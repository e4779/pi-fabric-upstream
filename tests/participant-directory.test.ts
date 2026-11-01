import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import type { FabricParticipantRecord } from "../src/topology/types.js";

const roots: string[] = [];
const directories: ParticipantDirectory[] = [];

const rootRecord = (
  id: string,
  hostId: string,
  sessionId: string,
): FabricParticipantRecord => ({
  format: 1,
  id,
  kind: "root",
  rootId: id,
  ownerHostId: hostId,
  ownerIdentityId: hostId,
  name: "main",
  status: "idle",
  runner: "pi",
  transport: "host",
  capabilities: ["steer", "followUp", "fabric"],
  cwd: "/tmp/project",
  sessionId,
  startedAt: 1,
  updatedAt: 2,
  pendingMessages: false,
  controlProtocol: "v1",
});

const agentRecord = (
  id: string,
  rootId: string,
  hostId: string,
  parentId: string,
): FabricParticipantRecord => ({
  format: 1,
  id,
  kind: "agent",
  rootId,
  ownerHostId: hostId,
  ownerIdentityId: hostId,
  parentId,
  name: id,
  status: "running",
  runner: "pi",
  transport: "process",
  capabilities: ["steer", "followUp", "stop"],
  cwd: "/tmp/project",
  startedAt: 3,
  updatedAt: 4,
  controlProtocol: "v1",
});

const createDirectory = (
  meshRoot: string,
  identity: MeshIdentity,
  rootId: string,
  source: () => FabricParticipantRecord[],
): ParticipantDirectory => {
  const hostId = identity.kind === "main" ? identity.id : "runtime:" + identity.sessionId;
  const directory = new ParticipantDirectory(
    new MeshStore(meshRoot, 64 * 1024, 1_000),
    { enabled: true, hostId, rootId, identity, heartbeatMs: 100, leaseMs: 300 },
  );
  directory.registerSource(source);
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => directory.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ParticipantDirectory", () => {
  it("builds one project topology while preserving local ownership and lineage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const alphaIdentity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const betaIdentity: MeshIdentity = {
      id: "session:beta",
      name: "main",
      kind: "main",
      sessionId: "beta",
    };
    const recursiveIdentity: MeshIdentity = {
      id: "agent:recursive",
      name: "recursive",
      kind: "agent",
      sessionId: "recursive-session",
    };
    const alpha = createDirectory(meshRoot, alphaIdentity, alphaIdentity.id, () => [
      rootRecord(alphaIdentity.id, alphaIdentity.id, "alpha"),
      agentRecord("agent:alpha-child", alphaIdentity.id, alphaIdentity.id, alphaIdentity.id),
    ]);
    const beta = createDirectory(meshRoot, betaIdentity, betaIdentity.id, () => [
      rootRecord(betaIdentity.id, betaIdentity.id, "beta"),
    ]);
    const recursive = createDirectory(meshRoot, recursiveIdentity, alphaIdentity.id, () => [
      agentRecord(
        "agent:grandchild",
        alphaIdentity.id,
        "runtime:recursive-session",
        recursiveIdentity.id,
      ),
    ]);

    await alpha.start();
    await beta.start();
    await recursive.start();

    expect(alpha.list({ scope: "project" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "session:beta",
      "agent:alpha-child",
      "agent:grandchild",
    ]);
    expect(alpha.list({ scope: "local" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "agent:alpha-child",
    ]);
    expect(alpha.list({ scope: "lineage" }).map(({ id }) => id)).toEqual([
      "session:alpha",
      "agent:alpha-child",
      "agent:grandchild",
    ]);
    expect(alpha.sessions()).toMatchObject([
      { id: "session:alpha", kind: "root", local: true },
      { id: "session:beta", kind: "root", local: false },
    ]);
    expect(alpha.peers()).toMatchObject([
      { id: "session:beta", name: "PRO-2", label: "PRO-2", kind: "peer", local: false },
    ]);
    expect(recursive.self()).toMatchObject({
      id: "agent:recursive",
      kind: "agent",
      rootId: "session:alpha",
    });
  });

  it("withdraws control capabilities before releasing its live host lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:quiesce",
      name: "main",
      kind: "main",
      sessionId: "quiesce",
    };
    const directory = createDirectory(path.join(root, "mesh"), identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "quiesce"),
      agentRecord("agent:quiesce", identity.id, identity.id, identity.id),
    ]);

    await directory.start();
    await directory.quiesce();

    expect(directory.get("agent:quiesce")).toMatchObject({
      capabilities: [],
      local: true,
      stale: false,
    });
    expect(directory.mesh.get("sessions/quiesce")).toBeUndefined();
  });

  it("stamps the host lease after participant writes that outlast it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:slow",
      name: "main",
      kind: "main",
      sessionId: "slow",
    };
    const directory = createDirectory(path.join(root, "mesh"), identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "slow"),
      agentRecord("agent:slow", identity.id, identity.id, identity.id),
    ]);
    const publish = directory.mesh.put.bind(directory.mesh);
    // A contended Windows mesh makes each participant write outlast the 300ms
    // lease; the host lease must still be fresh once the refresh completes.
    vi.spyOn(directory.mesh, "put").mockImplementation(async (input) => {
      if (input.key.startsWith("topology/participants/")) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return publish(input);
    });

    await directory.start();

    expect(directory.get("agent:slow")).toMatchObject({
      capabilities: ["steer", "followUp", "stop"],
      local: true,
      stale: false,
    });
  });

  it("does not claim an actor still owned by a live legacy root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const mesh = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const oldIdentity: MeshIdentity = {
      id: "session:old",
      name: "main",
      kind: "main",
      sessionId: "old-session",
    };
    const session = await mesh.put({
      key: "sessions/old-session",
      value: {
        id: oldIdentity.id,
        name: "Peer old-sess",
        kind: "peer",
        status: "idle",
        runner: "pi",
        transport: "host",
        cwd: "/tmp/project",
        sessionId: "old-session",
        startedAt: 1,
        updatedAt: Date.now(),
        pendingMessages: false,
        local: false,
      },
      identity: oldIdentity,
    });
    await mesh.put({
      key: "actors/old-session/actor:legacy",
      value: {
        id: "actor:legacy",
        name: "legacy actor",
        status: "idle",
        runner: "pi",
        createdAt: 1,
      },
      identity: oldIdentity,
    });
    const identity: MeshIdentity = {
      id: "session:new",
      name: "main",
      kind: "main",
      sessionId: "new-session",
    };
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "new-session"),
      {
        ...agentRecord("actor:legacy", identity.id, identity.id, identity.id),
        kind: "actor",
        transport: "host",
      },
    ]);

    await directory.start();
    expect(directory.get("actor:legacy")).toMatchObject({
      ownerHostId: oldIdentity.id,
      controlProtocol: "legacy",
      local: false,
    });

    await mesh.delete({ key: session.key, ifVersion: session.version });
    await directory.refresh();
    expect(directory.get("actor:legacy")).toMatchObject({
      ownerHostId: identity.id,
      controlProtocol: "v1",
      local: true,
    });
  });

  it("never shares agent prompts, results, or errors in participant state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:private",
      name: "main",
      kind: "main",
      sessionId: "private",
    };
    const directory = createDirectory(path.join(root, "mesh"), identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "private"),
      {
        ...agentRecord("agent:private", identity.id, identity.id, identity.id),
        task: "secret prompt",
        text: "secret result",
        error: "secret failure",
      } as FabricParticipantRecord,
      agentRecord("agent:wrong-lineage", "session:foreign", identity.id, identity.id),
    ]);

    await directory.start();
    expect(directory.mesh.get("sessions/private")?.value).toMatchObject({
      id: identity.id,
      kind: "peer",
    });
    const participant = directory.get("agent:private") as unknown as Record<string, unknown>;
    expect(participant).not.toHaveProperty("task");
    expect(participant).not.toHaveProperty("text");
    expect(participant).not.toHaveProperty("error");
    expect(directory.get("agent:wrong-lineage")).toBeUndefined();
    expect(
      JSON.stringify(directory.mesh.listAll("topology/participants/")),
    ).not.toContain("secret");

    await directory.mesh.put({
      key: "topology/participants/not-a-canonical-hash",
      value: {
        ...agentRecord("agent:forged", identity.id, identity.id, identity.id),
        ownerIdentityId: identity.id,
      },
      identity,
    });
    expect(directory.get("agent:forged")).toBeUndefined();
    await directory.mesh.put({
      key: "sessions/claimed",
      value: {
        id: "session:victim",
        sessionId: "claimed",
        cwd: "/tmp/project",
        status: "idle",
        startedAt: 1,
      },
      identity,
    });
    expect(directory.get("session:victim")).toBeUndefined();
  });

  it("keeps one live execution owner for a colliding participant id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const alphaIdentity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const betaIdentity: MeshIdentity = {
      id: "session:beta",
      name: "main",
      kind: "main",
      sessionId: "beta",
    };
    const shared = (identity: MeshIdentity): FabricParticipantRecord => ({
      ...agentRecord("actor:shared", identity.id, identity.id, identity.id),
      kind: "actor",
      transport: "host",
    });
    const alpha = createDirectory(meshRoot, alphaIdentity, alphaIdentity.id, () => [
      rootRecord(alphaIdentity.id, alphaIdentity.id, "alpha"),
      shared(alphaIdentity),
    ]);
    const beta = createDirectory(meshRoot, betaIdentity, betaIdentity.id, () => [
      rootRecord(betaIdentity.id, betaIdentity.id, "beta"),
      shared(betaIdentity),
    ]);

    await alpha.start();
    // Mesh writes can lag a fresh enumeration on CI-bound filesystems
    // (Windows readdir caching): beta's first refresh relies on the occupancy
    // guard seeing alpha's records, so wait until beta's on-disk mesh view
    // actually contains alpha before contention starts — otherwise a blind
    // first write can converge on the wrong owner and never self-correct.
    await vi.waitFor(
      () => {
        expect(beta.mesh.listAll("topology/participants/").length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5_000, interval: 50 },
    );
    await beta.start();
    expect(beta.get("actor:shared")).toMatchObject({ ownerHostId: "session:alpha" });

    await alpha.close();
    // The takeover itself is another write-then-readback hop: poll refresh +
    // read until the delete propagates and beta claims the record.
    await vi.waitFor(
      async () => {
        await beta.refresh();
        expect(beta.get("actor:shared")).toMatchObject({ ownerHostId: "session:beta" });
      },
      { timeout: 5_000, interval: 50 },
    );
  });

  it("hides every participant owned by an expired host lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const identity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "alpha"),
      agentRecord("agent:child", identity.id, identity.id, identity.id),
    ]);
    await directory.start();

    // Same filesystem readback lag: poll until the fresh enumeration shows
    // both records instead of asserting one shot.
    await vi.waitFor(() => expect(directory.list({ scope: "project" })).toHaveLength(2), {
      timeout: 5_000,
      interval: 50,
    });
    expect(directory.list({ scope: "project" }, Date.now() + 1_000)).toEqual([]);
    const stale = directory.list(
      { scope: "project", includeStale: true },
      Date.now() + 1_000,
    );
    expect(stale).toHaveLength(2);
    expect(stale.every((participant) => participant.stale)).toBe(true);
  });

  it("reads live participants and cold self records without enumerating the directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:direct", name: "main", kind: "main", sessionId: "direct",
    };
    const meshRoot = path.join(root, "mesh");
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "direct"),
      agentRecord("agent:direct", identity.id, identity.id, identity.id),
    ]);
    await directory.start();
    const expected = directory.list({ scope: "project" });
    const scans = vi.spyOn(directory.mesh, "listAll");
    const child = directory.get("agent:direct")!;
    expect(child).toEqual(expected.find((entry) => entry.id === "agent:direct"));
    expect(directory.get("main")).toEqual(expected.find((entry) => entry.id === identity.id));
    expect(scans).not.toHaveBeenCalled();
    child.capabilities.push("ask");
    expect(directory.get("agent:direct")?.capabilities).not.toContain("ask");

    const cold = createDirectory(meshRoot, identity, identity.id, () => []);
    const coldScans = vi.spyOn(cold.mesh, "listAll");
    expect(cold.self()).toMatchObject({ id: identity.id, local: true, stale: false });
    expect(coldScans).not.toHaveBeenCalled();

    const writer = new MeshStore(meshRoot, 64 * 1024, 1_000);
    const host = writer.listAll("topology/hosts/")[0]!;
    await writer.put({ key: host.key, value: { ...(host.value as object), expiresAt: 0 }, identity });
    expect(directory.get("agent:direct")).toBeUndefined();
  });

  it("does not alias distinct participant IDs with the same UTF-8 hash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:utf8", name: "main", kind: "main", sessionId: "utf8",
    };
    const meshRoot = path.join(root, "mesh");
    const storedId = "agent:\ufffd", requestedId = "agent:\ud800";
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "utf8"),
      agentRecord(storedId, identity.id, identity.id, identity.id),
    ]);
    await directory.start();
    expect(directory.get(storedId)?.id).toBe(storedId);
    expect(directory.get(requestedId)).toBeUndefined();

    const alias = createDirectory(meshRoot, {
      id: requestedId, name: "alias", kind: "agent", sessionId: "alias",
    }, identity.id, () => []);
    expect(alias.self().id).toBe(requestedId);
  });

  it("keeps the same topology API in local-only mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const identity: MeshIdentity = {
      id: "session:local",
      name: "main",
      kind: "main",
      sessionId: "local",
    };
    const directory = new ParticipantDirectory(
      new MeshStore(path.join(root, "mesh"), 64 * 1024, 100),
      { enabled: false, hostId: identity.id, rootId: identity.id, identity },
    );
    directories.push(directory);
    directory.registerSource(() => [
      rootRecord(identity.id, identity.id, "local"),
      agentRecord("agent:local", identity.id, identity.id, identity.id),
    ]);
    await directory.start();

    expect(directory.list({ scope: "project" }).map(({ id }) => id)).toEqual([
      "session:local",
      "agent:local",
    ]);
  });

  it("recovers via heartbeat when the initial publish fails at startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-topology-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const identity: MeshIdentity = {
      id: "session:alpha",
      name: "main",
      kind: "main",
      sessionId: "alpha",
    };
    const directory = createDirectory(meshRoot, identity, identity.id, () => [
      rootRecord(identity.id, identity.id, "alpha"),
    ]);
    let failures = 1;
    const publish = directory.mesh.put.bind(directory.mesh);
    vi.spyOn(directory.mesh, "put").mockImplementation(async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mesh offline");
      }
      return publish(input);
    });

    await expect(directory.start()).rejects.toThrow("mesh offline");

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && directory.mesh.listAll("topology/hosts/").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(directory.mesh.listAll("topology/hosts/")).toHaveLength(1);
    expect(directory.mesh.listAll("topology/participants/")).toHaveLength(1);
  });
});

const sessionIdentity = (name: string): MeshIdentity => ({
  id: `session:${name}`,
  name: "main",
  kind: "main",
  sessionId: name,
});

const createSession = (
  meshRoot: string,
  name: string,
  options: { departedLimit?: number; departedRetentionMs?: number } = {},
): ParticipantDirectory => {
  const identity = sessionIdentity(name);
  const directory = new ParticipantDirectory(new MeshStore(meshRoot, 64 * 1024, 1_000), {
    enabled: true,
    hostId: identity.id,
    rootId: identity.id,
    identity,
    heartbeatMs: 100,
    leaseMs: 300,
    ...options,
  });
  directory.registerSource(() => [
    { ...rootRecord(identity.id, identity.id, name), label: `PRJ-${name}` },
    agentRecord(`agent:${name}-child`, identity.id, identity.id, identity.id),
  ]);
  directories.push(directory);
  return directory;
};

const meshRootFor = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-departed-"));
  roots.push(root);
  return path.join(root, "mesh");
};

describe("ParticipantDirectory departed sessions", () => {
  it("replaces a closed root with a stopped tombstone that live discovery never returns", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    const leaving = createSession(meshRoot, "leaving");
    await viewer.start();
    await leaving.start();
    await vi.waitFor(() => expect(viewer.sessions().map((item) => item.id)).toContain("session:leaving"), {
      timeout: 5_000,
      interval: 50,
    });
    expect(viewer.departed()).toEqual([]);

    const before = Date.now();
    await leaving.close();
    const after = Date.now();

    await vi.waitFor(() => expect(viewer.departed()).toHaveLength(1), { timeout: 5_000, interval: 50 });
    const [stopped] = viewer.departed();
    expect(stopped).toMatchObject({
      id: "session:leaving",
      kind: "root",
      status: "stopped",
      sessionId: "leaving",
      cwd: "/tmp/project",
      label: "PRJ-leaving",
      ownerIdentityId: "session:leaving",
    });
    expect(stopped!.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(stopped!.lastSeenAt).toBeLessThanOrEqual(after);
    // Only the root is tombstoned; the child agent simply leaves.
    expect(viewer.departed().map((item) => item.id)).not.toContain("agent:leaving-child");
    // Live discovery is unchanged: the record is gone, even with includeStale.
    const everything = viewer.list({ scope: "project", includeStale: true }).map((item) => item.id);
    expect(everything).not.toContain("session:leaving");
    expect(viewer.peers().map((peer) => peer.id)).not.toContain("session:leaving");
  });

  it("reports a root whose lease expired without closing as lost, with its last heartbeat", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    const crashed = createSession(meshRoot, "crashed");
    await viewer.start();
    await crashed.start();
    await vi.waitFor(() => expect(viewer.sessions().map((item) => item.id)).toContain("session:crashed"), {
      timeout: 5_000,
      interval: 50,
    });
    // While the lease holds, the session is live, not departed.
    expect(viewer.departed()).toEqual([]);

    const hosts = viewer.mesh.listAll("topology/hosts/").map((entry) => entry.value as { id: string; updatedAt: number });
    const heartbeat = hosts.find((host) => host.id === "session:crashed")!.updatedAt;
    const later = Date.now() + 60_000;
    const lost = viewer.departed({}, later);
    expect(lost.map((item) => item.id)).toEqual(["session:crashed"]);
    expect(lost[0]).toMatchObject({ status: "lost", sessionId: "crashed", label: "PRJ-crashed" });
    expect(lost[0]!.lastSeenAt).toBeGreaterThanOrEqual(heartbeat);
    // The viewer's own root is never reported as departed.
    expect(lost.map((item) => item.id)).not.toContain("session:viewer");
  });

  it("drops a tombstone from departed once the same root is live again", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    await viewer.start();
    const first = createSession(meshRoot, "resumed");
    await first.start();
    await first.close();
    await vi.waitFor(() => expect(viewer.departed().map((item) => item.id)).toEqual(["session:resumed"]), {
      timeout: 5_000,
      interval: 50,
    });
    const second = createSession(meshRoot, "resumed");
    await second.start();
    await vi.waitFor(() => expect(viewer.sessions().map((item) => item.id)).toContain("session:resumed"), {
      timeout: 5_000,
      interval: 50,
    });
    expect(viewer.departed()).toEqual([]);
  });

  it("reports a root lost after a resume over its older stopped tombstone", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    await viewer.start();
    const first = createSession(meshRoot, "resumed");
    await first.start();
    await first.close();
    await vi.waitFor(() => expect(viewer.departed().map((item) => item.status)).toEqual(["stopped"]), {
      timeout: 5_000,
      interval: 50,
    });
    const stoppedAt = viewer.departed()[0]!.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = createSession(meshRoot, "resumed");
    await second.start();
    await vi.waitFor(() => expect(viewer.sessions().map((item) => item.id)).toContain("session:resumed"), {
      timeout: 5_000,
      interval: 50,
    });
    // The resumed session never closes; once its lease expires it is lost, not stopped.
    const lost = viewer.departed({}, Date.now() + 60_000);
    expect(lost.map((item) => item.id)).toEqual(["session:resumed"]);
    expect(lost[0]).toMatchObject({ status: "lost" });
    expect(lost[0]!.lastSeenAt).toBeGreaterThan(stoppedAt);
  });

  it("prunes tombstones beyond the configured count and age", async () => {
    const meshRoot = meshRootFor();
    for (const name of ["one", "two", "three"]) {
      const session = createSession(meshRoot, name, { departedLimit: 2 });
      await session.start();
      await session.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const viewer = createSession(meshRoot, "viewer", { departedLimit: 2, departedRetentionMs: 60_000 });
    await viewer.start();
    await vi.waitFor(() => expect(viewer.mesh.listAll("topology/tombstones/")).toHaveLength(2), {
      timeout: 5_000,
      interval: 50,
    });
    expect(viewer.departed().map((item) => item.id)).toEqual(["session:three", "session:two"]);
    expect(viewer.departed({ limit: 1 }).map((item) => item.id)).toEqual(["session:three"]);
    expect(viewer.departed({}, Date.now() + 61_000)).toEqual([]);
  });

  it("writes no tombstone when the limit is zero", async () => {
    const meshRoot = meshRootFor();
    const session = createSession(meshRoot, "silent", { departedLimit: 0 });
    await session.start();
    await session.close();
    expect(session.mesh.listAll("topology/tombstones/")).toEqual([]);
  });

  it("keeps other sessions' tombstones when a session with limit zero closes", async () => {
    const meshRoot = meshRootFor();
    const departed = createSession(meshRoot, "departed");
    await departed.start();
    await departed.close();
    const silent = createSession(meshRoot, "silent", { departedLimit: 0 });
    await silent.start();
    expect(silent.mesh.listAll("topology/tombstones/")).toHaveLength(1);
    // A write limit of 0 does not hide other sessions' departures from reads.
    expect(silent.departed().map((item) => item.id)).toEqual(["session:departed"]);
    await silent.close();
    expect(silent.mesh.listAll("topology/tombstones/")).toHaveLength(1);
  });

  it("ignores a tombstone written by an identity other than its owner", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    await viewer.start();
    const victim = createSession(meshRoot, "victim");
    await victim.start();
    await victim.close();
    await vi.waitFor(() => expect(viewer.departed()).toHaveLength(1), { timeout: 5_000, interval: 50 });
    const [entry] = viewer.mesh.listAll("topology/tombstones/");
    await viewer.mesh.put({
      key: entry!.key,
      value: { ...(entry!.value as object), cwd: "/forged" },
      identity: sessionIdentity("forger"),
    });
    expect(viewer.departed()).toEqual([]);
  });

  it("keeps tombstones out of the live discovery path", async () => {
    const meshRoot = meshRootFor();
    const viewer = createSession(meshRoot, "viewer");
    await viewer.start();
    const gone = createSession(meshRoot, "gone");
    await gone.start();
    await gone.close();
    await vi.waitFor(() => expect(viewer.departed()).toHaveLength(1), { timeout: 5_000, interval: 50 });
    const listAll = vi.spyOn(viewer.mesh, "listAll");
    viewer.list({ scope: "project", includeStale: true });
    viewer.sessions();
    viewer.peers();
    viewer.get("session:gone");
    await viewer.refresh();
    const prefixes = listAll.mock.calls.map(([prefix]) => prefix);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.filter((prefix) => !prefix || prefix.startsWith("topology/tombstones/"))).toEqual([]);
    expect(viewer.get("session:gone")).toBeUndefined();
  });
});

