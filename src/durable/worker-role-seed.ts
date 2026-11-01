import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Tell a Fabric-owned pi-durable child's session that it is a worker.
 *
 * A context-aware extension reads `sessionRole` from `context-aware.policy.v1` custom
 * entries on the active branch of the session record, replaying them in order
 * (a later entry wins per path). Without one it behaves as a session with a user
 * at a terminal (compaction seed sent as a user message, model rewrite, cache
 * listing, mid-reply compaction). Delegation extensions write the same entry for their
 * workers. Fabric imports neither, so the wire shape is restated here
 * as plain JSON. This module uses node:fs only: the worker process must not load
 * the Pi SDK.
 *
 * Design: create complete, never edit. Fabric writes the entry only into a
 * session file it creates, in the same write that creates the file, as the ROOT
 * of the tree (the first entry after the header, `parentId: null`). Every entry
 * Pi appends, and every branch a later navigation or fork reaches, then descends
 * from it. The worker never appends to, rewrites, or parses an existing session
 * file, and a caller-supplied session file is never written at all.
 *
 * Threat model: a process running as the same user is trusted, because it can
 * already write every session file; same-user races (swapping a folder, adding
 * a hard link between a check and a write) are out of scope. This module guards
 * against other users and accidental links: before it creates anything it
 * requires the run directory to be a real directory owned by this user, removes
 * group and other write from it, and creates the folder without following links.
 */
export const DURABLE_WORKER_POLICY_ENTRY_TYPE = "context-aware.policy.v1";
export const DURABLE_WORKER_DECLARED_BY = "pi-fabric/durable-worker";

// Pi migrates an older header and rewrites the file; a newer Pi never reads this as newer than itself.
const SESSION_HEADER_VERSION = 3;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fs.constants.O_DIRECTORY ?? 0;
/** The only temp name this module writes: lowercase UUID v4. src/storage/retention.ts accepts exactly this shape. */
const TEMP_NAME = /^tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/;

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** The one payload of the worker-role entry: plain JSON, shared by every writer. */
const workerRolePolicyData = () => ({
  schemaVersion: 1,
  layer: "host",
  declaredBy: DURABLE_WORKER_DECLARED_BY,
  values: { sessionRole: "worker" },
});

/** The one builder for the worker-role entry: plain JSON, shared by the durable-session writer and the seed writers. */
export const workerRoleEntry = (id: string, parentId: string | null, timestamp: string) => ({
  type: "custom",
  customType: DURABLE_WORKER_POLICY_ENTRY_TYPE,
  data: workerRolePolicyData(),
  id,
  parentId,
  timestamp,
});

/** The structural slice of a Pi `SessionManager` that `declareWorkerSessionRole` needs. */
export interface WorkerRoleSessionManager {
  appendCustomEntry(customType: string, data?: unknown): unknown;
  getBranch(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
}

const declaredRole = (entry: { type: string; customType?: string; data?: unknown }): unknown => {
  if (entry.type !== "custom" || entry.customType !== DURABLE_WORKER_POLICY_ENTRY_TYPE) return undefined;
  const data = entry.data as { schemaVersion?: unknown; layer?: unknown; values?: { sessionRole?: unknown } } | undefined;
  return data?.schemaVersion === 1 && data.layer === "host" ? data.values?.sessionRole : undefined;
};

/**
 * For an embedding host that owns its session: add the worker-role entry to an open
 * `SessionManager` before the first prompt. It appends, so call it on a new session if
 * the entry should be the tree root. Idempotent: returns "already-seeded" when an entry
 * on the active branch most recently declares the worker role, and "seeded" after writing one.
 */
export const declareWorkerSessionRole = (sessionManager: WorkerRoleSessionManager): "seeded" | "already-seeded" => {
  const roles = sessionManager.getBranch().map(declaredRole).filter(role => role !== undefined);
  if (roles.at(-1) === "worker") return "already-seeded";
  sessionManager.appendCustomEntry(DURABLE_WORKER_POLICY_ENTRY_TYPE, workerRolePolicyData());
  return "seeded";
};

/** An entry id Pi would accept (8 hex characters) that no existing entry uses. */
export const freshEntryId = (taken: ReadonlySet<string>): string => {
  let id = randomUUID().slice(0, 8);
  while (taken.has(id)) id = randomUUID().slice(0, 8);
  return id;
};

const sessionHeader = (cwd: string, timestamp: string) => ({
  type: "session", version: SESSION_HEADER_VERSION, id: randomUUID(), timestamp, cwd,
});

const jsonLines = (lines: readonly unknown[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

/** A real directory (never a link) owned by this user, or an error before anything is written. */
const assertPrivateDirectory = (directory: string, label: string): fs.Stats => {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a link: ${directory}`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} is not owned by this user: ${directory}`);
  return stat;
};

/**
 * The run directory must be a real directory (not a link) owned by this user, or
 * the launch fails before anything is written. If group or others can write it
 * (mode & 0o022), tighten it through a descriptor opened without following links
 * and verified to be the directory just checked. The manager creates it 0700, but
 * a run directory from an earlier Fabric or a test harness may not be. After
 * tightening no other user can add or swap entries; anything already inside is
 * refused by the owner and link checks on durable-session and by
 * O_EXCL | O_NOFOLLOW on the temp file.
 */
const securePrivateRunDirectory = (runDirectory: string): void => {
  const stat = assertPrivateDirectory(runDirectory, "Run directory");
  if (process.platform === "win32" || (stat.mode & 0o022) === 0) return;
  const fd = fs.openSync(runDirectory, fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    const uid = currentUid();
    if (!opened.isDirectory() || opened.ino !== stat.ino || opened.dev !== stat.dev || (uid !== undefined && opened.uid !== uid)) {
      throw new Error(`Run directory changed while opening: ${runDirectory}`);
    }
    fs.fchmodSync(fd, (opened.mode & 0o7777) & ~0o022);
    if ((fs.fstatSync(fd).mode & 0o022) !== 0) {
      throw new Error(`Run directory is still writable by group or others after tightening: ${runDirectory}`);
    }
  } finally {
    fs.closeSync(fd);
  }
};

/** Create `<run>/<name>` without following a link, or accept an existing real directory owned by this user. */
const ensureSessionFolder = (runDirectory: string, name: string): string => {
  const directory = path.join(runDirectory, name);
  try {
    fs.mkdirSync(directory, { mode: 0o700 }); // not recursive: the run directory must already exist
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = assertPrivateDirectory(directory, "Durable session folder");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    // Through a descriptor opened without following links, so a link swapped in now cannot redirect the chmod.
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error(`Durable session folder changed while opening: ${directory}`);
      }
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  }
  return directory;
};

/** A crash between link and unlink leaves the temp as a second name for session.jsonl; remove only our own temp names. */
const reclaimLeftoverTemps = (folder: string, file: string): void => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink < 2) return;
  for (const name of fs.readdirSync(folder)) {
    if (!TEMP_NAME.test(name)) continue;
    const candidate = path.join(folder, name);
    try {
      const other = fs.lstatSync(candidate);
      if (other.isFile() && other.ino === stat.ino && other.dev === stat.dev) fs.unlinkSync(candidate);
    } catch { /* another attempt removed it first */ }
  }
};

/** Validate existing files and link-race winners before returning them to Pi. */
const secureSessionFile = (folder: string, file: string): void => {
  const stat = fs.lstatSync(file);
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Session file must be a regular file: ${file}`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Session file is not owned by this user: ${file}`);
  reclaimLeftoverTemps(folder, file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || (uid !== undefined && opened.uid !== uid)) {
      throw new Error(`Session file changed while opening: ${file}`);
    }
    if (opened.nlink !== 1) throw new Error(`Session file has external hard links: ${file}`);
    if (process.platform !== "win32" && (opened.mode & 0o7777) !== 0o600) {
      fs.fchmodSync(fd, 0o600);
      if ((fs.fstatSync(fd).mode & 0o7777) !== 0o600) throw new Error(`Session file permissions could not be secured: ${file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Create the durable child's private session file, or reuse the existing one.
 *
 * Nothing is created unless the run directory is a real directory owned by this
 * user; group and other write are removed from it first. The folder is created under the existing
 * run directory without following links. A new file appears already complete (Pi
 * header, then the worker-role entry as the tree root): the content goes to
 * `tmp-<uuid>.jsonl` in the same folder (exclusive create, no link following),
 * is synced, then hard-linked to `session.jsonl`. Exactly one concurrent creator
 * wins the link; the others validate the winner's file. Existing files must be
 * regular, owned by this user and have no external hard links; their permissions
 * are tightened to 0600 if necessary, without changing their content. A crash
 * leaves at most a stray `tmp-<uuid>.jsonl`, possibly as a
 * second name for `session.jsonl`; a relaunch removes it and run retention
 * reclaims the pair with the run.
 */
export const createDurableSessionFile = (
  runDirectory: string,
  cwd: string,
  hooks: { beforeLink?: () => void } = {},
): string => {
  securePrivateRunDirectory(runDirectory);
  const folder = ensureSessionFolder(runDirectory, "durable-session");
  const file = path.join(folder, "session.jsonl");
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    secureSessionFile(folder, file);
    return file;
  }
  const timestamp = new Date().toISOString();
  const temporary = path.join(folder, `tmp-${randomUUID()}.jsonl`);
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    try {
      if (process.platform !== "win32") fs.fchmodSync(fd, 0o600); // independent of umask
      fs.writeSync(fd, jsonLines([sessionHeader(cwd, timestamp), workerRoleEntry(randomUUID().slice(0, 8), null, timestamp)]));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    hooks.beforeLink?.();
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; // another attempt created it: keep theirs
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  secureSessionFile(folder, file); // validate the winner and reclaim its leftover temp
  return file;
};
