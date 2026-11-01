import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricActionDescriptor,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "../src/protocol.js";

const taskAdd: FabricActionDescriptor = {
  name: "task_add", description: "Add a task", risk: "read",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
};
const taskList: FabricActionDescriptor = {
  name: "task_list", description: "List tasks", risk: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const stub = (name: string) => {
  const invoke = vi.fn(async (action: string, args: Record<string, unknown>) => ({ provider: name, action, args }));
  const provider: FabricProvider = {
    name,
    description: `${name} stub`,
    async list() { return [taskAdd, taskList]; },
    async describe(action) { return [taskAdd, taskList].find((descriptor) => descriptor.name === action); },
    invoke,
  };
  return { provider, invoke };
};

describe("provider globals for a provider another extension registers", () => {
  it("adds a typed global, warns on a clash, reaches Jev programs and goes away on withdrawal", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-provider-globals-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
    vi.stubEnv("PI_FABRIC_DEBUG", "1");
    const context = stub("context");
    const discoveredClash = stub("rlm");
    const pi = {
      events: {
        emit: vi.fn((event: string, payload: unknown) => {
          // The stub extension answers discovery the way a real one does.
          if (event !== FABRIC_PROVIDER_DISCOVER_EVENT) return;
          (payload as FabricProviderDiscovery).register(context.provider);
          (payload as FabricProviderDiscovery).register(discoveredClash.provider);
        }),
      },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const extensionContext = {
      cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: { getSessionId: () => "provider-globals", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => undefined },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      fullCodeMode: true, mcp: { enabled: false, cache: { enabled: false } }, mesh: { enabled: false },
      agents: { enabled: false }, memory: { enabled: false }, residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
    });
    let sequence = 0;
    const run = (code: string) => runtime.execution.execute({
      code, context: extensionContext, signal: undefined, parentToolCallId: `provider-global-${++sequence}`, onPartial() {},
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runtime.initialize(extensionContext, config);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        expect.stringContaining('Fabric provider "rlm" gets no program global: the name clashes with the Fabric program global "rlm"'),
      ]);
      warn.mockClear();

      const typed = await run('return await context.task_add({ title: "from a global" });');
      expect(typed.success, typed.error ?? JSON.stringify(typed.typeErrors)).toBe(true);
      expect(typed.value).toEqual({ provider: "context", action: "task_add", args: { title: "from a global" } });

      const wrong = await run('return await context.task_add({ titel: "typo" });');
      expect(wrong.typeErrors?.map((error) => error.message).join("\n")).toMatch(/'titel' does not exist/);
      expect(context.invoke).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();

      const clashing = stub("workflow");
      runtime.registerExternal(clashing.provider);
      runtime.registerExternal(clashing.provider, { overwrite: true });
      const warnings = warn.mock.calls.map(([message]) => String(message));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Fabric provider "workflow" gets no program global');
      expect(warnings[0]).toContain('the Fabric program global "workflow"');
      // Without PI_FABRIC_DEBUG a clashing provider registers silently.
      vi.stubEnv("PI_FABRIC_DEBUG", "");
      warn.mockClear();
      runtime.registerExternal(stub("pipeline").provider);
      expect(warn).not.toHaveBeenCalled();
      const clash = await run(`
        const viaTools = await tools.call({ ref: "workflow.task_list", args: {} });
        return { viaTools, builtIn: typeof workflow.phase };`);
      expect(clash.success, clash.error ?? JSON.stringify(clash.typeErrors)).toBe(true);
      expect(clash.value).toEqual({ viaTools: { provider: "workflow", action: "task_list", args: {} }, builtIn: "function" });

      const invocation = {
        cwd, signal: undefined, parentToolCallId: "jev-provider-global", nestedToolCallId: "jev-provider-global",
        extensionContext, update() {}, approve: async () => {}, audits: [], maxResultChars: 32_768,
      };
      const jev = await runtime.registry.invoke("jev.run", {
        input: null,
        program: {
          name: "context-reader", requires: ["context.task_list"], inputSchema: {}, outputSchema: {},
          limits: { maxEvaluations: 0 }, code: "return await context.task_list({});",
        },
      }, invocation);
      expect(jev).toMatchObject({ state: "completed", result: { provider: "context", action: "task_list", args: {} } });

      expect(runtime.withdrawExternal("context")).toBe(true);
      const withdrawn = await run("return await context.task_list({});");
      expect(withdrawn.success).toBe(false);
      expect(withdrawn.typeErrors?.map((error) => error.message)).toEqual(["Cannot find name 'context'."]);
      expect(context.invoke).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
