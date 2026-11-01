import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity, type MeshStoreOptions } from "../src/mesh/store.js";
import { captureStorageDelete, captureStoragePut } from "../src/verified/storage.js";
import { storageTransition } from "../src/verified/generated/storage.js";

const identity: MeshIdentity = { id: "storage:test", name: "test", kind: "main" };
const roots: string[] = [];
const createStore = (options?: MeshStoreOptions, maxEventBytes = 1024): MeshStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-storage-"));
  roots.push(root);
  return new MeshStore(root, maxEventBytes, 100, options);
};
const statePath = (store: MeshStore): string => path.join(store.root, "state.json");
const bytes = (store: MeshStore): string => fs.readFileSync(statePath(store), "utf8");
const hold = (store: MeshStore): (() => void) => {
  const lock = path.join(store.root, ".lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner"), `test\n${process.pid}\n${Date.now()}\n`);
  return () => fs.rmSync(lock, { force: true, recursive: true });
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("compiled production storage reducer", () => {
  const PLANS = ["Conflict", "Exhausted", "Unchanged", "PutNext", "DeleteNext"];
  // Interned ids as the bridge assigns them: unequal, so swapped fields show.
  const key = 1, value = 2, actor = 3;
  type Change = "put" | "delete";
  const run = (present: boolean, version: number, highWater: number, expected: number | undefined, change: Change) => {
    const out = storageTransition.step({}, storageTransition.init({}), {
      key, any: expected === undefined ? 1 : 0, expected: expected ?? 0, put: change === "put" ? 1 : 0,
      value: change === "put" ? value : 0, identity: change === "put" ? actor : 0,
      present: present ? 1 : 0, version, highWater,
    }).scalars;
    const plan = PLANS[out["out.plan"]!];
    if (plan === "PutNext") return { plan, key: out["out.key"], value: out["out.value"], identity: out["out.identity"], version: out["out.version"], highWater: out["out.highWater"] };
    if (plan === "DeleteNext") return { plan, key: out["out.key"], version: out["out.version"], highWater: out["out.highWater"] };
    return { plan };
  };

  it("distinguishes CAS, presence, payload and clock fields at the generated ABI", () => {
    // storage_* laws quantify over all requests and slots. Unequal key/clock
    // values catch swapped ABI fields without reimplementing the decision tree.
    const live = { plan: "PutNext", key, value, identity: actor, version: 4, highWater: 12 };
    const fresh = { ...live, version: 12 };
    expect(run(true, 3, 11, 3, "put")).toEqual(live);
    expect(run(true, 3, 11, undefined, "put")).toEqual(live);
    expect(run(false, 0, 11, 0, "put")).toEqual(fresh);
    expect(run(false, 7, 11, 7, "put")).toEqual(fresh);
    expect(run(true, 3, 11, 3, "delete")).toEqual({ plan: "DeleteNext", key, version: 4, highWater: 12 });
    expect(run(false, 7, 11, 7, "delete")).toEqual({ plan: "Unchanged" });
    expect(run(true, 3, 11, 2, "put")).toEqual({ plan: "Conflict" });
    expect(run(true, 3, 11, 11, "put")).toEqual({ plan: "Conflict" });
    expect(run(false, 7, 11, 0, "delete")).toEqual({ plan: "Conflict" });
    expect(run(false, 0, 9007199254740991, undefined, "delete")).toEqual({ plan: "Unchanged" });
  });

  it("keeps successors exact across numeric boundaries and refuses overflow", () => {
    // Keep arithmetic probes separate from policy combinations.
    const successors = [
      [0, 1], [4294967294, 4294967295], [4294967295, 4294967296],
      [4294967296, 4294967297], [281474976710655, 281474976710656],
      [281474976710656, 281474976710657], [9007199254740990, 9007199254740991],
    ] as const;
    for (const [before, after] of successors) {
      expect(run(true, before, before, undefined, "put")).toEqual({ plan: "PutNext", key, value, identity: actor, version: after, highWater: after });
      expect(run(true, before, before, undefined, "delete")).toEqual({ plan: "DeleteNext", key, version: after, highWater: after });
    }
    for (const [version, highWater] of [[3, 9007199254740991], [9007199254740991, 4], [9007199254740991, 9007199254740991]] as const) {
      expect(run(true, version, highWater, undefined, "put")).toEqual({ plan: "Exhausted" });
      expect(run(true, version, highWater, undefined, "delete")).toEqual({ plan: "Exhausted" });
    }
    // The compiled runtime refuses revisions past 2^53 - 1 before deciding.
    for (const version of [2 ** 53, -1, 1.5]) expect(() => run(true, version, version, undefined, "put")).toThrow(RangeError);
  });

  it("uses lossless captured JSON, including NULs and lone surrogates", () => {
    const value = { text: "\u0000\ud800\udfff", nested: [1, { a: true }] };
    const actor = { ...identity, name: "\ud800\u0000" };
    const input = { key: "state/a", ifVersion: 0, value, identity: actor };
    const captured = captureStoragePut(input);
    input.key = "state/b";
    input.ifVersion = 12;
    value.nested.length = 0;
    actor.name = "changed";
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured.transition(false, 0, 0)).toEqual({
      kind: "put", key: "state/a", version: 1, highWater: 1,
      value: { text: "\u0000\ud800\udfff", nested: [1, { a: true }] },
      identity: { ...identity, name: "\ud800\u0000" },
    });
    expect(captureStorageDelete({ key: "state/a", ifVersion: Number.MAX_SAFE_INTEGER })
      .transition(false, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ kind: "unchanged" });
  });
});

describe("MeshStore uses the proved transition", () => {
  it("captures key, expected revision, nested value and identity before waiting for the lock", async () => {
    const store = createStore();
    const release = hold(store);
    const input = { key: "state/a", ifVersion: 0, value: { nested: { n: 1 } }, identity: { ...identity } };
    const pending = store.put(input);
    input.key = "state/b";
    input.ifVersion = 999;
    input.value.nested.n = 2;
    input.identity.id = "changed";
    input.identity = { ...identity, name: "replaced" };
    release();
    expect(await pending).toMatchObject({ key: "state/a", version: 1, value: { nested: { n: 1 } }, updatedBy: identity });
    expect(store.get("state/b")).toBeUndefined();
  });

  it("captures delete key and expected revision before lock wait", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    await store.put({ key: "state/b", value: 2, identity });
    const untouched = store.get("state/b");
    const release = hold(store);
    const input = { key: "state/a", ifVersion: 1 };
    const pending = store.delete(input);
    input.key = "state/b";
    input.ifVersion = 9;
    release();
    expect(await pending).toEqual({ deleted: true, version: 2 });
    expect(store.get("state/a")).toBeUndefined();
    expect(store.get("state/b")).toEqual(untouched);
  });

  it("cannot turn a waiting stale request into an unconditional write", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const before = bytes(store);
    const release = hold(store);
    const input: { key: string; value: unknown; identity: MeshIdentity; ifVersion?: number } = {
      key: "state/a", value: 2, identity, ifVersion: 0,
    };
    const pending = store.put(input);
    delete input.ifVersion;
    release();
    await expect(pending).rejects.toThrow("compare-and-swap failed");
    expect(bytes(store)).toBe(before);
  });

  it("rejects a stale delete even if its request is changed while waiting", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const before = bytes(store);
    const release = hold(store);
    const input: { key: string; ifVersion?: number } = { key: "state/a", ifVersion: 0 };
    const pending = store.delete(input);
    delete input.ifVersion;
    release();
    await expect(pending).rejects.toThrow("compare-and-swap failed");
    expect(bytes(store)).toBe(before);
  });

  it("advances deletion and refuses stale resurrection while its tombstone is retained", async () => {
    const store = createStore();
    expect(await store.delete({ key: "state/a", ifVersion: 0 })).toEqual({ deleted: false });
    const first = await store.put({ key: "state/a", value: 1, identity, ifVersion: 0 });
    const deleted = await store.delete({ key: "state/a", ifVersion: first.version });
    expect(deleted).toEqual({ deleted: true, version: 2 });
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity, ifVersion: first.version })).rejects.toThrow("compare-and-swap failed");
    await expect(store.delete({ key: "state/a", ifVersion: first.version })).rejects.toThrow("compare-and-swap failed");
    expect(await store.delete({ key: "state/a", ifVersion: deleted.version! })).toEqual({ deleted: false });
    expect(bytes(store)).toBe(before);
    expect((await store.put({ key: "state/a", value: 3, identity, ifVersion: deleted.version! })).version).toBe(3);
  });

  it("preserves allocation history across tombstone eviction, restart and recreation", async () => {
    const store = createStore({ maxStateTombstones: 1 });
    const first = await store.put({ key: "state/a", value: "old", identity });
    const deleted = await store.delete({ key: "state/a" });
    await store.put({ key: "state/b", value: true, identity });
    await store.delete({ key: "state/b" });
    expect(JSON.parse(bytes(store))).toMatchObject({ highWater: 4 });
    expect(JSON.parse(bytes(store)).versions["state/a"]).toBeUndefined();
    const restarted = new MeshStore(store.root, 1024, 100, { maxStateTombstones: 1 });
    const recreated = await restarted.put({ key: "state/a", value: "new", identity, ifVersion: 0 });
    expect(recreated.version).toBe(5);
    const before = bytes(restarted);
    for (const ifVersion of [first.version, deleted.version!]) {
      await expect(restarted.put({ key: "state/a", value: "stale", identity, ifVersion })).rejects.toThrow("compare-and-swap failed");
      await expect(restarted.delete({ key: "state/a", ifVersion })).rejects.toThrow("compare-and-swap failed");
    }
    expect(bytes(restarted)).toBe(before);
    expect(restarted.get("state/a")?.value).toBe("new");
  });

  it("permits exactly the last safe successor, then refuses put and delete without mutation", async () => {
    const store = createStore();
    await store.put({ key: "state/other", value: "unrelated", identity });
    const state = JSON.parse(bytes(store));
    state.versions["state/a"] = Number.MAX_SAFE_INTEGER - 1;
    state.highWater = Number.MAX_SAFE_INTEGER - 1;
    state.tombstoneOrder.push("state/a");
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const last = await store.put({ key: "state/a", value: "last", identity, ifVersion: Number.MAX_SAFE_INTEGER - 1 });
    expect(last.version).toBe(Number.MAX_SAFE_INTEGER);
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: "overflow", identity })).rejects.toThrow("revision exhausted");
    await expect(store.delete({ key: "state/a", ifVersion: last.version })).rejects.toThrow("revision exhausted");
    expect(bytes(store)).toBe(before);
    expect(store.get("state/a")).toEqual(last);
    expect(store.get("state/other")?.value).toBe("unrelated");
  });

  it.each([2 ** 32 - 1, 2 ** 48 - 1, 2 ** 48])("handles production successor across numeric boundary %s", async (version) => {
    const store = createStore();
    fs.writeFileSync(statePath(store), JSON.stringify({ format: 1, entries: {}, versions: { "state/a": version } }));
    expect((await store.put({ key: "state/a", value: 1, identity, ifVersion: version })).version).toBe(version + 1);
    expect(await store.delete({ key: "state/a", ifVersion: version + 1 })).toEqual({ deleted: true, version: version + 2 });
    expect(JSON.parse(bytes(store)).versions["state/a"]).toBe(version + 2);
  });

  it("allows the last safe deletion successor but refuses resurrection past the ceiling", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const state = JSON.parse(bytes(store));
    state.entries["state/a"].version = Number.MAX_SAFE_INTEGER - 1;
    state.versions["state/a"] = Number.MAX_SAFE_INTEGER - 1;
    state.highWater = Number.MAX_SAFE_INTEGER - 1;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    expect(await store.delete({ key: "state/a" })).toEqual({ deleted: true, version: Number.MAX_SAFE_INTEGER });
    const before = bytes(store);
    expect(await store.delete({ key: "state/a", ifVersion: Number.MAX_SAFE_INTEGER })).toEqual({ deleted: false });
    await expect(store.put({ key: "state/a", value: 2, identity })).rejects.toThrow("revision exhausted");
    expect(bytes(store)).toBe(before);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses malformed expected revision %s before effects", async (ifVersion) => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity, ifVersion })).rejects.toThrow("safe integer");
    await expect(store.delete({ key: "state/a", ifVersion })).rejects.toThrow("safe integer");
    expect(bytes(store)).toBe(before);
  });

  it.each([-1, 1.5, null, "1", Number.MAX_SAFE_INTEGER + 1])("does not silently reset malformed retained revision %s", async (version) => {
    const store = createStore();
    fs.writeFileSync(statePath(store), JSON.stringify({ format: 1, entries: {}, versions: { "state/a": version } }));
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity })).rejects.toThrow("safe integer");
    await expect(store.delete({ key: "state/a" })).rejects.toThrow("safe integer");
    expect(bytes(store)).toBe(before);
  });

  it("refuses inconsistent live and retained revisions instead of choosing one", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const state = JSON.parse(bytes(store));
    state.versions["state/a"] = 5;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity })).rejects.toThrow("Inconsistent");
    await expect(store.delete({ key: "state/a" })).rejects.toThrow("Inconsistent");
    expect(bytes(store)).toBe(before);
  });

  it("seeds legacy allocation history from every retained revision while preserving live +1", async () => {
    const store = createStore();
    fs.writeFileSync(statePath(store), JSON.stringify({
      format: 1,
      entries: { "state/live": { key: "state/live", value: 1, version: 7, updatedAt: 0, updatedBy: identity } },
      versions: { "state/deleted": 40 },
    }));
    const allocated = await store.put({ key: "state/new", value: 2, identity, ifVersion: 0 });
    expect(allocated.version).toBe(41);
    expect(JSON.parse(bytes(store)).highWater).toBe(41);
    expect((await store.put({ key: "state/live", value: 3, identity, ifVersion: 7 })).version).toBe(8);
    expect(JSON.parse(bytes(store)).highWater).toBe(42);
    expect(await store.delete({ key: "state/live", ifVersion: 8 })).toEqual({ deleted: true, version: 9 });
    expect(JSON.parse(bytes(store)).highWater).toBe(43);
    // Migration cannot reconstruct tokens already evicted from a legacy file.
    // From this persisted clock onward, absent allocations are strictly newer.
    expect((await store.put({ key: "state/live", value: 4, identity, ifVersion: 9 })).version).toBe(44);
  });

  it.each([-1, 1.5, null, "1", Number.MAX_SAFE_INTEGER + 1])("fails closed on malformed global high-water %s", async (highWater) => {
    const store = createStore();
    await store.put({ key: "state/other", value: "unrelated", identity });
    const state = JSON.parse(bytes(store));
    state.highWater = highWater;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const before = bytes(store);
    await expect(store.put({ key: "state/new", value: 2, identity })).rejects.toThrow("safe integer");
    await expect(store.delete({ key: "state/other" })).rejects.toThrow("safe integer");
    expect(bytes(store)).toBe(before);
  });

  it("does not reinterpret a missing clock in a current-format snapshot as legacy state", async () => {
    const store = createStore();
    await store.put({ key: "state/other", value: 1, identity });
    const state = JSON.parse(bytes(store));
    expect(state.format).toBe(1);
    expect(state.revisionFormat).toBe(2);
    delete state.highWater;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const before = bytes(store);
    await expect(store.put({ key: "state/new", value: 2, identity })).rejects.toThrow("Missing Fabric mesh high-water");
    await expect(store.delete({ key: "state/other" })).rejects.toThrow("Missing Fabric mesh high-water");
    expect(bytes(store)).toBe(before);
  });

  it("refuses a clock below retained history instead of silently reseeding it", async () => {
    const store = createStore();
    await store.put({ key: "state/other", value: 1, identity });
    const state = JSON.parse(bytes(store));
    state.highWater = 0;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const before = bytes(store);
    await expect(store.put({ key: "state/new", value: 2, identity })).rejects.toThrow("high-water");
    await expect(store.delete({ key: "state/other" })).rejects.toThrow("high-water");
    expect(bytes(store)).toBe(before);
  });

  it("clock exhaustion refuses even a small live revision without changing unrelated state", async () => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    const state = JSON.parse(bytes(store));
    state.highWater = Number.MAX_SAFE_INTEGER;
    fs.writeFileSync(statePath(store), JSON.stringify(state));
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity, ifVersion: 1 })).rejects.toThrow("revision exhausted");
    await expect(store.put({ key: "state/new", value: 2, identity, ifVersion: 0 })).rejects.toThrow("revision exhausted");
    await expect(store.delete({ key: "state/a", ifVersion: 1 })).rejects.toThrow("revision exhausted");
    expect(await store.delete({ key: "state/missing", ifVersion: 0 })).toEqual({ deleted: false });
    expect(bytes(store)).toBe(before);
  });

  it("failed writes to damaged JSON do not quarantine/reset unrelated state", async () => {
    const store = createStore();
    fs.writeFileSync(statePath(store), '{"format":1,"entries":{"unrelated":');
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity, ifVersion: 9 })).rejects.toThrow("invalid state format");
    await expect(store.delete({ key: "state/a", ifVersion: 9 })).rejects.toThrow("invalid state format");
    expect(bytes(store)).toBe(before);
    expect(fs.readdirSync(store.root)).toEqual(["state.json"]);
  });

  it("failed size admission leaves unrelated entries, tombstones and cache unchanged", async () => {
    const store = createStore({ maxStateBytes: 1024, maxStateTombstones: 1 }, 64);
    await store.put({ key: "state/old", value: 1, identity });
    await store.delete({ key: "state/old" });
    await store.put({ key: "state/a", value: 1, identity });
    const entry = store.get("state/a");
    const before = bytes(store);
    await expect(store.put({ key: "state/a", value: 2, identity: { ...identity, name: "x".repeat(2048) } })).rejects.toThrow("state exceeds");
    await expect(store.put({ key: "state/a", value: "x".repeat(65), identity })).rejects.toThrow("value exceeds");
    expect(bytes(store)).toBe(before);
    expect(store.get("state/a")).toEqual(entry);
  });

  it.each(["", "  ", "{"])("read recovery never turns damaged bytes %j into fresh allocation history", async damaged => {
    const store = createStore();
    await store.put({ key: "state/a", value: 1, identity });
    fs.writeFileSync(statePath(store), damaged);
    expect(store.listAll()).toEqual([]);
    await expect(store.put({ key: "state/a", value: 2, identity })).rejects.toThrow("invalid state format");
    expect(bytes(store)).toBe(damaged);
  });

  it.each(["toString", "valueOf", "hasOwnProperty"])("uses own-key presence and clock allocation for %s", async key => {
    const store = createStore({ maxStateTombstones: 1 });
    expect(store.get(key)).toBeUndefined();
    const first = await store.put({ key, value: 1, identity });
    await store.delete({ key });
    await store.put({ key: "other", value: 2, identity }); await store.delete({ key: "other" });
    expect(store.get(key)).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(bytes(store)).versions, key)).toBe(false);
    const next = await store.put({ key, value: 3, identity });
    expect(next.version).toBeGreaterThan(first.version);
    await expect(store.put({ key, value: 4, identity, ifVersion: first.version })).rejects.toThrow("compare-and-swap failed");
  });

  it("two actual writers using one observed revision cannot both succeed", async () => {
    const store = createStore();
    const other = new MeshStore(store.root, 1024, 100);
    await store.put({ key: "state/a", value: 1, identity });
    const release = hold(store);
    const left = store.put({ key: "state/a", value: "left", identity, ifVersion: 1 });
    const right = other.put({ key: "state/a", value: "right", identity, ifVersion: 1 });
    release();
    const results = await Promise.allSettled([left, right]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(store.get("state/a")?.version).toBe(2);
  });
});
