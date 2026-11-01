export const PI_RECOVERY_TIMEOUT_MS = 60_000;

/** Bounds stalled Pi error recovery, not healthy inference or tool execution. */
export class PiRecoveryWatchdog {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reason: string | undefined;
  #disposed = false;

  constructor(private readonly fail: (error: string) => void) {}

  arm(reason: string): void {
    if (this.#disposed) return;
    this.#reason = reason;
    // Repeated errors, retry announcements and lifecycle chatter are not progress.
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      const error = this.#reason;
      this.dispose();
      this.fail(`${error}; Pi made no recovery progress for ${PI_RECOVERY_TIMEOUT_MS}ms; terminating child`);
    }, PI_RECOVERY_TIMEOUT_MS);
    this.#timer.unref?.();
  }

  progress(): void {
    if (!this.#reason || this.#disposed) return;
    const reason = this.#reason;
    this.clear();
    this.arm(reason);
  }

  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#reason = undefined;
  }

  dispose(): void {
    this.clear();
    this.#disposed = true;
  }
}

/**
 * A turn in which no model, tool or turn event arrives for this long has
 * stalled. It is longer than the longest whole model response we measured
 * (26 minutes across 177,636 responses), and while the turn waits on a tool,
 * a compaction or a parent answer it does not run at all.
 */
export const PI_STREAM_STALL_TIMEOUT_MS = 30 * 60_000;
/** How long a fabric_exec call may outlive the program deadline it reported. */
export const PI_PROGRAM_DEADLINE_GRACE_MS = 5 * 60_000;

// Widget and status chatter from extensions, and queue snapshots, are not
// progress: a stalled child can emit several of these a second.
const NOT_PROGRESS = new Set(["extension_ui_request", "queue_update"]);

/**
 * Fails a Pi child whose turn goes silent, and a fabric_exec call that keeps
 * running past the program deadline it reported in its own progress updates.
 */
export class PiStallWatchdog {
  #active = false;
  #compacting = false;
  #blocked = false;
  #disposed = false;
  #lastActivityAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #openTools = new Set<string>();
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly fail: (error: string) => void) {}

  observe(event: Record<string, unknown>): void {
    if (this.#disposed || typeof event.type !== "string" || NOT_PROGRESS.has(event.type)) return;
    const topLevel = typeof event.parentToolCallId !== "string";
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    switch (event.type) {
      case "agent_start":
        this.#active = true;
        break;
      case "agent_end":
        if (event.willRetry !== true) this.#endTurn();
        break;
      case "agent_settled":
        this.#endTurn();
        break;
      case "compaction_start":
        this.#compacting = true;
        break;
      case "compaction_end":
        this.#compacting = false;
        break;
      case "tool_execution_start":
        if (topLevel && toolCallId) this.#openTools.add(toolCallId);
        break;
      case "tool_execution_end":
        if (topLevel && toolCallId) {
          this.#openTools.delete(toolCallId);
          this.#clearDeadline(toolCallId);
        }
        break;
      case "tool_execution_update":
        if (topLevel && toolCallId && event.toolName === "fabric_exec" && this.#openTools.has(toolCallId)) {
          this.#programDeadline(toolCallId, event.partialResult);
        }
        break;
    }
    this.#lastActivityAt = Date.now();
    this.#schedule();
  }

  /** A parent question is open: the child waits for an answer, not the model. */
  blocked(value: boolean): void {
    if (this.#disposed || this.#blocked === value) return;
    this.#blocked = value;
    this.#lastActivityAt = Date.now();
    this.#schedule();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const timer of this.#deadlines.values()) clearTimeout(timer);
    this.#deadlines.clear();
  }

  #endTurn(): void {
    this.#active = false;
    this.#openTools.clear();
    for (const id of [...this.#deadlines.keys()]) this.#clearDeadline(id);
  }

  #watching(): boolean {
    return this.#active && !this.#compacting && !this.#blocked && this.#openTools.size === 0;
  }

  #schedule(): void {
    if (this.#disposed || this.#timer || !this.#watching()) return;
    const wait = this.#lastActivityAt + PI_STREAM_STALL_TIMEOUT_MS - Date.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || !this.#watching()) return;
      if (Date.now() - this.#lastActivityAt < PI_STREAM_STALL_TIMEOUT_MS) {
        this.#schedule();
        return;
      }
      this.dispose();
      this.fail(`Pi stream stalled: no model, tool or turn event for ${PI_STREAM_STALL_TIMEOUT_MS}ms; terminating child`);
    }, Math.max(0, wait));
    this.#timer.unref?.();
  }

  #programDeadline(toolCallId: string, partialResult: unknown): void {
    const details = typeof partialResult === "object" && partialResult !== null
      ? (partialResult as { details?: unknown }).details
      : undefined;
    const deadlineAt = typeof details === "object" && details !== null
      ? (details as { deadlineAt?: unknown }).deadlineAt
      : undefined;
    this.#clearDeadline(toolCallId);
    // No deadline means none is running: a human wait paused it, or the child
    // runs a Fabric build that does not report one.
    if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) return;
    const timer = setTimeout(() => {
      this.#deadlines.delete(toolCallId);
      if (this.#disposed || !this.#openTools.has(toolCallId)) return;
      this.dispose();
      this.fail(
        `fabric_exec call ${toolCallId} was still running ${PI_PROGRAM_DEADLINE_GRACE_MS}ms after its program deadline; terminating child`,
      );
    }, Math.min(2_147_483_647, Math.max(0, deadlineAt + PI_PROGRAM_DEADLINE_GRACE_MS - Date.now())));
    timer.unref?.();
    this.#deadlines.set(toolCallId, timer);
  }

  #clearDeadline(toolCallId: string): void {
    const timer = this.#deadlines.get(toolCallId);
    if (timer) clearTimeout(timer);
    this.#deadlines.delete(toolCallId);
  }
}
