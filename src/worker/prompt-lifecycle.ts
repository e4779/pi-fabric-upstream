// Five times the recovery window: legacy hosts acknowledge before preflight,
// which can include slow input hooks and compaction. Modern hosts acknowledge
// after preflight; boot/model admission is bounded only by the overall deadline.
export const PI_INITIAL_TURN_TIMEOUT_MS = 300_000;
// An extension command can report "handled" and still start its own turn: it
// calls pi.sendUserMessage or pi.sendMessage without awaiting the run, so the
// receipt precedes agent_start by the run's preparation (compaction check and
// before_agent_start handlers). One recovery window covers that preparation.
export const PI_HANDLED_TASK_GRACE_MS = 60_000;
/** Id of the initial task prompt; later steer, follow-up and operator commands carry none. */
export const PI_TASK_PROMPT_ID = "fabric-task";

const HANDLED_TASK_ERROR = "Pi handled the task without starting a turn; terminating child";
// A child's refusal notice is user-facing text, but it still crosses into the
// parent's result and run log, so it is flattened and bounded.
const MAX_NOTICE_CHARS = 500;

const childNotice = (event: Record<string, unknown>): string | undefined => {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return undefined;
  if (event.notifyType !== "warning" && event.notifyType !== "error") return undefined;
  if (typeof event.message !== "string") return undefined;
  const text = event.message
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return undefined;
  return text.length <= MAX_NOTICE_CHARS ? text : `${text.slice(0, MAX_NOTICE_CHARS - 1)}…`;
};
const ACKNOWLEDGED_TASK_ERROR =
  `Pi acknowledged the task but did not start a turn within ${PI_INITIAL_TURN_TIMEOUT_MS}ms; terminating child`;

/** Tracks only the ordinary task prompt, never later steering or operator commands. */
export class PiTaskPromptLifecycle {
  #id: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #responded = false;
  #started = false;
  #disposed = false;
  #handled = false;
  #handledError = HANDLED_TASK_ERROR;
  #notice: string | undefined;
  private readonly fail: (error: string) => void;

  constructor(fail: (error: string) => void) {
    this.fail = fail;
  }

  sent(id: string): void {
    if (this.#id || this.#disposed) return;
    this.#id = id;
  }

  observe(event: Record<string, unknown>): void {
    if (this.#disposed || !this.#id) return;
    if (event.type === "agent_start") {
      this.#started = true;
      this.#handled = false;
      this.#clearTimer();
      return;
    }
    // An input hook that consumes the task reports why only through a UI
    // notice. Keep the last warning or error sent before the prompt response.
    if (!this.#responded && !this.#started) {
      const notice = childNotice(event);
      if (notice !== undefined) {
        this.#notice = notice;
        return;
      }
    }
    if (event.type !== "response" || event.command !== "prompt" || event.id !== this.#id ||
        event.success !== true || this.#responded) return;
    this.#responded = true;
    if (this.#started) return;
    const data = event.data;
    const disposition = typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).disposition
      : undefined;
    if (disposition === "handled") {
      this.#handled = true;
      this.#handledError = this.#notice === undefined
        ? HANDLED_TASK_ERROR
        : `${HANDLED_TASK_ERROR}. Child notice: ${this.#notice}`;
      this.#arm(PI_HANDLED_TASK_GRACE_MS, this.#handledError);
      return;
    }
    // "started" and "queued" say the task is in a run. A resumed durable
    // request reattaches to its recorded run and sends no agent_start, so only
    // a host that predates dispositions is held to the turn deadline.
    if (disposition === undefined) this.#arm(PI_INITIAL_TURN_TIMEOUT_MS, ACKNOWLEDGED_TASK_ERROR);
  }

  /** The child is gone, so a handled task can no longer start a turn: fail it now. */
  childExited(): void {
    const handled = this.#handled && !this.#disposed;
    this.dispose();
    if (handled) this.fail(this.#handledError);
  }

  #arm(delayMs: number, error: string): void {
    this.#timer = setTimeout(() => {
      this.dispose();
      this.fail(error);
    }, delayMs);
    this.#timer.unref?.();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose(): void {
    this.#clearTimer();
    this.#handled = false;
    this.#disposed = true;
  }
}
