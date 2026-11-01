import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FABRIC_COMPONENT_PROVIDER_NAMES } from "../src/components/provider-component.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FABRIC_BUILTIN_READ_REFS, FabricHostPolicy } from "../src/core/host-policy.js";
import { FabricExecutionService } from "../src/execution-service.js";
import piFabric from "../src/index.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import {
  FABRIC_HOST_POLICY_EVENT,
  readFabricHostPolicyRequestV1,
  type FabricActionDescriptor,
  type FabricHostPolicyReplyV1,
  type FabricInvocationContext,
  type FabricProvider,
  type FabricRisk,
} from "../src/protocol.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
};

interface Trace { described: string[]; prepared: string[]; invoked: string[] }

const newTrace = (): Trace => ({ described: [], prepared: [], invoked: [] });

/** A provider that records every hook Fabric calls on it, so a test can assert none ran. */
const provider = (name: string, actions: Record<string, FabricRisk>, trace: Trace, extra: Partial<FabricProvider> = {}): FabricProvider => {
  const descriptor = (action: string): FabricActionDescriptor | undefined => {
    const risk = actions[action];
    return risk
      ? { name: action, description: action, inputSchema: { type: "object", additionalProperties: false }, risk, effect: { kind: "none", ordering: "commutative" } }
      : undefined;
  };
  return {
    name,
    description: name,
    async list() {
      trace.described.push(`${name}.*`);
      return Object.keys(actions).flatMap((action) => descriptor(action) ?? []);
    },
    async describe(action) {
      trace.described.push(`${name}.${action}`);
      return descriptor(action);
    },
    async prepareArguments(action, args) {
      trace.prepared.push(`${name}.${action}`);
      return args;
    },
    async invoke(action) {
      trace.invoked.push(`${name}.${action}`);
      return "ran";
    },
    ...extra,
  };
};

const invoke = (registry: ActionRegistry, ref: string): Promise<unknown> =>
  registry.invoke(ref, {}, { ...context, approve: async () => {}, audits: [], maxResultChars: 10_000 });

const accepted = (reply: FabricHostPolicyReplyV1): Extract<FabricHostPolicyReplyV1, { accepted: true }> => {
  if (!reply.accepted) throw new Error(`policy refused: ${reply.reason}`);
  return reply;
};

const workerPolicy = {
  owner: "delegate-runner",
  reason: "read-only worker",
  deniedTools: ["write", "edit", "delegate"],
};

describe("host policy request", () => {
  const reply = () => undefined;

  it("accepts a well-formed policy and copies only named fields", () => {
    const read = readFabricHostPolicyRequestV1({
      policy: { ...workerPolicy, allowedRefs: ["agents.list", "mcp.docs.*", "jev.*"] },
      reply,
      extra: 1,
    });
    expect(read?.ok && read.request.policy).toEqual({ ...workerPolicy, allowedRefs: ["agents.list", "mcp.docs.*", "jev.*"] });
  });

  it("refuses a policy field this build does not enforce instead of dropping it", () => {
    const read = readFabricHostPolicyRequestV1({ policy: { ...workerPolicy, writableRoots: ["/tmp/out"] }, reply });
    expect(read).toMatchObject({ ok: false, reason: expect.stringContaining("unsupported policy fields: writableRoots") });
  });

  it("refuses malformed policies whole and ignores requests without a reply", () => {
    expect(readFabricHostPolicyRequestV1({ policy: workerPolicy })).toBeUndefined();
    for (const policy of [
      { ...workerPolicy, owner: "" },
      { ...workerPolicy, reason: 1 },
      { ...workerPolicy, deniedTools: "write" },
      { ...workerPolicy, deniedProviders: [""] },
      { ...workerPolicy, allowedRefs: ["*"] },
      { ...workerPolicy, allowedRefs: ["agents"] },
      { ...workerPolicy, allowedRefs: ["agents.r*n"] },
      { ...workerPolicy, deniedTools: Array.from({ length: 257 }, (_, i) => `t${i}`) },
    ]) {
      expect(readFabricHostPolicyRequestV1({ policy, reply })?.ok, JSON.stringify(policy).slice(0, 80)).toBe(false);
    }
  });

  it("refuses a provider or tool entry that can never match a name", () => {
    // A typo such as "MCP" or "mcp " used to be acknowledged and then deny nothing.
    for (const policy of [
      { ...workerPolicy, deniedProviders: ["MCP"] },
      { ...workerPolicy, deniedProviders: ["mcp "] },
      { ...workerPolicy, deniedProviders: ["mcp.docs"] },
      { ...workerPolicy, deniedTools: ["write "] },
      { ...workerPolicy, deniedTools: ["pi.write"] },
    ]) {
      expect(readFabricHostPolicyRequestV1({ policy, reply }), JSON.stringify(policy)).toMatchObject({ ok: false });
    }
    const valid = { ...workerPolicy, deniedProviders: ["mcp", "web-search_2"], deniedTools: ["Write_File", "mcp__docs__search"] };
    expect(readFabricHostPolicyRequestV1({ policy: valid, reply })?.ok).toBe(true);
  });
});

describe("FabricHostPolicy", () => {
  it("is inactive and allows everything until a policy is applied", () => {
    const policy = new FabricHostPolicy();
    expect(policy.active).toBe(false);
    expect(policy.refDenial("agents", "run")).toBeUndefined();
    expect(policy.executorDenial()).toBeUndefined();
  });

  it("denies named tools and providers, and every unhooked action outside the built-in read set", () => {
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, deniedProviders: ["mesh"], allowedRefs: ["agents.status"] }));
    expect(policy.refDenial("pi", "write")).toContain("tool write");
    expect(policy.refDenial("extensions", "delegate")).toContain("tool delegate");
    // Hooked providers keep their other tools: Pi tool_call hooks still guard them.
    expect(policy.refDenial("pi", "bash")).toBeUndefined();
    expect(policy.refDenial("mesh", "self")).toContain("provider mesh");
    expect(policy.refDenial("agents", "run")).toContain("need a host allowedRefs entry");
    expect(policy.refDenial("agents", "status")).toBeUndefined();
    expect(policy.refDenial("memory", "recall")).toBeUndefined();
    expect(policy.executorDenial()).toContain("refuses native executors");
  });

  it("never lets a provider's self-declared read risk through", async () => {
    // tasks.adopt mutates session state but declares risk: "read". A read-only
    // policy must refuse it, and every third-party read-rated action.
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("tasks", { adopt: "read" }, trace));
    registry.register(provider("thirdparty", { lookup: "read" }, trace));
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    await expect(invoke(registry, "tasks.adopt")).rejects.toThrow("need a host allowedRefs entry");
    await expect(invoke(registry, "thirdparty.lookup")).rejects.toThrow("need a host allowedRefs entry");
    expect(trace.invoked).toEqual([]);
    await registry.close(new Set(["tasks", "thirdparty"]));
  });

  it("matches provider.* and exact allowedRefs only", () => {
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, allowedRefs: ["mcp.docs.*", "jev.status"] }));
    expect(policy.refDenial("mcp", "docs.search")).toBeUndefined();
    expect(policy.refDenial("mcp", "docsx.search")).toBeDefined();
    expect(policy.refDenial("jev", "status")).toBeUndefined();
    expect(policy.refDenial("jev", "status2")).toBeDefined();
  });

  it("lists only reserved built-in providers in the fixed read set", () => {
    const reserved = new Set<string>([...FABRIC_COMPONENT_PROVIDER_NAMES, "components"]);
    for (const ref of FABRIC_BUILTIN_READ_REFS) expect(reserved, ref).toContain(ref.split(".")[0]);
  });

  it("accepts one policy, then refuses replacement and anything after first use", () => {
    const policy = new FabricHostPolicy();
    const first = accepted(policy.apply(workerPolicy));
    expect(first.enforced).toEqual(["owner", "reason", "deniedTools", "deniedProviders", "allowedRefs"]);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(policy.apply({ owner: "other", reason: "wider" })).toMatchObject({ accepted: false, reason: expect.stringContaining("already set") });
    const unused = new FabricHostPolicy();
    expect(unused.refDenial("pi", "read")).toBeUndefined();
    expect(unused.apply(workerPolicy)).toMatchObject({ accepted: false, reason: expect.stringContaining("sealed") });
  });

  it("keeps its own copy of the applied policy", () => {
    const policy = new FabricHostPolicy();
    const input = { owner: "a", reason: "r", deniedTools: ["write"] };
    accepted(policy.apply(input));
    input.deniedTools.length = 0;
    expect(policy.refDenial("pi", "write")).toBeDefined();
  });
});

describe("registry enforcement", () => {
  it("refuses a denied action before any provider code runs, including describe", async () => {
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("agents", { run: "agent", list: "read" }, trace));
    registry.register(provider("pi", { write: "write", bash: "execute" }, trace));
    registry.register(provider("mesh", { self: "read" }, trace));
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, deniedProviders: ["mesh"], allowedRefs: ["agents.list"] }));
    registry.setHostPolicy(policy);

    await expect(invoke(registry, "agents.run")).rejects.toThrow("refused by the Fabric host policy from delegate-runner");
    await expect(invoke(registry, "pi.write")).rejects.toThrow("tool write is unavailable here");
    await expect(invoke(registry, "mesh.self")).rejects.toThrow("provider mesh is unavailable here");
    await expect(registry.describe("agents.run", context)).rejects.toThrow("need a host allowedRefs entry");
    expect(trace).toEqual({ described: [], prepared: [], invoked: [] });

    expect(await invoke(registry, "agents.list")).toBe("ran");
    expect(await invoke(registry, "pi.bash")).toBe("ran");
    expect(trace.invoked).toEqual(["agents.list", "pi.bash"]);
    await registry.close(new Set(["agents", "pi", "mesh"]));
  });

  it("keeps refused actions and providers out of listings, search and bare-name lookup", async () => {
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("agents", { run: "agent", list: "read" }, trace));
    registry.register(provider("mesh", { self: "read" }, trace));
    registry.register(provider("pi", { write: "write", read: "read" }, trace));
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, allowedRefs: ["agents.list"] }));
    registry.setHostPolicy(policy);

    expect(registry.providers().map((entry) => entry.name)).toEqual(["agents", "pi"]);
    expect((await registry.list({ limit: 100 }, context)).map((action) => action.ref).sort()).toEqual(["agents.list", "pi.read"]);
    expect((await registry.search("run", context)).map((action) => action.ref)).toEqual([]);
    await expect(registry.describe("run", context)).rejects.toThrow("Unknown Fabric action");
    const catalog = await registry.catalog(context);
    expect(catalog.providers.flatMap((entry) => entry.actions.map((action) => action.ref)).sort()).toEqual(["agents.list", "pi.read"]);
    // Listing a hidden provider never ran its list hook.
    expect(trace.described).not.toContain("mesh.*");
    await registry.close(new Set(["agents", "mesh", "pi"]));
  });

  it("refuses scoped acquisition before describe or acquire runs", async () => {
    const trace = newTrace();
    const acquire = vi.fn(async () => ({ value: "lease", dispose: async () => {} }));
    const registry = new ActionRegistry();
    registry.register(provider("cache", { lease: "read" }, trace, { acquire }));
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    await expect(registry.acquireScoped("cache.lease", {}, context)).rejects.toThrow("need a host allowedRefs entry");
    expect(trace.described).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
    await registry.close(new Set(["cache"]));
  });

  it("never speculates a refused action", async () => {
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("spec", { echo: "read", hidden: "read" }, trace));
    registry.setSpeculation(new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 }), () => true);
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, allowedRefs: ["spec.echo"] }));
    registry.setHostPolicy(policy);
    expect(await registry.speculate("spec.echo", {}, context, {})).toBeDefined();
    expect(await registry.speculate("spec.hidden", {}, context, {})).toBeUndefined();
    expect(trace.described).toEqual(["spec.echo"]);
    expect(trace.prepared).toEqual(["spec.echo"]);
    await registry.close(new Set(["spec"]));
  });

  it("decides again on a repaired action name before preparing or invoking it", async () => {
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("pi", { write: "write", bash: "execute" }, trace));
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    // Case, separator and synonym-class forms all repair to the denied pi.write.
    for (const ref of ["pi.Write", "pi.WRITE", "pi.wri_te", "pi.save"]) {
      await expect(invoke(registry, ref), ref).rejects.toThrow(
        "pi.write is refused by the Fabric host policy from delegate-runner: tool write is unavailable here",
      );
    }
    expect(trace.prepared).toEqual([]);
    expect(trace.invoked).toEqual([]);
    // Repair still reaches a tool the policy allows.
    expect(await invoke(registry, "pi.Bash")).toBe("ran");
    expect(trace.invoked).toEqual(["pi.bash"]);
    await registry.close(new Set(["pi"]));
  });

  it("refuses a case variant of a denied extension tool", async () => {
    const trace = newTrace();
    const registry = new ActionRegistry();
    registry.register(provider("extensions", { delegate: "agent", lookup: "read" }, trace));
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    await expect(invoke(registry, "extensions.Delegate")).rejects.toThrow(
      "extensions.delegate is refused by the Fabric host policy from delegate-runner: tool delegate is unavailable here",
    );
    expect(trace.prepared).toEqual([]);
    expect(trace.invoked).toEqual([]);
    await registry.close(new Set(["extensions"]));
  });

  it("decides again on a repaired name in describe and scoped acquisition", async () => {
    const trace = newTrace();
    const acquire = vi.fn(async () => ({ value: "lease", dispose: async () => {} }));
    const scopedWrite: FabricActionDescriptor = {
      name: "write", description: "write", inputSchema: { type: "object", additionalProperties: false },
      risk: "write", effect: { kind: "scoped", resources: ["scope"] },
    };
    const registry = new ActionRegistry();
    registry.register(provider("pi", { write: "write" }, trace, {
      acquire,
      async list() { return [scopedWrite]; },
      async describe(action) {
        trace.described.push(`pi.${action}`);
        return action === "write" ? scopedWrite : undefined;
      },
    }));
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    await expect(registry.describe("pi.Write", context)).rejects.toThrow("tool write is unavailable here");
    await expect(registry.acquireScoped("pi.WRITE", {}, context)).rejects.toThrow("tool write is unavailable here");
    expect(trace.prepared).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
    await registry.close(new Set(["pi"]));
  });

  it("never speculates a denied tool that a provider describes under another spelling", async () => {
    const trace = newTrace();
    const write: FabricActionDescriptor = {
      name: "write", description: "write", inputSchema: { type: "object", additionalProperties: false },
      risk: "read", effect: { kind: "none", ordering: "commutative" },
    };
    const registry = new ActionRegistry();
    // This provider answers describe case-insensitively, so pi.Write resolves to write without repair.
    registry.register(provider("pi", { write: "read" }, trace, {
      async describe(action) {
        trace.described.push(`pi.${action}`);
        return action.toLowerCase() === "write" ? write : undefined;
      },
    }));
    registry.setSpeculation(new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 }), () => true);
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    expect(await registry.speculate("pi.Write", {}, context, {})).toBeUndefined();
    await expect(invoke(registry, "pi.Write")).rejects.toThrow("tool write is unavailable here");
    expect(trace.prepared).toEqual([]);
    expect(trace.invoked).toEqual([]);
    await registry.close(new Set(["pi"]));
  });

  it.each([
    ["list", (registry: ActionRegistry) => registry.list({}, context), "demo"],
    ["catalog", (registry: ActionRegistry) => registry.catalog(context), "demo"],
    ["search", (registry: ActionRegistry) => registry.search("echo", context), "demo"],
    ["bare describe", (registry: ActionRegistry) => registry.describe("echo", context), "demo"],
    ["provider types", (registry: ActionRegistry) => registry.guestTypeSources(context, { code: "return demo.echo({});" }), "demo"],
    ["extension types", (registry: ActionRegistry) => registry.guestTypeSources(context), "extensions"],
  ] as const)("seals before %s enters a provider even without an active policy", async (_label, discover, name) => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    registry.setHostPolicy(policy);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sealedAtEntry: boolean | undefined;
    registry.register(provider(name, { echo: "read" }, newTrace(), {
      async list() {
        sealedAtEntry = policy.sealed;
        markStarted();
        await gate;
        return [{ name: "echo", description: "echo", inputSchema: { type: "object" }, risk: "read" }];
      },
    }));
    const pending = discover(registry);
    try {
      await started;
      expect(sealedAtEntry).toBe(true);
      expect(policy.apply({ ...workerPolicy, deniedProviders: [name] })).toMatchObject({
        accepted: false, reason: expect.stringContaining("sealed"),
      });
    } finally {
      release();
      await pending;
      await registry.close(new Set([name]));
    }
    expect(policy.active).toBe(false);
  });

  it("does not seal pure provider previews or unused provider type declarations", async () => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    registry.setHostPolicy(policy);
    const trace = newTrace();
    registry.register(provider("demo", { echo: "read" }, trace));
    expect(registry.providers().map((entry) => entry.name)).toEqual(["demo"]);
    expect(registry.providerGlobals()).toEqual(["demo"]);
    await registry.guestTypeSources(context, { code: "return 1;" });
    expect(trace.described).toEqual([]);
    expect(policy.sealed).toBe(false);
    accepted(policy.apply({ ...workerPolicy, allowedRefs: ["demo.echo"] }));
    expect(registry.providers().map((entry) => entry.name)).toEqual(["demo"]);
    expect(registry.providerGlobals()).toEqual(["demo"]);
    expect(policy.sealed).toBe(false);
    await registry.close(new Set(["demo"]));
  });

  it("does not seal a cache-only MCP schema preview", async () => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    accepted(policy.apply({ ...workerPolicy, allowedRefs: ["mcp.server.echo"] }));
    registry.setHostPolicy(policy);
    const trace = newTrace();
    const cached = {
      ...provider("mcp", { "server.echo": "read" }, trace),
      sliceDescriptors: () => [{
        name: "server.echo", namespace: "server", description: "echo",
        inputSchema: { type: "object" }, risk: "read" as const,
      }],
    };
    registry.register(cached);
    const sources = await registry.guestTypeSources(context, { code: "return 1;" });
    expect(sources.mcpServers).toEqual([{
      server: "server", tools: [{ name: "echo", inputSchema: { type: "object" } }],
    }]);
    expect(trace.described).toEqual([]);
    expect(policy.sealed).toBe(false);
    await registry.close(new Set(["mcp"]));
  });

  it("has no in-flight window: a policy arriving after the first call is refused", async () => {
    // The old design applied a policy at any time. A write already waiting in
    // prepareArguments then ran after a read-only policy was acknowledged.
    const trace = newTrace();
    let markStarted!: () => void;
    let releasePrepare!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const registry = new ActionRegistry();
    registry.register(provider("pi", { write: "write" }, trace, {
      async prepareArguments(_action, args) { markStarted(); await gate; return args; },
    }));
    const policy = new FabricHostPolicy();
    registry.setHostPolicy(policy);
    const pending = invoke(registry, "pi.write");
    await started;
    // The write is admitted and waiting; the host cannot claim a read-only policy now.
    expect(policy.apply(workerPolicy)).toMatchObject({ accepted: false, reason: expect.stringContaining("sealed") });
    releasePrepare();
    expect(await pending).toBe("ran");
    expect(policy.active).toBe(false);
    await registry.close(new Set(["pi"]));
  });
});

describe("native executors", () => {
  it("refuses node-process under a policy and keeps QuickJS", async () => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    const run = async (runtime: "quickjs" | "node-process") => {
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.executor.runtime = runtime;
      const service = new FabricExecutionService(registry, config);
      return service.execute({
        code: "return 1;", signal: undefined, parentToolCallId: `exec-${runtime}`,
        context: { cwd: process.cwd(), hasUI: false } as ExtensionContext, onPartial() {},
      });
    };
    await expect(run("node-process")).rejects.toThrow("refuses native executors");
    const quickjs = await run("quickjs");
    expect(quickjs.success, quickjs.error).toBe(true);
  });

  it("refuses CPython", async () => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    accepted(policy.apply(workerPolicy));
    registry.setHostPolicy(policy);
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.kernel = "python";
    config.executor.pythonRuntime = "cpython";
    const service = new FabricExecutionService(registry, config);
    await expect(service.execute({
      code: "1", signal: undefined, parentToolCallId: "exec-cpython",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext, onPartial() {},
    })).rejects.toThrow("refuses native executors");
  });

  it("seals the policy when a program starts", async () => {
    const registry = new ActionRegistry();
    const policy = new FabricHostPolicy();
    registry.setHostPolicy(policy);
    const service = new FabricExecutionService(registry, structuredClone(DEFAULT_FABRIC_CONFIG));
    const result = await service.execute({
      code: "return 1;", signal: undefined, parentToolCallId: "exec-seal",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext, onPartial() {},
    });
    expect(result.success, result.error).toBe(true);
    expect(policy.apply(workerPolicy).accepted).toBe(false);
  });
});

describe("pi.* without tool hooks", () => {
  it("fails closed for non-read tools when a policy relies on hooks that are absent", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-host-policy-"));
    try {
      let active = false;
      // No captured-tool catalog: the embed path that used to execute directly.
      const tools = new PiToolsProvider(cwd, undefined, undefined, { powerShellToolDefinitionFactory: undefined, requireToolHooks: () => active });
      const write = () => tools.invoke("write", { path: "out.txt", content: "x" }, { ...context, cwd });
      active = true;
      await expect(write()).rejects.toThrow("until extension tool hooks initialize");
      expect(fs.existsSync(path.join(cwd, "out.txt"))).toBe(false);
      await expect(tools.invoke("ls", { path: cwd }, { ...context, cwd })).resolves.toBeDefined();
      active = false;
      await write();
      expect(fs.readFileSync(path.join(cwd, "out.txt"), "utf8")).toBe("x");
      await tools.close?.();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("host policy event", () => {
  const host = () => {
    const listeners = new Map<string, (value: unknown) => unknown>();
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
    const pi = {
      events: {
        emit: vi.fn(),
        on: vi.fn((channel: string, handler: (value: unknown) => unknown) => {
          listeners.set(channel, handler);
          return () => listeners.delete(channel);
        }),
      },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => [{ name: "fabric_exec" }]),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    return { pi, listeners, handlers };
  };

  it("replies before emit returns, refuses unknown fields and a second policy, and unsubscribes on shutdown", async () => {
    const { pi, listeners, handlers } = host();
    await piFabric(pi);
    const request = listeners.get(FABRIC_HOST_POLICY_EVENT)!;
    const send = (policy: unknown): FabricHostPolicyReplyV1 | undefined => {
      let reply: FabricHostPolicyReplyV1 | undefined;
      request({ policy, reply: (value: FabricHostPolicyReplyV1) => { reply = value; } });
      return reply;
    };
    expect(send({ ...workerPolicy, writableRoots: ["/out"] })).toMatchObject({ accepted: false, reason: expect.stringContaining("writableRoots") });
    expect(send({ owner: "x" })).toMatchObject({ accepted: false });
    expect(send(workerPolicy)).toMatchObject({ version: 1, accepted: true, enforced: expect.arrayContaining(["deniedTools"]) });
    expect(send(workerPolicy)).toMatchObject({ accepted: false, reason: expect.stringContaining("already set") });
    for (const shutdown of handlers.get("session_shutdown") ?? []) await shutdown();
    expect(listeners.has(FABRIC_HOST_POLICY_EVENT)).toBe(false);
  });
});
