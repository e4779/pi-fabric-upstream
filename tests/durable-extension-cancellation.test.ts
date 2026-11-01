// Real-kernel deadlines plus custom-runtime settlement: no provider starts after admission closes.
import { describe, expect, it, vi } from "vitest";
import { FabricDurableJournal } from "../src/durable-journal.js";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxTerminationReason } from "../src/runtime/kernel.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { latch, runProgram } from "./durable-extension-host.js";

/** Keep the actual dispatch promises, not just the kernel's abortable waiters. */
const trackedKernel = () => {
  const kernel = new QuickJsRuntime();
  const calls: Promise<unknown>[] = [];
  const runtime: FabricKernelRuntime = {
    execute: (code, hostCall, options) => kernel.execute(code, (...args) => {
      const call = hostCall(...args);
      calls.push(call);
      return call;
    }, options),
  };
  return { runtime, calls };
};

describe("durable provider cancellation", () => {
  it("does not start a provider when its intent finishes after the kernel deadline", async () => {
    const release = latch();
    const { runtime, calls } = trackedKernel();
    const action = vi.fn(() => "too late");
    const original = FabricDurableJournal.prototype.intent;
    let committed = false;
    const intent = vi.spyOn(FabricDurableJournal.prototype, "intent").mockImplementation(async function (this: FabricDurableJournal, seq, ref) {
      await original.call(this, seq, ref);
      committed = true;
      // Model persistence whose completion is not cancelled along with the kernel's waiter.
      await release.opened;
    });
    try {
      const run = await runProgram('return notes.add({})', {
        fabric: { runtime, timeoutMs: 300, providers: { notes: { actions: { add: action } } } },
      });
      expect(committed).toBe(true);
      expect(run.isError).toBe(true);
      expect(run.text).toContain("timed_out");
      expect(action).not.toHaveBeenCalled();
      release.open();
      await Promise.allSettled(calls);
      expect(action).not.toHaveBeenCalled();
    } finally {
      release.open();
      await Promise.allSettled(calls);
      intent.mockRestore();
    }
  }, 10_000);

  it("aborts an already-running provider through its Context at the kernel deadline", async () => {
    const release = latch();
    const { runtime, calls } = trackedKernel();
    let signal: AbortSignal | undefined;
    let observedAbort = false;
    try {
      const run = await runProgram('return notes.wait({})', {
        fabric: { runtime, timeoutMs: 300, providers: { notes: { actions: {
          wait: async (_args, call) => {
            signal = call.context.abortSignal;
            const onAbort = () => { observedAbort = true; release.open(); };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
            try { await release.opened; return "finished"; }
            finally { signal?.removeEventListener("abort", onAbort); }
          },
        } } } },
      });
      expect(run.isError).toBe(true);
      expect(run.text).toContain("timed_out");
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(true);
      expect(observedAbort).toBe(true);
    } finally {
      release.open();
      await Promise.allSettled(calls);
    }
  }, 10_000);

  it.each<FabricSandboxTerminationReason | "throw">([
    "completed", "timed_out", "aborted", "runtime_error", "throw",
  ])("closes a retained dispatcher when a custom runtime settles with %s", async (reason) => {
    let dispatch: FabricHostCall | undefined;
    const signal = new AbortController().signal; // Deliberately never aborted by this custom runtime.
    const action = vi.fn(() => "too late");
    const runtime: FabricKernelRuntime = {
      execute: async (_code, hostCall) => {
        dispatch = hostCall;
        if (reason === "throw") throw new Error("runtime failed");
        return { value: "done", logs: [], terminationReason: reason };
      },
    };
    await runProgram("return 1", { fabric: { runtime, providers: { notes: { actions: { add: action } } } } });
    expect(dispatch).toBeDefined();
    await expect(dispatch!("fabric.$call", { ref: "notes.add", args: {} }, signal)).rejects.toThrow("stopped");
    expect(action).not.toHaveBeenCalled();
  });
});
