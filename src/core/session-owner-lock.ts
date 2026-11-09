// Cross-process single-writer guard for Pi session files. The failure it
// prevents: a second process resumes a session that is live elsewhere and
// both processes write one file. The host's SessionManager has no locking, and a boot
// veto hook does not exist upstream (the sanctioned pre-open veto is only
// `session_before_switch`), so this registry adds the missing ownership
// layer beside the file:
//
//   `${PI_FABRIC_SESSION_OWNERS_DIR | ${XDG_RUNTIME_DIR:-tmp}/pi-fabric/session-owners}/<sha256(absolute session path)>.owner`
//
// A sidecar carries one `pid=`/`session=`/`ts=` record per writer; a forced
// second writer appends its own record instead of displacing the owner.
// Liveness is `process.kill(pid, 0)` (EPERM still proves life, like
// file-lock.ts). The sidecar key hashes the full resolved path, not the
// basename: different directories legitimately reuse `<timestamp>_<uuid>.jsonl`
// names.
//
// Protocol:
//   - clean claim: write a private temp file, then `link(2)` it into place —
//     an atomic create-with-content, so a contender never observes a
//     half-written sidecar (the create-then-write window of the naive
//     O_EXCL approach);
//   - contention: read the sidecar and judge. A live foreign pid refuses the
//     open (SessionOwnerConflictError dumps every recorded owner, live and
//     dead); `force` appends our record as a visible second writer;
//   - stale (dead pids) or self (only our pid): take over. Takeover and
//     release rewrite the sidecar behind an exclusive `.claim` directory —
//     rename-claim discipline as in atomic-write.ts, so two stale-takers
//     cannot both believe they won; an abandoned claim ages out (CLAIM_STALE_MS);
//   - release removes only our own record; the sidecar is unlinked when the
//     last writer leaves, so a forced duplicate never erases the original
//     owner's registration;
//   - sweeps prune sidecars whose pids are all dead and older than the TTL.
//
// Failure policy: registry infrastructure errors throw
// SessionOwnerLockUnavailableError — callers fail OPEN with a loud warning
// (a broken lock must not kill every session); a DETECTED live owner fails
// CLOSED. `claimWorkerSessionOwnerLock` encodes that policy for worker hosts.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A sidecar whose pids are all dead is pruned once older than this. */
export const SESSION_OWNER_TTL_MS = 24 * 60 * 60 * 1000;
/** A takeover/release claim older than this belongs to a dead mutator. */
const CLAIM_STALE_MS = 10_000;
/** Registry hygiene ceiling: provably-dead sidecars beyond this are pruned. */
const REGISTRY_MAX_SIDECARS = 128;
/** Bounded retries when takeover claims collide with another mutator. */
const MAX_TAKEOVER_ATTEMPTS = 3;
const OWNER_SUFFIX = ".owner";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const messageText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Brief wait between takeover attempts so a concurrent claim holder can
// finish (same bounded-wait approach as file-lock.ts).
const sleepSync = (() => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number): void => {
      Atomics.wait(buffer, 0, 0, ms);
    };
  } catch {
    return (): void => undefined;
  }
})();

// ---- sidecar text (pure) ----------------------------------------------------

export interface SessionOwnerRecord {
  pid: number;
  /** Pi session id the writer opened, when known. */
  session?: string;
  /** ISO timestamp of the claim. */
  ts?: string;
}

export interface SessionOwnerView extends SessionOwnerRecord {
  alive: boolean;
}

export interface SessionOwnerSidecar {
  /** One record per `pid=` line, in file order (first owner first). */
  owners: SessionOwnerRecord[];
  /** True when the file has content but no parseable pid line. */
  corrupt: boolean;
}

export type SessionOwnerProbe = (pid: number) => boolean;

/** True when the pid exists: kill(pid, 0) succeeded or proved EPERM, not ESRCH. */
export const processAliveProbe: SessionOwnerProbe = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM (another user's live process) is not evidence of a dead owner.
    return errorCode(error) !== "ESRCH";
  }
};

/**
 * Parse sidecar text. Each `pid=` line opens a record; `session=`/`ts=` lines
 * attach to the most recent pid record, so a forced second writer's appended
 * lines never overwrite the original owner's fields.
 */
export const parseOwnerSidecar = (text: string): SessionOwnerSidecar => {
  const owners: SessionOwnerRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("pid=")) {
      const pid = Number(line.slice("pid=".length));
      if (Number.isInteger(pid) && pid > 0) owners.push({ pid });
      continue;
    }
    const current = owners.length > 0 ? owners[owners.length - 1] : undefined;
    if (!current) continue;
    if (line.startsWith("session=")) {
      const session = line.slice("session=".length);
      if (session.length > 0) current.session = session;
    } else if (line.startsWith("ts=") && current.ts === undefined) {
      const ts = line.slice("ts=".length);
      if (!Number.isNaN(Date.parse(ts))) current.ts = ts;
    }
  }
  return { owners, corrupt: owners.length === 0 && text.trim().length > 0 };
};

export const formatOwnerRecord = (record: SessionOwnerRecord): string =>
  `pid=${record.pid}\n`
  + (record.session !== undefined ? `session=${record.session}\n` : "")
  + (record.ts !== undefined ? `ts=${record.ts}\n` : "");

export type SessionOwnerDecision =
  | { verdict: "live"; owner: SessionOwnerRecord }
  | { verdict: "stale" }
  | { verdict: "self" };

/**
 * Judge a sidecar for a prospective opener:
 *   live  → a foreign pid is alive (refuse, or force-append);
 *   self  → only our own pid is recorded (same-process reclaim);
 *   stale → no valid pid, or every pid is dead (safe to take over).
 */
export const decideOwnerSidecar = (
  sidecar: SessionOwnerSidecar,
  ownPid: number,
  probe: SessionOwnerProbe,
): SessionOwnerDecision => {
  for (const owner of sidecar.owners) {
    if (owner.pid === ownPid) continue;
    if (probe(owner.pid)) return { verdict: "live", owner };
  }
  return sidecar.owners.some((owner) => owner.pid === ownPid)
    ? { verdict: "self" }
    : { verdict: "stale" };
};

// ---- registry layout --------------------------------------------------------

export const sessionOwnerRegistryRoot = (): string =>
  process.env.PI_FABRIC_SESSION_OWNERS_DIR
    ?? path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "pi-fabric", "session-owners");

/** Sidecar path for a session file: sha256 of the resolved absolute path. */
export const sessionOwnerSidecarPath = (sessionFile: string, registryRoot?: string): string => {
  const digest = createHash("sha256").update(path.resolve(sessionFile)).digest("hex");
  return path.join(registryRoot ?? sessionOwnerRegistryRoot(), `${digest}${OWNER_SUFFIX}`);
};

// ---- errors -----------------------------------------------------------------

/** A live writer owns the session file; the open is refused (fail closed). */
export class SessionOwnerConflictError extends Error {
  readonly sessionFile: string;
  readonly owners: SessionOwnerView[];

  constructor(sessionFile: string, owners: SessionOwnerView[]) {
    const dump = owners
      .map((owner) => `pid=${owner.pid}`
        + (owner.session !== undefined ? ` session=${owner.session}` : "")
        + (owner.ts !== undefined ? ` since=${owner.ts}` : "")
        + ` (${owner.alive ? "alive" : "dead"})`)
      .join(", ");
    super(
      `Session file ${sessionFile} already has a live writer (${dump}); `
      + "a second open would put two writers on one session file. "
      + "Refusing; pass force (PI_FABRIC_ALLOW_LIVE_SESSION=1) to open anyway.",
    );
    this.name = "SessionOwnerConflictError";
    this.sessionFile = sessionFile;
    this.owners = owners;
  }
}

/** The registry itself is unusable; callers fail open with a loud warning. */
export class SessionOwnerLockUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionOwnerLockUnavailableError";
  }
}

// ---- acquisition ------------------------------------------------------------

export interface SessionOwnerAcquireOptions {
  sessionFile: string;
  sessionId?: string;
  /** Explicit override: register as a visible second writer beside a live owner. */
  force?: boolean;
  pid?: number;
  probe?: SessionOwnerProbe;
  registryRoot?: string;
  now?: () => Date;
}

export type SessionOwnerAcquisition =
  | { status: "owner" }
  | { status: "took-over"; displaced: SessionOwnerView[] }
  | { status: "forced"; owners: SessionOwnerView[] };

const viewsOf = (sidecar: SessionOwnerSidecar, probe: SessionOwnerProbe): SessionOwnerView[] =>
  sidecar.owners.map((owner) => ({ ...owner, alive: probe(owner.pid) }));

const readSidecar = (sidecar: string): SessionOwnerSidecar => {
  try {
    return parseOwnerSidecar(fs.readFileSync(sidecar, "utf8"));
  } catch {
    // Missing or unreadable: nothing provably live; the takeover claim barrier
    // keeps two readers from both publishing over each other.
    return { owners: [], corrupt: false };
  }
};

const ensureRegistry = (registryRoot: string): void => {
  try {
    fs.mkdirSync(registryRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SessionOwnerLockUnavailableError(
      `Session owner registry ${registryRoot} is unavailable: ${messageText(error)}`,
      { cause: error },
    );
  }
};

/**
 * Atomic create-with-content: write a private temp file, then link(2) it to
 * the sidecar. Only the winner's full record can ever be observed at the
 * sidecar path; EEXIST means a contender published first.
 */
const publishSidecar = (sidecar: string, text: string, pid: number): "published" | "exists" => {
  const temporary = `${sidecar}.new-${pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    throw new SessionOwnerLockUnavailableError(
      `Cannot stage a session owner sidecar beside ${sidecar}: ${messageText(error)}`,
      { cause: error },
    );
  }
  try {
    fs.linkSync(temporary, sidecar);
    return "published";
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new SessionOwnerLockUnavailableError(
        `Cannot claim the session owner sidecar ${sidecar}: ${messageText(error)}`,
        { cause: error },
      );
    }
    return "exists";
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Staging is best effort once the link attempt is done.
    }
  }
};

/** Atomic replace behind the claim barrier (takeover, release rewrite). */
const replaceSidecar = (sidecar: string, text: string, pid: number): void => {
  const temporary = `${sidecar}.replace-${pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, sidecar);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Already moved or never staged.
    }
    throw new SessionOwnerLockUnavailableError(
      `Cannot update the session owner sidecar ${sidecar}: ${messageText(error)}`,
      { cause: error },
    );
  }
};

type ClaimResult<T> = T | "busy";

/**
 * Exclusive mutation window for an existing sidecar: an O_EXCL `.claim`
 * directory. Only one claim-aware mutator (taker-over or releaser) can hold
 * it, so stale takeovers cannot both publish and a release cannot clobber a
 * fresh owner. An abandoned claim (crashed mutator) ages out and is reaped.
 */
const withSidecarClaim = <T>(sidecar: string, now: number, action: () => T): ClaimResult<T> => {
  const claim = `${sidecar}.claim`;
  const enter = (): boolean => {
    try {
      fs.mkdirSync(claim);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new SessionOwnerLockUnavailableError(
          `Cannot claim the session owner sidecar ${sidecar}: ${messageText(error)}`,
          { cause: error },
        );
      }
      return false;
    }
  };
  if (!enter()) {
    // Fresh claims are respected; stale ones belong to dead mutators.
    try {
      const age = now - fs.statSync(claim).mtimeMs;
      if (age < CLAIM_STALE_MS) return "busy";
      fs.rmSync(claim, { recursive: true, force: true });
    } catch {
      return "busy";
    }
    if (!enter()) return "busy";
  }
  try {
    return action();
  } finally {
    try {
      fs.rmSync(claim, { recursive: true, force: true });
    } catch {
      // Left for the stale-claim reap; the barrier holds meanwhile.
    }
  }
};

/** Prune provably-dead sidecars past the registry ceiling (oldest first). */
const pruneOverflow = (registryRoot: string, probe: SessionOwnerProbe): void => {
  try {
    const entries = fs.readdirSync(registryRoot)
      .filter((name) => name.endsWith(OWNER_SUFFIX))
      .map((name) => {
        const file = path.join(registryRoot, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = entries.length - REGISTRY_MAX_SIDECARS;
    for (let index = 0; index < excess; index++) {
      const entry = entries[index];
      if (!entry) break;
      try {
        const owners = parseOwnerSidecar(fs.readFileSync(entry.file, "utf8")).owners;
        if (owners.some((owner) => probe(owner.pid))) continue;
        fs.unlinkSync(entry.file);
      } catch {
        // Best effort: a sidecar that cannot be judged stays put.
      }
    }
  } catch {
    // Registry hygiene never blocks acquisition.
  }
};

/**
 * Claim single-writer ownership of a session file. Clean claim → `owner`;
 * dead owners → `took-over` (their records are returned for reporting); a
 * live foreign owner throws SessionOwnerConflictError with the full owner
 * dump unless `force` registers this caller as a second writer.
 */
export const acquireSessionOwnerLock = (options: SessionOwnerAcquireOptions): SessionOwnerAcquisition => {
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? processAliveProbe;
  const registryRoot = options.registryRoot ?? sessionOwnerRegistryRoot();
  const now = options.now ?? ((): Date => new Date());
  const sidecar = sessionOwnerSidecarPath(options.sessionFile, registryRoot);
  ensureRegistry(registryRoot);
  const record: SessionOwnerRecord = {
    pid,
    ...(options.sessionId !== undefined ? { session: options.sessionId } : {}),
    ts: now().toISOString(),
  };
  const text = formatOwnerRecord(record);
  if (publishSidecar(sidecar, text, pid) === "published") {
    pruneOverflow(registryRoot, probe);
    return { status: "owner" };
  }
  for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(2);
    const decision = decideOwnerSidecar(readSidecar(sidecar), pid, probe);
    if (decision.verdict === "live") {
      if (options.force !== true) {
        throw new SessionOwnerConflictError(
          options.sessionFile,
          viewsOf(readSidecar(sidecar), probe),
        );
      }
      try {
        // Append-only: the original owner's registration stays intact and
        // visible; our release later removes exactly our own record.
        fs.appendFileSync(sidecar, text, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        throw new SessionOwnerLockUnavailableError(
          `Cannot register a forced second writer for ${sidecar}: ${messageText(error)}`,
          { cause: error },
        );
      }
      return { status: "forced", owners: viewsOf(readSidecar(sidecar), probe) };
    }
    // Stale or self: an exclusive takeover behind the claim barrier, so two
    // takers of a dead owner cannot both end up published.
    const outcome = withSidecarClaim(sidecar, now().getTime(), () => {
      const latest = readSidecar(sidecar);
      const recheck = decideOwnerSidecar(latest, pid, probe);
      // A forced writer may have appended while we judged; re-run the loop so
      // the live branch (refuse or force-append) decides with fresh state.
      if (recheck.verdict === "live") return undefined;
      replaceSidecar(sidecar, text, pid);
      return viewsOf(latest, probe);
    });
    if (outcome === "busy") continue;
    if (outcome === undefined) continue;
    pruneOverflow(registryRoot, probe);
    return { status: "took-over", displaced: outcome };
  }
  // Takeover contention never settles into a silent second writer: refuse
  // with whatever the registry currently shows.
  throw new SessionOwnerConflictError(options.sessionFile, viewsOf(readSidecar(sidecar), probe));
};

// ---- release and views ------------------------------------------------------

export type SessionOwnerRelease = "released" | "co-owners-remain" | "absent" | "busy";

export interface SessionOwnerReleaseOptions {
  sessionFile: string;
  pid?: number;
  registryRoot?: string;
  now?: () => number;
}

/**
 * Remove this writer's record. Never throws: cleanup is best effort, a
 * leftover record is reclaimed by the sweep once its pid dies.
 */
export const releaseSessionOwnerLock = (options: SessionOwnerReleaseOptions): SessionOwnerRelease => {
  const pid = options.pid ?? process.pid;
  const registryRoot = options.registryRoot ?? sessionOwnerRegistryRoot();
  const sidecar = sessionOwnerSidecarPath(options.sessionFile, registryRoot);
  const now = options.now ?? ((): number => Date.now());
  if (!readSidecar(sidecar).owners.some((owner) => owner.pid === pid)) return "absent";
  try {
    const outcome = withSidecarClaim(sidecar, now(), (): SessionOwnerRelease => {
      const latest = readSidecar(sidecar);
      if (!latest.owners.some((owner) => owner.pid === pid)) return "absent";
      const kept = latest.owners.filter((owner) => owner.pid !== pid);
      if (kept.length === 0) {
        fs.unlinkSync(sidecar);
        return "released";
      }
      replaceSidecar(sidecar, kept.map(formatOwnerRecord).join(""), pid);
      return "co-owners-remain";
    });
    return outcome === "busy" ? "busy" : outcome;
  } catch {
    // Infrastructure failure during cleanup: the record ages out via the sweep.
    return "busy";
  }
};

export interface SessionOwnerReadOptions {
  registryRoot?: string;
  probe?: SessionOwnerProbe;
}

/** Every recorded writer of a session file, with liveness. Empty when unknown. */
export const readSessionOwners = (
  sessionFile: string,
  options?: SessionOwnerReadOptions,
): SessionOwnerView[] => {
  const probe = options?.probe ?? processAliveProbe;
  const registryRoot = options?.registryRoot ?? sessionOwnerRegistryRoot();
  return viewsOf(readSidecar(sessionOwnerSidecarPath(sessionFile, registryRoot)), probe);
};

export interface SessionOwnerSweepOptions {
  registryRoot?: string;
  ttlMs?: number;
  probe?: SessionOwnerProbe;
  now?: () => number;
}

/**
 * Prune sidecars whose pids are ALL dead and whose last update is older than
 * the TTL. Conservative: any live pid or fresh record is always kept. Returns
 * the removed sidecar file names.
 */
export const sweepSessionOwnerRegistry = (options?: SessionOwnerSweepOptions): string[] => {
  const registryRoot = options?.registryRoot ?? sessionOwnerRegistryRoot();
  const ttlMs = options?.ttlMs ?? SESSION_OWNER_TTL_MS;
  const probe = options?.probe ?? processAliveProbe;
  const now = options?.now ?? ((): number => Date.now());
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(registryRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(OWNER_SUFFIX)) continue;
    const file = path.join(registryRoot, name);
    try {
      if (now() - fs.statSync(file).mtimeMs < ttlMs) continue;
      const owners = parseOwnerSidecar(fs.readFileSync(file, "utf8")).owners;
      if (owners.some((owner) => probe(owner.pid))) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      // Best effort: an unreadable sidecar stays for a later sweep.
    }
  }
  return removed;
};

// ---- worker policy ----------------------------------------------------------

export interface SessionOwnerClaim {
  sessionFile: string;
  release(): SessionOwnerRelease;
}

export const SESSION_OWNER_LOCK_ENV = "PI_FABRIC_SESSION_OWNER_LOCK";
export const SESSION_OWNER_FORCE_ENV = "PI_FABRIC_ALLOW_LIVE_SESSION";

/**
 * Worker-host policy for `sessions.ownerLock` (the flag reaches children as
 * PI_FABRIC_SESSION_OWNER_LOCK, inherited through spawns like the compaction
 * engine marker). Acquires the lock for the session file this worker is about
 * to open and returns the claim, or undefined when the guard is off or no
 * file is in play. A live foreign owner rethrows (fail closed: the run ends
 * with the conflict instead of becoming a silent second writer); registry
 * infrastructure failure warns on stderr and returns undefined (fail open).
 */
export const claimWorkerSessionOwnerLock = (
  sessionFile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options?: Omit<SessionOwnerAcquireOptions, "sessionFile" | "force">,
): SessionOwnerClaim | undefined => {
  if (!sessionFile || env[SESSION_OWNER_LOCK_ENV] !== "1") return undefined;
  const force = env[SESSION_OWNER_FORCE_ENV] === "1";
  try {
    acquireSessionOwnerLock({ ...(options ?? {}), sessionFile, force });
    return {
      sessionFile,
      release: (): SessionOwnerRelease =>
        releaseSessionOwnerLock({
          sessionFile,
          ...(options?.pid !== undefined ? { pid: options.pid } : {}),
          ...(options?.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
        }),
    };
  } catch (error) {
    if (error instanceof SessionOwnerConflictError) throw error;
    process.stderr.write(
      `[pi-fabric] session owner lock unavailable for ${sessionFile} `
      + `(${messageText(error)}) — continuing WITHOUT single-writer protection\n`,
    );
    return undefined;
  }
};
