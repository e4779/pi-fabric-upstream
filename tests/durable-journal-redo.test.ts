import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_CARRY_ENTRY_TYPE, latestCarryItems } from "../src/compaction/carry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { CompactController, type CompactPendingIntent, type CompactRequestIntent } from "../src/core/compact-controller.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { MeshStore } from "../src/mesh/store.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";
import { CompactProvider } from "../src/providers/compact-provider.js";
import { PrewalkProvider } from "../src/providers/prewalk-provider.js";
import { SchemaProvider } from "../src/providers/schema-provider.js";
import { ThinkingProvider } from "../src/providers/thinking-provider.js";
import { SchemaController } from "../src/schema/controller.js";
import { StateStore } from "../src/state/store.js";
import { FABRIC_THINKING_ENTRY_TYPE, FabricThinkingController } from "../src/thinking-control.js";

// A served call skips its provider. These tests resume a fabric_exec call from
// its journal in a fresh service, as a restarted durable worker would, and check
// which host-local effects come back.

type JournalOffer = { path: string; digest?: string; accept(digest: string): Promise<void> };
type Fence = { toolCallId: string; accept(): Promise<void>; arm(): Promise<void>; journal?: JournalOffer };
const holder = globalThis as { [key: symbol]: unknown };
const fences = (holder[Symbol.for("pi-fabric.durable-tool-fence.v1")] ??= new AsyncLocalStorage<Fence>()) as AsyncLocalStorage<Fence>;

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(registries.splice(0).map(registry => registry.close().catch(() => undefined)));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(root);
  return root;
};

class RecordingCompact extends CompactController {
  readonly events: string[] = [];
  constructor(private readonly failWith?: string) { super(); }
  override request(intent: CompactRequestIntent): CompactPendingIntent {
    if (this.failWith) throw new Error(this.failWith);
    this.events.push(`request:${intent.reason ?? ""}`);
    return super.request(intent);
  }
  override cancel(): void {
    this.events.push("cancel");
    super.cancel();
  }
}

const execute = (service: FabricExecutionService, context: ExtensionContext, code: string, journal: JournalOffer) =>
  fences.run({ toolCallId: "call", accept: async () => undefined, arm: async () => undefined, journal }, () => service.execute({
    code, signal: undefined, parentToolCallId: "call", context, onPartial() {},
  }));

// One worker process: fresh in-memory controllers over the session it is given.
function worker(cwd: string, session: SessionManager, options: { level?: string; compact?: RecordingCompact } = {}) {
  const registry = new ActionRegistry(); registries.push(registry);
  const compact = options.compact ?? new RecordingCompact();
  const prewalk = new PrewalkController();
  let level = options.level ?? "medium";
  const appendEntry = (type: string, data: unknown) => { session.appendCustomEntry(type, data); };
  const thinking = new FabricThinkingController({
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => { level = next; },
    appendEntry,
  } as never, () => ({}));
  registry.register(new CompactProvider(compact, { appendEntry }));
  registry.register(new PrewalkProvider(prewalk));
  registry.register(new ThinkingProvider(thinking, session.getSessionId()));
  const service = new FabricExecutionService(registry, structuredClone(DEFAULT_FABRIC_CONFIG));
  const context = { cwd, hasUI: false, sessionManager: session } as unknown as ExtensionContext;
  return {
    compact, prewalk, thinking, context, level: () => level,
    run: (code: string, journal: JournalOffer) => execute(service, context, code, journal),
  };
}

async function record(run: (code: string, journal: JournalOffer) => Promise<unknown>, code: string) {
  const file = path.join(tempDir("fabric-redo-journal-"), "call.jsonl");
  let digest: string | undefined;
  const result = await run(code, { path: file, accept: async (value) => { digest = value; } });
  return { result, resume: { path: file, digest: digest!, accept: async () => { throw new Error("a resume must not record a new journal"); } } };
}

const entries = (session: SessionManager, type: string) =>
  session.getBranch().filter(entry => entry.type === "custom" && entry.customType === type).length;

describe("durable fabric_exec resume redoes host-local effects", () => {
  it("redoes compaction requests and cancellations once each, in their recorded order", async () => {
    const cwd = tempDir("fabric-redo-");
    const code = 'await compact.request({ reason: "first" });\nawait compact.cancel();\nawait compact.request({ reason: "second", instructions: "keep the plan" });\nreturn "done";';
    const first = worker(cwd, SessionManager.inMemory(cwd));
    const { result, resume } = await record(first.run, code);
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(first.compact.events).toEqual(["request:first", "cancel", "request:second"]);

    const resumed = worker(cwd, SessionManager.inMemory(cwd));
    expect(await resumed.run(code, resume)).toMatchObject({ success: true, value: "done" });
    expect(resumed.compact.events).toEqual(["request:first", "cancel", "request:second"]);
    expect(resumed.compact.status().pending).toMatchObject({ reason: "second", instructions: "keep the plan" });
  });

  it.each(["deadline", "cancellation"] as const)("aborts an asynchronous provider restore on %s before later effects", async (stop) => {
    const cwd = tempDir("fabric-redo-abort-");
    const code = 'await compact.request({ reason: "restore" }); await compact.cancel(); return "done";';
    const first = worker(cwd, SessionManager.inMemory(cwd));
    const { result, resume } = await record(first.run, code);
    expect(result).toMatchObject({ success: true });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let finished!: () => void;
    const restored = new Promise<void>((resolve) => { finished = resolve; });
    let restoreSignal: AbortSignal | undefined;
    const compact = new RecordingCompact();
    class LatchedCompactProvider extends CompactProvider {
      override async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
        if (name === "request") {
          restoreSignal = context.signal;
          enter();
          await held;
          finished();
          if (context.signal?.aborted) return undefined;
        }
        return super.invoke(name, args, context);
      }
    }
    const registry = new ActionRegistry(); registries.push(registry);
    registry.register(new LatchedCompactProvider(compact));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.timeoutMs = stop === "deadline" ? 100 : 5_000;
    const service = new FabricExecutionService(registry, config);
    const controller = new AbortController();
    const context = { cwd, hasUI: false, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
    const run = fences.run({ toolCallId: "call", accept: async () => {}, arm: async () => {}, journal: resume }, () => service.execute({
      code, signal: controller.signal, parentToolCallId: "call", context, onPartial() {},
    }));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered, run.then((result) => {
        throw new Error(`Execution settled before provider restoration entered: ${result.error ?? result.success}`);
      })]);
      if (stop === "cancellation") controller.abort();
      const again = await Promise.race([
        run,
        new Promise<undefined>((resolve) => { watchdog = setTimeout(() => resolve(undefined), 1_000); }),
      ]);
      expect(again, "the service must return while the provider is still latched").toBeDefined();
      expect(again).toMatchObject({ success: false });
      expect(again?.error).toContain(stop === "deadline" ? "timed out" : "cancelled");
      expect(restoreSignal?.aborted).toBe(true);
      release();
      await restored;
      await new Promise((resolve) => setImmediate(resolve));
      expect(compact.events).toEqual([]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release();
      await run;
    }
  });

  it("redoes a recorded prewalk plan for an arm that owes one, and skips it when none does", async () => {
    const cwd = tempDir("fabric-redo-");
    const plan = { outcome: "ship", steps: ["edit src/a.ts"], verification: ["bun run typecheck"], risks: "none" };
    const code = `const recorded = await prewalk.plan(${JSON.stringify(plan)});\nreturn recorded.recorded;`;
    const arm = (target: ReturnType<typeof worker>, session: SessionManager) =>
      target.prewalk.arm({ model: "provider/model", sessionId: session.getSessionId(), requirePlan: true });
    const firstSession = SessionManager.inMemory(cwd);
    const first = worker(cwd, firstSession);
    arm(first, firstSession);
    const { result, resume } = await record(first.run, code);
    expect(result).toMatchObject({ success: true, value: true });

    const session = SessionManager.inMemory(cwd);
    const resumed = worker(cwd, session);
    arm(resumed, session);
    expect(resumed.prewalk.planReady(session.getSessionId())).toBe(false);
    expect(await resumed.run(code, resume)).toMatchObject({ success: true, value: true });
    expect(resumed.prewalk.planReady(session.getSessionId())).toBe(true);

    // No arm after the restart: the plan has nowhere to go, and the resume still runs.
    const idleSession = SessionManager.inMemory(cwd);
    const idle = worker(cwd, idleSession);
    expect(await idle.run(code, resume)).toMatchObject({ success: true, value: true });
    expect(idle.prewalk.planReady(idleSession.getSessionId())).toBe(false);
  });

  const sessionCode = [
    'await compact.carry({ add: ["A"] });',
    'await compact.carry({ add: ["B"] });',
    'await compact.carry({ remove: ["A"] });',
    'await thinking.set({ level: "low" });',
    "await thinking.reset();",
    'await thinking.set({ level: "high", scope: "session" });',
    'return "done";',
  ].join("\n");

  it("redoes carry and thinking changes when their session entries were lost", async () => {
    const cwd = tempDir("fabric-redo-");
    const firstSession = SessionManager.inMemory(cwd);
    const first = worker(cwd, firstSession);
    const { result, resume } = await record(first.run, sessionCode);
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(latestCarryItems(firstSession.getBranch())).toEqual(["B"]);
    expect(first.level()).toBe("high");

    // A worker without a session file restarts with an empty session.
    const session = SessionManager.inMemory(cwd);
    const resumed = worker(cwd, session);
    expect(await resumed.run(sessionCode, resume)).toMatchObject({ success: true, value: "done" });
    expect(latestCarryItems(session.getBranch())).toEqual(["B"]);
    expect(resumed.level()).toBe("high");
    expect(resumed.thinking.status(resumed.context).override).toMatchObject({ level: "high", scope: "session" });
  });

  it("never writes a second carry or thinking entry when the first one survived", async () => {
    const cwd = tempDir("fabric-redo-");
    const session = SessionManager.inMemory(cwd);
    const first = worker(cwd, session);
    const { result, resume } = await record(first.run, sessionCode);
    expect(result).toMatchObject({ success: true, value: "done" });
    const carries = entries(session, COMPACTION_CARRY_ENTRY_TYPE);
    const levels = entries(session, FABRIC_THINKING_ENTRY_TYPE);
    expect([carries, levels]).toEqual([3, 3]);

    // The session survived, so Pi restores the level from it at start.
    const resumed = worker(cwd, session, { level: "high" });
    expect(await resumed.run(sessionCode, resume)).toMatchObject({ success: true, value: "done" });
    expect(entries(session, COMPACTION_CARRY_ENTRY_TYPE)).toBe(carries);
    expect(entries(session, FABRIC_THINKING_ENTRY_TYPE)).toBe(levels);
    expect(latestCarryItems(session.getBranch())).toEqual(["B"]);
    expect(resumed.level()).toBe("high");
  });

  it("stops the resume with the error when a redo fails, and runs nothing after it", async () => {
    const cwd = tempDir("fabric-redo-");
    const code = 'await compact.request({ reason: "first" });\nawait thinking.set({ level: "high", scope: "session" });\nreturn "done";';
    const first = worker(cwd, SessionManager.inMemory(cwd));
    const { result, resume } = await record(first.run, code);
    expect(result).toMatchObject({ success: true, value: "done" });

    const resumed = worker(cwd, SessionManager.inMemory(cwd), { compact: new RecordingCompact("compaction is unavailable") });
    const again = await resumed.run(code, resume);
    expect(again).toMatchObject({ success: false });
    expect(JSON.stringify(again)).toContain("redoing its recorded compact.request call failed: compaction is unavailable");
    // The thinking change after the failed redo was not redone.
    expect(resumed.level()).toBe("medium");
  });
});

// Schema hypotheses and certificates live in the on-disk mesh and are bound to
// the fabric_exec invocation. A durable resume keeps the tool call id, so a
// commit issued live after the served verify meets the recorded certificate.
describe("durable fabric_exec resume with a recorded Schema hypothesis", () => {
  const code = [
    'const hypothesis = await schema.hypothesize({ label: "change", summary: "create one file", evidence: [{ kind: "file_absent", path: "result.txt" }] });',
    "const verified = await schema.verify({ hypothesisId: hypothesis.hypothesisId });",
    'await tools.progress({ message: "verified" });',
    "return await schema.commit({ hypothesisId: hypothesis.hypothesisId, certificate: verified.certificate,",
    '  operations: [{ kind: "write", path: "result.txt", content: "done", expected: { absent: true } }],',
    '  postconditions: [{ kind: "file_contains", path: "result.txt", literal: "done" }] });',
  ].join("\n");

  // A process over the workspace's mesh. `crash` aborts once verify's result is
  // recorded and drops the end-of-invocation cleanup, as SIGKILL would.
  function schemaWorker(cwd: string, crash?: AbortController) {
    const mesh = new MeshStore(path.join(cwd, ".pi", "fabric", "mesh"), 256 * 1024, 500);
    const config = { ...structuredClone(DEFAULT_FABRIC_CONFIG.schema), mode: "off" as const };
    const controller = new SchemaController(cwd, config, mesh,
      { id: "session:schema", name: "main", kind: "main", sessionId: "schema" }, new StateStore(mesh));
    const schema = new SchemaProvider(controller);
    // Without invocationEnded, the certificate stays active as a killed worker leaves it.
    const provider: FabricProvider = crash ? {
      name: schema.name, description: schema.description,
      list: (request, context) => schema.list(request, context),
      describe: (name, context) => schema.describe(name, context),
      invoke: (name, args, context) => schema.invoke(name, args, context),
    } : schema;
    const registry = new ActionRegistry(); registries.push(registry);
    registry.register(provider);
    const fabricConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
    fabricConfig.ui.updateDebounceMs = 0;
    const service = new FabricExecutionService(registry, fabricConfig);
    const context = { cwd, hasUI: false } as ExtensionContext;
    return (journal: JournalOffer, signal?: AbortSignal) => fences.run(
      { toolCallId: "call", accept: async () => undefined, arm: async () => undefined, journal },
      () => service.execute({
        code, signal, parentToolCallId: "call", context,
        onPartial(snapshot) { if (snapshot.progress === "verified") crash?.abort(); },
      }),
    );
  }

  async function crashAfterVerify(cwd: string) {
    const controller = new AbortController();
    const run = schemaWorker(cwd, controller);
    const recorded = await record((_code, journal) => run(journal, controller.signal), code);
    expect(recorded.result).toMatchObject({ success: false });
    expect(fs.existsSync(path.join(cwd, "result.txt"))).toBe(false);
    return recorded.resume;
  }

  it("commits with the recorded certificate while every fact it binds still holds", async () => {
    const cwd = tempDir("fabric-redo-schema-");
    const resume = await crashAfterVerify(cwd);
    const again = await schemaWorker(cwd)(resume);
    expect(again).toMatchObject({ success: true, value: { outcome: "committed" } });
    expect(fs.readFileSync(path.join(cwd, "result.txt"), "utf8")).toBe("done");
  });

  it("refuses the recorded certificate when the workspace changed before the resume", async () => {
    const cwd = tempDir("fabric-redo-schema-");
    const resume = await crashAfterVerify(cwd);
    fs.writeFileSync(path.join(cwd, "other.txt"), "changed while the worker was down");
    const again = await schemaWorker(cwd)(resume);
    expect(JSON.stringify(again)).toContain("Schema workspace fingerprint is stale");
    expect(fs.existsSync(path.join(cwd, "result.txt"))).toBe(false);
  });

  it("refuses the recorded certificate once it expired before the resume", async () => {
    const cwd = tempDir("fabric-redo-schema-");
    vi.useFakeTimers({ toFake: ["Date"] });
    const resume = await crashAfterVerify(cwd);
    vi.setSystemTime(Date.now() + DEFAULT_FABRIC_CONFIG.schema.certificateTtlMs + 1);
    const again = await schemaWorker(cwd)(resume);
    expect(JSON.stringify(again)).toContain("Schema certificate expired");
    expect(fs.existsSync(path.join(cwd, "result.txt"))).toBe(false);
  });
});
