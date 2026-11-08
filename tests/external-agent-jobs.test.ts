import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentJobs, createAgentJobsCommand } from "../src/external/agent-jobs.js";
import type { AgentCommandArgs, WorkerSession } from "../src/external/agent.js";
import { composeCommands, startExternalBridge, type ExternalBridgeHandle } from "../src/external/bridge.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-agent-jobs-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

interface FakeController {
  resolvePrompt: (messages: unknown[]) => void;
  rejectPrompt: (error: Error) => void;
  steerTexts: string[];
  followTexts: string[];
  aborted: boolean;
  disposed: boolean;
}

const fakeSession = (): { session: WorkerSession; controller: FakeController } => {
  const controller: FakeController = {
    resolvePrompt: () => undefined,
    rejectPrompt: () => undefined,
    steerTexts: [],
    followTexts: [],
    aborted: false,
    disposed: false,
  };
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
    steer: (text) => {
      controller.steerTexts.push(text);
      return "queued";
    },
    followUp: (text) => {
      controller.followTexts.push(text);
      return "queued";
    },
    abort: () => {
      controller.aborted = true;
      controller.resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "partial before abort" }] }]);
    },
    dispose: () => {
      controller.disposed = true;
    },
    state: { messages: [] },
  };
  return { session, controller };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const args = (overrides: Partial<AgentCommandArgs> = {}): AgentCommandArgs => ({
  prompt: "work",
  tools: [],
  timeoutMs: 60_000,
  json: false,
  ...overrides,
});

describe("AgentJobs state machine", () => {
  it("submit answers immediately; wait joins; result returns the text", async () => {
    const fake = fakeSession();
    const jobs = new AgentJobs(async () => fake.session);
    const id = jobs.submit(args({ name: "alpha" }));
    await settled(); // let the spawn+prompt microtasks start
    expect(jobs.status(id)).toContain("state=running");
    fake.controller.resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "done text" }] }]);
    const wait = await jobs.wait(id);
    expect(wait.lines[0]).toBe("state=done");
    const result = await jobs.result(id);
    expect(result).toEqual({ ok: true, lines: ["done text"] });
    expect(fake.controller.disposed).toBe(true);
    expect(jobs.list().some((line) => line.includes("alpha"))).toBe(true);
  });

  it("failures carry the error; result is ok:false", async () => {
    const fake = fakeSession();
    const jobs = new AgentJobs(async () => fake.session);
    const id = jobs.submit(args());
    await settled();
    fake.controller.rejectPrompt(new Error("model exploded"));
    await jobs.wait(id);
    expect(jobs.status(id)).toContain("state=failed");
    const result = await jobs.result(id);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("model exploded");
  });

  it("stop claims the state before abort and keeps partial text", async () => {
    const fake = fakeSession();
    const jobs = new AgentJobs(async () => fake.session);
    const id = jobs.submit(args());
    await settled(); // session assigned: stop takes the abort path
    const stopped = await jobs.stop(id);
    expect(stopped.lines[0]).toBe("state=stopped");
    expect(fake.controller.aborted).toBe(true);
    const result = await jobs.result(id);
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("partial before abort");
  });

  it("steer and follow reach the running session; timeout fails the job", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession();
      const jobs = new AgentJobs(async () => fake.session);
      const id = jobs.submit(args({ timeoutMs: 1_000 }));
      await vi.advanceTimersByTimeAsync(0); // flush spawn+prompt microtasks
      await expect(jobs.steer(id, "change of plans")).resolves.toBe("queued");
      await expect(jobs.follow(id, "then do this")).resolves.toBe("queued");
      expect(fake.controller.steerTexts).toEqual(["change of plans"]);
      expect(fake.controller.followTexts).toEqual(["then do this"]);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(jobs.status(id)).toContain("state=failed");
      expect(jobs.status(id)).toContain("error=timeout 1000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn failure and the job cap are reported", async () => {
    const jobs = new AgentJobs(async () => {
      throw new Error("no sdk for you");
    }, 1);
    const id = jobs.submit(args());
    await jobs.wait(id);
    expect(jobs.status(id).some((line) => line.includes("spawn failed"))).toBe(true);
  });

  it("completion inbox: one settlement per terminal job, none on close", async () => {
    const settlements: import("../src/external/agent-jobs.js").JobSettlement[] = [];
    const fake = fakeSession();
    const jobs = new AgentJobs(async () => fake.session, 64, (settlement) => settlements.push(settlement));
    const id = jobs.submit(args({ name: "inbox" }));
    await settled();
    fake.controller.resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
    await jobs.wait(id);
    const failed = jobs.submit(args());
    await settled();
    fake.controller.rejectPrompt(new Error("boom"));
    await jobs.wait(failed);
    jobs.close();
    expect(settlements.map((entry) => `${entry.name}:${entry.state}`)).toEqual(["inbox:done", `${failed.slice(0, 8)}:failed`]);
    expect(settlements[1]?.error).toContain("boom");
  });

  it("the job cap bounds concurrent running jobs", () => {
    const second = new AgentJobs(async () => fakeSession().session, 1);
    const first = second.submit(args());
    expect(() => second.submit(args())).toThrow(/cap/);
    void first;
  });
});

describe("agent jobs over the bridge", () => {
  let bridge: ExternalBridgeHandle | undefined;
  let jobs: AgentJobs | undefined;
  let fake: ReturnType<typeof fakeSession> | undefined;
  let promptFile: string;

  beforeEach(() => {
    fake = fakeSession();
    jobs = new AgentJobs(async () => fake!.session);
    promptFile = path.join(temporaryDirectory("prompt"), "p.txt");
    fs.writeFileSync(promptFile, "worker prompt");
    bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: composeCommands(createAgentJobsCommand(jobs), async (argv) =>
        argv[0] === "agent"
          ? { ok: true, lines: ["blocking-form"] }
          : undefined,
      ),
    });
  });

  afterEach(() => {
    jobs?.close();
    bridge?.close();
    bridge = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const speak = (payload: string[]): Promise<{ status: string; lines: string[] }> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(bridge!.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${[...payload, ""].join("\n")}`);
        socket.end();
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
      });
      socket.on("close", () => {
        const parts = buffer.replace(/\n$/, "").split("\n");
        const status = parts.shift() ?? "";
        resolve({ status, lines: parts });
      });
    });

  it("submit returns an id instantly and result joins through the socket", async () => {
    const submitted = await speak(["agent", "submit", `promptFile=${promptFile}`, "name=sock-test"]);
    expect(submitted.status).toBe("OK");
    expect(submitted.lines[0]).toMatch(/^id=/);
    const id = (submitted.lines[0] ?? "").slice("id=".length);

    const peek = await speak(["agent", "status", id]);
    expect(peek.lines[0]).toBe("state=running");

    fake!.controller.resolvePrompt([{ role: "assistant", content: [{ type: "text", text: "socket result" }] }]);
    const joined = await speak(["agent", "wait", id]);
    expect(joined.lines[0]).toBe("state=done");
    const result = await speak(["agent", "result", id]);
    expect(result.lines).toEqual(["socket result"]);
  });

  it("steer carries a textFile payload and errors surface as ERR", async () => {
    const textFile = path.join(temporaryDirectory("text"), "steer.txt");
    fs.writeFileSync(textFile, "pivot");
    const submitted = await speak(["agent", "submit", `promptFile=${promptFile}`]);
    const id = (submitted.lines[0] ?? "").slice("id=".length);
    const steered = await speak(["agent", "steer", id, `textFile=${textFile}`]);
    expect(steered.lines).toEqual(["state=queued"]);
    expect(fake!.controller.steerTexts).toEqual(["pivot"]);

    const bad = await speak(["agent", "steer", "nonexistent", `textFile=${textFile}`]);
    expect(bad.status).toMatch(/^ERR/);
    expect(bad.status).toContain("unknown agent job");
  });

  it("the blocking form still falls through when jobs do not claim it", async () => {
    const reply = await speak(["agent", `promptFile=${promptFile}`]);
    expect(reply.lines).toEqual(["blocking-form"]);
  });
});
