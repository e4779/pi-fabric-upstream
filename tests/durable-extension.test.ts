// fabric_exec as a pi-durable extension inside a bare Harness: its surface, limits, prompt
// section, isolation and onError. Every test runs a real program in the QuickJS
// kernel through a real Harness; see tests/durable-extension-host.ts.
import { defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createFabricExtension,
  FABRIC_DURABLE_DEFAULTS,
  FabricDurableRefusal,
  type FabricExtensionOptions,
} from "../src/durable-extension.js";
import type { FabricKernelRuntime, FabricSandboxOptions } from "../src/runtime/kernel.js";
import { latch, openHost, runProgram } from "./durable-extension-host.js";

const textTool = (name: string, run: (args: Record<string, unknown>) => Promise<string> | string, extra: Partial<ToolRegistration> = {}): ToolRegistration => ({
  ...defineTool({
    name,
    description: `Test tool ${name}`,
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (args) => ({ output: [{ type: "text" as const, text: await run(args as Record<string, unknown>) }] }),
  }),
  ...extra,
});

/** A kernel that records the sandbox options it is given and returns a fixed value. */
const recordingRuntime = () => {
  const seen: FabricSandboxOptions[] = [];
  const runtime: FabricKernelRuntime = {
    execute: async (_code, _hostCall, options) => {
      seen.push(options);
      return { value: "ok", logs: [], terminationReason: "completed" };
    },
  };
  return { runtime, seen };
};

const parsed = <T>(text: string): T => JSON.parse(text) as T;

describe("surface, options and defaults", () => {
  it("is a pi-durable 1.4 Extension a host installs without a cast", () => {
    const extension: Extension = createFabricExtension();
    expect(extension.name).toBe("pi-fabric");
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["fabric_exec"]);
    expect(extension.sections?.map((section) => section.key)).toEqual(["fabric"]);
    const renamed = createFabricExtension({ name: "fabric-x", toolName: "run_code" });
    expect(renamed.name).toBe("fabric-x");
    expect(renamed.tools?.map((tool) => tool.name)).toEqual(["run_code"]);
  });

  it("declares pi-durable, pi-codemode and chord 1.4.0 or later as optional peers, and publishes the entry", async () => {
    const manifest = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync("package.json", "utf8")));
    for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-codemode", "@earendil-works/chord"]) {
      expect(manifest.peerDependencies[name]).toBe(">=1.4.0");
      expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
    expect(manifest.exports["./durable-extension"]).toEqual({ types: "./dist/durable-extension.d.ts", import: "./dist/durable-extension.js" });
    expect(manifest.exports["./durable-extension/wasm"]).toEqual({ types: "./dist/durable-extension-wasm.d.ts", import: "./dist/durable-extension-wasm.js" });
  });

  it("passes the default and the overridden limits to the kernel", async () => {
    const defaults = recordingRuntime();
    const { timeoutMs: _testTimeout, ...noLimits }: FabricExtensionOptions = { runtime: defaults.runtime, timeoutMs: 1 };
    await runProgram("return 1", { fabric: noLimits });
    expect(defaults.seen).toHaveLength(1);
    expect(defaults.seen[0]).toMatchObject({ timeoutMs: 30_000, memoryLimitBytes: 64 * 1024 * 1024, maxLogChars: 20_000, providerGlobals: [] });
    expect(FABRIC_DURABLE_DEFAULTS).toMatchObject({ timeoutMs: 30_000, memoryLimitBytes: 67_108_864, maxLogChars: 20_000, maxResultChars: 40_000, maxArgumentBytes: 262_144, sectionTokenBudget: 3_000 });
    const custom = recordingRuntime();
    await runProgram("return 1", { fabric: { runtime: custom.runtime, timeoutMs: 1234, memoryLimitBytes: 8 * 1024 * 1024, maxLogChars: 77, providers: { notes: { actions: {} } } } });
    expect(custom.seen[0]).toMatchObject({ timeoutMs: 1234, memoryLimitBytes: 8 * 1024 * 1024, maxLogChars: 77, providerGlobals: ["notes"] });
  });

  it.each(["timeoutMs", "memoryLimitBytes", "maxLogChars", "maxResultChars", "maxArgumentBytes", "sectionTokenBudget"] as const)("rejects a non-positive %s", (key) => {
    expect(() => createFabricExtension({ [key]: 0 } as FabricExtensionOptions)).toThrow(key);
    expect(() => createFabricExtension({ [key]: 1.5 } as FabricExtensionOptions)).toThrow(key);
  });

  it("rejects an invalid provider name", () => {
    expect(() => createFabricExtension({ providers: { "Bad-Name": { actions: {} } } })).toThrow(/Invalid Fabric provider name/);
  });

  it("grants every callable host tool by default and only the listed ones with options.tools", async () => {
    const all = await runProgram("return Object.keys(tools).sort()");
    expect(parsed<string[]>(all.text)).toEqual(["fail_tool", "search_knowledge", "secret_admin"]);
    const listed = await runProgram("return Object.keys(tools).sort()", { fabric: { tools: ["search_knowledge"] } });
    expect(parsed<string[]>(listed.text)).toEqual(["search_knowledge"]);
    const none = await runProgram("return Object.keys(tools).length", { fabric: { tools: [] } });
    expect(none.text).toBe("0");
  });

  it("cuts the result at maxResultChars (default 40 000) with a notice", async () => {
    const byDefault = await runProgram('return "x".repeat(50_000)');
    expect(byDefault.text).toContain("[fabric_exec output truncated: 40000 of 50000 characters shown]");
    expect(byDefault.text.startsWith("x".repeat(40_000) + "\n[")).toBe(true);
    const small = await runProgram('return "y".repeat(500)', { fabric: { maxResultChars: 100 } });
    expect(small.text).toBe("y".repeat(100) + "\n[fabric_exec output truncated: 100 of 500 characters shown]");
    const fits = await runProgram('return "z".repeat(39_999)');
    expect(fits.text).toBe("z".repeat(39_999));
  });

  it("refuses arguments over maxArgumentBytes (default 262 144) before the tool runs", async () => {
    const over = await runProgram(`
      try { await tools.search_knowledge({ query: "q".repeat(262_200) }); return "ran"; }
      catch (error) { return "refused: " + error.message; }`);
    expect(over.text).toBe("refused: search_knowledge arguments exceed 262144 bytes");
    expect(over.calls).toEqual([]);
    const under = await runProgram('await tools.search_knowledge({ query: "q".repeat(200_000) }); return "ok"');
    expect(under.text).toBe("ok");
    expect((under.calls[0]?.args as { query: string }).query).toHaveLength(200_000);
    const small = await runProgram(`
      try { await tools.search_knowledge({ query: "q".repeat(100) }); return "ran"; }
      catch (error) { return "refused: " + error.message; }`, { fabric: { maxArgumentBytes: 50 } });
    expect(small.text).toBe("refused: search_knowledge arguments exceed 50 bytes");
    expect(small.calls).toEqual([]);
  });

  it("uses quickJsWasmModule instead of the bundled wasm when given", async () => {
    // An empty but valid wasm module: if the option is used, the kernel cannot start.
    const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const onError = vi.fn();
    const run = await runProgram("return 1", { fabric: { quickJsWasmModule: empty, onError } });
    expect(run.isError).toBe(true);
    expect(run.text).toBe("fabric_exec failed with an internal error. The program may not have run.");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("quickJsWasmBytes (Worker recipe)", () => {
  it("returns the installed QuickJS wasm, which runs programs when passed back as quickJsWasmModule", async () => {
    const { quickJsWasmBytes } = await import("../src/durable-extension-wasm.js");
    const bytes = await quickJsWasmBytes();
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(WebAssembly.validate(bytes)).toBe(true);
    // The helper restores the host's WebAssembly.instantiate.
    expect(WebAssembly.instantiate.name).toBe("instantiate");
    const precompiled = new WebAssembly.Module(bytes);
    const onError = vi.fn();
    const run = await runProgram("return { sum: 1 + 2, ok: typeof tools }", { fabric: { quickJsWasmModule: precompiled, onError } });
    expect(onError).not.toHaveBeenCalled();
    expect(run.isError).toBe(false);
    expect(parsed(run.text)).toEqual({ sum: 3, ok: "object" });
  });
});

describe("onError and internal failures", () => {
  const failing = (): FabricKernelRuntime => ({
    execute: async () => { throw new Error("kernel load failed: token=sk-live-123 at /srv/host/secret.ts:10"); },
  });

  it("reports a kernel failure once with the conversation and call ids, and the model sees only the fixed error", async () => {
    const onError = vi.fn();
    const run = await runProgram("return 1", { fabric: { runtime: failing(), onError } });
    expect(run.isError).toBe(true);
    expect(run.text).toBe("fabric_exec failed with an internal error. The program may not have run.");
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0]!;
    expect((error as Error).message).toContain("kernel load failed");
    expect(info).toEqual({ conversationId: run.conversationId, callId: run.callId });
    expect(run.callId).toBe("call_1");
  });

  it("returns the same fixed error without onError, and a throwing onError changes nothing", async () => {
    const without = await runProgram("return 1", { fabric: { runtime: failing() } });
    const throwing = await runProgram("return 1", { fabric: { runtime: failing(), onError: () => { throw new Error("onError broke"); } } });
    for (const run of [without, throwing]) {
      expect(run.status).toBe("done");
      expect(run.isError).toBe(true);
      expect(run.text).toBe("fabric_exec failed with an internal error. The program may not have run.");
    }
  });

  it("shows a provider action's failure as a fixed message and sends the error to onError", async () => {
    const onError = vi.fn();
    const run = await runProgram(`
      const out = [];
      try { await fabric.tools.call({ ref: "vault.read", args: {} }); } catch (error) { out.push(error.message); }
      try { await vault.deny({}); } catch (error) { out.push(error.message); }
      return out;`, { fabric: { onError, providers: { vault: { actions: {
        read: () => { throw new Error("db password=hunter2 at /srv/vault.ts:3"); },
        deny: () => { throw new FabricDurableRefusal("vault is read-only here"); },
      } } } } });
    expect(parsed<string[]>(run.text)).toEqual(["Fabric action vault.read failed", "vault is read-only here"]);
    expect(run.text).not.toContain("hunter2");
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toContain("hunter2");
  });

  it("hides an unexpected host error behind a fixed message and reports it", async () => {
    const onError = vi.fn();
    const host = await openHost({ fabric: { onError } });
    try {
      const conversation = await host.conversation("t_alpha");
      // Break the conversation's tool lookup the way a storage failure would.
      const tool = host.fabric.tools![0]!;
      const execute = tool.execute.bind(tool);
      (tool as { execute: ToolRegistration["execute"] }).execute = (args, api, context) => execute(args, {
        ...api,
        conversationId: api.conversationId,
        callId: api.callId,
        agent: async () => { throw new Error("sqlite: disk I/O error at /var/lib/host/db.sqlite"); },
      } as typeof api, context);
      // The catalog loads while the program starts, so the failure ends the program.
      const run = await host.turn(conversation, "broken", "return Object.keys(tools)");
      expect(run.isError).toBe(true);
      expect(run.text).toContain("Fabric host call failed");
      expect(run.text).not.toMatch(/disk I\/O|\/var\/lib/);
      expect(onError).toHaveBeenCalledTimes(1);
      expect((onError.mock.calls[0]![0] as Error).message).toContain("disk I/O");
    } finally {
      await host.close();
    }
  });
});

describe("program behaviour", () => {
  it("returns host tool results and runs Promise.all calls concurrently", async () => {
    // Each tool waits until the other has started: sequential calls would hit the deadline.
    const a = latch();
    const b = latch();
    const run = await runProgram(`
      const [first, second] = await Promise.all([tools.gate_a({}), tools.gate_b({})]);
      return { first, second, hit: await tools.search_knowledge({ query: "phishing" }) };`, {
      fabric: { timeoutMs: 3_000 },
      tools: [
        textTool("gate_a", async () => { a.open(); await b.opened; return "A"; }),
        textTool("gate_b", async () => { b.open(); await a.opened; return "B"; }),
      ],
    });
    expect(run.isError).toBe(false);
    expect(parsed(run.text)).toEqual({ first: "A", second: "B", hit: "search_knowledge:phishing" });
  });

  it("rejects in the program with the tool's own error text", async () => {
    const run = await runProgram(`
      try { await tools.fail_tool({}); return "ran"; } catch (error) { return "caught: " + error.message; }`);
    expect(run.text).toBe("caught: quota exceeded for this key");
  });

  it("returns a program error to the model as a tool error that lists the calls already made", async () => {
    const run = await runProgram(`
      await tools.search_knowledge({ query: "one" });
      await tools.fail_tool({}).catch(() => undefined);
      throw new Error("program gave up");`);
    expect(run.isError).toBe(true);
    expect(run.text).toContain("Error (runtime_error):");
    expect(run.text).toContain("program gave up");
    expect(run.text).toContain("Nested calls made before the error (they are not undone): search_knowledge (ok), fail_tool (failed).");
  });

  it("keeps print() output ahead of the result and reads payloads as π", async () => {
    const run = await runProgram('print("seen"); return π.note.toUpperCase()', {}, { note: "hello" });
    expect(run.text).toBe("seen\nHELLO");
  });
});

describe("limits", () => {
  it("stops an endless loop at the deadline", async () => {
    const started = Date.now();
    const run = await runProgram("while (true) {}", { fabric: { timeoutMs: 300 } });
    expect(run.isError).toBe(true);
    expect(run.text).toContain("Error (timed_out)");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("stops a huge allocation at the heap limit", async () => {
    const run = await runProgram("const parts = []; for (let i = 0; i < 1e6; i++) parts.push('x'.repeat(1024)); return parts.length;", { fabric: { memoryLimitBytes: 8 * 1024 * 1024 } });
    expect(run.isError).toBe(true);
    expect(run.text).toMatch(/out of memory|memory/i);
  });

  it("cuts print() output at maxLogChars with a notice", async () => {
    const run = await runProgram('for (let i = 0; i < 100; i++) print("line " + i); return "end";', { fabric: { maxLogChars: 50 } });
    expect(run.text).toContain("[Pi Fabric log output truncated]");
    expect(run.text).not.toContain("line 99");
    expect(run.text.endsWith("end")).toBe(true);
  });
});

describe("the prompt section", () => {
  it("lists only the tools a program may call, as declarations", async () => {
    const run = await runProgram("return 1", { fabric: { tools: ["search_knowledge", "model_only"] } });
    const section = parsed<{ sections: { fabric: string } }[]>(run.prompt)[0]!.sections.fabric;
    // pi-codemode's declarations: one `declare const tools` with a doc comment per tool.
    expect(section).toContain("```ts\ndeclare const tools: {\n  /** Stub search_knowledge search tool */\n  search_knowledge(args: { query?: string; }): Promise<string>;\n};\n```");
    // Not granted, model-only, or fabric_exec itself: never listed.
    for (const hidden of ["secret_admin", "model_only", "fail_tool", "fabric_exec("]) expect(section).not.toContain(hidden);
    expect(section).not.toContain("Some tools are not listed");
    expect(section).toContain("No Fabric providers are available.");
  });

  it("keeps declarations within sectionTokenBudget and says some tools are hidden", async () => {
    const many = Array.from({ length: 40 }, (_, index) => textTool(`bulk_${index}`, () => "x", { description: `Bulk tool ${index} ${"word ".repeat(40)}` }));
    const small = await runProgram("return 1", { tools: many, fabric: { sectionTokenBudget: 300 } });
    const section = parsed<{ sections: { fabric: string } }[]>(small.prompt)[0]!.sections.fabric;
    const listed = section.match(/^ {2}bulk_\d+\(args/gm) ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(40);
    const declarations = section.split("\n").filter((line) => !line.startsWith("Use ") && !line.startsWith("Tools ") && !line.startsWith("Some ") && !line.startsWith("No ") && !line.startsWith("<"));
    expect(declarations.join("\n").length).toBeLessThanOrEqual(300 * 4);
    expect(section).toContain("Some tools are not listed: find them with `searchTools(query)` and read one with `describeTool(name)`.");
    // Default budget (3 000 tokens) lists more of them, still within the budget.
    const byDefault = await runProgram("return 1", { tools: many });
    const full = parsed<{ sections: { fabric: string } }[]>(byDefault.prompt)[0]!.sections.fabric;
    expect((full.match(/^ {2}bulk_\d+\(args/gm) ?? []).length).toBeGreaterThan(listed.length);
    expect(full.length).toBeLessThan(3_000 * 4 + 600);
  });

  it("declares granted provider actions as a namespace and describes each provider once", async () => {
    const run = await runProgram("return 1", { fabric: { tools: [], providers: { notes: { description: "Team notes", actions: { add: async () => 1, peek: { repeatable: true, run: async () => 2 } } } } } });
    const section = parsed<{ sections: { fabric: string } }[]>(run.prompt)[0]!.sections.fabric;
    expect(section).toContain("declare const notes: {\n  add(args: { [key: string]: unknown; }): Promise<unknown>;\n  peek(args: { [key: string]: unknown; }): Promise<unknown>;\n};");
    expect(section).toContain("Granted providers: notes (Team notes).");
    expect(section).not.toContain("declare const tools");
  });

  it("declares a tool whose name is not an identifier under pi-codemode's identifier, and calls it by either name", async () => {
    const dashed = textTool("look-up", () => "dashed result", { description: "Dashed lookup" });
    const run = await runProgram(`
      return {
        byIdentifier: await tools.look_up({}),
        byName: await tools["look-up"]({}),
        described: (await describeTool("look_up")).split("\\n")[0],
      };`, { tools: [dashed], fabric: { tools: ["look-up"] } });
    const section = parsed<{ sections: { fabric: string } }[]>(run.prompt)[0]!.sections.fabric;
    expect(section).toContain("  look_up(args: { [key: string]: unknown; }): Promise<string>;");
    expect(parsed(run.text)).toEqual({ byIdentifier: "dashed result", byName: "dashed result", described: "Dashed lookup" });
  });

  it("keeps deferred tools callable and searchable but out of the section, like pi-durable codemode", async () => {
    const rare = textTool("rare_lookup", () => "rare result", { description: "Rare lookup of archived incidents", deferred: true });
    const run = await runProgram(`
      return {
        called: await tools.rare_lookup({}),
        found: (await searchTools("archived incidents")).map((tool) => tool.name),
        described: await describeTool("rare_lookup"),
      };`, { tools: [rare] });
    const section = parsed<{ sections: { fabric: string } }[]>(run.prompt)[0]!.sections.fabric;
    expect(section).not.toContain("rare_lookup");
    expect(section).toContain("Some tools are not listed");
    const value = parsed<{ called: string; found: string[]; described: string }>(run.text);
    expect(value.called).toBe("rare result");
    expect(value.found).toEqual(["rare_lookup"]);
    expect(value.described).toBe("Rare lookup of archived incidents\n\n```ts\ndeclare const tools: { rare_lookup(args: { [key: string]: unknown; }): Promise<string>; };\n```");
  });
});

describe("a program cannot reach a tool the conversation or host did not allow", () => {
  const attempts = `
    const attempt = async (label, fn) => { try { const value = await fn(); return label + ": ran " + JSON.stringify(value); } catch (error) { return label + ": refused"; } };
    const name = ["secret", "admin"].join("_");
    return [
      await attempt("computed", () => tools[name]({ query: "x" })),
      await attempt("native", () => nativeTools[name]({ query: "x" })),
      await attempt("call", () => fabric.tools.call({ ref: name, args: { query: "x" } })),
      await attempt("call-native", () => fabric.tools.call({ ref: "fabric.$nativeTool", args: { name, args: {} } })),
      await attempt("describe", () => describeTool(name)),
      await attempt("search", async () => { const hits = await searchTools("secret admin"); if (hits.length) return hits; throw new Error("none"); }),
      await attempt("proto", () => Object.getPrototypeOf(tools)[name]({})),
      await attempt("ctor", () => tools.constructor.constructor("return tools")()[name]({})),
      await attempt("global", () => globalThis.tools[name]({})),
      await attempt("host-fn", () => globalThis.__fabricHostCall("fabric.$nativeTool", { name, args: {} })),
      await attempt("this", () => Function("return this")().nativeTools[name]({})),
    ];`;

  it("refuses a tool the host did not grant, by every route", async () => {
    const run = await runProgram(attempts, { fabric: { tools: ["search_knowledge"] } });
    const lines = parsed<string[]>(run.text);
    expect(lines).toHaveLength(11);
    for (const line of lines) expect(line).toMatch(/: refused$/);
    expect(run.calls).toEqual([]);
  });

  it("refuses a tool the conversation does not allow even when the host grants it", async () => {
    const host = await openHost();
    try {
      const allowed = host.registry.snapshot().tools().map((entry) => entry.tool).filter((tool) => tool.name === "search_knowledge" || tool.name === "fabric_exec");
      const conversation = await host.conversation("t_alpha", { tools: allowed });
      const run = await host.turn(conversation, "narrow", attempts.replace("return [", "const before = Object.keys(tools); return [JSON.stringify(before),"));
      const lines = parsed<string[]>(run.text);
      expect(lines[0]).toBe('["search_knowledge"]');
      for (const line of lines.slice(1)) expect(line).toMatch(/: refused$/);
      expect(host.calls).toEqual([]);
      // A model-only tool, fabric_exec included, is never callable from a program, nor listed, found or described.
      const modelOnly = await host.turn(await host.conversation("t_alpha"), "model-only", `
        const seen = { keys: Object.keys(tools).sort(), all: ALL_TOOLS.map((tool) => tool.name).sort() };
        for (const name of ["model_only", "fabric_exec"]) {
          seen[name + " search"] = (await searchTools(name.replace("_", " "))).map((hit) => hit.name).includes(name);
          try { await describeTool(name); seen[name + " describe"] = "described"; } catch { seen[name + " describe"] = "refused"; }
          try { await nativeTools[name]({ code: "1" }); seen[name + " call"] = "ran"; } catch { seen[name + " call"] = "refused"; }
        }
        return seen;`);
      expect(modelOnly.text, modelOnly.text).not.toMatch(/^Error/);
      expect(parsed(modelOnly.text)).toEqual({
        keys: ["fail_tool", "search_knowledge", "secret_admin"],
        all: ["fail_tool", "search_knowledge", "secret_admin"],
        "model_only search": false, "model_only describe": "refused", "model_only call": "refused",
        "fabric_exec search": false, "fabric_exec describe": "refused", "fabric_exec call": "refused",
      });
      expect(host.calls).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("providers are default-deny and get copied JSON", () => {
  it("refuses every Fabric namespace and pi.* the host did not grant", async () => {
    const run = await runProgram(`
      const attempt = async (label, fn) => { try { await fn(); return label + ": ran"; } catch (error) { return label + ": " + error.message; } };
      return [
        await attempt("memory", () => memory.search({ query: "x" })),
        await attempt("state", () => fabric.tools.call({ ref: "state.get", args: {} })),
        await attempt("pi", () => pi.bash({ cmd: "id" })),
        await attempt("pi-read", () => pi.read("/etc/passwd")),
        await attempt("agents", () => agents.run({ task: "x" })),
        await attempt("mcp", () => fabric.tools.call({ ref: "mcp.server.tool", args: {} })),
        await attempt("jev", () => jev.run({ code: "1" })),
        await attempt("mesh", () => mesh.publish({ topic: "x" })),
        await attempt("models", () => models()),
        await attempt("granted", () => fabric.tools.call({ ref: "notes.add", args: { text: "ok" } })),
        await attempt("granted-unknown", () => fabric.tools.call({ ref: "notes.remove", args: {} })),
        await attempt("granted-proto", () => fabric.tools.call({ ref: "notes.constructor", args: {} })),
      ];`, { fabric: { providers: { notes: { actions: { add: (args) => ({ added: args.text }) } } } } });
    const lines = parsed<string[]>(run.text);
    expect(lines).toHaveLength(12);
    for (const line of [...lines.slice(0, 9), ...lines.slice(10)]) {
      expect(line).not.toMatch(/: ran$/);
      expect(line).toMatch(/not granted|Not available/);
    }
    expect(lines[9]).toBe("granted: ran");
  });

  it("copies arguments and results even when a custom runtime passes live objects", async () => {
    // A runtime override (another isolate, a test double) may hand the host any object: the extension copies it.
    class Live { n = 1; get computed() { return "getter"; } }
    const sent = new Live();
    let received: unknown;
    let returned: unknown;
    const shared = { kept: true };
    const runtime: FabricKernelRuntime = {
      execute: async (_code, hostCall) => {
        returned = await hostCall("fabric.$call", { ref: "notes.add", args: sent }, new AbortController().signal);
        return { value: "ok", logs: [], terminationReason: "completed" };
      },
    };
    await runProgram("return 1", { fabric: { runtime, providers: { notes: { actions: {
      add: (args) => { received = args; (args as { n: number }).n = 99; return { shared, fn: () => 1, map: new Map([["a", 1]]) }; },
    } } } } });
    expect(received).toEqual({ n: 99 });
    expect(Object.getPrototypeOf(received)).toBe(Object.prototype);
    expect(sent.n).toBe(1);
    expect(returned).toEqual({ shared: { kept: true }, map: {} });
    expect((returned as { shared: unknown }).shared).not.toBe(shared);
  });

  it("gives a granted action a plain JSON copy and the program a JSON copy back", async () => {
    const received: unknown[] = [];
    const run = await runProgram(`
      const value = { n: 1, list: [1, { deep: true }], when: new Date(0), skip: undefined };
      const first = await notes.add(value);
      value.n = 2;
      const second = await notes.add(value);
      return { first, second };`, { fabric: { providers: { notes: { actions: {
        add: (args) => {
          received.push(args);
          const copy = args as { n: number; mutated?: boolean };
          copy.mutated = true; // must not reach the next call
          return { echo: args.n, fn: () => 1, map: new Map([["a", 1]]), date: new Date(0) };
        },
      } } } } });
    expect(received).toEqual([
      { n: 1, list: [1, { deep: true }], when: "1970-01-01T00:00:00.000Z", mutated: true },
      { n: 2, list: [1, { deep: true }], when: "1970-01-01T00:00:00.000Z", mutated: true },
    ]);
    for (const args of received) expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(received[0]).not.toBe(received[1]);
    expect(parsed(run.text)).toEqual({
      first: { echo: 1, map: {}, date: "1970-01-01T00:00:00.000Z" },
      second: { echo: 2, map: {}, date: "1970-01-01T00:00:00.000Z" },
    });
  });
});

describe("nested calls pass the host's ToolTask hooks", () => {
  it("lets a tenantGuard-shaped hook refuse a call naming another tenant", async () => {
    const run = await runProgram(`
      const own = await tools.search_knowledge({ query: "t_alpha incidents" });
      let other;
      try { other = await tools.search_knowledge({ query: "t_beta incidents" }); } catch (error) { other = "refused: " + error.message; }
      return { own, other };`);
    expect(parsed(run.text)).toEqual({ own: "search_knowledge:t_alpha incidents", other: expect.stringMatching(/^refused: .*another tenant/) });
    expect(run.calls.map((call) => call.args)).toEqual([{ query: "t_alpha incidents" }]);
  });
});

describe("no host capabilities in the sandbox", () => {
  it("has no file, process, network or module access and no host object", async () => {
    const run = await runProgram(`
      const names = ["require", "process", "fetch", "Deno", "Bun", "XMLHttpRequest", "WebSocket", "navigator", "Buffer", "WebAssembly", "queueMicrotask", "__fabricHostCall", "__call", "std", "os", "performance"];
      const types = Object.fromEntries(names.map((name) => [name, typeof globalThis[name]]));
      let imported; try { await import("node:fs"); imported = "imported"; } catch { imported = "refused"; }
      let env; try { env = typeof Function("return process")(); } catch { env = "none"; }
      return { types, imported, env };`);
    const value = parsed<{ types: Record<string, string>; imported: string; env: string }>(run.text);
    for (const [name, type] of Object.entries(value.types)) expect([name, type]).toEqual([name, "undefined"]);
    expect(value.imported).toBe("refused");
    expect(value.env).toBe("none");
  });

  it("drops pending guest timers when the program ends instead of waiting for them", async () => {
    // Watch the host's own timers: every timer a program schedules must be cleared when it ends, not left to expire.
    const created = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSet(fn, ms);
      if (ms === 60_000) created.add(timer);
      return timer;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(timer);
      realClear(timer);
    }) as typeof clearTimeout);
    const started = Date.now();
    const run = await runProgram(`
      let fired = false;
      for (let i = 0; i < 10; i++) setTimeout(() => { fired = true; }, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { fired, end: true };`, { fabric: { timeoutMs: 20_000 } });
    setSpy.mockRestore();
    clearSpy.mockRestore();
    expect(parsed(run.text)).toEqual({ fired: false, end: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(created.size).toBe(10);
    for (const timer of created) expect(cleared.has(timer)).toBe(true);
  });
});

describe("results hold no host secrets", () => {
  it("shows a program error without host paths", async () => {
    const run = await runProgram('const value = null; return value.missing;');
    expect(run.isError).toBe(true);
    expect(run.text).not.toMatch(/\/home\/|node_modules|\.worktrees|src\/runtime/);
  });
});
