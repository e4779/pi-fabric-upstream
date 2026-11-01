import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import {
  adoptedWorkerHandle,
  probeWorker,
  readWorkerRecovery,
  WORKER_RECOVERY_FILE,
  WORKER_RECOVERY_MAX_BYTES,
  workerRecoveryAuthorityRoot,
} from "../src/agents/worker-recovery.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
const pids: number[] = [];

const manager = (root: string, durableWorkerRecovery: boolean): AgentManager => {
  const created = new AgentManager(
    process.cwd(),
    {
      ...DEFAULT_FABRIC_CONFIG.agents,
      budgetUsd: 0,
      retainRuns: true,
      transport: "process",
      sessionExport: false,
      durableWorkerRecovery,
    },
    { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root },
  );
  managers.push(created);
  return created;
};

const until = async (condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readStatus = (runDirectory: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
  } catch {
    return undefined;
  }
};

const writeStatus = (runDirectory: string, patch: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify({ ...readStatus(runDirectory), ...patch }));
};

const attempts = (runDirectory: string): string =>
  fs.readFileSync(path.join(runDirectory, "reattach-attempts"), "utf8");

const argument = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

/** Rewrite worker-recovery.json in place, as anything able to write the run directory could. */
const tamper = (runDirectory: string, edit: (value: { launch: { workerPath: string; cwd: string; workerArguments: string[] } }) => void): void => {
  const file = path.join(runDirectory, WORKER_RECOVERY_FILE);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(value);
  fs.writeFileSync(file, JSON.stringify(value));
};

const setArgument = (args: string[], name: string, value: string): void => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) throw new Error(`no --${name}`);
  args[index + 1] = value;
};

const killWorker = async (pid: number): Promise<void> => {
  process.kill(-pid, "SIGKILL");
  await until(() => !alive(pid), "the worker to die");
};

/** Launch a durable pi-durable REATTACH run and close its host, leaving the worker. */
const orphanedRun = async (durableWorkerRecovery = true, recursive?: boolean) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-"));
  roots.push(root);
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  const first = manager(root, durableWorkerRecovery);
  const handle = await first.spawn({
    task: "REATTACH",
    runner: "pi-durable",
    residency: "durable",
    extensions: recursive === true,
    ...(recursive === undefined ? {} : { recursive }),
  });
  const runDirectory = path.join(root, handle.id);
  await until(() => readStatus(runDirectory)?.status === "running", "the first attempt to start");
  const recovery = readWorkerRecovery(runDirectory);
  if (recovery) pids.push(recovery.pid);
  await first.close();
  return { root, id: handle.id, runDirectory, pid: recovery?.pid, recovery };
};

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((created) => created.close()));
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workerRecoveryAuthorityRoot(root), { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("pi-durable worker recovery after a host restart (#314)", () => {
  it("leaves an opted-in durable worker running when its host closes, and a new host re-attaches it", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    expect(pid).toBeTypeOf("number");
    // The closing host did not stop the worker and kept its recovery file.
    expect(alive(pid!)).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(true);
    expect(readStatus(runDirectory)?.status).toBe("running");

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([id]);
    fs.writeFileSync(path.join(runDirectory, "release"), "");
    const result = await second.wait(id);

    expect(result.status).toBe("completed");
    // The original attempt finished: it was adopted, not relaunched.
    expect(result.text).toBe("reattach attempt 1");
    expect(fs.readFileSync(path.join(runDirectory, "reattach-attempts"), "utf8")).toBe("1");
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
  }, 30_000);

  it("relaunches a dead durable worker on the same run directory with its progress carried over", async () => {
    const { root, id, runDirectory, pid, recovery } = await orphanedRun();
    process.kill(-pid!, "SIGKILL");
    await until(() => !alive(pid!), "the worker to die");

    const second = manager(root, true);
    const before = Date.now();
    expect(await second.recoverWorkerRuns()).toEqual([id]);
    const relaunched = readWorkerRecovery(runDirectory);
    expect(relaunched?.pid).not.toBe(pid);
    pids.push(relaunched!.pid);
    // The relaunch gets only what is left of the original deadline.
    expect(relaunched!.deadlineAt).toBe(recovery!.deadlineAt);
    const remaining = Number(argument(relaunched!.launch.workerArguments, "timeout-ms"));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(recovery!.deadlineAt - before);
    expect(remaining).toBeLessThan(Number(argument(recovery!.launch.workerArguments, "timeout-ms")));
    fs.writeFileSync(path.join(runDirectory, "release"), "");
    const result = await second.wait(id);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("reattach attempt 2");
    // The durable runner keeps its prompt identity across the relaunch.
    expect(result.task).toBe("REATTACH");
    // Attempt 1 recorded 2 turns and 1 tool call; attempt 2 starts from that prefix.
    expect(result.turns).toBe(4);
    expect(result.toolCalls).toBe(2);
  }, 30_000);

  it("settles a run whose deadline passed while no host owned it as indeterminate", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    process.kill(-pid!, "SIGKILL");
    await until(() => !alive(pid!), "the worker to die");
    const file = path.join(runDirectory, WORKER_RECOVERY_FILE);
    vi.spyOn(Date, "now").mockReturnValue(readWorkerRecovery(runDirectory)!.deadlineAt + 1);

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    const status = readStatus(runDirectory);
    expect(status?.id).toBe(id);
    expect(status?.status).toBe("failed");
    expect(status?.outcome).toBe("indeterminate");
    expect(status?.error).toBe(
      "The durable worker run passed its deadline while no resident host owned it; the run outcome is indeterminate",
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(runDirectory, "reattach-attempts"))).toBe(true);
    expect(fs.readFileSync(path.join(runDirectory, "reattach-attempts"), "utf8")).toBe("1");
  }, 30_000);

  it("does not recover a run Fabric stopped on request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-"));
    roots.push(root);
    vi.stubEnv("PI_FABRIC_DEPTH", "0");
    const first = manager(root, true);
    const handle = await first.spawn({ task: "REATTACH", runner: "pi-durable", residency: "durable", extensions: false });
    const runDirectory = path.join(root, handle.id);
    await until(() => readStatus(runDirectory)?.status === "running", "the worker to start");
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(true);
    await first.stop(handle.id);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)?.status).toBe("stopped");
  }, 30_000);

  it("removes the recovery file the moment a stop is requested, so a host that dies mid-stop leaves nothing to relaunch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-"));
    roots.push(root);
    vi.stubEnv("PI_FABRIC_DEPTH", "0");
    const first = manager(root, true);
    const handle = await first.spawn({ task: "REATTACH", runner: "pi-durable", residency: "durable", extensions: false });
    const runDirectory = path.join(root, handle.id);
    const file = path.join(runDirectory, WORKER_RECOVERY_FILE);
    await until(() => readStatus(runDirectory)?.status === "running", "the worker to start");
    pids.push(readWorkerRecovery(runDirectory)!.pid);

    const stopping = first.stop(handle.id);
    // Checked before stop() reaches any transport work or #settle.
    expect(fs.existsSync(file)).toBe(false);
    // A host that takes over inside the stop window finds nothing to recover.
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    await stopping;
    expect(readStatus(runDirectory)?.status).toBe("stopped");
    expect(attempts(runDirectory)).toBe("1");
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  it("waits for a worker that recorded a stop but is still exiting before relaunching it", async () => {
    const { root, id, runDirectory, pid } = await orphanedRun();
    writeStatus(runDirectory, { status: "stopped", finishedAt: Date.now() });
    let killedAt = Number.POSITIVE_INFINITY;
    const exit = setTimeout(() => {
      killedAt = Date.now();
      process.kill(-pid!, "SIGKILL");
    }, 600);

    const second = manager(root, true);
    try {
      expect(await second.recoverWorkerRuns()).toEqual([id]);
    } finally {
      clearTimeout(exit);
    }
    const relaunched = readWorkerRecovery(runDirectory);
    pids.push(relaunched!.pid);
    await until(() => readStatus(runDirectory)?.status === "running", "the relaunched attempt to start");
    expect(attempts(runDirectory)).toBe("2");
    // The new attempt started only after the old worker was gone.
    expect(Number(readStatus(runDirectory)?.startedAt)).toBeGreaterThanOrEqual(killedAt);
    fs.writeFileSync(path.join(runDirectory, "release"), "");
    expect((await second.wait(id)).text).toBe("reattach attempt 2");
  }, 30_000);

  it("settles a worker that recorded a stop but never exits as indeterminate instead of relaunching", async () => {
    const { root, runDirectory, pid } = await orphanedRun();
    writeStatus(runDirectory, { status: "stopped", finishedAt: Date.now() });

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    const status = readStatus(runDirectory);
    expect(status?.status).toBe("failed");
    expect(status?.outcome).toBe("indeterminate");
    expect(status?.error).toBe(
      `Worker process ${pid} recorded a stop but did not exit; the run outcome is indeterminate`,
    );
    expect(attempts(runDirectory)).toBe("1");
    expect(alive(pid!)).toBe(true);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
  }, 30_000);

  it.each([
    ["a tampered worker path", (root: string) => (value: Parameters<Parameters<typeof tamper>[1]>[0]) => {
      const copy = path.join(root, "other-worker.mjs");
      fs.copyFileSync(path.resolve("tests/fixtures/fake-worker.mjs"), copy);
      value.launch.workerPath = copy;
    }],
    ["a --status-file outside the run directory", (root: string) => (value: Parameters<Parameters<typeof tamper>[1]>[0]) => {
      setArgument(value.launch.workerArguments, "status-file", path.join(root, "elsewhere.json"));
    }],
    ["a --task-file that climbs out of the run directory", (root: string) => (value: Parameters<Parameters<typeof tamper>[1]>[0]) => {
      const taskFile = argument(value.launch.workerArguments, "task-file")!;
      fs.writeFileSync(path.join(root, "task.txt"), "REATTACH");
      setArgument(value.launch.workerArguments, "task-file", path.join(path.dirname(taskFile), "..", "task.txt"));
    }],
    ["a different --id", () => (value: Parameters<Parameters<typeof tamper>[1]>[0]) => {
      setArgument(value.launch.workerArguments, "id", "b".repeat(32));
    }],
    ["a different working directory", (root: string) => (value: Parameters<Parameters<typeof tamper>[1]>[0]) => {
      value.launch.cwd = root;
      setArgument(value.launch.workerArguments, "cwd", root);
    }],
  ])("refuses to relaunch a recovery file with %s", async (_label, edit) => {
    const { root, runDirectory, pid } = await orphanedRun();
    await killWorker(pid!);
    tamper(runDirectory, edit(root));

    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    const status = readStatus(runDirectory);
    expect(status?.status).toBe("failed");
    expect(status?.outcome).toBe("indeterminate");
    expect(status?.error).toBe("The recovery file does not match this host; the run outcome is indeterminate");
    expect(attempts(runDirectory)).toBe("1");
    expect(fs.existsSync(path.join(root, "elsewhere.json"))).toBe(false);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
  }, 30_000);

  it("rejects the real runner/binary injection before any child executes", async () => {
    const { root, runDirectory, pid } = await orphanedRun();
    await killWorker(pid!);
    const executed = path.join(root, "executed");
    const payload = path.join(root, "payload.mjs");
    fs.writeFileSync(payload, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(executed)}, 'executed');`);
    tamper(runDirectory, value => {
      setArgument(value.launch.workerArguments, "runner", "pi");
      setArgument(value.launch.workerArguments, "pi-binary", payload);
    });
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(fs.existsSync(executed)).toBe(false);
    expect(attempts(runDirectory)).toBe("1");
  });

  it("settles a marker with no first status explicitly indeterminate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-startup-window-")); roots.push(root);
    const workerPath = path.join(root, "slow.mjs"); fs.writeFileSync(workerPath, "setInterval(() => {}, 1000);");
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, retainRuns: true, transport: "process" as const, sessionExport: false, durableWorkerRecovery: true };
    const first = new AgentManager(process.cwd(), config, { workerPath, runRoot: root }); managers.push(first);
    const handle = await first.spawn({ task: "go", runner: "pi-durable", residency: "durable", extensions: false });
    const directory = path.join(root, handle.id), recovery = readWorkerRecovery(directory)!; pids.push(recovery.pid);
    await first.close(); await killWorker(recovery.pid);
    expect(readStatus(directory)).toBeUndefined();
    const second = new AgentManager(process.cwd(), config, { workerPath, runRoot: root }); managers.push(second);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(directory)).toMatchObject({ id: handle.id, status: "failed", outcome: "indeterminate" });
    expect(readWorkerRecovery(directory)).toBeUndefined();
  });

  it("settles a malformed recovery marker without executing or recreating authority", async () => {
    const { root, runDirectory, pid } = await orphanedRun(); await killWorker(pid!);
    fs.writeFileSync(path.join(runDirectory, WORKER_RECOVERY_FILE), "{bad json");
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(fs.existsSync(workerRecoveryAuthorityRoot(root))).toBe(false);
    expect(attempts(runDirectory)).toBe("1");
  });

  it("settles a missing host receipt instead of recreating authority from the marker", async () => {
    const { root, runDirectory, pid } = await orphanedRun(); await killWorker(pid!);
    fs.rmSync(workerRecoveryAuthorityRoot(root), { recursive: true });
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(readWorkerRecovery(runDirectory)).toBeUndefined();
    expect(fs.existsSync(workerRecoveryAuthorityRoot(root))).toBe(false);
    expect(attempts(runDirectory)).toBe("1");
  });

  it("refuses old launch authority after current host token limits change", async () => {
    const { root, runDirectory, pid } = await orphanedRun(); await killWorker(pid!);
    const second = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, retainRuns: true, transport: "process", sessionExport: false, durableWorkerRecovery: true, maxTokensPerChild: 1 }, { workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root }); managers.push(second);
    expect(await second.recoverWorkerRuns()).toEqual([]);
    expect(readStatus(runDirectory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(attempts(runDirectory)).toBe("1");
  });

  it.each([
    { label: "revoked", next: '["read"]', allowed: false },
    { label: "unchanged", next: '["read","fabric_exec"]', allowed: true },
  ])("checks the separate fabric_exec recovery authority ($label)", async ({ next, allowed }) => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read","fabric_exec"]');
    const { root, id, runDirectory, pid, recovery } = await orphanedRun(true, true);
    expect(JSON.parse(argument(recovery!.launch.workerArguments, "tools")!)).toContain("fabric_exec");
    await killWorker(pid!);

    // Both policies have entries=["read"]; only the separately stored bit changes.
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", next);
    const second = manager(root, true);
    const recovered = await second.recoverWorkerRuns();
    const relaunched = readWorkerRecovery(runDirectory);
    if (relaunched && relaunched.pid !== pid) pids.push(relaunched.pid);
    expect(recovered).toEqual(allowed ? [id] : []);
    if (allowed) {
      expect(JSON.parse(argument(relaunched!.launch.workerArguments, "tools")!)).toContain("fabric_exec");
      fs.writeFileSync(path.join(runDirectory, "release"), "");
      expect((await second.wait(id)).status).toBe("completed");
    } else {
      expect(readStatus(runDirectory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
      expect(attempts(runDirectory)).toBe("1");
      expect(relaunched).toBeUndefined();
      // The same current host may start a fresh child, but cannot give it the revoked tool.
      const fresh = await second.spawn({ task: "REATTACH", runner: "pi-durable", residency: "durable", recursive: true });
      const freshDirectory = path.join(root, fresh.id);
      const freshRecovery = readWorkerRecovery(freshDirectory)!;
      pids.push(freshRecovery.pid);
      expect(JSON.parse(argument(freshRecovery.launch.workerArguments, "tools")!)).not.toContain("fabric_exec");
      fs.writeFileSync(path.join(freshDirectory, "release"), "");
      expect((await second.wait(fresh.id)).status).toBe("completed");
    }
  }, 30_000);

  it("keeps today's behaviour when agents.durableWorkerRecovery is off", async () => {
    const { root, runDirectory } = await orphanedRun(false);
    expect(fs.existsSync(path.join(runDirectory, WORKER_RECOVERY_FILE))).toBe(false);
    // The closing host stopped the worker as before.
    expect(readStatus(runDirectory)?.status).not.toBe("running");
    const second = manager(root, true);
    expect(await second.recoverWorkerRuns()).toEqual([]);
  }, 30_000);
});

describe("probeWorker", () => {
  const id = "a".repeat(32);
  it("accepts a live process whose command line carries the run id", () => {
    expect(probeWorker(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${id} --name n`,
    })).toBe("alive");
  });
  it("treats a reused PID running something else as a dead worker", () => {
    expect(probeWorker(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${"c".repeat(32)}`,
    })).toBe("dead");
  });
  it("refuses to guess when the PID belongs to another user or its command line is unreadable", () => {
    expect(probeWorker(4242, id, { signal: () => "unknown", commandLine: () => `--id ${id}` })).toBe("unknown");
    expect(probeWorker(4242, id, { signal: () => "exists", commandLine: () => undefined })).toBe("unknown");
  });
  it("reports a missing PID as dead", () => {
    expect(probeWorker(4242, id, { signal: () => "missing", commandLine: () => `--id ${id}` })).toBe("dead");
  });
  it("sees this process's own command line through the default probes", () => {
    // Windows has neither /proc nor ps, so the default command-line probe
    // cannot read it and the probe refuses to guess.
    expect(probeWorker(process.pid, id)).toBe(process.platform === "win32" ? "unknown" : "dead");
  });
});

describe("readWorkerRecovery", () => {
  const id = "d".repeat(32);
  const valid = () => ({
    format: 1,
    id,
    runner: "pi-durable",
    deadlineAt: Date.now() + 60_000,
    pid: 4242,
    writtenAt: Date.now(),
    launch: { id, name: "n", cwd: "/work", workerPath: "/x/worker.js", workerArguments: ["--id", id] },
  });
  const runDirectory = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-worker-recovery-read-"));
    roots.push(root);
    const directory = path.join(root, id);
    fs.mkdirSync(directory);
    return directory;
  };
  const write = (directory: string, content: string): void => {
    fs.writeFileSync(path.join(directory, WORKER_RECOVERY_FILE), content);
  };

  it("reads a well-formed record", () => {
    const directory = runDirectory();
    write(directory, JSON.stringify(valid()));
    expect(readWorkerRecovery(directory)?.pid).toBe(4242);
  });
  it("rejects malformed content", () => {
    const directory = runDirectory();
    write(directory, "{not json");
    expect(readWorkerRecovery(directory)).toBeUndefined();
    write(directory, JSON.stringify({ ...valid(), pid: -1 }));
    expect(readWorkerRecovery(directory)).toBeUndefined();
    write(directory, JSON.stringify({ ...valid(), launch: { ...valid().launch, workerArguments: [1] } }));
    expect(readWorkerRecovery(directory)).toBeUndefined();
  });
  it("refuses an oversized file without parsing it", () => {
    const directory = runDirectory();
    write(directory, JSON.stringify(valid()) + " ".repeat(WORKER_RECOVERY_MAX_BYTES));
    expect(readWorkerRecovery(directory)).toBeUndefined();
  });
  it("rejects a record whose id does not name its run directory or its launch", () => {
    const directory = runDirectory();
    const other = "e".repeat(32);
    write(directory, JSON.stringify({ ...valid(), id: other, launch: { ...valid().launch, id: other } }));
    expect(readWorkerRecovery(directory)).toBeUndefined();
    write(directory, JSON.stringify({ ...valid(), launch: { ...valid().launch, id: other } }));
    expect(readWorkerRecovery(directory)).toBeUndefined();
  });
});

describe("adoptedWorkerHandle", () => {
  const id = "a".repeat(32);
  it("does not signal a PID whose command line no longer carries the run id", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await adoptedWorkerHandle(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${"c".repeat(32)}`,
    }).stop();
    expect(kill).not.toHaveBeenCalled();
  });
  it("signals the worker's process group while the command line still matches", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    await adoptedWorkerHandle(4242, id, {
      signal: () => "exists",
      commandLine: () => `/usr/bin/node /x/worker.js --id ${id}`,
    }).stop();
    expect(kill).toHaveBeenCalledWith(process.platform === "win32" ? 4242 : -4242, "SIGTERM");
  });
});
