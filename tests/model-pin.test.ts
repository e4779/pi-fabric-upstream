import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import {
  MODEL_PIN_ENV, MODEL_PIN_EXIT_CODE, MODEL_PIN_MARKER, modelPinFailure, parseModelPinViolation,
} from "../src/agents/model-pin.js";
import fabricModelPinGuard from "../src/agents/model-pin-guard.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

const CONVERSATION_EVENTS = ["context", "context_with_system", "before_provider_request"] as const;
const pinned = { provider: "lab", id: "pinned" };
const other = { provider: "lab", id: "other" };

describe("model pin guard (child-side extension)", () => {
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  let writes: string[];
  const install = (): void => {
    handlers.clear();
    fabricModelPinGuard({ on: (event: string, handler: (event: unknown, context: unknown) => void) => handlers.set(event, handler) } as unknown as ExtensionAPI);
  };
  const violation = () => parseModelPinViolation(writes.join(""));
  beforeEach(() => {
    writes = [];
    vi.stubEnv(MODEL_PIN_ENV, "lab/pinned");
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    vi.spyOn(fs, "writeSync").mockImplementation(((_fd: number, text: string) => { writes.push(String(text)); return 0; }) as never);
    install();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("guards every point where the model can change or a request can go out", () => {
    expect([...handlers.keys()].sort()).toEqual(["model_select", ...CONVERSATION_EVENTS].sort());
  });

  it.each(CONVERSATION_EVENTS)("lets the pinned model through at %s", (event) => {
    expect(() => handlers.get(event)!({}, { model: pinned })).not.toThrow();
    expect(process.exit).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it.each(CONVERSATION_EVENTS)("ends the child before the call when another model is current at %s", (event) => {
    expect(() => handlers.get(event)!({}, { model: other })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
    expect(violation()).toEqual({ pinned: "lab/pinned", actual: "lab/other" });
  });

  describe("model_select", () => {
    it("lets a switch to the pin through, as Fabric's own set_model does after a startup switch", () => {
      expect(() => handlers.get("model_select")!({ model: pinned, previousModel: other, source: "set" }, {})).not.toThrow();
      expect(process.exit).not.toHaveBeenCalled();
    });

    it.each(["set", "cycle", "restore"])("ends the child on a switch to another model, source %s", (source) => {
      expect(() => handlers.get("model_select")!({ model: other, previousModel: pinned, source }, { model: pinned })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(violation()).toEqual({ pinned: "lab/pinned", actual: "lab/other" });
    });

    it("judges the model the event names, not the stale one the context still shows", () => {
      expect(() => handlers.get("model_select")!({ model: other }, { model: pinned })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(() => handlers.get("model_select")!({ model: pinned }, { model: other })).not.toThrow();
    });

    it("fails closed on an event without a usable model", () => {
      expect(() => handlers.get("model_select")!({}, {})).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(violation()).toEqual({ pinned: "lab/pinned", actual: "none" });
    });
  });

  it("compares provider and id case-sensitively, because the pin is the registry's own spelling", () => {
    expect(() => handlers.get("context")!({}, { model: { provider: "lab", id: "Pinned" } })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
  });

  it.each([
    ["no model", { model: undefined }],
    ["a model without an id", { model: { provider: "lab" } }],
    ["a stale context whose model getter throws", { get model(): never { throw new Error("stale"); } }],
  ])("fails closed on %s", (_label, context) => {
    expect(() => handlers.get("context")!({}, context)).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
    expect(violation()).toEqual({ pinned: "lab/pinned", actual: "none" });
  });

  it("fails closed when the pin is missing from the environment", () => {
    vi.stubEnv(MODEL_PIN_ENV, "");
    install();
    expect(() => handlers.get("context")!({}, { model: pinned })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
    expect(() => handlers.get("model_select")!({ model: pinned }, {})).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
  });

  describe("outgoing payload", () => {
    const request = (api: string, payload: unknown) =>
      handlers.get("before_provider_request")!({ payload }, { model: { ...pinned, api } });

    it.each([
      ["openai-completions", "model"],
      ["openai-responses", "model"],
      ["openai-codex-responses", "model"],
      ["anthropic-messages", "model"],
      ["mistral-conversations", "model"],
      ["google-generative-ai", "model"],
      ["google-vertex", "model"],
      ["pi-messages", "model"],
      ["bedrock-converse-stream", "modelId"],
    ])("compares the %s payload's %s field with the pinned id", (api, field) => {
      expect(() => request(api, { [field]: "pinned", messages: [] })).not.toThrow();
      expect(writes).toEqual([]);
      expect(() => request(api, { [field]: "other", messages: [] })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(violation()).toEqual({ pinned: "lab/pinned", actual: 'payload model "other"' });
    });

    it("bounds the payload model it quotes in the failure", () => {
      expect(() => request("openai-completions", { model: "x".repeat(5000) })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(violation()!.actual.length).toBeLessThan(200);
    });

    it.each([
      ["an API whose payload names a deployment, not the id", "azure-openai-responses", { model: "my-deployment" }],
      ["a virtual model that routes to a physical one", "pi-virtual", { model: "physical" }],
      ["an API an extension registered", "my-extension-api", { model: "other" }],
      ["a known API whose payload has no model field", "openai-completions", { messages: [] }],
      ["a known API whose model field is not a string", "openai-completions", { model: { name: "other" } }],
      ["a payload that is not an object", "openai-completions", "raw body"],
      ["a bedrock payload with the other API's field name", "bedrock-converse-stream", { model: "other" }],
      ["a prototype key as the API name", "constructor", { model: "other" }],
    ])("does not compare %s", (_label, api, payload) => {
      expect(() => request(api, payload)).not.toThrow();
      expect(process.exit).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

    it("still ends the child for another current model whatever the payload says", () => {
      expect(() => handlers.get("before_provider_request")!({ payload: { model: "other" } }, { model: { ...other, api: "my-extension-api" } })).toThrow(`exit:${MODEL_PIN_EXIT_CODE}`);
      expect(violation()).toEqual({ pinned: "lab/pinned", actual: "lab/other" });
    });

    it("never replaces the payload", () => {
      expect(request("openai-completions", { model: "pinned" })).toBeUndefined();
    });
  });
});

describe("model pin marker", () => {
  it("round-trips through a noisy stderr and builds the fixed run error", () => {
    const violation = { pinned: "a/b", actual: "c/d" };
    const stderr = `warn\n${MODEL_PIN_MARKER}${JSON.stringify(violation)}\ntrailing`;
    expect(parseModelPinViolation(stderr)).toEqual(violation);
    expect(modelPinFailure(violation)).toBe(
      "Fabric exact model pin violated: only a/b may run, but c/d was about to run. The provider call was stopped before any request was sent.",
    );
  });

  it.each(["", "nothing here", `${MODEL_PIN_MARKER}not json`, `${MODEL_PIN_MARKER}{"pinned":1}`])("ignores %j", (stderr) => {
    expect(parseModelPinViolation(stderr)).toBeUndefined();
  });
});

describe("worker option --model-match", () => {
  const base = ["node", "worker", "--id", "a", "--name", "n", "--runner", "pi", "--task-file", "t", "--status-file", "s", "--lifecycle-file", "l", "--log-file", "f", "--cwd", "/", "--pi-binary", "pi", "--claude-binary", "c", "--veda-binary", "v", "--veda-backend", "b", "--veda-persona", "p", "--timeout-ms", "1", "--depth", "1", "--full-code-mode", "false", "--extensions", "true", "--tools", "[]", "--granted-risks", "[]", "--transport", "process"];
  it("accepts only exact", () => {
    expect(parseWorkerOptions([...base, "--model-match", "exact"]).modelMatch).toBe("exact");
    expect(parseWorkerOptions(base).modelMatch).toBeUndefined();
    expect(() => parseWorkerOptions([...base, "--model-match", "fuzzy"])).toThrow(/model-match/);
  });
});

// Real Pi child, offline provider. The fixture extension logs every entry into the provider's
// stream function, so the log counts the model calls each model received.
const workerPath = path.resolve("dist/worker.js");
const piCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

describe.skipIf(!fs.existsSync(workerPath) || !fs.existsSync(path.resolve("dist/agents/model-pin-guard.js")))("exact model pin against a real Pi child", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmTempSync(root);
  });

  interface LaunchOptions {
    /** "before" loads the extension ahead of the guard (-e), "after" through settings, behind it. */
    order?: "before" | "after";
    settings?: Record<string, unknown>;
    /** Seed the run's session with a long history, so compaction has something to summarize. */
    seeded?: boolean;
  }

  const launch = async (
    runner: "pi" | "pi-durable",
    extension: string,
    env: Record<string, string>,
    model: string,
    exact: boolean,
    options: LaunchOptions = {},
  ) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-model-pin-"));
    roots.push(directory);
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(agentDir);
    const before = options.order === "before";
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: before ? [] : [path.resolve(extension)], enableInstallTelemetry: false, ...options.settings,
    }));
    let sessionFile: string | undefined;
    if (options.seeded) {
      const seed = SessionManager.create(directory, path.join(directory, "seed"));
      for (let index = 0; index < 4; index++) {
        const filler = "words ".repeat(200);
        seed.appendMessage({ role: "user", content: `Seed ${index} ${filler}`, timestamp: Date.now() });
        seed.appendMessage({
          role: "assistant", api: "switch-probe-api", provider: "switch-probe", model: "requested",
          content: [{ type: "text", text: `Reply ${index} ${filler}` }], stopReason: "stop", timestamp: Date.now(),
          usage: { input: 200, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 400, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
      }
      sessionFile = seed.getSessionFile();
    }
    const callLog = path.join(directory, "calls.jsonl");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("MODEL_SWITCH_CALL_LOG", callLog);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // Permissive on purpose: the pin must hold without relying on admission.
    const manager = new AgentManager(directory, { ...DEFAULT_FABRIC_CONFIG.agents, runner, timeoutMs: 60_000, modelAdmission: "permissive", budgetUsd: 0 }, {
      workerPath, piBinary: piCli, fullCodeMode: before,
      fabricExtensionPath: before ? path.resolve(extension) : path.resolve("dist/index.js"),
      runRoot: path.join(directory, "runs"), preparePiModel: async (selected) => selected,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "pinned request", model, ...(exact ? { modelMatch: "exact" as const } : {}), thinking: "high",
      extensions: true, tools: ["switch_probe_noop"], transport: "process",
      ...(sessionFile ? { sessionFile } : {}),
    });
    const entries = fs.existsSync(callLog)
      ? fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { provider?: string; id?: string; switched?: string; loaded?: number })
      : [];
    const calls: Record<string, number> = {};
    for (const entry of entries) if (entry.id) calls[`${entry.provider}/${entry.id}`] = (calls[`${entry.provider}/${entry.id}`] ?? 0) + 1;
    return {
      result, calls, switched: entries.some((entry) => entry.switched),
      launches: new Set(entries.filter((entry) => entry.loaded !== undefined).map((entry) => entry.loaded)).size,
    };
  };

  const fixture = "tests/fixtures/model-switch-extension.ts";
  const pinnedModel = "switch-probe/requested";
  const pinFailure = (actual: string) => modelPinFailure({ pinned: pinnedModel, actual });

  describe.each(["pi", "pi-durable"] as const)("%s", (runner) => {
    it.each(["before-start", "between-turns", "context", "session-start"])("sends no request to another model when an extension switches it: %s", async (phase) => {
      const { result, calls, switched } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: phase }, pinnedModel, true);
      expect(switched).toBe(true);
      expect(calls["switch-probe/other"]).toBeUndefined();
      expect(result.status).toBe("failed");
      expect(result.error).toBe(pinFailure("switch-probe/other"));
    }, 120_000);

    it("lets a default request reach the other model, so the switch above is real", async () => {
      const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "before-start" }, pinnedModel, false);
      expect(result.status).toBe("completed");
      expect(calls["switch-probe/other"]).toBe(1);
    }, 120_000);

    it("completes an exact run on the pinned model when nothing switches it", async () => {
      const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "none" }, pinnedModel, true);
      expect(result).toMatchObject({ status: "completed", model: pinnedModel });
      expect(calls).toEqual({ [pinnedModel]: 1 });
    }, 120_000);

    it("is not tripped by Pi's own launch order: --model, then Fabric's set_model, with another settings default model", async () => {
      const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "none" }, pinnedModel, true, {
        settings: { defaultProvider: "switch-probe", defaultModel: "other" },
      });
      expect(result).toMatchObject({ status: "completed", model: pinnedModel });
      expect(calls).toEqual({ [pinnedModel]: 1 });
    }, 120_000);

    // An extension that moves the model at session_start and relies on Fabric to move it back.
    // Until the pin guard handled model_select that completed; the guard now cannot tell it from
    // a switch that is followed by a summary on the other model, so the run fails closed.
    it("fails closed on an extension that switches at session_start and lets Fabric switch back", async () => {
      const { result } = await launch(runner, "tests/fixtures/model-hijack-extension.ts", {}, "model-probe/requested", true);
      expect(result.status).toBe("failed");
      expect(result.error).toBe(modelPinFailure({ pinned: "model-probe/requested", actual: "model-probe/mru" }));
    }, 120_000);

    it("still lets a default request complete after that startup switch", async () => {
      const { result } = await launch(runner, "tests/fixtures/model-hijack-extension.ts", {}, "model-probe/requested", false);
      expect(result).toMatchObject({ status: "completed", model: "model-probe/requested" });
    }, 120_000);

    describe("switch, compaction, switch back", () => {
      const compaction = { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 256 } };
      it("a default request lets the compaction summary reach the other model", async () => {
        const { calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "manual-compact" }, pinnedModel, false, { seeded: true, settings: compaction });
        expect(calls["switch-probe/other"]).toBeGreaterThanOrEqual(1);
      }, 120_000);

      it("an exact run ends at the switch, before any compaction or request reaches the other model", async () => {
        const { result, calls, switched } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "manual-compact" }, pinnedModel, true, { seeded: true, settings: compaction });
        expect(switched).toBe(true);
        expect(calls["switch-probe/other"]).toBeUndefined();
        expect(result.status).toBe("failed");
        expect(result.error).toBe(pinFailure("switch-probe/other"));
      }, 120_000);
    });

    describe("payload rewrite by a request handler (known API: openai-completions)", () => {
      const env = { MODEL_SWITCH_PHASE: "rewrite", MODEL_SWITCH_API: "openai-completions" };
      it("a handler loaded before the guard cannot send a request to another model", async () => {
        const { result, calls } = await launch(runner, fixture, env, pinnedModel, true, { order: "before" });
        expect(calls["switch-probe/other"]).toBeUndefined();
        expect(result.status).toBe("failed");
        expect(result.error).toBe(pinFailure('payload model "other"'));
      }, 120_000);

      it("documented limit: a handler that runs after the guard still sends it, and the run fails afterwards", async () => {
        const { result, calls } = await launch(runner, fixture, env, pinnedModel, true, { order: "after" });
        expect(calls["switch-probe/other"]).toBe(1);
        expect(result.status).toBe("failed");
        expect(result.error).toMatch(/assistant reports switch-probe\/other/);
      }, 120_000);

      it("documented limit: a payload of an API the guard knows no shape for is not compared", async () => {
        const { result, calls } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "rewrite" }, pinnedModel, true, { order: "before" });
        expect(calls["switch-probe/other"]).toBe(1);
        expect(result.status).toBe("failed");
        expect(result.error).toMatch(/assistant reports switch-probe\/other/);
      }, 120_000);
    });

    it("launches an exact run once when the model id spells a credential error", async () => {
      const { result, calls, launches } = await launch(runner, fixture, { MODEL_SWITCH_PHASE: "before-start", MODEL_SWITCH_TARGET: "missing credentials" }, pinnedModel, true);
      expect(result.status).toBe("failed");
      expect(result.error).toBe(pinFailure("switch-probe/missing credentials"));
      expect(calls).toEqual({});
      expect(launches).toBe(1);
    }, 120_000);
  });
});
