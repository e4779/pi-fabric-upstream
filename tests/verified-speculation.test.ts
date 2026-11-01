import { afterEach, describe, expect, it, vi } from "vitest";
import { admitSpeculation, checkSpeculation, SpeculationAccounting } from "../src/verified/speculation.js";
import { speculationAdmission, speculationCheck, speculationAccounting } from "../src/verified/generated/speculation.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";

afterEach(() => vi.restoreAllMocks());
const deferred = () => { let resolve!: (value: string) => void; const promise = new Promise<string>(done => { resolve = done; }); return { promise, resolve }; };

describe("compiled speculation codec", () => {
  it("distinguishes count/limit positions, output tags, both checkpoints and backward clocks", () => {
    const admission = { ended: false, duplicate: false, entries: 2, inFlight: 1, maxEntries: 3, maxConcurrent: 2 };
    expect(admitSpeculation(admission)).toBe("admit");
    expect(admitSpeculation({ ...admission, entries: 3 })).toBe("skip");
    expect(admitSpeculation({ ...admission, inFlight: 2 })).toBe("skip");
    expect(admitSpeculation({ ...admission, duplicate: true })).toBe("skip");
    expect(admitSpeculation({ ...admission, ended: true })).toBe("ended");
    const observation = { settled: false, aborted: false, now: 105, createdAt: 100, ttl: 5, birthEpoch: 2, epoch: 2, fresh: true, failed: false };
    expect(checkSpeculation(observation)).toBe("ready");
    expect(checkSpeculation({ ...observation, now: 99 })).toBe("ready");
    expect(checkSpeculation({ ...observation, now: 106, epoch: 3 })).toBe("absent");
    expect(checkSpeculation({ ...observation, settled: true, aborted: true, now: 106 })).toBe("epoch");
    expect(checkSpeculation({ ...observation, fresh: false })).toBe("freshness");
    expect(checkSpeculation({ ...observation, settled: true, failed: true })).toBe("failed");
    expect(() => admitSpeculation({ ...admission, entries: NaN })).toThrow(RangeError);
    expect(() => checkSpeculation({ ...observation, epoch: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
  });

  it("maps every event tag to independent counters and returns detached statistics", () => {
    const ledger = new SpeculationAccounting();
    const trace = ["launched", "served", "epochInvalidated", "freshnessInvalidated", "failed", "wasted", "skipped", "bump"] as const;
    trace.forEach((event, index) => { for (let n = 0; n <= index; n++) ledger.record(event); });
    expect(ledger.stats()).toEqual({ launched: 1, served: 2, epochInvalidated: 3, freshnessInvalidated: 4, failed: 5, wasted: 6, skipped: 7 });
    expect(ledger.epoch).toBe(8);
    ledger.stats().launched = 100;
    expect(ledger.stats().launched).toBe(1);
  });
});

describe("speculation host observations", () => {
  it("uses the compiled decisions and preserves ended-invocation no-sweep and expiry-before-epoch behavior", async () => {
    let now = 100; vi.spyOn(Date, "now").mockImplementation(() => now);
    const admission = vi.spyOn(speculationAdmission, "step"), checks = vi.spyOn(speculationCheck, "step"), accounting = vi.spyOn(speculationAccounting, "step");
    const store = new FabricSpeculationStore({ maxConcurrent: 2, maxEntries: 3, entryTtlMs: 5 });
    const fresh = vi.fn(() => true);
    store.launch("old", "demo.read", {}, async () => "old", fresh, {}, "binding");
    store.onInvocationEnd("ended"); now = 106;
    expect(store.launch("ended", "demo.read", {}, async () => "new", undefined, {}, "binding")).toBe(false);
    expect(store.stats()).toMatchObject({ pending: 1, wasted: 0, skipped: 0 });
    store.bumpEpoch();
    expect(await store.tryServe("old", "demo.read", {}, "binding")).toEqual({ hit: false, reason: "absent" });
    expect(fresh).not.toHaveBeenCalled();
    expect(store.stats()).toMatchObject({ wasted: 1, epochInvalidated: 0 });
    expect(admission).toHaveBeenCalled(); expect(checks).toHaveBeenCalled(); expect(accounting).toHaveBeenCalled();
  });

  it("retains post-settlement epoch priority and never evaluates freshness after an earlier refusal", async () => {
    let now = 100; vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new FabricSpeculationStore({ maxConcurrent: 2, maxEntries: 3, entryTtlMs: 5 });
    const call = deferred(); const fresh = vi.fn(() => true);
    store.launch("call", "demo.read", {}, () => call.promise, fresh, {}, "binding");
    const serving = store.tryServe("call", "demo.read", {}, "binding");
    now = 106; store.bumpEpoch(); call.resolve("late");
    expect(await serving).toEqual({ hit: false, reason: "epoch" });
    expect(fresh).toHaveBeenCalledOnce();
    expect(store.stats()).toMatchObject({ epochInvalidated: 1, wasted: 0, served: 0 });
  });

  it("checks freshness before provider failure and preserves their distinct abort behavior", async () => {
    const store = new FabricSpeculationStore({ maxConcurrent: 2, maxEntries: 3, entryTtlMs: 1000 });
    const fresh = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const aborted = vi.fn();
    store.launch("call", "demo.read", {}, async signal => { signal.addEventListener("abort", aborted); throw new Error("provider failure"); }, fresh, {}, "binding");
    expect(await store.tryServe("call", "demo.read", {}, "binding")).toEqual({ hit: false, reason: "freshness" });
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(aborted).toHaveBeenCalledOnce();
    expect(store.stats()).toMatchObject({ freshnessInvalidated: 1, failed: 0 });
    const failedAbort = vi.fn();
    store.launch("failure", "demo.read", {}, async signal => { signal.addEventListener("abort", failedAbort); throw new Error("current provider failure"); }, undefined, {}, "binding");
    expect(await store.tryServe("failure", "demo.read", {}, "binding")).toEqual({ hit: false, reason: "failed" });
    expect(failedAbort).not.toHaveBeenCalled();
    expect(store.stats()).toMatchObject({ freshnessInvalidated: 1, failed: 1 });
  });
});
