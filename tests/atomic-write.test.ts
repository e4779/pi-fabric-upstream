import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShortLockOwner,
  reapLockByRenameClaim,
  reapStaleShortLock,
  releaseShortLock,
  sweepStaleLockClaims,
  tryAcquireShortLock,
} from "../src/core/atomic-write.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const lockIn = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-atomic-write-"));
  roots.push(root);
  return path.join(root, "store.lock");
};

const claims = (lock: string): string[] =>
  fs.readdirSync(path.dirname(lock)).filter((name) => name.startsWith(`${path.basename(lock)}.reap-`));

const owner = (directory: string): string => fs.readFileSync(path.join(directory, "owner"), "utf8");

describe("short-lock rename-claim", () => {
  it("rename-claim: an owner that releases while a reaper holds its lock does not resurrect it", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    let verified = 0;
    const removed = reapLockByRenameClaim(lock, (claimed) => {
      // A failed rename-back verifies again; the claim is gone by then.
      if (verified++ > 0) return fs.existsSync(claimed);
      // The reaper verifies; the owner's critical section ends meanwhile.
      expect(fs.existsSync(lock)).toBe(false);
      expect(owner(claimed).startsWith("held\n")).toBe(true);
      expect(releaseShortLock(lock, "held")).toBe(true);
      // A live owner: the reaper renames the claim back.
      return false;
    });
    expect(removed).toBe(false);
    expect(verified).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
    expect(claims(lock)).toEqual([]);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("next"))).toBe(true);
  });

  it("rename-claim: a still-held lock is renamed back and later released", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const readdirSync = fs.readdirSync;
    let claim: string | undefined;
    // The reaper's rename-back lands after the release first looked at the
    // lock path and while it scans for claims.
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(((directory: fs.PathLike, options?: unknown) => {
      if (claim) fs.renameSync(claim, lock);
      return readdirSync(directory, options as BufferEncoding);
    }) as typeof fs.readdirSync);
    claim = `${lock}.reap-1-t${Date.now()}-00000000-0000-4000-8000-000000000000`;
    fs.renameSync(lock, claim);
    expect(releaseShortLock(lock, "held")).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(claims(lock)).toEqual([]);
  });

  it("rename-claim: an owner releases its lock from a claim a failed rename-back left behind", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const intruder = formatShortLockOwner("intruder");
    let verified = 0;
    reapLockByRenameClaim(lock, () => {
      if (verified++ > 0) return false;
      // A legacy client does not honor claim barriers and can still occupy
      // the canonical path. Upgraded acquisition must refuse this window.
      expect(tryAcquireShortLock(lock, intruder)).toBe(false);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), intruder);
      return false;
    });
    expect(claims(lock)).toHaveLength(1);
    expect(releaseShortLock(lock, "held")).toBe(true);
    expect(claims(lock)).toEqual([]);
    expect(owner(lock)).toBe(intruder);
  });

  it("rename-claim: stale claim dirs are swept without touching the lock", () => {
    const lock = lockIn();
    expect(tryAcquireShortLock(lock, formatShortLockOwner("held"))).toBe(true);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const dated = `${lock}.reap-7-t${Date.now() - 60_000}-${uuid}`;
    const legacy = `${lock}.reap-7-${uuid}`;
    const fresh = `${lock}.reap-8-t${Date.now()}-${uuid}`;
    for (const claim of [dated, legacy, fresh]) {
      fs.mkdirSync(claim);
      fs.writeFileSync(path.join(claim, "owner"), `old\n7\n${Date.now() - 3_600_000}\n`);
    }
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(legacy, past, past);
    expect(sweepStaleLockClaims(lock, 30_000)).toBe(2);
    expect(claims(lock)).toEqual([path.basename(fresh)]);
    expect(owner(lock).startsWith("held\n")).toBe(true);
  });

  // Windows cannot rename a directory over an existing one (EPERM), so the
  // rename-back this test stages cannot happen there.
  it.skipIf(process.platform === "win32")("publish: an acquire whose directory was replaced by another owner's renamed-back lock returns false", () => {
    const lock = lockIn();
    // A's live lock sits at a reaper's claim; the reaper renames it back over
    // the empty directory the new acquirer just created.
    const held = formatShortLockOwner("held");
    const claim = `${lock}.reap-1-t${Date.now()}-00000000-0000-4000-8000-000000000000`;
    fs.mkdirSync(claim);
    fs.writeFileSync(path.join(claim, "owner"), held);
    const mkdirSync = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const created = mkdirSync(directory, options);
      fs.renameSync(claim, lock);
      return created;
    }) as typeof fs.mkdirSync);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("intruder"))).toBe(false);
    expect(owner(lock)).toBe(held);
    expect(fs.readdirSync(lock)).toEqual(["owner"]);
    expect(claims(lock)).toEqual([]);
  });

  it("rename-claim: a claim whose inode differs from the judged lock is renamed back unread", () => {
    const lock = lockIn();
    const stale = `old\n${process.pid}\n${Date.now() - 3_600_000}\n`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), stale);
    const live = formatShortLockOwner("live");
    const renameSync = fs.renameSync;
    // Between the judgment and the claim, the stale lock is reaped and A
    // re-acquires the lock path.
    vi.spyOn(fs, "renameSync").mockImplementationOnce(((source: fs.PathLike, target: fs.PathLike) => {
      renameSync(lock, path.join(path.dirname(lock), "reaped"));
      expect(tryAcquireShortLock(lock, live)).toBe(true);
      renameSync(source, target);
    }) as typeof fs.renameSync);
    const readFileSync = fs.readFileSync;
    const reads: string[] = [];
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      reads.push(String(file));
      return readFileSync(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    expect(reapStaleShortLock(lock, { staleMs: 1_000 })).toBe(false);
    expect(reads.filter((file) => file.startsWith(`${lock}.reap-`))).toEqual([]);
    expect(owner(lock)).toBe(live);
    expect(claims(lock)).toEqual([]);
  });

  it("rename-claim: release still waits for a rename-back when no blocking sleep exists", async () => {
    vi.stubGlobal("SharedArrayBuffer", undefined);
    vi.resetModules();
    const fallback = await import("../src/core/atomic-write.js");
    const lock = lockIn();
    const started = performance.now();
    expect(fallback.releaseShortLock(lock, "absent", 25)).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("rename-claim: release without a blocking sleep stops under a frozen clock", async () => {
    vi.stubGlobal("SharedArrayBuffer", undefined);
    vi.resetModules();
    const fallback = await import("../src/core/atomic-write.js");
    const lock = lockIn();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(fallback.releaseShortLock(lock, "absent", 25)).toBe(false);
  });
});
