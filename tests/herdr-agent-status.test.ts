import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERDR_STATUS_SOURCE,
  HerdrAgentStatus,
  type HerdrAgentStatusOptions,
} from "../src/agents/herdr-status.js";
import type { AgentActivity } from "../src/agents/types.js";

// Herdr's Pi integration reports a pane idle as soon as the root turn ends,
// even while Fabric agents keep running. HerdrAgentStatus tells Herdr about
// them: herdr:busy and herdr:blocked events for the integration, and pane
// metadata that replaces the idle text with a count of running agents.

const environment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HERDR_SOCKET_PATH: "/run/herdr-test.sock",
};

interface Sent {
  socketPath: string;
  method: string;
  params: Record<string, unknown>;
}

const setup = (overrides: Partial<HerdrAgentStatusOptions> = {}) => {
  let runs: AgentActivity[] = [];
  const events: Array<[string, unknown]> = [];
  const sent: Sent[] = [];
  let clock = 1_000;
  const status = new HerdrAgentStatus({
    events: { emit: (event, data) => void events.push([event, data]) },
    activity: () => runs,
    environment,
    request: async (socketPath, request) => {
      sent.push({ socketPath, method: request.method, params: request.params });
      return { result: { type: "ok" } };
    },
    now: () => clock,
    ...overrides,
  });
  return {
    status,
    events,
    sent,
    set(next: AgentActivity[]) {
      runs = next;
      status.sync();
    },
    tick(ms: number) {
      clock += ms;
    },
  };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("HerdrAgentStatus", () => {
  it("stays silent while no agent runs", async () => {
    const h = setup();
    h.set([]);
    await flush();
    expect(h.events).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("marks the pane busy and shows the running agents in place of idle", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout" }, { id: "r2", name: "reviewer" }]);
    await flush();
    expect(h.events).toEqual([["herdr:busy", { active: true, label: "Fabric: 2 agents running" }]]);
    expect(h.sent).toHaveLength(1);
    const text = "⏳ 2 Fabric agents · scout, reviewer";
    expect(h.sent[0]).toEqual({
      socketPath: environment.HERDR_SOCKET_PATH,
      method: "pane.report_metadata",
      params: {
        pane_id: "w1:p1",
        source: HERDR_STATUS_SOURCE,
        agent: "pi",
        applies_to_source: "herdr:pi",
        state_labels: { idle: text, done: text, working: text },
        tokens: { summary: text },
        ttl_ms: 120_000,
        seq: 1_000_000,
      },
    });
  });

  it("reports nothing new when the activity has not changed", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout" }]);
    h.set([{ id: "r1", name: "scout" }]);
    await flush();
    expect(h.events).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it("re-raises busy once when the count changes, keeping raises and releases paired", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout" }]);
    h.set([{ id: "r1", name: "scout" }, { id: "r2", name: "scout" }]);
    h.set([]);
    await flush();
    expect(h.events).toEqual([
      ["herdr:busy", { active: true, label: "Fabric: 1 agent running" }],
      ["herdr:busy", { active: false }],
      ["herdr:busy", { active: true, label: "Fabric: 2 agents running" }],
      ["herdr:busy", { active: false }],
    ]);
  });

  it("blocks the pane while a child waits on the user and releases it once", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout" }]);
    h.set([{ id: "r1", name: "scout", question: "Pick a branch" }]);
    h.set([{ id: "r1", name: "scout", question: "Pick a branch" }]);
    await flush();
    expect(h.events.filter(([event]) => event === "herdr:blocked")).toEqual([
      ["herdr:blocked", { active: true, label: "scout: Pick a branch" }],
    ]);
    expect((h.sent.at(-1)!.params.tokens as Record<string, string>).summary).toBe(
      "⏳ 1 Fabric agent · ⚠ 1 waiting · scout",
    );
    h.set([{ id: "r1", name: "scout" }]);
    h.set([]);
    expect(h.events.filter(([event]) => event === "herdr:blocked")).toEqual([
      ["herdr:blocked", { active: true, label: "scout: Pick a branch" }],
      ["herdr:blocked", { active: false }],
    ]);
  });

  it("releases a run's hold when it settles with its question still open", () => {
    const h = setup();
    h.set([
      { id: "r1", name: "scout", question: "Pick" },
      { id: "r2", name: "reviewer", question: "Approve?" },
    ]);
    h.set([{ id: "r2", name: "reviewer", question: "Approve?" }]);
    const blocked = h.events.filter(([event]) => event === "herdr:blocked");
    expect(blocked).toEqual([
      ["herdr:blocked", { active: true, label: "scout: Pick" }],
      ["herdr:blocked", { active: true, label: "reviewer: Approve?" }],
      ["herdr:blocked", { active: false }],
    ]);
  });

  it("clears its metadata with a newer sequence when the last agent settles", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout" }]);
    await flush();
    h.set([]);
    await flush();
    expect(h.events.at(-1)).toEqual(["herdr:busy", { active: false }]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.params).toEqual({
      pane_id: "w1:p1",
      source: HERDR_STATUS_SOURCE,
      agent: "pi",
      applies_to_source: "herdr:pi",
      clear_state_labels: true,
      tokens: { summary: null },
      seq: 1_000_001,
    });
  });

  it("refreshes the metadata before its TTL lapses while agents run", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.set([{ id: "r1", name: "scout" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toHaveLength(1);
    h.tick(45_000);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.params.seq).toBe(46_000_000);
    expect(h.sent[1]!.params.state_labels).toEqual(h.sent[0]!.params.state_labels);
    h.set([]);
    await vi.advanceTimersByTimeAsync(0);
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.sent).toHaveLength(count);
  });

  it("keeps only the newest pending report and survives a failed request", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let fail = true;
    let release: (() => void) | undefined;
    const h = setup({
      request: async (_socket, request) => {
        sent.push(request.params);
        if (fail) {
          fail = false;
          await new Promise<void>((resolve) => { release = resolve; });
          throw new Error("socket closed");
        }
        return {};
      },
    });
    h.set([{ id: "r1", name: "a" }]);
    h.set([{ id: "r1", name: "a" }, { id: "r2", name: "b" }]);
    h.set([{ id: "r1", name: "a" }, { id: "r2", name: "b" }, { id: "r3", name: "c" }]);
    await flush();
    release!();
    await flush();
    await flush();
    expect(sent.map((params) => (params.tokens as Record<string, string>).summary)).toEqual([
      "⏳ 1 Fabric agent · a",
      "⏳ 3 Fabric agents · a, b, c",
    ]);
  });

  it("clips the summary to Herdr's 80-character limit", async () => {
    const h = setup();
    h.set(Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, name: `worker-number-${index}` })));
    await flush();
    const summary = (h.sent[0]!.params.tokens as Record<string, string>).summary!;
    expect(summary.length).toBe(80);
    expect(summary.startsWith("⏳ 12 Fabric agents · worker-number-0, ")).toBe(true);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("releases every hold and clears the pane on close, then ignores later syncs", async () => {
    const h = setup();
    h.set([{ id: "r1", name: "scout", question: "Pick" }]);
    await flush();
    await h.status.close();
    expect(h.events.slice(-2)).toEqual([
      ["herdr:blocked", { active: false }],
      ["herdr:busy", { active: false }],
    ]);
    expect(h.sent.at(-1)!.params.clear_state_labels).toBe(true);
    const events = h.events.length;
    const sent = h.sent.length;
    h.set([{ id: "r2", name: "late" }]);
    await flush();
    expect(h.events).toHaveLength(events);
    expect(h.sent).toHaveLength(sent);
  });

  it.each([
    { HERDR_ENV: "", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s" },
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
  ])("does nothing outside a Herdr pane (%o)", async (outside) => {
    const h = setup({ environment: outside });
    h.set([{ id: "r1", name: "scout", question: "Pick" }]);
    await flush();
    await h.status.close();
    expect(h.events).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("HerdrAgentStatus over the Herdr socket", () => {
  const roots: string[] = [];
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("sends its reports as Herdr API requests on HERDR_SOCKET_PATH", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-herdr-status-"));
    roots.push(root);
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
    let runs: AgentActivity[] = [{ id: "r1", name: "scout" }];
    const status = new HerdrAgentStatus({
      events: { emit: () => undefined },
      activity: () => runs,
      environment: { ...environment, HERDR_SOCKET_PATH: socketPath },
    });
    status.sync();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    runs = [];
    status.sync();
    await status.close();
    expect(requests.map((request) => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata"]);
    expect(requests[0]!.params.state_labels).toMatchObject({ idle: "⏳ 1 Fabric agent · scout" });
    expect(requests[1]!.params.clear_state_labels).toBe(true);
  });
});
