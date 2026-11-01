import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fabric from "../src/index.js";
import { managedHostExecutionGuidance, managedHostKernelGuidance } from "../src/core/managed-host-guidance.js";
import { FABRIC_PROVIDER_REGISTER_EVENT } from "../src/protocol.js";

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
  vi.stubEnv("PI_FABRIC_FULL_CODE_MODE", undefined);
});
afterEach(() => vi.unstubAllEnvs());

// Exercise Pi's real skill/tool-guideline rendering, Fabric's before_agent_start
// hook, and the model-facing declarations together. Counting only the hook's
// returned systemPrompt misses copies introduced by promptGuidelines/schema.
it("emits managed execution and host guidance once in each complete model request", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-managed-request-"));
  const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } });
  const options = { providers: ["mcp"], guidance: "Reconcile uncertain receipts before continuing the requested scope.", compaction: "pi" as const };
  const requests: Array<{ serialized: string; system: string }> = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [async pi => {
      await fabric(pi, { managedHost: options });
      pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, { version: 1, provider: {
        name: "mcp", description: "Host broker", async list() { return []; }, async describe() { return undefined; }, async invoke() { throw new Error("No probe calls expected"); },
      } });
      pi.registerProvider("managed-request", {
        api: "managed-request", apiKey: "offline", baseUrl: "http://invalid.local",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
        streamSimple(model, context) {
          const tools = getCurrentTools(context.messages);
          expect(tools.map(tool => tool.name)).toEqual(["fabric_exec"]);
          requests.push({ serialized: JSON.stringify(context), system: JSON.stringify(context.messages.filter(message => message.role === "system")) });
          const message: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "Done." }], api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
        },
      });
    }],
  });
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
    try {
      await session.bindExtensions({});
      await session.setModel(modelRuntime.getModel("managed-request", "fixture")!);
      await session.prompt("First bounded request.");
      await session.prompt("Second bounded request.");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        for (const guidance of [managedHostExecutionGuidance(options), managedHostKernelGuidance(options), options.guidance]) {
          // Compare JSON-escaped text, matching the serialization above.
          const encoded = JSON.stringify(guidance).slice(1, -1);
          expect(request.serialized.split(encoded).length - 1, guidance).toBe(1);
        }
        expect(request.serialized.length).toBeLessThan(15000);
      }
      expect(requests[1]!.system).toBe(requests[0]!.system);
    } finally { session.dispose(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);
