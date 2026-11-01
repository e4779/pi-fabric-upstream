import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricActionPolicyHooks } from "../src/core/action-policy-hooks.js";
import { ApprovalController, FabricSessionApprovals } from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { normalizeFabricConfig } from "../src/config.js";

const action = { ref: "demo.act", provider: "demo", name: "act", description: "test", inputSchema: {}, risk: "write" as const };
const noUi = { hasUI: false } as ExtensionContext;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

it("rejects null as malformed instead of permitting a configured allow", async () => {
  const hooks = new FabricActionPolicyHooks();
  hooks.register("broken", () => null as never);
  expect(await hooks.evaluate(action, {}, { caller: "program" })).toEqual({
    decision: "deny", hook: "broken", reason: "the hook returned a malformed decision",
  });
  const controller = new ApprovalController(
    normalizeFabricConfig({ approvals: { write: "allow" } }).approvals,
    noUi, undefined, undefined, undefined, undefined, undefined, hooks.bind({ caller: "program" }),
  );
  await expect(controller.approve(action)).rejects.toThrow("malformed decision");
});

it("an old disposer cannot remove the same function registered again under the same name", async () => {
  const hooks = new FabricActionPolicyHooks();
  const hook = () => ({ decision: "deny" as const, reason: "writes frozen" });
  const stale = hooks.register("policy", hook);
  const current = hooks.register("policy", hook);
  stale();
  stale();
  expect(hooks.size).toBe(1);
  expect(await hooks.evaluate(action, {}, { caller: "program" })).toEqual({ decision: "deny", hook: "policy", reason: "writes frozen" });
  current();
  expect(hooks.size).toBe(0);
  hooks.register("policy", hook);
  current();
  expect(hooks.size).toBe(1);
});

describe.each(["quickjs", "node-process"] as const)("%s call lifetime", runtime => {
  it.each([
    { stage: "hook", stop: "deadline" },
    { stage: "headless", stop: "deadline" },
    { stage: "queued", stop: "deadline" },
    { stage: "hook", stop: "caller" },
    { stage: "headless", stop: "caller" },
    { stage: "hook", stop: "registry" },
    { stage: "headless", stop: "registry" },
  ] as const)("$stop cancellation stops $stage work without late approval effects", async ({ stage, stop }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const registry = new ActionRegistry();
    let ran = 0;
    const descriptor = { name: "act", description: "test", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "write" as const };
    registry.register({ name: "demo", description: "test", async list() { return [descriptor]; }, async describe() { return descriptor; }, async invoke() { ran++; return true; } });
    const config = normalizeFabricConfig({ fullCodeMode: true, executor: { runtime }, approvals: { policyHooks: true, write: "allow", headless: "decision" } });
    const service = new FabricExecutionService(registry, config);
    const hooks = new FabricActionPolicyHooks();
    const release = deferred<void>();
    const entered = deferred<void>();
    const bothHooks = deferred<void>();
    const hookSignals: AbortSignal[] = [];
    const approvalSignals: Array<AbortSignal | undefined> = [];
    hooks.register("slow", async ({ signal }) => {
      hookSignals.push(signal);
      if (hookSignals.length === 2) bothHooks.resolve();
      if (stage === "hook") { entered.resolve(); await release.promise; }
      return { decision: "hold", reason: "manual review" };
    });
    service.setActionPolicyHooks(hooks);
    service.setHeadlessApproval(async (_action, _reason, signal) => {
      approvalSignals.push(signal);
      entered.resolve();
      await release.promise;
      return true;
    });
    const outer = new AbortController();
    try {
      const resultPromise = service.execute({
        code: stage === "queued"
          ? 'return await Promise.all([tools.call({ref:"demo.act",args:{}}), tools.call({ref:"demo.act",args:{}})]);'
          : 'return await tools.call({ref:"demo.act",args:{}});',
        hardTimeoutMs: 1000, signal: outer.signal, parentToolCallId: "review-timeout",
        context: { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "review", getSessionFile: () => undefined } } as unknown as ExtensionContext,
        onPartial() {},
      });
      await entered.promise;
      if (stage === "queued") await bothHooks.promise;
      if (stop === "deadline") await vi.advanceTimersByTimeAsync(1001);
      else if (stop === "caller") outer.abort(new Error("caller cancelled"));
      else await registry.close();
      const result = await resultPromise;
      expect(result.success).toBe(false);
      if (stop === "deadline") expect(result.error).toMatch(/timed out/i);
      expect(outer.signal.aborted).toBe(stop === "caller");
      if (stage === "hook") expect(hookSignals[0]?.aborted).toBe(true);
      else expect(approvalSignals[0]?.aborted).toBe(true);
      release.resolve();
      await flush();
      expect(approvalSignals).toHaveLength(stage === "hook" ? 0 : 1);
      expect(ran).toBe(0);
    } finally {
      outer.abort();
      release.resolve();
      await registry.close();
    }
  });
});

it("cancelled approval never grants a session risk or sends a late notification", async () => {
  const reply = deferred<string>();
  const entered = deferred<void>();
  const notify = vi.fn();
  let dialogSignal: AbortSignal | undefined;
  const context = { hasUI: true, mode: "rpc", ui: {
    notify,
    select: vi.fn((_title: string, _options: string[], options?: { signal?: AbortSignal }) => { dialogSignal = options?.signal; entered.resolve(); return reply.promise; }),
  } } as unknown as ExtensionContext;
  const session = new FabricSessionApprovals();
  const controller = new ApprovalController(normalizeFabricConfig({ approvals: { write: "ask" } }).approvals, context, session);
  const abort = new AbortController();
  const pending = controller.approve(action, {}, undefined, abort.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await entered.promise;
  abort.abort(new Error("cancelled"));
  await rejected;
  expect(dialogSignal?.aborted).toBe(true);
  reply.resolve("Allow write access for this session");
  await flush();
  expect(session.approvedRisks.size).toBe(0);
  expect(notify).toHaveBeenCalledTimes(1); // Only the initial request, not an allow notification.
});

it("one call's cancellation does not cancel another call on the same approval controller", async () => {
  const hooks = new FabricActionPolicyHooks();
  const releases = [deferred<void>(), deferred<void>()];
  const entered = deferred<void>();
  let count = 0;
  hooks.register("policy", async ({ args }) => {
    if (++count === 2) entered.resolve();
    await releases[Number(args.index)]!.promise;
    return { decision: "hold", reason: "check" };
  });
  const headless = vi.fn(async () => true);
  const controller = new ApprovalController(
    normalizeFabricConfig({ approvals: { write: "allow", headless: "decision" } }).approvals,
    noUi, undefined, undefined, undefined, undefined, headless,
    hooks.bind({ caller: "program" }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = controller.approve(action, { index: 0 }, undefined, first.signal);
  const rejected = expect(cancelled).rejects.toThrow("first cancelled");
  const live = controller.approve(action, { index: 1 }, undefined, second.signal);
  await entered.promise;
  first.abort(new Error("first cancelled"));
  await rejected;
  releases.forEach(release => release.resolve());
  await expect(live).resolves.toBeUndefined();
  expect(second.signal.aborted).toBe(false);
  expect(headless).toHaveBeenCalledExactlyOnceWith(action, "Held by policy hook policy: check", second.signal);
});

it("dismisses a cancelled custom TUI prompt through its host completion callback", async () => {
  const entered = deferred<void>();
  const notify = vi.fn();
  const done = vi.fn();
  const context = { hasUI: true, mode: "tui", ui: {
    notify,
    custom: (factory: (...args: any[]) => unknown) => new Promise(resolve => {
      done.mockImplementation(resolve);
      factory({ requestRender() {} }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }, {}, done);
      entered.resolve();
    }),
  } } as unknown as ExtensionContext;
  const session = new FabricSessionApprovals();
  const controller = new ApprovalController(normalizeFabricConfig({ approvals: { write: "ask" } }).approvals, context, session);
  const abort = new AbortController();
  const pending = controller.approve(action, {}, undefined, abort.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await entered.promise;
  abort.abort(new Error("cancelled"));
  await rejected;
  expect(done).toHaveBeenCalledExactlyOnceWith("deny");
  expect(session.approvedRisks.size).toBe(0);
  expect(notify).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"] as const)("late classifier %s cannot audit or open approval after cancellation", async outcome => {
  const result = deferred<never>();
  const entered = deferred<void>();
  const classify = vi.fn(() => { entered.resolve(); return result.promise; });
  const audit = vi.fn();
  const headless = vi.fn(async () => true);
  const controller = new ApprovalController(
    normalizeFabricConfig({ approvals: { write: "auto", headless: "decision" } }).approvals,
    noUi, undefined, { classify } as unknown as FabricAutoApprovalClassifier, audit, undefined, headless,
  );
  const abort = new AbortController();
  const pending = controller.approve(action, {}, undefined, abort.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await entered.promise;
  abort.abort(new Error("cancelled"));
  await rejected;
  // Both a fulfilled and failed classifier used to continue into audit/approval work.
  if (outcome === "resolve") result.resolve({ decision: "escalate", reason: "review", model: "test" } as never);
  // A rejection is observed by runAbortable even after cancellation.
  else result.reject(new Error("late classifier failure"));
  await flush();
  expect(audit).not.toHaveBeenCalled();
  expect(headless).not.toHaveBeenCalled();
});
