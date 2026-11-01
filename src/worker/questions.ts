// Routed child dialogs (agents.childQuestions: "route"). The worker turns a
// child Pi's extension_ui_request into a `question` lifecycle record for the
// parent AgentManager and forwards the parent's `ui_response` steer line back
// as extension_ui_response. A `ui_decision` steer line names the decision that
// backs a headless question, so the run record can name it too. The worker
// owns the deadline: when the parent never answers (gone, headless without
// decisions, or slow) the child gets a cancelled response, never a hang. A run
// that holds its questions (holdQuestions) sets no deadline on a dialog that has
// none of its own; the run's wall clock and settlement still end the wait.

export type ChildQuestionMethod = "select" | "confirm" | "input" | "editor";

export interface ChildQuestionEvent {
  requestId: string;
  method: ChildQuestionMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Nominal for a held question, which has no deadline. */
  timeout: number;
  /** The run holds this question for a person with no deadline. */
  hold?: true;
}

export type ChildQuestionFrame =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

const MAX_PENDING = 16;
const MAX_TITLE_CHARS = 1_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_OPTIONS = 64;
const MAX_VALUE_CHARS = 64 * 1024;
const MAX_TIMEOUT_MS = 86_400_000;
const MAX_DECISION_ID_CHARS = 128;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

interface PendingQuestion {
  method: ChildQuestionMethod;
  options?: string[];
  timer?: NodeJS.Timeout;
  decisionId?: string;
}

export class ChildQuestionRelay {
  readonly #pending = new Map<string, PendingQuestion>();
  #since: number | undefined;
  /** The decision last reported through `blocked`. */
  #decisionId: string | undefined;

  constructor(
    readonly defaultTimeoutMs: number,
    readonly io: {
      emit(question: ChildQuestionEvent): void;
      send(frame: ChildQuestionFrame): void;
      /** Blocked since a time, with the decision of the oldest question that has one; undefined when unblocked. */
      blocked(since: number | undefined, decisionId?: string): void;
    },
    readonly now: () => number = Date.now,
    readonly options: { hold?: boolean } = {},
  ) {}

  get pending(): number {
    return this.#pending.size;
  }

  /** Handle one select/confirm/input/editor request (routing it or cancelling it); false when malformed. */
  request(event: Record<string, unknown>): boolean {
    const id = event.id;
    const method = event.method;
    if (typeof id !== "string" || !id || id.length > 256) return false;
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return false;
    const options = Array.isArray(event.options)
      ? event.options.filter((option): option is string => typeof option === "string").slice(0, MAX_OPTIONS)
      : undefined;
    if (this.#pending.has(id) || this.#pending.size >= MAX_PENDING || (method === "select" && !options?.length)) {
      this.io.send({ type: "extension_ui_response", id, cancelled: true });
      return true;
    }
    const requested = typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0
      ? Math.floor(event.timeout)
      : undefined;
    const hold = this.options.hold === true && requested === undefined;
    const timeout = hold ? MAX_TIMEOUT_MS : Math.min(requested ?? this.defaultTimeoutMs, MAX_TIMEOUT_MS);
    let timer: NodeJS.Timeout | undefined;
    if (!hold) {
      timer = setTimeout(() => this.#finish(id, { type: "extension_ui_response", id, cancelled: true }), timeout);
      timer.unref?.();
    }
    this.#pending.set(id, { method, ...(options ? { options } : {}), ...(timer ? { timer } : {}) });
    const message = text(event.message, MAX_TEXT_CHARS);
    const placeholder = text(event.placeholder, MAX_TEXT_CHARS);
    const prefill = text(event.prefill, MAX_TEXT_CHARS);
    this.io.emit({
      requestId: id,
      method,
      title: text(event.title, MAX_TITLE_CHARS) ?? "",
      ...(message !== undefined ? { message } : {}),
      ...(options ? { options } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(prefill !== undefined ? { prefill } : {}),
      timeout,
      ...(hold ? { hold: true as const } : {}),
    });
    if (this.#pending.size === 1) {
      this.#since = this.now();
      this.io.blocked(this.#since);
    }
    return true;
  }

  /** Apply a parent `ui_decision` steer command naming the decision behind a pending question. */
  decide(command: Record<string, unknown>): boolean {
    const id = command.requestId;
    const decisionId = command.decisionId;
    if (typeof id !== "string" || typeof decisionId !== "string") return false;
    if (!decisionId || decisionId.length > MAX_DECISION_ID_CHARS) return false;
    const pending = this.#pending.get(id);
    if (!pending) return false;
    pending.decisionId = decisionId;
    this.#reportDecision();
    return true;
  }

  /** Apply a parent `ui_response` steer command; unknown or stale ids are ignored. */
  respond(command: Record<string, unknown>): boolean {
    const id = command.requestId;
    if (typeof id !== "string") return false;
    const pending = this.#pending.get(id);
    if (!pending) return false;
    let frame: ChildQuestionFrame = { type: "extension_ui_response", id, cancelled: true };
    if (command.cancelled !== true) {
      if (pending.method === "confirm" && typeof command.confirmed === "boolean") {
        frame = { type: "extension_ui_response", id, confirmed: command.confirmed };
      } else if (
        pending.method !== "confirm" &&
        typeof command.value === "string" &&
        command.value.length <= MAX_VALUE_CHARS &&
        (pending.method !== "select" || pending.options?.includes(command.value))
      ) {
        frame = { type: "extension_ui_response", id, value: command.value };
      }
    }
    this.#finish(id, frame);
    return true;
  }

  close(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#since = undefined;
    this.#decisionId = undefined;
  }

  #finish(id: string, frame: ChildQuestionFrame): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    try {
      this.io.send(frame);
    } catch {
      // A closed child stdin means the dialog has no reader left.
    }
    if (this.#pending.size === 0) {
      this.#since = undefined;
      this.#decisionId = undefined;
      this.io.blocked(undefined);
    } else {
      this.#reportDecision();
    }
  }

  #reportDecision(): void {
    let decisionId: string | undefined;
    for (const pending of this.#pending.values()) {
      if (pending.decisionId) {
        decisionId = pending.decisionId;
        break;
      }
    }
    if (decisionId === this.#decisionId || this.#since === undefined) return;
    this.#decisionId = decisionId;
    this.io.blocked(this.#since, decisionId);
  }
}
