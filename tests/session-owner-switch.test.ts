// Session owner switch veto: the extension-level enforcement of the
// single-writer guard (session_before_switch + the session_start claim).
// Unlike the core suite, these tests use the real pid-liveness probe: a live
// foreign owner is a real spawned process, so a refusal and a stale-claim
// recovery exercise exactly what an operator's second window would hit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piFabric from "../src/index.js";
import {
  acquireSessionOwnerLock,
  readSessionOwners,
  SESSION_OWNER_FORCE_ENV,
  SESSION_OWNER_LOCK_ENV,
} from "../src/core/session-owner-lock.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const fakePi = () => {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => undefined),
    },
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    getActiveTools: vi.fn(() => ["fabric_exec"]),
    getAllTools: vi.fn(() => [{ name: "fabric_exec" }]),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const emit = async (name: string, event: unknown, context: ExtensionContext) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  };
  return { pi, handlers, emit };
};

/** Spawn a process that stays alive until killed: a real foreign owner. */
const livePid = (): number => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  cleanups.push(async () => {
    child.kill("SIGKILL");
  });
  return child.pid!;
};

/** A pid that is provably dead: wait for a spawned process to exit. */
const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
};

const sandbox = (): { root: string; cwd: string; sessionFile: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-owner-veto-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "fabric.json"),
    JSON.stringify({ sessions: { ownerLock: true } }),
  );
  vi.stubEnv("PI_FABRIC_SESSION_OWNERS_DIR", path.join(root, "owners"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  fs.mkdirSync(path.join(root, "agent"), { recursive: true });
  for (const key of [SESSION_OWNER_LOCK_ENV, SESSION_OWNER_FORCE_ENV]) vi.stubEnv(key, undefined);
  const sessionFile = path.join(root, "session.jsonl");
  fs.writeFileSync(sessionFile, "");
  return { root, cwd, sessionFile };
};

const contextOn = (cwd: string, sessionFile: string, notify: ReturnType<typeof vi.fn>): ExtensionContext =>
  ({
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    model: { provider: "anthropic", id: "sonnet", contextWindow: 100_000 },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => sessionFile,
      getBranch: () => [],
    },
    ui: { notify, setStatus: vi.fn() },
    shutdown: vi.fn(),
  }) as unknown as ExtensionContext;

const loadFabric = async (cwd: string, sessionFile: string, notify: ReturnType<typeof vi.fn>) => {
  const host = fakePi();
  await piFabric(host.pi);
  const context = contextOn(cwd, sessionFile, notify);
  cleanups.push(async () => {
    await host.emit("session_shutdown", { type: "session_shutdown" }, context);
  });
  // Boot: the extension claims the session file it opened.
  await host.emit("session_start", { type: "session_start", reason: "new" }, context);
  // Every session_before_switch handler must pass for the switch to happen.
  const veto = async (targetSessionFile: string): Promise<boolean> => {
    const event = { type: "session_before_switch", reason: "resume", targetSessionFile };
    for (const handler of host.handlers.get("session_before_switch") ?? []) {
      const result = (await handler(event, context)) as { cancel?: boolean } | undefined;
      if (result?.cancel === true) return false;
    }
    return true;
  };
  // The switch itself: a session_start for the target file with the new
  // session manager active (same extension process, same handlers).
  const switchTo = (targetSessionFile: string): Promise<unknown[]> =>
    host.emit(
      "session_start",
      { type: "session_start", reason: "resume", previousSessionFile: sessionFile },
      contextOn(cwd, targetSessionFile, notify),
    );
  const shutdown = (): Promise<unknown[]> =>
    host.emit("session_shutdown", { type: "session_shutdown" }, context);
  return { host, veto, switchTo, shutdown };
};

describe("session owner switch veto", () => {
  it("refuses a switch to a live-owned file with a visible named reason", async () => {
    const { root, cwd, sessionFile } = sandbox();
    const ownerPid = livePid();
    const other = path.join(root, "other.jsonl");
    fs.writeFileSync(other, "");
    // The live owner has really claimed the file it is writing.
    acquireSessionOwnerLock({ sessionFile: other, pid: ownerPid, sessionId: "owner-1" });
    const notify = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(async () => {
    errorSpy.mockRestore();
  });
    const { veto } = await loadFabric(cwd, sessionFile, notify);
    expect(await veto(other)).toBe(false);
    const message = notify.mock.calls.at(-1)?.[0] as string | undefined;
    expect(message).toContain(`pid=${ownerPid}`);
    expect(message).toContain(other);
    expect(message).toContain(SESSION_OWNER_FORCE_ENV);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(`pid=${ownerPid}`))).toBe(true);
  });

  it("lets a dead owner's file through and the switch takes the stale claim over", async () => {
    const { root, cwd, sessionFile } = sandbox();
    const ghost = await deadPid();
    const other = path.join(root, "other.jsonl");
    fs.writeFileSync(other, "");
    // A crashed owner left its claim behind: the pid is dead, the record is
    // really on disk under the shared registry.
    acquireSessionOwnerLock({ sessionFile: other, pid: ghost, sessionId: "ghost" });
    expect(readSessionOwners(other).map((owner) => owner.pid)).toEqual([ghost]);
    const notify = vi.fn();
    const { veto, switchTo } = await loadFabric(cwd, sessionFile, notify);
    notify.mockClear();
    expect(await veto(other)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    await switchTo(other);
    const owners = readSessionOwners(other);
    expect(owners.map((owner) => owner.pid)).toEqual([process.pid]);
    expect(owners[0]?.session).toBe("session-1");
  });

  it("PI_FABRIC_ALLOW_LIVE_SESSION=1 opens a live-owned file as a visible second writer", async () => {
    const { root, cwd, sessionFile } = sandbox();
    const ownerPid = livePid();
    const other = path.join(root, "other.jsonl");
    fs.writeFileSync(other, "");
    // The live owner has really claimed the file it is writing.
    acquireSessionOwnerLock({ sessionFile: other, pid: ownerPid, sessionId: "owner-1" });
    const notify = vi.fn();
    const { veto, switchTo, shutdown } = await loadFabric(cwd, sessionFile, notify);
    vi.stubEnv(SESSION_OWNER_FORCE_ENV, "1");
    notify.mockClear();
    expect(await veto(other)).toBe(true);
    // The forced open is itself loud, and then visibly registered.
    expect(String(notify.mock.calls.at(-1)?.[0])).toContain(`pid=${ownerPid}`);
    await switchTo(other);
    const pids = readSessionOwners(other).map((owner) => owner.pid);
    expect(pids).toContain(ownerPid);
    expect(pids).toContain(process.pid);
    // Shutdown releases only this process's record; the live owner remains.
    await shutdown();
    expect(readSessionOwners(other).map((owner) => owner.pid)).toEqual([ownerPid]);
  });

  it("stays silent for a file nobody owns", async () => {
    const { root, cwd, sessionFile } = sandbox();
    const other = path.join(root, "other.jsonl");
    fs.writeFileSync(other, "");
    const notify = vi.fn();
    const { veto } = await loadFabric(cwd, sessionFile, notify);
    notify.mockClear();
    expect(await veto(other)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
