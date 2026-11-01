import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore, MAX_DECISION_DEADLINE_MS, type DecisionRecord } from "../src/decisions/store.js";
import { cancelOrphanedChildQuestions, requestHeadlessApproval, routeChildQuestion } from "../src/decisions/host.js";
import { ApprovalController } from "../src/core/approval-controller.js";
import type { ResolvedFabricAction } from "../src/core/action-registry.js";
import type { AgentChildQuestionRequest } from "../src/agents/types.js";

const roots: string[] = [];
const main: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main" };
const human = { answeredBy: "alice", via: "cli" };

const decisionStore = (): DecisionStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-host-"));
  roots.push(root);
  return new DecisionStore(new MeshStore(root, 64 * 1024, 500), main);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const waitForOpen = async (store: DecisionStore): Promise<DecisionRecord> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [open] = await store.list({ status: "open" });
    if (open) return open;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no open decision appeared");
};

const request = (
  question: Record<string, unknown>,
  signal = new AbortController().signal,
): AgentChildQuestionRequest & { onDecision: ReturnType<typeof vi.fn<(id: string) => void>> } => ({
  runId: "run-1",
  name: "worker",
  question: { requestId: "q1", timeout: 60_000, ...question },
  signal,
  onDecision: vi.fn<(id: string) => void>(),
});

const action: ResolvedFabricAction = {
  ref: "demo.write",
  provider: "demo",
  name: "write",
  description: "Write data",
  inputSchema: {},
  risk: "write",
};

describe("routeChildQuestion", () => {
  it("asks through the parent's interactive UI, labelled with the child name", async () => {
    const select = vi.fn(async () => "Beta");
    const confirm = vi.fn(async () => true);
    const input = vi.fn(async () => undefined);
    const context = { hasUI: true, ui: { select, confirm, input } } as unknown as ExtensionContext;
    expect(await routeChildQuestion(request({ method: "select", title: "Pick", options: ["Alpha", "Beta"] }), { context }))
      .toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledWith("worker: Pick", ["Alpha", "Beta"], expect.objectContaining({ timeout: 60_000 }));
    expect(await routeChildQuestion(request({ method: "confirm", title: "Sure?", message: "m" }), { context }))
      .toEqual({ confirmed: true });
    expect(await routeChildQuestion(request({ method: "input", title: "Name" }), { context })).toEqual({ cancelled: true });
  });

  it("raises a root-held decision without UI and maps the answer back", async () => {
    const store = decisionStore();
    const context = { hasUI: false } as ExtensionContext;
    const routed = request({ method: "select", title: "Pick", message: "why", options: ["Alpha", "Beta"] });
    const pending = routeChildQuestion(routed, { context, store });
    const open = await waitForOpen(store);
    expect(open).toMatchObject({
      kind: "question",
      holder: "root",
      title: "worker: Pick",
      body: "why",
      raisedBy: { participantId: "run-1", runId: "run-1" },
      options: [{ id: "o1", label: "Alpha" }, { id: "o2", label: "Beta" }],
    });
    expect(routed.onDecision).toHaveBeenCalledWith(open.id);
    await store.answer(open.id, { optionId: "o2" }, human);
    expect(await pending).toEqual({ value: "Beta" });
  });

  it("maps text and confirm decisions and cancels on decision cancel", async () => {
    const store = decisionStore();
    const context = { hasUI: false } as ExtensionContext;
    const text = routeChildQuestion(request({ method: "input", title: "Name" }), { context, store });
    await store.answer((await waitForOpen(store)).id, { text: "Ada" }, human);
    expect(await text).toEqual({ value: "Ada" });
    const confirm = routeChildQuestion(request({ method: "confirm", title: "Ok?" }), { context, store });
    await store.answer((await waitForOpen(store)).id, { optionId: "no" }, human);
    expect(await confirm).toEqual({ confirmed: false });
    const cancelled = routeChildQuestion(request({ method: "editor", title: "Draft" }), { context, store });
    await store.cancel((await waitForOpen(store)).id, human);
    expect(await cancelled).toEqual({ cancelled: true });
  });

  it("cancels the decision when the child run settles", async () => {
    const store = decisionStore();
    const controller = new AbortController();
    const pending = routeChildQuestion(
      request({ method: "input", title: "Slow" }, controller.signal),
      { context: { hasUI: false } as ExtensionContext, store },
    );
    const open = await waitForOpen(store);
    controller.abort(new Error("settled"));
    await expect(pending).rejects.toThrow("settled");
    expect((await store.get(open.id))?.status).toBe("cancelled");
  });

  it("holds a question as a root decision with the longest deadline, even with a parent UI", async () => {
    let now = 1_000_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-host-"));
    roots.push(root);
    const store = new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, () => now);
    const select = vi.fn(async () => "Alpha");
    const notify = vi.fn();
    const context = { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext;
    const routed = { ...request({ method: "select", title: "Pick", options: ["Alpha", "Beta"], hold: true }), hold: true as const };
    const pending = routeChildQuestion(routed, { context, store });
    const open = await waitForOpen(store);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(open.id), "info");
    expect(open).toMatchObject({ kind: "question", holder: "root", title: "worker: Pick" });
    expect(open.deadline).toBe(now + MAX_DECISION_DEADLINE_MS);
    now += 2 * 60 * 60 * 1_000;
    expect((await store.get(open.id))?.status).toBe("open");
    await store.answer(open.id, { optionId: "o2" }, human);
    expect(await pending).toEqual({ value: "Beta" });
  });

  it("bounds a held decision so a session that died without shutdown cannot leave it open forever", async () => {
    // The raising session crashes: nothing aborts its wait or cancels the decision.
    let now = 1_000_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-host-"));
    roots.push(root);
    const crashed = new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, () => now);
    const routed = { ...request({ method: "select", title: "Pick", options: ["Alpha", "Beta"] }), hold: true as const };
    const pending = routeChildQuestion(routed, { store: crashed });
    const open = await waitForOpen(crashed);
    // A later session, with a different identity, reads the same mesh.
    const other: MeshIdentity = { id: "session:later", name: "main", kind: "main", sessionId: "later" };
    const later = new DecisionStore(new MeshStore(root, 64 * 1024, 500), other, () => now);
    now += 2 * 60 * 60 * 1_000;
    expect((await later.get(open.id))?.status).toBe("open");
    now += MAX_DECISION_DEADLINE_MS;
    expect((await later.get(open.id))?.status).toBe("expired");
    expect(await later.list({ status: "open" })).toEqual([]);
    // Had the raiser lived, its child would have been released with a cancellation.
    expect(await pending).toEqual({ cancelled: true });
  });

  it("holds through the UI with no timeout when there is no decision store", async () => {
    vi.useFakeTimers();
    try {
      let answer: ((value: string) => void) | undefined;
      const select = vi.fn((_title: string, _options: string[], _dialog?: unknown) =>
        new Promise<string>((resolve) => { answer = resolve; }));
      const editor = vi.fn(async () => "draft");
      const context = { hasUI: true, ui: { select, editor } } as unknown as ExtensionContext;
      const held = (question: Record<string, unknown>) => ({ ...request({ ...question, timeout: 1_000 }), hold: true as const });
      const pending = routeChildQuestion(held({ method: "select", title: "Pick", options: ["Alpha", "Beta"] }), { context });
      await vi.advanceTimersByTimeAsync(0);
      expect(select.mock.calls[0]![2]).not.toHaveProperty("timeout");
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
      answer!("Beta");
      expect(await pending).toEqual({ value: "Beta" });
      // The editor has no dialog timeout; a held one is not raced against a timer.
      expect(await routeChildQuestion(held({ method: "editor", title: "Write" }), { context })).toEqual({ value: "draft" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the question's deadline when the request does not hold", async () => {
    const store = decisionStore();
    const routed = request({ method: "input", title: "Name", hold: true });
    const pending = routeChildQuestion(routed, { context: { hasUI: false } as ExtensionContext, store });
    const open = await waitForOpen(store);
    // The worker payload alone cannot ask for a hold; only the host-set request flag can.
    expect(open.deadline).toBeDefined();
    await store.answer(open.id, { text: "x" }, human);
    expect(await pending).toEqual({ value: "x" });
  });

  it("fails closed without UI or store, and on malformed requests", async () => {
    const context = { hasUI: false } as ExtensionContext;
    expect(await routeChildQuestion(request({ method: "input", title: "x" }), { context })).toEqual({ cancelled: true });
    expect(await routeChildQuestion(request({ method: "notify" }), { context, store: decisionStore() })).toEqual({ cancelled: true });
    expect(await routeChildQuestion(request({ method: "select", options: [] }), { context, store: decisionStore() }))
      .toEqual({ cancelled: true });
  });
});

describe("headless approvals", () => {
  it("approves only on an explicit approve answer", async () => {
    const store = decisionStore();
    const approved = requestHeadlessApproval(store, action, { reason: "because" });
    const open = await waitForOpen(store);
    expect(open).toMatchObject({ kind: "approval", holder: "user", title: "demo.write requests write access" });
    expect(open.body).toBe("Write data\n\nbecause");
    await store.answer(open.id, { optionId: "approve" }, human);
    expect(await approved).toBe(true);

    const denied = requestHeadlessApproval(store, action);
    await store.answer((await waitForOpen(store)).id, { optionId: "deny" }, human);
    expect(await denied).toBe(false);
  });

  it("denies on expiry", async () => {
    const store = decisionStore();
    expect(await requestHeadlessApproval(store, action, { timeoutMs: 1_000 })).toBe(false);
    const [expired] = await store.list({ status: "expired" });
    expect(expired?.kind).toBe("approval");
  });

  it("ApprovalController uses the decision path only when approvals.headless is decision", async () => {
    const policies = { read: "allow", write: "ask", execute: "ask", network: "ask", agent: "ask" } as const;
    const headless = vi.fn(async () => true);
    const noUi = { hasUI: false } as ExtensionContext;
    await expect(new ApprovalController(policies, noUi, undefined, undefined, undefined, undefined, headless).approve(action))
      .rejects.toThrow(/no interactive UI/);
    expect(headless).not.toHaveBeenCalled();
    const decisionPolicies = { ...policies, headless: "decision" as const };
    await new ApprovalController(decisionPolicies, noUi, undefined, undefined, undefined, undefined, headless).approve(action);
    expect(headless).toHaveBeenCalledWith(action, undefined);
    const denying = vi.fn(async () => false);
    await expect(new ApprovalController(decisionPolicies, noUi, undefined, undefined, undefined, undefined, denying).approve(action))
      .rejects.toThrow(/denied, cancelled, or expired/);
    // No handler wired: still fail closed.
    await expect(new ApprovalController(decisionPolicies, noUi).approve(action)).rejects.toThrow(/no interactive UI/);
  });
});

describe("/fabric decisions", () => {
  it("lists open decisions and answers the picked one through native dialogs", async () => {
    const { openFabricDecisions } = await import("../src/decisions/command.js");
    const store = decisionStore();
    const approval = await store.raise({
      kind: "approval",
      title: "demo.write requests write access",
      options: [{ id: "approve", label: "Approve once" }, { id: "deny", label: "Deny" }],
    });
    const select = vi.fn()
      .mockImplementationOnce(async (_title: string, labels: string[]) => labels[0])
      .mockImplementationOnce(async () => "Approve once");
    const notify = vi.fn();
    const context = { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext;
    await openFabricDecisions(store.mesh, context);
    expect(select.mock.calls[1]![1]).toEqual(["Approve once", "Deny", "Cancel this decision"]);
    expect(await store.get(approval.id)).toMatchObject({ status: "answered", answer: { optionId: "approve", via: "tui" } });

    const text = await store.raise({ title: "Why?" });
    const input = vi.fn(async () => "because");
    const answerFirst = vi.fn(async (_title: string, labels: string[]) => labels[0]);
    await openFabricDecisions(store.mesh, { hasUI: true, ui: { select: answerFirst, input, notify } } as unknown as ExtensionContext, text.id.slice(-6));
    expect((await store.get(text.id))?.answer?.text).toBe("because");
    await openFabricDecisions(store.mesh, context);
    expect(notify).toHaveBeenLastCalledWith("No open Fabric decisions", "info");
  });
});

describe("cancelOrphanedChildQuestions", () => {
  const routed = { kind: "question", title: "worker: Pick", input: "text", holder: "root", timeoutMs: 60_000 };

  it("cancels only the open routed questions its own identity raised", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-orphans-"));
    roots.push(root);
    const mesh = new MeshStore(root, 64 * 1024, 500);
    const host = new DecisionStore(mesh, { id: "resident:abc", name: "host", kind: "agent", sessionId: "s" });
    // The durable child itself runs Fabric under the run id and may raise its own decisions.
    const child = new DecisionStore(mesh, { id: "run-1", name: "child", kind: "agent", sessionId: "c" });
    const otherHost = new DecisionStore(mesh, { id: "resident:def", name: "other", kind: "agent", sessionId: "o" });

    const orphan = await host.raise(routed, { participantId: "run-1", runId: "run-1" });
    const childOwn = await child.raise(routed, { runId: "run-1" });
    const elsewhere = await otherHost.raise(routed, { participantId: "run-2", runId: "run-2" });
    const approval = await host.raise({ ...routed, kind: "approval" }, { participantId: "run-1", runId: "run-1" });
    const runless = await host.raise(routed, {});
    const answered = await host.raise(routed, { participantId: "run-3", runId: "run-3" });
    await host.answer(answered.id, { text: "done" }, human);

    expect(await cancelOrphanedChildQuestions(host)).toEqual([orphan.id]);
    expect(await host.get(orphan.id)).toMatchObject({
      status: "cancelled",
      answer: { answeredBy: "resident:abc", via: "restart" },
    });
    for (const untouched of [childOwn, elsewhere, approval, runless]) {
      expect(await host.get(untouched.id)).toMatchObject({ status: "open" });
    }
    expect(await host.get(answered.id)).toMatchObject({ status: "answered" });
  });
});
