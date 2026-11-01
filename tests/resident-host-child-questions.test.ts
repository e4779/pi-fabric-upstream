import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, type FabricAgentConfig } from "../src/config.js";
import { routeChildQuestion } from "../src/decisions/host.js";
import { DecisionStore, type DecisionRecord } from "../src/decisions/store.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { scriptSpawnArgs } from "../src/agents/transports/process-utils.js";
import { runResidentHostFromConfigPath } from "../src/residency/host.js";
import {
  RESIDENT_HOST_FORMAT,
  residentHostId,
  residentRoot,
  type ResidentAgentMetadata,
  type ResidentCommandResponse,
  type ResidentHostConfig,
} from "../src/residency/protocol.js";
import {
  registerAgentRunner,
  type FabricHostedReporter,
  type FabricRunnerAnswer,
  type FabricRunnerCapabilities,
} from "../src/runners.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

// A durable run's child dialog, routed by the resident host itself: the host
// runs in this process and receives the same file requests a session's
// ResidencyClient writes. The answering side is a separate mesh handle, as the
// pi-fabric decisions CLI or another root session would be.

// The resident host always resolves a model, so the child must pass model admission first.
const fakePi = path.resolve("tests/fixtures/fake-pi-rpc-question-admitted.mjs");
const human = { answeredBy: "alice", via: "cli" };
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const QUESTIONS_ONLY: FabricRunnerCapabilities = {
  recursiveFabric: false,
  steer: false,
  followUp: false,
  persistentSessions: false,
  kernels: false,
  handoff: false,
  modelDiscovery: false,
  imageInput: false,
  compaction: false,
  questions: true,
  sleep: false,
  writePolicy: false,
};

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for resident host state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out"]);

interface Harness {
  config: ResidentHostConfig;
  configPath: string;
  decisions: DecisionStore;
  mesh: MeshStore;
}

const harness = async (agents: Partial<FabricAgentConfig>): Promise<Harness> => {
  const state = writeHostConfig(agents);
  const controller = new AbortController();
  const running = runResidentHostFromConfigPath(state.configPath, controller.signal);
  cleanups.push(async () => {
    controller.abort();
    await running;
  });
  await waitFor(() => fs.existsSync(path.join(state.config.residencyRoot, "owner.json")));
  return state;
};

/** A resident host config and an answering mesh handle; no host is started. */
const writeHostConfig = (agents: Partial<FabricAgentConfig>): Harness => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-question-"));
  cleanups.push(() => rmTempSync(root));
  const meshRoot = path.join(root, "mesh");
  const rootId = `session:resident-question:${randomUUID()}`;
  const mesh = { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: true, actorPollMs: 20 };
  const config: ResidentHostConfig = {
    format: RESIDENT_HOST_FORMAT,
    rootId,
    sessionId: "resident-question",
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    meshRoot,
    actorRoot: path.join(meshRoot, "actors"),
    sessionActorRoot: path.join(meshRoot, "actors", "resident-question"),
    residencyRoot: residentRoot(meshRoot, rootId),
    fullCodeMode: false,
    agents: { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, timeoutMs: 60_000, ...agents },
    mesh,
    retention: DEFAULT_FABRIC_CONFIG.retention,
    workerPath: path.resolve("src/worker.ts"),
    fabricExtensionPath: path.resolve("src/index.ts"),
    piBinary: fakePi,
    claudeBinary: "claude",
    vedaBinary: "veda",
    piModels: {
      available: [{ provider: "provider", id: "visible", name: "Visible" }],
      aliases: {},
      defaultModel: "provider/visible",
    },
  };
  fs.mkdirSync(config.residencyRoot, { recursive: true });
  const configPath = path.join(config.residencyRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const store = new MeshStore(meshRoot, mesh.maxEventBytes, mesh.maxReadEvents);
  const answerer: MeshIdentity = { id: `${rootId}:answerer`, name: "answerer", kind: "main", sessionId: "answerer" };
  return { config, configPath, mesh: store, decisions: new DecisionStore(store, answerer) };
};

/** Submit a durable spawn exactly as ResidencyClient does, through the request directory. */
const spawnDurable = async (
  config: ResidentHostConfig,
  request: { task: string; runner: string; transport?: "process" },
  runnerModule?: string,
): Promise<{ id: string; runDirectory: string }> => {
  const requestId = randomUUID();
  const requests = path.join(config.residencyRoot, "requests");
  const pending = path.join(requests, `${requestId}.json.partial`);
  fs.writeFileSync(pending, JSON.stringify({
    format: RESIDENT_HOST_FORMAT,
    operation: "spawn",
    requestId,
    rootId: config.rootId,
    request: {
      task: request.task,
      runner: request.runner,
      ...(request.transport ? { transport: request.transport } : {}),
      residency: "durable",
    },
    ...(runnerModule ? { runnerModule } : {}),
    createdAt: Date.now(),
  }));
  fs.renameSync(pending, path.join(requests, `${requestId}.json`));
  const responsePath = path.join(config.residencyRoot, "responses", `${requestId}.json`);
  await waitFor(() => readJson<ResidentCommandResponse>(responsePath) !== undefined);
  const response = readJson<ResidentCommandResponse>(responsePath)!;
  expect(response.error).toBeUndefined();
  const id = response.handle!.id;
  const metadata = readJson<ResidentAgentMetadata>(path.join(config.residencyRoot, "agents", `${id}.json`))!;
  return { id, runDirectory: metadata.runDirectory };
};

const runRecord = (runDirectory: string): AgentRunRecord | undefined =>
  readJson<AgentRunRecord>(path.join(runDirectory, "status.json"));

/** The run's open question decision, or a failure naming how the run settled instead. */
const openQuestion = async (state: Harness, runDirectory: string): Promise<DecisionRecord> => {
  let open: DecisionRecord | undefined;
  let settled: AgentRunRecord | undefined;
  await waitFor(async () => {
    [open] = await state.decisions.list({ status: "open" });
    const record = runRecord(runDirectory);
    if (record && TERMINAL.has(record.status)) settled = record;
    return open !== undefined || settled !== undefined;
  });
  expect(open, `no decision opened; the run settled ${settled?.status} with ${settled?.text ?? settled?.error}`)
    .toBeDefined();
  return open!;
};

const settledRecord = async (runDirectory: string): Promise<AgentRunRecord> => {
  await waitFor(() => TERMINAL.has(runRecord(runDirectory)?.status ?? ""));
  return runRecord(runDirectory)!;
};

/** A hosted runner that asks one question and finishes with the answer it received. */
const registerAskOnce = (id: string): { stops: string[] } => {
  const stops: string[] = [];
  cleanups.push(registerAgentRunner({
    kind: "hosted",
    id,
    label: "Ask once",
    capabilities: QUESTIONS_ONLY,
    prepare: (context) => ({ job: context.idempotencyKey }),
    start(_locator, _context, reporter) {
      void reporter
        .question({ method: "select", title: "Pick a colour", options: ["red", "blue"] })
        .then((answer) => reporter.finish({ status: "completed", output: JSON.stringify(answer) }));
    },
    attach() {},
    liveness: () => "running",
    stop: (_locator, reason) => {
      stops.push(reason);
      return { confirmed: true };
    },
  }));
  return { stops };
};

describe("resident host routed child questions", () => {
  it("turns a durable hosted run's question into a root-held decision and returns the answer", { timeout: 30_000 }, async () => {
    registerAskOnce("ask-once");
    const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-once" });

    const decision = await openQuestion(state, run.runDirectory);
    expect(decision).toMatchObject({
      kind: "question",
      holder: "root",
      input: "select",
      options: [{ id: "o1", label: "red" }, { id: "o2", label: "blue" }],
      raisedBy: { participantId: run.id, runId: run.id, sessionId: state.config.sessionId },
      onExpire: "cancel",
    });
    expect(decision.title).toMatch(/: Pick a colour$/);
    expect(runRecord(run.runDirectory)).toMatchObject({ status: "running", blockedOn: { since: expect.any(Number) } });

    await state.decisions.answer(decision.id, { optionId: "o2" }, human);
    const result = await settledRecord(run.runDirectory);
    expect(result).toMatchObject({ status: "completed", text: JSON.stringify({ value: "blue" }) });
    expect(result.blockedOn).toBeUndefined();
  });

  it("cancels the open decision when the durable run is stopped", { timeout: 30_000 }, async () => {
    const adapter = registerAskOnce("ask-stop");
    const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-stop" });
    const decision = await openQuestion(state, run.runDirectory);

    const peer: MeshIdentity = { id: `${state.config.rootId}:peer`, name: "peer", kind: "main", sessionId: "peer" };
    const control = new FabricControlPlane(state.mesh, peer, {
      enabled: true,
      hostId: peer.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 5_000,
    });
    control.start(() => ({ accepted: false }));
    cleanups.push(() => control.close());
    const hostId = residentHostId(state.config.rootId);
    await control.request(hostId, run.id, "stop", {}, hostId);

    expect(await settledRecord(run.runDirectory)).toMatchObject({ status: "stopped" });
    expect(adapter.stops).toEqual(["requested"]);
    await waitFor(async () => (await state.decisions.get(decision.id))?.status !== "open");
    expect(await state.decisions.get(decision.id)).toMatchObject({
      status: "cancelled",
      answer: { answeredBy: hostId, via: "abort" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "routes a durable pi-runner worker's dialog through a root-held decision",
    { timeout: 45_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-question-log-"));
      cleanups.push(() => rmTempSync(root));
      const log = path.join(root, "responses.jsonl");
      process.env.FAKE_PI_QUESTION_LOG = log;
      cleanups.push(() => {
        delete process.env.FAKE_PI_QUESTION_LOG;
      });
      const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
      const run = await spawnDurable(state.config, { task: "ASK", runner: "pi", transport: "process" });

      const decision = await openQuestion(state, run.runDirectory);
      expect(decision).toMatchObject({
        kind: "question",
        holder: "root",
        options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }],
        raisedBy: { runId: run.id },
      });
      await state.decisions.answer(decision.id, { optionId: "o2" }, human);

      const settled = await settledRecord(run.runDirectory);
      expect(settled.error).toBeUndefined();
      expect(settled).toMatchObject({ status: "completed" });
      const responses = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(responses).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "B" }]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "names the decision in a durable pi-runner worker's status file while it waits",
    { timeout: 45_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-question-log-"));
      cleanups.push(() => rmTempSync(root));
      process.env.FAKE_PI_QUESTION_LOG = path.join(root, "responses.jsonl");
      cleanups.push(() => {
        delete process.env.FAKE_PI_QUESTION_LOG;
      });
      const state = await harness({ childQuestions: "route", childQuestionTimeoutMs: 30_000 });
      const run = await spawnDurable(state.config, { task: "ASK", runner: "pi", transport: "process" });

      const decision = await openQuestion(state, run.runDirectory);
      // The worker writes this file; a session reads a durable run only from it.
      await waitFor(() => runRecord(run.runDirectory)?.blockedOn?.decisionId === decision.id);
      expect(runRecord(run.runDirectory)).toMatchObject({
        status: "running",
        blockedOn: { since: expect.any(Number), decisionId: decision.id },
      });

      await state.decisions.answer(decision.id, { optionId: "o1" }, human);
      const settled = await settledRecord(run.runDirectory);
      expect(settled).toMatchObject({ status: "completed" });
      expect(settled.blockedOn).toBeUndefined();
    },
  );

  it("still cancels a durable child's question when childQuestions is not route", { timeout: 30_000 }, async () => {
    registerAskOnce("ask-cancel");
    const state = await harness({ childQuestions: "cancel" });
    const run = await spawnDurable(state.config, { task: "ask", runner: "ask-cancel" });
    expect(await settledRecord(run.runDirectory)).toMatchObject({
      status: "completed",
      text: JSON.stringify({ cancelled: true }),
    });
    expect(await state.decisions.list()).toEqual([]);
  });
});

// A resident host generation in its own process, so the test can end it as a
// shutdown would (SIGTERM: the host closes) or as a crash would (SIGKILL: no
// cleanup at all, its owner record and open decisions left behind).
interface HostProcess {
  pid: number;
  stop(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

// Ends its process as soon as the host returns, as the Pi entry does.
const hostEntry = path.resolve("tests/fixtures/resident-host-process.ts");
// Registers the "restart-asker" runner inside each host process.
const questionRunner = path.resolve("tests/fixtures/hosted-question-runner.ts");

// Store locks (mesh, actor registry, bindings) held under the mesh root. The
// host's own host.lock is left out: a crashed host leaves it by design. A
// directory or lock can vanish while we walk, so ENOENT just skips it.
const heldStoreLocks = (meshRoot: string): string[] => {
  const held: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name.endsWith(".lock") && entry.name !== "host.lock") held.push(entryPath);
      else if (entry.isDirectory()) walk(entryPath);
    }
  };
  walk(meshRoot);
  return held;
};

const processStopped = (pid: number): boolean =>
  spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("T");

/**
 * Freeze the host (SIGSTOP) at a moment it holds no store lock, so the SIGKILL
 * that follows is a crash between store writes. A crash inside a store write
 * leaves that lock behind for up to STALE_LOCK_MS, and the next host's writes
 * wait it out: a separate mesh-lock failure this test does not cover. If a lock
 * is held, let the host run on (SIGCONT) and try again.
 */
const freezeOutsideLocks = async (pid: number, meshRoot: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    process.kill(pid, "SIGSTOP");
    await waitFor(() => processStopped(pid), 15_000);
    const held = heldStoreLocks(meshRoot);
    if (held.length === 0) return;
    process.kill(pid, "SIGCONT");
    if (Date.now() >= deadline) throw new Error(`Resident host kept holding store locks: ${held.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const startHostProcess = async (state: Harness, backend: string): Promise<HostProcess> => {
  const [command, ...args] = await scriptSpawnArgs(hostEntry, ["--config", state.configPath]);
  const child = spawn(command!, args, {
    cwd: process.cwd(),
    env: { ...process.env, FABRIC_TEST_HOSTED_BACKEND: backend },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  cleanups.push(async () => {
    if (running()) child.kill("SIGKILL");
    await exited;
  });
  const ownerPath = path.join(state.config.residencyRoot, "owner.json");
  await waitFor(() => {
    if (!running()) throw new Error(`Resident host exited during startup: ${stderr}`);
    return readJson<{ pid?: number }>(ownerPath)?.pid === child.pid;
  }, 30_000);
  return {
    pid: child.pid!,
    async stop(signal) {
      if (signal === "SIGTERM") {
        child.kill(signal);
        // A graceful close ends by releasing the owner record.
        await waitFor(() => !fs.existsSync(ownerPath), 15_000);
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
      } else {
        await freezeOutsideLocks(child.pid!, state.config.meshRoot);
        child.kill("SIGKILL");
        // Reaped, so the next host judges the owner record's pid dead.
        await exited;
      }
    },
  };
};

const backendAnswers = (backend: string, id: string): Array<{ pid: number; answer: unknown }> =>
  readJson<{ answers: Array<{ pid: number; answer: unknown }> }>(path.join(backend, `${id}.json`))?.answers ?? [];

/** The open decisions once the new host has asked again: anything but `previous`. */
const reasked = async (state: Harness, previous: string): Promise<DecisionRecord[]> => {
  let open: DecisionRecord[] = [];
  await waitFor(async () => {
    open = await state.decisions.list({ status: "open" });
    return open.some((decision) => decision.id !== previous);
  }, 30_000);
  return open;
};

describe.skipIf(process.platform === "win32")("resident host restart with a routed question open", () => {
  const restart = async (signal: "SIGTERM" | "SIGKILL") => {
    const state = writeHostConfig({ childQuestions: "route", childQuestionTimeoutMs: 120_000 });
    const backend = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-hosted-backend-"));
    cleanups.push(() => rmTempSync(backend));
    const first = await startHostProcess(state, backend);
    const run = await spawnDurable(state.config, { task: "ask", runner: "restart-asker" }, questionRunner);
    const asked = await openQuestion(state, run.runDirectory);
    // The session reads a durable run's status file; it names the blocking decision.
    await waitFor(() => runRecord(run.runDirectory)?.blockedOn?.decisionId === asked.id);
    await first.stop(signal);
    return { state, backend, run, asked, hostId: residentHostId(state.config.rootId) };
  };

  it("cancels the question at shutdown, and the next host's re-ask is the only open decision", { timeout: 90_000 }, async () => {
    const { state, backend, run, asked, hostId } = await restart("SIGTERM");

    // Who cancels: the closing host, when it detaches the run. The runner got no answer.
    expect(await state.decisions.get(asked.id)).toMatchObject({
      status: "cancelled",
      answer: { answeredBy: hostId, via: "abort" },
    });
    expect(backendAnswers(backend, run.id)).toEqual([]);
    expect(runRecord(run.runDirectory)).toMatchObject({ status: "running", blockedOn: { since: expect.any(Number) } });
    expect(runRecord(run.runDirectory)?.blockedOn?.decisionId).toBeUndefined();

    const second = await startHostProcess(state, backend);
    const open = await reasked(state, asked.id);
    expect(open).toHaveLength(1);
    const live = open[0]!;
    expect(live).toMatchObject({ kind: "question", holder: "root", raisedBy: { runId: run.id } });
    await waitFor(() => runRecord(run.runDirectory)?.blockedOn?.decisionId === live.id);

    await state.decisions.answer(live.id, { optionId: "o2" }, human);
    expect(await settledRecord(run.runDirectory)).toMatchObject({
      status: "completed",
      text: JSON.stringify({ value: "blue" }),
    });
    expect(backendAnswers(backend, run.id)).toEqual([{ pid: second.pid, answer: { value: "blue" } }]);
    expect(await state.decisions.get(asked.id)).toMatchObject({ status: "cancelled" });
    await second.stop("SIGTERM");
  });

  it("cancels a dead host's question at the next start, and the re-ask is the only open decision", { timeout: 90_000 }, async () => {
    const { state, backend, run, asked, hostId } = await restart("SIGKILL");

    // A crashed host cleans up nothing: its decision is still open, and status names it.
    expect(fs.existsSync(path.join(state.config.residencyRoot, "owner.json"))).toBe(true);
    expect(await state.decisions.get(asked.id)).toMatchObject({ status: "open" });
    expect(runRecord(run.runDirectory)?.blockedOn?.decisionId).toBe(asked.id);

    // Who cancels: the next host, at startup, before it re-attaches the run.
    const second = await startHostProcess(state, backend);
    const open = await reasked(state, asked.id);
    expect(await state.decisions.get(asked.id)).toMatchObject({
      status: "cancelled",
      answer: { answeredBy: hostId, via: "restart" },
    });
    expect(open).toHaveLength(1);
    const live = open[0]!;
    expect(live).toMatchObject({ kind: "question", holder: "root", raisedBy: { runId: run.id } });
    await waitFor(() => runRecord(run.runDirectory)?.blockedOn?.decisionId === live.id);

    await state.decisions.answer(live.id, { optionId: "o1" }, human);
    expect(await settledRecord(run.runDirectory)).toMatchObject({
      status: "completed",
      text: JSON.stringify({ value: "red" }),
    });
    expect(backendAnswers(backend, run.id)).toEqual([{ pid: second.pid, answer: { value: "red" } }]);
    await second.stop("SIGTERM");
  });
});

// The same detach and re-attach, one level down: the AgentManager that a
// resident host owns, with the host's router over a real decision store.
describe("durable hosted run questions in the agent manager", () => {
  interface Asker {
    /** Ask through the reporter of the latest start or attach. */
    ask(title: string): Promise<FabricRunnerAnswer>;
    attaches: number;
  }

  const registerAsker = (id: string, onStart?: (asker: Asker) => void): Asker => {
    let reporter: FabricHostedReporter | undefined;
    const asker: Asker = {
      ask: (title) => reporter!.question({ method: "input", title }),
      attaches: 0,
    };
    cleanups.push(registerAgentRunner({
      kind: "hosted",
      id,
      label: "Asker",
      capabilities: QUESTIONS_ONLY,
      prepare: (context) => ({ job: context.idempotencyKey }),
      start(_locator, _context, current) {
        reporter = current;
        onStart?.(asker);
      },
      attach(_locator, _context, current) {
        reporter = current;
        asker.attaches += 1;
      },
      liveness: () => "running",
      stop: () => ({ confirmed: true }),
    }));
    return asker;
  };

  const managerWithDecisions = (runRoot: string, decisions: DecisionStore): AgentManager => {
    const manager = new AgentManager(process.cwd(), {
      ...DEFAULT_FABRIC_CONFIG.agents,
      childQuestions: "route",
      childQuestionTimeoutMs: 60_000,
    }, {
      runRoot,
      fullCodeMode: false,
      onChildQuestion: (request) => routeChildQuestion(request, { store: decisions }),
    });
    cleanups.push(() => manager.close());
    return manager;
  };

  /** Cancelling takes this long, so close's ordering is visible. */
  class SlowCancelStore extends DecisionStore {
    override async cancel(...args: Parameters<DecisionStore["cancel"]>): Promise<DecisionRecord> {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return super.cancel(...args);
    }
  }

  const stores = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-hosted-question-"));
    cleanups.push(() => rmTempSync(root));
    const mesh = new MeshStore(path.join(root, "mesh"), DEFAULT_FABRIC_CONFIG.mesh.maxEventBytes, DEFAULT_FABRIC_CONFIG.mesh.maxReadEvents);
    const host: MeshIdentity = { id: "resident:test-host", name: "host", kind: "agent", sessionId: "s" };
    const person: MeshIdentity = { id: "person", name: "person", kind: "main", sessionId: "p" };
    return {
      runRoot: path.join(root, "runs"),
      host: new SlowCancelStore(mesh, host),
      answers: new DecisionStore(mesh, person),
    };
  };

  const openTitled = async (decisions: DecisionStore, title: string): Promise<DecisionRecord> => {
    let found: DecisionRecord | undefined;
    await waitFor(async () => {
      found = (await decisions.list({ status: "open" })).find((decision) => decision.title.endsWith(`: ${title}`));
      return found !== undefined;
    });
    return found!;
  };

  it("names the oldest question's decision in status.json and moves on when it is answered", { timeout: 30_000 }, async () => {
    const { runRoot, host, answers } = stores();
    const asker = registerAsker("asker-two");
    const manager = managerWithDecisions(runRoot, host);
    const handle = await manager.spawn({ task: "ask twice", runner: "asker-two", residency: "durable" });
    const status = (): AgentRunRecord => readJson<AgentRunRecord>(path.join(manager.runDirectory(handle.id)!, "status.json"))!;

    const firstAnswer = asker.ask("First");
    const first = await openTitled(answers, "First");
    const secondAnswer = asker.ask("Second");
    const second = await openTitled(answers, "Second");
    expect(status().blockedOn?.decisionId).toBe(first.id);

    await answers.answer(first.id, { text: "one" }, human);
    expect(await firstAnswer).toEqual({ value: "one" });
    expect(status().blockedOn?.decisionId).toBe(second.id);

    await answers.answer(second.id, { text: "two" }, human);
    expect(await secondAnswer).toEqual({ value: "two" });
    expect(status().blockedOn).toBeUndefined();
  });

  it("cancels the decision when it detaches, and re-attaching drops a blockedOn left behind", { timeout: 30_000 }, async () => {
    const { runRoot, host, answers } = stores();
    let pending: Promise<FabricRunnerAnswer> | undefined;
    const asker = registerAsker("asker-detach", (current) => {
      pending = current.ask("Before shutdown");
    });
    const first = managerWithDecisions(runRoot, host);
    const handle = await first.spawn({ task: "ask", runner: "asker-detach", residency: "durable" });
    const statusFile = path.join(first.runDirectory(handle.id)!, "status.json");
    const asked = await openTitled(answers, "Before shutdown");
    await waitFor(() => readJson<AgentRunRecord>(statusFile)?.blockedOn?.decisionId === asked.id);

    await first.close();
    // Settled by the time close returns, and never as an answer to the runner,
    // nor is a question asked after the detach answered or routed.
    expect(await answers.get(asked.id)).toMatchObject({ status: "cancelled", answer: { answeredBy: host.identity.id } });
    const late = asker.ask("After shutdown");
    const answered = await Promise.race([
      Promise.any([pending!, late]).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(answered).toBe(false);
    expect(await answers.list({ status: "open" })).toEqual([]);
    expect(readJson<AgentRunRecord>(statusFile)).toMatchObject({ status: "running", blockedOn: { since: expect.any(Number) } });
    expect(readJson<AgentRunRecord>(statusFile)?.blockedOn?.decisionId).toBeUndefined();

    // What a host that died mid-question leaves: the record still names its decision.
    fs.writeFileSync(statusFile, JSON.stringify({
      ...readJson<AgentRunRecord>(statusFile),
      blockedOn: { since: 1, decisionId: asked.id },
    }));
    const second = managerWithDecisions(runRoot, host);
    expect(await second.recoverHostedRuns()).toEqual([handle.id]);
    expect(asker.attaches).toBe(1);
    expect(readJson<AgentRunRecord>(statusFile)).toMatchObject({ status: "running" });
    expect(readJson<AgentRunRecord>(statusFile)?.blockedOn).toBeUndefined();
  });
});
