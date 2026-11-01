import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createSyntheticSourceInfo, defineTool, type ExtensionContext, type ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { normalizeMcpResult } from "../src/providers/mcp-provider.js";
import { nativeMcpIdentity } from "../src/core/native-mcp-identity.js";
import { nativeToolCatalog, resolveNativeTool } from "../src/native-tool-catalog.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function fixture(profile: "additive" | "native" = "additive", runtime: "quickjs" | "node-process" | "bun-process" = "quickjs", extra: ReturnType<typeof defineTool>[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "fabric-native-test-"));
  cleanups.push(() => rmSync(cwd, {recursive: true, force: true}));
  writeFileSync(join(cwd, "input.txt"), "hello");
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  Object.assign(config.executor, {codemodeProfile: profile, runtime});
  Object.assign(config.approvals, {read: "allow", write: "allow", execute: "allow", network: "allow"});
  const echo = vi.fn(async (_id: string, args: { fail?: boolean }) => ({
    content: [{type: "text" as const, text: "display text"}], details: {},
    structuredContent: {answer: 42}, ...(args.fail ? {isError: true} : {}),
  }));
  const definitions = [
    defineTool({name: "echo", label: "Echo", description: "Structured example", parameters: Type.Object({fail: Type.Optional(Type.Boolean())}), outputSchema: Type.Object({answer: Type.Number()}), namespace: {name: "examples", instructions: "Example namespace"}, execute: echo}),
    defineTool({name: "search", label: "Search", description: "Native search tool", parameters: Type.Object({}), async execute() { return {content: [{type: "text" as const, text: "native search"}], details: {}}; }}),
    ...extra,
  ];
  const runner = {createContext: () => ({cwd}), getActiveTools: () => definitions.map(d => d.name), emit: vi.fn(async () => {}), emitToolCall: vi.fn(async () => undefined), emitToolResult: vi.fn(async () => undefined)} as unknown as ExtensionRunner;
  const captured = new CapturedToolCatalog();
  captured.replace(definitions.map(definition => ({definition, sourceInfo: createSyntheticSourceInfo("/extensions/example.ts", {source: "test"})})), runner, config.capture, "/extensions/fabric.ts");
  const actions = new ActionRegistry();
  const extensions = new CapturedToolsProvider(captured);
  actions.register(extensions);
  actions.register(new PiToolsProvider(cwd, captured, extensions));
  let branch: any[] = [];
  let n = 0;
  const context = {cwd, hasUI:false, sessionManager:{getBranch:()=>branch,getSessionId:()=>"native-test",getSessionFile:()=>undefined,getLeafId:()=>String(branch.length)}} as unknown as ExtensionContext;
  const service = new FabricExecutionService(actions, config, undefined, undefined, undefined, undefined, captured);
  service.nativeCodemode.setPersistence((customType, data) => branch.push({type:"custom",customType,data}));
  const run = async (code: string) => {
    const result = await service.execute({code, context, signal:undefined, parentToolCallId:`native-${++n}`, onPartial(){}});
    for (const log of result.logs) if (log.startsWith("Image saved to: ")) cleanups.push(() => rmSync(dirname(log.slice(16)), {recursive:true,force:true}));
    return result;
  };
  return {run, config, echo, runner, branch:()=>branch, setBranch:(value:any[])=>{branch=value;}, cwd, definitions, actions};
}

describe.each(["additive", "native"] as const)("%s native tool compatibility", profile => {
  it.each(["quickjs", "node-process", "bun-process"] as const)("preserves both API result views in %s", async runtime => {
    const f = fixture(profile, runtime);
    const result = await f.run('const a = await tools.echo({}); const b = await nativeTools.echo({fail:true}); const c = await extensions.echo({}); return {a,b,c};');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({a:{answer:42},b:{answer:42},c:{text:"display text",structuredContent:{answer:42},isError:false}});
    expect(f.echo).toHaveBeenCalledTimes(3);
    expect(f.runner.emitToolCall).toHaveBeenCalledTimes(3);
    expect(f.runner.emitToolResult).toHaveBeenCalledTimes(3);
    expect((await f.run('return await extensions.echo({fail:true});')).success).toBe(false);
  });

  it("keeps colliding tools and discovery unambiguous", async () => {
    const f = fixture(profile);
    const result = await f.run(`return {native: await nativeTools.search({}), current: await tools.search(${profile === "native" ? "{}" : '{query:"echo"}'}), fabric: await fabric.tools.search({query:"echo"}), names: Object.keys(nativeTools), missing: typeof nativeTools.not_registered};`);
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({native:"native search",fabric:expect.any(Array),names:expect.arrayContaining(["echo","search","read"]),missing:"undefined"});
    expect((result.value as any).current).toEqual(profile === "native" ? "native search" : expect.any(Array));
  });

  it("returns native discovery declarations and namespace names", async () => {
    const f = fixture(profile);
    const prefix = profile === "native" ? "" : "nativeDiscovery.";
    const result = await f.run(`return {one:await ${prefix}describeTool("echo"), ns:await ${prefix}describeNamespace("examples"), hits:await ${prefix}searchTools("structured example"), all:${profile === "native" ? "ALL_TOOLS" : "nativeDiscovery.ALL_TOOLS"}};`);
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({one:expect.stringContaining("answer"),ns:{name:"examples",instructions:"Example namespace",tools:["echo"]},hits:expect.arrayContaining([expect.objectContaining({name:"echo"})]),all:expect.arrayContaining([expect.objectContaining({name:"read"})])});
  });

  it.each(["enum", "anyOf"] as const)("keeps all 13 %s alternatives visible and dispatchable", async kind => {
    const values = Array.from({length: 13}, (_, i) => `operation_${i}`);
    const parameters = Type.Object({choice: Type.Unsafe(kind === "enum" ? {type: "string", enum: values} : {anyOf: values.map(value => ({const: value}))})});
    const execute = vi.fn(async (_id: string, args: {choice: unknown}) => ({content: [{type: "text" as const, text: String(args.choice)}], details: {}}));
    const f = fixture(profile, "quickjs", [defineTool({
      name: "choose_value", label: "Choose value", description: "Choose a sample operation", parameters, execute,
    })]);
    const prefix = profile === "native" ? "" : "nativeDiscovery.";
    const result = await f.run(`return {preview: await ${prefix}describeTool("choose_value"), hits: await ${prefix}searchTools("sample operation"), raw: await fabric.tools.describe({ref: "extensions.choose_value"}), result: await nativeTools.choose_value({choice:"operation_12"})};`);
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    const value = result.value as {preview: string; hits: unknown; raw: {inputSchema: unknown}; result: string};
    for (const operation of values) {
      expect(value.preview).toContain(operation);
      expect(JSON.stringify(value.hits)).toContain(operation);
    }
    expect(value.preview).not.toContain("truncated");
    expect(value.raw.inputSchema).toEqual(parameters);
    expect(value.result).toBe("operation_12");
    const invalid = await f.run('return await nativeTools.choose_value({choice: ("not_authorized" as any)});');
    expect(invalid.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps field guidance and large contracts visible through actual discovery", async () => {
    const guidance = Type.Object({
      page_number: Type.Optional(Type.Number({description: "Initial page is zero; omit for the initial read."})),
      reference: Type.Object({id: Type.Number({description: "Record ID from the current account lookup receipt."})}),
    });
    const large = Type.Object({project_id: Type.Number(), record: Type.Object({
      title: Type.String({description: "Preserve the requested title and selected resource scope. ".repeat(300)}),
      steps: Type.Array(Type.Object({name: Type.String(), expectedResult: Type.String()})),
      mode: Type.Literal("MANUAL"),
    })});
    const f = fixture(profile, "quickjs", [guidance, large].map((parameters, i) => defineTool({
      name: `sample_contract_${i}`, label: "Sample contract", description: "Sample contract discovery",
      parameters,
      async execute() { return {content: [{type: "text" as const, text: "ok"}], details: {}}; },
    })));
    const prefix = profile === "native" ? "" : "nativeDiscovery.";
    const result = await f.run(`return {guidance:await ${prefix}describeTool("sample_contract_0"), large:await ${prefix}describeTool("sample_contract_1"), hits:await ${prefix}searchTools("Sample contract discovery"), raw:await fabric.tools.describe({ref:"extensions.sample_contract_1"}), invoked:await nativeTools.sample_contract_1({project_id:1,record:{title:"sample",steps:[{name:"step",expectedResult:"done"}],mode:"MANUAL"}})};`);
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    const value = result.value as {guidance: string; large: string; hits: unknown; raw: {inputSchema: unknown}; invoked: string};
    for (const text of ["Initial page is zero; omit for the initial read.", "Record ID from the current account lookup receipt."]) {
      expect(value.guidance).toContain(text);
      expect(JSON.stringify(value.hits)).toContain(text);
    }
    expect(value.guidance).toContain("page_number?: number");
    expect(value.guidance).toContain("reference: { /** Record ID from the current account lookup receipt. */ id: number");
    for (const text of ["project_id: number", "expectedResult: string", 'mode: "MANUAL"', "fabric.tools.describe"]) expect(value.large).toContain(text);
    expect(value.large).not.toContain("(args: unknown)");
    expect(JSON.stringify(value.hits)).toContain("expectedResult: string");
    expect(value.raw.inputSchema).toEqual(large);
    expect(value.invoked).toBe("ok");
  });

  it("preserves content-only redaction instead of restoring structured data", async () => {
    const f = fixture(profile);
    vi.mocked(f.runner.emitToolResult).mockResolvedValue({content:[{type:"text",text:"redacted"}]} as any);
    const result = await f.run('return await tools.echo({});');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toBe("redacted");
    expect(JSON.stringify(result)).not.toContain('"answer":42');
  });

  it("does not bypass approval or Schema authorization", async () => {
    const f = fixture(profile);
    f.config.approvals.actions = {"extensions.echo":"deny"};
    expect((await f.run('return await tools.echo({});')).success).toBe(false);
    expect(f.echo).not.toHaveBeenCalled();
    f.config.approvals.actions = {};
    const service = new FabricExecutionService(f.actions, f.config, undefined, {authorize:async()=>{throw new Error("schema denied");}});
    const result = await service.execute({code:'return await tools.echo({});',context:{cwd:f.cwd,hasUI:false,sessionManager:{getBranch:()=>[]}} as unknown as ExtensionContext,signal:undefined,parentToolCallId:"denied",onPartial(){}});
    expect(result.success).toBe(false);
    expect(f.echo).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("preserves native bash nonzero output and Fabric settle semantics", async () => {
    const f = fixture(profile);
    const result = await f.run('return {native: await tools.bash({command:"printf hello; exit 7"}), fabric: await pi.bash({command:"printf hello; exit 7",settle:true})};');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({native:{output:expect.stringContaining("hello"),exit_code:7},fabric:{ok:false,exitCode:7}});
  });

  it("returns strings for native writes while preserving Fabric envelopes", async () => {
    const f = fixture(profile);
    const result = await f.run('const n = await tools.write({path:"n.txt",content:"native"}); const p = await pi.write({path:"p.txt",content:"fabric"}); return {n,p,read:await tools.read({path:"n.txt"})};');
    expect(result.success, result.error).toBe(true);
    expect(result.value).toMatchObject({n:expect.any(String),p:{ok:true},read:"native"});
  });

  it("keeps native image reads in the guest until explicitly emitted", async () => {
    const f = fixture(profile);
    writeFileSync(join(f.cwd, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
    const result = await f.run('const block = await tools.read({path:"pixel.png"}); if(typeof block === "string") throw new Error(block); return {type:block.type,mimeType:block.mimeType,size:block.data.length};');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toMatchObject({type:"image",mimeType:"image/png",size:expect.any(Number)});
    expect(result.media ?? []).toEqual([]);
    const shown = await f.run('image(await tools.read({path:"pixel.png"}));');
    expect(shown.success,shown.error).toBe(true);
    expect(shown.media).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("retains native structured shell output beyond display truncation", async () => {
    const f = fixture(profile);
    const result = await f.run('const r = await tools.bash({command:"printf %070000d 0"}); return {length:r.output.length,truncated:r.truncated,exit:r.exit_code};');
    expect(result.success,result.error).toBe(true);
    expect(result.value).toEqual({length:70000,truncated:false,exit:0});
  });

  it("shows explicit images and creates host-side artifacts", async () => {
    const f = fixture(profile);
    const result = await f.run('image("data:image/png;base64,aGVsbG8="); text("shown");');
    expect(result.success, result.error).toBe(true);
    expect(result.media).toHaveLength(1);
    const log = result.logs.find(value => value.startsWith("Image saved to: "))!;
    expect(readFileSync(log.slice(16), "utf8")).toBe("hello");
  });
});

it("native profile reads/writes Pi store deltas without merging Fabric state", async () => {
  const f = fixture("native");
  f.setBranch([{type:"custom",customType:"codemode-store",data:{set:{x:1},delete:[]}}, {type:"custom",customType:"fabric-codemode-store",data:{values:{x:9}}}]);
  expect((await f.run('store("y",2); return load("x");')).value).toBe(1);
  expect(f.branch().at(-1)).toMatchObject({customType:"codemode-store",data:{set:{y:2},delete:[]}});
  expect((await f.run('store("x",undefined); throw new Error("rollback");')).success).toBe(false);
  expect((await f.run('return load("x");')).value).toBe(1);
  await f.run('store("x",undefined);');
  expect(f.branch().at(-1)).toMatchObject({data:{set:{},delete:["x"]}});
  f.config.executor.codemodeProfile = "additive";
  expect((await f.run('return load("x");')).value).toBe(9);
});

it("keeps MCP errors as native envelopes while Fabric MCP calls still reject", () => {
  const result = {content:[{type:"text",text:"failed"}],structuredContent:{retry:false},isError:true,_meta:{source:"test"}};
  expect(normalizeMcpResult(result,true)).toBe(result);
  expect(()=>normalizeMcpResult(result)).toThrow("failed");
});

it("rejects sanitized alias collisions rather than choosing an arbitrary tool", () => {
  const actions = ["a-b","a_b"].map(name => ({provider:"extensions",ref:`extensions.${name}`,name,description:name,inputSchema:{},risk:"read" as const}));
  expect(()=>resolveNativeTool(nativeToolCatalog(actions,[],nativeMcpIdentity),"a_b")).toThrow(/ambiguous/);
});

it("normalizes the opt-in profile without changing existing defaults", () => {
  expect(normalizeFabricConfig({}).executor.codemodeProfile).toBe("additive");
  expect(normalizeFabricConfig({executor:{codemodeProfile:"native"}}).executor.codemodeProfile).toBe("native");
  expect(normalizeFabricConfig({executor:{codemodeProfile:"invalid"}}).executor.codemodeProfile).toBe("additive");
});

it.skipIf(process.platform === "win32")("exposes the task id of a detached native shell call", async () => {
  const f = fixture("native");
  const result = await f.run('const r = await tools.bash({command:"printf hi", background:true}); return {r, id: typeof r === "object" && r ? r.taskId : undefined};');
  expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
  const value = result.value as {r: {output: string; taskId: string}; id: string};
  expect(value.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(value.r.output).toContain(`[Task ${value.id};`);
});

it("resolves an overridden core tool to the single active definition", () => {
  const read = {name: "read", label: "Read", description: "override", parameters: {type: "object", properties: {}}} as any;
  const actions = [
    {provider: "pi", ref: "pi.read", name: "read", description: "core", inputSchema: {}, risk: "read" as const},
    {provider: "extensions", ref: "extensions.read", name: "read", description: "override", inputSchema: {}, risk: "read" as const},
  ];
  const entries = nativeToolCatalog(actions, [read], nativeMcpIdentity);
  expect(entries.map(entry => entry.ref)).toEqual(["pi.read"]);
  expect(resolveNativeTool(entries, "read").ref).toBe("pi.read");
});

it("keeps a non-core extension tool whose name matches no core tool", () => {
  const actions = [{provider: "extensions", ref: "extensions.echo", name: "echo", description: "e", inputSchema: {}, risk: "read" as const}];
  expect(resolveNativeTool(nativeToolCatalog(actions, [], nativeMcpIdentity), "echo").ref).toBe("extensions.echo");
});

describe("an extension override of a core tool", () => {
  const override = () => defineTool({name: "read", label: "Read", description: "Hash-anchored read", parameters: Type.Object({path: Type.String()}), async execute() { return {content: [{type: "text" as const, text: "override read"}], details: {}}; }});
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(["additive", "native"] as const)("runs the override through nativeTools.read in the %s profile", async profile => {
    const f = fixture(profile, "quickjs", [override()]);
    const result = await f.run('return await nativeTools.read({path: "input.txt"});');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toBe("override read");
  });

  it("stays unreachable when the child allowlist hides it", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", JSON.stringify(["echo"]));
    const f = fixture("native", "quickjs", [override()]);
    const result = await f.run('return await nativeTools.read({path: "input.txt"});');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("override read");
  });
});

