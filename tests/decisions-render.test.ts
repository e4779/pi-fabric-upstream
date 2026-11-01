import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore, type DecisionRecord } from "../src/decisions/store.js";
import { routeChildQuestion } from "../src/decisions/host.js";
import { openFabricDecisions } from "../src/decisions/command.js";
import type { FabricQuestionRenderers } from "../src/fabric-state.js";
import { normalizeFabricConfig } from "../src/config.js";
import piFabric from "../src/index.js";
import type { AgentChildQuestionRequest } from "../src/agents/types.js";

// The literal event name is the contract, so a renamed constant fails here.
const REGISTER_EVENT = "pi-fabric:question-renderer:register:v1";

interface RenderInput {
  version: number;
  surface: string;
  ui: unknown;
  decision: DecisionRecord;
  signal: AbortSignal;
}

const roots: string[] = [];
const main: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main" };
const human = { answeredBy: "alice", via: "cli" };

const decisionStore = (now?: () => number): DecisionStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-render-"));
  roots.push(root);
  return new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, now);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

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

const pick = { method: "select", title: "Pick", message: "why", options: ["Alpha", "Beta"] };

// A plain registry stand-in, so each test fails on behaviour, not on a missing
// module, when the renderer path is absent.
const registry = (...renders: Array<(input: RenderInput) => unknown>): FabricQuestionRenderers => ({
  size: renders.length,
  list: () => renders.map((render, index) => ({ name: `renderer-${index}`, render })),
}) as unknown as FabricQuestionRenderers;

/** A registry with one renderer that records every input and answers with `render`. */
const withRenderer = (
  render: (input: RenderInput) => unknown,
): { renderers: FabricQuestionRenderers; seen: RenderInput[] } => {
  const seen: RenderInput[] = [];
  const renderers = registry((input) => {
    seen.push(input);
    return render(input);
  });
  return { renderers, seen };
};

const uiContext = () => {
  const select = vi.fn(async (_title: string, options: string[]) => options[1]);
  const notify = vi.fn();
  const context = { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext;
  return { context, select, notify };
};

const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

describe("question renderers are off by default", () => {
  it("ui.questionRenderers is on only for an explicit true", () => {
    expect(normalizeFabricConfig({ ui: { questionRenderers: true } }).ui.questionRenderers).toBe(true);
    expect(normalizeFabricConfig({ ui: { questionRenderers: "true" } }).ui.questionRenderers).toBeUndefined();
    expect(normalizeFabricConfig({}).ui.questionRenderers).toBeUndefined();
  });

  it("consults renderers only when the setting is on and one is registered", async () => {
    const { FabricQuestionRenderers } = await import("../src/fabric-state.js");
    const registered = new FabricQuestionRenderers();
    const unregister = registered.register("ui", () => undefined);
    expect(registered.active(undefined)).toBeUndefined();
    expect(registered.active(false)).toBeUndefined();
    expect(registered.active(true)).toBe(registered);
    unregister();
    expect(registered.active(true)).toBeUndefined();
  });

  it("without renderers, a UI question uses the direct dialog and never touches the store", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const routed = request(pick);
    expect(await routeChildQuestion(routed, { context, store })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("worker: Pick", ["Alpha", "Beta"], { signal: routed.signal, timeout: 60_000 });
    expect(routed.onDecision).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });
});

describe("pi-fabric:question-renderer:register:v1", () => {
  const load = async () => {
    const events = createEventBus();
    const shutdown: Array<() => unknown> = [];
    const pi = {
      events,
      getActiveTools: vi.fn(() => []),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: () => unknown) => {
        if (event === "session_shutdown") shutdown.push(handler);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    await piFabric(pi);
    return { events, shutdown };
  };

  it("accepts a named renderer and hands back its unregister function", async () => {
    const { events, shutdown } = await load();
    const respond = vi.fn();
    events.emit(REGISTER_EVENT, { version: 1, name: "rich-questions", render: () => undefined, respond });
    expect(respond).toHaveBeenCalledWith({ ok: true, unregister: expect.any(Function) });
    const refused = vi.fn();
    events.emit(REGISTER_EVENT, { version: 1, name: "bad name!", render: () => undefined, respond: refused });
    expect(refused).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("name must match") });
    for (const handler of shutdown) await handler();
  });
});

describe("question renderers for routed child questions", () => {
  it("lets a registered renderer answer, so ctx.ui.select is never called", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => ({
      status: "answered",
      decisionId: input.decision.id,
      answer: { optionId: "o2" },
    }));
    const routed = request(pick);
    expect(await routeChildQuestion(routed, { context, store, renderers })).toEqual({ value: "Beta" });
    expect(select).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const [input] = seen;
    expect(input).toMatchObject({
      version: 1,
      surface: "child-question",
      decision: {
        kind: "question",
        title: "worker: Pick",
        body: "why",
        input: "select",
        holder: "root",
        options: [{ id: "o1", label: "Alpha" }, { id: "o2", label: "Beta" }],
        raisedBy: { participantId: "run-1", runId: "run-1" },
      },
    });
    expect(input!.ui).toBe(context.ui);
    expect(routed.onDecision).toHaveBeenCalledWith(input!.decision.id);
    expect(await store.get(input!.decision.id)).toMatchObject({
      status: "answered",
      answer: { optionId: "o2", via: "tui" },
    });
  });

  it("asks the next renderer when one declines, then falls back to ctx.ui when all decline", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const declined = vi.fn(() => undefined);
    const renderers = registry(
      declined,
      (input) => ({ status: "answered", decisionId: input.decision.id, answer: { optionId: "o1" } }),
    );
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Alpha" });
    expect(declined).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();

    const routed = request(pick);
    const none = withRenderer(() => undefined);
    expect(await routeChildQuestion(routed, { context, store, renderers: none.renderers })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledWith("worker: Pick", ["Alpha", "Beta"], expect.objectContaining({ timeout: 60_000 }));
    expect(await store.get(routed.onDecision.mock.calls[0]![0])).toMatchObject({
      status: "answered",
      answer: { optionId: "o2", via: "tui" },
    });
  });

  it("falls back to ctx.ui when the renderer throws or rejects", async () => {
    for (const render of [
      () => { throw new Error("renderer broke"); },
      async () => { throw new Error("renderer broke later"); },
    ]) {
      const store = decisionStore();
      const { context, select } = uiContext();
      const { renderers, seen } = withRenderer(render);
      expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Beta" });
      expect(seen).toHaveLength(1);
      expect(select).toHaveBeenCalledTimes(1);
      expect((await store.get(seen[0]!.decision.id))?.status).toBe("answered");
    }
  });

  it("refuses an answer for a different decision and falls back to ctx.ui", async () => {
    const store = decisionStore();
    const other = await store.raise({ title: "Unrelated", options: [{ id: "o2", label: "Yes" }], holder: "user" });
    const { context, select } = uiContext();
    const { renderers } = withRenderer(() => ({
      status: "answered",
      decisionId: other.id,
      answer: { optionId: "o2" },
    }));
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledTimes(1);
    expect((await store.get(other.id))?.status).toBe("open");
  });

  it("lets a renderer change only the answer, never holder, raiser or attribution", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => {
      // Mutating the copy it was handed must not reach the record.
      input.decision.holder = "user";
      input.decision.raisedBy.participantId = "session:main";
      return {
        status: "answered",
        decisionId: input.decision.id,
        holder: "user",
        answeredBy: "session:main",
        via: "cli",
        answer: { optionId: "o1", answeredBy: "session:main", via: "cli", at: 1 },
      };
    });
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Alpha" });
    expect(select).not.toHaveBeenCalled();
    const stored = await store.get(seen[0]!.decision.id);
    expect(stored).toMatchObject({ holder: "root", raisedBy: { participantId: "run-1" }, answer: { optionId: "o1", via: "tui" } });
    expect(stored?.answer?.answeredBy).not.toBe("session:main");
    expect(stored?.answer?.at).not.toBe(1);
  });

  it("falls back to ctx.ui when the renderer's answer does not fit the decision", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => ({
      status: "answered",
      decisionId: input.decision.id,
      answer: { optionId: "o9" },
    }));
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Beta" });
    expect(select).toHaveBeenCalledTimes(1);
    expect((await store.get(seen[0]!.decision.id))?.answer?.optionId).toBe("o2");
  });

  it("aborts the render when the decision is cancelled in the store", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => {
      void store.cancel(input.decision.id, human);
      return untilAborted(input.signal);
    });
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ cancelled: true });
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(seen[0]!.decision.id)).toMatchObject({ status: "cancelled", answer: { via: "cli" } });
  });

  it("aborts the render when the decision expires", async () => {
    let now = 1_000_000;
    const store = decisionStore(() => now);
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => {
      now += 120_000;
      return untilAborted(input.signal);
    });
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ cancelled: true });
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect((await store.get(seen[0]!.decision.id))?.status).toBe("expired");
  });

  it("aborts the render and cancels the decision when the child run settles", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const controller = new AbortController();
    const { renderers, seen } = withRenderer((input) => {
      controller.abort(new Error("settled"));
      return untilAborted(input.signal);
    });
    // As on the headless path, the abort reason rejects; the manager turns it into a cancel.
    await expect(routeChildQuestion(request(pick, controller.signal), { context, store, renderers })).rejects.toThrow("settled");
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(seen[0]!.decision.id)).toMatchObject({ status: "cancelled", answer: { via: "abort" } });
  });

  it("cancels the decision when the renderer dismisses the question", async () => {
    const store = decisionStore();
    const { context, select } = uiContext();
    const { renderers, seen } = withRenderer((input) => ({ status: "dismissed", decisionId: input.decision.id }));
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ cancelled: true });
    expect(select).not.toHaveBeenCalled();
    expect((await store.get(seen[0]!.decision.id))?.status).toBe("cancelled");
  });

  it("leaves a held question on the hold path: the renderer is not consulted", async () => {
    const store = decisionStore();
    const notify = vi.fn();
    const select = vi.fn();
    const context = { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext;
    const { renderers, seen } = withRenderer(() => undefined);
    const routed = { ...request({ ...pick, hold: true }), hold: true as const };
    const pending = routeChildQuestion(routed, { context, store, renderers });
    await vi.waitFor(() => expect(routed.onDecision).toHaveBeenCalledTimes(1));
    const id = routed.onDecision.mock.calls[0]![0];
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(id), "info");
    await store.answer(id, { optionId: "o1" }, human);
    expect(await pending).toEqual({ value: "Alpha" });
    expect(seen).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps a select with more options than a decision holds on the direct dialog, unrecorded", async () => {
    const store = decisionStore();
    const options = Array.from({ length: 13 }, (_, index) => `Option ${index + 1}`);
    const select = vi.fn(async () => "Option 13");
    const context = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
    const { renderers, seen } = withRenderer(() => undefined);
    const routed = request({ method: "select", title: "Many", options });
    expect(await routeChildQuestion(routed, { context, store, renderers })).toEqual({ value: "Option 13" });
    expect(seen).toHaveLength(0);
    expect(routed.onDecision).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("uses direct UI for context a decision cannot represent losslessly", async () => {
    const store = decisionStore();
    const select = vi.fn(async (_title: string, options: string[]) => options[1]);
    const confirm = vi.fn(async () => true);
    const input = vi.fn(async () => "typed");
    const editor = vi.fn(async () => "edited");
    const context = { hasUI: true, ui: { select, confirm, input, editor } } as unknown as ExtensionContext;
    const { renderers, seen } = withRenderer(() => { throw new Error("must not render"); });
    const longOption = "x".repeat(201);
    const longMessage = "m".repeat(4001);
    const cases = [
      { question: { ...pick, title: "t".repeat(200) }, result: { value: "Beta" } },
      { question: { ...pick, message: longMessage }, result: { value: "Beta" } },
      { question: { ...pick, options: ["Alpha", longOption] }, result: { value: longOption } },
      { question: { ...pick, options: ["Alpha", ""] }, result: { value: "" } },
      { question: { ...pick, options: ["Alpha", "  "] }, result: { value: "  " } },
      { question: { method: "confirm", title: "Confirm", message: longMessage }, result: { confirmed: true } },
      { question: { method: "input", title: "Input", placeholder: "hint" }, result: { value: "typed" } },
      { question: { method: "editor", title: "Edit", prefill: "draft" }, result: { value: "edited" } },
    ];
    for (const item of cases) {
      const routed = request(item.question);
      expect(await routeChildQuestion(routed, { context, store, renderers })).toEqual(item.result);
      expect(routed.onDecision).not.toHaveBeenCalled();
    }
    expect(confirm).toHaveBeenCalledWith("worker: Confirm", longMessage, expect.any(Object));
    expect(input).toHaveBeenCalledWith("worker: Input", "hint", expect.any(Object));
    expect(editor).toHaveBeenCalledWith("worker: Edit", "draft");
    expect(select).toHaveBeenCalledWith("worker: Pick", ["Alpha", longOption], expect.any(Object));
    expect(seen).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("cancels the record and the child's dialog when the store refuses the typed text", async () => {
    const store = decisionStore();
    const editor = vi.fn(async () => "x".repeat(4_001));
    const context = { hasUI: true, ui: { editor } } as unknown as ExtensionContext;
    const routed = request({ method: "editor", title: "Draft" });
    const { renderers } = withRenderer(() => undefined);
    expect(await routeChildQuestion(routed, { context, store, renderers })).toEqual({ cancelled: true });
    expect(editor).toHaveBeenCalledTimes(1);
    expect((await store.get(routed.onDecision.mock.calls[0]![0]))?.status).toBe("cancelled");
  });

  it("closes the fallback dialog and returns the record's answer when the CLI answers first", async () => {
    const store = decisionStore();
    let dialogSignal: AbortSignal | undefined;
    const select = vi.fn(async (_title: string, _options: string[], dialog: { signal: AbortSignal }) => {
      dialogSignal = dialog.signal;
      const [open] = await store.list({ status: "open" });
      await store.answer(open!.id, { optionId: "o1" }, human);
      await new Promise((resolve) => dialog.signal.addEventListener("abort", resolve, { once: true }));
      return undefined;
    });
    const context = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
    const { renderers } = withRenderer(() => undefined);
    expect(await routeChildQuestion(request(pick), { context, store, renderers })).toEqual({ value: "Alpha" });
    expect(dialogSignal?.aborted).toBe(true);
  });
});

describe("question renderers in /fabric decisions", () => {
  it("lets a registered renderer answer the picked decision without ctx.ui dialogs", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Why?", holder: "user" });
    const { context, select, notify } = uiContext();
    const { renderers, seen } = withRenderer((input) => ({
      status: "answered",
      decisionId: input.decision.id,
      answer: { text: "because" },
    }));
    await openFabricDecisions(store.mesh, context, record.id, renderers);
    expect(select).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ surface: "decisions-command", decision: { id: record.id, input: "text" } });
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { text: "because", via: "tui" } });
    expect(notify).toHaveBeenLastCalledWith(`Answered ${record.id}`, "info");
  });

  it("leaves the decision open when the renderer dismisses it, and falls back when it throws", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const dismissed = uiContext();
    await openFabricDecisions(
      store.mesh,
      dismissed.context,
      record.id,
      withRenderer((input) => ({ status: "dismissed", decisionId: input.decision.id })).renderers,
    );
    expect(dismissed.select).not.toHaveBeenCalled();
    expect((await store.get(record.id))?.status).toBe("open");

    const broken = uiContext();
    await openFabricDecisions(store.mesh, broken.context, record.id, withRenderer(() => {
      throw new Error("renderer broke");
    }).renderers);
    expect(broken.select).toHaveBeenCalledTimes(1);
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { optionId: "b" } });
  });

  it("lets a renderer cancel the decision it was handed, and only that one", async () => {
    const store = decisionStore();
    const other = await store.raise({ title: "Other" });
    const record = await store.raise({ title: "Mine" });
    const wrong = uiContext();
    wrong.select.mockImplementation(async () => undefined);
    await openFabricDecisions(store.mesh, wrong.context, record.id, withRenderer(() => ({
      status: "cancelled",
      decisionId: other.id,
    })).renderers);
    expect(wrong.select).toHaveBeenCalledTimes(1);
    expect((await store.get(other.id))?.status).toBe("open");
    expect((await store.get(record.id))?.status).toBe("open");

    const right = uiContext();
    await openFabricDecisions(store.mesh, right.context, record.id, withRenderer((input) => ({
      status: "cancelled",
      decisionId: input.decision.id,
    })).renderers);
    expect(right.select).not.toHaveBeenCalled();
    expect(await store.get(record.id)).toMatchObject({ status: "cancelled", answer: { via: "tui" } });
    expect((await store.get(other.id))?.status).toBe("open");
  });

  it("aborts the render when the decision is answered elsewhere", async () => {
    const store = decisionStore();
    const record = await store.raise({ title: "Why?" });
    const { context, select, notify } = uiContext();
    const { renderers, seen } = withRenderer((input) => {
      void store.answer(input.decision.id, { text: "from cli" }, human);
      return untilAborted(input.signal);
    });
    await openFabricDecisions(store.mesh, context, record.id, renderers);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(await store.get(record.id)).toMatchObject({ status: "answered", answer: { text: "from cli", via: "cli" } });
    expect(notify).toHaveBeenLastCalledWith(`Answered ${record.id}`, "info");
  });
});
