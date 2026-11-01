import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { agentServiceDescriptors } from "../src/agents/service-schema.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

// Named agent files go through the real request path: AgentsProvider.invoke, a real AgentManager
// and the fake worker, which echoes the launch arguments it received into the run record.

type Echo = AgentRunResult & { systemPrompt?: string; tools?: string[] };
type ProviderArgs = ConstructorParameters<typeof AgentsProvider>;

const roots: string[] = [];
const managers: AgentManager[] = [];

const visible = [
  { provider: "anthropic", id: "executor" },
  { provider: "anthropic", id: "frontier" },
];

interface Setup {
  provider: AgentsProvider;
  manager: AgentManager;
  userDir: string;
  projectDir: string;
  notices: string[];
  context: FabricInvocationContext;
  spawn: ReturnType<typeof vi.spyOn>;
}

const setup = (options: { trusted?: boolean } = {}): Setup => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-agent-files-"));
  roots.push(root);
  const userDir = path.join(root, "pi-home", "agents");
  const projectRoot = path.join(root, "project");
  const projectDir = path.join(projectRoot, ".pi", "agents");
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "pi-home"));
  const manager = new AgentManager(projectRoot, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, "runs"),
    projectRoot,
    // Without full code mode the child's tool list is exactly what the file asked for.
    fullCodeMode: false,
  });
  managers.push(manager);
  const spawn = vi.spyOn(manager, "spawn");
  const provider = new AgentsProvider(
    manager, {} as ProviderArgs[1], {} as ProviderArgs[2], {} as ProviderArgs[3],
    { scheduleRefresh() {}, async refresh() {} } as unknown as ProviderArgs[4],
    undefined, {} as ProviderArgs[6], () => false, undefined, false,
    () => ({ aliases: { cheap: { targets: ["anthropic/executor"], thinking: "low" } } }),
  );
  // The session's one skill, listed the way Pi's getCommands() lists it.
  const skillDir = path.join(root, "skills", "writing");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, "---\nname: writing\ndescription: Writing\n---\nWRITING SKILL BODY\n");
  provider.sessionCommands = () => [
    { name: "skill:writing", source: "skill", sourceInfo: { path: skillFile, source: "local", scope: "user", origin: "top-level" } },
  ];
  const notices: string[] = [];
  const context = {
    cwd: projectRoot, signal: undefined, parentToolCallId: "outer", nestedToolCallId: "nested",
    extensionContext: {
      modelRegistry: { getAvailable: () => visible, find: () => undefined },
      isProjectTrusted: () => options.trusted !== false,
    },
    update: (message: string) => { notices.push(message); },
    activity() {},
  } as unknown as FabricInvocationContext;
  return { provider, manager, userDir, projectDir, notices, context, spawn };
};

const write = (dir: string, file: string, text: string): string => {
  const target = path.join(dir, file);
  fs.writeFileSync(target, text);
  return target;
};

// Own fixture, shaped like a Claude Code subagent file.
const REVIEWER = [
  "---",
  "name: reviewer",
  "description: Reviews a diff for defects",
  "tools: Read, Grep, Glob, LS, Bash, MultiEdit, WebFetch",
  "model: inherit",
  "color: blue",
  "---",
  "",
  "You review diffs. Report defects only.",
  "",
].join("\n");

// Own fixture, shaped like a pi-agents profile.
const PLANNER = [
  "---",
  "name: planner",
  "description: Plans the work",
  "model: anthropic/frontier",
  "thinking: high",
  "skills:",
  "  - writing",
  "tools: read, grep",
  "delegate: false",
  "---",
  "Plan before you edit.",
].join("\n");

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_DEPTH", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET_FILE", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET", undefined);
  // A Fabric child filters tools through its parent's allowlist; the test must not inherit one.
  vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("named agent files", () => {
  it("runs a Claude Code shaped file with its body as instructions and mapped tools", async () => {
    const { provider, userDir, context, notices } = setup();
    write(userDir, "reviewer.md", REVIEWER);
    const result = await provider.invoke("run", { agent: "reviewer", task: "look at it" }, context) as Echo;
    expect(result.status).toBe("completed");
    expect(result.systemPrompt).toBe("You review diffs. Report defects only.");
    expect(result.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "WebFetch"]);
    expect(result.name).toBe("reviewer");
    // model: inherit leaves the model unset; color is ignored with a warning, not an error.
    expect(result.model).toBeUndefined();
    expect(notices.join("\n")).toContain("ignored field \"color\"");
  });

  it("loads a pi-agents shaped file; its skills are preloaded and delegate is a warning", async () => {
    const { provider, userDir, context, notices } = setup();
    write(userDir, "planner.md", PLANNER);
    const result = await provider.invoke("run", { agent: "planner", task: "plan" }, context) as Echo;
    expect(result).toMatchObject({ status: "completed", model: "anthropic/frontier", thinking: "high", tools: ["read", "grep"] });
    expect(result.systemPrompt).toMatch(/^Plan before you edit\.\n\n/);
    expect(result.systemPrompt).toContain("WRITING SKILL BODY");
    const [entry] = await provider.invoke("definitions", {}, context) as Array<{ warnings: string[] }>;
    expect(entry!.warnings).toEqual([expect.stringContaining("\"delegate\"")]);
    expect(notices.join("\n")).toContain("delegate");
    expect(notices.join("\n")).not.toContain("\"skills\"");
  });

  it("starts a spawned agent from a file and reports the handle", async () => {
    const { provider, userDir, context, manager } = setup();
    write(userDir, "planner.md", PLANNER);
    const handle = await provider.invoke("spawn", { agent: "planner", task: "plan" }, context) as { id: string; model?: string };
    expect(handle.model).toBe("anthropic/frontier");
    const done = await manager.wait(handle.id) as Echo;
    expect(done.systemPrompt).toMatch(/^Plan before you edit\.\n\n/);
    expect(done.systemPrompt).toContain("<skill name=\"writing\"");
  });

  it("lets a project file shadow a user file and reports the shadowed path", async () => {
    const { provider, userDir, projectDir, context } = setup();
    const user = write(userDir, "reviewer.md", REVIEWER);
    const project = write(projectDir, "reviewer.md", REVIEWER.replace("Report defects only.", "Project rules apply."));
    const result = await provider.invoke("run", { agent: "reviewer", task: "t" }, context) as Echo;
    expect(result.systemPrompt).toBe("You review diffs. Project rules apply.");
    expect(await provider.invoke("definitions", {}, context)).toEqual([
      expect.objectContaining({ name: "reviewer", scope: "project", path: project, shadows: user, description: "Reviews a diff for defects" }),
    ]);
  });

  it("does not read project files for an untrusted project and says so", async () => {
    const { provider, userDir, projectDir, context, notices } = setup({ trusted: false });
    write(userDir, "reviewer.md", REVIEWER);
    write(projectDir, "reviewer.md", REVIEWER.replace("Report defects only.", "Project rules apply."));
    const result = await provider.invoke("run", { agent: "reviewer", task: "t" }, context) as Echo;
    expect(result.systemPrompt).toBe("You review diffs. Report defects only.");
    await provider.invoke("definitions", {}, context);
    expect(notices.join("\n")).toContain("not trusted");
  });

  it("lets every field passed on the call win over the file", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "planner.md", PLANNER);
    const result = await provider.invoke("run", {
      agent: "planner", task: "plan", model: "anthropic/executor", thinking: "low", tools: ["bash"], systemPrompt: "Call prompt.", name: "mine",
    }, context) as Echo;
    expect(result).toMatchObject({ model: "anthropic/executor", thinking: "low", tools: ["bash"], name: "mine" });
    // The call's prompt replaces the file body; the file's skills still apply because the call names none.
    expect(result.systemPrompt).toMatch(/^Call prompt\.\n\n/);
    expect(result.systemPrompt).not.toContain("Plan before you edit.");
    // A field the call leaves out still comes from the file.
    const partial = await provider.invoke("run", { agent: "planner", task: "plan", tools: [] }, context) as Echo;
    expect(partial).toMatchObject({ model: "anthropic/frontier", thinking: "high", tools: [] });
    expect(partial.systemPrompt).toMatch(/^Plan before you edit\./);
  });

  it("sends a model from the file through alias resolution, with the alias thinking level", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "cheap.md", "---\nname: cheap\nmodel: cheap\n---\nBe brief.");
    const result = await provider.invoke("run", { agent: "cheap", task: "t" }, context) as Echo;
    expect(result).toMatchObject({ model: "anthropic/executor", thinking: "low" });
  });

  it("applies runtimes.fabric over the shared fields and accepts effort as thinking", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "tuned.md", [
      "---", "name: tuned", "effort: medium", "model: anthropic/frontier", "runtimes:", "  fabric:", "    runner: pi", "    timeoutMs: 120000",
      "    model: anthropic/executor", "---", "Tuned.",
    ].join("\n"));
    const result = await provider.invoke("run", { agent: "tuned", task: "t" }, context) as Echo;
    expect(result).toMatchObject({ model: "anthropic/executor", thinking: "medium", runner: "pi" });
  });

  it("fails an unknown name before any child starts and lists the names that exist", async () => {
    const { provider, userDir, context, spawn } = setup();
    write(userDir, "reviewer.md", REVIEWER);
    write(userDir, "planner.md", PLANNER);
    for (const action of ["run", "spawn"]) {
      const failure = provider.invoke(action, { agent: "reviewr", task: "t" }, context);
      await expect(failure).rejects.toThrow(/Unknown agent "reviewr"\. Did you mean "reviewer"\? Available agents: planner, reviewer\./);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses thinking and effort together, naming the file and line", async () => {
    const { provider, userDir, context, spawn } = setup();
    const file = write(userDir, "both.md", "---\nname: both\nthinking: low\neffort: high\n---\nBody");
    await expect(provider.invoke("run", { agent: "both", task: "t" }, context)).rejects.toThrow(new RegExp(file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") + ":4: thinking and effort"));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses an unknown key in runtimes.fabric and an unknown thinking level", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "bad-key.md", "---\nname: bad-key\nruntimes:\n  fabric:\n    sandbox: true\n---\nBody");
    write(userDir, "bad-level.md", "---\nname: bad-level\nthinking: ultra\n---\nBody");
    await expect(provider.invoke("run", { agent: "bad-key", task: "t" }, context)).rejects.toThrow(/bad-key\.md:5: unknown key "sandbox" in runtimes\.fabric/);
    await expect(provider.invoke("run", { agent: "bad-level", task: "t" }, context)).rejects.toThrow(/bad-level\.md:3: thinking "ultra" is not a Fabric thinking level/);
  });

  it("names the file and line of frontmatter it cannot read", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "dup.md", "---\nname: dup\nmodel: a\nmodel: b\n---\nBody");
    write(userDir, "open.md", "---\nname: open\nBody without a closing line");
    write(userDir, "plain.md", "No frontmatter here");
    await expect(provider.invoke("run", { agent: "dup", task: "t" }, context)).rejects.toThrow(/dup\.md:4: /);
    await expect(provider.invoke("run", { agent: "open", task: "t" }, context)).rejects.toThrow(/open\.md:1: the frontmatter block opened on line 1 is never closed/);
    await expect(provider.invoke("run", { agent: "plain", task: "t" }, context)).rejects.toThrow(/plain\.md:1: the file must start with a YAML frontmatter block/);
    // The listing keeps working and shows the unreadable file with its error.
    const listing = await provider.invoke("definitions", {}, context) as Array<{ name: string; error?: string }>;
    expect(listing.find((entry) => entry.name === "dup")?.error).toMatch(/dup\.md:4: /);
  });

  it("does not let a broken project file fall back to a user file of the same name", async () => {
    const { provider, userDir, projectDir, context } = setup();
    write(userDir, "reviewer.md", REVIEWER);
    write(projectDir, "reviewer.md", "---\nname: reviewer\nthinking: ultra\n---\nBody");
    await expect(provider.invoke("run", { agent: "reviewer", task: "t" }, context)).rejects.toThrow(/thinking "ultra"/);
  });

  it("reads only visible Markdown files directly inside the folders", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "reviewer.md", REVIEWER);
    write(userDir, ".hidden.md", PLANNER);
    write(userDir, "notes.txt", PLANNER);
    fs.mkdirSync(path.join(userDir, "nested"));
    write(path.join(userDir, "nested"), "planner.md", PLANNER);
    const names = (await provider.invoke("definitions", {}, context) as Array<{ name: string }>).map((entry) => entry.name);
    expect(names).toEqual(["reviewer"]);
  });

  it("refuses a file body on a durable spawn instead of dropping it", async () => {
    const { provider, userDir, context, spawn } = setup();
    write(userDir, "reviewer.md", REVIEWER);
    await expect(provider.invoke("spawn", { agent: "reviewer", task: "t", residency: "durable" }, context)).rejects.toThrow(/durable agents\.spawn does not accept/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does nothing for a call without agent", async () => {
    const { provider, userDir, context } = setup();
    write(userDir, "broken.md", "not frontmatter");
    const result = await provider.invoke("run", { task: "plain" }, context) as Echo;
    expect(result.status).toBe("completed");
    expect(result.systemPrompt).toBeUndefined();
  });
});

describe("named agent file contracts", () => {
  const find = (name: string) => AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === name)!;

  it("declares agent on run and spawn and lists definitions as a read action", () => {
    for (const name of ["run", "spawn"]) {
      const properties = (find(name).inputSchema as { properties: Record<string, unknown> }).properties;
      expect(properties).toHaveProperty("agent");
    }
    expect(find("definitions").risk).toBe("read");
  });

  it("keeps file loading out of the hosted execution port", () => {
    const hosted = agentServiceDescriptors({ steer: true, topology: true });
    expect(hosted.map((descriptor) => descriptor.name)).not.toContain("definitions");
    for (const descriptor of hosted.filter((entry) => entry.name === "run" || entry.name === "spawn")) {
      expect((descriptor.inputSchema as { properties: Record<string, unknown> }).properties).not.toHaveProperty("agent");
    }
  });

  it("types agent and definitions for guest programs", () => {
    const ok = typeCheckFabricCode(
      'const list = await agents.definitions(); const r = await agents.run({ agent: list[0]!.name, task: "t" }); return [list[0]!.scope, list[0]!.shadows, r.status];',
      GUEST_TYPE_DECLARATIONS, true,
    );
    expect(ok.errors).toEqual([]);
    expect(typeCheckFabricCode('await agents.run({ agent: 7, task: "t" }); return 1;', GUEST_TYPE_DECLARATIONS, true).errors.length).toBeGreaterThan(0);
  });
});
