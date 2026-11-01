import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availablePythonBackends } from "./fixtures/python-backends.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig, type FabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";

// A parent worker can only enforce a child's program deadline if the child's
// fabric_exec progress updates carry it. Only the deadline clock is virtual.
const registries: ActionRegistry[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(registries.splice(0).map(registry => registry.close()));
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};

const fixture = (configure: (config: FabricConfig) => void) => {
  const registry = new ActionRegistry();
  registries.push(registry);
  const calls: Array<ReturnType<typeof deferred<{ name: string; answer(): void }>>> = [];
  const slot = (index: number) => calls[index] ??= deferred();
  let invoked = 0;
  let observed = 0;
  const descriptor = {
    name: "ask",
    description: "stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "read" as const,
  };
  registry.register({
    name: "extensions",
    description: "fake extensions",
    async list() { return ["ask", "slow"].map(name => ({ ...descriptor, name })); },
    async describe(name) { return ["ask", "slow"].includes(name) ? { ...descriptor, name } : undefined; },
    async invoke(name) {
      const response = deferred<unknown>();
      slot(invoked++).resolve({ name, answer: () => response.resolve({ answer: name }) });
      return response.promise;
    },
  });
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = true;
  config.approvals.read = "allow";
  config.ui.updateDebounceMs = 0;
  configure(config);
  const service = new FabricExecutionService(registry, config);
  const deadlines: Array<number | undefined> = [];
  const run = (code: string, requestedTimeoutMs?: number) => service.execute({
    code, signal: undefined, parentToolCallId: "deadline-report",
    ...(requestedTimeoutMs !== undefined ? { requestedTimeoutMs } : {}),
    context: { cwd: process.cwd(), hasUI: false, sessionManager: {
      getSessionId: () => "deadline-report", getSessionFile: () => undefined,
    } } as unknown as ExtensionContext,
    onPartial(snapshot) { deadlines.push(snapshot.deadlineAt); },
  });
  return { run, deadlines, nextCall: () => slot(observed++).promise };
};

const runtimes = ["quickjs", "node-process", "monty", "cpython"] as const;
describe.each(runtimes)("%s program deadline report", (runtime) => {
  const python = runtime === "monty" || runtime === "cpython";
  const runTest = it.skipIf(python && !availablePythonBackends[runtime]);
  const configure = (config: FabricConfig): void => {
    config.executor = { ...normalizeFabricConfig({ executor: {
      ...(python ? { kernel: "python", pythonRuntime: runtime } : { runtime }),
      memoryLimitBytes: 256 * 1024 * 1024,
    } }).executor, timeoutMs: 1_000, humanWaitRefs: ["extensions.ask"] };
  };
  const call = (name: string) => python
    ? `await tools.call(ref="extensions.${name}", args={})`
    : `await extensions.${name}({})`;

  runTest("reports the running deadline, clears it during a human wait, and reports it again after", async () => {
    const { run, deadlines, nextCall } = fixture(configure);
    const startedAt = Date.now();
    const code = python
      ? `${call("slow")}\n${call("ask")}\nreturn ${call("slow")}`
      : `${call("slow")}; ${call("ask")}; return ${call("slow")};`;
    const pending = run(code, 600_000);
    (await nextCall()).answer();
    expect(deadlines.filter((value) => value !== undefined).at(-1)).toBe(startedAt + 600_000);
    const question = await nextCall();
    expect(deadlines.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    question.answer();
    const last = await nextCall();
    // The pause saved the budget left at the question, measured again from the answer.
    expect(deadlines.at(-1)).toBe(startedAt + 660_000);
    last.answer();
    expect(await pending).toMatchObject({ success: true });
  });
});
