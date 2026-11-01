import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentTarget } from "../src/main-agent.js";
import { MeshStore } from "../src/mesh/store.js";
import { ResidencyClient } from "../src/residency/client.js";
import {
  RESIDENT_HOST_FORMAT,
  residentHostId,
  residentRoot,
  type ResidentHostConfig,
  type ResidentHostOwner,
} from "../src/residency/protocol.js";
import { normalizeScope, type FabricScope } from "../src/scope.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import type { FabricParticipantSource } from "../src/topology/types.js";

// A durable run belongs to the root session that spawned it, but its record
// lives in the project's mesh. These tests cover a later, different root
// session in the same project collecting it, and the boundary around that.

const hostPath = path.resolve("dist/residency/launcher.js");
const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");
const hasResidentHost = fs.existsSync(hostPath);
const roots: string[] = [];
const clients: ResidencyClient[] = [];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const detachedParticipants: FabricParticipantSource = {
  list: () => [],
  get: () => undefined,
  self: () => {
    throw new Error("not used by residency tests");
  },
  peers: () => [],
  async refresh() {},
  scheduleRefresh() {},
};

const mainTarget = (rootId: string): FabricMainAgentTarget => ({
  id: rootId,
  local: true,
  matches: (id) => id === "main" || id === rootId,
  info: () => {
    throw new Error("not used by residency tests");
  },
  deliverAgent: () => ({ queued: true, messageId: "unused", routed: "main" }),
});

const project = (name: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-${name}-`));
  roots.push(root);
  return root;
};

const sessionConfig = (projectRoot: string, session: string): ResidentHostConfig => {
  const meshRoot = path.join(projectRoot, "mesh");
  const rootId = `session:${session}`;
  return {
    format: RESIDENT_HOST_FORMAT,
    rootId,
    sessionId: session,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    meshRoot,
    actorRoot: path.join(meshRoot, "actors"),
    sessionActorRoot: path.join(meshRoot, "actors", session),
    residencyRoot: residentRoot(meshRoot, rootId),
    fullCodeMode: true,
    agents: { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000 },
    mesh: { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
    retention: DEFAULT_FABRIC_CONFIG.retention,
    workerPath: fakeWorker,
    fabricExtensionPath: path.resolve("dist/index.js"),
    piBinary: "pi",
    claudeBinary: "claude",
    vedaBinary: "veda",
    piModels: { available: [{ provider: "provider", id: "visible", name: "Visible" }], aliases: {}, defaultModel: "provider/visible" },
  };
};

const sessionClient = (
  config: ResidentHostConfig,
  callerScope?: () => FabricScope | undefined,
): ResidencyClient => {
  const mesh = new MeshStore(config.meshRoot, config.mesh.maxEventBytes, config.mesh.maxReadEvents);
  const client = new ResidencyClient({
    config,
    mesh,
    participants: detachedParticipants,
    mainAgent: mainTarget(config.rootId),
    hostPath,
    ...(callerScope ? { callerScope } : {}),
  });
  clients.push(client);
  return client;
};

interface SeededRun {
  id: string;
  runDirectory: string;
  metadataPath: string;
  statusPath: string;
  result: Record<string, unknown>;
}

/** Write the files a resident host leaves for one durable run of `owner`. */
const seedRun = (
  owner: ResidentHostConfig,
  options: { id?: string; status?: string; scope?: FabricScope; text?: string } = {},
): SeededRun => {
  const id = options.id ?? "b".repeat(32);
  const runDirectory = path.join(owner.residencyRoot, "runs", id);
  const agentsPath = path.join(owner.residencyRoot, "agents");
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.mkdirSync(agentsPath, { recursive: true });
  const result = {
    id, name: "earlier durable worker", status: options.status ?? "completed", text: options.text ?? "result from the earlier session",
    task: "work", runner: "pi", transport: "process", cwd: process.cwd(), startedAt: 1, updatedAt: 2, finishedAt: 2,
    turns: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
  const statusPath = path.join(runDirectory, "status.json");
  fs.writeFileSync(statusPath, JSON.stringify(result));
  fs.writeFileSync(path.join(runDirectory, "events.jsonl"), `${JSON.stringify({ type: "agent_end" })}\n`);
  const metadataPath = path.join(agentsPath, `${id}.json`);
  fs.writeFileSync(metadataPath, JSON.stringify({
    format: RESIDENT_HOST_FORMAT, rootId: owner.rootId, id, runDirectory, handle: result,
    ...(options.scope ? { scope: options.scope } : {}), createdAt: 1, updatedAt: 2,
  }));
  return { id, runDirectory, metadataPath, statusPath, result };
};

/** Publish this test process as `owner`'s live resident host. */
const fakeLiveOwner = (owner: ResidentHostConfig): void => {
  const record: ResidentHostOwner = {
    format: RESIDENT_HOST_FORMAT,
    hostId: residentHostId(owner.rootId),
    pid: process.pid,
    token: "test-owner",
    startedAt: Date.now(),
    readyAt: Date.now(),
  };
  fs.mkdirSync(owner.residencyRoot, { recursive: true });
  fs.writeFileSync(path.join(owner.residencyRoot, "owner.json"), JSON.stringify(record));
};

const stopResidents = async (projectRoot: string): Promise<void> => {
  const residency = path.join(projectRoot, "mesh", "residency");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(residency);
  } catch {
    return;
  }
  for (const entry of entries) {
    const ownerPath = path.join(residency, entry, "owner.json");
    let owner: ResidentHostOwner | undefined;
    try {
      owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as ResidentHostOwner;
    } catch {
      continue;
    }
    if (!owner?.pid || owner.pid === process.pid) continue;
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      continue;
    }
    const deadline = Date.now() + 5_000;
    while (fs.existsSync(ownerPath) && Date.now() < deadline) await delay(25);
  }
};

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) {
    await stopResidents(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const alice = normalizeScope({ principal: { id: "user:alice" }, grants: [{ resource: "fs:/repo/**", actions: ["read"] }] });

describe("a durable run collected by a later session in the same project", () => {
  it("waits for and reads a result that an earlier session started", async () => {
    const root = project("project-run-collect");
    const earlier = sessionConfig(root, "earlier");
    const seeded = seedRun(earlier);
    const later = sessionClient(sessionConfig(root, "later"));

    // The run is not the later session's own: cleanup and completion receipts stay with its owner.
    expect(later.hasAgent(seeded.id)).toBe(false);
    expect(later.hasProjectAgent(seeded.id)).toBe(true);
    await expect(later.waitProjectAgent(seeded.id)).resolves.toMatchObject({
      id: seeded.id, status: "completed", residency: "durable", text: "result from the earlier session",
    });
    expect(later.statusAgent(seeded.id)).toMatchObject({ status: "completed", text: "result from the earlier session" });
    expect(later.readAgentLog(seeded.id).events.map((line) => line.raw)).toEqual([JSON.stringify({ type: "agent_end" })]);
    // Reading never writes into the owner's residency root.
    expect(JSON.parse(fs.readFileSync(seeded.metadataPath, "utf8")).completionConsumedAt).toBeUndefined();
    await expect(later.cleanupAgent(seeded.id)).rejects.toThrow(/Unknown durable Fabric agent/);
    expect(fs.existsSync(seeded.runDirectory)).toBe(true);
  });

  it("waits until the owning session's resident host settles the run", async () => {
    const root = project("project-run-pending");
    const earlier = sessionConfig(root, "earlier");
    const seeded = seedRun(earlier, { status: "running" });
    fakeLiveOwner(earlier);
    const later = sessionClient(sessionConfig(root, "later"));

    // Only the poll timer is virtual, so the wait advances only when the test says so.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = later.waitProjectAgent(seeded.id);
    let settled = false;
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    fs.writeFileSync(seeded.statusPath, JSON.stringify({ ...seeded.result, status: "completed", text: "settled later" }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toMatchObject({ status: "completed", text: "settled later" });
  });

  it("fails the wait instead of hanging when the owning session's resident host is gone", async () => {
    const root = project("project-run-orphan");
    const earlier = sessionConfig(root, "earlier");
    const seeded = seedRun(earlier, { status: "running" });
    const later = sessionClient(sessionConfig(root, "later"));

    // With no live host the wait fails on its first read; it never sleeps, so a hang is a test timeout.
    await expect(later.waitProjectAgent(seeded.id)).rejects.toThrow(
      /resident host of the session that started it is not running, so it cannot finish/,
    );
    // Only a hosted run is re-attached when its owner resumes.
    fs.writeFileSync(seeded.statusPath, JSON.stringify({ ...seeded.result, status: "running", hosted: { locator: {} } }));
    await expect(later.waitProjectAgent(seeded.id)).rejects.toThrow(/resume that session to re-attach it/);
  });

  it("re-checks the run record on every poll of a wait", async () => {
    const root = project("project-run-revoked");
    const earlier = sessionConfig(root, "earlier");
    const seeded = seedRun(earlier, { status: "running" });
    fakeLiveOwner(earlier);
    const later = sessionClient(sessionConfig(root, "later"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = later.waitProjectAgent(seeded.id);
    void waiting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    // The record went away while the owner's host stays live: the wait must not keep polling.
    fs.rmSync(seeded.metadataPath);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).rejects.toThrow(/Unknown durable Fabric agent/);
  });

  it("keeps a run from another project unknown", async () => {
    const owner = sessionConfig(project("project-run-owner"), "earlier");
    const seeded = seedRun(owner);
    const other = sessionClient(sessionConfig(project("project-run-other"), "later"));

    expect(other.hasProjectAgent(seeded.id)).toBe(false);
    expect(() => other.statusAgent(seeded.id)).toThrow(/Unknown durable Fabric agent/);
    await expect(other.waitProjectAgent(seeded.id)).rejects.toThrow(/Unknown durable Fabric agent/);
    expect(() => other.readAgentLog(seeded.id)).toThrow(/Unknown durable Fabric agent/);
  });

  it("keeps a scoped run unknown to a session whose scope does not cover it", async () => {
    const root = project("project-run-scope");
    const earlier = sessionConfig(root, "earlier");
    const scoped = seedRun(earlier, { id: "c".repeat(32), scope: alice });
    const unscoped = seedRun(earlier, { id: "d".repeat(32) });
    const later = sessionConfig(root, "later");
    const bob = normalizeScope({ principal: { id: "user:bob" }, grants: [{ resource: "fs:/repo/**", actions: ["read"] }] });
    const narrowerAlice = normalizeScope({ principal: { id: "user:alice" }, grants: [{ resource: "fs:/repo/src/**", actions: ["read"] }] });
    const widerAlice = normalizeScope({ principal: { id: "user:alice" }, grants: [{ resource: "fs:*", actions: ["read", "write"] }] });

    const asBob = sessionClient(later, () => bob);
    expect(asBob.hasProjectAgent(scoped.id)).toBe(false);
    expect(() => asBob.statusAgent(scoped.id)).toThrow(/Unknown durable Fabric agent/);
    await expect(asBob.waitProjectAgent(scoped.id)).rejects.toThrow(/Unknown durable Fabric agent/);
    expect(sessionClient(later, () => narrowerAlice).hasProjectAgent(scoped.id)).toBe(false);
    // A run launched without a scope had host authority; no scoped session reads it.
    expect(sessionClient(later, () => widerAlice).hasProjectAgent(unscoped.id)).toBe(false);

    expect(sessionClient(later, () => widerAlice).hasProjectAgent(scoped.id)).toBe(true);
    expect(sessionClient(later, () => alice).hasProjectAgent(scoped.id)).toBe(true);
    expect(sessionClient(later, () => undefined).hasProjectAgent(scoped.id)).toBe(true);
    // A session whose scope issuance failed reads nothing.
    expect(sessionClient(later, () => { throw new Error("issuance failed"); }).hasProjectAgent(unscoped.id)).toBe(false);
  });

  it("ignores run records that are not bound to the residency directory holding them", () => {
    const root = project("project-run-tamper");
    const earlier = sessionConfig(root, "earlier");
    const elsewhere = sessionConfig(root, "elsewhere");
    const later = sessionClient(sessionConfig(root, "later"));

    // Metadata claiming another root than the directory it sits in.
    const moved = seedRun(earlier, { id: "e".repeat(32) });
    fs.writeFileSync(moved.metadataPath, JSON.stringify({
      ...JSON.parse(fs.readFileSync(moved.metadataPath, "utf8")), rootId: elsewhere.rootId,
    }));
    expect(later.hasProjectAgent(moved.id)).toBe(false);

    // A run directory outside the owner's residency root.
    const escaped = seedRun(earlier, { id: "f".repeat(32) });
    const outside = path.join(root, "outside", escaped.id);
    fs.mkdirSync(outside, { recursive: true });
    fs.copyFileSync(escaped.statusPath, path.join(outside, "status.json"));
    fs.writeFileSync(escaped.metadataPath, JSON.stringify({
      ...JSON.parse(fs.readFileSync(escaped.metadataPath, "utf8")), runDirectory: outside,
    }));
    expect(later.hasProjectAgent(escaped.id)).toBe(false);

    // A residency entry that is a symbolic link to another directory.
    const linkedProject = sessionConfig(project("project-run-link"), "linked");
    const linked = seedRun(linkedProject, { id: "1".repeat(32) });
    const link = residentRoot(earlier.meshRoot, linkedProject.rootId);
    fs.symlinkSync(linkedProject.residencyRoot, link, "dir");
    // Point the record through the link, so only the link itself gives it away.
    fs.writeFileSync(linked.metadataPath, JSON.stringify({
      ...JSON.parse(fs.readFileSync(linked.metadataPath, "utf8")), runDirectory: path.join(link, "runs", linked.id),
    }));
    expect(later.hasProjectAgent(linked.id)).toBe(false);
  });
});

describe.skipIf(!hasResidentHost || process.platform === "win32")("a real resident host", () => {
  it("lets a new session collect a durable result after the spawning session closed", { timeout: 45_000 }, async () => {
    const root = project("project-run-real-host");
    const earlierConfig = sessionConfig(root, "earlier");
    // spawnAgent waits until the host publishes the participant; read it from the mesh.
    const mesh = new MeshStore(earlierConfig.meshRoot, earlierConfig.mesh.maxEventBytes, earlierConfig.mesh.maxReadEvents);
    const identity = { id: earlierConfig.rootId, name: "main", kind: "main" as const, sessionId: "earlier" };
    const directory = new ParticipantDirectory(mesh, { enabled: true, hostId: identity.id, rootId: identity.id, identity, heartbeatMs: 50, leaseMs: 300 });
    await directory.start();
    const spawning = new ResidencyClient({
      config: earlierConfig, mesh, participants: directory, mainAgent: mainTarget(earlierConfig.rootId), hostPath,
    });
    clients.push(spawning);
    try {
      const handle = await spawning.spawnAgent({ task: "STREAM_PREVIEW", transport: "process", residency: "durable" });
      await spawning.close();
      await directory.close();

      const later = sessionClient(sessionConfig(root, "later"));
      expect(later.hasAgent(handle.id)).toBe(false);
      expect(later.hasProjectAgent(handle.id)).toBe(true);
      await expect(later.waitProjectAgent(handle.id)).resolves.toMatchObject({
        id: handle.id, status: "completed", residency: "durable", text: "stream preview complete",
      });
    } finally {
      await directory.close();
    }
  });
});
