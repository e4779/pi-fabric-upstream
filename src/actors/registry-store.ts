import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  writeJsonAtomic,
  formatShortLockOwner,
  reapStaleShortLock,
  releaseShortLock,
  tryAcquireShortLock,
} from "../core/atomic-write.js";
import { ActorStoreReadError, readStoreJson } from "./store-read.js";

const ACTOR_REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const ACTOR_REGISTRY_STALE_LOCK_MS = 30_000;

export type ActorRegistryRecord = Record<string, unknown> & { id: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isActorRegistryRecord = (entry: unknown): entry is ActorRegistryRecord =>
  isObject(entry) && typeof entry.id === "string";

/** Disk protocol shared by registry merges and fenced lineage adoption. */
export class ActorRegistryStore {
  readonly #registryPath: string;
  readonly #actorRoot: string;

  constructor(actorRoot: string) {
    this.#actorRoot = actorRoot;
    this.#registryPath = path.join(actorRoot, "actors.json");
  }

  /**
   * Every entry in actors.json, including entries without a valid identity, so
   * a rewrite can keep them. A missing file reads as empty; any other read or
   * parse failure throws ActorStoreReadError, and callers must not write.
   */
  entries(): unknown[] {
    const parsed = readStoreJson(this.#registryPath);
    if (parsed === undefined) return [];
    const actors = isObject(parsed) ? parsed.actors : undefined;
    if (!Array.isArray(actors)) {
      throw new ActorStoreReadError(this.#registryPath, "expected an object with an actors array");
    }
    return actors;
  }

  /** The entries that carry a string id. Throws like entries(). */
  records(): ActorRegistryRecord[] {
    return this.entries().filter(isActorRegistryRecord);
  }

  /** The callback must be synchronous: release precedes promise assimilation. */
  async withLock<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    const lockPath = `${this.#registryPath}.lock`;
    const deadline = Date.now() + ACTOR_REGISTRY_LOCK_TIMEOUT_MS;
    const token = randomUUID();
    const processAlive = (pid: number): boolean => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    fs.mkdirSync(this.#actorRoot, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    while (!tryAcquireShortLock(lockPath, formatShortLockOwner(token))) {
      // An ownerless or partial lock is judged by its age; a fresh one only
      // when its local owner is provably dead; any past the hold ceiling has
      // leaked. Removal is a rename claim, so a lock a new owner took survives.
      if (reapStaleShortLock(lockPath, { staleMs: ACTOR_REGISTRY_STALE_LOCK_MS, legacyAlive: processAlive })) continue;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Fabric actor registry lock");
      }
      await delay(10, undefined, { signal });
      signal?.throwIfAborted();
    }
    try {
      signal?.throwIfAborted();
      return operation();
    } finally {
      // Also takes the lock back from a reaper's claim path.
      releaseShortLock(lockPath, token);
    }
  }

  fingerprint(): string | undefined {
    try {
      const stat = fs.statSync(this.#registryPath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  read(): unknown {
    return JSON.parse(fs.readFileSync(this.#registryPath, "utf8"));
  }

  /** Call within withLock for read-modify-write operations. */
  write(actors: readonly unknown[]): void {
    writeJsonAtomic(this.#registryPath, { format: 1, actors }, { space: 2 });
  }
}
