import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { AgentTransportHandle, AgentTransportLaunch } from "./types.js";

/**
 * Opt-in reattachment of built-in `pi-durable` worker runs after the resident
 * host that launched them stops (`agents.durableWorkerRecovery`).
 *
 * The file below is an untrusted recovery hint. A host-owned receipt outside
 * the run directory must authorize its complete contents before use. An explicit
 * stop deletes it as soon as the stop is requested,
 * before Fabric signals the worker, and every other settlement deletes it
 * before the terminal record lands. A recovery file beside a worker-written
 * terminal "stopped" record therefore means the stop came from outside Fabric
 * (a reboot or logout signal), never from an operator stop.
 */
export const WORKER_RECOVERY_FILE = "worker-recovery.json";
export const WORKER_RECOVERY_FORMAT = 1;

export interface WorkerRecoveryRecord {
  format: typeof WORKER_RECOVERY_FORMAT;
  id: string;
  runner: "pi-durable";
  /** Absolute wall-clock deadline of the original launch. */
  deadlineAt: number;
  /** Process id of the current worker attempt. */
  pid: number;
  launch: AgentTransportLaunch;
  writtenAt: number;
}

const MAX_ARGUMENTS = 4_096;
const MAX_STRING = 1_048_576;
/** Larger files are refused unread: a launch is far smaller than this. */
export const WORKER_RECOVERY_MAX_BYTES = 8 * 1_048_576;

const boundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_STRING;

export const workerRecoveryPath = (runDirectory: string): string =>
  path.join(runDirectory, WORKER_RECOVERY_FILE);

export const writeWorkerRecovery = (runDirectory: string, record: WorkerRecoveryRecord): void => {
  writeJsonAtomic(workerRecoveryPath(runDirectory), record, { mode: 0o600 });
};

// A sibling of the host run root, never a child run's directory or nested
// --run-root. The host must control this directory and its parent just as it
// controls its configuration; mode 0700 is not same-UID process isolation.
export const workerRecoveryAuthorityRoot = (runRoot: string): string =>
  `${path.resolve(runRoot)}.worker-launch-authority`;

const authorityPath = (runDirectory: string): string =>
  path.join(workerRecoveryAuthorityRoot(path.dirname(runDirectory)), `${path.basename(runDirectory)}.json`);

/** Called only with an admitted in-memory launch (or its verified receipt), never a marker. */
export const authorizeWorkerRecovery = (runDirectory: string, recovery: WorkerRecoveryRecord, policy: string): void => {
  fs.mkdirSync(path.dirname(authorityPath(runDirectory)), { recursive: true, mode: 0o700 });
  writeJsonAtomic(authorityPath(runDirectory), { recovery, policy }, { mode: 0o600 });
};

export const readWorkerRecoveryAuthority = (runDirectory: string, policy?: string): WorkerRecoveryRecord | undefined => {
  const content = readBounded(authorityPath(runDirectory));
  if (!content) return undefined;
  try {
    const receipt = JSON.parse(content);
    if (policy !== undefined && receipt.policy !== policy) return undefined;
    return parseWorkerRecovery(JSON.stringify(receipt.recovery), runDirectory);
  } catch {
    return undefined;
  }
};

export const removeWorkerRecovery = (runDirectory: string): void => {
  fs.rmSync(workerRecoveryPath(runDirectory), { force: true });
  fs.rmSync(authorityPath(runDirectory), { force: true });
  // Remove an empty host receipt directory, but never another run's receipt.
  try { fs.rmdirSync(workerRecoveryAuthorityRoot(path.dirname(runDirectory))); } catch { /* not empty or already gone */ }
};

export const hasWorkerRecovery = (runDirectory: string): boolean =>
  fs.existsSync(workerRecoveryPath(runDirectory));

const readBounded = (file: string): string | undefined => {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > WORKER_RECOVERY_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

/**
 * Strict reader: copies named, validated fields; anything else is undefined.
 * The record's id must name the run directory it sits in, so a file copied
 * from another run is never read as this one.
 */
export const readWorkerRecovery = (runDirectory: string): WorkerRecoveryRecord | undefined => {
  const content = readBounded(workerRecoveryPath(runDirectory));
  if (content === undefined) return undefined;
  return parseWorkerRecovery(content, runDirectory);
};

const parseWorkerRecovery = (content: string, runDirectory: string): WorkerRecoveryRecord | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const launch = value.launch as Record<string, unknown> | undefined;
  if (
    value.format !== WORKER_RECOVERY_FORMAT ||
    !boundedString(value.id) ||
    value.id !== path.basename(runDirectory) ||
    value.runner !== "pi-durable" ||
    typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt) ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    typeof value.writtenAt !== "number" || !Number.isFinite(value.writtenAt) ||
    typeof launch !== "object" || launch === null || Array.isArray(launch) ||
    launch.id !== value.id ||
    !boundedString(launch.name) ||
    !boundedString(launch.cwd) ||
    !boundedString(launch.workerPath) ||
    !Array.isArray(launch.workerArguments) ||
    launch.workerArguments.length > MAX_ARGUMENTS ||
    launch.workerArguments.some((argument) => typeof argument !== "string" || argument.length > MAX_STRING)
  ) {
    return undefined;
  }
  return {
    format: WORKER_RECOVERY_FORMAT,
    id: value.id,
    runner: "pi-durable",
    deadlineAt: value.deadlineAt,
    pid: value.pid,
    writtenAt: value.writtenAt,
    launch: {
      id: value.id,
      name: launch.name,
      cwd: launch.cwd,
      workerPath: launch.workerPath,
      workerArguments: [...(launch.workerArguments as string[])],
    },
  };
};

/** Pairs exactly as the worker's own argument parser reads them (last wins). */
const workerArgumentMap = (args: readonly string[]): Map<string, string> | undefined => {
  if (args.length % 2 !== 0) return undefined;
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    if (!key.startsWith("--")) return undefined;
    result.set(key.slice(2), args[index + 1]!);
  }
  return result;
};

const insideDirectory = (directory: string, file: string): boolean => {
  if (!path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Why a recovery file must not be acted on by this host, or undefined when it
 * may. The file sits in the run directory, so anything that can write there
 * could otherwise point a relaunch at another program, working directory, run
 * id, or status file. Every launch field must exactly match the host-owned
 * receipt, including approved external paths and optional capabilities. The
 * launch must also use this host's worker and this run's id/cwd/status paths.
 */
export const workerRecoveryMismatch = (
  recovery: WorkerRecoveryRecord,
  expected: { runDirectory: string; workerPath: string; cwd: string; policy?: string },
): string | undefined => {
  const authority = readWorkerRecoveryAuthority(expected.runDirectory, expected.policy);
  if (!authority || !isDeepStrictEqual(authority, recovery)) return "host launch receipt";
  const { launch } = recovery;
  if (path.basename(expected.runDirectory) !== recovery.id || launch.id !== recovery.id) return "run id";
  if (path.resolve(launch.workerPath) !== path.resolve(expected.workerPath)) return "worker path";
  const args = workerArgumentMap(launch.workerArguments);
  if (!args) return "worker arguments";
  if (args.get("id") !== recovery.id) return "--id";
  if (!path.isAbsolute(launch.cwd) || launch.cwd !== expected.cwd || args.get("cwd") !== launch.cwd) return "working directory";
  const pinned: Array<[string, string | undefined]> = [
    ["status-file", path.join(expected.runDirectory, "status.json")],
    ["lifecycle-file", path.join(expected.runDirectory, "lifecycle.jsonl")],
    ["task-file", undefined],
    ["log-file", undefined],
  ];
  for (const [name, exact] of pinned) {
    const value = args.get(name);
    if (value === undefined || !insideDirectory(expected.runDirectory, value)) return `--${name}`;
    if (exact !== undefined && path.resolve(value) !== path.resolve(exact)) return `--${name}`;
  }
  return undefined;
};

export type WorkerLiveness = "alive" | "dead" | "unknown";

export interface WorkerProbes {
  /** `kill(pid, 0)`. */
  signal?: (pid: number) => "exists" | "missing" | "unknown";
  /** Full command line of `pid`, or undefined when it cannot be read. */
  commandLine?: (pid: number) => string | undefined;
}

const signalProbe = (pid: number): "exists" | "missing" | "unknown" => {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") return "missing";
    // EPERM: some other user's process holds the pid, so not our worker; but
    // the answer is not ours to trust either way.
    return "unknown";
  }
};

const commandLineProbe = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    }
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

/**
 * Whether `pid` is still this run's worker. A PID alone is not enough: after a
 * reboot or a long outage the number may belong to an unrelated process, and
 * adopting that would let a later stop signal its process group. The worker's
 * command line carries `--id <run id>`, so a live PID whose command line lacks
 * it is a reused PID and our worker is gone. Any probe Fabric cannot read is
 * "unknown": relaunching then could put two writers on one journal.
 */
export const probeWorker = (pid: number, id: string, probes: WorkerProbes = {}): WorkerLiveness => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "dead";
  const signal = (probes.signal ?? signalProbe)(pid);
  if (signal === "missing") return "dead";
  if (signal === "unknown") return "unknown";
  const commandLine = (probes.commandLine ?? commandLineProbe)(pid);
  if (commandLine === undefined) return "unknown";
  const tokens = commandLine.trim().split(/\s+/);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "--id" && tokens[index + 1] === id) return "alive";
  }
  return "dead";
};

/** Transport handle for a verified live worker the new host did not launch. */
export const adoptedWorkerHandle = (
  pid: number,
  id: string,
  probes: WorkerProbes = {},
): AgentTransportHandle => ({
  kind: "process",
  sessionId: String(pid),
  livenessPollIntervalMs: 1_000,
  isAlive: async () => probeWorker(pid, id, probes) !== "dead",
  stop: async () => {
    // Re-verify before signalling the group: never signal a reused PID.
    if (probeWorker(pid, id, probes) !== "alive") return;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },
});
