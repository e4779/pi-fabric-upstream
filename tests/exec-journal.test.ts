import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFabricExecJournal, type FabricExecJournal } from "../src/runtime/exec-journal.js";
import type { FabricHostCall, FabricJournalDriver, FabricSandboxOptions } from "../src/runtime/kernel.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };
const hooks = { served() {}, local: () => undefined };
const identity = { code: "fixture" };

function journalFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-journal-")); roots.push(root);
  return path.join(root, "journal", "call.jsonl");
}

// Opens a fresh journal and returns the header digest the worker would memoize.
async function record(file: string, code: string, host: (journal: FabricExecJournal) => FabricHostCall, signal?: AbortSignal) {
  let digest = "";
  const journal = await openFabricExecJournal({ path: file, accept: async (value) => { digest = value; } }, identity, hooks);
  try {
    const result = await new QuickJsRuntime().execute(code, host(journal), { ...options, journal, ...(signal ? { signal } : {}) });
    return { digest, result };
  } finally { journal.close(); }
}

async function resume(file: string, digest: string, code: string, host: FabricHostCall, resumeIdentity = identity, extra: Partial<FabricSandboxOptions> = {}) {
  const journal = await openFabricExecJournal({ path: file, digest, accept: async () => { throw new Error("resume must not accept"); } }, resumeIdentity, hooks);
  try { return await new QuickJsRuntime().execute(code, host, { ...options, ...extra, journal }); }
  finally { journal.close(); }
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const target = (args: Record<string, unknown>) => `${String(args.ref)}:${JSON.stringify(args.args)}`;
const neverCalled: FabricHostCall = async (ref, args) => { throw new Error(`host called on resume: ${ref} ${JSON.stringify(args)}`); };
// A first attempt whose call `stopAt` hangs until the run is aborted, as a crash would leave it.
function crashingHost(stopAt: number, controller: AbortController, intent: boolean) {
  return (journal: FabricExecJournal): FabricHostCall => async (_ref, args, signal, _humanWait, call) => {
    const n = (args.args as { n: number }).n;
    if (n < stopAt) return n * 10;
    if (intent) journal.intent(call!.seq, String(args.ref));
    queueMicrotask(() => controller.abort());
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
}

const twoCalls = (second: string) => `const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nconst b = await tools.call({ ref: "${second}", args: { n: 2 } });\nreturn [a, b];`;

describe("fabric_exec crash journal", () => {
  it("serves recorded results without the host and repeats the guest clock and randomness", async () => {
    const file = journalFile();
    // Only Date is virtual: each host call advances the clock by a fixed step.
    vi.useFakeTimers({ toFake: ["Date"] });
    const code = `const r = Math.random(); const t0 = Date.now();\nconst x = await tools.call({ ref: "demo.read", args: { n: 1 } });\nconst t1 = Date.now();\nconst y = await tools.call({ ref: "demo.read", args: { n: 2 } });\nreturn [r, t0, x, t1, y, Math.random(), new Date(t1).toString(), new Date(0).getHours()];`;
    const calls: string[] = [];
    const first = await record(file, code, () => async (_ref, args) => {
      calls.push(target(args));
      vi.setSystemTime(Date.now() + 10);
      return (args.args as { n: number }).n * 10;
    });
    expect(first.result.terminationReason, first.result.error).toBe("completed");
    expect(calls).toEqual(['demo.read:{"n":1}', 'demo.read:{"n":2}']);
    const value = first.result.value as unknown[];
    expect(value[2]).toBe(10);
    expect(value[4]).toBe(20);
    expect(value[3]).toBeGreaterThan(value[1] as number);
    expect(value[7]).toBe(0);

    const again = await resume(file, first.digest, code, neverCalled);
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual(value);
  });

  it("leaves no nondeterministic guest global under a journal", async () => {
    // Every source the guest could read that a replay would not reproduce.
    const probe = `const t0 = Date.now(); const d0 = new Date().getTime();
let spin = 0; for (let i = 0; i < 2e6; i++) spin += i;
const p = typeof performance === "object" && performance !== null && typeof performance.now === "function" ? [performance.now(), performance.now()] : null;
const c = typeof crypto === "object" && crypto !== null && typeof crypto.getRandomValues === "function" ? Array.from(crypto.getRandomValues(new Uint32Array(4))) : null;
return { clock: [t0, d0, Date.now(), new Date().getTime(), String(Date())], zone: [new Date(0).getTimezoneOffset(), new Date(0).getHours(), new Date(2020, 0, 1).getTime(), new Date("2020-01-01T00:00:00").getTime()],
  random: [Math.random(), Math.random(), Math.random()], weak: [typeof WeakRef, typeof FinalizationRegistry], p, c, spin: spin > 0 };`;
    const previousZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const runs: Array<Record<string, unknown[] | null>> = [];
      const digests: string[] = [];
      for (let n = 0; n < 2; n++) {
        const file = journalFile();
        const { digest, result } = await record(file, probe, () => async () => undefined);
        expect(result.terminationReason, result.error).toBe("completed");
        runs.push(result.value as Record<string, unknown[] | null>);
        digests.push(digest);
        // The replay reads exactly what the recording read.
        const again = await resume(file, digest, probe, neverCalled);
        expect(again.value).toEqual(result.value);
      }
      for (const run of runs) {
        const clock = run.clock as number[];
        // The clock does not move while the guest computes.
        expect(clock.slice(0, 4).every((value) => value === clock[0])).toBe(true);
        // The zone is UTC whatever the host zone is.
        expect(run.zone).toEqual([0, 0, Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 1)]);
        expect(clock[4]).toMatch(/GMT\+0000$/);
        expect(run.weak).toEqual(["undefined", "undefined"]);
        // Any timer or random source the guest has must also be frozen or seeded.
        if (run.p) expect(run.p[0]).toBe(run.p[1]);
      }
      // Two journals draw different seeds, so randomness is seeded, not constant.
      expect(runs[0]!.random).not.toEqual(runs[1]!.random);
      if (runs[0]!.c) expect(runs[0]!.c).not.toEqual(runs[1]!.c);
    } finally {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    }
  });

  it("runs the calls after the last recorded result live and keeps recording", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const first = await record(file, twoCalls("demo.read"), crashingHost(2, controller, false), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");

    const live: string[] = [];
    const again = await resume(file, first.digest, twoCalls("demo.read"), async (_ref, args) => {
      live.push(target(args));
      return (args.args as { n: number }).n * 10;
    });
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual([10, 20]);
    expect(live).toEqual(['demo.read:{"n":2}']);

    // The live result was journaled too, so a third attempt calls nothing.
    const third = await resume(file, first.digest, twoCalls("demo.read"), neverCalled);
    expect(third.value).toEqual([10, 20]);
  });

  it("stops at a call with an intent but no result and never repeats it", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const first = await record(file, twoCalls("demo.write"), crashingHost(2, controller, true), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");

    const again = await resume(file, first.digest, twoCalls("demo.write"), neverCalled);
    expect(again.terminationReason).toBe("runtime_error");
    expect(again.error).toContain("fabric_exec was interrupted during this call, which may have run:");
    expect(again.error).toContain('demo.write({"n":2})');
    expect(again.error).toContain("1 earlier tool call finished before the interruption");
    expect(again.error).toContain("This call was not repeated.");
  });

  it("repeats a call that may have run only after a person answers yes", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const first = await record(file, twoCalls("demo.write"), crashingHost(2, controller, true), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");

    const questions: string[] = [];
    const live: string[] = [];
    const again = await resume(file, first.digest, twoCalls("demo.write"), async (_ref, args) => {
      live.push(target(args));
      return (args.args as { n: number }).n * 10;
    }, identity, { confirmRepeat: { pausesDeadline: true, ask: async (question) => { questions.push(question); return true; } } });
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual([10, 20]);
    expect(live).toEqual(['demo.write:{"n":2}']);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('demo.write({"n":2})');
    expect(questions[0]).toContain("Run it again? If it took effect, running it again repeats that effect.");

    // The repeated result was journaled, so a later resume asks nobody and calls nothing.
    const third = await resume(file, first.digest, twoCalls("demo.write"), neverCalled, identity, {
      confirmRepeat: { pausesDeadline: true, ask: async () => { throw new Error("asked again"); } },
    });
    expect(third.value).toEqual([10, 20]);
  });

  it("keeps the stop when the person says no, dismisses the question, or it fails", async () => {
    const answers: Array<() => Promise<boolean>> = [
      async () => false,
      async () => undefined as unknown as boolean,
      async () => { throw new Error("dialog failed"); },
    ];
    for (const answer of answers) {
      const file = journalFile();
      const controller = new AbortController();
      const first = await record(file, twoCalls("demo.write"), crashingHost(2, controller, true), controller.signal);
      const again = await resume(file, first.digest, twoCalls("demo.write"), neverCalled, identity, { confirmRepeat: { pausesDeadline: true, ask: answer } });
      expect(again.terminationReason).toBe("runtime_error");
      expect(again.error).toContain("This call was not repeated.");
    }
  });

  it("pauses the program deadline while it asks, unless the deadline is hard", async () => {
    for (const pausesDeadline of [true, false]) {
      const file = journalFile();
      const controller = new AbortController();
      const first = await record(file, twoCalls("demo.write"), crashingHost(2, controller, true), controller.signal);
      // The deadline clock is virtual from here. The question opens, the clock
      // moves past the 200 ms deadline, and only then does the person answer.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const opened = latch();
      const answer = latch();
      const live: string[] = [];
      const pending = resume(file, first.digest, twoCalls("demo.write"), async (_ref, args) => {
        live.push(target(args));
        return 0;
      }, identity, { timeoutMs: 200, confirmRepeat: { pausesDeadline, ask: async (_question, signal) => {
        opened.resolve();
        await answer.promise;
        return !signal.aborted;
      } } });
      await opened.promise;
      await vi.advanceTimersByTimeAsync(400);
      answer.resolve();
      const again = await pending;
      vi.useRealTimers();
      // A hard deadline cancels the question without waiting for its answer.
      expect(again.terminationReason, again.error).toBe(pausesDeadline ? "completed" : "timed_out");
      if (!pausesDeadline) expect(again.error).toContain("timed out");
      expect(live).toEqual(pausesDeadline ? ['demo.write:{"n":2}'] : []);
    }
  });

  it("asks nobody when more than one call may have run", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const code = 'return await Promise.all([tools.call({ ref: "demo.write", args: { n: 1 } }), tools.call({ ref: "demo.write", args: { n: 2 } })]);';
    let started = 0;
    const first = await record(file, code, (journal) => async (_ref, args, signal, _humanWait, call) => {
      journal.intent(call!.seq, String(args.ref));
      if (++started === 2) queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }, controller.signal);
    expect(first.result.terminationReason).toBe("aborted");
    expect(started).toBe(2);

    let asked = 0;
    const again = await resume(file, first.digest, code, neverCalled, identity, { confirmRepeat: { pausesDeadline: true, ask: async () => { asked++; return true; } } });
    expect(again.terminationReason).toBe("runtime_error");
    expect(again.error).toContain("This call was not repeated.");
    expect(asked).toBe(0);
  });

  it("refuses a resume whose program no longer repeats its recorded calls", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async (_ref, args) => (args.args as { n: number }).n);
    const changed = 'return await tools.call({ ref: "demo.other", args: { n: 9 } });';
    const again = await resume(file, first.digest, changed, neverCalled);
    expect(again.terminationReason).toBe("runtime_error");
    expect(again.error).toBe('fabric_exec could not resume after an interruption: the program did not repeat its recorded demo.read call (it made demo.other({"n":9}) instead). No call after the divergence ran.');
  });

  it("replays a recorded error with its message and opted-in numeric fields", async () => {
    const file = journalFile();
    const code = 'try { await tools.call({ ref: "demo.fail", args: {} }); } catch (error) { const e = error as Record<string, unknown>; return [e.message, e.status]; }\nreturn null;';
    const first = await record(file, code, () => async () => { throw Object.assign(new Error("HTTP 429"), { guestFields: { status: 429 } }); });
    expect(first.result.value).toEqual(["HTTP 429", 429]);
    const again = await resume(file, first.digest, code, neverCalled);
    expect(again.value).toEqual(["HTTP 429", 429]);
  });

  it("drops a torn last line but refuses damage before it", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async (_ref, args) => (args.args as { n: number }).n);
    const intact = fs.readFileSync(file);

    fs.appendFileSync(file, '0badc0de {"c":2');
    const torn = await resume(file, first.digest, twoCalls("demo.read"), neverCalled);
    expect(torn.value).toEqual([1, 2]);
    expect(fs.readFileSync(file).equals(intact)).toBe(true);

    const lines = intact.toString("utf8").split("\n");
    const damaged = lines[1]!.replace('"seq":0', '"seq":5');
    expect(damaged).not.toBe(lines[1]);
    lines[1] = damaged;
    fs.writeFileSync(file, lines.join("\n"));
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled)).rejects.toThrow(
      "fabric_exec could not resume after an interruption: its journal is damaged. Nothing was rerun.",
    );
  });

  it("appends after a torn-tail repair without overwriting the surviving journal", async () => {
    const file = journalFile();
    const controller = new AbortController();
    const code = twoCalls("demo.read");
    const first = await record(file, code, crashingHost(2, controller, false), controller.signal);
    expect(first.result.terminationReason).toBe("aborted");
    const intact = fs.readFileSync(file);
    fs.appendFileSync(file, '0badc0de {"c":1');

    const live: string[] = [];
    const again = await resume(file, first.digest, code, async (_ref, args) => {
      live.push(target(args));
      return 20;
    });
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual([10, 20]);
    expect(live).toEqual(['demo.read:{"n":2}']);
    const repaired = fs.readFileSync(file);
    expect(repaired.subarray(0, intact.length).equals(intact)).toBe(true);
    expect(repaired.length).toBeGreaterThan(intact.length);
    // A second resume validates the new completion's position and hash chain.
    expect((await resume(file, first.digest, code, neverCalled)).value).toEqual([10, 20]);
  });

  it("refuses a journal whose lines were lost, reordered, or spliced in from another journal", async () => {
    const threeCalls = 'const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nconst b = await tools.call({ ref: "demo.read", args: { n: 2 } });\nconst c = await tools.call({ ref: "demo.read", args: { n: 3 } });\nreturn [a, b, c];';
    const file = journalFile();
    const first = await record(file, threeCalls, () => async (_ref, args) => (args.args as { n: number }).n);
    const intact = fs.readFileSync(file, "utf8");
    const lines = intact.split("\n");
    expect(lines).toHaveLength(5);
    const damaged = "fabric_exec could not resume after an interruption: its journal is damaged. Nothing was rerun.";

    // A lost middle line: every remaining line keeps a valid checksum.
    fs.writeFileSync(file, [lines[0], lines[2], lines[3], ""].join("\n"));
    await expect(resume(file, first.digest, threeCalls, neverCalled)).rejects.toThrow(damaged);

    // Two complete lines swapped.
    fs.writeFileSync(file, [lines[0], lines[2], lines[1], lines[3], ""].join("\n"));
    await expect(resume(file, first.digest, threeCalls, neverCalled)).rejects.toThrow(damaged);

    // A line copied from another journal of the same program.
    const other = journalFile();
    await record(other, threeCalls, () => async (_ref, args) => (args.args as { n: number }).n);
    const foreign = fs.readFileSync(other, "utf8").split("\n");
    fs.writeFileSync(file, [lines[0], lines[1], foreign[2], lines[3], ""].join("\n"));
    await expect(resume(file, first.digest, threeCalls, neverCalled)).rejects.toThrow(damaged);

    // The intact journal still resumes.
    fs.writeFileSync(file, intact);
    expect((await resume(file, first.digest, threeCalls, neverCalled)).value).toEqual([1, 2, 3]);
  });

  it("refuses a journal written in the unchained v1 format", async () => {
    const file = journalFile();
    await record(file, "return 1;", () => async () => undefined);
    const [header] = fs.readFileSync(file, "utf8").split("\n");
    const json = header!.slice(9).replace(/pi-fabric\.exec-journal\.v\d+/, "pi-fabric.exec-journal.v1");
    const { crc32 } = await import("node:zlib");
    fs.writeFileSync(file, `${crc32(json).toString(16).padStart(8, "0")} ${json}\n`);
    const { createHash } = await import("node:crypto");
    await expect(resume(file, createHash("sha256").update(json).digest("hex"), "return 1;", neverCalled)).rejects.toThrow(
      "fabric_exec could not resume after an interruption: its journal was written in format v1, which this Fabric cannot verify. Nothing was rerun.",
    );
  });

  it("refuses a missing, replaced, or re-identified journal", async () => {
    const file = journalFile();
    const first = await record(file, twoCalls("demo.read"), () => async () => 1);
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled, { code: "changed" })).rejects.toThrow(
      "the program, its payloads, or its execution settings changed since the journal was recorded",
    );
    await expect(resume(file, "0".repeat(64), twoCalls("demo.read"), neverCalled)).rejects.toThrow("its journal was replaced or lost its header");
    fs.rmSync(file);
    await expect(resume(file, first.digest, twoCalls("demo.read"), neverCalled)).rejects.toThrow("its journal is missing");
  });

  it("refuses to resume past a result that named process-local work", async () => {
    const file = journalFile();
    const first = await record(file, 'return await tools.call({ ref: "agents.spawn", args: {} });', () => async () => ({ id: "child" }));
    await expect(resume(file, first.digest, 'return await tools.call({ ref: "agents.spawn", args: {} });', neverCalled)).rejects.toThrow(
      "its agents.spawn call returned process-local work that did not survive the restart",
    );
  });

  it("creates the journal private to its owner", async () => {
    const file = journalFile();
    await record(file, "return 1;", () => async () => undefined);
    // Windows has no POSIX permission bits to read back.
    if (process.platform === "win32") return;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe("fabric_exec journal restoration cancellation", () => {
  it.each([
    ["deadline", "resolves"], ["deadline", "rejects"],
    ["cancellation", "resolves"], ["cancellation", "rejects"],
  ] as const)("settles on %s while served is latched and ignores a restore that later %s", async (stop, late) => {
    const file = journalFile();
    const code = twoCalls("demo.read");
    const first = await record(file, code, () => async (_ref, args) => (args.args as { n: number }).n);
    const entered = latch();
    const release = latch();
    const restored = latch();
    const controller = new AbortController();
    const served: number[] = [];
    let restoreSignal: AbortSignal | undefined;
    const journal = await openFabricExecJournal({ path: file, digest: first.digest, accept: async () => {} }, identity, {
      local: () => undefined,
      served: async (delivery, _args, signal) => {
        served.push(delivery.seq);
        restoreSignal = signal;
        entered.resolve();
        // Deliberately ignore cancellation until after execute has disposed its
        // context. Neither this completion nor rejection may restart replay.
        await release.promise;
        restored.resolve();
        if (late === "rejects") throw new Error("late restore failure");
      },
    });
    const host = vi.fn(neverCalled);
    const run = new QuickJsRuntime().execute(code, host, {
      ...options, timeoutMs: stop === "deadline" ? 100 : 5_000, signal: controller.signal, journal,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered.promise, run.then((result) => {
        throw new Error(`Execution settled before restoration entered: ${result.error ?? result.terminationReason}`);
      })]);
      if (stop === "cancellation") controller.abort();
      const result = await Promise.race([
        run,
        new Promise<undefined>((resolve) => { watchdog = setTimeout(() => resolve(undefined), 1_000); }),
      ]);
      expect(result, "execute must settle before the restoration latch is released").toBeDefined();
      expect(result?.terminationReason).toBe(stop === "deadline" ? "timed_out" : "aborted");
      expect(restoreSignal?.aborted).toBe(true);
      release.resolve();
      await restored.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(served).toEqual([0]);
      expect(host).not.toHaveBeenCalled();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release.resolve();
      await run;
      journal.close();
    }
  });
});

// A driver that saves asynchronously, as one backed by a database would. It
// wraps the file journal so the recorded run can be resumed from disk.
function asyncDriver(journal: FabricExecJournal, save: (seq: number) => Promise<void>): FabricJournalDriver {
  return {
    get shim() { return journal.shim; },
    get startedAt() { return journal.startedAt; },
    get resuming() { return journal.resuming; },
    get replay() { return journal.replay; },
    digest: (args) => journal.digest(args),
    complete: async (seq, ref, args, value, outcome) => {
      await save(seq);
      return journal.complete(seq, ref, args, value, outcome);
    },
    served: (delivery, args, signal) => journal.served(delivery, args, signal),
    frontier: (held) => journal.frontier(held),
    diverged: (expected, actual) => journal.diverged(expected, actual),
  };
}

describe("fabric_exec journal with an asynchronous save", () => {
  it("shows the guest a result only after its save finishes", async () => {
    const file = journalFile();
    const saved = latch();
    const calls: number[] = [];
    let digest = "";
    const journal = await openFabricExecJournal({ path: file, accept: async (value) => { digest = value; } }, identity, hooks);
    try {
      const code = 'const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nreturn await tools.call({ ref: "demo.read", args: { n: a + 1 } });';
      const run = new QuickJsRuntime().execute(code, async (_ref, args) => {
        const n = (args.args as { n: number }).n;
        calls.push(n);
        return n;
      }, { ...options, journal: asyncDriver(journal, (seq) => (seq === 0 ? saved.promise : Promise.resolve())) });
      await new Promise((done) => setTimeout(done, 50));
      expect(calls).toEqual([1]);
      saved.resolve();
      const result = await run;
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toBe(2);
      expect(calls).toEqual([1, 2]);
    } finally { journal.close(); }

    const again = await resume(file, digest, 'const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nreturn await tools.call({ ref: "demo.read", args: { n: a + 1 } });', neverCalled);
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toBe(2);
  });

  it("delivers parallel results in the order they finished, even when a later save finishes first", async () => {
    const file = journalFile();
    const slowSave = latch();
    const firstDone = latch();
    let digest = "";
    const code = 'const seen = [];\nawait Promise.all([1, 2].map((n) => tools.call({ ref: "demo.read", args: { n } }).then((v) => seen.push(v))));\nreturn seen;';
    const journal = await openFabricExecJournal({ path: file, accept: async (value) => { digest = value; } }, identity, hooks);
    try {
      const result = await new QuickJsRuntime().execute(code, async (_ref, args) => {
        const n = (args.args as { n: number }).n;
        // Call 1 finishes first; call 2 finishes after it.
        if (n === 2) await firstDone.promise;
        return n;
      }, {
        ...options,
        journal: asyncDriver(journal, async (seq) => {
          if (seq === 0) {
            firstDone.resolve();
            // Hold the first save until the second result has arrived and could overtake it.
            await new Promise((done) => setTimeout(done, 30));
            slowSave.resolve();
          } else {
            await Promise.resolve();
          }
        }),
      });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual([1, 2]);
    } finally { journal.close(); }
    await slowSave.promise;

    const again = await resume(file, digest, code, neverCalled);
    expect(again.terminationReason, again.error).toBe("completed");
    expect(again.value).toEqual([1, 2]);
  });

  it("stops the program when a save fails, before the guest sees that result", async () => {
    const file = journalFile();
    const calls: number[] = [];
    const journal = await openFabricExecJournal({ path: file, accept: async () => {} }, identity, hooks);
    try {
      const code = 'const a = await tools.call({ ref: "demo.read", args: { n: 1 } });\nawait tools.call({ ref: "demo.write", args: { n: a + 1 } });\nreturn "finished";';
      const result = await new QuickJsRuntime().execute(code, async (_ref, args) => {
        const n = (args.args as { n: number }).n;
        calls.push(n);
        return n;
      }, { ...options, journal: asyncDriver(journal, async () => { throw new Error("disk full"); }) });
      expect(result.terminationReason).toBe("runtime_error");
      expect(result.error).toBe("Fabric could not write its journal: disk full");
      expect(calls).toEqual([1]);
    } finally { journal.close(); }
  });
});
