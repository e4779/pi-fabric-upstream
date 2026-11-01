import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { parseDurableWorkerOptions } from "../src/durable/worker-options.js";
import { FabricState } from "../src/fabric-state.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { agentServiceDescriptors } from "../src/agents/service-schema.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

// The skills option goes through the real request path: AgentsProvider.invoke, a real
// AgentManager and the fake worker, which echoes the launch arguments it received.

type Echo = AgentRunResult & { systemPrompt?: string; skills?: string[] };
type ProviderArgs = ConstructorParameters<typeof AgentsProvider>;

const roots: string[] = [];
const managers: AgentManager[] = [];

const temp = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

/** Writes a skill the way Pi lays one out on disk and returns its SKILL.md path. */
const writeSkill = (root: string, name: string, body: string): string => {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  return file;
};

const setup = () => {
  const root = temp("fabric-child-skills-");
  const projectRoot = path.join(root, "project");
  const agentsDir = path.join(root, "pi-home", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "pi-home"));
  const writing = writeSkill(root, "writing", "WRITING BODY: short sentences.");
  const review = writeSkill(root, "review", "REVIEW BODY: report defects only.");
  const manager = new AgentManager(projectRoot, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, "runs"),
    projectRoot,
    fullCodeMode: false,
  });
  managers.push(manager);
  const spawn = vi.spyOn(manager, "spawn");
  const provider = new AgentsProvider(
    manager, {} as ProviderArgs[1], {} as ProviderArgs[2], {} as ProviderArgs[3],
    { scheduleRefresh() {}, async refresh() {} } as unknown as ProviderArgs[4],
    undefined, {} as ProviderArgs[6], () => false, undefined, false,
  );
  // The shape Pi's getCommands() returns: skills sit beside other commands.
  // A prompt template and an extension command are not skills, even with a skill's name.
  (provider as unknown as { sessionCommands: () => unknown[] }).sessionCommands = () => [
    { name: "fabric", source: "extension", sourceInfo: { path: "/ext/index.js", source: "local", scope: "user", origin: "top-level" } },
    { name: "lint", source: "prompt", sourceInfo: { path: path.join(root, "lint.md"), source: "local", scope: "user", origin: "top-level" } },
    { name: "skill:writing", source: "skill", sourceInfo: { path: writing, source: "local", scope: "user", origin: "top-level" } },
    { name: "skill:review", source: "skill", sourceInfo: { path: review, source: "local", scope: "user", origin: "top-level" } },
  ];
  const notices: string[] = [];
  const context = {
    cwd: projectRoot, signal: undefined, parentToolCallId: "outer", nestedToolCallId: "nested",
    extensionContext: { modelRegistry: { getAvailable: () => [], find: () => undefined }, isProjectTrusted: () => true },
    update: (message: string) => { notices.push(message); },
    activity() {},
  } as unknown as FabricInvocationContext;
  return { provider, manager, spawn, context, notices, agentsDir, writing, review };
};

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_DEPTH", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET_FILE", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET", undefined);
  vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
  vi.stubEnv("PI_FABRIC_CHILD_SKILLS", undefined);
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agents.run skills option", () => {
  it("preloads a listed skill in full and keeps the session's other skills", async () => {
    const { provider, context, writing, review } = setup();
    const result = await provider.invoke("run", { task: "t", skills: ["writing"] }, context) as Echo;
    expect(result.status).toBe("completed");
    expect(result.systemPrompt).toContain(`<skill name="writing" location="${writing}">`);
    expect(result.systemPrompt).toContain("WRITING BODY: short sentences.");
    expect(result.systemPrompt).not.toContain("name: writing");
    expect(result.systemPrompt).not.toContain("REVIEW BODY");
    expect(result.skills).toEqual([writing, review]);
  });

  it("gives a child no skills at all for skills: false", async () => {
    const { provider, context } = setup();
    const result = await provider.invoke("run", { task: "t", skills: false }, context) as Echo;
    expect(result.status).toBe("completed");
    expect(result.skills).toEqual([]);
    expect(result.systemPrompt).toBeUndefined();
  });

  it("drops the session's other skills with inherit: false", async () => {
    const { provider, context } = setup();
    const result = await provider.invoke("run", { task: "t", skills: { preload: ["review"], inherit: false } }, context) as Echo;
    expect(result.skills).toEqual([]);
    expect(result.systemPrompt).toContain("REVIEW BODY: report defects only.");
  });

  it("leaves the child's own discovery alone when skills is omitted", async () => {
    const { provider, context } = setup();
    const result = await provider.invoke("run", { task: "t" }, context) as Echo;
    expect(result.skills).toBeUndefined();
  });

  it("places a call's systemPrompt ahead of the preloaded skills", async () => {
    const { provider, context } = setup();
    const result = await provider.invoke("run", { task: "t", systemPrompt: "CALLER TEXT", skills: ["writing"] }, context) as Echo;
    expect(result.systemPrompt!.indexOf("CALLER TEXT")).toBe(0);
    expect(result.systemPrompt!.indexOf("WRITING BODY")).toBeGreaterThan(0);
  });

  it("does not treat a prompt template as a skill", async () => {
    const { provider, context } = setup();
    await expect(provider.invoke("run", { task: "t", skills: ["lint"] }, context)).rejects.toThrow('Unknown skill "lint"');
  });

  it("fails an unknown skill before any child starts and lists the session's skills", async () => {
    const { provider, context, spawn } = setup();
    await expect(provider.invoke("run", { task: "t", skills: ["writng"] }, context))
      .rejects.toThrow('Unknown skill "writng". Did you mean "writing"? Available skills: review, writing.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a path instead of a skill name", async () => {
    const { provider, context, spawn, writing } = setup();
    await expect(provider.invoke("run", { task: "t", skills: [writing] }, context)).rejects.toThrow("is a path");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails a listed skill whose file cannot be read", async () => {
    const { provider, context, spawn, writing } = setup();
    fs.rmSync(writing);
    await expect(provider.invoke("run", { task: "t", skills: ["writing"] }, context)).rejects.toThrow('Cannot read skill "writing"');
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["claude", "veda"])("refuses skills for the %s runner before launch", async (runner) => {
    const { provider, context, manager } = setup();
    const launch = vi.spyOn(manager as unknown as { runDirectory(id: string): unknown }, "runDirectory");
    await expect(provider.invoke("run", { task: "t", runner, skills: ["writing"] }, context))
      .rejects.toThrow(`The skills option is supported only by the Pi runners, not ${runner}`);
    await expect(provider.invoke("run", { task: "t", runner, skills: false }, context)).rejects.toThrow("only by the Pi runners");
    expect(manager.list()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses skills on a durable spawn instead of dropping them", async () => {
    const { provider, context, spawn } = setup();
    await expect(provider.invoke("spawn", { task: "t", residency: "durable", skills: ["writing"] }, context))
      .rejects.toThrow("durable agents.spawn does not accept skills");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("applies skills to a spawned child too", async () => {
    const { provider, context, manager } = setup();
    const handle = await provider.invoke("spawn", { task: "t", skills: ["review"] }, context) as { id: string };
    const done = await manager.wait(handle.id) as Echo;
    expect(done.systemPrompt).toContain("REVIEW BODY");
  });
});

describe("agent file skills", () => {
  const file = (lines: string[]) => ["---", "name: writer", "description: Writes", ...lines, "---", "Write it."].join("\n");

  it("preloads the file's skills and honors context.skills: false", async () => {
    const { provider, context, agentsDir, notices } = setup();
    fs.writeFileSync(path.join(agentsDir, "writer.md"), file(["skills:", "  - writing", "context:", "  skills: false", "  project: false"]));
    const result = await provider.invoke("run", { agent: "writer", task: "t" }, context) as Echo;
    expect(result.status).toBe("completed");
    expect(result.systemPrompt).toMatch(/^Write it\.\n\n/);
    expect(result.systemPrompt).toContain("WRITING BODY");
    expect(result.skills).toEqual([]);
    // Other context keys keep the warn-and-ignore behaviour.
    expect(notices.join("\n")).toContain('ignored field "context.project"');
    expect(notices.join("\n")).not.toContain('ignored field "skills"');
  });

  it("skips a missing optional skill with a warning and still fails a missing required one", async () => {
    const { provider, context, agentsDir, notices, spawn } = setup();
    fs.writeFileSync(path.join(agentsDir, "writer.md"), file([
      "skills:", "  - name: writing", "  - name: nowhere", "    required: false", "    source: npm:somewhere",
    ]));
    const result = await provider.invoke("run", { agent: "writer", task: "t" }, context) as Echo;
    expect(result.systemPrompt).toContain("WRITING BODY");
    expect(notices.join("\n")).toContain('Skill "nowhere" is not available in this session; skipped because it is optional.');
    expect(notices.join("\n")).toContain("source is not supported");

    fs.writeFileSync(path.join(agentsDir, "writer.md"), file(["skills: [writing, nowhere]"]));
    spawn.mockClear();
    await expect(provider.invoke("run", { agent: "writer", task: "t" }, context)).rejects.toThrow('Unknown skill "nowhere"');
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lets the call's skills win over the file's", async () => {
    const { provider, context, agentsDir } = setup();
    fs.writeFileSync(path.join(agentsDir, "writer.md"), file(["skills: [writing]"]));
    const result = await provider.invoke("run", { agent: "writer", task: "t", skills: false }, context) as Echo;
    expect(result.skills).toEqual([]);
    expect(result.systemPrompt).toBe("Write it.");
  });

  it("refuses a skill path and a malformed context.skills in a file", async () => {
    const { provider, context, agentsDir } = setup();
    fs.writeFileSync(path.join(agentsDir, "writer.md"), file(["skills: [../skills/writing]"]));
    await expect(provider.invoke("run", { agent: "writer", task: "t" }, context)).rejects.toThrow(/writer\.md:4: skills entry .* is a path/);
    fs.writeFileSync(path.join(agentsDir, "writer.md"), file(["context:", "  skills: maybe"]));
    await expect(provider.invoke("run", { agent: "writer", task: "t" }, context)).rejects.toThrow("context.skills must be true or false");
  });
});

describe("child skills launch", () => {
  it("starts Pi with --no-skills, one --skill per file, and the preload in the system prompt", { timeout: 15_000 }, async () => {
    const root = temp("fabric-child-skills-launch-");
    const probe = path.resolve("tests/fixtures/fake-pi-launch-probe.mjs");
    fs.chmodSync(probe, 0o755);
    // An ambient flag from this process's own parent must not reach a child without the option.
    vi.stubEnv("PI_FABRIC_CHILD_SKILLS", "selected");
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"), piBinary: probe, runRoot: root, fullCodeMode: false,
    });
    managers.push(manager);
    const selected = await manager.run({
      task: "REPORT_LAUNCH_SURFACE", transport: "process", tools: ["read"], timeoutMs: 5_000,
      childSkills: { catalog: ["/a/SKILL.md", "/b/SKILL.md"], preload: "PRELOADED" },
    });
    expect(selected.status, selected.error).toBe("completed");
    expect(JSON.parse(selected.text)).toMatchObject({
      noSkills: true, skillPaths: ["/a/SKILL.md", "/b/SKILL.md"], childSkillsEnv: "selected",
      appendSystemPrompt: [expect.stringContaining("PRELOADED")],
    });
    const none = await manager.run({
      task: "REPORT_LAUNCH_SURFACE", transport: "process", tools: ["read"], timeoutMs: 5_000,
      childSkills: { catalog: [] },
    });
    expect(JSON.parse(none.text)).toMatchObject({ noSkills: true, skillPaths: [], childSkillsEnv: "selected" });
    const ambient = await manager.run({ task: "REPORT_LAUNCH_SURFACE", transport: "process", tools: ["read"], timeoutMs: 5_000 });
    const surface = JSON.parse(ambient.text);
    expect(surface).toMatchObject({ noSkills: false, skillPaths: [] });
    expect(surface.childSkillsEnv).toBeUndefined();
  });

  it("carries --no-skills and --skill into the pi-durable worker", () => {
    const base = ["--durable-directory", "state", "--durable-run-id", "run"];
    expect(parseDurableWorkerOptions(base)).toMatchObject({ noSkills: false, skills: [] });
    const cwd = path.resolve("cwd");
    expect(parseDurableWorkerOptions([...base, "--no-skills", "--skill", "/a/SKILL.md", "--skill", "b/SKILL.md"], cwd))
      .toMatchObject({ noSkills: true, skills: [path.resolve(cwd, "/a/SKILL.md"), path.resolve(cwd, "b/SKILL.md")] });
  });

  it("adds no Fabric skills in a child whose parent chose its skills", async () => {
    const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) }, getActiveTools: vi.fn(() => ["fabric_exec"]), getAllTools: vi.fn(() => []),
      on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(), setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const { default: piFabric } = await import("../src/index.js");
    await piFabric(pi);
    vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(normalizeFabricConfig({}));
    const discover = handlers.get("resources_discover")![0]!;
    expect(((await discover({}, {})) as { skillPaths: string[] }).skillPaths).toHaveLength(1);
    vi.stubEnv("PI_FABRIC_CHILD_SKILLS", "selected");
    expect(await discover({}, {})).toEqual({ skillPaths: [] });
  });
});

describe("skills option contracts", () => {
  const schema = (name: string) => AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === name)!.inputSchema;

  it.each(["run", "spawn"])("accepts false, a name list or { preload, inherit } on agents.%s", (name) => {
    for (const skills of [false, [], ["writing"], { preload: ["writing"], inherit: false }, { inherit: true }]) {
      expect(Value.Check(schema(name), { task: "t", skills }), JSON.stringify(skills)).toBe(true);
    }
    for (const skills of [true, "writing", [""], ["a/b"], ["a\\b"], [1], { preload: "writing" }, { inherit: "no" }, { other: 1 }]) {
      expect(Value.Check(schema(name), { task: "t", skills }), JSON.stringify(skills)).toBe(false);
    }
  });

  it("keeps skills out of the hosted execution port", () => {
    for (const descriptor of agentServiceDescriptors({}).filter((entry) => entry.name === "run" || entry.name === "spawn")) {
      expect((descriptor.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty("skills");
    }
  });

  it("types skills for guest programs", () => {
    const check = (code: string) => typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS, true).errors;
    expect(check('await agents.run({ task: "t", skills: ["writing"] }); await agents.spawn({ task: "t", skills: false }); await agents.run({ task: "t", skills: { preload: ["a"], inherit: false } }); return 1;')).toEqual([]);
    expect(check('await agents.run({ task: "t", skills: true }); return 1;').length).toBeGreaterThan(0);
  });
});
