import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { WorktreeManager } from "../src/agents/worktree-manager.js";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import type { AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { normalizeAgentRunRequest } from "../src/agents/request.js";

const managers: AgentManager[] = [];
const roots: string[] = [];

const setup = (extra: ConstructorParameters<typeof AgentManager>[2] = {}) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-queue-test-"));
  roots.push(runRoot);
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_RUN_ROOT", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) {
    vi.stubEnv(key, undefined);
  }
  const manager = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 1, transport: "process", sessionExport: false },
    { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot, ...extra },
  );
  managers.push(manager);
  return { manager, runRoot };
};

// Resolves when the manager reports the run in the given status. The manager
// notifies UI subscribers on every run registration and settlement, so this is
// an explicit handshake rather than a polling loop.
const untilStatus = (manager: AgentManager, id: string, status: string): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const check = () => {
      if (done || manager.status(id).status !== status) return;
      done = true;
      unsubscribe();
      resolve();
    };
    unsubscribe = manager.subscribeUi(check);
    check();
  });

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agents.spawn queue: true", () => {
  it("returns every handle at once past maxConcurrent and starts each run in turn after the program deadline", async () => {
    const { manager } = setup();
    const deadline = new AbortController();
    const pending = Promise.all([
      manager.spawn({ task: "HANG first", extensions: false, queue: true }, deadline.signal),
      manager.spawn({ task: "HANG second", extensions: false, queue: true }, deadline.signal),
      manager.spawn({ task: "third", extensions: false, queue: true }, deadline.signal),
    ]);
    // The calling program's deadline passes while two of the three wait for the one slot.
    deadline.abort();
    const [first, second, third] = await pending;
    expect([first!.status, second!.status, third!.status]).toEqual(["queued", "queued", "queued"]);
    expect(new Set([first!.id, second!.id, third!.id]).size).toBe(3);
    expect(manager.list().map((run) => run.id).sort()).toEqual([first!.id, second!.id, third!.id].sort());

    await untilStatus(manager, first!.id, "running");
    expect(manager.status(second!.id).status).toBe("queued");
    expect(manager.status(third!.id).status).toBe("queued");

    await manager.stop(first!.id);
    await untilStatus(manager, second!.id, "running");
    expect(manager.status(third!.id).status).toBe("queued");

    await manager.stop(second!.id);
    const result = await manager.wait(third!.id);
    expect(result).toMatchObject({ id: third!.id, status: "completed", text: "fake worker complete" });
  });

  it("keeps the default: without queue, spawn waits inside the call and the caller's abort cancels it", async () => {
    const { manager } = setup();
    const blocker = await manager.spawn({ task: "HANG blocker", extensions: false });
    expect(blocker.status).toBe("running");
    const caller = new AbortController();
    const waiting = manager.spawn({ task: "second", extensions: false }, caller.signal);
    const rejected = expect(waiting).rejects.toThrow("Operation aborted");
    caller.abort();
    await rejected;
    expect(manager.list().map((run) => run.id)).toEqual([blocker.id]);
  });

  it("stop before start cancels a queued run without launching it and frees nothing it never held", async () => {
    const { manager, runRoot } = setup();
    const blocker = await manager.spawn({ task: "HANG blocker", extensions: false });
    const queued = await manager.spawn({ task: "never runs", extensions: false, queue: true });
    expect(manager.status(queued.id).status).toBe("queued");

    const stopped = await manager.stop(queued.id);
    expect(stopped).toMatchObject({ id: queued.id, status: "stopped", turns: 0 });
    expect(manager.status(queued.id).status).toBe("stopped");
    expect(await manager.wait(queued.id)).toMatchObject({ id: queued.id, status: "stopped" });

    await manager.stop(blocker.id);
    // The slot passes to the next spawn, not to the cancelled run.
    const next = await manager.run({ task: "next", extensions: false });
    expect(next.status).toBe("completed");
    expect(fs.existsSync(path.join(runRoot, queued.id))).toBe(false);
    expect(manager.status(queued.id).status).toBe("stopped");
    await expect(manager.cleanup(queued.id)).resolves.toEqual({ cleaned: true });
    expect(() => manager.status(queued.id)).toThrow("Unknown Fabric agent");
  });

  it("does not launch when stopped during model preparation and releases its slot", async () => {
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    const { manager, runRoot } = setup({
      preparePiModel: async () => { started(); await deferred; },
    });
    const queued = await manager.spawn({ task: "never runs", runner: "pi", extensions: false, queue: true });
    await preparing;
    const stopping = manager.stop(queued.id);
    finish();
    expect(await stopping).toMatchObject({ id: queued.id, status: "stopped", turns: 0 });
    expect(await manager.wait(queued.id)).toMatchObject({ status: "stopped" });
    expect(fs.existsSync(path.join(runRoot, queued.id))).toBe(false);
    await expect(manager.cleanup(queued.id)).resolves.toEqual({ cleaned: true });
    const next = await manager.run({ task: "next", runner: "pi", extensions: false });
    expect(next.status).toBe("completed");
  });

  it.each(["create", "setup", "budget", "transport"] as const)("cancels during deferred %s and releases resources", async (phase) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    const pause = async () => { entered(); await deferred; };
    const lease = { gitRoot: process.cwd(), path: process.cwd(), cwd: process.cwd(), branch: "test" };
    vi.spyOn(WorktreeManager.prototype, "create").mockImplementation(async () => {
      if (phase === "create") await pause();
      return lease;
    });
    const setupWorktree = vi.spyOn(WorktreeManager.prototype, "setup").mockImplementation(async () => {
      if (phase === "setup") await pause();
    });
    const cleanup = vi.spyOn(WorktreeManager.prototype, "cleanup").mockResolvedValue(true);
    const available = vi.spyOn(ProcessTransport.prototype, "available").mockImplementation(async () => {
      if (phase === "transport") await pause();
      return true;
    });
    const launch = vi.spyOn(ProcessTransport.prototype, "launch");
    const { manager } = setup({ resolveHandoffCompactionBudget: async () => { await pause(); return { contextWindow: 50_000, targetContextRatio: 0.5, reserveTokens: 5000, keepRecentTokens: 1000 }; } });
    const queued = await manager.spawn({
      task: "never runs", queue: true, extensions: false, worktree: true, worktreeSetup: "setup",
      ...(phase === "budget" ? { sessionSeed: {} as never, handoffCompact: {} } : {}),
    });
    await started;
    const stopping = manager.stop(queued.id);
    finish();
    expect(await stopping).toMatchObject({ status: "stopped" });
    expect(await manager.wait(queued.id)).toMatchObject({ status: "stopped" });
    expect(cleanup).toHaveBeenCalledWith(queued.id, true);
    expect(launch).not.toHaveBeenCalled();
    if (phase === "create") expect(setupWorktree).not.toHaveBeenCalled();
    available.mockRestore();
    const next = await manager.run({ task: "next", extensions: false });
    expect(next.status).toBe("completed");
  });

  it("stops a transport acquired after queued cancellation", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const deferred = new Promise<void>((resolve) => { finish = resolve; });
    const stop = vi.fn(async () => {});
    vi.spyOn(ProcessTransport.prototype, "launch").mockImplementation(async () => {
      entered();
      await deferred;
      return { kind: "process", sessionId: "test", stop, isAlive: async () => false };
    });
    const { manager } = setup();
    const queued = await manager.spawn({ task: "late transport", queue: true, extensions: false });
    await started;
    const stopping = manager.stop(queued.id);
    finish();
    expect(await stopping).toMatchObject({ status: "stopped" });
    expect(stop).toHaveBeenCalledOnce();
    expect(await manager.wait(queued.id)).toMatchObject({ status: "stopped" });
  });

  it("wait on a queued run resolves with the run's result once it starts and finishes", async () => {
    const { manager } = setup();
    const blocker = await manager.spawn({ task: "HANG blocker", extensions: false });
    const queued = await manager.spawn({ task: "done later", extensions: false, queue: true });
    const waiting = manager.wait(queued.id);
    await manager.stop(blocker.id);
    expect(await waiting).toMatchObject({ id: queued.id, status: "completed" });
  });

  it("reports a launch that fails after admission as a failed run and notifies a detached caller", async () => {
    const notified: AgentRunResult[] = [];
    const { manager } = setup({
      preparePiModel: async () => { throw new Error("model is no longer available"); },
      onBackgroundComplete: (result) => notified.push(result),
    });
    const queued = await manager.spawn({ task: "bad model", runner: "pi", extensions: false, queue: true });
    expect(queued.status).toBe("queued");
    const result = await manager.wait(queued.id);
    expect(result).toMatchObject({ id: queued.id, status: "failed", error: "model is no longer available" });
    // A foreground caller consumed the result, so nothing is pushed.
    expect(notified).toEqual([]);

    // The agents provider detaches every local spawn; then the failure is delivered.
    const detached = await manager.spawn({ task: "bad model again", runner: "pi", extensions: false, queue: true });
    manager.detachSignal(detached.id);
    await untilStatus(manager, detached.id, "failed");
    expect(notified.map((entry) => [entry.id, entry.status])).toEqual([[detached.id, "failed"]]);
  });

  it("rejects validation errors from the spawn call itself, before a handle exists", async () => {
    const { manager } = setup();
    await expect(manager.spawn({ task: "x", runner: "claude", persona: "p", queue: true })).rejects.toThrow("persona");
    await expect(manager.spawn({ task: "x", residency: "durable", queue: true })).rejects.toThrow('residency: "durable"');
    expect(manager.list()).toEqual([]);
  });

  it("stops queued runs on close without launching them", async () => {
    const { manager, runRoot } = setup();
    await manager.spawn({ task: "HANG blocker", extensions: false });
    const queued = await manager.spawn({ task: "queued at close", extensions: false, queue: true });
    const waiting = manager.wait(queued.id);
    await manager.close();
    expect(await waiting).toMatchObject({ id: queued.id, status: "stopped" });
    expect(fs.existsSync(path.join(runRoot, queued.id))).toBe(false);
  });
});

describe("queue request surface", () => {
  it("is an agents.spawn option only", () => {
    const schema = (name: string) =>
      AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === name)!.inputSchema as { properties: Record<string, unknown> };
    expect(schema("spawn").properties.queue).toMatchObject({ type: "boolean" });
    expect(schema("run").properties).not.toHaveProperty("queue");
  });

  it("keeps only a literal true", () => {
    const defaults = { runner: "pi" as const, timeoutMs: 1_000 };
    expect(normalizeAgentRunRequest({ task: "t", queue: true }, defaults).queue).toBe(true);
    expect(normalizeAgentRunRequest({ task: "t", queue: false }, defaults)).not.toHaveProperty("queue");
    expect(normalizeAgentRunRequest({ task: "t" }, defaults)).not.toHaveProperty("queue");
  });
});
