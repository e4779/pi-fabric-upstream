import fs from "node:fs";
import path from "node:path";
import {
  type OwnerIdentity,
  ownerHeartbeatFields,
  ownerIdentityFields,
  ownerLiveness,
  recordOwnerLiveness,
  writeJsonAtomic,
} from "../core/atomic-write.js";
import { ownedStat, processAlive } from "./scratch.js";

export const FABRIC_RUN_ROOT_PREFIX = "pi-fabric-runs-";
const RUN_ROOT_OWNER_FILE = ".fabric-owner.json";
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "timed_out"]);
/**
 * A run root is heartbeated by each retention sweep of its owner, every 15
 * minutes (`RETENTION_SWEEP_INTERVAL_MS` in agents/manager.ts). Across PID
 * namespaces a signal probe means nothing, so three missed sweeps prove the
 * owner dead.
 */
export const RUN_ROOT_HEARTBEAT_TTL_MS = 45 * 60 * 1_000;
interface RunRootOwner {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  // Optional owner identity (namespace-safe liveness); absent on old markers.
  identity?: Omit<OwnerIdentity, "pid">;
  orphanedAt?: number;
  closedAt?: number;
  childrenStopped?: boolean;
}
interface RunRecordSummary {
  status?: string;
  actorId?: string;
  finishedAt?: number;
  updatedAt?: number;
  transport?: string;
  sessionId?: string;
}
export interface RetentionSweepResult {
  removedRoots: string[];
  removedRuns: string[];
}
const ownerPath = (root: string): string => path.join(root, RUN_ROOT_OWNER_FILE);
const readJson = <T>(file: string): T | undefined => {
  try {
    const stat = ownedStat(file);
    if (!stat?.isFile() || stat.size > 1024 * 1024) return;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch { return; }
};
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validOwner = (owner: RunRootOwner | undefined): owner is RunRootOwner => !!owner &&
  Number.isSafeInteger(owner.pid) && owner.pid > 0 && time(owner.startedAt) && time(owner.heartbeatAt) &&
  (owner.closedAt === undefined || time(owner.closedAt)) &&
  (owner.orphanedAt === undefined || time(owner.orphanedAt)) &&
  (owner.childrenStopped === undefined || typeof owner.childrenStopped === "boolean");
const writeOwner = (root: string, owner: RunRootOwner): void => {
  if (fs.existsSync(root) && !ownedStat(root)?.isDirectory()) throw new Error("Unsafe Fabric run root");
  const file = ownerPath(root);
  if (fs.existsSync(file)) {
    const existing = readJson<RunRootOwner>(file);
    if (!validOwner(existing) || existing.pid !== owner.pid) throw new Error("Unsafe Fabric run owner marker");
  }
  writeJsonAtomic(file, owner);
};
export const markRunRootActive = (root: string, now = Date.now()): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, { pid: process.pid, startedAt: validOwner(existing) ? existing.startedAt : now, ...ownerHeartbeatFields(now) });
};
export const heartbeatRunRoot = markRunRootActive;
export const markRunRootClosed = (root: string, now = Date.now(), childrenStopped = false): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, { pid: process.pid, startedAt: validOwner(existing) ? existing.startedAt : now, ...ownerHeartbeatFields(now), closedAt: now, childrenStopped });
};
// Identity-less (old) markers keep the plain signal probe. Uncertainty is not death.
const ownerAlive = (owner: RunRootOwner, now: number): boolean =>
  recordOwnerLiveness(owner, {
    heartbeatTtlMs: RUN_ROOT_HEARTBEAT_TTL_MS,
    legacyAlive: processAlive,
    probes: { now: () => now },
  }) !== "dead";
// A process-transport child lives in its owner's namespace; its start time is
// unrecorded. Without an owner identity, keep the plain signal probe.
const childAlive = (owner: RunRootOwner | undefined, pid: number): boolean => {
  const identity = ownerIdentityFields(owner?.identity);
  if (!identity) return processAlive(pid);
  const { startedAt: _startedAt, ...place } = identity;
  return ownerLiveness({ ...place, pid }, { legacyAlive: processAlive }) !== "dead";
};
const recordAgeReference = (record: RunRecordSummary, fallback: number): number =>
  time(record.finishedAt) ? record.finishedAt : time(record.updatedAt) ? record.updatedAt : fallback;
const runFiles = new Set(["task.txt", "status.json", "events.jsonl", "lifecycle.jsonl", "steer.jsonl", "schema.json", "images.json"]);
/** node:crypto randomUUID(): lowercase, version 4, variant 10xx. */
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** pi-ai uuidv7(), which Pi's SessionManager uses for session ids: lowercase, version 7, variant 10xx. */
const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** process.pid: positive and unpadded. */
const PID = "[1-9]\\d*";
/**
 * Files writeForkSession (src/agents/handoff.ts) and Pi create in `<run>/fork-session/`:
 * materializeBranch's `handoff-<randomUUID>.jsonl`, appended to in place, and the
 * `<timestamp>_<uuidv7>.jsonl` SessionManager.createBranchedSession writes beside it when a child
 * extension forks the session. The timestamp is `new Date().toISOString()` with `:` and `.` turned into `-`
 * (pi-coding-agent dist/core/session-manager.js: `timestamp.replace(/[:.]/g, "-")`, `${fileTimestamp}_${newSessionId}.jsonl`).
 */
const HANDOFF_FILE = new RegExp(`^handoff-${UUID_V4}\\.jsonl$`);
const PI_BRANCH_FILE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z_${UUID_V7}\\.jsonl$`);
/** The name part must be a real instant: map it back to an ISO string and require Date to reproduce it exactly (rejects 2026-02-30 and month 99). */
const piBranchFile = (name: string): boolean => {
  const match = PI_BRANCH_FILE.exec(name);
  if (!match) return false;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const instant = new Date(iso);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === iso;
};
const forkSessionFile = (name: string): boolean => HANDOFF_FILE.test(name) || piBranchFile(name);
/**
 * A crash between a record's temp write and its rename leaves a temp file beside it, named by the writer:
 * the worker's writeRunRecord (src/worker/run-record.ts) `status.json.<pid>.tmp`, and writeFileAtomic
 * (src/core/atomic-write.ts, used for status.json by the manager and HostedRun) `status.json.<pid>.<randomUUID>.tmp`.
 */
const STATUS_TEMP_FILE = new RegExp(`^status\\.json\\.${PID}(?:\\.${UUID_V4})?\\.tmp$`);
/** src/worker.ts failOversizedEvent saves the first characters of an oversized event line here. */
const OVERSIZED_EVENT_FILE = "oversized-event-prefix.txt";
const DURABLE_KEY = /^(?:initial|[0-9a-f]{64})$/;
const DURABLE_LEASE_FILES = new Set(["lease.sqlite", "lease.sqlite-journal"]);
const DURABLE_STORE_FILE = /^(?:main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl(?:\.reclaim)?$/;
/** src/durable/agent.ts fabricJournalPath: the first 32 hex digits of a sha256, as `.jsonl`. */
const FABRIC_JOURNAL_FILE = /^[0-9a-f]{32}\.jsonl$/;
const onlyOwnedFiles = (directory: string, allowed: (name: string) => boolean): boolean =>
  fs.readdirSync(directory).every((name) => allowed(name) && ownedStat(path.join(directory, name))?.isFile() === true);
const DURABLE_SESSION_FILE = "session.jsonl";
const DURABLE_SESSION_TEMP = /^tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/;
/** A file an extension keeps beside the session file, such as `session.jsonl.acp.json`. */
const DURABLE_SESSION_SIDECAR = /^session\.jsonl\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * A pi-durable worker's private session folder (src/durable/worker-role-seed.ts):
 * only `session.jsonl` and the `tmp-<uuid v4>.jsonl` names the worker writes,
 * each a regular file owned by this user. A file with two names is accepted only
 * as the crash leftover between the worker's link and unlink: the folder holds
 * exactly `session.jsonl` and one temp name sharing device and inode. A link that
 * leaves the folder, an unknown name, a symlink or another owner keeps the run.
 * A `session.jsonl.<suffix>` sidecar is accepted only as an owned regular file with one name.
 */
const safeDurableSessionFolder = (directory: string): boolean => {
  const uid = process.getuid?.();
  const stats = new Map<string, fs.Stats>();
  for (const name of fs.readdirSync(directory)) {
    if (DURABLE_SESSION_SIDECAR.test(name)) {
      const sidecar = fs.lstatSync(path.join(directory, name));
      if (!sidecar.isFile() || (uid !== undefined && sidecar.uid !== uid) || sidecar.nlink !== 1) return false;
      continue;
    }
    if (name !== DURABLE_SESSION_FILE && !DURABLE_SESSION_TEMP.test(name)) return false;
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || stat.nlink > 2) return false;
    stats.set(name, stat);
  }
  const linked = [...stats.entries()].filter(([, stat]) => stat.nlink !== 1);
  if (linked.length === 0) return true;
  const session = stats.get(DURABLE_SESSION_FILE);
  const temporaries = [...stats.entries()].filter(([name]) => name !== DURABLE_SESSION_FILE);
  const [temporary] = temporaries;
  return stats.size === 2 && session !== undefined && temporaries.length === 1 && temporary !== undefined &&
    session.nlink === 2 && temporary[1].nlink === 2 && session.dev === temporary[1].dev && session.ino === temporary[1].ino;
};
/**
 * The pi-durable runner's journal: `durable/<initial|sha256>/{lease.sqlite,store/*.jsonl}`,
 * exactly as src/durable/storage.ts creates it, plus the fabric_exec crash journals in
 * `fabric-journal/` (src/durable/worker-host.ts). The run's status and child liveness
 * still decide removal; this only stops Fabric's own journal from vetoing it.
 */
const safeDurableTree = (directory: string): boolean => fs.readdirSync(directory).every((key) => {
  const conversation = path.join(directory, key);
  if (!DURABLE_KEY.test(key) || !ownedStat(conversation)?.isDirectory()) return false;
  return fs.readdirSync(conversation).every((name) => {
    const file = path.join(conversation, name);
    if (name === "store") return ownedStat(file)?.isDirectory() === true && onlyOwnedFiles(file, (child) => DURABLE_STORE_FILE.test(child));
    if (name === "fabric-journal") return ownedStat(file)?.isDirectory() === true && onlyOwnedFiles(file, (child) => FABRIC_JOURNAL_FILE.test(child));
    return DURABLE_LEASE_FILES.has(name) && ownedStat(file)?.isFile() === true;
  });
});
/**
 * Owned regular files and directories only: no links, no hard-linked files, no hosted-run locator.
 * Removing such a tree deletes nothing outside it.
 */
const ownedTree = (directory: string, depth: number): boolean => {
  if (depth > 32) return false;
  return fs.readdirSync(directory).every((name) => {
    const stat = ownedStat(path.join(directory, name));
    if (!stat || name.startsWith("hosted.json")) return false;
    return stat.isFile() || (stat.isDirectory() && ownedTree(path.join(directory, name), depth + 1));
  });
};
/**
 * Unknown transports and live descendants veto removal, even under a dead host.
 * `anyContents` is for a root whose owner is dead and past its orphan grace: nothing will
 * read the run's files again, so files Fabric does not know (written by the durable worker,
 * its session, or another extension) no longer veto, provided they are owned and unlinked.
 * The run record, live children and hosted-run locators still decide.
 */
const safeRunTree = (root: string, childrenStopped: boolean, owner?: RunRootOwner, depth = 0, anyContents = false): boolean => {
  if (depth > 32 || !ownedStat(root)?.isDirectory()) return false;
  const record = readJson<RunRecordSummary>(path.join(root, "status.json"));
  const pid = record?.transport === "process" && typeof record.sessionId === "string" && /^\d+$/.test(record.sessionId)
    ? Number(record.sessionId) : undefined;
  if (pid !== undefined && childAlive(owner, pid)) return false;
  const terminal = !!record?.status && TERMINAL_STATUSES.has(record.status);
  if (!terminal) {
    if (!childrenStopped && pid === undefined) return false;
    if (!ownedStat(path.join(root, "task.txt"))?.isFile()) return false;
  }
  try {
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name);
      const stat = ownedStat(file);
      if (!stat) return false;
      if (stat.isFile() && (runFiles.has(name) || name === OVERSIZED_EVENT_FILE || STATUS_TEMP_FILE.test(name))) continue;
      if (anyContents && name !== "nested" && !name.startsWith("hosted.json")) {
        if (stat.isFile() || (stat.isDirectory() && ownedTree(file, depth + 1))) continue;
        return false;
      }
      // hosted.json and its temp files are deliberately not accepted: no record proves the remote work stopped,
      // so a run holding a hosted-run locator is always kept.
      if (stat.isDirectory() && name === "fork-session") {
        // Exclusively populated by writeForkSession: owned regular files of its one name shape.
        if (!onlyOwnedFiles(file, (child) => forkSessionFile(child))) return false;
        continue;
      }
      if (stat.isDirectory() && name === "handoff-session") {
        // This directory is exclusively populated by Fabric's session fork writer.
        if (fs.readdirSync(file).some((child) => !child.endsWith(".jsonl") || !ownedStat(path.join(file, child))?.isFile())) return false;
        continue;
      }
      if (stat.isDirectory() && name === "durable-session") {
        // The pi-durable worker's private Pi session file (src/worker.ts).
        if (!safeDurableSessionFolder(file)) return false;
        continue;
      }
      if (stat.isDirectory() && name === "durable") {
        if (!safeDurableTree(file)) return false;
        continue;
      }
      if (stat.isDirectory() && name === "nested") {
        for (const child of fs.readdirSync(file)) if (!safeRunTree(path.join(file, child), false, owner, depth + 1, anyContents)) return false;
        continue;
      }
      return false;
    }
    return true;
  } catch { return false; }
};
const safeRootContents = (root: string, childrenStopped: boolean, owner?: RunRootOwner, anyContents = false): boolean => {
  try { return fs.readdirSync(root).every((name) => name === RUN_ROOT_OWNER_FILE || safeRunTree(path.join(root, name), childrenStopped, owner, 0, anyContents)); }
  catch { return false; }
};
export const canRemoveManagedRunRoot = (root: string): boolean => {
  if (!ownedStat(root)?.isDirectory()) return false;
  const owner = readJson<RunRootOwner>(ownerPath(root));
  return validOwner(owner) && owner.pid === process.pid && safeRootContents(root, true, owner);
};
export const removeEmptyRunRoot = (root: string): boolean => {
  try {
    if (!ownedStat(root)?.isDirectory() || !validOwner(readJson<RunRootOwner>(ownerPath(root)))) return false;
    if (fs.readdirSync(root).some((name) => name !== RUN_ROOT_OWNER_FILE)) return false;
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch { return false; }
};
const pruneClosedRunRoot = (root: string, owner: RunRootOwner, orphanMs: number, oneShotMs: number, now: number): string[] => {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (!safeRunTree(directory, owner.childrenStopped === true, owner)) continue;
    const record = readJson<RunRecordSummary>(path.join(directory, "status.json"));
    const terminal = !!record?.status && TERMINAL_STATUSES.has(record.status);
    const reference = terminal ? recordAgeReference(record!, ownedStat(directory)?.mtimeMs ?? now) : owner.closedAt!;
    const retention = terminal && !record?.actorId ? oneShotMs : orphanMs;
    if (now - reference < retention) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch {}
  }
  return removed;
};
export const sweepTempRunRoots = (options: {
  tempRoot: string;
  currentRoot?: string;
  orphanedTempRunRetentionMs: number;
  oneShotRunRetentionMs: number;
  now?: number;
}): RetentionSweepResult => {
  const now = options.now ?? Date.now();
  const result: RetentionSweepResult = { removedRoots: [], removedRuns: [] };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(options.tempRoot, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^pi-fabric-runs-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const root = path.join(options.tempRoot, entry.name);
    if (options.currentRoot && path.resolve(root) === path.resolve(options.currentRoot)) continue;
    if (!ownedStat(root)?.isDirectory()) continue;
    const owner = readJson<RunRootOwner>(ownerPath(root));
    if (!validOwner(owner)) continue;
    if (owner.closedAt !== undefined) {
      result.removedRuns.push(...pruneClosedRunRoot(root, owner, options.orphanedTempRunRetentionMs, options.oneShotRunRetentionMs, now));
      if (removeEmptyRunRoot(root)) result.removedRoots.push(root);
      continue;
    }
    if (ownerAlive(owner, now)) continue;
    if (owner.orphanedAt === undefined) {
      try { writeOwner(root, { ...owner, orphanedAt: now }); } catch {}
      continue;
    }
    if (now - owner.orphanedAt < options.orphanedTempRunRetentionMs || !safeRootContents(root, false, owner, true)) continue;
    try { fs.rmSync(root, { recursive: true, force: true }); result.removedRoots.push(root); } catch {}
  }
  return result;
};

export const pruneActorRunArchives = (options: {
  runsDirectory: string;
  latestRunId?: string;
  retentionMs: number;
  now?: number;
}): string[] => {
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  if (!ownedStat(options.runsDirectory)?.isDirectory()) return removed;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(options.runsDirectory, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === options.latestRunId) continue;
    const directory = path.join(options.runsDirectory, entry.name);
    const record = readJson<RunRecordSummary>(path.join(directory, "status.json"));
    if (!record?.status || !TERMINAL_STATUSES.has(record.status) || !safeRunTree(directory, false)) continue;
    if (now - recordAgeReference(record, ownedStat(directory)?.mtimeMs ?? now) < options.retentionMs) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch {}
  }
  return removed;
};
