// The crash journal of one durable fabric_exec call, kept in a pi-durable task
// document so it works wherever the Harness does: Node, Bun and Cloudflare Workers.
//
// It implements the kernel's FabricJournalDriver (see runtime/kernel.ts). The
// kernel numbers host calls as the guest issues them, pins the clock and
// Math.random with the shim, and hands each result to complete() before the
// guest sees it; complete() commits it here first. After a restart pi-durable
// reruns fabric_exec (it is declared replay-safe) with the same task, so the
// recorded results are served in their recorded order without reaching the host.
//
// Nested tool calls need no intent of their own: each passes its issue number as
// the pi-durable nested-call key, so a rerun gets the same nested call back,
// finished or still running, and never starts a second one. A provider action is
// not a pi-durable task, so before one that is not repeatable runs, an intent is
// committed here. On resume, an action with an intent and no result may have run:
// the program stops and the model is told.
//
// Imports pi-durable for types only, and no Node module.
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, TaskDocToken, ToolExecutionApi } from "@earendil-works/pi-durable";
import { journalShimSource } from "./runtime/journal-shim.js";
import type { FabricJournalDelivery, FabricJournalDriver, FabricJournalOutcome, FabricJournalStop } from "./runtime/kernel.js";
import { stableDigest } from "./runtime/sha256.js";

/** Bump when what a recorded run means changes: record shapes, keys, or the replay rules. */
export const FABRIC_DURABLE_JOURNAL_FORMAT = "pi-fabric.durable-journal.v1";
const PREVIEW_CHARS = 300;

type JournalOutcomeJson =
  | { ok: true; json?: string }
  | { ok: false; message: string; fields?: Array<[string, number]> };

type JournalHeader = {
  format: string;
  engine: string;
  identity: string;
  seed: number;
  startedAt: number;
};

type JournalCompletion = {
  c: number;
  seq: number;
  ref: string;
  t?: string;
  d: string;
  at: number;
  o: JournalOutcomeJson;
};

type JournalIntent = {
  seq: number;
  ref: string;
};

export type FabricRunState = {
  header: JournalHeader | null;
  intents: JournalIntent[];
  completions: JournalCompletion[];
};

/** The journal document of one fabric_exec task; it retires with the task. */
export const FabricRunDoc = {
  definition: {
    kind: "pi-fabric.exec-run",
    version: 1,
    scope: "task",
    initial: (): FabricRunState => ({ header: null, intents: [], completions: [] }),
    checkpointWhen: () => false,
  },
} as unknown as TaskDocToken<FabricRunState>;

/** A resume the journal cannot trust; the program must not run. The message is for the model. */
export class FabricDurableJournalRefusal extends Error {
  override readonly name = "FabricDurableJournalRefusal";
}

const refusal = (reason: string): FabricDurableJournalRefusal =>
  new FabricDurableJournalRefusal(`fabric_exec could not resume after an interruption: ${reason}. The program did not run again.`);

export const durableJournalDigest = (args: unknown): string => stableDigest(args ?? {});

/** The tool or action a bridge ref names: tools.call and tools.<name> carry it in their arguments. */
export const callTarget = (ref: string, args: Record<string, unknown>): { ref: string; args: unknown } =>
  ref === "fabric.$call" && typeof args.ref === "string" ? { ref: args.ref, args: args.args ?? {} }
    : ref === "fabric.$nativeTool" && typeof args.name === "string" ? { ref: args.name, args: args.args ?? {} }
      : { ref, args };

export const callPreview = (ref: string, args: Record<string, unknown>): string => {
  const target = callTarget(ref, args);
  let text = JSON.stringify(target.args) ?? "";
  if (text.length > PREVIEW_CHARS) text = `${text.slice(0, PREVIEW_CHARS)}…`;
  return `${target.ref}(${text})`;
};

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toOutcome = (outcome: FabricJournalOutcome): JournalOutcomeJson => outcome.ok
  ? { ok: true, ...(outcome.json === undefined ? {} : { json: outcome.json }) }
  : { ok: false, message: outcome.message, ...(outcome.fields === undefined ? {} : { fields: outcome.fields }) };

const randomSeed = (): number => {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?(array: Uint32Array): Uint32Array } }).crypto;
  if (cryptoApi?.getRandomValues) return cryptoApi.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor(Math.random() * 2 ** 32);
};

export interface DurableJournalHooks {
  /** A journal write failed; the error may hold storage details, so it goes here, not to the program. */
  readonly onWriteError: (error: unknown) => void;
}

export class FabricDurableJournal implements FabricJournalDriver {
  readonly shim: string;
  readonly startedAt: number;
  readonly resuming: boolean;
  readonly replay: readonly FabricJournalDelivery[];
  readonly #api: ToolExecutionApi;
  readonly #context: Context;
  readonly #hooks: DurableJournalHooks;
  readonly #intents: Map<number, string>;
  readonly #completed: Set<number>;
  #next: number;
  #lastAt: number;

  private constructor(api: ToolExecutionApi, context: Context, state: FabricRunState, header: JournalHeader, resuming: boolean, hooks: DurableJournalHooks) {
    this.#api = api;
    this.#context = context;
    this.#hooks = hooks;
    this.shim = journalShimSource(header.seed);
    this.startedAt = header.startedAt;
    this.resuming = resuming;
    const completions = [...state.completions].sort((left, right) => left.c - right.c);
    this.replay = completions.map((completion) => ({
      seq: completion.seq,
      ref: completion.ref,
      ...(completion.t !== undefined ? { target: completion.t } : {}),
      digest: completion.d,
      at: completion.at,
      outcome: completion.o,
    }));
    this.#intents = new Map(state.intents.map((intent) => [intent.seq, intent.ref]));
    this.#completed = new Set(completions.map((completion) => completion.seq));
    this.#next = completions.length;
    this.#lastAt = completions.reduce((latest, completion) => Math.max(latest, completion.at), header.startedAt);
  }

  /**
   * Open the journal of this fabric_exec task: a fresh one on the first run, the recorded one on a rerun.
   * Throws FabricDurableJournalRefusal when the recorded run cannot be trusted to replay.
   */
  static async open(
    api: ToolExecutionApi,
    context: Context,
    identity: Record<string, unknown>,
    engine: string,
    hooks: DurableJournalHooks,
  ): Promise<FabricDurableJournal> {
    const identityDigest = stableDigest(identity);
    const fresh: JournalHeader = { format: FABRIC_DURABLE_JOURNAL_FORMAT, engine, identity: identityDigest, seed: randomSeed(), startedAt: api.now() };
    const opened = await api.commit(async (tx) => {
      const doc = await tx.doc(FabricRunDoc, api.taskId);
      if (doc.header !== null) return { state: plain(doc as FabricRunState), resuming: true };
      doc.header = { ...fresh };
      return { state: plain(doc as FabricRunState), resuming: false };
    }, context);
    const header = opened.state.header!;
    if (opened.resuming) {
      if (header.format !== FABRIC_DURABLE_JOURNAL_FORMAT) throw refusal(`its journal was written in format ${String(header.format)}, which this Fabric cannot replay`);
      if (header.engine !== engine) throw refusal("Fabric's program engine changed since the program started");
      if (header.identity !== identityDigest) throw refusal("the program, its payloads, or its settings changed since it started");
      const positions = opened.state.completions.map((completion) => completion.c).sort((left, right) => left - right);
      const sequences = new Set(opened.state.completions.map((completion) => completion.seq));
      if (positions.some((position, index) => position !== index) || sequences.size !== positions.length) throw refusal("its journal is damaged");
    }
    return new FabricDurableJournal(api, context, opened.state, header, opened.resuming, hooks);
  }

  /** The recorded tool and provider calls a resume serves without running them again. */
  replayedCalls(): number {
    return this.replay.filter((delivery) => !delivery.ref.startsWith("fabric.$") || delivery.target !== undefined).length;
  }

  /** Set when the journal stopped the program; the model sees exactly this text. */
  stopReport: string | undefined;

  digest(args: Record<string, unknown>): string {
    return durableJournalDigest(args);
  }

  /** True when call `seq` was recorded as about to reach its effect. */
  hasIntent(seq: number): boolean {
    return this.#intents.has(seq);
  }

  /** Commit that call `seq` is about to reach its effect, before it does. */
  async intent(seq: number, ref: string): Promise<void> {
    if (this.#intents.has(seq)) return;
    await this.#write((doc) => { doc.intents.push({ seq, ref }); });
    this.#intents.set(seq, ref);
  }

  async complete(seq: number, ref: string, args: Record<string, unknown>, _value: unknown, outcome: FabricJournalOutcome): Promise<number> {
    const at = Math.max(this.#api.now(), this.#lastAt);
    const target = callTarget(ref, args).ref;
    const c = this.#next++;
    this.#lastAt = at;
    await this.#write((doc) => {
      doc.completions.push({ c, seq, ref, ...(target !== ref ? { t: target } : {}), d: durableJournalDigest(args), at, o: toOutcome(outcome) });
    });
    this.#completed.add(seq);
    return at;
  }

  served(): void {
    // Nothing host-local to restore: every effect lives in the Harness.
  }

  frontier(held: ReadonlyArray<{ seq: number; ref: string; args: Record<string, unknown> }>): FabricJournalStop | undefined {
    const waiting = new Set(held.map((call) => call.seq));
    for (const [seq, ref] of [...this.#intents].sort(([left], [right]) => left - right)) {
      if (!this.#completed.has(seq) && !waiting.has(seq)) {
        this.stopReport = `fabric_exec could not resume after an interruption: the program did not repeat its recorded ${ref} call. No call after the divergence ran.`;
        return { report: this.stopReport };
      }
    }
    const uncertain = held.find((call) => this.#intents.has(call.seq));
    if (uncertain === undefined) return undefined;
    this.stopReport = maybeRanReport(callPreview(uncertain.ref, uncertain.args), this.replayedCalls());
    return { report: this.stopReport };
  }

  diverged(expected: FabricJournalDelivery, actual?: { ref: string; args: Record<string, unknown> }): string {
    const instead = actual ? ` (it made ${callPreview(actual.ref, actual.args)} instead)` : "";
    return this.stopReport = `fabric_exec could not resume after an interruption: the program did not repeat its recorded ${expected.target ?? expected.ref} call${instead}. No call after the divergence ran.`;
  }

  async #write(change: (doc: FabricRunState) => void): Promise<void> {
    try {
      await this.#api.commit(async (tx) => { change(await tx.doc(FabricRunDoc, this.#api.taskId) as FabricRunState); }, this.#context);
    } catch (error) {
      this.#hooks.onWriteError(error);
      throw new Error("the journal write failed");
    }
  }
}

/** What the model reads when a call that may have taken effect was interrupted. */
export const maybeRanReport = (call: string, replayed: number): string => [
  "fabric_exec was interrupted during this call, which may have run:",
  `  ${call}`,
  `${replayed} earlier tool ${replayed === 1 ? "call" : "calls"} finished before the interruption and ${replayed === 1 ? "was" : "were"} replayed from the journal without running again.`,
  "The program stopped here and this call was not repeated. Check whether it took effect, or ask the user, before running it or the rest of the program again.",
].join("\n");

/** Extra JSON for the model-facing result of a journaled call; exported for tests. */
export type FabricRunStateJson = FabricRunState & JsonObject;
