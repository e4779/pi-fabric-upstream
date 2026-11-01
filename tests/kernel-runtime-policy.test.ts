import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricActionPolicyHooks } from "../src/core/action-policy-hooks.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { LiteralCallScanner } from "../src/speculation/scanner.js";

const fixture = async (python: boolean, policyHooks = false, hooks = new FabricActionPolicyHooks()) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-kernel-policy-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const pi = { events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const context = {
    cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: { getSessionId: () => "kernel-policy", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => undefined },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    executor: { kernel: python ? "python" : "typescript" },
    approvals: { network: "allow", ...(policyHooks ? { policyHooks: true } : {}) },
    speculation: { enabled: true, mcpAllowlist: ["demo.read"] }, mcp: { enabled: false, cache: { enabled: false } },
    agents: { enabled: false }, residency: { enabled: false }, prewalk: { enabled: false, alwaysRearm: false },
  });
  const unused = path.join(cwd, "unused.mjs");
  fs.writeFileSync(unused, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { actionPolicyHooks: hooks, paths: { extension: unused, worker: unused, residentHost: unused, skills: cwd } });
  await runtime.initialize(context, config);
  const reload = (update: (next: typeof config) => void) => {
    const next = structuredClone(config);
    update(next);
    runtime.reloadConfig(context, next);
  };
  const close = async () => { await runtime.shutdown(); vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }); };
  return { runtime, reload, close, context };
};

const streamEvent = (type: "toolcall_start" | "toolcall_delta", delta = "", toolCallId = "policy-call"): MessageUpdateEvent => ({
  assistantMessageEvent: { type, contentIndex: 0, delta,
    partial: { content: [{ type: "toolCall", name: "fabric_exec", id: toolCallId }] },
  },
} as MessageUpdateEvent);

const mcpCode = 'return await mcp.demo.read({});';
const installMcp = async (runtime: FabricRuntimeState) => {
  const invoke = vi.fn(async () => ({ value: "read result" }));
  const action = {
    name: "demo.read", description: "Read-only MCP fixture", inputSchema: { type: "object" },
    risk: "network" as const, annotations: { readOnlyHint: true },
  };
  runtime.registry.register({
    name: "mcp", description: "MCP fixture",
    async list() { return [action]; },
    async describe(name) { return name === action.name ? action : undefined; },
    invoke,
  }, { overwrite: true });
  // Let retiring the built-in MCP binding finish invalidating the cache.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return invoke;
};
const streamMcp = async (runtime: FabricRuntimeState, context: ExtensionContext, toolCallId = "policy-call") => {
  const tap = runtime.speculationTap;
  tap?.setScannerFactory(() => new LiteralCallScanner());
  tap?.handleMessageUpdate(streamEvent("toolcall_start", "", toolCallId), context);
  tap?.handleMessageUpdate(streamEvent("toolcall_delta", JSON.stringify({ code: mcpCode }), toolCallId), context);
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const executeMcp = (runtime: FabricRuntimeState, context: ExtensionContext) => runtime.execution.execute({
  code: mcpCode, signal: new AbortController().signal, parentToolCallId: "policy-call", context, onPartial() {},
});

describe("real runtime action policy speculation wiring", () => {
  it.each(["before configure", "after configure"])("never pre-launches with hooks enabled and a deny registered %s", async (registration) => {
    const hooks = new FabricActionPolicyHooks();
    const deny = vi.fn(() => ({ decision: "deny" as const, reason: "reads are frozen" }));
    if (registration === "before configure") hooks.register("deny-reads", input => input.action.ref === "mcp.demo.read" ? deny() : undefined);
    const { runtime, context, close } = await fixture(false, true, hooks);
    try {
      const invoke = await installMcp(runtime);
      const speculate = vi.spyOn(runtime.registry, "speculate");
      expect(runtime.speculationTap).toBeUndefined();
      // Even an empty hook registry must disable warming: hooks can arrive later.
      await streamMcp(runtime, context);
      if (registration === "after configure") hooks.register("deny-reads", input => input.action.ref === "mcp.demo.read" ? deny() : undefined);
      await streamMcp(runtime, context);
      expect(speculate).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(deny).not.toHaveBeenCalled();
      const result = await executeMcp(runtime, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain("mcp.demo.read is denied by the Fabric action policy hook deny-reads: reads are frozen");
      expect(deny).toHaveBeenCalledOnce();
      expect(invoke).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it("preserves default hook-disabled warming and replay even with a registered deny", async () => {
    const hooks = new FabricActionPolicyHooks();
    const deny = vi.fn(() => ({ decision: "deny" as const, reason: "reads are frozen" }));
    hooks.register("deny-reads", input => input.action.ref === "mcp.demo.read" ? deny() : undefined);
    const { runtime, context, close } = await fixture(false, false, hooks);
    try {
      const invoke = await installMcp(runtime);
      expect(runtime.config.approvals.policyHooks).toBeUndefined();
      await streamMcp(runtime, context);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      expect(deny).not.toHaveBeenCalled();
      const result = await executeMcp(runtime, context);
      expect(result.success).toBe(true);
      expect(result.audits).toContainEqual(expect.objectContaining({ ref: "mcp.demo.read", speculated: true }));
      expect(invoke).toHaveBeenCalledOnce();
      expect(deny).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it("disables and resets warming on hook enable reload, then resumes with an empty cache", async () => {
    const hooks = new FabricActionPolicyHooks();
    const deny = vi.fn(() => ({ decision: "deny" as const, reason: "reads are frozen" }));
    hooks.register("deny-reads", input => input.action.ref === "mcp.demo.read" ? deny() : undefined);
    const { runtime, context, reload, close } = await fixture(false, false, hooks);
    try {
      const invoke = await installMcp(runtime);
      const oldTap = runtime.speculationTap!;
      const reset = vi.spyOn(oldTap, "reset");
      await streamMcp(runtime, context);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
      reload(config => { config.approvals.policyHooks = true; });
      expect(reset).toHaveBeenCalled();
      expect(runtime.speculationTap).toBeUndefined();
      // A retained tap must also obey the current config, not only new lookups.
      oldTap.handleMessageUpdate(streamEvent("toolcall_start"), context);
      oldTap.handleMessageUpdate(streamEvent("toolcall_delta", JSON.stringify({ code: mcpCode })), context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(invoke).toHaveBeenCalledOnce();
      expect(deny).not.toHaveBeenCalled();
      expect((await executeMcp(runtime, context)).success).toBe(false);
      expect(deny).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledOnce();
      reload(config => { delete config.approvals.policyHooks; });
      expect(runtime.speculationTap).toBeDefined();
      expect(runtime.speculationTap).not.toBe(oldTap);
      // Execute without streaming: the previous warm result must have been dropped.
      const result = await executeMcp(runtime, context);
      expect(result.success).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(deny).toHaveBeenCalledOnce();
      await streamMcp(runtime, context, "next-policy-call");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    } finally { await close(); }
  });
});

describe("real runtime kernel policy wiring", () => {
  it.each(["allow", "read-deny", "read-ask", "core-hidden", "network-ask", "network-deny", "enforce-mcp"])("checks speculative policy before lookup: %s", async (policy) => {
    const { runtime, reload, close, context } = await fixture(false);
    try {
      reload((config) => {
        config.fullCodeMode = policy !== "core-hidden";
        config.approvals.read = policy === "read-deny" ? "deny" : policy === "read-ask" ? "ask" : "allow";
        config.approvals.network = policy === "network-ask" ? "ask" : policy === "network-deny" ? "deny" : "allow";
        config.speculation.mcpAllowlist = ["demo.read"];
      });
      if (policy === "enforce-mcp") runtime.setSchemaMode("enforce", "quickjs");
      const tap = runtime.speculationTap!;
      expect(tap).toBeDefined();
      tap.setScannerFactory(() => new LiteralCallScanner());
      const speculate = vi.spyOn(runtime.registry, "speculate");
      const code = policy.includes("network") || policy === "enforce-mcp"
        ? 'return await mcp.demo.read({});' : 'return await pi.read({path:"unused.mjs"});';
      tap.handleMessageUpdate(streamEvent("toolcall_start"), context);
      tap.handleMessageUpdate(streamEvent("toolcall_delta", JSON.stringify({ code })), context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (policy === "allow") expect(speculate).toHaveBeenCalledOnce();
      else expect(speculate).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it.each([false, true])("recreates speculation only for isolated backends (starts Python=%s)", async (python) => {
    const { runtime, reload, close } = await fixture(python);
    try {
      expect(runtime.speculationTap).toBeDefined();
      reload((config) => { config.executor.kernel = "typescript"; });
      const first = runtime.speculationTap!;
      expect(first).toBeDefined();
      const reset = vi.spyOn(first, "reset");
      reload((config) => { config.fullCodeMode = !config.fullCodeMode; });
      expect(reset).toHaveBeenCalled();
      expect(runtime.speculationTap).not.toBe(first);
      reload((config) => { config.executor.runtime = "node-process"; });
      expect(runtime.speculationTap).toBeUndefined();
      runtime.setSchemaMode("enforce", "quickjs");
      expect(runtime.speculationTap).toBeDefined();
      runtime.setSchemaMode("off", "node-process");
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.executor.kernel = "python"; config.executor.pythonRuntime = "cpython"; });
      expect(runtime.speculationTap).toBeUndefined();
      runtime.setSchemaMode("enforce", "quickjs");
      expect(runtime.speculationTap).toBeDefined();
      runtime.setSchemaMode("off", "quickjs");
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.executor.kernel = "python"; config.executor.pythonRuntime = "monty"; });
      expect(runtime.speculationTap).toBeDefined();
      reload((config) => { config.executor.kernel = "typescript"; config.executor.runtime = "quickjs"; config.speculation.enabled = false; });
      expect(runtime.speculationTap).toBeUndefined();
      reload((config) => { config.speculation.enabled = true; config.speculation.maxEntries = 1; });
      expect(runtime.speculationTap).toBeDefined();
    } finally { await close(); }
  });
});
