import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentChildQuestionRequest, AgentChildQuestionResponse } from "../agents/types.js";
import type { ResolvedFabricAction } from "../core/action-registry.js";
import { renderDecision, terminalOperator, watchDecision, type DecisionBy } from "./render.js";
import type { FabricQuestionRenderers } from "../fabric-state.js";
import {
  MAX_DECISION_BODY_CHARS,
  MAX_DECISION_DEADLINE_MS,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_TITLE_CHARS,
  type DecisionRaiseInput,
  type DecisionRecord,
  type DecisionStore,
} from "./store.js";

// Host-side consumers of the decision store: headless approvals
// (approvals.headless "decision") and routed child dialogs
// (agents.childQuestions "route").

export const DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS = 300_000;
const DEFAULT_CHILD_QUESTION_TIMEOUT_MS = 600_000;
const CANCELLED: AgentChildQuestionResponse = { cancelled: true };

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** Raise a decision and wait for it; an aborted wait cancels the decision. */
export const raiseAndWait = async (
  store: DecisionStore,
  input: DecisionRaiseInput,
  raisedBy: Partial<DecisionRecord["raisedBy"]>,
  signal: AbortSignal | undefined,
  onRaised?: (id: string) => void,
): Promise<DecisionRecord> => {
  const record = await store.raise(input, raisedBy);
  onRaised?.(record.id);
  try {
    return await store.wait(record.id, signal ? { signal } : {});
  } catch (error) {
    await store.cancel(record.id, { answeredBy: store.identity.id, via: "abort" }).catch(() => undefined);
    throw error;
  }
};

/**
 * No-UI approval: a user-held "approval" decision with approve/deny options.
 * Only an explicit approve answer allows the call; deny, cancel, and expiry deny.
 */
export const requestHeadlessApproval = async (
  store: DecisionStore,
  action: Pick<ResolvedFabricAction, "ref" | "risk" | "description">,
  options: { reason?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> => {
  const settled = await raiseAndWait(store, {
    kind: "approval",
    title: clip(`${action.ref} requests ${action.risk} access`, MAX_DECISION_TITLE_CHARS),
    body: clip([action.description, options.reason].filter(Boolean).join("\n\n"), MAX_DECISION_BODY_CHARS),
    options: [
      { id: "approve", label: "Approve once" },
      { id: "deny", label: "Deny" },
    ],
    holder: "user",
    timeoutMs: options.timeoutMs ?? DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS,
    onExpire: "cancel",
  }, {}, options.signal);
  return settled.status === "answered" && settled.answer?.optionId === "approve";
};

interface ChildQuestion {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout: number;
}

const parseChildQuestion = (value: Record<string, unknown>): ChildQuestion | undefined => {
  const method = value.method;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return undefined;
  const options = Array.isArray(value.options)
    ? value.options.filter((option): option is string => typeof option === "string")
    : undefined;
  if (method === "select" && !options?.length) return undefined;
  const string = (field: unknown): string | undefined => typeof field === "string" ? field : undefined;
  const message = string(value.message);
  const placeholder = string(value.placeholder);
  const prefill = string(value.prefill);
  return {
    method,
    title: string(value.title) ?? "",
    ...(message !== undefined ? { message } : {}),
    ...(options && method === "select" ? { options } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
    timeout: typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout >= 1_000
      ? Math.floor(value.timeout)
      : DEFAULT_CHILD_QUESTION_TIMEOUT_MS,
  };
};

const askViaUi = async (
  ui: ExtensionContext["ui"],
  label: string,
  question: ChildQuestion,
  signal: AbortSignal,
  hold = false,
): Promise<AgentChildQuestionResponse> => {
  // A held question has no deadline: the dialog waits until answered or the run settles.
  const dialog = hold ? { signal } : { signal, timeout: question.timeout };
  if (question.method === "select") {
    const value = await ui.select(label, question.options!, dialog);
    return value !== undefined && question.options!.includes(value) ? { value } : CANCELLED;
  }
  if (question.method === "confirm") {
    return { confirmed: await ui.confirm(label, question.message ?? "", dialog) };
  }
  if (question.method === "input") {
    const value = await ui.input(label, question.placeholder, dialog);
    return value === undefined ? CANCELLED : { value };
  }
  // ui.editor takes no dialog options: race it against the deadline and abort.
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<undefined>((resolve) => {
    if (!hold) timer = setTimeout(() => resolve(undefined), question.timeout);
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([ui.editor(label, question.prefill), stop]);
    return value === undefined ? CANCELLED : { value };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

/** A UI answer as the decision answer it records; undefined records a cancel. */
const decisionAnswerFromUi = (
  question: ChildQuestion,
  response: AgentChildQuestionResponse,
): { optionId?: string; text?: string } | undefined => {
  if ("confirmed" in response) return { optionId: response.confirmed ? "yes" : "no" };
  if (!("value" in response)) return undefined;
  if (question.method === "select") {
    const index = question.options!.indexOf(response.value);
    return index >= 0 ? { optionId: `o${index + 1}` } : undefined;
  }
  return { text: response.value };
};

const responseFromDecision = (
  question: ChildQuestion,
  decision: DecisionRecord,
): AgentChildQuestionResponse => {
  if (decision.status !== "answered" || !decision.answer) return CANCELLED;
  const { optionId, text } = decision.answer;
  if (question.method === "confirm") return { confirmed: optionId === "yes" };
  if (question.method === "select") {
    const index = optionId?.startsWith("o") ? Number(optionId.slice(1)) - 1 : -1;
    const value = question.options?.[index];
    return value === undefined ? CANCELLED : { value };
  }
  return text === undefined ? CANCELLED : { value: text };
};

/**
 * Cancel the routed child questions that an earlier process with this store's
 * identity raised and left open: a resident host that died while a durable run
 * waited. The wait and the reporter that would deliver an answer died with that
 * process, so the decision could only mislead; the runner asks again through
 * the current host. Call it before this process routes any question. Records
 * `via: "restart"`.
 */
export const cancelOrphanedChildQuestions = async (store: DecisionStore): Promise<string[]> => {
  const cancelled: string[] = [];
  for (const record of await store.listOwnOpen()) {
    if (record.kind !== "question" || record.holder !== "root" || !record.raisedBy.runId) continue;
    try {
      await store.cancel(record.id, { answeredBy: store.identity.id, via: "restart" });
      cancelled.push(record.id);
    } catch {
      // Answered, expired, or cancelled meanwhile: nothing is left to release.
    }
  }
  return cancelled;
};

const childDecisionInput = (label: string, question: ChildQuestion, timeoutMs: number): DecisionRaiseInput => ({
  kind: "question",
  title: clip(label, MAX_DECISION_TITLE_CHARS),
  ...(question.message ? { body: clip(question.message, MAX_DECISION_BODY_CHARS) } : {}),
  ...(question.method === "select"
    ? {
        input: "select",
        options: question.options!.slice(0, MAX_DECISION_OPTIONS).map((option, index) => ({
          id: `o${index + 1}`,
          label: clip(option || `Option ${index + 1}`, MAX_DECISION_TITLE_CHARS),
        })),
      }
    : { input: question.method === "input" ? "text" : question.method }),
  holder: "root",
  timeoutMs,
  onExpire: "cancel",
});

/** Only offer a child question to a renderer when its decision is lossless. */
const recordable = (label: string, question: ChildQuestion): boolean => {
  if (label.length > MAX_DECISION_TITLE_CHARS ||
      (question.message !== undefined && (!question.message || question.message.length > MAX_DECISION_BODY_CHARS)) ||
      question.placeholder !== undefined || question.prefill !== undefined) return false;
  return question.method !== "select" || (
    question.options!.length <= MAX_DECISION_OPTIONS &&
    question.options!.every((option) => !!option.trim() && option.length <= MAX_DECISION_TITLE_CHARS)
  );
};

/**
 * Show a recorded child question to the person at this terminal: through a
 * registered question renderer, else through `ctx.ui`. The first answer wins,
 * whether from here, `/fabric decisions`, or the CLI; the child always gets
 * what the record says.
 */
const askRecorded = async (
  request: AgentChildQuestionRequest,
  deps: { ui: ExtensionContext["ui"]; store: DecisionStore; renderers: FabricQuestionRenderers },
  label: string,
  question: ChildQuestion,
): Promise<AgentChildQuestionResponse> => {
  const { store } = deps;
  const record = await store.raise(
    childDecisionInput(label, question, Math.max(1_000, question.timeout)),
    { participantId: request.actorId ?? request.runId, runId: request.runId },
  );
  request.onDecision(record.id);
  const by: DecisionBy = { answeredBy: terminalOperator(), via: "tui" };
  const watch = watchDecision(store, record.id, request.signal);
  const settle = async (answer: { optionId?: string; text?: string } | undefined): Promise<DecisionRecord> => {
    try {
      return answer ? await store.answer(record.id, answer, by) : await store.cancel(record.id, by);
    } catch {
      // Settled elsewhere first, or an answer the store refuses (for example
      // text over its limit): the record decides what the child receives.
      const latest = await store.get(record.id);
      if (latest && latest.status !== "open") return latest;
      return store.cancel(record.id, by);
    }
  };
  try {
    const rendered = await renderDecision({
      renderers: deps.renderers,
      surface: "child-question",
      ui: deps.ui,
      store,
      record,
      watch,
      by,
    });
    // The asker went away: the catch below cancels the record as an abort.
    request.signal.throwIfAborted();
    let settled: DecisionRecord;
    if (rendered.kind === "settled") settled = rendered.record;
    else if (rendered.kind === "dismissed") settled = await settle(undefined);
    else if (rendered.kind === "aborted") settled = watch.current() ?? await settle(undefined);
    else {
      const response = await askViaUi(deps.ui, label, question, watch.signal);
      request.signal.throwIfAborted();
      settled = watch.current() ?? await settle(decisionAnswerFromUi(question, response));
    }
    return responseFromDecision(question, settled);
  } catch (error) {
    await store.cancel(record.id, { answeredBy: store.identity.id, via: "abort" }).catch(() => undefined);
    throw error;
  } finally {
    watch.stop();
  }
};

/**
 * Answer one routed child dialog: through the parent's interactive UI when it
 * has one, otherwise through a root-held decision. Missing UI and store, a
 * malformed request, or any failure cancels the child's dialog. A host with no
 * UI at all (the resident host) omits `context` and only ever raises a decision.
 *
 * A held request (`request.hold`, set by the manager for a holdQuestions run)
 * always becomes a root-held decision with the store's longest deadline
 * (MAX_DECISION_DEADLINE_MS, 30 days), even with a UI, so a
 * blocking dialog never stalls the session: the UI is only told the decision is
 * waiting. It stays open until answered, until the run settles, or until the
 * deadline passes and the child's question is cancelled. Without a
 * decision store it falls back to the UI dialog, with no timeout.
 *
 * `renderers` is passed only when `ui.questionRenderers` is on and an
 * extension registered one. Then a question that would use the UI dialog is
 * recorded as a root-held decision first, so a renderer and Fabric's own
 * dialog show the same record; see askRecorded. Without `renderers` the UI
 * path does not touch the store.
 */
export const routeChildQuestion = async (
  request: AgentChildQuestionRequest,
  deps: {
    context?: Pick<ExtensionContext, "hasUI" | "ui">;
    store?: DecisionStore;
    renderers?: FabricQuestionRenderers;
  },
): Promise<AgentChildQuestionResponse> => {
  const question = parseChildQuestion(request.question);
  if (!question || request.signal.aborted) return CANCELLED;
  const label = `${request.name}: ${question.title || "question"}`;
  const hold = request.hold === true;
  if (deps.context?.hasUI && (!hold || !deps.store)) {
    if (!hold && deps.store && deps.renderers && recordable(label, question)) {
      return askRecorded(request, { ui: deps.context.ui, store: deps.store, renderers: deps.renderers }, label, question);
    }
    return askViaUi(deps.context.ui, label, question, request.signal, hold);
  }
  if (!deps.store) return CANCELLED;
  // A held decision gets the longest deadline the store allows, not none: if the
  // session that raised it dies without shutdown, nothing else cancels it.
  const input = childDecisionInput(label, question, hold ? MAX_DECISION_DEADLINE_MS : Math.max(1_000, question.timeout));
  const onRaised = hold && deps.context?.hasUI
    ? (id: string): void => {
        request.onDecision(id);
        try {
          deps.context!.ui.notify(`${label}: decision ${id} is held for you (up to 30 days); answer it with /fabric decisions`, "info");
        } catch {
          // A notice is best-effort; the decision is already durable.
        }
      }
    : request.onDecision;
  const decision = await raiseAndWait(
    deps.store,
    input,
    { participantId: request.actorId ?? request.runId, runId: request.runId },
    request.signal,
    onRaised,
  );
  return responseFromDecision(question, decision);
};
