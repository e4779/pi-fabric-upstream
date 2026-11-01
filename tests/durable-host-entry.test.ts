import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import * as host from "../src/durable-host.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("pi-fabric/durable-host public entry", () => {
  it("exports exactly the embedding surface", () => {
    expect(Object.keys(host).sort()).toEqual([
      "DURABLE_WORKER_POLICY_ENTRY_TYPE", "DurableAgent", "createDurableAgentSession",
      "createDurableWorkerRuntime", "declareWorkerSessionRole", "openDurableWorkerStorage",
    ]);
  });

  it("resolves pi-fabric/durable-host by package name from the built dist", () => {
    // A separate Node process: resolution goes through package.json "exports", not the vitest alias graph.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const m = await import("pi-fabric/durable-host"); process.stdout.write(JSON.stringify(Object.keys(m).sort()));'],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      "DURABLE_WORKER_POLICY_ENTRY_TYPE", "DurableAgent", "createDurableAgentSession",
      "createDurableWorkerRuntime", "declareWorkerSessionRole", "openDurableWorkerStorage",
    ]);
  });

  it("runs a durable session through the end of its first turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fabric-durable-host-"));
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "offline", models: [{ id: "test" }], tokensPerSecond: 100000 });
    modelRuntime.registerNativeProvider({ ...faux.provider, auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "k" } }) } } });
    await modelRuntime.setRuntimeApiKey("offline", "k");
    await modelRuntime.getAvailable();
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Embedded host test", getSystemPromptSource: () => undefined as never,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    const sessionManager = SessionManager.inMemory(cwd);
    expect(host.declareWorkerSessionRole(sessionManager)).toBe("seeded");
    const created = await host.createDurableAgentSession({
      cwd, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      storage: new MemoryStorage(), runId: "embedded-host", tools: [],
    });
    cleanup.push(() => created.close());
    expect(created.agent).toBeInstanceOf(host.DurableAgent);
    await created.session.bindExtensions({});
    faux.setResponses([fauxAssistantMessage("first turn done")]);
    await created.session.prompt("hello");
    expect(created.session.getLastAssistantText()).toBe("first turn done");
  });
});
