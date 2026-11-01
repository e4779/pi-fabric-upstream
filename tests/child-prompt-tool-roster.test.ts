import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";

// A child's system prompt must name only the tools its allowlist lets it
// call. Otherwise the child spends turns on "Unknown Fabric action" errors.
const capturedEntry = (name: string, source: string, definition: Record<string, unknown> = {}) => ({
  name,
  definition: { name, description: `${name} tool`, ...definition },
  sourceInfo: { source: `npm:${source}`, path: `/nonexistent/${source}/index.ts` },
});

const entries = [
  capturedEntry("ask", "pi-question"),
  capturedEntry("web_search", "pi-web-access"),
];
const overrides = new Map([
  ["read", capturedEntry("read", "pi-hashline", { promptSnippet: "structure-aware reads" })],
  ["edit", capturedEntry("edit", "pi-hashline", { promptSnippet: "anchored line edits" })],
]);

const systemPrompt = async (): Promise<string> => {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => ["fabric_exec"]),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: (event: unknown, context: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const { default: piFabric } = await import("../src/index.js");
  await piFabric(pi);
  for (const handler of handlers.get("before_agent_start") ?? []) {
    const result = await handler({ systemPrompt: "base system", prompt: "go", systemPromptOptions: { skills: [] } }, {});
    if (result && typeof result === "object" && "systemPrompt" in result) {
      return (result as { systemPrompt: string }).systemPrompt;
    }
  }
  throw new Error("No before_agent_start handler returned a system prompt");
};

describe("child prompt tool roster", () => {
  // The first import of the extension compiles its whole graph, which can
  // outlast the default test timeout on a loaded runner. Pay it once here.
  beforeAll(() => import("../src/index.js"), 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const mockCatalog = (): void => {
    vi.spyOn(CapturedToolCatalog.prototype, "list").mockReturnValue(entries as never);
    vi.spyOn(CapturedToolCatalog.prototype, "get").mockImplementation((name) => overrides.get(name) as never);
  };

  it("lists every captured tool and override for a session without an allowlist", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    mockCatalog();
    const prompt = await systemPrompt();
    expect(prompt).toContain("- pi-question: ask");
    expect(prompt).toContain("- pi-web-access: web_search");
    expect(prompt).toContain("structure-aware reads");
    expect(prompt).toContain("anchored line edits");
  });

  it("names only the tools a child's allowlist permits", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", JSON.stringify(["read", "ask"]));
    mockCatalog();
    const prompt = await systemPrompt();
    expect(prompt).toContain("- pi-question: ask");
    expect(prompt).not.toContain("web_search");
    expect(prompt).toContain("structure-aware reads");
    expect(prompt).not.toContain("anchored line edits");
  });

  it("honours * patterns in the allowlist for the roster and the overrides", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", JSON.stringify(["web_*", "r*"]));
    mockCatalog();
    const prompt = await systemPrompt();
    expect(prompt).toContain("- pi-web-access: web_search");
    expect(prompt).not.toContain("pi-question");
    expect(prompt).toContain("structure-aware reads");
    expect(prompt).not.toContain("anchored line edits");
  });

  it("names no extension tool when the inherited allowlist is malformed", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", "not json");
    mockCatalog();
    const prompt = await systemPrompt();
    expect(prompt).not.toContain("Registered extension tools are callable");
    expect(prompt).not.toContain("web_search");
    expect(prompt).not.toContain("structure-aware reads");
  });

  it("drops the roster when a child may call no extension tool", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", JSON.stringify(["read"]));
    mockCatalog();
    const prompt = await systemPrompt();
    expect(prompt).not.toContain("Registered extension tools are callable");
    expect(prompt).not.toContain("pi-question");
  });
});
