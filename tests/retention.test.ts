import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { writeForkSession } from "../src/agents/handoff.js";
import { HostedRun } from "../src/agents/hosted-run.js";
import type { FabricHostedRunContext, FabricHostedRunner, FabricRunnerCapabilities } from "../src/agents/runner-registry.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import {
  FABRIC_RUN_ROOT_PREFIX,
  markRunRootActive,
  markRunRootClosed,
  pruneActorRunArchives,
  RUN_ROOT_HEARTBEAT_TTL_MS,
  sweepTempRunRoots,
} from "../src/storage/retention.js";

const roots: string[] = [];
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const temporaryDirectory = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-retention-test-"));
  roots.push(root);
  return root;
};

const writeStatus = (
  directory: string,
  record: Record<string, unknown>,
): void => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify(record));
};

const sweepAt = (tempRoot: string, now: number) =>
  sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("safe run roots", () => {
  const sweep = (tempRoot: string, now = 100 * DAY) => sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });

  it("preserves malformed/unmarked ownership and unknown root contents", () => {
    const tempRoot = temporaryDirectory();
    for (const [suffix, owner] of [["bad", {}], ["pid", { pid: "gone", startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }], ["time", { pid: 2147483647, startedAt: 1, heartbeatAt: "old", orphanedAt: 1 }]] as const) {
      const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + suffix);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify(owner));
    }
    const unknown = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "unknown");
    markRunRootActive(unknown, 1);
    fs.writeFileSync(path.join(unknown, ".fabric-owner.json"), JSON.stringify({ pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }));
    fs.writeFileSync(path.join(unknown, "mine"), "do not delete");
    const unmarked = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "unmarked");
    fs.mkdirSync(unmarked);
    expect(sweep(tempRoot).removedRoots).toEqual([]);
    expect(fs.readdirSync(tempRoot)).toHaveLength(5);
  });

  it("rejects symlink roots and status markers without touching targets", () => {
    const tempRoot = temporaryDirectory();
    const target = temporaryDirectory();
    markRunRootActive(target, 1);
    const run = path.join(target, "run");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    markRunRootClosed(target, 1);
    fs.symlinkSync(target, path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "link"), "junction");
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "status-link");
    markRunRootActive(root, 1);
    fs.mkdirSync(path.join(root, "run"));
    fs.symlinkSync(path.join(run, "status.json"), path.join(root, "run", "status.json"));
    markRunRootClosed(root, 1, true);
    expect(sweep(tempRoot).removedRuns).toEqual([]);
    expect(fs.existsSync(run)).toBe(true);
  });

  it("expires shutdown-confirmed incomplete runs, but never a live descendant", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "closed-incomplete");
    markRunRootActive(root, 1);
    const incomplete = path.join(root, "incomplete");
    fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(incomplete, "task.txt"), "incomplete launch");
    const active = path.join(root, "active");
    writeStatus(active, { status: "running", transport: "process", sessionId: String(process.pid) });
    fs.writeFileSync(path.join(active, "task.txt"), "still live");
    markRunRootClosed(root, 1, true);
    expect(sweep(tempRoot, 5 * HOUR).removedRuns).toEqual([]);
    expect(sweep(tempRoot, 6 * HOUR + 1).removedRuns).toEqual([incomplete]);
    expect(fs.existsSync(active)).toBe(true);
  });

  it("keeps unknown incomplete runs and live nested work under dead owners", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "dead-nested");
    markRunRootActive(root, 1);
    fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify({ pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 }));
    const run = path.join(root, "outer");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    const nested = path.join(run, "nested", "live");
    writeStatus(nested, { status: "running", transport: "process", sessionId: String(process.pid) });
    expect(sweep(tempRoot).removedRoots).toEqual([]);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe("run-root owner identity", () => {
  const sweep = (tempRoot: string, now: number) => sweepTempRunRoots({ tempRoot, now, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY });
  // A PID namespace this process is not in: the signal probe means nothing for it.
  const foreignIdentity = { hostname: os.hostname(), pidNamespace: "pid:[4026599999]", startedAt: 1 };
  const writeOwner = (root: string, owner: Record<string, unknown>): void => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".fabric-owner.json"), JSON.stringify(owner));
  };
  const readOwner = (root: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(root, ".fabric-owner.json"), "utf8")) as Record<string, unknown>;

  it("records this process's identity on the owner marker", () => {
    const root = path.join(temporaryDirectory(), FABRIC_RUN_ROOT_PREFIX + "self");
    markRunRootActive(root, 5);
    expect(readOwner(root)).toMatchObject({ pid: process.pid, heartbeatAt: 5, identity: { hostname: os.hostname() } });
    markRunRootClosed(root, 6, true);
    expect(readOwner(root)).toMatchObject({ pid: process.pid, heartbeatAt: 6, closedAt: 6, identity: { hostname: os.hostname() } });
  });

  it("treats a foreign-namespace owner with a stale heartbeat as dead, even when its PID is live here", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-stale");
    // process.pid answers the signal probe here, but it is not the foreign owner.
    writeOwner(root, { pid: process.pid, startedAt: 1, heartbeatAt: 1, identity: foreignIdentity });
    const detectedAt = 1 + RUN_ROOT_HEARTBEAT_TTL_MS + 1;
    expect(sweep(tempRoot, detectedAt).removedRoots).toEqual([]);
    expect(readOwner(root).orphanedAt).toBe(detectedAt);
    expect(sweep(tempRoot, detectedAt + 6 * HOUR).removedRoots).toEqual([root]);
  });

  it("keeps a foreign-namespace owner with a fresh heartbeat, even when its PID is absent here", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-fresh");
    writeOwner(root, { pid: 2_147_483_647, startedAt: 1, heartbeatAt: DAY, identity: foreignIdentity });
    expect(sweep(tempRoot, DAY + RUN_ROOT_HEARTBEAT_TTL_MS).removedRoots).toEqual([]);
    expect(readOwner(root).orphanedAt).toBeUndefined();
  });

  it("keeps a child run whose PID lives in the dead owner's foreign namespace", () => {
    const tempRoot = temporaryDirectory();
    const root = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "foreign-child");
    writeOwner(root, { pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1, identity: foreignIdentity });
    const child = path.join(root, "child");
    // Absent from this namespace, so a bare signal probe would call it dead.
    writeStatus(child, { status: "running", transport: "process", sessionId: "2147483647" });
    fs.writeFileSync(path.join(child, "task.txt"), "foreign worker");
    expect(sweep(tempRoot, 100 * DAY).removedRoots).toEqual([]);
    expect(fs.existsSync(child)).toBe(true);
  });
});

describe("temporal retention", () => {
  it("removes dead temporary run roots after six hours", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "dead");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(
      path.join(runRoot, ".fabric-owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }),
    );

    const detected = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 2,
    });
    expect(detected.removedRoots).toEqual([]);

    const result = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 6 * HOUR + 2,
    });

    expect(result.removedRoots).toEqual([runRoot]);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it("keeps live roots and the current root out of orphan cleanup", () => {
    const tempRoot = temporaryDirectory();
    const liveRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "live");
    markRunRootActive(liveRoot, 1);

    const result = sweepTempRunRoots({
      tempRoot,
      currentRoot: liveRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 30 * DAY,
    });

    expect(result.removedRoots).toEqual([]);
    expect(fs.existsSync(liveRoot)).toBe(true);
  });

  it("expires terminal one-shot runs from gracefully retained roots after 24 hours", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "closed");
    markRunRootActive(runRoot, 1);
    const expired = path.join(runRoot, "expired");
    const fresh = path.join(runRoot, "fresh");
    const actorTemp = path.join(runRoot, "actor-temp");
    writeStatus(expired, { status: "completed", finishedAt: DAY });
    writeStatus(fresh, { status: "completed", finishedAt: 2 * DAY });
    writeStatus(actorTemp, { status: "failed", actorId: "actor-1", finishedAt: DAY });
    markRunRootClosed(runRoot, 2 * DAY);

    const result = sweepTempRunRoots({
      tempRoot,
      orphanedTempRunRetentionMs: 6 * HOUR,
      oneShotRunRetentionMs: DAY,
      now: 2 * DAY + 1,
    });

    expect(result.removedRuns.sort()).toEqual([actorTemp, expired].sort());
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(actorTemp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("reclaims pi-durable journals with their run, but keeps unknown or linked journal contents (#229)", () => {
    const tempRoot = temporaryDirectory();
    const journal = (run: string, key = "initial") => {
      const store = path.join(run, "durable", key, "store");
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, "..", "lease.sqlite"), "");
      for (const name of ["main.jsonl", "doc-0.jsonl", "task-12.jsonl", "doc-3.jsonl.reclaim"]) fs.writeFileSync(path.join(store, name), "{}\n");
      return store;
    };
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable");
    markRunRootActive(runRoot, 1);
    const plain = path.join(runRoot, "plain");
    writeStatus(plain, { status: "completed", finishedAt: DAY });
    journal(plain);
    journal(plain, "a".repeat(64));
    const nested = path.join(runRoot, "parent");
    writeStatus(nested, { status: "completed", finishedAt: DAY });
    journal(nested);
    writeStatus(path.join(nested, "nested", "child"), { status: "completed", finishedAt: DAY });
    journal(path.join(nested, "nested", "child"));
    const unknown = path.join(runRoot, "unknown");
    writeStatus(unknown, { status: "completed", finishedAt: DAY });
    fs.writeFileSync(path.join(journal(unknown), "notes.txt"), "not Fabric's");
    const badKey = path.join(runRoot, "bad-key");
    writeStatus(badKey, { status: "completed", finishedAt: DAY });
    journal(badKey, "other");
    const outside = path.join(temporaryDirectory(), "outside.jsonl");
    fs.writeFileSync(outside, "keep");
    const linked = path.join(runRoot, "linked");
    writeStatus(linked, { status: "completed", finishedAt: DAY });
    fs.symlinkSync(outside, path.join(journal(linked), "doc-1.jsonl"));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns.sort()).toEqual([nested, plain].sort());
    for (const kept of [unknown, badKey, linked]) expect(fs.existsSync(kept)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  it("reclaims fabric_exec crash journals with their run, but keeps lookalikes, nested folders and links", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fabric-journal");
    markRunRootActive(runRoot, 1);
    // src/durable/agent.ts names each journal by the first 32 hex digits of a sha256.
    const journalName = "0123456789abcdef0123456789abcdef.jsonl";
    const run = (name: string, files: string[] = [journalName]) => {
      const directory = path.join(runRoot, name);
      writeStatus(directory, { status: "completed", finishedAt: DAY });
      const journals = path.join(directory, "durable", "initial", "fabric-journal");
      fs.mkdirSync(path.join(journals, "..", "store"), { recursive: true });
      fs.writeFileSync(path.join(journals, "..", "lease.sqlite"), "");
      fs.writeFileSync(path.join(journals, "..", "store", "main.jsonl"), "{}\n");
      fs.mkdirSync(journals);
      for (const file of files) fs.writeFileSync(path.join(journals, file), "{}\n");
      return { directory, journals };
    };
    const plain = run("plain").directory;
    const empty = run("empty", []).directory;
    const lookalike = run("lookalike", ["0123456789abcdef.jsonl"]).directory;
    const upper = run("upper", [journalName.toUpperCase().replace(".JSONL", ".jsonl")]).directory;
    const nested = run("nested", []);
    fs.mkdirSync(path.join(nested.journals, journalName));
    const outside = path.join(temporaryDirectory(), "outside.jsonl");
    fs.writeFileSync(outside, "keep");
    const linked = run("linked", []);
    fs.symlinkSync(outside, path.join(linked.journals, journalName));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns.sort()).toEqual([empty, plain].sort());
    for (const kept of [lookalike, upper, nested.directory, linked.directory]) expect(fs.existsSync(kept)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  const forkEntries = (): SessionEntry[] => [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } },
  ] as unknown as SessionEntry[];
  // The real writer, into the directory the manager gives it, so the layout is not guessed.
  const forkRun = (runRoot: string, name: string): { run: string; fork: string } => {
    const run = path.join(runRoot, name);
    writeStatus(run, { status: "completed", finishedAt: DAY });
    const fork = path.join(run, "fork-session");
    writeForkSession({ sourceSessionId: "caller", sourceBranch: forkEntries() }, run, fork);
    return { run, fork };
  };

  it("reclaims a forked run's fork-session with its run, but keeps unknown, linked, hard-linked, or nested contents", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fork");
    markRunRootActive(runRoot, 1);
    const plain = forkRun(runRoot, "plain");
    expect(fs.readdirSync(plain.fork)).toHaveLength(1);
    const unknown = forkRun(runRoot, "unknown");
    fs.writeFileSync(path.join(unknown.fork, "notes.txt"), "not Fabric's");
    const wrongName = forkRun(runRoot, "wrong-name");
    fs.writeFileSync(path.join(wrongName.fork, "other.jsonl"), "{}\n");
    const outside = path.join(temporaryDirectory(), "outside.jsonl");
    fs.writeFileSync(outside, "keep");
    const linked = forkRun(runRoot, "linked");
    fs.symlinkSync(outside, path.join(linked.fork, "handoff-00000000-0000-4000-8000-000000000000.jsonl"));
    const hardLinked = forkRun(runRoot, "hard-linked");
    const alias = path.join(temporaryDirectory(), "alias.jsonl");
    fs.linkSync(path.join(hardLinked.fork, fs.readdirSync(hardLinked.fork)[0]!), alias);
    const aliasBytes = fs.readFileSync(alias, "utf8");
    expect(aliasBytes).toContain('"pi-fabric-fork"');
    const nested = forkRun(runRoot, "nested-dir");
    fs.mkdirSync(path.join(nested.fork, "sub"));
    const linkedDirectory = forkRun(runRoot, "linked-dir");
    fs.rmSync(linkedDirectory.fork, { recursive: true });
    const outsideDirectory = temporaryDirectory();
    const sentinel = path.join(outsideDirectory, "sentinel.jsonl");
    fs.writeFileSync(sentinel, "keep directory");
    fs.symlinkSync(outsideDirectory, linkedDirectory.fork, "junction");
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([plain.run]);
    for (const kept of [unknown, wrongName, linked, hardLinked, nested, linkedDirectory]) expect(fs.existsSync(kept.run)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(fs.readFileSync(alias, "utf8")).toBe(aliasBytes);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep directory");
  });

  it("accepts only the file names its writers produce in fork-session, and rejects lookalikes", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fork-names");
    markRunRootActive(runRoot, 1);
    const accepted = forkRun(runRoot, "accepted");
    fs.writeFileSync(path.join(accepted.fork, "2026-01-02T03-04-05-678Z_0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl"), "{}\n");
    const lookalikes = [
      "handoff-00000000-0000-0000-0000-000000000000.jsonl", // no version or variant
      "handoff-123e4567-e89b-12d3-a456-426614174000.jsonl", // version 1
      "handoff-123e4567-e89b-42d3-c456-426614174000.jsonl", // variant c
      "handoff-123E4567-E89B-42D3-A456-426614174000.jsonl", // uppercase
      "handoff-123e4567-e89b-72d3-a456-426614174000.jsonl", // handoff names come from randomUUID: version 4 only
      "handoff-123e4567-e89b-42d3-a456-426614174000.jsonl.bak",
      "2026-01-02T03-04-05-678Z_123e4567-e89b-42d3-a456-426614174000.jsonl", // Pi session ids are version 7
      "2026-01-02T03:04:05.678Z_0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl", // colons and dot: Pi replaces them
      "2026-01-02T03-04-05Z_0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl", // no milliseconds
      "2026-01-02T03-04-05-678Z_0190a1b2-c3d4-7e5f-0a6b-7c8d9e0f1a2b.jsonl", // variant 0
      "2026-01-02T03-04-05-678Z-0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl", // wrong separator
      "2026-99-99T99-99-99-999Z_0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl", // right shape, not an instant
      "2026-02-30T12-00-00-000Z_0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b.jsonl", // no 30 February
    ];
    // Windows cannot create a file name containing a colon; every other lookalike still runs there.
    const creatable = lookalikes.filter((name) => process.platform !== "win32" || !name.includes(":"));
    const kept = creatable.map((name, index) => {
      const run = forkRun(runRoot, `look-${index}`);
      fs.writeFileSync(path.join(run.fork, name), "{}\n");
      return run.run;
    });
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([accepted.run]);
    for (const run of kept) expect(fs.existsSync(run)).toBe(true);
  });

  it("reclaims a run whose child extension forked the session into fork-session, via Pi's own branch writer", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "pi-branch");
    markRunRootActive(runRoot, 1);
    const { run, fork } = forkRun(runRoot, "forked");
    const handoff = fs.readdirSync(fork)[0]!;
    // SessionManager.createBranchedSession writes <timestamp>_<uuid>.jsonl beside the handoff file.
    const branched = SessionManager.open(path.join(fork, handoff), fork, run).createBranchedSession("a1");
    expect(branched).toBeDefined();
    expect(path.dirname(branched!)).toBe(fork);
    expect(path.basename(branched!)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/);
    expect(fs.readdirSync(fork).sort()).toHaveLength(2);
    // A name Pi does not produce still keeps the run.
    const stray = forkRun(runRoot, "stray");
    fs.writeFileSync(path.join(stray.fork, "2026-01-01T00-00-00-000Z_not-a-uuid.jsonl"), "{}\n");
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([run]);
    expect(fs.existsSync(stray.run)).toBe(true);
  });

  it("reclaims a forked run whose owner died, once the orphan grace passes", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "fork-orphan");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(path.join(runRoot, ".fabric-owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }));
    forkRun(runRoot, "run");
    expect(sweepAt(tempRoot, 2).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 2).removedRoots).toEqual([runRoot]);
  });

  it("reclaims the oversized-event artifact and record temp files a crash leaves, but not lookalikes or links", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "artifacts");
    markRunRootActive(runRoot, 1);
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const run = (name: string, files: Record<string, string>): string => {
      const directory = path.join(runRoot, name);
      writeStatus(directory, { status: "failed", finishedAt: DAY });
      for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), text);
      return directory;
    };
    const artifacts = run("artifacts", {
      "oversized-event-prefix.txt": "x".repeat(64),
      "status.json.4242.tmp": "{",
      [`status.json.4242.${uuid}.tmp`]: "{",
    });
    const lookalikes = [
      "status.json.bak", "status.json.4242.tmp.old", "task.txt.4242.tmp", "oversized-event-prefix.txt.bak", "events.jsonl.4242.tmp",
      "status.json.0.tmp", // a pid is positive
      "status.json.00042.tmp", // a pid is unpadded
      "status.json.4242.00000000-0000-0000-0000-000000000000.tmp", // no UUID version or variant
      "status.json.4242.123e4567-e89b-12d3-a456-426614174000.tmp", // version 1
      "status.json.4242.123E4567-E89B-42D3-A456-426614174000.tmp", // uppercase
    ]
      .map((file) => run(`look-${file}`, { [file]: "mine" }));
    const outside = path.join(temporaryDirectory(), "outside.txt");
    fs.writeFileSync(outside, "keep");
    const linked = run("linked", {});
    fs.symlinkSync(outside, path.join(linked, "oversized-event-prefix.txt"));
    const linkedTemp = run("linked-temp", {});
    fs.symlinkSync(outside, path.join(linkedTemp, "status.json.4242.tmp"));
    const directoryNamed = run("directory-named", {});
    fs.mkdirSync(path.join(directoryNamed, "oversized-event-prefix.txt"));
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, 2 * DAY + 1);
    expect(result.removedRuns).toEqual([artifacts]);
    for (const kept of [...lookalikes, linked, linkedTemp, directoryNamed]) expect(fs.existsSync(kept)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  // Real HostedRun: it writes hosted.json (the locator) and status.json exactly as the manager's runs do.
  const noCapabilities: FabricRunnerCapabilities = {
    recursiveFabric: false, steer: false, followUp: false, persistentSessions: false, kernels: false, handoff: false,
    modelDiscovery: false, imageInput: false, compaction: false, questions: false, sleep: false, writePolicy: false,
  };
  const hostedAdapter = (behavior: Pick<Partial<FabricHostedRunner>, "start" | "stop">): FabricHostedRunner => ({
    kind: "hosted", id: "retention-test", label: "Retention test", capabilities: noCapabilities,
    prepare: () => ({ job: "remote-1" }),
    start: () => undefined,
    attach: () => undefined,
    liveness: () => "running",
    stop: () => ({ confirmed: true }),
    ...behavior,
  });
  const hostedRun = async (runRoot: string, name: string, behavior: Pick<Partial<FabricHostedRunner>, "start" | "stop">): Promise<{ directory: string; run: HostedRun }> => {
    const directory = path.join(runRoot, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "task.txt"), "task"); // the manager writes it beside status.json
    const context: FabricHostedRunContext = {
      id: name, name, task: "task", cwd: directory, runDirectory: directory, residency: "session",
      deadlineAt: Date.now() + DAY, depth: 0, tools: [], idempotencyKey: name,
      lineage: { version: 1, rootSessionId: "root", runId: name, depth: 0, childIndex: 0, worker: true },
    };
    const record: AgentRunRecord = {
      id: name, name, task: "task", status: "running", runner: "retention-test", transport: "hosted", cwd: directory,
      startedAt: Date.now(), updatedAt: Date.now(), turns: 0, toolCalls: 0, text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    const run = await HostedRun.prepare(
      hostedAdapter(behavior), context,
      { statusFile: path.join(directory, "status.json"), lifecycleFile: path.join(directory, "lifecycle.jsonl"), logFile: path.join(directory, "events.jsonl"), stateFile: path.join(directory, "hosted.json") },
      record, { questionTimeoutMs: 1_000 },
    );
    return { directory, run };
  };

  it("keeps every run that holds a hosted-run locator, whatever its record says", async () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "hosted");
    markRunRootActive(runRoot, 1);
    const status = (directory: string): { status: string; outcome?: string } =>
      JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8")) as { status: string; outcome?: string };
    const uuid = "123e4567-e89b-42d3-a456-426614174000";

    const running = await hostedRun(runRoot, "running", {});
    const startFailed = await hostedRun(runRoot, "start-failed", { start: () => { throw new Error("submit failed"); } });
    await startFailed.run.start();
    const stoppedUnconfirmed = await hostedRun(runRoot, "stopped-unconfirmed", { stop: () => ({ confirmed: false }) });
    await stoppedUnconfirmed.run.stop();
    const stoppedConfirmed = await hostedRun(runRoot, "stopped-confirmed", {});
    await stoppedConfirmed.run.stop();
    // A terminal record without an outcome, written by hand: nothing in status.json vouches the remote work stopped.
    const handWritten = path.join(runRoot, "hand-written");
    writeStatus(handWritten, { transport: "hosted", status: "completed", finishedAt: DAY });
    fs.writeFileSync(path.join(handWritten, "hosted.json"), '{"job":"remote-hand"}');
    // A leftover temp locator beside a terminal record.
    const tempBeside = path.join(runRoot, "temp-beside");
    writeStatus(tempBeside, { transport: "hosted", status: "completed", finishedAt: DAY });
    const tempName = `hosted.json.4242.${uuid}.tmp`;
    fs.writeFileSync(path.join(tempBeside, tempName), "{");

    // The records are what the real HostedRun wrote, not assumed shapes.
    expect(status(running.directory)).toMatchObject({ status: "running" });
    expect(status(startFailed.directory)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(status(stoppedUnconfirmed.directory)).toMatchObject({ status: "stopped", outcome: "indeterminate" });
    expect(status(stoppedConfirmed.directory)).toMatchObject({ status: "stopped" });
    const locatorBytes = (directory: string): string => fs.readFileSync(path.join(directory, "hosted.json"), "utf8");
    const before = new Map([running, startFailed, stoppedUnconfirmed, stoppedConfirmed].map((run) => [run.directory, locatorBytes(run.directory)]));
    for (const bytes of before.values()) expect(bytes).toContain('"remote-1"');
    markRunRootClosed(runRoot, DAY, true);

    const result = sweepAt(tempRoot, Date.now() + 3 * DAY);
    expect(result.removedRuns).toEqual([]);
    for (const [directory, bytes] of before) expect(locatorBytes(directory)).toBe(bytes);
    expect(fs.readFileSync(path.join(handWritten, "hosted.json"), "utf8")).toBe('{"job":"remote-hand"}');
    expect(fs.readFileSync(path.join(tempBeside, tempName), "utf8")).toBe("{");
  });

  it("removes a dead owner's root holding pi-durable journals after the orphan grace (#229)", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable-orphan");
    fs.mkdirSync(runRoot);
    fs.writeFileSync(path.join(runRoot, ".fabric-owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }));
    const run = path.join(runRoot, "run");
    writeStatus(run, { status: "completed", finishedAt: 1 });
    fs.mkdirSync(path.join(run, "durable", "initial", "store"), { recursive: true });
    fs.writeFileSync(path.join(run, "durable", "initial", "lease.sqlite"), "");
    fs.writeFileSync(path.join(run, "durable", "initial", "store", "main.jsonl"), "{}\n");
    expect(sweepAt(tempRoot, 2).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 2).removedRoots).toEqual([runRoot]);
  });

  describe("durable-session folder", () => {
    const UUID_A = "0b6f2f62-3c1e-4c7a-9a4e-5d1f0a9b7c11";
    const UUID_B = "7d9e1c24-8f3a-4b5d-8c60-2a1e4f6b9d03";
    const setup = () => {
      const tempRoot = temporaryDirectory();
      const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable-session");
      markRunRootActive(runRoot, 1);
      const run = (name: string, files: Record<string, string>) => {
        const directory = path.join(runRoot, name);
        writeStatus(directory, { status: "completed", finishedAt: DAY });
        const sessions = path.join(directory, "durable-session");
        fs.mkdirSync(sessions, { recursive: true });
        for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(sessions, file), text);
        return directory;
      };
      const sweep = () => { markRunRootClosed(runRoot, DAY, true); return sweepAt(tempRoot, 2 * DAY + 1); };
      return { run, sweep };
    };

    it("reclaims a run whose folder holds session.jsonl, or a lone tmp-<uuid v4>.jsonl", () => {
      const { run, sweep } = setup();
      const plain = run("plain", { "session.jsonl": "{}\n" });
      const lone = run("lone", { [`tmp-${UUID_A}.jsonl`]: "{}\n" });
      const both = run("both", { "session.jsonl": "{}\n", [`tmp-${UUID_B}.jsonl`]: "{}\n" }); // two files, two inodes
      expect(sweep().removedRuns.sort()).toEqual([plain, lone, both].sort());
    });

    it("reclaims a run whose folder also holds a sidecar an extension keeps beside session.jsonl", () => {
      const { run, sweep } = setup();
      // An extension may write `<session file>.acp.json` next to every session it manages.
      const sidecar = run("sidecar", { "session.jsonl": "{}\n", "session.jsonl.acp.json": "{}" });
      const crashed = run("crashed", { "session.jsonl": "{}\n", "session.jsonl.acp.json": "{}" });
      fs.linkSync(path.join(crashed, "durable-session", "session.jsonl"), path.join(crashed, "durable-session", `tmp-${UUID_A}.jsonl`));
      const bare = run("bare", { "session.jsonl.": "{}" });
      const nested = run("nested", { "session.jsonl": "{}\n" });
      fs.mkdirSync(path.join(nested, "durable-session", "session.jsonl.acp.json"));
      const outside = path.join(temporaryDirectory(), "outside.json");
      fs.writeFileSync(outside, "outside bytes");
      const linked = run("linked", { "session.jsonl": "{}\n" });
      fs.linkSync(outside, path.join(linked, "durable-session", "session.jsonl.acp.json"));
      const symlinked = run("symlinked", { "session.jsonl": "{}\n" });
      fs.symlinkSync(outside, path.join(symlinked, "durable-session", "session.jsonl.acp.json"));
      expect(sweep().removedRuns.sort()).toEqual([crashed, sidecar].sort());
      for (const kept of [bare, nested, linked, symlinked]) expect(fs.existsSync(kept)).toBe(true);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
    });

    it.skipIf(process.platform === "win32")("reclaims a terminal run left with session.jsonl and tmp-<uuid>.jsonl as two names of one inode", () => {
      const { run, sweep } = setup();
      const crashed = run("crashed", { "session.jsonl": "{}\n" });
      const sessions = path.join(crashed, "durable-session");
      fs.linkSync(path.join(sessions, "session.jsonl"), path.join(sessions, `tmp-${UUID_A}.jsonl`)); // crash between link and unlink
      expect(fs.statSync(path.join(sessions, "session.jsonl")).nlink).toBe(2);
      expect(sweep().removedRuns).toEqual([crashed]);
      expect(fs.existsSync(crashed)).toBe(false);
    });

    it.skipIf(process.platform === "win32")("keeps a run whose tmp name is hard-linked to a file outside the run, and leaves that file's bytes alone", () => {
      const { run, sweep } = setup();
      const kept = run("kept", { "session.jsonl": "{}\n" });
      const outside = path.join(temporaryDirectory(), "outside.jsonl");
      fs.writeFileSync(outside, "outside bytes");
      fs.rmSync(path.join(kept, "durable-session", "session.jsonl"));
      fs.linkSync(outside, path.join(kept, "durable-session", "session.jsonl"));
      fs.linkSync(outside, path.join(kept, "durable-session", `tmp-${UUID_A}.jsonl`));
      expect(fs.statSync(outside).nlink).toBe(3);
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.existsSync(kept)).toBe(true);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
    });

    it.skipIf(process.platform === "win32")("keeps a run whose session.jsonl alone is linked to a file outside the run", () => {
      const { run, sweep } = setup();
      const kept = run("kept", { "session.jsonl": "{}\n" });
      const outside = path.join(temporaryDirectory(), "outside.jsonl");
      fs.writeFileSync(outside, "outside bytes");
      fs.rmSync(path.join(kept, "durable-session", "session.jsonl"));
      fs.linkSync(outside, path.join(kept, "durable-session", "session.jsonl"));
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
    });

    it.skipIf(process.platform === "win32")("keeps a run whose session.jsonl and tmp name each have two links but are not the same file", () => {
      const { run, sweep } = setup();
      const kept = run("kept", { "session.jsonl": "{}\n", [`tmp-${UUID_A}.jsonl`]: "{}\n" });
      const sessions = path.join(kept, "durable-session");
      const outside = temporaryDirectory();
      const outsideSession = path.join(outside, "session-twin.jsonl");
      const outsideTemp = path.join(outside, "temp-twin.jsonl");
      fs.linkSync(path.join(sessions, "session.jsonl"), outsideSession); // the second name is outside the run
      fs.linkSync(path.join(sessions, `tmp-${UUID_A}.jsonl`), outsideTemp);
      const session = fs.statSync(path.join(sessions, "session.jsonl"));
      const temporary = fs.statSync(path.join(sessions, `tmp-${UUID_A}.jsonl`));
      expect([session.nlink, temporary.nlink]).toEqual([2, 2]);
      expect(session.ino).not.toBe(temporary.ino);
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.existsSync(kept)).toBe(true);
      expect(fs.readFileSync(outsideSession, "utf8")).toBe("{}\n");
      expect(fs.readFileSync(outsideTemp, "utf8")).toBe("{}\n");
      expect(fs.statSync(outsideSession).nlink).toBe(2);
      expect(fs.statSync(outsideTemp).nlink).toBe(2);
    });

    it.skipIf(process.platform === "win32")("keeps a run when a two-name file is not the session.jsonl plus one tmp pair", () => {
      const { run, sweep } = setup();
      const twoTemps = run("two-temps", { [`tmp-${UUID_A}.jsonl`]: "{}\n" });
      fs.linkSync(path.join(twoTemps, "durable-session", `tmp-${UUID_A}.jsonl`), path.join(twoTemps, "durable-session", `tmp-${UUID_B}.jsonl`));
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.existsSync(twoTemps)).toBe(true);
    });

    it.each([
      ["an unknown name", "notes.txt"],
      ["a legacy timestamped Pi name", "2026-10-11T00-00-00-000Z_new.jsonl"],
      ["an uppercase uuid", `tmp-${UUID_A.toUpperCase()}.jsonl`],
      ["an all-zero uuid", "tmp-00000000-0000-0000-0000-000000000000.jsonl"],
      ["a uuid that is not version 4", "tmp-0b6f2f62-3c1e-1c7a-9a4e-5d1f0a9b7c11.jsonl"],
      ["a tmp name with a suffix", `tmp-${UUID_A}.jsonl.bak`],
    ])("keeps a run whose folder holds %s", (_label, name) => {
      const { run, sweep } = setup();
      const kept = run("kept", { "session.jsonl": "{}\n", [name]: "{}\n" });
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.existsSync(kept)).toBe(true);
    });

    it.skipIf(process.platform === "win32")("keeps a run whose folder holds a symlink", () => {
      const { run, sweep } = setup();
      const linked = run("linked", { "session.jsonl": "{}\n" });
      const outside = path.join(temporaryDirectory(), "outside.jsonl");
      fs.writeFileSync(outside, "keep");
      fs.symlinkSync(outside, path.join(linked, "durable-session", `tmp-${UUID_A}.jsonl`));
      expect(sweep().removedRuns).toEqual([]);
      expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    });

    it("keeps a run whose durable-session holds a directory", () => {
      const { run, sweep } = setup();
      const kept = run("dir", { "session.jsonl": "{}\n" });
      fs.mkdirSync(path.join(kept, "durable-session", `tmp-${UUID_A}.jsonl`));
      expect(sweep().removedRuns).toEqual([]);
    });
  });

  // What a durable worker run leaves behind, as found under dead owners: the durable store, the
  // fabric_exec crash journal beside it, an exported session with a sidecar another extension wrote.
  const deadDurableRun = (runRoot: string, name: string): string => {
    const run = path.join(runRoot, name);
    writeStatus(run, { status: "completed", finishedAt: 1 });
    fs.writeFileSync(path.join(run, "task.txt"), "task");
    const key = path.join(run, "durable", "initial");
    fs.mkdirSync(path.join(key, "store"), { recursive: true });
    fs.mkdirSync(path.join(key, "fabric-journal"));
    fs.writeFileSync(path.join(key, "lease.sqlite"), "");
    fs.writeFileSync(path.join(key, "store", "main.jsonl"), "{}\n");
    fs.writeFileSync(path.join(key, "fabric-journal", `${"a".repeat(32)}.jsonl`), "{}\n");
    fs.mkdirSync(path.join(run, "durable-session"));
    fs.writeFileSync(path.join(run, "durable-session", "session.jsonl"), "{}\n");
    fs.writeFileSync(path.join(run, "durable-session", "session.jsonl.acp.json"), "{}");
    return run;
  };
  const deadOwner = (runRoot: string): void => {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, ".fabric-owner.json"), JSON.stringify({ pid: 2_147_483_647, startedAt: 1, heartbeatAt: 1 }));
  };

  it("removes a dead owner's root once the orphan grace passes, whatever files its runs wrote", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "durable-leftovers");
    deadOwner(runRoot);
    const run = deadDurableRun(runRoot, "run");
    fs.writeFileSync(path.join(run, "written-by-something-else.bin"), "x");
    writeStatus(path.join(run, "nested", "child"), { status: "failed", finishedAt: 1 });
    fs.writeFileSync(path.join(run, "nested", "child", "notes.txt"), "x");
    expect(sweepAt(tempRoot, 2).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 1).removedRoots).toEqual([]);
    expect(sweepAt(tempRoot, 6 * HOUR + 2).removedRoots).toEqual([runRoot]);
    expect(fs.existsSync(runRoot)).toBe(false);
  });

  it("still keeps a dead owner's root with a live child, a hosted locator, an unfinished run, or unknown root entries", () => {
    const tempRoot = temporaryDirectory();
    const live = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "live-child");
    deadOwner(live);
    deadDurableRun(live, "done");
    writeStatus(path.join(live, "child"), { status: "running", transport: "process", sessionId: String(process.pid) });
    const hosted = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "hosted");
    deadOwner(hosted);
    fs.writeFileSync(path.join(deadDurableRun(hosted, "run"), "hosted.json"), '{"job":"remote"}');
    const hostedTemp = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "hosted-temp");
    deadOwner(hostedTemp);
    fs.writeFileSync(path.join(deadDurableRun(hostedTemp, "run"), "hosted.json.4242.123e4567-e89b-42d3-a456-426614174000.tmp"), "{");
    const unfinished = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "unfinished");
    deadOwner(unfinished);
    writeStatus(path.join(unfinished, "tmux"), { status: "running", transport: "tmux", sessionId: "fabric-1" });
    fs.writeFileSync(path.join(unfinished, "tmux", "task.txt"), "task");
    const rootFile = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "root-file");
    deadOwner(rootFile);
    deadDurableRun(rootFile, "run");
    fs.writeFileSync(path.join(rootFile, "mine"), "not a run");
    const linked = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "linked-run");
    deadOwner(linked);
    fs.symlinkSync(deadDurableRun(temporaryDirectory(), "elsewhere"), path.join(linked, "run"), "junction");
    sweepAt(tempRoot, 2);
    expect(sweepAt(tempRoot, 100 * DAY).removedRoots).toEqual([]);
    for (const kept of [live, hosted, hostedTemp, unfinished, rootFile, linked]) expect(fs.existsSync(kept)).toBe(true);
  });

  it("keeps a live owner's root holding the same files, however old", () => {
    const tempRoot = temporaryDirectory();
    const runRoot = path.join(tempRoot, FABRIC_RUN_ROOT_PREFIX + "live-owner");
    markRunRootActive(runRoot, 1);
    deadDurableRun(runRoot, "run");
    expect(sweepTempRunRoots({ tempRoot, orphanedTempRunRetentionMs: 6 * HOUR, oneShotRunRetentionMs: DAY }).removedRoots).toEqual([]);
    expect(fs.existsSync(runRoot)).toBe(true);
  });

  it("expires actor archives after seven days while preserving the latest run", () => {
    const root = temporaryDirectory();
    const runsDirectory = path.join(root, "runs");
    const expired = path.join(runsDirectory, "expired");
    const latest = path.join(runsDirectory, "latest");
    const fresh = path.join(runsDirectory, "fresh");
    writeStatus(expired, { status: "completed", finishedAt: DAY });
    writeStatus(latest, { status: "completed", finishedAt: DAY });
    writeStatus(fresh, { status: "completed", finishedAt: 8 * DAY });

    const removed = pruneActorRunArchives({
      runsDirectory,
      latestRunId: "latest",
      retentionMs: 7 * DAY,
      now: 8 * DAY + 1,
    });

    expect(removed).toEqual([expired]);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(latest)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
