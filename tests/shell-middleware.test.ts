import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition, type ExtensionContext, type ExtensionRunner, type RegisteredTool } from "@earendil-works/pi-coding-agent";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { readFabricBashMiddleware } from "../src/core/shell-middleware.js";
import { FABRIC_BASH_MIDDLEWARE, type FabricBashMiddlewareV1 } from "../src/protocol.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { DurableShellBridge } from "../src/jev-fabric/bridge.js";

const SECRET = "fabric-test-secret-not-a-credential";
const registries: ActionRegistry[] = [];
const directories: string[] = [];
const removeDirectory = async (directory: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (attempt >= 10 || (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
};

afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  for (const directory of directories.splice(0)) await removeDirectory(directory);
  vi.unstubAllEnvs();
});

const middleware = (onOutput?: (text: string) => void, delayMs = 0): FabricBashMiddlewareV1 => ({
  version: 1,
  options: {
    commandPrefix: "export FABRIC_PREFIX=kept",
    spawnHook: ({ env, ...rest }) => {
      const childEnv = { ...env };
      delete childEnv.FABRIC_TEST_SECRET;
      return { ...rest, env: childEnv };
    },
  },
  wrapOperations: inner => ({
    exec: async (command, cwd, options) => {
      // Line buffering in this fixture tests that Fabric records only filtered bytes.
      let pending = "";
      const emit = (text: string) => {
        const filtered = text.split(SECRET).join("[filtered]");
        options.onData(Buffer.from(filtered));
        onOutput?.(filtered);
      };
      try {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        return await inner.exec(command, cwd, { ...options, onData: data => {
          pending += data.toString();
          const last = pending.lastIndexOf("\n");
          if (last >= 0) { emit(pending.slice(0, last + 1)); pending = pending.slice(last + 1); }
        } });
      } finally { emit(pending); }
    },
  }),
});

const harness = (options: { middleware?: unknown; optIn?: boolean; hangMs?: number; managed?: boolean; blocked?: boolean } = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-middleware-test-"));
  directories.push(cwd);
  const extensionContext = {
    cwd,
    sessionManager: { getSessionId: () => "middleware-test", getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  const runner = {
    createContext: () => extensionContext,
    getActiveTools: () => ["bash"],
    emit: vi.fn(async () => {}),
    emitToolCall: vi.fn(async () => options.blocked ? { block: true, reason: "blocked by policy" } : undefined),
    emitToolResult: vi.fn(async () => undefined),
  } as unknown as ExtensionRunner;
  const fallback = vi.fn(async () => ({ content: [{ type: "text" as const, text: "standalone override" }], details: undefined }));
  const definition = { ...createBashToolDefinition(cwd), execute: fallback };
  if (options.optIn !== false) Object.assign(definition, { [FABRIC_BASH_MIDDLEWARE]: options.middleware ?? middleware() });
  const catalog = new CapturedToolCatalog();
  catalog.replace([{ definition, sourceInfo: { path: "/extensions/filtered-bash.ts", source: "test", scope: "user", origin: "package" } } as RegisteredTool], runner, DEFAULT_FABRIC_CONFIG.capture, "/fabric/index.ts");
  const captured = new CapturedToolsProvider(catalog);
  const provider = new PiToolsProvider(cwd, catalog, captured, {
    requireCapturedOverrides: options.managed === true,
    powerShellToolDefinitionFactory: undefined,
    getShellHangMs: () => options.hangMs ?? 120_000,
  });
  const registry = new ActionRegistry();
  registry.register(provider);
  registries.push(registry);
  const previews: unknown[] = [];
  const context = {
    cwd, extensionContext, signal: new AbortController().signal,
    parentToolCallId: "parent", nestedToolCallId: "fabric_middleware",
    update: () => {}, approve: async () => {}, audits: [], maxResultChars: 100_000,
    attachPreview: (preview: unknown) => { previews.push(preview); },
  };
  const invoke = (args: Record<string, unknown>, signal = context.signal) => registry.invoke("pi.bash", args, { ...context, signal }) as Promise<{
    ok: boolean; output: string; details: { running?: boolean; pid?: number; logPath?: string } | null;
  }>;
  return { provider, catalog, registry, runner, fallback, context, cwd, previews, invoke };
};

describe("cooperative bash middleware", () => {
  it.skipIf(process.platform === "win32")("wraps durable jev-fabric operations with the same filters, prefix and spawn hook", async () => {
    const h = harness();
    const fake = new URL("./fixtures/fake-jev-fabric.mjs", import.meta.url).pathname;
    const binary = path.join(h.cwd, "jev-fabric");
    fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    const jobs = h.provider.shellJobs;
    jobs.durable = new DurableShellBridge(jobs, {
      cwd: h.cwd, agentDir: path.join(h.cwd, "agent"), ownerId: "middleware-test",
      settings: () => ({ binary, home: path.join(h.cwd, "home"), timeoutMs: 60_000 }),
      middleware: () => readFabricBashMiddleware(h.catalog.get("bash")?.definition),
    });
    vi.stubEnv("FABRIC_TEST_SECRET", SECRET);
    fs.writeFileSync(path.join(h.cwd, "fixture"), `${SECRET}\n`);
    const result = await h.invoke({ command: 'cat fixture; printf "prefix=%s secret=%s\\n" "$FABRIC_PREFIX" "${FABRIC_TEST_SECRET:-unset}"', durable: true });
    expect(result.details?.running).toBe(true);
    await vi.waitFor(() => expect(jobs.list()[0]?.finishedAt).toBeDefined(), { timeout: 10_000 });
    const output = await jobs.get(jobs.list()[0]!.id)!.outputText();
    expect(output).toContain("[filtered]");
    expect(output).toContain("prefix=kept secret=unset");
    expect(output).not.toContain(SECRET);
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it("delivers monitor events only after cooperative output filtering and hooks", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.cwd, "fixture"), `${SECRET}\n`);
    const events: unknown[] = [];
    h.provider.shellJobs.subscribe(event => { if (event.type === "monitor") events.push(event); });
    await h.invoke({ command: "cat fixture; sleep 1.3", monitor: { delivery: "wake", intervalMs: 1000 } });
    await vi.waitFor(() => expect(h.provider.shellJobs.list()[0]?.finishedAt).toBeDefined(), { timeout: 5000 });
    expect(JSON.stringify(events)).toContain("[filtered]");
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(h.runner.emitToolCall).toHaveBeenCalledOnce();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("does not bypass an opaque shell override for monitors", async () => {
    const h = harness({ optIn: false });
    await expect(h.invoke({ command: "echo forbidden", monitor: { delivery: "wake" } })).rejects.toThrow();
    expect(h.provider.shellJobs.list()).toEqual([]);
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it("advertises Fabric arguments without serializing host callbacks", async () => {
    const h = harness();
    const descriptor = await h.provider.describe("bash", h.context);
    expect(descriptor).toMatchObject({ namespace: "extension-middleware", inputSchema: { properties: {
      background: { type: "boolean" }, cwd: { type: "string" }, timeout: { type: "number" },
    } } });
    expect(JSON.stringify(descriptor)).not.toContain("spawnHook");
  });

  it("scrubs child env, keeps host credentials, prefix, cwd, and lifecycle", async () => {
    vi.stubEnv("FABRIC_TEST_SECRET", SECRET);
    const h = harness();
    const nested = path.join(h.cwd, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "marker"), "nested-ok");
    const result = await h.invoke({ cmd: 'printf "%s|%s|%s|%s\\n" "${FABRIC_TEST_SECRET-unset}" "$FABRIC_PREFIX" "$PI_SESSION_ID" "$(cat marker)"', cwd: "nested" });
    expect(result.output).toBe("unset|kept|middleware-test|nested-ok\n");
    expect(process.env.FABRIC_TEST_SECRET).toBe(SECRET);
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.runner.emitToolCall).toHaveBeenCalledOnce();
    expect(h.runner.emitToolResult).toHaveBeenCalledOnce();
  });

  it.each([true, false])("filters output before and after handoff (immediate=%s)", async immediate => {
    const h = harness({ hangMs: immediate ? 120_000 : 30 });
    fs.writeFileSync(path.join(h.cwd, "fixture"), `${SECRET}\n`);
    const result = await h.invoke({ command: "cat fixture; sleep 0.2; cat fixture", ...(immediate ? { run_in_background: true } : {}) });
    // The pid is best-effort: a slow shell start (Git Bash on a loaded Windows
    // runner) can miss the read window, and the handoff goes ahead without it.
    expect(result).toMatchObject({ ok: true, details: { running: true, logPath: expect.any(String) } });
    expect(result.output).not.toContain(SECRET);
    await vi.waitFor(() => expect(h.provider.shellJobs.list()[0]?.finishedAt).toEqual(expect.any(Number)));
    const log = fs.readFileSync(result.details!.logPath!, "utf8");
    expect(log).toContain("[filtered]");
    expect(log).not.toContain(SECRET);
    expect(log).toContain("Process exited with code 0");
    expect(JSON.stringify(h.previews)).not.toContain(SECRET);
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("keeps explicit timeout a hard cap before handoff", async () => {
    const h = harness();
    await expect(h.invoke({ command: "sleep 8", timeout: 0.05 })).rejects.toThrow("timed out");
    expect(h.provider.shellJobs.list().every(job => job.status !== "running")).toBe(true);
  });

  it("keeps the explicit hard cap after handoff", async () => {
    const h = harness();
    // Long enough that the cap cannot fire before a slow runner hands off.
    const result = await h.invoke({ command: "sleep 8", timeout: 1, background: true });
    expect(result.details?.running).toBe(true);
    await vi.waitFor(() => expect(h.provider.shellJobs.list()[0]?.finishedAt).toEqual(expect.any(Number)), { timeout: 10_000 });
    expect(fs.readFileSync(result.details!.logPath!, "utf8")).toContain("timed out");
  });

  it("keeps nonzero status and redacted failure output", async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.cwd, "fixture"), `${SECRET}\n`);
    await expect(h.invoke({ command: "cat fixture; exit 7" })).rejects.toThrow("[filtered]\n\n\nCommand exited with code 7");
  });

  it("allows policy hooks to block before middleware or spawn", async () => {
    const wrapOperations = vi.fn((inner) => inner);
    const h = harness({ middleware: { version: 1, wrapOperations }, blocked: true });
    await expect(h.invoke({ command: "echo forbidden" })).rejects.toThrow("blocked by policy");
    expect(wrapOperations).not.toHaveBeenCalled();
    expect(h.provider.shellJobs.list()).toEqual([]);
  });

  it.each([0, 400])("cancels a ready child and cleans up detached children on close (startup delay=%i)", async delayMs => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const h = harness({ middleware: middleware(text => { if (text.includes("child-ready")) ready(); }, delayMs) });
    const controller = new AbortController();
    const waiting = h.invoke({ command: "printf 'child-ready\\n'; sleep 30" }, controller.signal);
    // Attach a rejection handler immediately, including on the readiness failure path.
    void waiting.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child readiness timed out")), 10_000);
      })]);
      expect(h.provider.shellJobs.list()[0]?.status).toBe("running");
      controller.abort(new Error("cancel probe"));
      await expect(waiting).rejects.toThrow();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const result = await h.invoke({ command: "sleep 30", background: true });
    expect(result.details?.running).toBe(true);
    await h.registry.close();
    expect(h.provider.shellJobs.list().every(job => job.status !== "running" && job.status !== "spilled")).toBe(true);
  }, 20_000);

  it.each([{ optIn: false }, { managed: true }])("does not replace unrelated or managed overrides: %j", async options => {
    const h = harness(options);
    expect(await h.invoke({ command: "echo unused" })).toMatchObject({ output: "standalone override" });
    expect(h.fallback).toHaveBeenCalledOnce();
    expect(h.provider.shellJobs.list()).toEqual([]);
  });

  it("retains the selected protection when a lifecycle hook refreshes the catalog", async () => {
    vi.stubEnv("FABRIC_TEST_SECRET", SECRET);
    const h = harness();
    vi.mocked(h.runner.emitToolCall).mockImplementationOnce(async () => {
      h.catalog.clear();
      return undefined;
    });
    const result = await h.invoke({ command: 'printf "%s" "${FABRIC_TEST_SECRET-unset}"' });
    expect(result.output).toBe("unset");
  });

  it("observes catalog refresh rather than caching an obsolete middleware", async () => {
    const h = harness();
    expect((await h.provider.describe("bash", h.context))?.namespace).toBe("extension-middleware");
    h.catalog.replace([], h.runner, DEFAULT_FABRIC_CONFIG.capture, "/fabric/index.ts");
    expect((await h.provider.describe("bash", h.context))?.namespace).toBe("builtin");
  });

  it.each([{ version: 2, wrapOperations: () => ({}) }, { version: 1, wrapOperations: true }, { version: 1, wrapOperations: () => ({}), options: { operations: {} } }])("fails closed for invalid opt-in metadata", async value => {
    const h = harness({ middleware: value });
    await expect(h.invoke({ command: "echo forbidden" })).rejects.toThrow("Invalid Fabric bash middleware");
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("fails closed and closes the job when a middleware factory fails", async () => {
    const h = harness({ middleware: { version: 1, wrapOperations: () => { throw new Error("filter unavailable"); } } });
    await expect(h.invoke({ command: "echo forbidden" })).rejects.toThrow("filter unavailable");
    expect(h.provider.shellJobs.list().every(job => job.status !== "running")).toBe(true);
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("validates the public symbol by registry identity", () => {
    expect(FABRIC_BASH_MIDDLEWARE).toBe(Symbol.for("pi-fabric:bash-middleware:v1"));
    expect(readFabricBashMiddleware({})).toBeUndefined();
  });
});
