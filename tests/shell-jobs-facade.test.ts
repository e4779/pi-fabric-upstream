import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import type { FabricShellJobEvent } from "../src/core/shell-jobs.js";
import { ShellEventInbox, SHELL_MESSAGE_TYPE } from "../src/core/shell-inbox.js";
import {
  createFabricBgServiceFacade,
  registerFabricBgJobService,
} from "../src/core/shell-jobs-facade.js";
import {
  FABRIC_SHELL_JOB_NOTIFY_EVENT,
  FABRIC_SHELL_JOB_REGISTER_EVENT,
  FABRIC_SHELL_JOB_SUBSCRIBE_EVENT,
  MAX_FABRIC_SHELL_JOB_PAYLOAD,
  readFabricShellJobCompletionV1,
  readFabricShellJobRegistrationV1,
  readFabricShellJobSubscriptionV1,
} from "../src/protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-jobs-facade-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

type Handler = (value: unknown) => unknown;

/** Minimal `pi.events` double mirroring how extension.ts subscribes channels. */
const fakePi = () => {
  const channels = new Map<string, Handler>();
  const on = vi.fn((channel: string, handler: Handler) => {
    channels.set(channel, handler);
    return () => channels.delete(channel);
  });
  const emit = (channel: string, value: unknown): unknown => channels.get(channel)?.(value);
  return { events: { on }, channels, on, emit };
};

describe("fabric bg service facade (registerJob/unregister/subscribe/notifyCompletion)", () => {
  it("registerJob registers on the existing store and reports the typed job info", () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const result = service.registerJob("bash", "bun run build", { description: "build" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.command).toBe("bun run build");
    expect(result.info.description).toBe("build");
    // The register channel's contract is background work: the job is spilled
    // at registration so its completion wakes through the session inbox.
    expect(result.info.status).toBe("spilled");
    expect(result.info.spilledAt).toBeDefined();
    expect(store.get(result.jobId)).toBeDefined();
    // The facade wraps the store's own handle: no second registry exists.
    expect(store.list()).toHaveLength(1);
  });

  it("begin is a backward-compatible alias of registerJob", () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    expect(service.begin).toBe(service.registerJob);
    const result = service.begin("bash", "sleep 5", { id: "alias-job" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobId).toBe("alias-job");
    expect(store.get("alias-job")).toBeDefined();
  });

  it("registerJob reports an existing stable id as ok:false, not a throw", () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    expect(service.registerJob("bash", "one", { id: "dup" }).ok).toBe(true);
    const again = service.registerJob("bash", "two", { id: "dup" });
    expect(again).toEqual({ ok: false, error: "Shell task already tracked: dup" });
  });

  it("subscribe delivers only that job's events and unsubscribes cleanly", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "true");
    const other = service.registerJob("bash", "false");
    expect(job.ok && other.ok).toBe(true);
    if (!job.ok || !other.ok) return;
    const events: FabricShellJobEvent[] = [];
    const unsubscribe = service.subscribe(job.jobId, (event) => events.push(event));
    store.get(other.jobId)?.append(Buffer.from("noise"));
    await store.get(other.jobId)?.finish(0);
    expect(events).toHaveLength(0); // another job's lifecycle never leaks in
    await store.get(job.jobId)?.finish(0, "done");
    expect(events.map((event) => event.type)).toEqual(["finished"]);
    expect(events[0]?.job.id).toBe(job.jobId);
    unsubscribe();
    const after = service.registerJob("bash", "sleep 1");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    await store.get(after.jobId)?.finish(0);
    expect(events).toHaveLength(1);
  });

  it("subscribe throws honestly before the session store exists", () => {
    const service = createFabricBgServiceFacade(() => undefined);
    expect(() => service.subscribe("x", () => {})).toThrow(
      "Background job service is unavailable before the fabric session is initialized",
    );
  });

  it("notifyCompletion funnels the payload through the store's single finished event", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "remote-work");
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    const events: FabricShellJobEvent[] = [];
    store.subscribe((event) => events.push(event)); // the sanctioned channel itself
    const delivered = await service.notifyCompletion(job.jobId, "build artifacts ready\nall green\n");
    expect(delivered).toEqual({ ok: true });
    const finished = events.find((event) => event.type === "finished");
    expect(finished).toBeDefined();
    expect(finished?.job.id).toBe(job.jobId);
    expect(finished?.job.status).toBe("exited");
    expect(finished?.job.exitCode).toBe(0);
    expect(finished?.output).toContain("build artifacts ready");
    expect(finished?.output).toContain("[Completed by owner via notifyCompletion]");
    // The typed wake event built from this delivery carries the payload as its tail.
    const info = store.get(job.jobId)?.info();
    expect(info?.finishedAt).toBeDefined();
  });

  it("notifyCompletion maps a non-zero exitCode to status failed", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "remote-work");
    if (!job.ok) throw new Error("registration failed");
    const events: FabricShellJobEvent[] = [];
    store.subscribe((event) => events.push(event));
    await service.notifyCompletion(job.jobId, "boom", { exitCode: 3 });
    const finished = events.find((event) => event.type === "finished");
    expect(finished?.job.status).toBe("failed");
    expect(finished?.job.exitCode).toBe(3);
  });

  it("notifyCompletion derives a typed stop reason from the exit code when the owner names none", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const ok = service.registerJob("bash", "clean");
    const crash = service.registerJob("bash", "dirty");
    if (!ok.ok || !crash.ok) throw new Error("registration failed");
    await service.notifyCompletion(ok.jobId, "done");
    await service.notifyCompletion(crash.jobId, "boom", { exitCode: 3 });
    expect(store.get(ok.jobId)?.info()).toMatchObject({ status: "exited", stopReason: "completed" });
    expect(store.get(crash.jobId)?.info()).toMatchObject({ status: "failed", stopReason: "runtime_error" });
  });

  it("notifyCompletion carries a typed stop reason beside a missing exit code", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "watch CI");
    if (!job.ok) throw new Error("registration failed");
    const events: FabricShellJobEvent[] = [];
    store.subscribe((event) => events.push(event));
    await service.notifyCompletion(job.jobId, "deadline killed it", { exitCode: null, stopReason: "timed_out" });
    const finished = events.find((event) => event.type === "finished");
    // No exit code is invented for a kill (null = ended without one), and the
    // typed wake names the cause instead of leaving a bare `failed`.
    expect(finished?.job.status).toBe("failed");
    expect(finished?.job.exitCode).toBeNull();
    expect(finished?.job.stopReason).toBe("timed_out");
  });

  it("registerJob plus notifyCompletion delivers the typed wake through the session inbox", async () => {
    vi.useFakeTimers();
    const store = new FabricShellJobStore(tempRoot());
    const sendMessage = vi.fn();
    const ctx = { hasUI: false, ui: { notify: vi.fn() }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
    const pi = { sendMessage, on: () => () => {} } as unknown as ExtensionAPI;
    const inbox = new ShellEventInbox(pi, ctx, store);
    cleanups.push(
      () => inbox.close(),
      () => void store.close(),
      () => vi.useRealTimers(),
    );
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "bun run build", { ownerId: "sess-facade" });
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    await expect(service.notifyCompletion(job.jobId, "build done", { exitCode: 0 })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]![0];
    expect(message.customType).toBe(SHELL_MESSAGE_TYPE);
    expect(message.details.ids).toEqual([job.jobId]);
    expect(message.details.events[0]).toMatchObject({
      schemaVersion: 1,
      kind: "wake",
      id: job.jobId,
      status: "exited",
      exitCode: 0,
      stopReason: "completed",
    });
    expect(message.content).toContain("not human input");
  });

  it("notifyCompletion refuses unknown and already-finished jobs", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    await expect(service.notifyCompletion("nope", "x")).resolves.toEqual({
      ok: false,
      error: "Unknown background job: nope",
    });
    const job = service.registerJob("bash", "once");
    if (!job.ok) throw new Error("registration failed");
    await service.notifyCompletion(job.jobId, "first");
    await expect(service.notifyCompletion(job.jobId, "second")).resolves.toEqual({
      ok: false,
      error: `Background job already finished: ${job.jobId}`,
    });
  });

  it("unregister drops tracking without touching live work and silences later events", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const service = createFabricBgServiceFacade(() => store);
    const job = service.registerJob("bash", "long-running");
    if (!job.ok) throw new Error("registration failed");
    const events: FabricShellJobEvent[] = [];
    service.subscribe(job.jobId, (event) => events.push(event));
    expect(service.unregister(job.jobId)).toBe(true);
    expect(store.get(job.jobId)).toBeUndefined();
    await service.notifyCompletion(job.jobId, "late payload"); // unknown now: the caller owns delivery
    expect(events).toHaveLength(0);
    expect(service.unregister(job.jobId)).toBe(false);
  });

  it("every method answers honestly before the session store exists", async () => {
    const service = createFabricBgServiceFacade(() => undefined);
    expect(service.registerJob("bash", "x")).toEqual({
      ok: false,
      error: "Background job service is unavailable before the fabric session is initialized",
    });
    expect(service.begin("bash", "x").ok).toBe(false);
    expect(service.unregister("x")).toBe(false);
    await expect(service.notifyCompletion("x", "y")).resolves.toEqual({
      ok: false,
      error: "Background job service is unavailable before the fabric session is initialized",
    });
  });

  it("follows the live store across a session switch", async () => {
    const first = new FabricShellJobStore(tempRoot());
    let live: FabricShellJobStore | undefined = first;
    const service = createFabricBgServiceFacade(() => live);
    const job = service.registerJob("bash", "on-first");
    expect(job.ok).toBe(true);
    live = new FabricShellJobStore(tempRoot());
    expect(live.get(job.ok ? job.jobId : "")).toBeUndefined(); // old session's job is gone
    const next = service.registerJob("bash", "on-second");
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    await expect(service.notifyCompletion(next.jobId, "done")).resolves.toEqual({ ok: true });
  });
});

describe("fabric bg service extension registration (pi.events surface)", () => {
  const context = {} as ExtensionContext;

  it("wires register/subscribe/notify channels and answers via respond", async () => {
    const store = new FabricShellJobStore(tempRoot());
    const pi = fakePi();
    const unsubscribe = registerFabricBgJobService(
      pi as never,
      () => store,
    );
    cleanups.push(unsubscribe);
    expect(pi.on).toHaveBeenCalledTimes(3);

    const registered: unknown[] = [];
    pi.emit(FABRIC_SHELL_JOB_REGISTER_EVENT, {
      version: 1,
      tool: "bash",
      command: "bun test",
      options: { description: "tests" },
      respond: (result: unknown) => registered.push(result),
    });
    expect(registered).toHaveLength(1);
    const registration = registered[0] as { ok: true; jobId: string };
    expect(registration.ok).toBe(true);
    expect(store.get(registration.jobId)).toBeDefined();

    const subscription: Array<{ ok: boolean; unsubscribe?: () => void; error?: string }> = [];
    const events: FabricShellJobEvent[] = [];
    pi.emit(FABRIC_SHELL_JOB_SUBSCRIBE_EVENT, {
      version: 1,
      jobId: registration.jobId,
      listener: (event: FabricShellJobEvent) => events.push(event),
      respond: (result: unknown) => subscription.push(result as { ok: boolean }),
    });
    expect(subscription[0]?.ok).toBe(true);

    const completions: unknown[] = [];
    pi.emit(FABRIC_SHELL_JOB_NOTIFY_EVENT, {
      version: 1,
      jobId: registration.jobId,
      payload: "finished remotely",
      exitCode: 0,
      respond: (result: unknown) => completions.push(result),
    });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toEqual({ ok: true });
    expect(events.map((event) => event.type)).toEqual(["finished"]);

    // Malformed payloads are rejected before any state is touched.
    expect(() => pi.emit(FABRIC_SHELL_JOB_REGISTER_EVENT, { version: 2, tool: "bash", command: "x" }))
      .toThrow("Invalid Pi Fabric background job registration");
    expect(() => pi.emit(FABRIC_SHELL_JOB_SUBSCRIBE_EVENT, { version: 1, jobId: "x" }))
      .toThrow("Invalid Pi Fabric background job subscription");
    expect(() => pi.emit(FABRIC_SHELL_JOB_NOTIFY_EVENT, { version: 1, jobId: "x" }))
      .toThrow("Invalid Pi Fabric background job completion");

    unsubscribe();
    expect(pi.channels.size).toBe(0);
  });

  it("subscription over events answers ok:false when the store is absent", () => {
    const pi = fakePi();
    const unsubscribe = registerFabricBgJobService(pi as never, () => undefined);
    cleanups.push(unsubscribe);
    const replies: Array<{ ok: boolean; error?: string }> = [];
    pi.emit(FABRIC_SHELL_JOB_SUBSCRIBE_EVENT, {
      version: 1,
      jobId: "x",
      listener: () => {},
      respond: (result: unknown) => replies.push(result as { ok: boolean }),
    });
    expect(replies[0]?.ok).toBe(false);
    expect(replies[0]?.error).toContain("unavailable before the fabric session is initialized");
  });
});

describe("fabric bg service protocol readers", () => {
  it("accepts and copies a valid registration", () => {
    const respond = () => {};
    const registration = readFabricShellJobRegistrationV1({
      version: 1,
      tool: "fabric_exec",
      command: "run()",
      options: { id: "job-1", ownerId: "session-1", description: "desc", cwd: "/tmp" },
      respond,
    });
    expect(registration).toEqual({
      version: 1,
      tool: "fabric_exec",
      command: "run()",
      options: { id: "job-1", ownerId: "session-1", description: "desc", cwd: "/tmp" },
      respond,
    });
  });

  it("rejects malformed registrations", () => {
    const valid = { version: 1, tool: "bash", command: "ls" };
    expect(readFabricShellJobRegistrationV1(valid)).toBeDefined();
    expect(readFabricShellJobRegistrationV1(null)).toBeUndefined();
    expect(readFabricShellJobRegistrationV1([valid])).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, version: 2 })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, tool: "cursor" })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, command: "" })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, command: "x".repeat(16_385) })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, options: { id: "" } })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, options: { id: 4 } })).toBeUndefined();
    expect(readFabricShellJobRegistrationV1({ ...valid, respond: "nope" })).toBeUndefined();
  });

  it("rejects malformed subscriptions", () => {
    const listener = () => {};
    expect(readFabricShellJobSubscriptionV1({ version: 1, jobId: "j", listener })).toBeDefined();
    expect(readFabricShellJobSubscriptionV1({ version: 1, jobId: "j" })).toBeUndefined();
    expect(readFabricShellJobSubscriptionV1({ version: 1, jobId: "j", listener: "x" })).toBeUndefined();
    expect(readFabricShellJobSubscriptionV1({ version: 1, jobId: "", listener })).toBeUndefined();
    expect(readFabricShellJobSubscriptionV1({ version: 2, jobId: "j", listener })).toBeUndefined();
  });

  it("rejects malformed completions and bounds the payload", () => {
    const valid = { version: 1, jobId: "j", payload: "done" };
    expect(readFabricShellJobCompletionV1(valid)).toEqual(valid);
    expect(readFabricShellJobCompletionV1({ ...valid, exitCode: 1 })).toEqual({
      ...valid,
      exitCode: 1,
    });
    expect(readFabricShellJobCompletionV1({ ...valid, payload: "" })).toBeDefined(); // empty payload is legal
    expect(readFabricShellJobCompletionV1({ ...valid, payload: "x".repeat(MAX_FABRIC_SHELL_JOB_PAYLOAD + 1) }))
      .toBeUndefined();
    expect(readFabricShellJobCompletionV1({ ...valid, exitCode: 1.5 })).toBeUndefined();
    expect(readFabricShellJobCompletionV1({ ...valid, jobId: "" })).toBeUndefined();
    expect(readFabricShellJobCompletionV1({ version: 1, jobId: "j" })).toBeUndefined();
    expect(readFabricShellJobCompletionV1({ ...valid, payload: 42 })).toBeUndefined();
  });

  it("accepts a typed stop reason and a null exit code; unknown reasons refuse the completion", () => {
    const valid = { version: 1, jobId: "j", payload: "done" };
    // `null` records a run that ended without an exit code (a kill leaves none).
    expect(readFabricShellJobCompletionV1({ ...valid, exitCode: null })).toEqual({ ...valid, exitCode: null });
    expect(readFabricShellJobCompletionV1({ ...valid, exitCode: null, stopReason: "timed_out" }))
      .toEqual({ ...valid, exitCode: null, stopReason: "timed_out" });
    expect(readFabricShellJobCompletionV1({ ...valid, stopReason: "user" }))
      .toEqual({ ...valid, stopReason: "user" });
    // Refuse-not-guess: an unknown terminal cause rejects the whole payload.
    expect(readFabricShellJobCompletionV1({ ...valid, stopReason: "exploded" })).toBeUndefined();
    expect(readFabricShellJobCompletionV1({ ...valid, stopReason: 7 })).toBeUndefined();
  });
});
