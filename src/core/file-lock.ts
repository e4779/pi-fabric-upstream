// Cross-process exclusive lock for Fabric's durable stores (the repair
// table, the compiled entropy surface). Acquisition is a bounded retry over
// mkdir plus a post-publication claim barrier and ownership check. Stale
// recovery uses rename claims; displaced live owners keep excluding writers
// even if restoration fails (see docs/short-lock-protocol.md).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  formatShortLockOwner,
  reapStaleShortLock,
  releaseShortLock,
  tryAcquireShortLock,
} from "./atomic-write.js";

const DEFAULT_LOCK_ATTEMPTS = 50;
const DEFAULT_LOCK_DELAY_MS = 5;
const DEFAULT_STALE_LOCK_MS = 30_000;

/** Contention is retryable; permission, I/O, and operation errors are not. */
export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

export interface ExclusiveLockOptions {
  directory: string;
  lockName: string;
  /** Error message when acquisition times out. */
  timeoutMessage: string;
  staleMs?: number;
  attempts?: number;
  delayMs?: number;
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

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

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM (or an unknown probe failure) is not evidence of a dead owner.
    return errorCode(error) !== "ESRCH";
  }
};

const sleepAsync = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface LockAttempt {
  lock: string;
  token: string;
  attempts: number;
  delayMs: number;
  staleMs: number;
}

const prepare = (options: ExclusiveLockOptions): LockAttempt => ({
  lock: path.join(options.directory, options.lockName),
  token: randomUUID(),
  attempts: options.attempts ?? DEFAULT_LOCK_ATTEMPTS,
  delayMs: options.delayMs ?? DEFAULT_LOCK_DELAY_MS,
  staleMs: options.staleMs ?? DEFAULT_STALE_LOCK_MS,
});

// One acquisition attempt: take the lock, or reap a stale one (true means
// retry at once). An ownerless or partial lock is judged by its directory's
// age; a fresh one only when its local owner is provably dead; any lock past
// the hold ceiling has leaked. Reaping is a rename claim that re-verifies.
const attempt = (lock: LockAttempt): "acquired" | "reaped" | "busy" => {
  if (tryAcquireShortLock(lock.lock, formatShortLockOwner(lock.token))) return "acquired";
  return reapStaleShortLock(lock.lock, { staleMs: lock.staleMs, legacyAlive: processAlive })
    ? "reaped"
    : "busy";
};

export const withExclusiveFileLockAsync = async <T>(
  options: ExclusiveLockOptions,
  operation: () => T | Promise<T>,
): Promise<T> => {
  await fs.promises.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const lock = prepare(options);
  let acquired = false;
  for (let index = 0; index < lock.attempts; index++) {
    const outcome = attempt(lock);
    if (outcome === "acquired") {
      acquired = true;
      break;
    }
    if (outcome === "reaped") continue;
    if (index === lock.attempts - 1) break;
    await sleepAsync(lock.delayMs);
  }
  if (!acquired) throw new FileLockTimeoutError(options.timeoutMessage);
  try {
    return await operation();
  } finally {
    // Also takes the lock back from a reaper's claim path.
    releaseShortLock(lock.lock, lock.token);
  }
};

export const withExclusiveFileLock = <T>(
  options: ExclusiveLockOptions,
  operation: () => T,
): T => {
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const lock = prepare(options);
  let acquired = false;
  for (let index = 0; index < lock.attempts; index++) {
    const outcome = attempt(lock);
    if (outcome === "acquired") {
      acquired = true;
      break;
    }
    if (outcome === "reaped") continue;
    if (index === lock.attempts - 1) break;
    sleepSync(lock.delayMs);
  }
  if (!acquired) throw new FileLockTimeoutError(options.timeoutMessage);
  try {
    return operation();
  } finally {
    // Also takes the lock back from a reaper's claim path.
    releaseShortLock(lock.lock, lock.token);
  }
};
