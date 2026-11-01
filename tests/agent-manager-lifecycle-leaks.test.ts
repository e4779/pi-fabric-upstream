import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];

const setup = (
  runRoot: string,
  workerPath = "tests/fixtures/fake-worker.mjs",
  timeoutMs = DEFAULT_FABRIC_CONFIG.agents.timeoutMs,
) => {
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_RUN_ROOT", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) {
    vi.stubEnv(key, undefined);
  }
  const manager = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 1, transport: "process", sessionExport: false, timeoutMs },
    { workerPath: path.resolve(workerPath), runRoot },
  );
  managers.push(manager);
  return manager;
};

const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-lifecycle-leaks-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager lifecycle leaks", () => {
  it("releases the concurrency slot when the run directory cannot be created", async () => {
    const root = tempRoot();
    // A file where the run root should be: creating <runRoot>/<id> fails
    // after admission and before any child exists.
    const runRoot = path.join(root, "runs");
    fs.writeFileSync(runRoot, "not a directory");
    const manager = setup(runRoot);

    await expect(manager.spawn({ task: "first", extensions: false })).rejects.toThrow();

    fs.rmSync(runRoot);
    fs.mkdirSync(runRoot);
    // maxConcurrent is 1: a leaked slot makes this run wait forever.
    const result = await manager.run({ task: "second", extensions: false });
    expect(result.status).toBe("completed");
  });

  it("resolves a pending wait when settlement cleanup fails", async () => {
    const manager = setup(tempRoot());
    const handle = await manager.spawn({ task: "HANG", extensions: false });
    // Settlement removes images.json; a directory there makes that removal throw.
    fs.mkdirSync(path.join(manager.runDirectory(handle.id)!, "images.json", "blocker"), { recursive: true });
    const pending = manager.wait(handle.id);

    const stopped = await manager.stop(handle.id);

    expect(stopped.status).toBe("stopped");
    await expect(pending).resolves.toMatchObject({ id: handle.id, status: "stopped" });
  });

  it("settles a run as failed when its monitor throws", async () => {
    const manager = setup(tempRoot(), "tests/fixtures/fake-worker-transport-death.mjs");
    const handle = await manager.spawn({ task: "Terminal boot death", extensions: false });
    // The worker exits without writing status.json. With a directory in its
    // place, the startup retry cannot rewrite the record and throws out of
    // the monitor loop.
    fs.mkdirSync(path.join(manager.runDirectory(handle.id)!, "status.json", "blocker"), { recursive: true });

    const result = await manager.wait(handle.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Agent monitor failed");
  });

  it.each(["pi", "pi-durable"] as const)("keeps %s terminal reads consistent when status replacement fails with ENOSPC", async (runner) => {
    const manager = setup(tempRoot(), "tests/fixtures/fake-worker.mjs", 1_000);
    const handle = await manager.spawn({ task: "HANG", runner, extensions: false });
    const statusFile = path.join(manager.runDirectory(handle.id)!, "status.json");
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(statusFile, "utf8")).status).toBe("running");
    });
    const running = fs.readFileSync(statusFile, "utf8");
    const renameSync = fs.renameSync;
    let failedReplacements = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === statusFile) {
        failedReplacements++;
        throw Object.assign(new Error("ENOSPC while replacing status.json"), { code: "ENOSPC" });
      }
      return renameSync(source, target);
    });

    // Start observing before the timeout: both the timeout write and the
    // monitor's fallback write fail, leaving a readable running file behind.
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({
      id: handle.id,
      status: "failed",
      error: "Agent monitor failed: ENOSPC while replacing status.json",
    });
    expect(failedReplacements).toBe(2);
    expect(fs.readFileSync(statusFile, "utf8")).toBe(running);
    expect(manager.status(handle.id)).toMatchObject(result);
    await expect(manager.wait(handle.id)).resolves.toMatchObject(result);
    expect(manager.list()).toEqual([expect.objectContaining(result)]);
    expect(manager.listForUi()).toEqual([expect.objectContaining(result)]);
    await expect(manager.wait(handle.id)).resolves.toMatchObject(result);
  });

  it("does not start a relaunched child when the lifecycle file cannot be reset", async () => {
    const launch = vi.spyOn(ProcessTransport.prototype, "launch");
    const manager = setup(tempRoot(), "tests/fixtures/fake-worker-transport-death.mjs");
    const handle = await manager.spawn({ task: "Terminal boot death", extensions: false });
    // A directory where lifecycle.jsonl belongs makes the relaunch's reset fail.
    fs.mkdirSync(path.join(manager.runDirectory(handle.id)!, "lifecycle.jsonl", "blocker"), { recursive: true });

    const result = await manager.wait(handle.id);

    expect(result.status).toBe("failed");
    // Only the first launch: the failed reset must not leave a second child
    // running after the run settled.
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
