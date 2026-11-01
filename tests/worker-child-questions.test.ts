import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ChildQuestionRelay } from "../src/worker/questions.js";
import type {
  AgentChildQuestionRequest,
  AgentChildQuestionResponse,
  AgentRunRecord,
} from "../src/agents/types.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

const fakePi = path.resolve("tests/fixtures/fake-pi-rpc-question.mjs");
const roots: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
  delete process.env.FAKE_PI_QUESTION_LOG;
  delete process.env.FAKE_PI_QUESTION;
  delete process.env.FAKE_PI_QUESTION_COUNT;
});

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const responses = (file: string): Array<Record<string, unknown>> =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

const setup = (
  agents: Partial<typeof DEFAULT_FABRIC_CONFIG.agents>,
  onChildQuestion?: (request: AgentChildQuestionRequest) => Promise<AgentChildQuestionResponse>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-child-question-"));
  roots.push(root);
  fs.chmodSync(fakePi, 0o755);
  const log = path.join(root, "responses.jsonl");
  process.env.FAKE_PI_QUESTION_LOG = log;
  const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, ...agents }, {
    workerPath: path.resolve("src/worker.ts"),
    piBinary: fakePi,
    runRoot: root,
    fullCodeMode: false,
    ...(onChildQuestion ? { onChildQuestion } : {}),
  });
  managers.push(manager);
  return { manager, log };
};

describe("routed child questions (worker round trip)", () => {
  it("routes a child select through the parent, marks blockedOn, and forwards the answer", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: AgentChildQuestionRequest[] = [];
    const { manager, log } = setup({ childQuestions: "route", childQuestionTimeoutMs: 30_000 }, async (request) => {
      seen.push(request);
      request.onDecision("dec_testdecision01");
      await gate;
      return { value: "B" };
    });
    const handle = await manager.spawn({ task: "ASK", transport: "process" });
    await waitFor(() => seen.length === 1 && Boolean((manager.status(handle.id) as AgentRunRecord).blockedOn));
    expect(seen[0]!.question).toMatchObject({ requestId: "ui-1", method: "select", title: "Pick", options: ["A", "B"] });
    expect(seen[0]!.name).toBe(handle.name);
    expect((manager.status(handle.id) as AgentRunRecord).blockedOn).toMatchObject({
      decisionId: "dec_testdecision01",
      since: expect.any(Number),
    });
    expect(manager.activity()).toEqual([{ id: handle.id, name: handle.name, question: "Pick" }]);
    release!();
    const result = await manager.wait(handle.id);
    expect(manager.activity()).toEqual([]);
    expect(responses(log)).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "B" }]);
    expect(result.blockedOn).toBeUndefined();
    expect(result.status).toBe("completed");
  }, 30_000);

  it("keeps a run waiting in activity until its last open question is answered", async () => {
    process.env.FAKE_PI_QUESTION_COUNT = "2";
    const gates = new Map<string, () => void>();
    const { manager } = setup({ childQuestions: "route", childQuestionTimeoutMs: 30_000 }, async (request) => {
      const requestId = String(request.question.requestId);
      await new Promise<void>((resolve) => gates.set(requestId, resolve));
      return { value: "A" };
    });
    const handle = await manager.spawn({ task: "ASK", transport: "process" });
    await waitFor(() => gates.size === 2);
    expect(manager.activity()).toEqual([{ id: handle.id, name: handle.name, question: "Pick" }]);
    // Both questions share a title; answering one must not clear the other.
    gates.get("ui-2")!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.activity()).toEqual([{ id: handle.id, name: handle.name, question: "Pick" }]);
    gates.get("ui-1")!();
    await manager.wait(handle.id);
    expect(manager.activity()).toEqual([]);
  }, 30_000);

  it("cancels at the worker deadline when the parent never answers", async () => {
    const { manager, log } = setup(
      { childQuestions: "route", childQuestionTimeoutMs: 1_000 },
      () => new Promise<AgentChildQuestionResponse>(() => {}),
    );
    const handle = await manager.spawn({ task: "ASK", transport: "process" });
    await manager.wait(handle.id);
    expect(responses(log)).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
  }, 30_000);

  it("holds a question past the worker deadline when the run asks to hold questions", async () => {
    const seen: AgentChildQuestionRequest[] = [];
    const { manager, log } = setup({ childQuestions: "route", childQuestionTimeoutMs: 1_000 }, async (request) => {
      seen.push(request);
      // Answer well after the 1s worker deadline that applies without holdQuestions.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      return { value: "B" };
    });
    const handle = await manager.spawn({ task: "ASK", transport: "process", holdQuestions: true });
    const result = await manager.wait(handle.id);
    expect(seen[0]!.hold).toBe(true);
    expect(seen[0]!.question).toMatchObject({ requestId: "ui-1", hold: true });
    expect(responses(log)).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "B" }]);
    expect(result.status).toBe("completed");
  }, 30_000);

  it("refuses holdQuestions unless child questions are routed", async () => {
    const { manager } = setup({});
    await expect(manager.spawn({ task: "ASK", transport: "process", holdQuestions: true }))
      .rejects.toThrow(/holdQuestions requires agents.childQuestions "route"/);
    const routed = setup({ childQuestions: "route" }, async () => ({ value: "A" }));
    await expect(routed.manager.spawn({ task: "ASK", transport: "process", holdQuestions: "yes" as never }))
      .rejects.toThrow(/holdQuestions must be true/);
  }, 30_000);

  it("keeps the default cancel behaviour without route", async () => {
    const router = vi.fn(async (): Promise<AgentChildQuestionResponse> => ({ value: "A" }));
    const { manager, log } = setup({}, router);
    const handle = await manager.spawn({ task: "ASK", transport: "process" });
    await manager.wait(handle.id);
    expect(router).not.toHaveBeenCalled();
    expect(responses(log)).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
  }, 30_000);
});

describe("ChildQuestionRelay", () => {
  const relay = (timeoutMs = 60_000) => {
    const io = { emit: vi.fn(), send: vi.fn(), blocked: vi.fn() };
    return { io, relay: new ChildQuestionRelay(timeoutMs, io, () => 42) };
  };

  it("emits a bounded question and validates the answer shape per method", () => {
    const { io, relay: subject } = relay();
    expect(subject.request({ id: "s", method: "select", title: "Pick", options: ["A", "B", 3] })).toBe(true);
    expect(io.emit).toHaveBeenCalledWith({ requestId: "s", method: "select", title: "Pick", options: ["A", "B"], timeout: 60_000 });
    expect(io.blocked).toHaveBeenCalledWith(42);
    subject.respond({ requestId: "s", value: "C" });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "s", cancelled: true });
    expect(io.blocked).toHaveBeenLastCalledWith(undefined);

    subject.request({ id: "c", method: "confirm", title: "Ok?", message: "m", timeout: 5_000 });
    expect(io.emit).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: "c", timeout: 5_000, message: "m" }));
    subject.respond({ requestId: "c", value: "yes" });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "c", cancelled: true });

    subject.request({ id: "c2", method: "confirm", title: "Ok?" });
    subject.respond({ requestId: "c2", confirmed: true });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "c2", confirmed: true });

    subject.request({ id: "i", method: "input", title: "Name" });
    expect(subject.respond({ requestId: "unknown", value: "x" })).toBe(false);
    subject.respond({ requestId: "i", value: "Ada" });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "i", value: "Ada" });
    expect(subject.respond({ requestId: "i", value: "again" })).toBe(false);
    subject.close();
  });

  it("cancels duplicates, empty selects, and overflow immediately; rejects malformed requests", () => {
    const { io, relay: subject } = relay();
    expect(subject.request({ id: "x", method: "notify" })).toBe(false);
    expect(subject.request({ method: "input" })).toBe(false);
    expect(subject.request({ id: "e", method: "select", options: [] })).toBe(true);
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "e", cancelled: true });
    for (let index = 0; index < 16; index += 1) subject.request({ id: `q${index}`, method: "input", title: "t" });
    expect(subject.pending).toBe(16);
    subject.request({ id: "overflow", method: "input", title: "t" });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "overflow", cancelled: true });
    subject.request({ id: "q0", method: "input", title: "dup" });
    expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "q0", cancelled: true });
    subject.close();
    expect(subject.pending).toBe(0);
  });

  it("reports the oldest pending question's decision and moves on when it is answered", () => {
    const { io, relay: subject } = relay();
    subject.request({ id: "a", method: "input", title: "first" });
    subject.request({ id: "b", method: "input", title: "second" });
    expect(io.blocked.mock.calls).toEqual([[42]]);
    expect(subject.decide({ requestId: "b", decisionId: "dec_second" })).toBe(true);
    expect(io.blocked).toHaveBeenLastCalledWith(42, "dec_second");
    subject.decide({ requestId: "a", decisionId: "dec_first" });
    expect(io.blocked).toHaveBeenLastCalledWith(42, "dec_first");

    expect(subject.decide({ requestId: "unknown", decisionId: "dec_x" })).toBe(false);
    expect(subject.decide({ requestId: "a", decisionId: "" })).toBe(false);
    expect(subject.decide({ requestId: "a", decisionId: "d".repeat(129) })).toBe(false);
    expect(subject.decide({ requestId: "a", decisionId: 7 })).toBe(false);
    expect(io.blocked).toHaveBeenLastCalledWith(42, "dec_first");

    subject.respond({ requestId: "a", value: "one" });
    expect(io.blocked).toHaveBeenLastCalledWith(42, "dec_second");
    subject.respond({ requestId: "b", value: "two" });
    expect(io.blocked).toHaveBeenLastCalledWith(undefined);
    expect(io.blocked).toHaveBeenCalledTimes(5);
    subject.close();
  });

  it("never times out a held question that set no timeout of its own", () => {
    vi.useFakeTimers();
    try {
      const io = { emit: vi.fn(), send: vi.fn(), blocked: vi.fn() };
      const subject = new ChildQuestionRelay(1_000, io, () => 42, { hold: true });
      subject.request({ id: "h", method: "input", title: "slow" });
      expect(io.emit).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: "h", hold: true }));
      vi.advanceTimersByTime(2 * 60 * 60 * 1_000);
      expect(io.send).not.toHaveBeenCalled();
      expect(subject.pending).toBe(1);
      subject.respond({ requestId: "h", value: "late" });
      expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "h", value: "late" });

      // A dialog that sets its own timeout keeps it; it is not held.
      subject.request({ id: "t", method: "input", title: "timed", timeout: 5_000 });
      expect(io.emit).toHaveBeenLastCalledWith(expect.not.objectContaining({ hold: true }));
      vi.advanceTimersByTime(5_001);
      expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "t", cancelled: true });
      subject.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out pending questions as cancelled", async () => {
    vi.useFakeTimers();
    try {
      const { io, relay: subject } = relay(1_000);
      subject.request({ id: "t", method: "input", title: "slow" });
      vi.advanceTimersByTime(1_001);
      expect(io.send).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "t", cancelled: true });
      expect(io.blocked).toHaveBeenLastCalledWith(undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
