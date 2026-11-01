import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirDurable, writeFileAtomic, writeJsonAtomicAsync } from "../src/core/atomic-write.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-durability-"));
  roots.push(root);
  return root;
};
const ioError = () => Object.assign(new Error("injected EIO"), { code: "EIO" });
const parentsOf = (directory: string): string[] => {
  const parents: string[] = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const parent = path.dirname(current);
    if (parents.at(-1) !== parent) parents.push(parent);
    if (current === parent) return parents;
  }
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const syncTrace = (fail?: (name: string) => boolean) => {
  const names = new Map<number, string>();
  const flushed: string[] = [];
  const descriptors: number[] = [];
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  vi.spyOn(fs, "openSync").mockImplementation(((name: fs.PathLike, ...args: unknown[]) => {
    const fd = (open as (...args: unknown[]) => number)(name, ...args);
    names.set(fd, String(name));
    descriptors.push(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const name = names.get(fd)!;
    flushed.push(name);
    if (fail?.(name)) throw ioError();
    sync(fd);
  });
  return { flushed, descriptors };
};

describe.skipIf(process.platform === "win32")("directory durability regressions", () => {
  it("flushes the full chain even when a default-mode creator made every directory", () => {
    const leaf = path.join(tempRoot(), "a", "b", "mesh");
    mkdirDurable(leaf, 0o700, false);
    const { flushed } = syncTrace();
    mkdirDurable(leaf, 0o700, true);
    expect(flushed).toEqual(parentsOf(leaf));
  });

  it("flushes a concurrent creator's links without relying on mkdir's return value", () => {
    const root = tempRoot();
    const leaf = path.join(root, "a", "mesh");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(((name: fs.PathLike, options: fs.MakeDirectoryOptions) => {
      mkdir(name, options); // Another creator wins before our mkdir runs.
      return mkdir(name, options);
    }) as typeof fs.mkdirSync);
    const { flushed } = syncTrace();
    mkdirDurable(leaf, 0o700, true, path.join(root, "a"));
    expect(flushed).toEqual([path.join(root, "a"), root]);
  });

  it("retries all barriers after mkdir creates part of a chain and fails", () => {
    const root = tempRoot();
    const leaf = path.join(root, "a", "b", "mesh");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce((() => {
      mkdir(path.join(root, "a"));
      throw ioError();
    }) as typeof fs.mkdirSync);
    const { flushed } = syncTrace();
    expect(() => mkdirDurable(leaf, 0o700, true)).toThrow("injected EIO");
    expect(flushed).toEqual([]);
    mkdirDurable(leaf, 0o700, true);
    expect(flushed).toEqual(parentsOf(leaf));
  });

  it("does not remember a failed parent flush as durable on retry", () => {
    const root = tempRoot();
    const leaf = path.join(root, "a", "mesh");
    let fail = true;
    const { flushed, descriptors } = syncTrace((name) => fail && name === root);
    expect(() => mkdirDurable(leaf, 0o700, true)).toThrow("injected EIO");
    for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow();
    flushed.length = 0;
    fail = false;
    mkdirDurable(leaf, 0o700, true);
    expect(flushed).toEqual(parentsOf(leaf));
  });

  it("closes and removes the temp without replacing old contents on file fsync failure", () => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    fs.writeFileSync(target, "old");
    const { descriptors } = syncTrace((name) => name.endsWith(".tmp"));
    expect(() => writeFileAtomic(target, "new", { fsync: true, durabilityRoot: root })).toThrow("injected EIO");
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
    for (const fd of descriptors) expect(() => fs.fstatSync(fd)).toThrow();
  });
});

it("rejects out-of-scope or missing boundary parents before creating anything", async () => {
  const root = tempRoot();
  const leaf = path.join(root, "a", "mesh");
  expect(() => mkdirDurable(leaf, 0o700, true, path.join(root, "other"))).toThrow("must contain");
  expect(() => mkdirDurable(leaf, 0o700, true, leaf)).toThrow();
  await expect(writeJsonAtomicAsync(path.join(leaf, "value.json"), {}, {
    fsync: true, durabilityRoot: leaf,
  })).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual([]);
});

type Event = { op: "open" | "write" | "sync" | "close" | "rename"; path: string };
const asyncTrace = (fail?: (event: Event) => boolean) => {
  const events: Event[] = [];
  const handles: fs.promises.FileHandle[] = [];
  const record = (event: Event) => {
    events.push(event);
    if (fail?.(event)) throw ioError();
  };
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const name = String(args[0]);
    record({ op: "open", path: name });
    const handle = await open(...args);
    handles.push(handle);
    const write = handle.writeFile.bind(handle);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementation(async (...params) => {
      record({ op: "write", path: name });
      return write(...params);
    });
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      record({ op: "sync", path: name });
      return sync();
    });
    vi.spyOn(handle, "close").mockImplementation(async () => {
      record({ op: "close", path: name });
      return close();
    });
    return handle;
  });
  const rename = fs.promises.rename;
  vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
    record({ op: "rename", path: String(from) });
    return rename(from, to);
  });
  return { events, handles };
};

it("keeps the async default path free of explicit opens and flushes", async () => {
  const target = path.join(tempRoot(), "value.json");
  const open = vi.spyOn(fs.promises, "open");
  const sync = vi.spyOn(fs, "fsyncSync");
  await writeJsonAtomicAsync(target, { committed: true }, { space: 2, newline: true });
  expect(open).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(fs.readFileSync(target, "utf8")).toBe('{\n  "committed": true\n}\n');
});

describe.skipIf(process.platform === "win32")("async durable JSON writes", () => {
  it("awaits ancestor barriers, temp write/sync/close, rename and final directory sync", async () => {
    const root = tempRoot();
    const directory = path.join(root, "a", "mesh");
    const target = path.join(directory, "value.json");
    fs.mkdirSync(directory, { recursive: true }); // Pre-created but not known durable.
    const { events, handles } = asyncTrace();
    await writeJsonAtomicAsync(target, { committed: true }, { fsync: true, space: 2, newline: true });
    const renameIndex = events.findIndex((event) => event.op === "rename");
    const temporary = events[renameIndex]!.path;
    expect(events.filter((event) => event.op === "sync").map((event) => event.path))
      .toEqual([...parentsOf(directory), temporary, directory]);
    expect(events.slice(renameIndex - 4, renameIndex + 4)).toEqual([
      { op: "open", path: temporary }, { op: "write", path: temporary },
      { op: "sync", path: temporary }, { op: "close", path: temporary },
      { op: "rename", path: temporary }, { op: "open", path: directory },
      { op: "sync", path: directory }, { op: "close", path: directory },
    ]);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe('{\n  "committed": true\n}\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["value.json"]);
  });

  it("supports concurrent creators and stops at the explicit durable boundary", async () => {
    const root = tempRoot();
    const boundary = path.join(root, "a");
    const directory = path.join(boundary, "mesh");
    const { events } = asyncTrace();
    await Promise.all(["one", "two"].map((name) => writeJsonAtomicAsync(path.join(directory, `${name}.json`), name, {
      fsync: true, durabilityRoot: boundary,
    })));
    const flushed = events.filter((event) => event.op === "sync").map((event) => event.path);
    expect(flushed.filter((name) => name === root)).toHaveLength(2);
    expect(flushed.filter((name) => name === boundary)).toHaveLength(2);
    expect(flushed).not.toContain(path.dirname(root));
    expect(fs.readdirSync(directory).sort()).toEqual(["one.json", "two.json"]);
  });

  it.each(["write", "sync", "rename"] as const)("cleans up on temp %s failure and preserves old contents", async (stage) => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    fs.writeFileSync(target, "old");
    const { handles } = asyncTrace((event) => event.op === stage && event.path.endsWith(".tmp"));
    await expect(writeJsonAtomicAsync(target, { new: true }, {
      fsync: true, durabilityRoot: root,
    })).rejects.toThrow("injected EIO");
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("keeps the file flushed across transient rename retries", async () => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    const rename = fs.promises.rename;
    const { events } = asyncTrace();
    const attempts: string[] = [];
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      attempts.push(String(from));
      if (attempts.length === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      events.push({ op: "rename", path: String(from) });
      return rename(from, to);
    });
    await writeJsonAtomicAsync(target, 1, { fsync: true, durabilityRoot: root, renameRetryDelayMs: 0 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
    expect(events.filter((event) => event.op === "sync" && event.path.endsWith(".tmp"))).toHaveLength(1);
    expect(events.at(-1)).toEqual({ op: "close", path: root });
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
  });

  it("reports a post-rename directory failure without leaving a temp or leaking a handle", async () => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    const { handles } = asyncTrace((event) => event.op === "sync" && event.path === root);
    await expect(writeJsonAtomicAsync(target, { committed: true }, {
      fsync: true, durabilityRoot: root,
    })).rejects.toThrow("injected EIO");
    // Rename committed atomically, but durability was not acknowledged.
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ committed: true });
    expect(fs.readdirSync(root)).toEqual(["value.json"]);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("repeats the complete ancestor chain on retry after a failed async barrier", async () => {
    const root = tempRoot();
    const directory = path.join(root, "a", "mesh");
    const target = path.join(directory, "value.json");
    let fail = true;
    const { events, handles } = asyncTrace((event) => fail && event.op === "sync" && event.path === root);
    await expect(writeJsonAtomicAsync(target, 1, { fsync: true })).rejects.toThrow("injected EIO");
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    events.length = 0;
    fail = false;
    await writeJsonAtomicAsync(target, 2, { fsync: true });
    const flushed = events.filter((event) => event.op === "sync").map((event) => event.path);
    expect(flushed.slice(0, -2)).toEqual(parentsOf(directory));
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toBe(2);
  });

  it.each(["EINVAL", "EACCES"])("treats async directory %s consistently with synchronous fsync", async (code) => {
    const root = tempRoot();
    const target = path.join(root, "value.json");
    const open = fs.promises.open;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!String(args[0]).endsWith(".tmp")) throw Object.assign(new Error(code), { code });
      return open(...args);
    });
    const write = writeJsonAtomicAsync(target, 1, { fsync: true, durabilityRoot: root });
    if (code === "EINVAL") {
      await expect(write).resolves.toBeUndefined();
      expect(fs.readFileSync(target, "utf8")).toBe("1");
    } else {
      await expect(write).rejects.toThrow("EACCES");
      expect(fs.readdirSync(root)).toEqual([]);
    }
  });
});
