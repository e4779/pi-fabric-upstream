import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_HANDLED_TASK_GRACE_MS,
  PI_INITIAL_TURN_TIMEOUT_MS,
  PI_TASK_PROMPT_ID,
  PiTaskPromptLifecycle,
} from "../src/worker/prompt-lifecycle.js";

afterEach(() => vi.useRealTimers());

const HANDLED = "Pi handled the task without starting a turn; terminating child";
const handledReceipt = { type: "response", command: "prompt", id: "task", success: true, data: { disposition: "handled" } };

describe("Pi task prompt lifecycle", () => {
  it("uses a stable task id", () => {
    expect(PI_TASK_PROMPT_ID).toBe("fabric-task");
  });

  it("bounds a legacy successful acknowledgement without any turn", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    expect(PI_INITIAL_TURN_TIMEOUT_MS).toBe(300_000);
    task.sent("task");
    task.observe({ type: "response", command: "prompt", id: "task", success: true });
    vi.advanceTimersByTime(299_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Pi acknowledged the task but did not start a turn within 300000ms; terminating child",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a handled task once the grace period passes without a turn", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe(handledReceipt);
    // A duplicate receipt must not restart the clock.
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS - 1);
    task.observe(handledReceipt);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(HANDLED);
    vi.advanceTimersByTime(600_000);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a command that handled the prompt start its own turn inside the grace period", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe(handledReceipt);
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS - 1);
    task.observe({ type: "agent_start" });
    vi.advanceTimersByTime(600_000);
    task.childExited();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a handled task at once when the child exits before any turn", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe(handledReceipt);
    task.childExited();
    task.childExited();
    expect(fail).toHaveBeenCalledExactlyOnceWith(HANDLED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fail on child exit when nothing was handled", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.childExited();
    expect(fail).not.toHaveBeenCalled();
  });

  it("never copies fields from the receipt into the failure", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ ...handledReceipt, data: { disposition: "handled", headers: "SECRET" }, error: "SECRET" });
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS);
    expect(fail).toHaveBeenCalledExactlyOnceWith(HANDLED);
  });

  it("names the child's last warning notice in a handled-task failure", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    const notify = (message: unknown, notifyType: unknown) =>
      task.observe({ type: "extension_ui_request", id: "ui", method: "notify", message, notifyType });
    notify("before the task was sent", "warning");
    task.sent("task");
    notify("first warning", "warning");
    notify("Refused: select\nopenai-codex/gpt-5.5\u202e now", "error");
    // Neither an info notice nor a non-string message replaces the refusal.
    notify("informational chatter", "info");
    notify(42, "warning");
    task.observe({ ...handledReceipt, data: { disposition: "handled", headers: "SECRET" }, error: "SECRET" });
    notify("after the response", "warning");
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      `${HANDLED}. Child notice: Refused: select openai-codex/gpt-5.5 now`,
    );
  });

  it("carries the child's notice into the failure when the child exits first", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "Select a model" });
    task.observe(handledReceipt);
    task.childExited();
    expect(fail).toHaveBeenCalledExactlyOnceWith(`${HANDLED}. Child notice: Select a model`);
  });

  it("bounds an oversized notice and ignores notices once a turn started", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "x".repeat(2_000) });
    task.observe(handledReceipt);
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS);
    expect(fail).toHaveBeenCalledExactlyOnceWith(`${HANDLED}. Child notice: ${"x".repeat(499)}…`);

    const started = vi.fn();
    const later = new PiTaskPromptLifecycle(started);
    later.sent("task");
    later.observe({ type: "agent_start" });
    later.observe({ type: "extension_ui_request", method: "notify", notifyType: "warning", message: "late" });
    later.observe(handledReceipt);
    later.childExited();
    vi.advanceTimersByTime(PI_HANDLED_TASK_GRACE_MS);
    expect(started).not.toHaveBeenCalled();
  });

  it.each([undefined, "started", "queued"])("allows a delayed turn after %s acknowledgement", disposition => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    // Boot, admission and modern preflight can consume the overall run budget.
    vi.advanceTimersByTime(600_000);
    expect(vi.getTimerCount()).toBe(0);
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition } });
    vi.advanceTimersByTime(299_999);
    task.observe({ type: "agent_start" });
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["started", "queued"])("holds a %s task to no turn deadline", disposition => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition } });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    task.childExited();
    expect(fail).not.toHaveBeenCalled();
  });

  it.each(["started", "handled"])("allows start-before-ack and post-start %s receipts", disposition => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    task.observe({ type: "agent_start" });
    task.observe({ type: "response", command: "prompt", id: "task", success: true, data: { disposition } });
    task.observe({ type: "response", command: "steer", success: true, data: { disposition: "handled" } });
    vi.advanceTimersByTime(600_000);
    task.childExited();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not refresh the deadline on duplicate responses or lifecycle chatter", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    const ack = { type: "response", command: "prompt", id: "task", success: true };
    task.observe(ack);
    vi.advanceTimersByTime(250_000);
    task.observe(ack);
    task.observe({ type: "queue_update", steering: [] });
    vi.advanceTimersByTime(50_000);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unmatched handled commands and leaves native rejection to the worker", () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    for (const command of ["prompt", "steer", "follow_up"]) {
      task.observe({ type: "response", command, id: "operator", success: true, data: { disposition: "handled" } });
    }
    task.observe({ type: "response", command: "prompt", id: "task", success: false, error: "native error" });
    vi.advanceTimersByTime(600_000);
    task.childExited();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["acknowledged", "handled", "unanswered"] as const)("clears timers on teardown and ignores late messages (%s)", state => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const task = new PiTaskPromptLifecycle(fail);
    task.sent("task");
    if (state === "acknowledged") task.observe({ type: "response", command: "prompt", id: "task", success: true });
    if (state === "handled") task.observe(handledReceipt);
    task.dispose();
    task.observe(handledReceipt);
    task.sent("late-task");
    task.childExited();
    vi.advanceTimersByTime(600_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
