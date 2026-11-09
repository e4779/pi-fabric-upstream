import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentJobs, type AgentJobEntry } from "../src/external/agent-jobs.js";
import type { AgentCommandArgs, WorkerSession } from "../src/external/agent.js";
import {
  AgentJobsStoreMirror,
  agentJobSettlementPayload,
  externalJobsFooter,
  FABRIC_AGENT_JOBS_STORE_EVENT,
} from "../src/external/agent-jobs-store.js";
import { FabricShellJobStore, type FabricShellJobEvent } from "../src/core/shell-jobs.js";
import { ShellEventInbox, SHELL_MESSAGE_TYPE } from "../src/core/shell-inbox.js";
import { registerFabricBgJobService } from "../src/core/shell-jobs-facade.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The agent-jobs bridge registry mirrored into the host JobStore through the
 * extension-facing facade: parity, settlement wake parity, stop propagation
 * and session-switch re-publication. The dock reads only the store.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-jobs-store-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

interface FakeController {
  resolvePrompt: (messages: unknown[]) => void;
  rejectPrompt: (error: Error) => void;
  aborted: boolean;
}

const fakeSession = (): { session: WorkerSession; controller: FakeController } => {
  const controller: FakeController = { resolvePrompt: () => undefined, rejectPrompt: () => undefined, aborted: false };
  let promptPromise: Promise<void>;
  const session: WorkerSession = {
    prompt: () => {
      promptPromise = new Promise<void>((resolve, reject) => {
        controller.resolvePrompt = (messages) => {
          (session.state as { messages: unknown[] }).messages = messages;
          resolve();
        };
        controller.rejectPrompt = reject;
      });
      return promptPromise!;
    },
    steer: () => "queued",
    followUp: () => "queued",
    abort: () => {
      controller.aborted = true;
      controller.resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "partial before abort" }] }]);
    },
    dispose: () => undefined,
    state: { messages: [] },
  };
  return { session, controller };
};

const args = (overrides: Partial<AgentCommandArgs> = {}): AgentCommandArgs => ({
  prompt: "Fix the flaky test",
  tools: [],
  timeoutMs: 60_000,
  json: false,
  ...overrides,
});

type Handler = (value: unknown) => unknown;

/** `pi.events` double: the facade channels plus the mirror's telemetry channel. */
const fakePi = () => {
  const channels = new Map<string, Handler>();
  const sent: Array<{ message: { customType: string; content: string }; options?: unknown }> = [];
  const pi = {
    sendMessage: vi.fn((message, options) => sent.push({ message, options })),
    on: vi.fn((name: string, handler: Handler) => {
      channels.set(name, handler);
      return () => channels.delete(name);
    }),
    events: {
      on: vi.fn((channel: string, handler: Handler) => {
        channels.set(channel, handler);
        return () => channels.delete(channel);
      }),
      emit: vi.fn((channel: string, value: unknown) => {
        const handler = channels.get(channel);
        if (handler === undefined) throw new Error(`no handler for ${channel}`);
        return handler(value);
      }),
    },
  } as unknown as ExtensionAPI & { events: { emit: (channel: string, value: unknown) => unknown } };
  return { pi, channels, sent };
};

const harness = (options: { inbox?: boolean } = {}) => {
  const base = fakePi();
  let store: FabricShellJobStore | undefined = new FabricShellJobStore(tempRoot());
  const offService = registerFabricBgJobService(base.pi, () => store);
  cleanups.push(offService);
  // One fresh fake session per submitted job, so tests settle jobs individually.
  const controllers: FakeController[] = [];
  const spawn = async (): Promise<WorkerSession> => {
    const fake = fakeSession();
    controllers.push(fake.controller);
    return fake.session;
  };
  const telemetry: Array<{ route: string; jobId: string }> = [];
  base.channels.set(FABRIC_AGENT_JOBS_STORE_EVENT, (value) => {
    telemetry.push(value as { route: string; jobId: string });
  });
  const redraws: number[] = [];
  let enabled = true;
  const mirror = new AgentJobsStoreMirror({
    pi: base.pi,
    entries: () => jobs.entries(),
    resolveStore: () => store,
    ownerId: () => "session-1",
    enabled: () => enabled,
    stop: (id) => {
      void jobs.stop(id).catch(() => undefined);
    },
    changed: () => redraws.push(Date.now()),
  });
  // Wired exactly like the extension: every registry mutation re-syncs the mirror.
  const jobs = new AgentJobs(spawn, undefined, undefined, () => mirror.sync());
  let inbox: ShellEventInbox | undefined;
  const { pi } = base;
  if (options.inbox) {
    inbox = new ShellEventInbox(pi, {
      hasUI: false,
      isIdle: () => true,
      hasPendingMessages: () => false,
    } as never, store);
    cleanups.push(() => inbox?.close());
  }
  return {
    ...base,
    mirror,
    jobs,
    controller: (index: number) => controllers[index]!,
    telemetry,
    inbox: () => inbox,
    store: () => store,
    switchStore: (): FabricShellJobStore => {
      store = new FabricShellJobStore(tempRoot());
      return store;
    },
    disable: () => {
      enabled = false;
    },
  };
};

const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent jobs mirrored into the host JobStore", () => {
  it("publishes every registry job with its name and keeps store parity with agent list", async () => {
    const h = harness();
    const first = h.jobs.submit(args({ name: "build" }));
    const second = h.jobs.submit(args({ name: "audit" }));
    await settleMicrotasks();
    h.mirror.sync();
    const external = h.store()!.list().filter((job) => job.external === true);
    expect(external.map((job) => job.id)).toEqual([first, second]);
    expect(external.map((job) => job.label)).toEqual(["build", "audit"]);
    expect(external.every((job) => job.tool === "monitor" && job.status === "running")).toBe(true);
    // Parity falsifier: the typed registry view and the store's external rows agree.
    const entries: AgentJobEntry[] = h.jobs.entries();
    expect(external.map((job) => [job.id, job.label, job.status]))
      .toEqual(entries.map((entry) => [entry.id, entry.name, "running"]));
  });

  it("settles through notifyCompletion: status, exit code, typed stop reason and retained tail", async () => {
    const h = harness();
    const done = h.jobs.submit(args({ name: "build" }));
    const failed = h.jobs.submit(args({ name: "audit" }));
    await settleMicrotasks();
    const events: FabricShellJobEvent[] = [];
    h.store()!.subscribe((event) => events.push(event));
    h.controller(0).resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
    h.controller(1).rejectPrompt(new Error("model exploded"));
    await h.jobs.wait(done);
    await h.jobs.wait(failed);
    // The store's finished event is the delivery contract: wait for it, not
    // merely for finishedAt, which lands before the event's trailing awaits.
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === "finished")).toHaveLength(2);
    });
    const settled = new Map(h.store()!.list().map((job) => [job.id, job]));
    expect(settled.get(done)?.status).toBe("exited");
    expect(settled.get(done)?.exitCode).toBe(0);
    expect(settled.get(failed)?.status).toBe("failed");
    expect(settled.get(failed)?.exitCode).toBe(1);
    const finished = events.filter((event) => event.type === "finished");
    const payload = finished.find((event) => event.job.id === failed)?.output ?? "";
    expect(payload).toContain("Job audit");
    expect(payload).toContain("failed: model exploded");
    expect(payload).toContain(`Fetch: ai agent result ${failed}`);
  });

  it("delivers the settlement wake through ShellEventInbox - the one sanctioned channel", async () => {
    const h = harness({ inbox: true });
    const id = h.jobs.submit(args({ name: "build" }));
    await settleMicrotasks();
    h.controller(0).resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "done text" }] }]);
    await h.jobs.wait(id);
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(0));
    const delivery = h.sent.find((entry) => entry.message.customType === SHELL_MESSAGE_TYPE);
    expect(delivery).toBeDefined();
    expect(delivery?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(delivery?.message.content).toContain("Agent job build");
    expect(delivery?.message.content).toContain(`Fetch: ai agent result ${id}`);
    expect(delivery?.message.content).toContain("not human input");
  });

  it("a store-side typed user stop stops the real agent job", async () => {
    const h = harness();
    const id = h.jobs.submit(args({ name: "build" }));
    await settleMicrotasks();
    h.mirror.sync();
    // The dock's double-x stop goes through the store handle.
    expect(h.store()!.get(id)?.stop()).toBe(true);
    await vi.waitFor(() => expect(h.controller(0).aborted).toBe(true));
    await h.jobs.wait(id);
    await vi.waitFor(() => {
      // killed + stopped:user is the terminal state the settlement lands.
      const info = h.store()!.get(id)?.info();
      expect(info?.status).toBe("killed");
      expect(info?.stopReason).toBe("user");
    });
    expect(h.jobs.status(id)[0]).toBe("state=stopped");
  });

  it("re-publishes into a fresh store on session switch, settled jobs included", async () => {
    const h = harness();
    const live = h.jobs.submit(args({ name: "build" }));
    const done = h.jobs.submit(args({ name: "audit" }));
    await settleMicrotasks();
    h.controller(1).resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
    await h.jobs.wait(done);
    await vi.waitFor(() => {
      expect(h.store()!.get(done)?.info().finishedAt).toBeDefined();
    });
    // Session switch: the bridge registry survives, the store does not.
    const fresh = h.switchStore();
    h.mirror.sync();
    const external = fresh.list().filter((job) => job.external === true);
    expect(external.map((job) => job.id).sort()).toEqual([done, live].sort());
    expect(fresh.get(live)?.info().status).toBe("running");
    await vi.waitFor(() => {
      expect(fresh.get(done)?.info().finishedAt).toBeDefined();
    });
    expect(fresh.get(done)?.info().status).toBe("exited");
  });

  it("registers under the caller's optional jobTool, the mirror's optional default, or monitor", async () => {
    const h = harness();
    const picked = h.jobs.submit(args({ name: "picked", jobTool: "bash" }));
    const defaulted = h.jobs.submit(args({ name: "defaulted" }));
    await settleMicrotasks();
    h.mirror.sync();
    const tools = new Map(h.store()!.list().filter((job) => job.external === true).map((job) => [job.id, job.tool]));
    expect(tools.get(picked)).toBe("bash");
    expect(tools.get(defaulted)).toBe("monitor");
  });

  it("refuses nothing silently: registration and settle refusals surface as telemetry", async () => {
    const h = harness();
    h.switchStore();
    h.disable();
    h.mirror.sync();
    expect(h.store()!.list().filter((job) => job.external === true)).toHaveLength(0);
    expect(h.telemetry).toHaveLength(0);
  });

  it("footer counter source: live external labels, oldest first, nothing else", () => {
    const now = Date.now();
    const labels = externalJobsFooter([
      { id: "a", tool: "bash", command: "x", startedAt: now - 5_000, status: "spilled", spilledAt: now, eventCount: 0, unread: false, stopping: false },
      { id: "b", tool: "monitor", command: "agent one", label: "one", external: true, startedAt: now - 3_000, status: "running", eventCount: 0, unread: false, stopping: false },
      { id: "c", tool: "monitor", command: "agent zero", label: "zero", external: true, startedAt: now - 4_000, status: "running", eventCount: 0, unread: false, stopping: false },
      { id: "d", tool: "monitor", command: "agent old", label: "old", external: true, startedAt: now - 9_000, finishedAt: now - 1_000, status: "exited", eventCount: 0, unread: false, stopping: false },
    ]);
    expect(labels).toEqual(["zero", "one"]);
  });

  it("settlement payload keeps the untrusted preamble contract and the fetch pointer", () => {
    const payload = agentJobSettlementPayload({ id: "job-1", name: "build", state: "failed", error: "boom" });
    expect(payload.split("\n")[0]).toContain("not human input");
    expect(payload).toContain("Job build (job-1): failed: boom");
    expect(payload).toContain("Fetch: ai agent result job-1");
  });
});
