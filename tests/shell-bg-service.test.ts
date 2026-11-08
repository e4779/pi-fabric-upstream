import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAlive, SCRATCH_OWNER_FILE, SCRATCH_SHELL_PREFIX } from "../src/storage/scratch.js";
import {
  buildShellWakeEvent,
  FabricShellJobStore,
  findShellOrphans,
  formatShellOwnershipStamp,
  formatShellWakeText,
  parseShellOwnershipStamp,
  SHELL_ORPHAN_CAP,
  SHELL_ORPHAN_TAIL_BYTES,
  SHELL_WAKE_PREAMBLE,
  SHELL_WAKE_SCHEMA_VERSION,
  type FabricShellJobEvent,
} from "../src/core/shell-jobs.js";
import { FabricProgramTasks } from "../src/core/program-tasks.js";
import { ShellEventInbox, SHELL_MESSAGE_TYPE, SHELL_SWEEP_MESSAGE_TYPE, SHELL_SWEEP_SCHEMA_VERSION } from "../src/core/shell-inbox.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

/** A pid that certainly does not exist anymore (retries until ESRCH confirms it). */
const deadPid = (): number => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid;
    if (pid !== undefined && !processAlive(pid)) return pid;
  }
  throw new Error("could not acquire a dead pid for the sweep test");
};

const liveChild = (): { pid: number; kill: () => void } => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60000)"], { stdio: "ignore" });
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  cleanups.push(kill);
  return { pid: child.pid!, kill };
};

const writeOrphanLog = (
  root: string,
  id: string,
  options: { pid?: number | "?"; session: string; cmd?: string; body?: string; ownerPid?: number; closedAt?: number; delayMs?: number },
): string => {
  const directory = path.join(root, `${SCRATCH_SHELL_PREFIX}${id}`);
  fs.mkdirSync(directory, { recursive: true });
  const body = options.body ?? "partial build output\n";
  fs.writeFileSync(path.join(directory, "output.log"), `${formatShellOwnershipStamp({ ...(options.pid !== undefined && options.pid !== "?" ? { pid: options.pid } : {}), session: options.session, command: options.cmd ?? "bun run build" })}\n${body}`);
  if (options.ownerPid !== undefined) {
    fs.writeFileSync(path.join(directory, SCRATCH_OWNER_FILE), JSON.stringify({
      app: "pi-fabric-scratch", version: 1, kind: "shell", pid: options.ownerPid, createdAt: Date.now() - 1_000,
      ...(options.closedAt !== undefined ? { closedAt: options.closedAt } : {}),
    }));
  }
  if (options.delayMs !== undefined) {
    const past = new Date(Date.now() - options.delayMs);
    fs.utimesSync(path.join(directory, "output.log"), past, past);
  }
  return path.join(directory, "output.log");
};

describe("ownership stamp", () => {
  it("round-trips the durable stamp line", () => {
    const stamp = formatShellOwnershipStamp({ pid: 41291, session: "sess-a", command: "bun  run\nbuild" });
    expect(stamp).toBe("pid 41291 session sess-a cmd bun run build");
    expect(parseShellOwnershipStamp(stamp)).toEqual({ pid: 41291, session: "sess-a", command: "bun run build" });
    expect(parseShellOwnershipStamp(formatShellOwnershipStamp({ session: "sess-a", command: "program" })))
      .toEqual({ session: "sess-a", command: "program" });
    // Legacy/foreground lines carry no stamp: ownership stays unknowable.
    expect(parseShellOwnershipStamp("[Bounded shell log: ...]")).toBeUndefined();
    expect(parseShellOwnershipStamp("")).toBeUndefined();
  });

  it("stamps a detached task's log with its pid and owning session", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-stamp-"));
    cleanups.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const jobs = new FabricShellJobStore(tempRoot);
    cleanups.push(() => void jobs.close());
    const job = jobs.begin("bash", "sleep 60", { ownerId: "sess-stamp" });
    fs.writeFileSync(job.pidPath, "41291\n");
    // The spill path resolves the pid before persisting (begin() starts readPid).
    await job.readPid();
    job.spill();
    const log = await job.persistLog();
    const firstLine = fs.readFileSync(log, "utf8").split("\n", 1)[0]!;
    expect(parseShellOwnershipStamp(firstLine)).toEqual({ pid: 41291, session: "sess-stamp", command: "sleep 60" });
    await job.finish(0);
  });
});

describe("session-scoped orphan sweep", () => {
  const root = (): string => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-sweep-"));
    cleanups.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    return tempRoot;
  };

  it("reports only this session's dead-pid logs", () => {
    const tempRoot = root();
    const pid = deadPid();
    writeOrphanLog(tempRoot, "aaaaaa", { pid, session: "mine", body: "result tail\n" });
    const orphans = findShellOrphans({ tempRoot, owner: "mine" });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ id: "aaaaaa", pid, session: "mine", command: "bun run build" });
    expect(orphans[0]!.tail).toContain("result tail");
    expect(orphans[0]!.tail.length).toBeLessThanOrEqual(SHELL_ORPHAN_TAIL_BYTES);
  });

  it("never reports foreign sessions, live pids, empty logs, or unstamped logs", () => {
    const tempRoot = root();
    const pid = deadPid();
    writeOrphanLog(tempRoot, "aaaaaa", { pid, session: "other", body: "x\n" });
    writeOrphanLog(tempRoot, "bbbbbb", { pid: liveChild().pid, session: "mine", body: "x\n" });
    writeOrphanLog(tempRoot, "cccccc", { pid, session: "mine", body: "   " });
    const legacy = path.join(tempRoot, `${SCRATCH_SHELL_PREFIX}dddddd`);
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "output.log"), "no stamp\noutput\n");
    writeOrphanLog(tempRoot, "eeeeee", { pid: "?", session: "mine", body: "x\n", ownerPid: process.pid });
    expect(findShellOrphans({ tempRoot, owner: "mine" })).toEqual([]);
    // A sessionless sweep owns nothing at all.
    expect(findShellOrphans({ tempRoot, owner: null })).toEqual([]);
    expect(findShellOrphans({ tempRoot, owner: undefined })).toEqual([]);
  });

  it("reports a pid-less (in-process) log only when its owning process died without closing it", () => {
    const tempRoot = root();
    const deadOwner = deadPid();
    writeOrphanLog(tempRoot, "aaaaaa", { pid: "?", session: "mine", body: "program output\n", ownerPid: deadOwner });
    writeOrphanLog(tempRoot, "bbbbbb", { pid: "?", session: "mine", body: "cleanly finished\n", ownerPid: deadOwner, closedAt: Date.now() });
    const orphans = findShellOrphans({ tempRoot, owner: "mine" });
    expect(orphans.map(orphan => orphan.id)).toEqual(["aaaaaa"]);
  });

  it("excludes logs a live store still tracks, newest first, capped", () => {
    const tempRoot = root();
    const pid = deadPid();
    const oldest = writeOrphanLog(tempRoot, "aaaaaa", { pid, session: "mine", body: "old\n", delayMs: 5_000 });
    writeOrphanLog(tempRoot, "bbbbbb", { pid, session: "mine", body: "new\n" });
    const all = findShellOrphans({ tempRoot, owner: "mine" });
    expect(all.map(orphan => orphan.id)).toEqual(["bbbbbb", "aaaaaa"]);
    const withoutTracked = findShellOrphans({ tempRoot, owner: "mine", exclude: new Set([oldest]) });
    expect(withoutTracked.map(orphan => orphan.id)).toEqual(["bbbbbb"]);
    for (let index = 0; index < SHELL_ORPHAN_CAP + 2; index++) {
      writeOrphanLog(tempRoot, `c${index}cccc`, { pid, session: "mine", body: `job ${index}\n`, delayMs: 10_000 - index });
    }
    expect(findShellOrphans({ tempRoot, owner: "mine" })).toHaveLength(SHELL_ORPHAN_CAP);
  });

  it("sweepOrphans hides tasks the store itself still tracks", async () => {
    const tempRoot = root();
    const jobs = new FabricShellJobStore(tempRoot);
    cleanups.push(() => void jobs.close());
    const job = jobs.begin("bash", "tracked", { ownerId: "mine" });
    fs.writeFileSync(job.pidPath, `${deadPid()}\n`);
    await job.readPid();
    job.spill();
    await job.persistLog();
    expect(jobs.sweepOrphans("mine")).toEqual([]);
    jobs.unregister(job.id);
    const orphans = jobs.sweepOrphans("mine");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.command).toBe("tracked");
    await job.finish(0);
  });
});

describe("typed wake with untrusted preamble", () => {
  it("builds the typed event and derives the text from it, preamble first", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-wake-"));
    cleanups.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const jobs = new FabricShellJobStore(tempRoot);
    cleanups.push(() => void jobs.close());
    const job = jobs.begin("bash", "watch CI", { ownerId: "sess" });
    job.spill();
    const log = await job.persistLog();
    const info = job.info();
    const running = buildShellWakeEvent(info, { output: "still building", now: info.startedAt + 90_000 });
    expect(running).toMatchObject({ schemaVersion: SHELL_WAKE_SCHEMA_VERSION, kind: "wake", id: job.id, tool: "bash", status: "spilled", seconds: 90, command: "watch CI", logPath: log, tail: "still building" });
    await job.finish(7);
    const finishedInfo = jobs.list().find(entry => entry.id === job.id)!;
    const event = buildShellWakeEvent(finishedInfo, { output: "CI failed" });
    expect(event).toMatchObject({ kind: "wake", status: "failed", exitCode: 7, tail: "CI failed" });
    expect(event.seconds).toBe(Math.max(0, Math.round(((finishedInfo.finishedAt ?? 0) - finishedInfo.startedAt) / 1000)));
    const text = formatShellWakeText(event);
    expect(text.startsWith(SHELL_WAKE_PREAMBLE)).toBe(true);
    expect(text).toContain(`Task ${job.id}: failed after ${event.seconds}s (exit 7)`);
    expect(text).toContain("Command: watch CI");
    expect(text).toContain(`Log: ${log}`);
    expect(text.endsWith("Tail:\nCI failed")).toBe(true);
    const monitorText = formatShellWakeText(buildShellWakeEvent(finishedInfo, { kind: "monitor", output: "state 3" }));
    expect(monitorText).toContain(`Task ${job.id}: monitor event after`);
  });

  it("carries typed wake events in the delivered message details", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn();
    const ctx = { hasUI: false, ui: { notify: vi.fn() }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
    const pi = { sendMessage, on: () => () => {} } as unknown as ExtensionAPI;
    const jobs = new FabricShellJobStore();
    cleanups.push(() => void jobs.close());
    const inbox = new ShellEventInbox(pi, ctx, jobs);
    cleanups.push(() => inbox.close());
    const job = jobs.begin("bash", "watch CI");
    job.spill();
    await job.finish(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]![0];
    expect(message.customType).toBe(SHELL_MESSAGE_TYPE);
    expect(message.details.ids).toEqual([job.id]);
    expect(message.details.events).toHaveLength(1);
    expect(message.details.events![0]).toMatchObject({ schemaVersion: 1, kind: "wake", id: job.id, status: "failed", exitCode: 3 });
    expect(message.content).toContain("not human input");
  });

  it("delivers an orphan sweep report with the untrusted preamble and typed records", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn();
    const ctx = { hasUI: false, ui: { notify: vi.fn() }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
    const pi = { sendMessage, on: () => () => {} } as unknown as ExtensionAPI;
    const jobs = new FabricShellJobStore();
    cleanups.push(() => void jobs.close());
    const inbox = new ShellEventInbox(pi, ctx, jobs);
    cleanups.push(() => inbox.close());
    inbox.reportOrphans([{
      id: "zzzzzz", pid: 41291, session: "mine", command: "bun run build",
      logPath: "/tmp/pi-fabric-shell-zzzzzz/output.log", tail: "final line", mtimeMs: 1,
    }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      customType: SHELL_SWEEP_MESSAGE_TYPE,
      display: false,
      details: { schemaVersion: SHELL_SWEEP_SCHEMA_VERSION, kind: "orphan-sweep", orphans: [expect.objectContaining({ id: "zzzzzz", pid: 41291 })] },
    }), { deliverAs: "steer", triggerTurn: true });
    const content = sendMessage.mock.calls[0]![0].content as string;
    expect(content.startsWith(SHELL_WAKE_PREAMBLE)).toBe(true);
    expect(content).toContain("Orphaned background task zzzzzz (pid 41291, dead)");
    expect(content).toContain("Do not restart a task without checking");
  });
});

describe("zero-action program hang race", () => {
  const tempRootFor = (): { root: string; jobs: FabricShellJobStore } => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-program-"));
    cleanups.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const jobs = new FabricShellJobStore(tempRoot);
    cleanups.push(() => void jobs.close());
    return { root: tempRoot, jobs };
  };
  const pending = (): Promise<never> => new Promise(() => {});

  it("detaches a running program past the hang threshold and returns its handle", async () => {
    vi.useFakeTimers();
    const { jobs } = tempRootFor();
    const tasks = new FabricProgramTasks();
    const events: FabricShellJobEvent[] = [];
    jobs.subscribe(event => events.push(event));
    const run = tasks.begin({ code: "await longWork()", jobs: () => jobs, ownerId: "sess-race", hangMs: 40 });
    const raced = run.race(pending());
    await vi.advanceTimersByTimeAsync(60);
    const outcome = await raced;
    expect(outcome.detached).toBe(true);
    if (!outcome.detached) throw new Error("expected the hang timer to detach the program");
    expect(outcome.reason).toBe("hang");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(40);
    const job = outcome.job;
    expect(job.spilled).toBe(true);
    expect(job.tool).toBe("fabric_exec");
    expect(jobs.get(job.id)).toBe(job);
    await vi.advanceTimersByTimeAsync(400);
    // The ownership stamp reaches the log the sweep will read after a restart.
    const log = await job.persistLog();
    expect(parseShellOwnershipStamp(fs.readFileSync(log, "utf8").split("\n", 1)[0]!))
      .toEqual({ session: "sess-race", command: "await longWork()" });
    expect(events.map(event => event.type)).toContain("spilled");
    expect(run.job).toBe(job);
  });

  it("returns the program result when it settles before the threshold", async () => {
    vi.useFakeTimers();
    const { jobs } = tempRootFor();
    const tasks = new FabricProgramTasks();
    const run = tasks.begin({ code: "return 1", jobs: () => jobs, hangMs: 5_000 });
    const outcome = await run.race(Promise.resolve("done"));
    expect(outcome).toEqual({ detached: false, value: "done" });
    expect(jobs.list()).toEqual([]);
    expect(run.job).toBeUndefined();
  });

  it("stays in the foreground without a hangMs (upstream default)", async () => {
    vi.useFakeTimers();
    const { jobs } = tempRootFor();
    const tasks = new FabricProgramTasks();
    const run = tasks.begin({ code: "await longWork()", jobs: () => jobs });
    const raced = run.race(pending());
    await vi.advanceTimersByTimeAsync(600_000);
    // Still unresolved: no timer ever fired, exactly the previous contract.
    const settled = await Promise.race([raced.then(() => true), Promise.resolve(false)]);
    expect(settled).toBe(false);
    expect(jobs.list()).toEqual([]);
  });
});

describe("store registry API for tools", () => {
  it("unregister drops tracking without stopping a live task, and prune retires finished tasks", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-api-"));
    cleanups.push(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const jobs = new FabricShellJobStore(tempRoot);
    cleanups.push(() => void jobs.close());
    const events: string[] = [];
    jobs.subscribe(event => events.push(`${event.type}:${event.job.id}`));
    const live = jobs.begin("bash", "live");
    const done = jobs.begin("bash", "done");
    await done.finish(0);
    expect(jobs.unregister(done.id)).toBe(true);
    expect(jobs.unregister(done.id)).toBe(false);
    expect(jobs.get(done.id)).toBeUndefined();
    expect(jobs.unregister(live.id)).toBe(true);
    // Unregistered: no further events reach subscribers, but the task itself is untouched.
    await live.finish(0);
    expect(events).not.toContain(`finished:${live.id}`);
    expect(live.finished).toBe(true);
    const keep = jobs.begin("bash", "keep");
    await keep.finish(0);
    expect(jobs.prune()).toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1_000);
    expect(jobs.prune()).toBe(1);
    expect(jobs.get(keep.id)).toBeUndefined();
    vi.restoreAllMocks();
  });
});
