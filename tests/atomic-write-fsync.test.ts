import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fsyncDirectory,
  mkdirDurable,
  unsupportedDirectoryFsyncCodes,
  writeFileAtomic,
} from "../src/core/atomic-write.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-atomic-fsync-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const trackFsync = (): string[] => {
  const realOpen = fs.openSync;
  const names = new Map<number, string>();
  vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
    const descriptor = (realOpen as (...args: unknown[]) => number)(target, ...rest);
    names.set(descriptor, String(target));
    return descriptor;
  }) as typeof fs.openSync);
  // Records every fsync request before it runs. Windows opens a directory
  // but rejects flushing it with EPERM, which fsyncDirectory ignores, so the
  // request list is the same on every platform even where the flush fails.
  const flushed: string[] = [];
  const realFsync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
    flushed.push(names.get(descriptor) ?? "?");
    realFsync(descriptor);
  });
  return flushed;
};

describe("writeFileAtomic fsync", () => {
  it.skipIf(process.platform === "win32")("flushes ancestor links, the temporary file and its directory only when asked", () => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    const flushed = trackFsync();

    writeFileAtomic(target, "one");
    expect(flushed).toEqual([]);

    writeFileAtomic(target, "two", { fsync: true, durabilityRoot: root });
    expect(fs.readFileSync(target, "utf8")).toBe("two");
    expect(flushed[0]).toBe(path.dirname(root));
    expect(path.basename(flushed[1]!)).toMatch(/^value\.json\..+\.tmp$/);
    expect(flushed.slice(2)).toEqual([root]);
    // Windows does not keep POSIX permission bits.
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
  });

  it("ignores directories the platform cannot flush and rethrows other errors", () => {
    const root = tempRoot();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("not supported"), { code: "EINVAL" });
    });
    expect(() => fsyncDirectory(root)).not.toThrow();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk failed"), { code: "EIO" });
    });
    expect(() => fsyncDirectory(root)).toThrow("disk failed");
  });

  it("treats directory permission errors as unsupported only on Windows", () => {
    for (const code of ["EPERM", "EACCES"]) {
      expect(unsupportedDirectoryFsyncCodes("win32").has(code)).toBe(true);
      expect(unsupportedDirectoryFsyncCodes("linux").has(code)).toBe(false);
      expect(unsupportedDirectoryFsyncCodes("darwin").has(code)).toBe(false);
    }
    for (const code of ["EINVAL", "ENOTSUP", "EISDIR"]) {
      expect(unsupportedDirectoryFsyncCodes("linux").has(code)).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")("rethrows a POSIX permission error opening the directory", () => {
    const root = tempRoot();
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    expect(() => fsyncDirectory(root)).toThrow("permission denied");
  });

  it.skipIf(process.platform === "win32")("flushes every link in scope even when directories already exist", () => {
    const root = tempRoot();
    const leaf = path.join(root, "a", "b", "mesh");
    const flushed = trackFsync();

    mkdirDurable(leaf, 0o700, false);
    expect(flushed).toEqual([]);
    fs.rmSync(path.join(root, "a"), { recursive: true });

    mkdirDurable(leaf, 0o700, true, path.join(root, "a"));
    expect(fs.statSync(leaf).isDirectory()).toBe(true);
    expect(flushed).toEqual([path.join(root, "a", "b"), path.join(root, "a"), root]);

    flushed.length = 0;
    mkdirDurable(leaf, 0o700, true, path.join(root, "a"));
    expect(flushed).toEqual([path.join(root, "a", "b"), path.join(root, "a"), root]);
  });

  it.skipIf(process.platform === "win32")("flushes new parent directories of a durable write", () => {
    const root = tempRoot();
    const target = path.join(root, "nested", "value.json");
    const flushed = trackFsync();
    writeFileAtomic(target, "one", { fsync: true, durabilityRoot: path.join(root, "nested") });
    // mkdir flushes the new directory's parent first, then the file and its directory.
    expect(flushed[0]).toBe(root);
    expect(path.basename(flushed[1]!)).toMatch(/^value\.json\..+\.tmp$/);
    expect(flushed.slice(2)).toEqual([path.join(root, "nested")]);
  });
});
