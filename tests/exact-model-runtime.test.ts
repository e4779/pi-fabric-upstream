import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

it("resolves a launch-boundary model exactly when the request says so, even if an alias has the model's name", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-exact-model-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const models = [
    { provider: "dest", id: "worker", name: "Worker" },
    { provider: "dest", id: "other", name: "Other" },
  ];
  const pi = { events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const context = {
    cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    model: models[1],
    modelRegistry: { getAvailable: () => models, find: () => models[0], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
    sessionManager: { getSessionId: () => "exact-model", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { paths: {
    extension: path.resolve("dist/index.js"), worker: path.resolve("tests/fixtures/fake-worker.mjs"), residentHost: path.join(cwd, "unused.mjs"), skills: cwd,
  } });
  try {
    await runtime.initialize(context, normalizeFabricConfig({
      fullCodeMode: false,
      models: { aliases: { "dest/worker": "dest/other" } },
      agents: { enabled: true, budgetUsd: 0 },
      mcp: { enabled: false }, memory: { enabled: false }, residency: { enabled: false }, mesh: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    }));
    const aliased = await runtime.agents.spawn({ task: "HANG", model: "dest/worker", transport: "process" });
    expect(aliased.model).toBe("dest/other");
    const exact = await runtime.agents.spawn({ task: "HANG", model: "dest/worker", modelMatch: "exact", transport: "process" });
    expect(exact.model).toBe("dest/worker");
    await expect(runtime.agents.spawn({ task: "HANG", model: "dest/wroker", modelMatch: "exact", transport: "process" }))
      .rejects.toThrow(/not available to this Pi session/);
    await runtime.agents.stop(aliased.id);
    await runtime.agents.stop(exact.id);
  } finally {
    await runtime.shutdown();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Entries that differ only by case are distinct registry models with distinct credentials.
it.each([
  { selector: "lab/model-x", authenticated: "model-x" },
  { selector: "lab/Model-X", authenticated: "Model-X" },
])("authenticates the registry entry an exact request names, with a case twin listed first: $selector", async ({ selector, authenticated }) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-exact-twins-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const models = [
    { provider: "lab", id: "Model-X", name: "Upper" },
    { provider: "lab", id: "model-x", name: "Lower" },
  ];
  const authenticate = vi.fn(async (_model: unknown) => ({ ok: true, apiKey: "test" }));
  const pi = { events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage: vi.fn() } as unknown as ExtensionAPI;
  const context = {
    cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    model: models[0],
    modelRegistry: { getAvailable: () => models, find: () => models[0], getApiKeyAndHeaders: authenticate },
    sessionManager: { getSessionId: () => "exact-twins", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), { paths: {
    extension: path.resolve("dist/index.js"), worker: path.resolve("tests/fixtures/fake-worker.mjs"), residentHost: path.join(cwd, "unused.mjs"), skills: cwd,
  } });
  try {
    await runtime.initialize(context, normalizeFabricConfig({
      fullCodeMode: false,
      agents: { enabled: true, budgetUsd: 0 },
      mcp: { enabled: false }, memory: { enabled: false }, residency: { enabled: false }, mesh: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
    }));
    authenticate.mockClear();
    const handle = await runtime.agents.spawn({ task: "HANG", model: selector, modelMatch: "exact", transport: "process" });
    expect(handle.model).toBe(selector);
    expect(authenticate).toHaveBeenCalled();
    for (const [model] of authenticate.mock.calls) expect(model).toMatchObject({ provider: "lab", id: authenticated });
    await runtime.agents.stop(handle.id);
  } finally {
    await runtime.shutdown();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
