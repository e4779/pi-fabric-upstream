import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { ActorRegistryStore } from "../src/actors/registry-store.js";
import { ActorStoreReadError } from "../src/actors/store-read.js";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";
import { deadChildPid } from "./dead-child-pid.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore } from "../src/mesh/store.js";

// Mode 000 does not stop the read on Windows or for root.
const unreadableFileSkip =
  process.platform === "win32"
    ? "Windows does not deny reads by POSIX mode bits"
    : process.getuid?.() === 0
      ? "root reads a mode-000 file"
      : undefined;

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-registry-test-"));
  roots.push(root);
  const actorRoot = path.join(root, "actors");
  const registryPath = path.join(actorRoot, "actors.json");
  const lockPath = `${registryPath}.lock`;
  return { store: new ActorRegistryStore(actorRoot), actorRoot, registryPath, lockPath };
};

const installLock = (lockPath: string, pid: number, createdAt: number) => {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner"), `previous\n${pid}\n${createdAt}\n`);
};

const foreignNamespaceLine = (): string => {
  const own = JSON.parse(encodeOwnerIdentityLine()) as Record<string, unknown>;
  return JSON.stringify({
    hostname: own.hostname,
    pidNamespace: "pid:[1]",
    bootId: own.bootId,
    startedAt: own.startedAt,
  });
};

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorRegistryStore", () => {
  it("round-trips format 1 records and fingerprints atomic replacements", async () => {
    const { store, lockPath } = setup();
    expect(store.fingerprint()).toBeUndefined();
    expect(store.records()).toEqual([]);
    const first = { id: "first", rootId: "remote", extra: { preserved: true } };
    await store.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      store.write([first]);
    });
    const before = store.fingerprint();
    expect(before).toBeTypeOf("string");
    await store.withLock(() => store.write([...store.records(), { id: "second" }]));
    expect(store.read()).toEqual({ format: 1, actors: [first, { id: "second" }] });
    expect(store.fingerprint()).not.toBe(before);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("preserves unknown record fields and filters only invalid record identities", () => {
    const { store, actorRoot, registryPath } = setup();
    fs.mkdirSync(actorRoot);
    for (const raw of ["bad json", "null", "[]", '{"actors":{}}']) {
      fs.writeFileSync(registryPath, raw);
      expect(() => store.records()).toThrow(ActorStoreReadError);
    }
    const record = { id: "", futureField: [1, 2] };
    fs.writeFileSync(registryPath, JSON.stringify({ actors: [null, [], 1, {}, { id: 1 }, record] }));
    expect(store.records()).toEqual([record]);
  });

  it("releases its lock on a throwing callback and propagates the original error", async () => {
    const { store, lockPath } = setup();
    const error = new Error("write failed");
    await expect(store.withLock(() => { throw error; })).rejects.toBe(error);
    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(store.withLock(() => 42)).resolves.toBe(42);
  });

  it("never releases a replacement owner's lock", async () => {
    const { store, lockPath } = setup();
    await store.withLock(() => {
      fs.writeFileSync(path.join(lockPath, "owner"), "replacement\n1\n0\n");
    });
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe("replacement\n1\n0\n");
  });

  it("recovers a stale lock only when its owning process is gone", async () => {
    const { store, lockPath } = setup();
    installLock(lockPath, 123456, Date.now() - 30_001);
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
    await expect(store.withLock(() => "recovered")).resolves.toBe("recovered");
    expect(process.kill).toHaveBeenCalledWith(123456, 0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("recovers a fresh lock at once when its local owner is provably dead", async () => {
    const { store, lockPath } = setup();
    const pid = deadChildPid();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `crashed\n${pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`);

    const started = performance.now();
    await expect(store.withLock(() => "recovered")).resolves.toBe("recovered");

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([["fresh", 0], ["stale", 60_000]] as const)(
    "keeps a lock that a new owner takes between the %s dead-owner check and the removal",
    async (_age, ageMs) => {
      const { store, lockPath } = setup();
      const pid = deadChildPid();
      const ownerPath = path.join(lockPath, "owner");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(ownerPath, `crashed\n${pid}\n${Date.now() - ageMs}\n${encodeOwnerIdentityLine()}\n`);
      const successor = `successor\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`;
      const readFileSync = fs.readFileSync;
      let ownerReads = 0;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
        const content = readFileSync(file, options as BufferEncoding);
        // The re-read just before removal still sees the dead owner. A new
        // owner takes the lock right after it.
        if (file === ownerPath && ++ownerReads === 2) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          fs.mkdirSync(lockPath, { mode: 0o700 });
          fs.writeFileSync(ownerPath, successor);
        }
        return content;
      }) as typeof fs.readFileSync);
      vi.useFakeTimers();
      const operation = vi.fn();
      const result = expect(store.withLock(operation)).rejects.toThrow(
        "Timed out waiting for the Fabric actor registry lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;

      expect(operation).not.toHaveBeenCalled();
      expect(ownerReads).toBeGreaterThan(2);
      expect(readFileSync(ownerPath, "utf8")).toBe(successor);
      expect(fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes(".lock."))).toEqual([]);
    },
  );

  it("honours a fresh legacy or foreign lock with a dead pid until the timeout", async () => {
    const pid = deadChildPid();
    for (const identityLine of [undefined, foreignNamespaceLine()]) {
      vi.useFakeTimers();
      const { store, lockPath } = setup();
      const owner = `previous\n${pid}\n${Date.now()}\n${identityLine ?? ""}`;
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner"), owner);
      const operation = vi.fn();
      const result = expect(store.withLock(operation)).rejects.toThrow(
        "Timed out waiting for the Fabric actor registry lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(operation).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe(owner);
      vi.useRealTimers();
    }
  });

  it("waits for a live owner without stealing its stale lock", async () => {
    vi.useFakeTimers();
    const { store, lockPath } = setup();
    installLock(lockPath, process.pid, Date.now() - 30_001);
    const operation = vi.fn(() => "acquired");
    const pending = store.withLock(operation);
    await vi.advanceTimersByTimeAsync(20);
    expect(operation).not.toHaveBeenCalled();
    fs.rmSync(lockPath, { recursive: true });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("acquired");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("times out on incomplete locks without running the callback", async () => {
    vi.useFakeTimers();
    const { store, lockPath } = setup();
    fs.mkdirSync(lockPath, { recursive: true });
    const operation = vi.fn();
    const result = expect(store.withLock(operation)).rejects.toThrow(
      "Timed out waiting for the Fabric actor registry lock",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe("ActorRegistryStore read failures", () => {
  const remote = { id: "f".repeat(32), rootId: "remote-host", name: "remote", note: "another host" };

  it("loads a missing registry as empty and lists only valid entries", () => {
    const { store, registryPath } = setup();
    expect(store.entries()).toEqual([]);
    expect(store.records()).toEqual([]);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ format: 1, actors: [remote, { name: "no id" }, null] }));
    expect(store.entries()).toEqual([remote, { name: "no id" }, null]);
    expect(store.records()).toEqual([remote]);
  });

  it("fails the read when the registry is a directory", () => {
    const { store, registryPath } = setup();
    fs.mkdirSync(registryPath, { recursive: true });
    const failure = (() => {
      try {
        store.records();
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ActorStoreReadError);
    expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  /** A persistent host that owns one actor in a shared registry. */
  const ownerHost = async () => {
    const { actorRoot, registryPath, store } = setup();
    const root = path.dirname(actorRoot);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const agents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: path.join(root, "runs"),
    });
    closers.push(() => agents.close());
    const actors = new ActorManager(
      "test",
      { id: "session:test", name: "main", kind: "main", sessionId: "test" },
      mesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      agents,
      () => {},
      { actorRoot, persistent: true },
    );
    closers.push(() => actors.close());
    const actor = await actors.create({ name: "local", instructions: "Observe." });
    return { actors, actor, registryPath, store };
  };

  it.each([
    ["truncated JSON", (owned: unknown) => JSON.stringify({ format: 1, actors: [remote, owned] }).slice(0, -3)],
    ["a non-array actors field", () => JSON.stringify({ format: 1, actors: { [remote.id]: remote } })],
  ])("refuses to save over %s and leaves other hosts' rows on disk", async (_label, corrupt) => {
    const { actors, actor, registryPath, store } = await ownerHost();
    const raw = corrupt(store.records().find((record) => record.id === actor.id));
    fs.writeFileSync(registryPath, raw);

    await expect(actors.setInstructions(actor.id, "Changed after a failed read.")).rejects.toThrow(
      ActorStoreReadError,
    );
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    // Suspending owned actors on close is the other save path.
    await expect(actors.close()).rejects.toThrow(ActorStoreReadError);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it("keeps draining the mailbox while presence saves are refused", async () => {
    const { actors, actor, registryPath } = await ownerHost();
    const raw = JSON.stringify({ format: 1, actors: [remote] }).slice(0, -3);
    fs.writeFileSync(registryPath, raw);

    await expect(actors.ask(actor.id, "first")).resolves.toMatchObject({ text: "fake worker complete" });
    await expect(actors.ask(actor.id, "second")).resolves.toMatchObject({ text: "fake worker complete" });
    await vi.waitFor(() => expect(actors.status(actor.id).status).toBe("idle"));
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    await expect(actors.close()).rejects.toThrow(ActorStoreReadError);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it(
    "refuses to save over a registry it has no permission to read",
    async ({ skip }) => {
      skip(unreadableFileSkip !== undefined, unreadableFileSkip);
      const { actors, actor, registryPath, store } = await ownerHost();
      const raw = JSON.stringify({ format: 1, actors: [remote, ...store.records()] }, null, 2);
      fs.writeFileSync(registryPath, raw);
      fs.chmodSync(registryPath, 0o000);
      try {
        await expect(actors.setInstructions(actor.id, "Changed after a failed read.")).rejects.toThrow(
          ActorStoreReadError,
        );
      } finally {
        fs.chmodSync(registryPath, 0o600);
      }
      expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    },
  );

  it("keeps entries that fail validation when a host rewrites the registry", async () => {
    const { actors, actor, registryPath, store } = await ownerHost();
    const noId = { name: "no id", note: "written by a future version" };
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ format: 1, actors: [noId, remote, null, ...store.records()] }),
    );

    await actors.setInstructions(actor.id, "Changed after a good read.");

    const saved = store.entries();
    expect(saved).toEqual(expect.arrayContaining([noId, remote, null]));
    expect(saved).toHaveLength(4);
    expect(store.records().find((record) => record.id === actor.id)).toMatchObject({
      instructions: "Changed after a good read.",
    });
  });
});

describe("ActorRegistryStore short-lock leaks (#323)", () => {
  const age = (target: string, ms: number): void => {
    const past = new Date(Date.now() - ms);
    fs.utimesSync(target, past, past);
  };

  it("partial owner: keeps a fresh lock with an empty owner file until the stale window passes", async () => {
    const { store, lockPath } = setup();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), "");
    vi.useFakeTimers();
    const operation = vi.fn(() => "wrong");
    const result = expect(store.withLock(operation)).rejects.toThrow(
      "Timed out waiting for the Fabric actor registry lock",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    vi.useRealTimers();
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);

    age(lockPath, 60_000);
    await expect(store.withLock(() => "recovered")).resolves.toBe("recovered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("partial owner: publishes the owner file atomically, never empty at the lock path", async () => {
    const { store, lockPath } = setup();
    const ownerPath = path.join(lockPath, "owner");
    const writeFileSync = fs.writeFileSync;
    const targets: string[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      targets.push(String(file));
      if (String(file).startsWith(`${ownerPath}.`)) expect(fs.existsSync(ownerPath)).toBe(false);
      return writeFileSync(file, data as string, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);
    await store.withLock(() => undefined);
    expect(targets).not.toContain(ownerPath);
    expect(targets.some((target) => target.startsWith(`${ownerPath}.`))).toBe(true);
  });

  it("hold ceiling: reaps a live same-host owner's leaked lock and keeps a young one", async () => {
    const leaked = setup();
    fs.mkdirSync(leaked.lockPath, { recursive: true });
    fs.writeFileSync(path.join(leaked.lockPath, "owner"), `leaked\n${process.pid}\n${Date.now() - 3_600_000}\n${encodeOwnerIdentityLine()}\n`);
    await expect(leaked.store.withLock(() => "recovered")).resolves.toBe("recovered");
    expect(fs.existsSync(leaked.lockPath)).toBe(false);

    const young = setup();
    const owner = `held\n${process.pid}\n${Date.now() - 5_000}\n${encodeOwnerIdentityLine()}\n`;
    fs.mkdirSync(young.lockPath, { recursive: true });
    fs.writeFileSync(path.join(young.lockPath, "owner"), owner);
    vi.useFakeTimers();
    const result = expect(young.store.withLock(() => "wrong")).rejects.toThrow(
      "Timed out waiting for the Fabric actor registry lock",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(fs.readFileSync(path.join(young.lockPath, "owner"), "utf8")).toBe(owner);
  });
});
