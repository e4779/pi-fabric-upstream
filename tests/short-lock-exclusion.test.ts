import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatShortLockOwner,
  reapStaleShortLock,
  releaseShortLock,
  sweepStaleLockClaims,
  tryAcquireShortLock,
} from "../src/core/atomic-write.js";

import { withExclusiveFileLockAsync } from "../src/core/file-lock.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const lockIn = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-exclusion-"));
  roots.push(root);
  return path.join(root, "store.lock");
};

describe("short-lock critical-section exclusion", () => {
  it.each([false, true])("R1/R2/A/B never overlap (failed restoration: %s)", (failRestore) => {
    const lock = lockIn();
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), `stale\n${process.pid}\n${Date.now() - 3_600_000}\n`);
    const active = new Set<string>();
    const overlaps: string[][] = [];
    const events: boolean[] = [];
    const enter = (token: string): boolean => {
      if (!tryAcquireShortLock(lock, formatShortLockOwner(token))) return false;
      active.add(token);
      if (active.size > 1) overlaps.push([...active]);
      return true;
    };
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce(((source: fs.PathLike, target: fs.PathLike) => {
      // R1 has judged the old inode. R2 reaps it, then A enters its CS.
      events.push(reapStaleShortLock(lock, { staleMs: 1_000 }));
      events.push(enter("A"));
      rename(source, target); // R1 mistakenly claims A's replacement inode.
      events.push(enter("B")); // A has not released!
      if (failRestore) {
        // An old client / external obstruction can still populate canonical.
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner"), formatShortLockOwner("old-client"));
      }
    }) as typeof fs.renameSync);
    expect(reapStaleShortLock(lock, { staleMs: 1_000 })).toBe(false);
    expect(overlaps).toEqual([]);
    expect(events).toEqual([true, true, false]);
    if (failRestore) {
      fs.rmSync(lock, { recursive: true });
      expect(enter("B")).toBe(false); // The stranded live claim is still a barrier.
    }
    active.delete("A");
    expect(releaseShortLock(lock, "A")).toBe(true);
    expect(enter("B")).toBe(true);
    active.delete("B");
    expect(releaseShortLock(lock, "B")).toBe(true);
  });

  it("keeps an old-dated live claim until its owner releases, without recursive reaping", () => {
    const lock = lockIn();
    const held = formatShortLockOwner("A");
    expect(tryAcquireShortLock(lock, held)).toBe(true);
    const claim = `${lock}.reap-1-t${Date.now() - 60_000}-live`;
    fs.renameSync(lock, claim);
    expect(sweepStaleLockClaims(lock, 1_000)).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(tryAcquireShortLock(lock, formatShortLockOwner(`B${i}`))).toBe(false);
      reapStaleShortLock(lock, { staleMs: 1_000 });
    }
    expect(fs.readdirSync(path.dirname(lock))).toEqual([path.basename(claim)]);
    expect(fs.readFileSync(path.join(claim, "owner"), "utf8")).toBe(held);
    expect(releaseShortLock(lock, "A")).toBe(true);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(true);
  });

  it("does not leave an immortal barrier when a live owner exceeds the hold ceiling", () => {
    const lock = lockIn();
    const claim = `${lock}.reap-1-t${Date.now() - 3_600_000}-leaked`;
    fs.mkdirSync(claim);
    const lines = formatShortLockOwner("leaked").split("\n");
    lines[2] = String(Date.now() - 3_600_000);
    fs.writeFileSync(path.join(claim, "owner"), lines.join("\n"));
    expect(sweepStaleLockClaims(lock, 1_000)).toBe(1);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(true);
  });

  it.each(["dead", "empty", "partial"])("recovers an abandoned %s claim through the bounded sweep", (kind) => {
    const lock = lockIn();
    const claim = `${lock}.reap-1-t${Date.now() - 60_000}-abandoned`;
    fs.mkdirSync(claim);
    if (kind === "dead") {
      const text = formatShortLockOwner("dead").replace(`\n${process.pid}\n`, "\n2147483647\n");
      fs.writeFileSync(path.join(claim, "owner"), text);
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === 2147483647) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return kill(pid, signal);
      }) as typeof process.kill);
    } else if (kind === "partial") {
      fs.writeFileSync(path.join(claim, "owner"), "incomplete\n");
    }
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(claim, past, past);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(false);
    expect(reapStaleShortLock(lock, { staleMs: 1_000 })).toBe(false);
    expect(fs.existsSync(claim)).toBe(false);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(true);
  });

  it("does not sweep a foreign live claim using a locally dead pid", () => {
    const lock = lockIn();
    const claim = `${lock}.reap-1-t${Date.now() - 60_000}-foreign`;
    fs.mkdirSync(claim);
    const lines = formatShortLockOwner("foreign").split("\n");
    lines[1] = "2147483647";
    lines[3] = JSON.stringify({ ...JSON.parse(lines[3]!), hostname: "other-host" });
    fs.writeFileSync(path.join(claim, "owner"), lines.join("\n"));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone locally"), { code: "ESRCH" });
    });
    expect(sweepStaleLockClaims(lock, 1_000)).toBe(0);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(false);
    expect(fs.existsSync(claim)).toBe(true);
  });

  it("serializes contending asynchronous critical sections", async () => {
    const lock = lockIn();
    let active = 0;
    let maximum = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: 12 }, () => withExclusiveFileLockAsync({
      directory: path.dirname(lock), lockName: path.basename(lock),
      timeoutMessage: "contention timed out", attempts: 200, delayMs: 1,
    }, async () => {
      maximum = Math.max(maximum, ++active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        completed++;
      } finally {
        active--;
      }
    })));
    expect(maximum).toBe(1);
    expect(completed).toBe(12);
    expect(fs.readdirSync(path.dirname(lock))).toEqual([]);
  });

  it("fails closed if the acquisition claim scan cannot be read", () => {
    const lock = lockIn();
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(tryAcquireShortLock(lock, formatShortLockOwner("A"))).toBe(false);
    expect(readdir(path.dirname(lock))).toEqual([]);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(true);
  });

  it("verifies canonical ownership after the claim scan", () => {
    const lock = lockIn();
    const claim = `${lock}.reap-1-t${Date.now()}-moved`;
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(((directory: fs.PathLike) => {
      const before = readdir(directory);
      fs.renameSync(lock, claim);
      return before;
    }) as typeof fs.readdirSync);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("A"))).toBe(false);
    expect(fs.existsSync(claim)).toBe(false);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(true);
  });

  it("publishes a complete owner atomically when hard links are unsupported", () => {
    const lock = lockIn();
    const text = formatShortLockOwner("A");
    const observed: string[] = [];
    vi.spyOn(fs, "linkSync").mockImplementation((temporary, owner) => {
      observed.push(fs.readFileSync(temporary, "utf8"));
      observed.push(String(fs.existsSync(owner)));
      throw Object.assign(new Error("unsupported"), { code: "EPERM" });
    });
    expect(tryAcquireShortLock(lock, text)).toBe(true);
    expect(observed).toEqual([text, "false"]);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(text);
    expect(fs.readdirSync(lock)).toEqual(["owner"]);
  });

  it.skipIf(process.platform === "win32")("fallback cannot overwrite an owner restored before temporary creation", () => {
    const lock = lockIn();
    const claim = `${lock}.reap-1-t${Date.now()}-held`;
    const held = formatShortLockOwner("A");
    fs.mkdirSync(claim);
    fs.writeFileSync(path.join(claim, "owner"), held);
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const result = mkdir(directory, options);
      fs.renameSync(claim, lock);
      return result;
    }) as typeof fs.mkdirSync);
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("unsupported"), { code: "EPERM" });
    });
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(false);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(held);
    expect(fs.readdirSync(lock)).toEqual(["owner"]);
  });

  it("fallback cannot publish into a replacement directory after its owner check", () => {
    const lock = lockIn();
    const held = formatShortLockOwner("A");
    const rename = fs.renameSync;
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(((source: fs.PathLike, target: fs.PathLike) => {
      rename(lock, `${lock}.reap-1-t${Date.now()}-moved`);
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), held);
      return rename(source, target);
    }) as typeof fs.renameSync);
    expect(tryAcquireShortLock(lock, formatShortLockOwner("B"))).toBe(false);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(held);
  });
});
