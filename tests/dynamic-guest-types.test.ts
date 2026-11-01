import { describe, expect, it } from "vitest";
import ts from "typescript";
import { buildDynamicGuestDeclarations, describeFabricActionDeclaration } from "../src/runtime/dynamic-guest-types.js";
import { GUEST_TYPE_DECLARATIONS, guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { sanitizeMcpRefPart } from "../src/ref-names.js";

describe("bounded schema previews", () => {
  const values = Array.from({ length: 400 }, (_, i) => `value_${i}_${"x".repeat(30)}`);
  const guidance = "exact raw inputSchema: fabric.tools.describe";
  const assertSyntax = (declaration: string) => {
    const result = ts.transpileModule(`type Preview = { ${declaration} };`, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    });
    expect(result.diagnostics).toEqual([]);
  };

  it.each(["enum", "anyOf", "oneOf", "allOf", "tuple"] as const)("marks omitted %s members without modifying the raw schema", kind => {
    const schema = kind === "enum" ? { enum: values }
      : kind === "tuple" ? { type: "array", items: values.map(value => ({ const: value })) }
      : { [kind]: values.map(value => kind === "allOf"
        ? { properties: { [value]: { type: "string" } } }
        : { const: value }) };
    const raw = structuredClone(schema);
    const preview = describeFabricActionDeclaration("sample", schema);
    expect(preview).toContain("value_0");
    expect(preview).not.toContain("value_399");
    expect(preview).toContain(`${kind === "tuple" ? "tuple items" : kind === "enum" ? "enum values" : kind === "allOf" ? "allOf members" : `${kind} alternatives`} omitted`);
    expect(preview.length).toBeLessThan(2600);
    expect(preview).toContain(guidance);
    expect(preview).toContain(kind === "tuple" ? "...unknown[]" : "unknown /* truncated:");
    assertSyntax(preview);
    const dynamic = buildDynamicGuestDeclarations({ extensionTools: [{ name: "sample", inputSchema: schema }] });
    expect(dynamic.extensions).toContain(guidance);
    const args = kind === "allOf" ? "{}" : kind === "tuple" ? JSON.stringify(values) : JSON.stringify(values[399]);
    expect(typeCheckFabricCode(`await extensions.sample(${args});`, guestTypeDeclarations(true, { dynamic })).errors).toEqual([]);
    expect(schema).toEqual(raw);
  });

  it.each([13, 40])("preserves all %i short alternatives within the type budget", count => {
    const values = Array.from({ length: count }, (_, i) => `operation_${i}`);
    const entries = values.map(value => ({ const: value }));
    for (const schema of [{ enum: values }, { anyOf: entries }, { oneOf: entries }, { allOf: entries }, { type: "array", items: entries }]) {
      const preview = describeFabricActionDeclaration("sample", schema);
      expect(preview).not.toContain("truncated");
      for (const value of values) expect(preview).toContain(JSON.stringify(value));
      assertSyntax(preview);
    }
  });

  it("escapes field comments and preserves optionality and required fields", () => {
    const schema = { type: "object", properties: {
      page_number: { type: "number", description: "Initial page is zero; omit for the initial read." },
      reference: { type: "object", properties: { id: { type: "number", description: "Record ID from the current account lookup receipt." } }, required: ["id"] },
      note: { type: "string", description: "close */\ncomment\u2028safely" },
    }, required: ["reference"] };
    const preview = describeFabricActionDeclaration("sample", schema);
    expect(preview).toContain("/** Initial page is zero; omit for the initial read. */ page_number?: number");
    expect(preview).toContain("reference: { /** Record ID from the current account lookup receipt. */ id: number");
    expect(preview).toContain("close * / comment safely");
    expect(preview).not.toContain("truncated");
    assertSyntax(preview);
  });

  it("marks depth cuts and preserves valid nested types", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i++) schema = { type: "array", items: schema };
    const preview = describeFabricActionDeclaration("deep", schema);
    expect(preview).toContain("unknown /* truncated: depth limit;");
    expect(preview).toContain(guidance);
    assertSyntax(preview);
  });

  it("shortens an 18KB description without losing structural fields", () => {
    const schema = { type: "object", properties: {
      project_id: { type: "number" },
      record: { type: "object", properties: {
        title: { type: "string", description: "Preserve the requested title and selected resource scope. ".repeat(300) },
        steps: { type: "array", items: { type: "object", properties: {
          name: { type: "string" }, expectedResult: { type: "string" },
        }, required: ["name", "expectedResult"] } },
        mode: { const: "MANUAL" },
      }, required: ["title", "steps", "mode"] },
    }, required: ["project_id", "record"] };
    const raw = structuredClone(schema);
    const preview = describeFabricActionDeclaration("big", schema);
    expect(preview).toContain("project_id: number");
    expect(preview).toContain("expectedResult: string");
    expect(preview).toContain('mode: "MANUAL"');
    expect(preview).toContain("Preserve the requested title and selected resource scope.");
    expect(preview).toContain("descriptions shortened or omitted");
    expect(preview).toContain(guidance);
    expect(preview.length).toBeLessThan(2600);
    const dynamic = buildDynamicGuestDeclarations({ extensionTools: [{ name: "big", inputSchema: schema }] });
    expect(dynamic.extensions).toContain("expectedResult: string");
    expect(schema).toEqual(raw);
    assertSyntax(preview);
  });

  it("drops descriptions before sacrificing fields or short alternatives", () => {
    const schema = { properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
      `field_${i}`, { enum: ["first", "second"], description: "Detailed guidance. ".repeat(100) },
    ])), additionalProperties: false };
    const preview = describeFabricActionDeclaration("sample", schema);
    expect(preview).toContain("descriptions shortened or omitted");
    expect(preview).not.toContain("Detailed guidance.");
    for (let i = 0; i < 20; i++) expect(preview).toContain(`field_${i}?: "first" | "second"`);
    expect(preview).toContain(guidance);
    expect(preview.length).toBeLessThan(2600);
    assertSyntax(preview);
  });

  it("collapses deep subtrees before the whole root and bounds giant inputs", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5; i++) nested = { properties: Object.fromEntries(Array.from({ length: 5 }, (_, j) => [`child_${j}`, nested])) };
    const schema = { properties: { project_id: { type: "number" }, record: nested }, required: ["project_id", "record"] };
    const preview = describeFabricActionDeclaration("big", schema);
    expect(preview).toContain("project_id: number");
    expect(preview).toContain("depth limit");
    expect(preview.length).toBeLessThan(2600);
    assertSyntax(preview);
    const giant = { enum: Array(1_000_000).fill("x".repeat(10000)) };
    const bounded = describeFabricActionDeclaration("giant", giant);
    expect(bounded).toContain("1000000 enum values omitted");
    expect(bounded).toContain(guidance);
    expect(bounded).toBe(describeFabricActionDeclaration("giant", giant));
    assertSyntax(bounded);
  });

  it("marks section-size exhaustion even below tool count limits", () => {
    const actions = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${String(i).padStart(3, "0")}`,
      inputSchema: { enum: Array.from({ length: 12 }, (_, j) => `${j}_${"x".repeat(100)}`) },
    }));
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: actions,
      providers: [{ provider: "sample", actions }],
    });
    for (const section of [dynamic.extensions, dynamic.providers]) {
      expect(section).toContain("tool_000");
      expect(section).not.toContain("tool_099");
      expect(section).toContain("Omitted");
      expect(section).toContain(guidance);
      expect(section!.length).toBeLessThan(61_000);
    }
    expect(typeCheckFabricCode("return 1;", guestTypeDeclarations(true, { dynamic })).errors).toEqual([]);
  });

  it("marks overall tool, server and provider action omissions", () => {
    const actions = Array.from({ length: 300 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: "object" } }));
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: actions,
      mcpServers: Array.from({ length: 70 }, (_, i) => ({ server: `server_${i}`, tools: actions })),
      providers: [{ provider: "sample", actions }],
    });
    for (const section of [dynamic.extensions, dynamic.mcp, dynamic.providers]) {
      expect(section).toContain("Omitted");
      expect(section).toContain(guidance);
      expect(section!.length).toBeLessThan(70_000);
    }
    expect(typeCheckFabricCode("return 1;", guestTypeDeclarations(true, { dynamic })).errors).toEqual([]);
  });
});

describe("buildDynamicGuestDeclarations", () => {
  const githubServer = {
    server: "github",
    tools: [
      {
        name: "get_repo",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
          },
          required: ["owner", "repo"],
          additionalProperties: false,
        },
      },
      {
        name: "search_repositories",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            sort: { enum: ["stars", "updated"] },
            page: { type: "integer" },
          },
          required: ["query"],
        },
      },
    ],
  };

  it("returns no replacements for empty sources, preserving the loose surface", () => {
    expect(buildDynamicGuestDeclarations({})).toEqual({});
    expect(buildDynamicGuestDeclarations({ mcpServers: [] })).toEqual({});
    expect(buildDynamicGuestDeclarations({ extensionTools: [] })).toEqual({});
    const declarations = guestTypeDeclarations(true, {
      dynamic: buildDynamicGuestDeclarations({}),
    });
    expect(declarations).toContain("declare const mcp: FabricMcpApi;");
    expect(declarations).toContain("declare const extensions: FabricExtensionsApi;");
  });

  it("renders required props, enums, and strict object shapes for mcp tools", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    expect(dynamic.mcp).toBeDefined();
    expect(dynamic.mcp).toContain("interface FabricMcpServer_github {");
    expect(dynamic.mcp).toContain(
      'get_repo(args: { owner: string; repo: string }): Promise<FabricMcpResult | unknown>;',
    );
    expect(dynamic.mcp).toContain("sort?: \"stars\" | \"updated\";");
    expect(dynamic.mcp).toContain("page?: number;");
    expect(dynamic.mcp).toContain("} & FabricMcpManagement;");
    expect(dynamic.extensions).toBeUndefined();
  });

  it("keeps the open-object index signature when additionalProperties is not false", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    // search_repositories is open: unexpected extra keys still compile.
    const open = typeCheckFabricCode(
      'await mcp.github.search_repositories({ query: "q", anything: 1 }); return "ok";',
      declarations,
    );
    expect(open.errors).toEqual([]);
  });

  it("fails type-check on arity violations for typed mcp tools", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const arity = typeCheckFabricCode(
      'await mcp.github.get_repo(); return "never";',
      declarations,
    );
    expect(arity.errors.length).toBeGreaterThan(0);
    expect(arity.errors.map((error) => error.message).join(" ")).toMatch(
      /Expected 1 arguments/,
    );
    // A missing required property alone is TS2345 — suppressed by the checker's
    // deliberate coercion policy (same as pi.* tools) — and is instead caught
    // by the registry's validate stage, covered by the execution-service tests.
    const omittedProp = typeCheckFabricCode(
      'await mcp.github.get_repo({ owner: "octo" }); return "compiles";',
      declarations,
    );
    expect(omittedProp.errors).toEqual([]);
  });

  it("fails type-check on unexpected keys for closed mcp tool schemas", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const extra = typeCheckFabricCode(
      'await mcp.github.get_repo({ owner: "o", repo: "r", branchs: "main" }); return "never";',
      declarations,
    );
    expect(extra.errors.length).toBeGreaterThan(0);
    expect(extra.errors.map((error) => error.message).join(" ")).toMatch(
      /branchs|known properties/,
    );
  });

  it("accepts correctly-shaped mcp calls and keeps management verbs typed", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    const ok = typeCheckFabricCode(
      `
const repo = await mcp.github.get_repo({ owner: "octo", repo: "hello" });
const servers = await mcp.servers();
const one = servers[0]?.transport;
await mcp.call({ server: "github", tool: "get_repo", args: { owner: "o", repo: "r" } });
return { repo, one };
`,
      declarations,
    );
    expect(ok.errors).toEqual([]);
  });

  it("leaves unknown servers and tools as runtime-resolved calls", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, { dynamic });
    // Unknown server/tool names are property-miss diagnostics, suppressed by
    // design — they resolve or reject at dispatch exactly like the loose
    // declarations before this feature.
    const cold = typeCheckFabricCode(
      'const a = await mcp.some_new_server.tool({ anyShape: 1 }); const b = await mcp.github.brand_new_tool({}); return { a, b };',
      declarations,
    );
    expect(cold.errors).toEqual([]);
  });

  it("emits the sanitized identifier plus quoted raw alias for non-identifier names", () => {
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        {
          server: "my-server",
          tools: [
            {
              name: "do-thing",
              inputSchema: {
                type: "object",
                properties: { q: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    });
    expect(dynamic.mcp).toContain(`  my_server: FabricMcpServer_my_server;`);
    expect(dynamic.mcp).toContain(`  "my-server": FabricMcpServer_my_server;`);
    expect(dynamic.mcp).toContain("  do_thing(args?: { q?: string })");
    expect(dynamic.mcp).toContain('  "do-thing"(args?: { q?: string })');
    const declarations = guestTypeDeclarations(true, { dynamic });
    const viaSanitized = typeCheckFabricCode(
      'await mcp.my_server.do_thing({ q: "x" }); return "ok";',
      declarations,
    );
    expect(viaSanitized.errors).toEqual([]);
    const viaRaw = typeCheckFabricCode(
      'await mcp["my-server"]["do-thing"]({}); return "ok";',
      declarations,
    );
    expect(viaRaw.errors).toEqual([]);
    const badShape = typeCheckFabricCode(
      'await mcp.my_server.do_thing({ q: "x", junk: 1 }); return "never";',
      declarations,
    );
    expect(badShape.errors.length).toBeGreaterThan(0);
  });

  it("drops servers whose sanitized names collide, mirroring runtime ambiguity", () => {
    const tool = {
      name: "ping",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        { server: "a-b", tools: [tool] },
        { server: "a_b", tools: [tool] },
      ],
    });
    expect(dynamic.mcp).toBeDefined();
    expect(dynamic.mcp).not.toContain("FabricMcpServer_a_b {");
    expect(dynamic.mcp).toContain("2 server(s) untyped");
    expect(dynamic.mcp).not.toContain("  a_b: ");
  });

  it("mirrors the shared sanitizer for member paths", () => {
    expect(sanitizeMcpRefPart("my-server")).toBe("my_server");
    expect(sanitizeMcpRefPart("9tools")).toBe("_9tools");
    const dynamic = buildDynamicGuestDeclarations({
      mcpServers: [
        {
          server: "9tools",
          tools: [
            { name: "x", inputSchema: { type: "object", additionalProperties: true } },
          ],
        },
      ],
    });
    expect(dynamic.mcp).toContain("  _9tools: FabricMcpServer__9tools;");
  });

  it("falls back to marked unknown only when the root cannot fit", () => {
    const huge = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `property_${index}_with_a_very_long_name_to_burn_budget`,
          { type: "string" },
        ]),
      ),
    };
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [{ name: "big_tool", inputSchema: huge }],
    });
    expect(dynamic.extensions).toContain(
      "big_tool(args?: unknown /* truncated: type size limit",
    );
  });

  it("types extension tools with their captured parameters in full code mode", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "project_status",
          inputSchema: {
            type: "object",
            properties: { verbose: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      ],
    });
    expect(dynamic.extensions).toContain("interface FabricExtensionsApiDynamic {");
    expect(dynamic.extensions).toContain("verbose?: boolean");
    const declarations = guestTypeDeclarations(true, { dynamic });
    expect(declarations).toContain("declare const extensions: FabricExtensionsApiDynamic;");
    const bad = typeCheckFabricCode(
      "await extensions.project_status({ verbise: true }); return 'never';",
      declarations,
    );
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors.map((error) => error.message).join(" ")).toMatch(/verbise|known properties/);
    const good = typeCheckFabricCode(
      "const result = await extensions.project_status({ verbose: true }); return result.text.length;",
      declarations,
    );
    expect(good.errors).toEqual([]);
  });

  it("ignores the extensions replacement in orchestration-only mode", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "project_status",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    const declarations = guestTypeDeclarations(false, { dynamic });
    expect(declarations).not.toContain("FabricExtensionsApiDynamic");
    expect(declarations).not.toContain("declare const extensions:");
  });

  it("still applies the mcp replacement in orchestration-only mode", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(false, { dynamic });
    expect(declarations).toContain("} & FabricMcpManagement;");
    expect(declarations).not.toContain("declare const mcp: FabricMcpApi;");
  });

  it("keeps the loose surface when the mcp global is excluded", () => {
    const dynamic = buildDynamicGuestDeclarations({ mcpServers: [githubServer] });
    const declarations = guestTypeDeclarations(true, {
      excludeGlobals: ["mcp"],
      dynamic,
    });
    expect(declarations).not.toContain("FabricMcpServer_github");
    expect(declarations).not.toContain("declare const mcp:");
  });

  it("supports union, array, tuple, and const schema forms", () => {
    const dynamic = buildDynamicGuestDeclarations({
      extensionTools: [
        {
          name: "mixed",
          inputSchema: {
            type: "object",
            properties: {
              mode: { anyOf: [{ const: "fast" }, { const: "slow" }] },
              tags: { type: "array", items: { type: "string" } },
              pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
              maybe: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      ],
    });
    expect(dynamic.extensions).toContain('mode?: "fast" | "slow"');
    expect(dynamic.extensions).toContain("tags?: Array<string>");
    expect(dynamic.extensions).toContain("pair?: [string, number]");
    expect(dynamic.extensions).toContain("maybe?: string | null");
    const declarations = guestTypeDeclarations(true, { dynamic });
    const ok = typeCheckFabricCode(
      'await extensions.mixed({ mode: "fast", tags: ["a"], pair: ["x", 1], maybe: null }); return "ok";',
      declarations,
    );
    expect(ok.errors).toEqual([]);
  });

  it("leaves the static declarations untouched when no dynamic option is given", () => {
    expect(guestTypeDeclarations(true)).toBe(GUEST_TYPE_DECLARATIONS);
  });
});
