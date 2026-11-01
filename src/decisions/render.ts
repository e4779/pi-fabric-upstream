import os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  FabricQuestionDecisionV1,
  FabricQuestionRenderInputV1,
  FabricQuestionRenderSurfaceV1,
} from "../protocol.js";
import type { FabricQuestionRenderers } from "../fabric-state.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

// Offer one stored decision to registered question renderers before Fabric
// shows it with its own `ctx.ui` dialogs. A renderer only reports an answer;
// Fabric checks it against the decision it handed out and writes it to the
// store, so a renderer cannot answer another decision or change the holder,
// raiser, deadline, or who is recorded as answering.

export type DecisionBy = { answeredBy: string; via: string };

/** The OS user at this terminal, recorded as `answeredBy` for TUI answers. */
export const terminalOperator = (): string => {
  try {
    return os.userInfo().username || "user";
  } catch {
    return "user";
  }
};

export interface DecisionWatch {
  /** Aborts when the decision leaves `open` or the outer signal aborts. */
  signal: AbortSignal;
  /** The settled record once the store reports one. */
  current(): DecisionRecord | undefined;
  stop(): void;
}

/** Watch one decision so a dialog showing it closes when it settles elsewhere. */
export const watchDecision = (store: DecisionStore, id: string, outer?: AbortSignal): DecisionWatch => {
  const stopWaiting = new AbortController();
  const settledElsewhere = new AbortController();
  let final: DecisionRecord | undefined;
  void store.wait(id, { signal: stopWaiting.signal }).then(
    (record) => {
      final = record;
      settledElsewhere.abort(new Error(`Decision ${id} is ${record.status}`));
    },
    () => undefined,
  );
  const signal = outer ? AbortSignal.any([outer, settledElsewhere.signal]) : settledElsewhere.signal;
  // An outer abort ends the watch too, so no wait outlives the asker.
  outer?.addEventListener("abort", () => stopWaiting.abort(), { once: true });
  return { signal, current: () => final, stop: () => stopWaiting.abort() };
};

export type RenderOutcome =
  | { kind: "fallback" }
  | { kind: "dismissed" }
  | { kind: "aborted" }
  | { kind: "settled"; record: DecisionRecord };

/** Copy only the named fields, so a renderer's edits never reach the store. */
const renderCopy = (record: DecisionRecord): FabricQuestionDecisionV1 => ({
  id: record.id,
  kind: record.kind,
  title: record.title,
  ...(record.body !== undefined ? { body: record.body } : {}),
  input: record.input ?? (record.options ? "select" : "text"),
  ...(record.options ? { options: record.options.map(({ id, label }) => ({ id, label })) } : {}),
  holder: record.holder,
  raisedBy: {
    participantId: record.raisedBy.participantId,
    ...(record.raisedBy.runId !== undefined ? { runId: record.raisedBy.runId } : {}),
    ...(record.raisedBy.sessionId !== undefined ? { sessionId: record.raisedBy.sessionId } : {}),
  },
  createdAt: record.createdAt,
  ...(record.deadline !== undefined ? { deadline: record.deadline } : {}),
});

type ParsedResult =
  | { status: "answered"; answer: { optionId?: string; text?: string } }
  | { status: "cancelled" | "dismissed" };

/** Accept only a result for `id`, and copy only `optionId` and `text`. */
const parseResult = (value: unknown, id: string): ParsedResult | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const result = value as Record<string, unknown>;
  if (result.decisionId !== id) return undefined;
  if (result.status === "cancelled" || result.status === "dismissed") return { status: result.status };
  if (result.status !== "answered" || typeof result.answer !== "object" || result.answer === null) return undefined;
  const { optionId, text } = result.answer as Record<string, unknown>;
  if (optionId !== undefined && typeof optionId !== "string") return undefined;
  if (text !== undefined && typeof text !== "string") return undefined;
  return {
    status: "answered",
    answer: { ...(optionId !== undefined ? { optionId } : {}), ...(text !== undefined ? { text } : {}) },
  };
};

const STOPPED = Symbol("stopped");

/**
 * Offer one open decision to each renderer in registration order until one
 * answers. Resolves `fallback` when every renderer declines or one fails, so
 * the caller shows its own dialog.
 */
export const renderDecision = async (options: {
  renderers: FabricQuestionRenderers;
  surface: FabricQuestionRenderSurfaceV1;
  ui: ExtensionContext["ui"];
  store: DecisionStore;
  record: DecisionRecord;
  watch: DecisionWatch;
  by: DecisionBy;
}): Promise<RenderOutcome> => {
  const { store, record, watch, by } = options;
  const stopped = (): RenderOutcome => {
    const settled = watch.current();
    return settled ? { kind: "settled", record: settled } : { kind: "aborted" };
  };
  const stop = new Promise<typeof STOPPED>((resolve) => {
    if (watch.signal.aborted) resolve(STOPPED);
    else watch.signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  for (const { render } of options.renderers.list()) {
    if (watch.signal.aborted) return stopped();
    // Each renderer gets its own copy of the decision.
    const input: FabricQuestionRenderInputV1 = {
      version: 1,
      surface: options.surface,
      ui: options.ui,
      decision: renderCopy(record),
      signal: watch.signal,
    };
    // An async wrapper turns a synchronous throw into a rejection.
    const rendered = (async () => render(input))();
    rendered.catch(() => undefined);
    let value: unknown;
    try {
      value = await Promise.race([rendered, stop]);
    } catch {
      return watch.signal.aborted ? stopped() : { kind: "fallback" };
    }
    if (value === STOPPED || watch.signal.aborted) return stopped();
    if (value === undefined) continue;
    const result = parseResult(value, record.id);
    if (!result) return { kind: "fallback" };
    if (result.status === "dismissed") return { kind: "dismissed" };
    try {
      const settled = result.status === "answered"
        ? await store.answer(record.id, result.answer, by)
        : await store.cancel(record.id, by);
      return { kind: "settled", record: settled };
    } catch {
      // Settled elsewhere in the meantime, or an answer the store refuses.
      const latest = await store.get(record.id).catch(() => undefined);
      return latest && latest.status !== "open" ? { kind: "settled", record: latest } : { kind: "fallback" };
    }
  }
  return { kind: "fallback" };
};
