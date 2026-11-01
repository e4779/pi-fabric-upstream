import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";

// Pi 1.4 renders the system prompt from named sections and diffs them turn to
// turn. A handler that returns `systemPrompt` forces one opaque prompt instead:
// later handlers' section edits are ignored and the section diff is lost.
type Handler = (event: unknown, context: unknown) => unknown;

const skills = [
  { name: "release-risk", description: "Review launch plans.", filePath: "/skills/release-risk/SKILL.md", baseDir: "/skills/release-risk", disableModelInvocation: false },
];

const extension = (path: string, handlers: Map<string, Handler[]>) => ({
  path, resolvedPath: path, sourceInfo: {}, handlers,
  tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
});

const loadFabric = async (): Promise<Map<string, Handler[]>> => {
  vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
  vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue(process.cwd());
  vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(normalizeFabricConfig({}));
  vi.spyOn(CapturedToolCatalog.prototype, "list").mockReturnValue([]);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }),
    getActiveTools: vi.fn(() => ["fabric_exec"]), getAllTools: vi.fn(() => []),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(),
    setActiveTools: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn(), getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const { default: piFabric } = await import("../src/index.js");
  await piFabric(pi);
  // Only the prompt handlers matter here; Fabric's other hooks need a live session.
  return new Map([["before_agent_start", handlers.get("before_agent_start") ?? []]]);
};

// Runs Pi's own before_agent_start pipeline over the given extensions.
const startRun = async (extensions: ReturnType<typeof extension>[]) => {
  const runner = new ExtensionRunner(extensions as never, createExtensionRuntime(), process.cwd(), {} as never, {} as never);
  const errors: string[] = [];
  runner.onError((error) => { errors.push(error.error); });
  (runner as unknown as { getModel: () => undefined }).getModel = () => undefined;
  (runner as unknown as { getSignalFn: () => undefined }).getSignalFn = () => undefined;
  let rendered = "";
  const observer = extension("observer", new Map([["before_agent_start", [(event: unknown) => {
    rendered = (event as { systemPrompt: string }).systemPrompt;
  }]]]));
  const result = await runner.emitBeforeAgentStart(
    { messageType: "user", prompt: "inspect" },
    { cwd: "/work", selectedTools: ["fabric_exec"], skills: skills as never },
  );
  // Render the final prompt the way Pi's later handlers and the session see it.
  await new ExtensionRunner([observer] as never, createExtensionRuntime(), process.cwd(), {} as never, {} as never)
    .emitBeforeAgentStart({ messageType: "user", prompt: "inspect" }, result.systemPromptOptions);
  return { options: result.systemPromptOptions, rendered, errors };
};

describe("Fabric guidance as a Pi prompt section", () => {
  beforeAll(() => import("../src/index.js"), 60_000);
  afterEach(() => { vi.restoreAllMocks(); });

  it("adds a fabric section and keeps a later extension's section instead of forcing the prompt", async () => {
    const fabric = extension("pi-fabric", await loadFabric());
    const later = extension("later", new Map([["before_agent_start", [(event: unknown) => {
      (event as { systemPromptOptions: { sections: Record<string, string> } }).systemPromptOptions.sections.later_notes = "Later extension notes.";
    }]]]));
    const { options, rendered, errors } = await startRun([fabric, later]);
    expect(errors).toEqual([]);
    expect(options.forceSystemPrompt).toBeUndefined();
    expect(options.sections.fabric).toContain("fabric_exec");
    // Full code mode names Fabric's nested reader in the skill catalog.
    expect(options.sections.skills).toContain("Use `pi.read` inside `fabric_exec`");
    expect(options.sections.skills).toContain("<name>release-risk</name>");
    expect(rendered).toContain("<later_notes>\nLater extension notes.\n</later_notes>");
    expect(rendered).toContain(`<fabric>\n${options.sections.fabric}\n</fabric>`);
    expect(rendered.split("<available_skills>").length - 1).toBe(1);
  });

  it("produces the same sections on a second run with the same inputs", async () => {
    const fabric = extension("pi-fabric", await loadFabric());
    const first = await startRun([fabric]);
    const second = await startRun([fabric]);
    expect(second.options.sections).toEqual(first.options.sections);
  });

  it("appends to a prompt an earlier handler forced, since Pi then ignores sections", async () => {
    const earlier = extension("earlier", new Map([["before_agent_start", [() => ({ systemPrompt: "Forced base prompt." })]]]));
    const fabric = extension("pi-fabric", await loadFabric());
    const { options, rendered, errors } = await startRun([earlier, fabric]);
    expect(errors).toEqual([]);
    expect(options.sections.fabric).toBeUndefined();
    expect(rendered.startsWith("Forced base prompt.")).toBe(true);
    expect(rendered).toContain("fabric_exec");
  });
});
