import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry, type ResolvedFabricAction } from "../src/core/action-registry.js";
import {
  FabricActionPolicyHooks,
  type FabricActionPolicyHookV1,
  type FabricActionPolicyInputV1,
} from "../src/core/action-policy-hooks.js";
import {
  ApprovalController,
  FabricSessionApprovals,
  type FabricActionPolicyGate,
} from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { JevClient, JevCredentials } from "../src/jev/client.js";
import { JevProvider } from "../src/providers/jev-provider.js";
import { readFabricActionPolicyRegistrationV1 } from "../src/protocol.js";
import { callProgram, jevContext, launch } from "./jev-test-helpers.js";

const action: ResolvedFabricAction = {
  ref: "demo.write",
  provider: "demo",
  name: "write",
  description: "Write data",
  inputSchema: {},
  risk: "write",
};

const policies = {
  read: "allow" as const,
  write: "ask" as const,
  execute: "deny" as const,
  network: "ask" as const,
  agent: "ask" as const,
};

const noUi = { hasUI: false } as ExtensionContext;
const tuiContext = (custom: (...args: unknown[]) => Promise<unknown>): ExtensionContext => ({
  hasUI: true,
  mode: "tui",
  ui: { custom, notify: vi.fn() },
} as unknown as ExtensionContext);

const gateFor = (hooks: FabricActionPolicyHooks): FabricActionPolicyGate => ({
  get active() { return hooks.size > 0; },
  evaluate: (candidate, args) => hooks.evaluate(candidate, args, { caller: "program" }),
});

const controllerWith = (
  hook: FabricActionPolicyHookV1,
  config: typeof policies & { actions?: Record<string, "allow" | "ask" | "deny"> } = policies,
  context: ExtensionContext = noUi,
  sessionApprovals = new FabricSessionApprovals(),
) => {
  const hooks = new FabricActionPolicyHooks();
  hooks.register("policy", hook);
  return new ApprovalController(config, context, sessionApprovals, undefined, undefined, undefined, undefined, gateFor(hooks));
};

describe("ApprovalController with action policy hooks", () => {
  it("a hook deny blocks an action the configuration allows", async () => {
    const controller = controllerWith(() => ({ decision: "deny", reason: "outside working hours" }));
    await expect(controller.approve({ ...action, risk: "read" }))
      .rejects.toThrow("demo.write is denied by the Fabric action policy hook policy: outside working hours");
  });

  it("a hook allow settles an ask without a prompt", async () => {
    const custom = vi.fn(async () => "deny");
    const controller = controllerWith(() => ({ decision: "allow" }), policies, tuiContext(custom));
    await expect(controller.approve(action)).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });

  it("a hook allow never lifts an approvals.actions deny or a risk-class deny", async () => {
    const allow = () => ({ decision: "allow" as const });
    await expect(controllerWith(allow, { ...policies, actions: { "demo.write": "deny" } }).approve(action))
      .rejects.toThrow("denied by the Fabric approvals.actions policy");
    await expect(controllerWith(allow).approve({ ...action, risk: "execute" }))
      .rejects.toThrow("denied by the Fabric execute policy");
  });

  it("a hold asks a person even when the configuration and a session grant allow the action", async () => {
    const custom = vi.fn(async () => "deny");
    const session = new FabricSessionApprovals();
    session.approvedRisks.add("write");
    const controller = controllerWith(
      () => ({ decision: "hold", reason: "needs a grant" }),
      { ...policies, read: "allow" },
      tuiContext(custom),
      session,
    );
    await expect(controller.approve({ ...action, risk: "read" })).rejects.toThrow("User denied read access");
    await expect(controller.approve(action)).rejects.toThrow("User denied write access");
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("a hold without a UI fails closed", async () => {
    const controller = controllerWith(() => ({ decision: "hold", reason: "needs a person" }));
    await expect(controller.approve({ ...action, risk: "read" })).rejects.toThrow("no interactive UI");
  });

  it("a hook that throws or answers malformed fails closed", async () => {
    await expect(controllerWith(() => { throw new Error("engine down"); }).approve({ ...action, risk: "read" }))
      .rejects.toThrow("policy hook policy: the hook failed: engine down");
    await expect(controllerWith(() => ({ decision: "deny" }) as never).approve({ ...action, risk: "read" }))
      .rejects.toThrow("the hook returned a malformed decision");
    await expect(controllerWith(() => "allow" as never).approve({ ...action, risk: "read" }))
      .rejects.toThrow("the hook returned a malformed decision");
  });

  it("no opinion leaves the configured policy alone", async () => {
    await expect(controllerWith(() => undefined).approve({ ...action, risk: "read" })).resolves.toBeUndefined();
    await expect(controllerWith(() => undefined).approve(action)).rejects.toThrow("no interactive UI");
  });

  it("a hold raises the headless decision with the hook's reason and runs only on approve", async () => {
    const headless = vi.fn(async () => true);
    const hooks = new FabricActionPolicyHooks();
    hooks.register("policy", () => ({ decision: "hold", reason: "needs a grant" }));
    const controller = new ApprovalController(
      { ...policies, headless: "decision" }, noUi, new FabricSessionApprovals(),
      undefined, undefined, undefined, headless, gateFor(hooks),
    );
    await expect(controller.approve({ ...action, risk: "read" })).resolves.toBeUndefined();
    expect(headless).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "demo.write", risk: "read" }),
      "Held by policy hook policy: needs a grant",
    );
    headless.mockResolvedValueOnce(false);
    await expect(controller.approve({ ...action, risk: "read" })).rejects.toThrow("approval was denied, cancelled, or expired");
    expect(headless).toHaveBeenCalledTimes(2);
  });

  it("a hook allow under auto mode skips the classifier and records an audit naming the hook", async () => {
    const classify = vi.fn(async () => { throw new Error("classifier must not run"); });
    const audits: unknown[] = [];
    const hooks = new FabricActionPolicyHooks();
    hooks.register("engine", () => ({ decision: "allow" }));
    const controller = new ApprovalController(
      { ...policies, write: "auto" }, noUi, new FabricSessionApprovals(),
      { classify } as unknown as FabricAutoApprovalClassifier,
      (audit) => audits.push(audit), undefined, undefined, gateFor(hooks),
    );
    await expect(controller.approve(action)).resolves.toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({
      action: "demo.write",
      risk: "write",
      decision: "allow",
      policyHook: "engine",
      reason: "Allowed by Fabric action policy hook engine",
    })]);
  });

  it("a hook allow over a configured allow records nothing: no prompt was settled", async () => {
    const audits: unknown[] = [];
    const hooks = new FabricActionPolicyHooks();
    hooks.register("engine", () => ({ decision: "allow" }));
    const controller = new ApprovalController(
      policies, noUi, new FabricSessionApprovals(), undefined,
      (audit) => audits.push(audit), undefined, undefined, gateFor(hooks),
    );
    await controller.approve({ ...action, risk: "read" });
    expect(audits).toEqual([]);
  });

  it("an active gate makes decidesWithoutInteraction false", () => {
    expect(controllerWith(() => undefined).decidesWithoutInteraction({ ...action, risk: "read" })).toBe(false);
    expect(new ApprovalController(policies, noUi).decidesWithoutInteraction({ ...action, risk: "read" })).toBe(true);
  });
});

describe("FabricActionPolicyHooks", () => {
  afterEach(() => vi.useRealTimers());

  it("deny beats hold beats allow across hooks", async () => {
    const hooks = new FabricActionPolicyHooks();
    hooks.register("allower", () => ({ decision: "allow" }));
    hooks.register("holder", () => ({ decision: "hold", reason: "wait" }));
    expect(await hooks.evaluate(action, {}, { caller: "program" }))
      .toEqual({ decision: "hold", hook: "holder", reason: "wait" });
    hooks.register("denier", async () => ({ decision: "deny", reason: "no" }));
    expect(await hooks.evaluate(action, {}, { caller: "program" }))
      .toEqual({ decision: "deny", hook: "denier", reason: "no" });
  });

  it("among equal decisions the first registered hook names the verdict", async () => {
    const hooks = new FabricActionPolicyHooks();
    hooks.register("first", async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { decision: "deny", reason: "one" }; });
    hooks.register("second", () => ({ decision: "deny", reason: "two" }));
    expect(await hooks.evaluate(action, {}, { caller: "program" }))
      .toEqual({ decision: "deny", hook: "first", reason: "one" });
  });

  it("strips control characters from a reason before it reaches a prompt or error", async () => {
    const hooks = new FabricActionPolicyHooks();
    hooks.register("ansi", () => ({ decision: "deny", reason: "\u001b[31mx\ny" }));
    const verdict = await hooks.evaluate(action, {}, { caller: "program" });
    expect(verdict?.reason).toBe(" [31mx y");
    expect(verdict?.reason).not.toMatch(/\p{Cc}/u);
    hooks.register("ansi", () => { throw new Error("\u001b[2Jboom\r\n"); });
    const failed = await hooks.evaluate(action, {}, { caller: "program" });
    expect(failed?.reason).toBe("the hook failed:  [2Jboom  ");
    expect(failed?.reason).not.toMatch(/\p{Cc}/u);
  });

  it("a hook past its deadline is denied and sees its signal abort", async () => {
    vi.useFakeTimers();
    const hooks = new FabricActionPolicyHooks(1_000);
    let seen: AbortSignal | undefined;
    hooks.register("slow", (input) => { seen = input.signal; return new Promise(() => {}); });
    const verdict = hooks.evaluate(action, {}, { caller: "program" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await verdict).toEqual({ decision: "deny", hook: "slow", reason: "the hook failed: timed out after 1000 ms" });
    expect(seen?.aborted).toBe(true);
  });

  it("rejects when the caller aborts instead of answering", async () => {
    const hooks = new FabricActionPolicyHooks();
    hooks.register("slow", () => new Promise(() => {}));
    const controller = new AbortController();
    const verdict = hooks.evaluate(action, {}, { caller: "program" }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(verdict).rejects.toThrow("cancelled");
  });

  it("gives each hook private copies of the action and arguments", async () => {
    const hooks = new FabricActionPolicyHooks();
    const seen: FabricActionPolicyInputV1[] = [];
    hooks.register("mutator", (input) => { input.args.path = "/etc/passwd"; input.action.risk = "read"; return undefined; });
    hooks.register("observer", (input) => { seen.push(input); return undefined; });
    const args = { path: "notes.md" };
    const subject = { ...action };
    await hooks.evaluate(subject, args, { caller: "program", parentToolCallId: "call-1" });
    expect(args).toEqual({ path: "notes.md" });
    expect(subject.risk).toBe("write");
    expect(seen[0]?.args).toEqual({ path: "notes.md" });
    expect(seen[0]?.context).toEqual({ caller: "program", parentToolCallId: "call-1" });
  });

  it("re-registering a name replaces the hook and a stale unregister is a no-op", async () => {
    const hooks = new FabricActionPolicyHooks();
    const stale = hooks.register("engine", () => ({ decision: "deny", reason: "old" }));
    const current = hooks.register("engine", () => ({ decision: "deny", reason: "new" }));
    stale();
    expect(hooks.size).toBe(1);
    expect((await hooks.evaluate(action, {}, { caller: "program" }))?.reason).toBe("new");
    current();
    expect(hooks.size).toBe(0);
    expect(() => hooks.register("bad:name", () => undefined)).toThrow("must match");
  });

  it("re-registering a name keeps its original position for ties", async () => {
    const hooks = new FabricActionPolicyHooks();
    hooks.register("engine", () => ({ decision: "deny", reason: "old" }));
    hooks.register("other", () => ({ decision: "deny", reason: "other" }));
    hooks.register("engine", () => ({ decision: "deny", reason: "reloaded" }));
    expect(await hooks.evaluate(action, {}, { caller: "program" }))
      .toEqual({ decision: "deny", hook: "engine", reason: "reloaded" });
  });
});

describe("action policy hook configuration and registration", () => {
  it("approvals.policyHooks is on only for an explicit true", () => {
    expect(normalizeFabricConfig({ approvals: { policyHooks: true } }).approvals.policyHooks).toBe(true);
    expect(normalizeFabricConfig({ approvals: { policyHooks: "true" } }).approvals.policyHooks).toBeUndefined();
    expect(normalizeFabricConfig({}).approvals.policyHooks).toBeUndefined();
  });

  it("reads a registration by named fields only", () => {
    const hook = () => undefined;
    const registration = readFabricActionPolicyRegistrationV1({ version: 1, name: "engine", hook, extra: "dropped" });
    expect(registration).toEqual({ version: 1, name: "engine", hook });
    expect(readFabricActionPolicyRegistrationV1({ version: 2, name: "engine", hook })).toBeUndefined();
    expect(readFabricActionPolicyRegistrationV1({ version: 1, name: "engine", hook: "nope" })).toBeUndefined();
  });
});

describe("fabric_exec programs consult action policy hooks", () => {
  const registries: ActionRegistry[] = [];
  afterEach(async () => {
    await Promise.all(registries.splice(0).map(registry => registry.close()));
  });

  const fixture = (
    policyHooks: boolean,
    answer: () => ReturnType<FabricActionPolicyHookV1> = () => ({ decision: "deny", reason: "writes are frozen" }),
    write: "allow" | "ask" = "allow",
  ) => {
    const registry = new ActionRegistry();
    registries.push(registry);
    let ran = 0;
    const descriptor = {
      name: "act",
      description: "write action stub",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "write" as const,
    };
    registry.register({
      name: "extensions",
      description: "fake extensions",
      async list() { return [descriptor]; },
      async describe(name) { return name === "act" ? descriptor : undefined; },
      async invoke() { ran++; return { done: true }; },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.write = write;
    if (policyHooks) config.approvals.policyHooks = true;
    const hooks = new FabricActionPolicyHooks();
    const inputs: FabricActionPolicyInputV1[] = [];
    hooks.register("engine", (input) => {
      inputs.push(input);
      return answer();
    });
    const service = new FabricExecutionService(registry, config);
    service.setActionPolicyHooks(hooks);
    const run = () => service.execute({
      code: "return await extensions.act({ path: 'notes.md' });",
      signal: new AbortController().signal,
      parentToolCallId: "outer-call",
      context: { cwd: process.cwd(), hasUI: false, sessionManager: {
        getSessionId: () => "policy-hook-test", getSessionFile: () => undefined,
      } } as unknown as ExtensionContext,
      onPartial() {},
    });
    return { run, ran: () => ran, inputs };
  };

  it("denies the call before the provider runs when approvals.policyHooks is true", async () => {
    const { run, ran, inputs } = fixture(true);
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toContain("extensions.act is denied by the Fabric action policy hook engine: writes are frozen");
    expect(ran()).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.action.ref).toBe("extensions.act");
    expect(inputs[0]?.args).toEqual({ path: "notes.md" });
    expect(inputs[0]?.context).toEqual({ caller: "program", parentToolCallId: "outer-call" });
  });

  it("traces a hook allow that settles an ask, naming the hook", async () => {
    const { run, ran } = fixture(true, () => ({ decision: "allow" }), "ask");
    const result = await run();
    expect(result.success).toBe(true);
    expect(ran()).toBe(1);
    expect(result.trace.operations).toContainEqual(expect.objectContaining({
      ref: "fabric.approval.auto",
      result: expect.objectContaining({ decision: "allow", policyHook: "engine" }),
    }));
  });

  it("ignores registered hooks when approvals.policyHooks is absent", async () => {
    const { run, ran, inputs } = fixture(false);
    const result = await run();
    expect(result.success).toBe(true);
    expect(ran()).toBe(1);
    expect(inputs).toHaveLength(0);
  });
});

describe("Jev programs consult action policy hooks", () => {
  const registries: ActionRegistry[] = [];
  afterEach(async () => {
    await Promise.all(registries.splice(0).map(registry => registry.close()));
  });

  const fixture = (policyHooks: boolean) => {
    const config = normalizeFabricConfig({
      approvals: { network: "allow", execute: "allow", read: "allow", write: "allow", ...(policyHooks ? { policyHooks: true } : {}) },
    });
    const registry = new ActionRegistry();
    registries.push(registry);
    let ran = 0;
    const descriptor = {
      name: "act",
      description: "write action stub",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "write" as const,
    };
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() { return [descriptor]; },
      async describe(name) { return name === "act" ? descriptor : undefined; },
      async invoke() { ran++; return { done: true }; },
    });
    const hooks = new FabricActionPolicyHooks();
    const inputs: FabricActionPolicyInputV1[] = [];
    hooks.register("engine", (input) => {
      inputs.push(input);
      return input.action.ref === "demo.act" ? { decision: "deny", reason: "writes are frozen" } : undefined;
    });
    const client = new JevClient(config.jev, undefined, new JevCredentials([], { TYPESAFE_API_KEY: "test-only-never-a-real-key" }));
    const provider = new JevProvider({ registry, config, actionPolicyHooks: hooks }, client);
    registry.register(provider);
    const run = () => callProgram(provider, "run", launch(
      'return await tools.call({ ref: "demo.act", args: { path: "notes.md" } });',
      { requires: ["demo.act"] },
    ), jevContext());
    return { run, ran: () => ran, inputs };
  };

  it("a hook deny on a ref also blocks it inside a Jev program", async () => {
    const { run, ran, inputs } = fixture(true);
    const info = await run();
    expect(info.state).toBe("failed");
    expect(info.error).toContain("demo.act is denied by the Fabric action policy hook engine: writes are frozen");
    expect(ran()).toBe(0);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.args).toEqual({ path: "notes.md" });
    expect(inputs[0]?.context).toEqual({ caller: "jev", parentToolCallId: "jev-test" });
  });

  it("ignores the hooks inside a Jev program when approvals.policyHooks is absent", async () => {
    const { run, ran, inputs } = fixture(false);
    const info = await run();
    expect(info.state).toBe("completed");
    expect(ran()).toBe(1);
    expect(inputs).toHaveLength(0);
  });
});
