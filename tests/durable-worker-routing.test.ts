import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeForkSession, writeHandoffSession } from "../src/agents/handoff.js";
import { AgentManager } from "../src/agents/manager.js";
import { BUILT_IN_RUNNER_IDS, requireAgentRunner, registerAgentRunner } from "../src/agents/runner-registry.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { parseWorkerOptions } from "../src/worker/options.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-routing-"));
  roots.push(root);
  return root;
};
const argv = (root: string, overrides: Record<string, string> = {}) => [
  process.execPath, "worker.js",
  ...Object.entries({
    id: "durable-probe", runner: "pi-durable", name: "routing probe",
    "task-file": path.join(root, "task.txt"), "status-file": path.join(root, "status.json"),
    "lifecycle-file": path.join(root, "lifecycle.jsonl"), "log-file": path.join(root, "events.jsonl"),
    cwd: root, "pi-binary": path.resolve("tests/fixtures/fake-pi-model.mjs"),
    "claude-binary": "unused", "veda-binary": "unused", "veda-backend": "unused", "veda-persona": "unused",
    "timeout-ms": "5000", depth: "1", "full-code-mode": "true", extensions: "true",
    tools: "[]", "granted-risks": "[]", transport: "process", model: "openai-codex/gpt-5.6-sol", thinking: "high",
    ...overrides,
  }).flatMap(([key, value]) => [`--${key}`, value]),
];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable Pi worker routing", () => {
  it("is a protected built-in process runner with exactly Pi capabilities", async () => {
    const durable = requireAgentRunner("pi-durable");
    expect(BUILT_IN_RUNNER_IDS.has(durable.id)).toBe(true);
    expect(durable.capabilities).toEqual(requireAgentRunner("pi").capabilities);
    expect(durable.kind).toBe("worker");
    expect(() => registerAgentRunner(durable)).toThrow("Cannot replace built-in");
    if (durable.kind !== "worker") throw new Error("expected worker");
    const fabricWorker = { workerPath: "/fabric/worker.js", workerArguments: ["--runner", "pi-durable"] };
    const launch = await durable.launch({
      fabricWorker, id: "probe", name: "probe", task: "probe", cwd: "/work", runDirectory: "/run",
      residency: "session", deadlineAt: Date.now() + 5000, depth: 1, tools: [],
      lineage: { version: 1, rootSessionId: "root", runId: "probe", depth: 1, childIndex: 0, worker: true },
      files: { taskFile: "task", statusFile: "status", lifecycleFile: "lifecycle", logFile: "log", steerFile: "steer" },
    });
    expect(launch).toEqual(fabricWorker);
    expect(launch.workerArguments).not.toBe(fabricWorker.workerArguments);
  });

  it.each(["pi", "pi-durable"])("parses Pi kernels and extension context for %s", runner => {
    const root = temporary();
    expect(parseWorkerOptions(argv(root, { runner, kernel: "python", "python-runtime": "monty", "child-questions": "1000" })))
      .toMatchObject({ runner, kernel: "python", pythonRuntime: "monty", childQuestionTimeoutMs: 1000 });
    expect(parseWorkerOptions(argv(root, { runner }))).toMatchObject({ kernel: "typescript" });
    expect(parseWorkerOptions(argv(root, { runner, extensions: "false" })).kernel).toBeUndefined();
    expect(() => parseWorkerOptions(argv(root, { runner, extensions: "false", kernel: "typescript" })))
      .toThrow("Fabric extensions enabled");
  });

  it("prepares the Pi default model and forwards recursive/actor/confinement/session context", async () => {
    const root = temporary();
    const capture = path.join(root, "capture.mjs");
    fs.writeFileSync(capture, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(root, "argv.json"))}, JSON.stringify(process.argv));\nawait import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-worker.mjs")).href)});`);
    const preparePiModel = vi.fn(async () => "provider/fallback");
    const manager = new AgentManager(root, {
      ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi-durable", model: "provider/default", timeoutMs: 5000,
      childQuestions: "route", sessionExport: true, sessionExportDir: path.join(root, "exports"),
    }, {
      workerPath: capture, runRoot: path.join(root, "runs"), preparePiModel, fullCodeMode: true,
      resolveInheritedSessionPins: () => [{ pool: "parent-pool" }],
    });
    managers.push(manager);
    const result = await manager.run({ task: "probe", runner: "pi-durable", transport: "process", recursive: true,
      extensions: true, kernel: "typescript", readOnly: true, actorId: "actor-probe", actorName: "Probe",
      sessionFile: path.join(root, "actor.jsonl"),
    });
    expect(result.status, result.error).toBe("completed");
    expect(preparePiModel).toHaveBeenCalledWith("provider/default");
    const options = parseWorkerOptions(JSON.parse(fs.readFileSync(path.join(root, "argv.json"), "utf8")));
    expect(options).toMatchObject({ runner: "pi-durable", model: "provider/fallback", extensions: true,
      kernel: "typescript", fullCodeMode: true, actorId: "actor-probe", sessionFile: path.join(root, "actor.jsonl"),
      inheritedSessionPins: [{ pool: "parent-pool" }],
    });
    expect(options.childQuestionTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(options.sessionExportFile).toContain(path.join(root, "exports"));
    expect(JSON.parse(options.writePolicy!)).toMatchObject({ readOnly: true });
    expect(options.grantedRisks).toContain("agent");
    expect(options.fabricExtensionPath).toBeTruthy();
  });

  it("rejects unavailable durable Pi models before launching a worker", async () => {
    const root = temporary();
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi-durable" }, {
      runRoot: path.join(root, "runs"), preparePiModel: async () => { throw new Error("model unavailable"); },
    });
    managers.push(manager);
    await expect(manager.run({ task: "never launch", model: "provider/missing", transport: "process" }))
      .rejects.toThrow("model unavailable");
    expect(manager.listForUi()).toHaveLength(0);
  });
});

// Compile only the test subject into a temporary directory, never dist/. The
// sibling durable entry is a protocol double: this tests Fabric routing and RPC
// behavior without a provider request or coupling to the durable engine internals.
describe("real worker durable process protocol", () => {
  let fixture: string;
  let worker: string;
  beforeAll(async () => {
    fixture = temporary();
    worker = path.join(fixture, "worker.mjs");
    fs.symlinkSync(path.resolve("node_modules"), path.join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await build({ entryPoints: [path.resolve("src/worker.ts")], outfile: worker, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
    fs.mkdirSync(path.join(fixture, "durable"));
    fs.writeFileSync(path.join(fixture, "durable", "worker.js"), `
      import fs from 'node:fs';
      // session: the --session file's bytes at the moment this child starts.
      const sessionIndex = process.argv.indexOf('--session');
      const session = sessionIndex > 0 && fs.existsSync(process.argv[sessionIndex + 1]) ? fs.readFileSync(process.argv[sessionIndex + 1], 'utf8') : null;
      process.stdout.write(JSON.stringify({type: 'launch_probe', execPath: process.execPath, argv: process.argv.slice(2), kernel: process.env.PI_FABRIC_KERNEL, session}) + '\\n');
      if (process.env.DURABLE_ROUTING_QUESTION === '1') {
        await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-pi-rpc-question.mjs")).href)});
      } else {
        await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-pi-model.mjs")).href)});
      }
    `);
  });

  const run = async (runner = "pi-durable", scenario = "success", seeded = true,
    options: { root?: string; sessionFile?: (root: string) => string; prepare?: (root: string) => void; durableSession?: boolean } = {}) => {
    const root = options.root ?? temporary();
    if (options.root) fs.rmSync(path.join(root, "events.jsonl"), { force: true });
    fs.writeFileSync(path.join(root, "task.txt"), "run on requested model");
    fs.writeFileSync(path.join(root, "scenario"), scenario);
    options.prepare?.(root);
    const args = argv(root, { runner, kernel: "typescript", "write-policy": JSON.stringify({ readOnly: true }),
      ...(options.sessionFile ? { "session-file": options.sessionFile(root) }
        : seeded ? { "session-file": path.join(root, "seed.jsonl") } : {}), "session-export-file": path.join(root, "export.jsonl"),
      // What the manager passes for agents.durableWorkerSession; on by default for unseeded pi-durable cases here.
      ...((options.durableSession ?? (runner === "pi-durable" && !seeded)) ? { "durable-session": "true" } : {}) });
    const child = spawn(process.execPath, [worker, ...args.slice(2)], {
      env: { ...process.env, FAKE_MODEL_SCENARIO: path.join(root, "scenario") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    expect(fs.existsSync(path.join(root, "status.json")), stderr).toBe(true);
    const result = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
    const events = fs.existsSync(path.join(root, "events.jsonl"))
      ? fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { root, result, events, frames: events.filter(event => event.type === "fake_received").map(event => event.frame) };
  };

  it("launches the durable sibling through the current runtime and preserves native Pi flags and admission", async () => {
    const { root, result, events, frames } = await run();
    expect(result.status, result.error).toBe("completed");
    const launch = events.find(event => event.type === "launch_probe");
    expect(launch).toMatchObject({ execPath: process.execPath, kernel: "typescript" });
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--mode", "rpc", "--durable-run-id", "durable-probe", "--durable-directory", path.join(root, "durable"),
      "--session", path.join(root, "seed.jsonl"), "--no-tools", "--model", "openai-codex/gpt-5.6-sol", "--thinking", "high",
      "-e", path.join(fs.realpathSync(fixture), "agents", "write-guard.js"),
    ]));
    expect(frames.map(frame => frame.type)).toEqual(["get_state", "set_model", "set_thinking_level", "get_state", "prompt"]);
    expect(result.text).toBe("correct model ran");
    const exported = fs.readFileSync(path.join(root, "export.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(exported.at(-1)).toMatchObject({ type: "message", message: {
      role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 2, output: 3 },
    } });
  });

  it("routes durable child questions through manager control and back to native RPC", async () => {
    const root = temporary();
    const answerFile = path.join(root, "answers.jsonl");
    vi.stubEnv("DURABLE_ROUTING_QUESTION", "1");
    vi.stubEnv("FAKE_PI_QUESTION_LOG", answerFile);
    const onChildQuestion = vi.fn(async () => ({ value: "B" }));
    const manager = new AgentManager(root, {
      ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi-durable", model: "", timeoutMs: 5000,
      childQuestions: "route", childQuestionTimeoutMs: 1000, sessionExport: false,
    }, { workerPath: worker, runRoot: path.join(root, "runs"), onChildQuestion });
    managers.push(manager);
    const result = await manager.run({ task: "ask", transport: "process" });
    expect(result.status, result.error).toBe("completed");
    expect(onChildQuestion).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(answerFile, "utf8"))).toEqual({
      type: "extension_ui_response", id: "ui-1", value: "B",
    });
    expect(result.blockedOn).toBeUndefined();
  });

  it("keeps explicit pi on piBinary, not the durable entry", async () => {
    const { result, events, frames } = await run("pi");
    expect(result.status, result.error).toBe("completed");
    expect(events.some(event => event.type === "launch_probe")).toBe(false);
    expect(frames.at(-1).type).toBe("prompt");
  });

  it("gives an unseeded durable child a private session file in its run directory", async () => {
    const { root, result, events } = await run("pi-durable", "success", false);
    expect(result.status, result.error).toBe("completed");
    const sessionFile = path.join(root, "durable-session", "session.jsonl");
    const launch = events.find(event => event.type === "launch_probe");
    expect(launch.argv).toEqual(expect.arrayContaining(["--session", sessionFile]));
    expect(launch.argv).not.toContain("--no-session");
    expect(fs.statSync(sessionFile).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(sessionFile)).mode & 0o777).toBe(0o700);
    }
  });

  // The literal payload a context-aware extension reads as the host-declared worker role.
  // Written out here on purpose: do not import it from the code under test.
  const workerPolicy = {
    schemaVersion: 1, layer: "host", declaredBy: "pi-fabric/durable-worker", values: { sessionRole: "worker" },
  };
  const parseLines = (text: string) => text.trim().split("\n").map(line => JSON.parse(line));
  const policyEntries = (text: string) => parseLines(text).filter(entry => entry.type === "custom" && entry.customType === "context-aware.policy.v1");

  it("writes exactly the worker-role entry into an unseeded durable child's session before it starts", async () => {
    const { root, result, events } = await run("pi-durable", "success", false);
    expect(result.status, result.error).toBe("completed");
    const launch = events.find(event => event.type === "launch_probe");
    const atStart = parseLines(launch.session);
    expect(atStart).toHaveLength(2);
    expect(atStart[0]).toMatchObject({ type: "session", version: 3, cwd: root });
    expect(policyEntries(launch.session)).toHaveLength(1);
    expect(atStart[1]).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null });
    expect(atStart[1].data).toEqual(workerPolicy);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(root, "durable-session", "session.jsonl")).mode & 0o777).toBe(0o600);
    }
  });

  it("does not add a second worker-role entry when a relaunched attempt reopens the file", async () => {
    const first = await run("pi-durable", "success", false);
    const file = path.join(first.root, "durable-session", "session.jsonl");
    const before = fs.readFileSync(file, "utf8");
    // Something Pi saved after the first launch must survive the relaunch untouched.
    const saved = JSON.stringify({ type: "custom", customType: "durable-test.turn", data: { turn: true }, id: "abc12345", parentId: parseLines(before).at(-1).id, timestamp: new Date().toISOString() });
    fs.appendFileSync(file, saved + "\n");
    const second = await run("pi-durable", "success", false, { root: first.root });
    expect(second.result.status, second.result.error).toBe("completed");
    const launch = second.events.find(event => event.type === "launch_probe");
    expect(policyEntries(launch.session)).toHaveLength(1);
    expect(launch.session).toBe(before + saved + "\n");
  });

  it.each(["fork", "handoff"])("starts a pi-durable child on a %s seed that carries the worker role as its root", async kind => {
    const source = SessionManager.create(os.tmpdir(), path.join(temporary(), "source"));
    source.appendMessage({ role: "user", content: "inherited question", timestamp: 1 });
    const sourceBranch = source.getBranch();
    let seeded = "";
    const { root, result, events } = await run("pi-durable", "success", false, {
      sessionFile: root => {
        const directory = path.join(root, `${kind}-session`);
        const options = { workerRole: true };
        seeded = kind === "fork"
          ? writeForkSession({ sourceSessionId: "source", sourceBranch }, root, directory, undefined, options)
          : writeHandoffSession({
              sourceSessionId: "source", sourceBranch, sourceBranchLeafId: sourceBranch.at(-1)!.id,
              outerToolResult: { role: "toolResult", toolCallId: "t", toolName: "fabric_exec", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 },
            }, root, directory, undefined, undefined, undefined, options);
        return seeded;
      },
    });
    expect(result.status, result.error).toBe("completed");
    const launch = events.find(event => event.type === "launch_probe");
    expect(launch.argv).toEqual(expect.arrayContaining(["--session", seeded]));
    expect(path.dirname(seeded)).toBe(path.join(root, `${kind}-session`));
    const entries = parseLines(launch.session);
    expect(policyEntries(launch.session)).toHaveLength(1);
    expect(entries[1]).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null });
    expect(entries[1].data).toEqual(workerPolicy);
    expect(entries[2]).toMatchObject({ type: "message", parentId: entries[1].id });
    expect(launch.session).toContain("inherited question");
    expect(launch.session).toBe(fs.readFileSync(seeded, "utf8")); // the worker did not edit the seed
  });

  it("leaves a caller-supplied session file byte-identical after launch", async () => {
    const seed = "{\"type\":\"session\",\"version\":3,\"id\":\"caller\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/work\"}\n";
    const { root, result, events } = await run("pi-durable", "success", false, {
      sessionFile: root => {
        const file = path.join(root, "caller-session.jsonl");
        fs.writeFileSync(file, seed);
        return file;
      },
    });
    expect(result.status, result.error).toBe("completed");
    expect(events.find(event => event.type === "launch_probe").session).toBe(seed);
    expect(fs.readFileSync(path.join(root, "caller-session.jsonl"), "utf8")).toBe(seed);
    expect(fs.existsSync(path.join(root, "durable-session"))).toBe(false);
  });

  it.each(["durable-session", "fork-session", "handoff-session"])("never edits a caller-supplied session file, even one sitting in %s/", async folder => {
    const seed = "{\"type\":\"session\",\"version\":3,\"id\":\"caller\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/work\"}\n";
    let file = "";
    const { result, events } = await run("pi-durable", "success", false, {
      sessionFile: root => {
        fs.mkdirSync(path.join(root, folder), { mode: 0o700 });
        file = path.join(root, folder, "caller.jsonl");
        fs.writeFileSync(file, seed);
        return file;
      },
    });
    expect(result.status, result.error).toBe("completed");
    expect(events.find(event => event.type === "launch_probe").session).toBe(seed);
    expect(fs.readFileSync(file, "utf8")).toBe(seed);
  });

  it.skipIf(process.platform === "win32")("fails the launch when durable-session is a link, leaving the target directory untouched", async () => {
    const target = temporary();
    fs.chmodSync(target, 0o755);
    const { result, events } = await run("pi-durable", "success", false, {
      prepare: root => fs.symlinkSync(target, path.join(root, "durable-session"), "dir"),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/real directory, not a link/);
    expect(events.some(event => event.type === "launch_probe")).toBe(false);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")("tightens a group-writable run directory and launches with the policy root in the session file", async () => {
    const { root, result, events } = await run("pi-durable", "success", false, {
      prepare: root => fs.chmodSync(root, 0o770),
    });
    expect(result.status, result.error).toBe("completed");
    expect(fs.statSync(root).mode & 0o7777).toBe(0o750);
    const file = path.join(root, "durable-session", "session.jsonl");
    const entries = parseLines(fs.readFileSync(file, "utf8"));
    expect(entries[1]).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null, data: workerPolicy });
    expect(policyEntries(fs.readFileSync(file, "utf8"))).toHaveLength(1);
    expect(events.some(event => event.type === "launch_probe")).toBe(true);
  });

  // The manager decides which seeds carry the worker role: only a pi-durable child's, never plain pi's.
  describe("manager seed options", () => {
    const launch = async (runner: "pi" | "pi-durable", request: Record<string, unknown>, durableWorkerSession = true) => {
      const root = temporary();
      const capture = path.join(root, "capture.mjs");
      fs.writeFileSync(capture, `import fs from 'node:fs';
const index = process.argv.indexOf('--session-file');
const seed = index > 0 && fs.existsSync(process.argv[index + 1]) ? fs.readFileSync(process.argv[index + 1], 'utf8') : null;
const status = process.argv[process.argv.indexOf('--status-file') + 1];
fs.writeFileSync(${JSON.stringify(path.join(root, "probe.json"))}, JSON.stringify({ argv: process.argv, seed, runMode: fs.statSync(status.replace(/[/\\\\][^/\\\\]*$/, '')).mode & 0o777 }));
await import(${JSON.stringify(pathToFileURL(path.resolve("tests/fixtures/fake-worker.mjs")).href)});`);
      const manager = new AgentManager(root, {
        ...DEFAULT_FABRIC_CONFIG.agents, runner, model: "provider/default", timeoutMs: 5000, sessionExport: false, durableWorkerSession,
      }, { workerPath: capture, runRoot: path.join(root, "runs"), preparePiModel: async () => "provider/default" });
      managers.push(manager);
      const result = await manager.run({ task: "probe", runner, transport: "process", ...request } as never);
      expect(result.status, result.error).toBe("completed");
      return JSON.parse(fs.readFileSync(path.join(root, "probe.json"), "utf8")) as { argv: string[]; seed: string | null; runMode: number };
    };
    const forkSeed = () => {
      const source = SessionManager.create(os.tmpdir(), path.join(temporary(), "source"));
      source.appendMessage({ role: "user", content: "inherited question", timestamp: 1 });
      return { sourceSessionId: "source", sourceBranch: source.getBranch() };
    };

    it("puts the worker role at the root of a pi-durable fork seed and passes no ownership flag", async () => {
      const probe = await launch("pi-durable", { forkSeed: forkSeed() });
      expect(probe.argv).toContain("--session-file");
      expect(probe.argv).not.toContain("--session-owned");
      const entries = parseLines(probe.seed!);
      expect(entries[1]).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null });
      expect(entries[1].data).toEqual(workerPolicy);
      expect(entries[2]).toMatchObject({ type: "message", parentId: entries[1].id });
    });

    it("leaves a pi-durable fork seed and run directory as before when agents.durableWorkerSession is off", async () => {
      const previous = process.umask(0o002);
      try {
        const probe = await launch("pi-durable", { forkSeed: forkSeed() }, false);
        expect(probe.argv).not.toContain("--durable-session");
        expect(policyEntries(probe.seed!)).toHaveLength(0);
        expect(parseLines(probe.seed!)[1]).toMatchObject({ type: "message", parentId: null });
        // No 0700 override: the run directory keeps the process umask, as before.
        if (process.platform !== "win32") expect(probe.runMode & 0o777).toBe(0o775);
      } finally { process.umask(previous); }
    });

    it("writes a plain pi fork seed without the worker role, as before", async () => {
      const probe = await launch("pi", { forkSeed: forkSeed() });
      expect(probe.argv).not.toContain("--session-owned");
      expect(policyEntries(probe.seed!)).toHaveLength(0);
      expect(parseLines(probe.seed!)[1]).toMatchObject({ type: "message", parentId: null });
    });

    it.skipIf(process.platform === "win32")("creates run directories closed to group and others", async () => {
      const previous = process.umask(0o002);
      try {
        const probe = await launch("pi-durable", { sessionFile: path.join(temporary(), "actor.jsonl") });
        expect(probe.runMode & 0o022).toBe(0);
        expect(probe.argv).not.toContain("--session-owned");
      } finally { process.umask(previous); }
    });
  });

  it("keeps --no-session and writes nothing for an unseeded pi-durable child without the durable-session flag", async () => {
    const { root, result, events } = await run("pi-durable", "success", false, { durableSession: false });
    expect(result.status, result.error).toBe("completed");
    const launch = events.find(event => event.type === "launch_probe");
    expect(launch.argv).toContain("--no-session");
    expect(launch.argv).not.toContain("--session");
    expect(launch.session).toBe(null);
    expect(fs.existsSync(path.join(root, "durable-session"))).toBe(false);
  });

  it("rejects the durable-session flag for a plain pi child", async () => {
    const { result } = await run("pi", "success", false, { durableSession: true });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/durable-session requires the pi-durable runner/);
  });

  it("keeps an unseeded explicit pi child without a session file", async () => {
    const { root, result } = await run("pi", "success", false);
    expect(result.status, result.error).toBe("completed");
    expect(fs.existsSync(path.join(root, "durable-session"))).toBe(false);
  });

  it("leaves a seeded plain pi child's session file without a worker-role entry", async () => {
    const source = SessionManager.create(os.tmpdir(), path.join(temporary(), "source"));
    source.appendMessage({ role: "user", content: "inherited question", timestamp: 1 });
    let seeded = "";
    const { result } = await run("pi", "success", false, {
      sessionFile: root => (seeded = writeForkSession({ sourceSessionId: "source", sourceBranch: source.getBranch() }, root, path.join(root, "fork-session"))),
    });
    expect(result.status, result.error).toBe("completed");
    expect(policyEntries(fs.readFileSync(seeded, "utf8"))).toHaveLength(0);
    expect(fs.readFileSync(seeded, "utf8")).toContain("inherited question");
  });

  it("gives a plain pi child no session file and no worker-role entry", async () => {
    const { root, result, events } = await run("pi", "success", false);
    expect(result.status, result.error).toBe("completed");
    expect(events.some(event => event.type === "launch_probe")).toBe(false);
    for (const dir of ["durable-session", "fork-session", "handoff-session"]) {
      expect(fs.existsSync(path.join(root, dir))).toBe(false);
    }
  });

  it.each(["reswitch", "reject", "exit"])("never prompts before durable model admission: %s", async scenario => {
    const { result, frames } = await run("pi-durable", scenario);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/model|admission/);
    expect(frames.some(frame => frame.type === "prompt")).toBe(false);
  });

  it("still terminates on durable assistant model drift", async () => {
    const { result } = await run("pi-durable", "drift");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("terminating child");
  });
});
