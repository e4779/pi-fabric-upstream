import {
  closeSync,
  constants,
  fchmodSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { stableJsonHash } from "../core/stable-hash.js";
import { journalShimSource } from "./journal-shim.js";
import type { FabricJournalDelivery, FabricJournalDriver, FabricJournalOutcome, FabricJournalStop } from "./kernel.js";

export { journalShimSource };

// Crash-replay journal for one durable fabric_exec call (QuickJS only).
//
// The runtime numbers each host call when the guest issues it. Before a call
// that is not a repeatable read reaches its effect, Fabric appends an intent
// and syncs it. Each result is appended as a completion before the guest sees
// it, and results reach the guest one at a time. To resume, the same program
// runs again with the same seed and clock: recorded results are served in
// their recorded order without calling the host. Then the calls still waiting
// decide what happens. A call with an intent but no completion may have run,
// so the program stops and reports it. Any other call runs live, and recording
// continues in the same file.
//
// One record per line: an 8-digit CRC-32, a space, and JSON. A crash can tear
// only the last line; it is dropped and truncated before anything is appended.
// Every record after the header names the line before it in `p`: a short hash
// of that line's JSON, which itself carries the hash before it, back to the
// header. A lost, reordered, or foreign line breaks the chain and the resume is
// refused. The chain cannot show that whole lines are missing from the end:
// that needs a durable record outside the file for every call. The journal
// trusts fdatasync instead: a synced intent survives a crash.

const FORMAT = "pi-fabric.exec-journal.v2";
const FORMAT_PATTERN = /^pi-fabric\.exec-journal\.(v\d+)$/;
const PREVIEW_CHARS = 300;
// Results that name process-local work a restart does not keep.
const HANDLE_REFS: ReadonlySet<string> = new Set([
  "agents.spawn", "agents.create", "jev.spawn", "sessions.open", "tasks.adopt", "tasks.external",
]);
const RESERVED_FIELDS: ReadonlySet<string> = new Set(["message", "name", "stack", "cause"]);

/** The durable worker's journal offer for one fabric_exec call. */
export interface FabricJournalOffer {
  readonly path: string;
  /** Header digest the worker recorded; present only when resuming. */
  readonly digest?: string;
  /** Record the header digest durably before the program starts. */
  accept(digest: string): Promise<void>;
}

/** Host-local state the execution service keeps in step with the journal. */
export interface FabricJournalHooks {
  /** Restore host-local state for a call served from the journal. */
  served(delivery: FabricJournalDelivery, args: Record<string, unknown>, signal: AbortSignal): void | Promise<void>;
  /** Host-local data stored with a completion, such as a deferred handoff. */
  local(seq: number): unknown;
}

/** A resume Fabric refuses; the message is the report for the model. */
export class FabricJournalRefusal extends Error {}

const refusal = (reason: string): FabricJournalRefusal =>
  new FabricJournalRefusal(`fabric_exec could not resume after an interruption: ${reason}. Nothing was rerun.`);

const refusalAfter = (delivery: FabricJournalDelivery, error: unknown): FabricJournalRefusal =>
  new FabricJournalRefusal(`fabric_exec could not resume after an interruption: redoing its recorded ${delivery.target ?? delivery.ref} call failed: ${error instanceof Error ? error.message : String(error)}. No call after it ran.`);

interface JournalHeader {
  h: 1;
  format: string;
  versions: Record<string, string>;
  identity: string;
  seed: number;
  startedAt: number;
}
interface CompletionRecord {
  p: string;
  c: number;
  seq: number;
  ref: string;
  t?: string;
  d: string;
  at: number;
  o: FabricJournalOutcome;
  l?: unknown;
  handle?: true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const isOutcome = (value: unknown): value is FabricJournalOutcome => {
  if (!isObject(value)) return false;
  if (value.ok === true) return value.json === undefined || typeof value.json === "string";
  if (value.ok !== false || typeof value.message !== "string") return false;
  const exit = value.bashExit;
  if (exit !== undefined && !(isObject(exit) && Number.isSafeInteger(exit.exitCode) && typeof exit.output === "string")) return false;
  const fields = value.fields;
  return fields === undefined || (Array.isArray(fields) && fields.every((field) =>
    Array.isArray(field) && field.length === 2 && typeof field[0] === "string" &&
    /^[a-z][A-Za-z]{0,31}$/.test(field[0]) && !RESERVED_FIELDS.has(field[0]) &&
    typeof field[1] === "number" && Number.isFinite(field[1])));
};

const isCompletion = (value: unknown): value is CompletionRecord =>
  isObject(value) && typeof value.p === "string" && isIndex(value.c) && isIndex(value.seq) && typeof value.ref === "string" &&
  (value.t === undefined || typeof value.t === "string") && typeof value.d === "string" &&
  typeof value.at === "number" && Number.isFinite(value.at) && isOutcome(value.o) &&
  (value.handle === undefined || value.handle === true);

const encode = (json: string): Buffer =>
  Buffer.from(`${crc32(json).toString(16).padStart(8, "0")} ${json}\n`, "utf8");

// Link from one journal line to the next; covers the previous line's own link.
const chainLink = (previous: string): string => createHash("sha256").update(previous).digest("base64url").slice(0, 16);

// Returns the JSON text of each intact line and the byte length they cover.
const decode = (buffer: Buffer): { lines: string[]; size: number } => {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset);
    if (end < 0) break;
    const line = buffer.toString("utf8", offset, end);
    const sum = line.slice(0, 8);
    const json = line.slice(9);
    if (line[8] !== " " || !/^[0-9a-f]{8}$/.test(sum) || Number.parseInt(sum, 16) !== crc32(json)) {
      // A crash tears only the last line; damage before it is corruption.
      if (end + 1 < buffer.length) throw refusal("its journal is damaged");
      break;
    }
    lines.push(json);
    offset = end + 1;
  }
  return { lines, size: offset };
};

const writeAll = (fd: number, data: Buffer): void => {
  for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Digest of one call's arguments; replay compares it with the reissued call. */
export const journalDigest = (args: unknown): string =>
  createHash("sha256").update(JSON.stringify(args) ?? "null").digest("base64url").slice(0, 22);

const require = createRequire(import.meta.url);
const manifestVersion = (from: string, name: string): string => {
  for (let directory = from; ; directory = path.dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === name && typeof manifest.version === "string") return manifest.version;
    } catch { /* no readable manifest here; keep walking up */ }
    if (path.dirname(directory) === directory) return "unknown";
  }
};
const dependencyVersion = (name: string): string => {
  for (const request of [`${name}/package.json`, name]) {
    try {
      return manifestVersion(path.dirname(require.resolve(request)), name);
    } catch { /* not resolvable in this form */ }
  }
  return "unknown";
};
let versions: Record<string, string> | undefined;
// A journal replays only under the exact code that recorded it.
const journalVersions = (): Record<string, string> => versions ??= {
  "pi-fabric": manifestVersion(path.dirname(fileURLToPath(import.meta.url)), "pi-fabric"),
  "@jitl/quickjs-singlefile-mjs-release-sync": dependencyVersion("@jitl/quickjs-singlefile-mjs-release-sync"),
  "quickjs-emscripten-core": dependencyVersion("quickjs-emscripten-core"),
  typescript: dependencyVersion("typescript"),
};

const callTarget = (ref: string, args: Record<string, unknown>): { ref: string; args: unknown } =>
  ref === "fabric.$call" && typeof args.ref === "string" ? { ref: args.ref, args: args.args ?? {} }
    : ref === "fabric.$nativeTool" && typeof args.name === "string" ? { ref: args.name, args: args.args ?? {} }
      : { ref, args };

const preview = (ref: string, args: Record<string, unknown>): string => {
  const target = callTarget(ref, args);
  let text = JSON.stringify(target.args) ?? "";
  if (text.length > PREVIEW_CHARS) text = `${text.slice(0, PREVIEW_CHARS)}…`;
  return `${target.ref}(${text})`;
};

const holdsHandle = (target: string, value: unknown): boolean => {
  if (HANDLE_REFS.has(target)) return true;
  if (!isObject(value)) return false;
  return typeof value.taskId === "string" || (isObject(value.details) && typeof value.details.taskId === "string");
};

const isServedTool = (delivery: FabricJournalDelivery): boolean =>
  !delivery.ref.startsWith("fabric.$") || delivery.target !== undefined;

export class FabricExecJournal implements FabricJournalDriver {
  readonly shim: string;
  readonly startedAt: number;
  readonly resuming: boolean;
  readonly replay: readonly FabricJournalDelivery[];
  readonly #hooks: FabricJournalHooks;
  readonly #intents: Map<number, string>;
  readonly #completed: Set<number>;
  #fd: number | undefined;
  #next: number;
  #lastAt: number;
  #previous: string;

  constructor(
    fd: number,
    header: JournalHeader,
    resuming: boolean,
    completions: readonly CompletionRecord[],
    intents: Map<number, string>,
    hooks: FabricJournalHooks,
    previous: string,
  ) {
    this.#fd = fd;
    this.#previous = previous;
    this.shim = journalShimSource(header.seed);
    this.startedAt = header.startedAt;
    this.resuming = resuming;
    this.replay = completions.map((completion) => ({
      seq: completion.seq,
      ref: completion.ref,
      ...(completion.t !== undefined ? { target: completion.t } : {}),
      digest: completion.d,
      at: completion.at,
      outcome: completion.o,
      ...(completion.l !== undefined ? { local: completion.l } : {}),
    }));
    this.#hooks = hooks;
    this.#intents = intents;
    this.#completed = new Set(completions.map((completion) => completion.seq));
    this.#next = completions.length;
    this.#lastAt = completions.reduce((latest, completion) => Math.max(latest, completion.at), header.startedAt);
  }

  digest(args: Record<string, unknown>): string {
    return journalDigest(args);
  }

  /** Durably record that call `seq` is about to reach its effect. */
  intent(seq: number, ref: string): void {
    this.#write({ i: seq, ref }, true);
    this.#intents.set(seq, ref);
  }

  complete(
    seq: number,
    ref: string,
    args: Record<string, unknown>,
    value: unknown,
    outcome: FabricJournalOutcome,
  ): number {
    const at = Math.max(Date.now(), this.#lastAt);
    const target = callTarget(ref, args).ref;
    const local = this.#hooks.local(seq);
    this.#write({
      c: this.#next,
      seq,
      ref,
      ...(target !== ref ? { t: target } : {}),
      d: journalDigest(args),
      at,
      o: outcome,
      ...(local !== undefined ? { l: local } : {}),
      ...(outcome.ok && holdsHandle(target, value) ? { handle: true } : {}),
    }, false);
    this.#next++;
    this.#lastAt = at;
    this.#completed.add(seq);
    return at;
  }

  /** Restore host-local state for a served call; a failure stops the resume. */
  async served(delivery: FabricJournalDelivery, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    try {
      await this.#hooks.served(delivery, args, signal);
    } catch (error) {
      throw refusalAfter(delivery, error);
    }
  }

  frontier(held: ReadonlyArray<{ seq: number; ref: string; args: Record<string, unknown> }>): FabricJournalStop | undefined {
    const waiting = new Set(held.map((call) => call.seq));
    for (const [seq, ref] of [...this.#intents].sort(([left], [right]) => left - right)) {
      if (!this.#completed.has(seq) && !waiting.has(seq)) {
        return { report: `fabric_exec could not resume after an interruption: the program did not repeat its recorded ${ref} call. No call after the divergence ran.` };
      }
    }
    const uncertain = held.filter((call) => this.#intents.has(call.seq));
    const [first] = uncertain;
    if (!first) return undefined;
    const replayed = this.replay.filter(isServedTool).length;
    const facts = [
      "fabric_exec was interrupted during this call, which may have run:",
      `  ${preview(first.ref, first.args)}`,
      `${replayed} earlier tool ${replayed === 1 ? "call" : "calls"} finished before the interruption and ${replayed === 1 ? "was" : "were"} replayed from the journal without running again.`,
    ];
    return {
      report: [...facts, "This call was not repeated. Check whether it took effect before running the rest of the program."].join("\n"),
      // One answer covers one call: with several uncertain calls nobody is asked.
      ...(uncertain.length === 1
        ? { question: [...facts, "Run it again? If it took effect, running it again repeats that effect."].join("\n") }
        : {}),
    };
  }

  diverged(expected: FabricJournalDelivery, actual?: { ref: string; args: Record<string, unknown> }): string {
    const instead = actual ? ` (it made ${preview(actual.ref, actual.args)} instead)` : "";
    return `fabric_exec could not resume after an interruption: the program did not repeat its recorded ${expected.target ?? expected.ref} call${instead}. No call after the divergence ran.`;
  }

  close(): void {
    if (this.#fd === undefined) return;
    const fd = this.#fd;
    this.#fd = undefined;
    closeSync(fd);
  }

  #write(record: Record<string, unknown>, sync: boolean): void {
    if (this.#fd === undefined) throw new Error("Fabric journal is closed");
    const json = JSON.stringify({ p: chainLink(this.#previous), ...record });
    writeAll(this.#fd, encode(json));
    this.#previous = json;
    if (sync) fdatasyncSync(this.#fd);
  }
}

/**
 * Create a journal for a fresh call, or reopen one to resume it. A resume that
 * cannot be trusted throws FabricJournalRefusal; the program must not run.
 */
export async function openFabricExecJournal(
  offer: FabricJournalOffer,
  identity: Record<string, unknown>,
  hooks: FabricJournalHooks,
): Promise<FabricExecJournal> {
  const identityDigest = stableJsonHash(identity);
  return offer.digest === undefined
    ? createJournal(offer, identityDigest, hooks)
    : resumeJournal(offer.path, offer.digest, identityDigest, hooks);
}

async function createJournal(offer: FabricJournalOffer, identity: string, hooks: FabricJournalHooks): Promise<FabricExecJournal> {
  const directory = path.dirname(offer.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const header: JournalHeader = {
    h: 1, format: FORMAT, versions: journalVersions(), identity, seed: randomInt(0, 2 ** 32), startedAt: Date.now(),
  };
  const fd = openSync(offer.path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Fabric journal is not a regular file: ${offer.path}`);
    fchmodSync(fd, 0o600);
    const headerText = JSON.stringify(header);
    writeAll(fd, encode(headerText));
    fdatasyncSync(fd);
    // Windows cannot open a directory for fsync; the file sync above still runs there.
    if (process.platform !== "win32") {
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
    await offer.accept(sha256(headerText));
    return new FabricExecJournal(fd, header, false, [], new Map(), hooks, headerText);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function resumeJournal(file: string, expected: string, identity: string, hooks: FabricJournalHooks): FabricExecJournal {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  } catch (error) {
    throw refusal((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "its journal is missing"
      : `its journal could not be opened (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    if (!fstatSync(fd).isFile()) throw refusal("its journal is not a regular file");
    const { lines, size } = decode(readFileSync(fd));
    const [headerText, ...rest] = lines;
    if (headerText === undefined || sha256(headerText) !== expected) throw refusal("its journal was replaced or lost its header");
    const header = JSON.parse(headerText) as unknown;
    // v1 journals had no chain, so a lost or reordered line could not be seen.
    const recordedFormat = isObject(header) && typeof header.format === "string" ? header.format : undefined;
    const format = recordedFormat === undefined ? null : FORMAT_PATTERN.exec(recordedFormat);
    if (format && recordedFormat !== FORMAT) throw refusal(`its journal was written in format ${format[1]}, which this Fabric cannot verify`);
    if (!isObject(header) || header.h !== 1 || header.format !== FORMAT || !isObject(header.versions) ||
      typeof header.identity !== "string" || !isIndex(header.seed) || typeof header.startedAt !== "number" ||
      !Number.isFinite(header.startedAt)) {
      throw refusal("its journal is damaged");
    }
    for (const [name, version] of Object.entries(journalVersions())) {
      const recorded = header.versions[name];
      if (recorded !== version) throw refusal(`${name} changed from ${typeof recorded === "string" ? recorded : "unknown"} to ${version} since the journal was recorded`);
    }
    if (header.identity !== identity) throw refusal("the program, its payloads, or its execution settings changed since the journal was recorded");
    const intents = new Map<number, string>();
    const completions: CompletionRecord[] = [];
    let previous = headerText;
    for (const text of rest) {
      const value = JSON.parse(text) as unknown;
      if (!isObject(value) || value.p !== chainLink(previous)) throw refusal("its journal is damaged");
      previous = text;
      if (isIndex(value.i) && typeof value.ref === "string") intents.set(value.i, value.ref);
      else if (isCompletion(value)) completions.push(value);
      else throw refusal("its journal is damaged");
    }
    completions.sort((left, right) => left.c - right.c);
    const seen = new Set<number>();
    for (const [position, completion] of completions.entries()) {
      if (completion.c !== position || seen.has(completion.seq)) throw refusal("its journal is damaged");
      seen.add(completion.seq);
      if (completion.handle) {
        throw refusal(`its ${completion.t ?? completion.ref} call returned process-local work that did not survive the restart`);
      }
    }
    if (size < fstatSync(fd).size) {
      // Windows append handles lack FILE_WRITE_DATA, which ftruncate needs.
      // Keep fd in append mode for later records, but repair through a separate
      // writable handle to the same file (never truncate a replacement path).
      const repairFd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        const original = fstatSync(fd);
        const repair = fstatSync(repairFd);
        if (original.dev !== repair.dev || original.ino !== repair.ino) throw refusal("its journal was replaced during recovery");
        ftruncateSync(repairFd, size);
      } finally {
        closeSync(repairFd);
      }
    }
    return new FabricExecJournal(fd, header as unknown as JournalHeader, true, completions, intents, hooks, previous);
  } catch (error) {
    closeSync(fd);
    throw error instanceof FabricJournalRefusal
      ? error
      : refusal(`its journal could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}
