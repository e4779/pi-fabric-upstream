import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig, type FabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import type { FabricActionDescriptor, FabricInvocationContext } from "../src/protocol.js";
import { availablePythonBackends } from "./fixtures/python-backends.js";

// The durable worker publishes the fence under this key; Fabric never imports the worker.
type JournalOffer = { path: string; digest?: string; accept(digest: string): Promise<void> };
type Fence = { toolCallId: string; accept(): Promise<void>; arm(): Promise<void>; journal?: JournalOffer };
const holder = globalThis as { [key: symbol]: unknown };
const fences = (holder[Symbol.for("pi-fabric.durable-tool-fence.v1")] ??= new AsyncLocalStorage<Fence>()) as AsyncLocalStorage<Fence>;

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close().catch(() => undefined)));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const writeAction: FabricActionDescriptor = {
  name: "write", description: "record an effect",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "write",
};

// Read risk, but not on the read-only list: a provider may do anything behind it.
const lookupAction: FabricActionDescriptor = {
  name: "lookup", description: "read through a provider",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(
  config: FabricConfig = structuredClone(DEFAULT_FABRIC_CONFIG),
  effect: (context: FabricInvocationContext) => Promise<unknown> = async () => "written",
  select?: (title: string, options: string[]) => Promise<string | undefined>,
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-fence-")); roots.push(cwd);
  fs.writeFileSync(path.join(cwd, "sample.txt"), "fabric works\n");
  const events: string[] = [];
  // The durable mark is slow in a real worker. The test holds it open to show
  // that nothing runs until it settles.
  const armStarted = deferred();
  const armGate = deferred(); let holdArm = false;
  const registry = new ActionRegistry(); registries.push(registry);
  registry.register(new PiToolsProvider(cwd, undefined, undefined));
  registry.register({
    name: "demo", description: "demo",
    async list() { return [writeAction, lookupAction]; },
    async describe(name) { return name === "write" ? writeAction : name === "lookup" ? lookupAction : undefined; },
    async invoke(_name, _args, context) { events.push("invoke"); return effect(context); },
  });
  const service = new FabricExecutionService(registry, config);
  const run = (code: string, fenceId = "call", journal?: JournalOffer, signal?: AbortSignal) => fences.run({
    toolCallId: fenceId,
    accept: async () => { events.push("accept"); },
    arm: async () => { events.push("arm-start"); armStarted.resolve(); if (holdArm) await armGate.promise; events.push("arm"); },
    ...(journal ? { journal } : {}),
  }, () => service.execute({
    code, signal, parentToolCallId: "call",
    context: (select
      ? { cwd, hasUI: true, ui: new Proxy({ select }, { get: (target, key) => key in target ? target[key as "select"] : () => undefined }) }
      : { cwd, hasUI: false }) as ExtensionContext,
    onPartial() {},
  }));
  return { events, run, service, armStarted, hold: () => { holdArm = true; return armGate.resolve; } };
}

const readOnly = 'const text = await pi.read({ path: "sample.txt" });\nreturn text.trim();';
const effectful = 'await pi.read({ path: "sample.txt" });\nawait tools.call({ ref: "demo.write", args: {} });\nreturn "done";';

describe("durable fabric_exec rerun fence", () => {
  it("accepts the fence for a read-only QuickJS program and never arms it", async () => {
    const { events, run } = fixture();
    const result = await run(readOnly);
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual(["accept"]);
  });

  it("arms the fence durably before an effectful call runs", async () => {
    const { events, run, armStarted, hold } = fixture();
    const release = hold();
    const finished = run(effectful);
    await armStarted.promise;
    // The mark is still being written, so the effect has not run.
    expect(events).toEqual(["accept", "arm-start"]);
    release();
    expect(await finished).toMatchObject({ success: true, value: "done" });
    expect(events).toEqual(["accept", "arm-start", "arm", "invoke"]);
  });

  it("arms before semantic search reaches the network classifier", async () => {
    const { events, run } = fixture();
    const result = await run('try { await tools.search({ query: "read", searchMode: "semantic" }); } catch {}\nreturn "searched";');
    expect(result).toMatchObject({ success: true, value: "searched" });
    expect(events).toEqual(["accept", "arm-start", "arm"]);
  });

  it("arms before a read approval that would prompt or classify", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.read = "ask";
    const { events, run } = fixture(config);
    const result = await run('try { await pi.read({ path: "sample.txt" }); } catch {}\nreturn "asked";');
    expect(result).toMatchObject({ success: true, value: "asked" });
    expect(events).toEqual(["accept", "arm-start", "arm"]);
  });

  it("does not arm for the script store load that every stored-state program performs", async () => {
    const { events, run, service } = fixture();
    service.nativeCodemode.setPersistence(() => undefined);
    const result = await run(readOnly);
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual(["accept"]);
  });

  it("arms before a read-risk action outside the read-only set", async () => {
    const { events, run } = fixture();
    const result = await run('await tools.call({ ref: "demo.lookup", args: {} });\nreturn "looked";');
    expect(result).toMatchObject({ success: true, value: "looked" });
    expect(events).toEqual(["accept", "arm-start", "arm", "invoke"]);
  });

  it("never accepts the fence for a native runtime whose effects bypass the host bridge", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    config.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const { events, run } = fixture(config);
    const result = await run(readOnly);
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual([]);
  }, 30_000);

  it.skipIf(!availablePythonBackends.monty)("accepts the fence for a read-only Monty program", async () => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", cpython: { binary: "/nonexistent/python3" }, memoryLimitBytes: 256 * 1024 * 1024 } });
    const { events, run } = fixture(config);
    const result = await run('text = await pi.read(path="sample.txt")\nreturn text.strip()');
    expect(result).toMatchObject({ success: true, value: "fabric works" });
    expect(events).toEqual(["accept"]);
  }, 30_000);

  it("ignores a fence that belongs to another tool call", async () => {
    const { events, run } = fixture();
    const result = await run(effectful, "another-call");
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(events).toEqual(["invoke"]);
  });
});

describe("durable fabric_exec crash journal", () => {
  const journalPath = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-journal-")); roots.push(root);
    return path.join(root, "call.jsonl");
  };
  const resumeOffer = (file: string, digest: string): JournalOffer => ({
    path: file, digest, accept: async () => { throw new Error("a resume must not record a new journal"); },
  });

  it("journals an effectful run instead of arming, and a resume reaches no provider", async () => {
    const file = journalPath();
    let digest: string | undefined;
    const first = fixture();
    const result = await first.run(effectful, "call", { path: file, accept: async value => { digest = value; } });
    expect(result).toMatchObject({ success: true, value: "done" });
    expect(first.events).toEqual(["accept", "invoke"]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // A fresh service stands in for the restarted worker.
    const resumed = fixture();
    const again = await resumed.run(effectful, "call", resumeOffer(file, digest!));
    expect(again).toMatchObject({ success: true, value: "done" });
    expect(resumed.events).toEqual([]);
  });

  it("records the intent before the effect and does not repeat an interrupted effect", async () => {
    const file = journalPath();
    let digest: string | undefined;
    const controller = new AbortController();
    let journalAtEffect = "";
    const first = fixture(undefined, async context => {
      journalAtEffect = fs.readFileSync(file, "utf8");
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const result = await first.run(effectful, "call", { path: file, accept: async value => { digest = value; } }, controller.signal);
    expect(result).toMatchObject({ success: false });
    expect(journalAtEffect).toMatch(/"i":\d+,"ref":"demo\.write"/);

    const resumed = fixture();
    const again = await resumed.run(effectful, "call", resumeOffer(file, digest!));
    expect(again).toMatchObject({ success: false });
    expect(JSON.stringify(again)).toContain("fabric_exec was interrupted during this call, which may have run:");
    expect(JSON.stringify(again)).toContain("demo.write({})");
    expect(resumed.events).toEqual([]);
  });

  it("asks before repeating an interrupted effect and repeats it only on yes", async () => {
    for (const choice of ["Run it again", "Stop here", undefined]) {
      const file = journalPath();
      let digest: string | undefined;
      const controller = new AbortController();
      const first = fixture(undefined, async context => {
        queueMicrotask(() => controller.abort());
        return new Promise((_resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      });
      await first.run(effectful, "call", { path: file, accept: async value => { digest = value; } }, controller.signal);

      const asked: Array<[string, string[]]> = [];
      const resumed = fixture(undefined, undefined, async (title, options) => { asked.push([title, options]); return choice; });
      const again = await resumed.run(effectful, "call", resumeOffer(file, digest!));
      expect(asked).toHaveLength(1);
      expect(asked[0]![0]).toContain("demo.write({})");
      expect(asked[0]![1]).toEqual(["Run it again", "Stop here"]);
      if (choice === "Run it again") {
        expect(again).toMatchObject({ success: true, value: "done" });
        expect(resumed.events).toEqual(["invoke"]);
      } else {
        expect(again).toMatchObject({ success: false });
        expect(JSON.stringify(again)).toContain("This call was not repeated.");
        expect(resumed.events).toEqual([]);
      }
    }
  });

  it.skipIf(!availablePythonBackends.monty)("refuses a resume on a runtime that cannot journal", async () => {
    const config = normalizeFabricConfig({ executor: { kernel: "python", cpython: { binary: "/nonexistent/python3" }, memoryLimitBytes: 256 * 1024 * 1024 } });
    const { events, run } = fixture(config);
    const result = await run('return "ran"', "call", resumeOffer(journalPath(), "0".repeat(64)));
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain("its runtime changed since the journal was recorded. Nothing was rerun.");
    expect(events).toEqual([]);
  }, 30_000);
});
