// Session owner lock: cross-process single-writer guard for session files
// (PR4 of the sessions roadmap; the P0 double-open incident). All tests
// run against an isolated registry root; liveness probes are injected so no
// real foreign process is needed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import {
  acquireSessionOwnerLock,
  claimWorkerSessionOwnerLock,
  decideOwnerSidecar,
  formatOwnerRecord,
  parseOwnerSidecar,
  processAliveProbe,
  readSessionOwners,
  releaseSessionOwnerLock,
  SESSION_OWNER_FORCE_ENV,
  SESSION_OWNER_LOCK_ENV,
  SESSION_OWNER_TTL_MS,
  SessionOwnerConflictError,
  SessionOwnerLockUnavailableError,
  sessionOwnerRegistryRoot,
  sessionOwnerSidecarPath,
  sweepSessionOwnerRegistry,
  type SessionOwnerProbe,
} from "../src/core/session-owner-lock.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const registryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-session-owners-"));
  roots.push(root);
  return root;
};

const sessionFileIn = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-sessions-"));
  roots.push(dir);
  return path.join(dir, "20261108T120000_0197a7e4-6f4c-7cc6-9d4e-2a1b3c4d5e6f.jsonl");
};

const aliveProbe = (): SessionOwnerProbe => (pid) => pid === 4242;
const deadProbe = (): SessionOwnerProbe => () => false;

const sidecarText = (registryRootDir: string, file: string): string =>
  fs.readFileSync(sessionOwnerSidecarPath(file, registryRootDir), "utf8");

describe("session owner sidecar text", () => {
  it("parses one record per pid line, keeping a forced writer's fields separate", () => {
    const text = [
      "pid=4242",
      "session=19deac54",
      "ts=2026-11-08T12:00:00.000Z",
      "pid=999",
      "ts=2026-11-08T12:05:00.000Z",
    ].join("\n");
    const parsed = parseOwnerSidecar(text);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.owners).toEqual([
      { pid: 4242, session: "19deac54", ts: "2026-11-08T12:00:00.000Z" },
      { pid: 999, ts: "2026-11-08T12:05:00.000Z" },
    ]);
  });

  it("flags content without a pid line as corrupt and formats records back", () => {
    expect(parseOwnerSidecar("pid=abc\ngarbage").corrupt).toBe(true);
    expect(parseOwnerSidecar("").corrupt).toBe(false);
    const record = { pid: 7, session: "sid", ts: "2026-11-08T12:00:00.000Z" };
    expect(parseOwnerSidecar(formatOwnerRecord(record)).owners).toEqual([record]);
  });

  it("decides live, self, and stale verdicts", () => {
    const probe = aliveProbe();
    const sidecar = parseOwnerSidecar("pid=4242\npid=5150\n");
    expect(decideOwnerSidecar(sidecar, 1, probe)).toEqual({ verdict: "live", owner: { pid: 4242 } });
    expect(decideOwnerSidecar(parseOwnerSidecar("pid=1\npid=2\n"), 1, deadProbe()))
      .toEqual({ verdict: "self" });
    expect(decideOwnerSidecar(parseOwnerSidecar("pid=2\n"), 1, deadProbe()))
      .toEqual({ verdict: "stale" });
    expect(decideOwnerSidecar(parseOwnerSidecar(""), 1, probe)).toEqual({ verdict: "stale" });
  });

  it("detects liveness through process.kill(pid, 0)", async () => {
    expect(processAliveProbe(process.pid)).toBe(true);
    expect(processAliveProbe(0)).toBe(false);
    expect(processAliveProbe(-1)).toBe(false);
    // A real exited pid must read dead on every supported platform.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(processAliveProbe(pid!)).toBe(false);
  }, 10_000);
});

describe("session owner registry layout", () => {
  it("resolves the registry root from the environment", () => {
    process.env.PI_FABRIC_SESSION_OWNERS_DIR = path.join(path.sep, "custom", "root");
    expect(sessionOwnerRegistryRoot()).toBe(path.join(path.sep, "custom", "root"));
    delete process.env.PI_FABRIC_SESSION_OWNERS_DIR;
    process.env.XDG_RUNTIME_DIR = path.join(path.sep, "xdg-run");
    expect(sessionOwnerRegistryRoot())
      .toBe(path.join(path.sep, "xdg-run", "pi-fabric", "session-owners"));
    delete process.env.XDG_RUNTIME_DIR;
  });

  it("keys sidecars by the full path, so equal basenames never collide", () => {
    const root = registryRoot();
    const first = path.join(path.sep, "a", "20261108T120000_0197a7e4.jsonl");
    const second = path.join(path.sep, "b", "20261108T120000_0197a7e4.jsonl");
    expect(sessionOwnerSidecarPath(first, root)).not.toBe(sessionOwnerSidecarPath(second, root));
  });

  it("keeps a 24h sweep TTL", () => {
    expect(SESSION_OWNER_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("session owner acquisition", () => {
  it("claims cleanly with an O_EXCL-style atomic publish", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    const result = acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-a", pid: 111, registryRoot: root, probe: deadProbe(),
    });
    expect(result).toEqual({ status: "owner" });
    const text = sidecarText(root, file);
    expect(text).toContain("pid=111");
    expect(text).toContain("session=sid-a");
    expect(text).toMatch(/^pid=111\n/m);
    expect(readSessionOwners(file, { registryRoot: root, probe: () => true }))
      .toEqual([{ pid: 111, session: "sid-a", ts: expect.any(String), alive: true }]);
  });

  it("refuses a second open on a live owner and dumps every recorded owner", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-live", pid: 4242,
      registryRoot: root, probe: aliveProbe(),
    });
    // A dead earlier writer is still recorded beside the live one.
    fs.appendFileSync(
      sessionOwnerSidecarPath(file, root),
      formatOwnerRecord({ pid: 5150, ts: "2026-11-08T11:00:00.000Z" }),
    );
    let caught: unknown;
    try {
      acquireSessionOwnerLock({ sessionFile: file, pid: 999, registryRoot: root, probe: aliveProbe() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionOwnerConflictError);
    const conflict = caught as SessionOwnerConflictError;
    expect(conflict.sessionFile).toBe(file);
    // The dump carries every recorded writer with its liveness.
    expect(conflict.owners.map((owner) => [owner.pid, owner.alive])).toEqual([[4242, true], [5150, false]]);
    expect(conflict.message).toContain("pid=4242");
    expect(conflict.message).toContain("session=sid-live");
    expect(conflict.message).toContain("(dead)");
    expect(conflict.message).toContain("PI_FABRIC_ALLOW_LIVE_SESSION=1");
  });

  it("registers a forced second writer beside a live owner without displacing it", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    const allAlive = (): SessionOwnerProbe => () => true;
    acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-live", pid: 4242,
      registryRoot: root, probe: allAlive(),
    });
    const result = acquireSessionOwnerLock({
      sessionFile: file, pid: 999, registryRoot: root, probe: allAlive(), force: true,
    });
    expect(result).toEqual({
      status: "forced",
      owners: [
        expect.objectContaining({ pid: 4242, session: "sid-live", alive: true }),
        expect.objectContaining({ pid: 999, alive: true }),
      ],
    });
    // The original owner's registration survives the append untouched.
    expect(sidecarText(root, file).startsWith("pid=4242\nsession=sid-live\n")).toBe(true);
  });

  it("takes over a stale sidecar whose owner pid is dead", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-dead", pid: 5150,
      registryRoot: root, probe: deadProbe(),
    });
    const result = acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-new", pid: 111,
      registryRoot: root, probe: deadProbe(),
    });
    expect(result).toEqual({
      status: "took-over",
      displaced: [expect.objectContaining({ pid: 5150, alive: false })],
    });
    const text = sidecarText(root, file);
    expect(text).toContain("pid=111");
    expect(text).not.toContain("pid=5150");
  });

  it("reclaims a sidecar recording only the own pid (self verdict)", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe: deadProbe() });
    const result = acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe: deadProbe() });
    expect(result).toEqual({ status: "took-over", displaced: [expect.objectContaining({ pid: 111, alive: false })] });
  });

  it("race: one of two concurrent clean claims wins, the other sees a live owner", async () => {
    const root = registryRoot();
    const file = sessionFileIn();
    const probe = (pid: number): boolean => pid === 111 || pid === 999;
    const results = await Promise.allSettled([
      (async () => acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe }))(),
      (async () => acquireSessionOwnerLock({ sessionFile: file, pid: 999, registryRoot: root, probe }))(),
    ]);
    const statuses = results.map((result) =>
      result.status === "fulfilled" ? result.value.status : "rejected");
    expect(statuses.sort()).toEqual(["owner", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected!.reason).toBeInstanceOf(SessionOwnerConflictError);
    expect(sidecarText(root, file)).toMatch(/^pid=(111|999)\n/);
  });

  it("race: a fresh claim held by a concurrent taker blocks a second takeover (fail closed)", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 5150, registryRoot: root, probe: deadProbe() });
    fs.mkdirSync(`${sessionOwnerSidecarPath(file, root)}.claim`);
    // Fresh claim: respect it; the takeover loop must not publish over it and
    // must end in a refusal, never a silent second writer.
    expect(() =>
      acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe: deadProbe() }))
      .toThrow(SessionOwnerConflictError);
    // The stale owner's sidecar was not displaced behind the fresh claim.
    expect(sidecarText(root, file)).toContain("pid=5150");
  });

  it("race: an abandoned claim ages out and the takeover proceeds", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 5150, registryRoot: root, probe: deadProbe() });
    const claim = `${sessionOwnerSidecarPath(file, root)}.claim`;
    fs.mkdirSync(claim);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(claim, stale, stale);
    expect(acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe: deadProbe() }))
      .toEqual({ status: "took-over", displaced: [expect.objectContaining({ pid: 5150, alive: false })] });
    expect(fs.existsSync(claim)).toBe(false);
  });

  it("fails with SessionOwnerLockUnavailableError when the registry cannot exist", () => {
    const occupied = sessionFileIn();
    fs.writeFileSync(occupied, "not a directory"); // a plain file where the registry should be
    expect(() =>
      acquireSessionOwnerLock({ sessionFile: sessionFileIn(), registryRoot: occupied, probe: deadProbe() }))
      .toThrow(SessionOwnerLockUnavailableError);
  });
});

describe("session owner release", () => {
  it("is absent without a registration", () => {
    const root = registryRoot();
    expect(releaseSessionOwnerLock({ sessionFile: sessionFileIn(), pid: 111, registryRoot: root }))
      .toBe("absent");
  });

  it("unlinks the sidecar when the last writer leaves", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root, probe: deadProbe() });
    expect(releaseSessionOwnerLock({ sessionFile: file, pid: 111, registryRoot: root }))
      .toBe("released");
    expect(fs.existsSync(sessionOwnerSidecarPath(file, root))).toBe(false);
  });

  it("removes only the forced writer's record, keeping the original owner", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-live", pid: 4242,
      registryRoot: root, probe: aliveProbe(),
    });
    acquireSessionOwnerLock({
      sessionFile: file, sessionId: "sid-second", pid: 999,
      registryRoot: root, probe: aliveProbe(), force: true,
    });
    expect(releaseSessionOwnerLock({ sessionFile: file, pid: 999, registryRoot: root }))
      .toBe("co-owners-remain");
    const text = sidecarText(root, file);
    expect(text).toContain("pid=4242");
    expect(text).not.toContain("pid=999");
    expect(releaseSessionOwnerLock({ sessionFile: file, pid: 4242, registryRoot: root }))
      .toBe("released");
    expect(fs.existsSync(sessionOwnerSidecarPath(file, root))).toBe(false);
  });
});

describe("session owner sweep", () => {
  it("prunes only old sidecars whose pids are all dead", () => {
    const root = registryRoot();
    const deadFile = sessionFileIn();
    const liveFile = sessionFileIn();
    const freshFile = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: deadFile, pid: 5150, registryRoot: root, probe: deadProbe() });
    acquireSessionOwnerLock({ sessionFile: liveFile, pid: 4242, registryRoot: root, probe: aliveProbe() });
    acquireSessionOwnerLock({ sessionFile: freshFile, pid: 5151, registryRoot: root, probe: deadProbe() });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(sessionOwnerSidecarPath(deadFile, root), old, old);
    fs.utimesSync(sessionOwnerSidecarPath(liveFile, root), old, old);
    const removed = sweepSessionOwnerRegistry({ registryRoot: root, probe: aliveProbe() });
    expect(removed).toEqual([path.basename(sessionOwnerSidecarPath(deadFile, root))]);
    expect(fs.existsSync(sessionOwnerSidecarPath(liveFile, root))).toBe(true);
    expect(fs.existsSync(sessionOwnerSidecarPath(freshFile, root))).toBe(true);
  });
});

describe("worker claim policy", () => {
  it("stays off without the opt-in env flag or a session file", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    expect(claimWorkerSessionOwnerLock(file, {}, { registryRoot: root, probe: deadProbe() }))
      .toBeUndefined();
    expect(claimWorkerSessionOwnerLock(undefined, { [SESSION_OWNER_LOCK_ENV]: "1" }, { registryRoot: root }))
      .toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("claims and releases for the enabled worker", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    const claim = claimWorkerSessionOwnerLock(
      file, { [SESSION_OWNER_LOCK_ENV]: "1" }, { registryRoot: root, probe: deadProbe() },
    );
    expect(claim).toBeDefined();
    expect(sidecarText(root, file)).toContain(`pid=${process.pid}`);
    expect(claim!.release()).toBe("released");
    expect(fs.existsSync(sessionOwnerSidecarPath(file, root))).toBe(false);
  });

  it("fails closed on a live owner and fails open with a warning on a broken registry", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 4242, registryRoot: root, probe: aliveProbe() });
    expect(() => claimWorkerSessionOwnerLock(
      file, { [SESSION_OWNER_LOCK_ENV]: "1" }, { registryRoot: root, probe: aliveProbe() },
    )).toThrow(SessionOwnerConflictError);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const occupied = sessionFileIn();
    fs.writeFileSync(occupied, "not a directory");
    expect(claimWorkerSessionOwnerLock(
      file, { [SESSION_OWNER_LOCK_ENV]: "1" }, { registryRoot: occupied, probe: aliveProbe() },
    )).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("WITHOUT single-writer protection"));
  });

  it("honors the force override env", () => {
    const root = registryRoot();
    const file = sessionFileIn();
    acquireSessionOwnerLock({ sessionFile: file, pid: 4242, registryRoot: root, probe: aliveProbe() });
    const claim = claimWorkerSessionOwnerLock(
      file,
      { [SESSION_OWNER_LOCK_ENV]: "1", [SESSION_OWNER_FORCE_ENV]: "1" },
      { registryRoot: root, probe: aliveProbe() },
    );
    expect(claim).toBeDefined();
    expect(sidecarText(root, file)).toContain(`pid=${process.pid}`);
    expect(claim!.release()).toBe("co-owners-remain");
  });
});

describe("sessions configuration", () => {
  it("ships the owner lock off by default and normalizes the opt-in", () => {
    expect(normalizeFabricConfig({}).sessions).toEqual({ ownerLock: false });
    expect(normalizeFabricConfig({ sessions: { ownerLock: true } }).sessions).toEqual({ ownerLock: true });
    expect(normalizeFabricConfig({ sessions: { ownerLock: "yes" } }).sessions).toEqual({ ownerLock: false });
  });
});
