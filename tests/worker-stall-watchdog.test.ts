import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_PROGRAM_DEADLINE_GRACE_MS,
  PI_STREAM_STALL_TIMEOUT_MS,
  PiStallWatchdog,
} from "../src/worker/recovery-watchdog.js";

afterEach(() => vi.useRealTimers());

const MINUTE = 60_000;
const setup = () => {
  vi.useFakeTimers();
  const fail = vi.fn();
  const watchdog = new PiStallWatchdog(fail);
  const observe = (event: Record<string, unknown>) => watchdog.observe(event);
  return { fail, watchdog, observe };
};
const delta = { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } };
const ui = { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "jobs" };

describe("PiStallWatchdog stream silence", () => {
  it("uses a 30 minute threshold", () => {
    // Longer than any whole model response measured across 177,636 responses (26 minutes).
    expect(PI_STREAM_STALL_TIMEOUT_MS).toBe(30 * MINUTE);
  });

  it("fails a turn whose stream stops mid tool call, despite UI chatter", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    observe(delta);
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(MINUTE);
      observe(ui);
      observe({ type: "queue_update", steering: [], followUp: [] });
    }
    vi.advanceTimersByTime(MINUTE - 1);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Pi stream stalled: no model, tool or turn event for 1800000ms; terminating child",
    );
    vi.advanceTimersByTime(4 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("restarts the window on each model event", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(25 * MINUTE);
      observe(delta);
    }
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not count a running tool, a compaction or a parent question as silence", () => {
    const { fail, watchdog, observe } = setup();
    observe({ type: "agent_start" });
    observe({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: {} });
    vi.advanceTimersByTime(5 * PI_STREAM_STALL_TIMEOUT_MS);
    observe({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false });
    observe({ type: "compaction_start", reason: "threshold" });
    vi.advanceTimersByTime(5 * PI_STREAM_STALL_TIMEOUT_MS);
    observe({ type: "compaction_end", reason: "threshold" });
    watchdog.blocked(true);
    vi.advanceTimersByTime(5 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).not.toHaveBeenCalled();
    watchdog.blocked(false);
    vi.advanceTimersByTime(PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("holds while any one of several parallel tools still runs", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    observe({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
    observe({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} });
    observe({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
    vi.advanceTimersByTime(3 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).not.toHaveBeenCalled();
    observe({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: false });
    vi.advanceTimersByTime(PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("leaves an idle child between turns alone and stops on dispose", () => {
    const { fail, watchdog, observe } = setup();
    observe({ type: "agent_start" });
    observe({ type: "agent_end", willRetry: false });
    observe({ type: "agent_settled" });
    vi.advanceTimersByTime(10 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).not.toHaveBeenCalled();
    observe({ type: "agent_start" });
    watchdog.dispose();
    observe(delta);
    vi.advanceTimersByTime(10 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("PiStallWatchdog program deadline", () => {
  const start = { type: "tool_execution_start", toolCallId: "fx", toolName: "fabric_exec", args: { code: "" } };
  const update = (details: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "tool_execution_update", toolCallId: "fx", toolName: "fabric_exec", args: {},
    partialResult: { content: [], details }, ...extra,
  });

  it("fails a fabric_exec call that is still running well past its reported deadline", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    observe(start);
    observe(update({ progress: "Calling sessions.wait", deadlineAt: Date.now() + 290_000 }));
    vi.advanceTimersByTime(290_000 + PI_PROGRAM_DEADLINE_GRACE_MS - 1);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      `fabric_exec call fx was still running ${PI_PROGRAM_DEADLINE_GRACE_MS}ms after its program deadline; terminating child`,
    );
  });

  it("follows a raised deadline, stops enforcing while paused, and ends with the call", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    observe(start);
    observe(update({ deadlineAt: Date.now() + 1_000 }));
    observe(update({ deadlineAt: Date.now() + 10 * MINUTE }));
    vi.advanceTimersByTime(5 * MINUTE);
    expect(fail).not.toHaveBeenCalled();
    // A human wait pauses the program deadline: the update carries none.
    observe(update({ progress: "Calling extensions.ask" }));
    vi.advanceTimersByTime(10 * PI_STREAM_STALL_TIMEOUT_MS);
    expect(fail).not.toHaveBeenCalled();
    observe(update({ deadlineAt: Date.now() + 1_000 }));
    observe({ type: "tool_execution_end", toolCallId: "fx", toolName: "fabric_exec", isError: false });
    vi.advanceTimersByTime(1_000 + PI_PROGRAM_DEADLINE_GRACE_MS);
    expect(fail).not.toHaveBeenCalled();
  });

  it("ignores other tools and nested calls that report a deadline", () => {
    const { fail, observe } = setup();
    observe({ type: "agent_start" });
    observe(start);
    observe({ ...update({ deadlineAt: Date.now() }), toolName: "bash" });
    observe(update({ deadlineAt: Date.now() }, { parentToolCallId: "outer" }));
    vi.advanceTimersByTime(PI_PROGRAM_DEADLINE_GRACE_MS * 5);
    expect(fail).not.toHaveBeenCalled();
  });
});
