import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

// The runtime decides which sessions tell Herdr about their agents: an
// interactive root inside a Herdr pane does, unless ui.herdrStatus is off; a
// child launched by Fabric and a headless session do not.

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const startHerdr = async (root: string) => {
  const socketPath = path.join(root, "herdr.sock");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
      requests.push({ method: request.method, params: request.params });
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, requests };
};

const startRuntime = async (
  options: { mode?: ExtensionContext["mode"]; herdrStatus?: boolean } = {},
) => {
  // Short on purpose: a unix socket path is capped at 104 bytes on macOS, and
  // the suite already runs under an isolated per-run TMPDIR.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "phs-"));
  roots.push(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const herdr = await startHerdr(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  vi.stubEnv("HERDR_SOCKET_PATH", herdr.socketPath);
  const target = { provider: "test", id: "worker", name: "Worker", contextWindow: 48_000 };
  const events: Array<[string, unknown]> = [];
  const pi = {
    events: { emit: (event: string, data: unknown) => void events.push([event, data]), on: vi.fn() },
    getThinkingLevel: vi.fn(() => "off"),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    mode: options.mode ?? "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: target,
    modelRegistry: {
      getAvailable: () => [target],
      find: () => target,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    },
    sessionManager: {
      getSessionId: () => "herdr-status-runtime",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    fullCodeMode: false,
    capture: { enabled: false },
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: false },
    memory: { enabled: false },
    agents: { enabled: true, budgetUsd: 0 },
    residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    approvals: { read: "allow", write: "allow" },
    ...(options.herdrStatus === undefined ? {} : { ui: { herdrStatus: options.herdrStatus } }),
  });
  const unused = path.join(cwd, "unused.mjs");
  fs.writeFileSync(unused, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: {
      extension: unused,
      worker: path.resolve("tests/fixtures/fake-worker.mjs"),
      residentHost: unused,
      skills: cwd,
    },
  });
  await runtime.initialize(context, config);
  const herdrEvents = () => events.filter(([event]) => event.startsWith("herdr:"));
  return { runtime, herdrEvents, requests: herdr.requests };
};

describe.skipIf(process.platform === "win32")("Fabric runtime Herdr agent status", () => {
  it("marks a root TUI pane busy while an agent runs and clears it when the agent stops", async () => {
    const { runtime, herdrEvents, requests } = await startRuntime();
    try {
      const handle = await runtime.agents.spawn({ name: "scout", task: "HANG", transport: "process" });
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 });
      expect(herdrEvents()).toEqual([["herdr:busy", { active: true, label: "Fabric: 1 agent running" }]]);
      expect(requests[0]).toMatchObject({
        method: "pane.report_metadata",
        params: { pane_id: "w1:p1", applies_to_source: "herdr:pi", tokens: { summary: "⏳ 1 Fabric agent · scout" } },
      });
      await runtime.agents.stop(handle.id);
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 });
      expect(herdrEvents().at(-1)).toEqual(["herdr:busy", { active: false }]);
      expect(requests[1]!.params.clear_state_labels).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("releases its busy hold on shutdown while an agent still runs", async () => {
    const { runtime, herdrEvents, requests } = await startRuntime();
    await runtime.agents.spawn({ name: "scout", task: "HANG", transport: "process" });
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 });
    await runtime.shutdown();
    expect(herdrEvents()).toEqual([
      ["herdr:busy", { active: true, label: "Fabric: 1 agent running" }],
      ["herdr:busy", { active: false }],
    ]);
    expect(requests.at(-1)!.params.clear_state_labels).toBe(true);
  });

  it.each([
    ["a headless session", { mode: "rpc" as const }],
    ["a session with ui.herdrStatus off", { herdrStatus: false }],
  ])("tells Herdr nothing in %s", async (_name, options) => {
    const { runtime, herdrEvents, requests } = await startRuntime(options);
    try {
      const handle = await runtime.agents.spawn({ name: "scout", task: "HANG", transport: "process" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.agents.stop(handle.id);
    } finally {
      await runtime.shutdown();
    }
    expect(herdrEvents()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("tells Herdr nothing in a child session launched by Fabric", async () => {
    vi.stubEnv("PI_FABRIC_PARENT_RUN", "parent-run-1");
    vi.stubEnv("PI_FABRIC_AGENT_NAME", "worker");
    const { runtime, herdrEvents, requests } = await startRuntime();
    try {
      const handle = await runtime.agents.spawn({ name: "scout", task: "HANG", transport: "process" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.agents.stop(handle.id);
    } finally {
      await runtime.shutdown();
    }
    expect(herdrEvents()).toEqual([]);
    expect(requests).toEqual([]);
  });
});
