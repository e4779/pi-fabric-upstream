import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createWorkerSession,
  formatModelLines,
  listHostModels,
  parseAgentArgv,
  workerResultLines,
  type AgentCommandArgs,
  type HostModelInfo,
  type WorkerSession,
} from "./agent.js";
import type { ExternalCommandHandler } from "./bridge.js";

/**
 * Detached agent jobs over the bridge — the agents.spawn tier. `agent submit`
 * starts a worker and answers with an id immediately; status/wait/result/stop
 * observe and join it, steer/follow inject mid-run guidance through the SDK's
 * own turn semantics. Jobs live in this process only: the bridge dies, the
 * jobs die — the orchestrator (a shell script) survives on its own files.
 */

export const AGENT_JOBS_HELP = [
  "agent job subcommands:",
  "  agent submit <agent key=value lines>   start a worker; replies id=<uuid>",
  "    optional job keys: name=<label>, jobTool=bash|powershell|fabric_exec|monitor",
  "  agent status <id>                      peek: state, name, elapsed",
  "  agent wait <id> [timeoutMs=<n>]        join (blocks the connection)",
  "  agent result <id>                      final text/JSON; ERR while running",
  "  agent stop <id>                        abort; partial text is kept",
  "  agent steer <id> textFile=<path>       inject after the current turn",
  "  agent follow <id> textFile=<path>      queue after the whole run",
  "  agent list                             one line per job",
  "  agent models                           one line per servable model",
].join("\n");

type JobState = "running" | "done" | "failed" | "stopped";

interface Job {
  id: string;
  name: string;
  state: JobState;
  submittedAt: number;
  endedAt?: number;
  error?: string;
  lines?: string[];
  partial?: string | undefined;
  json: boolean;
  prompt: string;
  jobTool?: import("../protocol.js").FabricBgJobToolV1;
  session?: WorkerSession | undefined;
  timer?: ReturnType<typeof setTimeout>;
  /** Bounded disposal backstop when a hanging abort() parks the run loop forever. */
  abortGrace?: ReturnType<typeof setTimeout>;
  /** True once the session cleanup (dispose) ran, from the run loop or the timeout grace. */
  finalized?: boolean;
  /** True once #terminal has notified observers — onSettle fires exactly once per job. */
  notified: boolean;
  done: Promise<void>;
  settle: () => void;
}

const ABORT_GRACE_MS = 1_000;

const readTextFile = (label: string, path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export interface JobSettlement {
  id: string;
  name: string;
  state: JobState;
  error?: string;
}

/** Typed registry view for observers that must not parse the CLI lines. */
export interface AgentJobEntry {
  id: string;
  name: string;
  state: JobState;
  error?: string;
  /** The submitted prompt; consumers bound it themselves before publishing. */
  prompt: string;
  /** Caller-chosen JobStore registration kind; absent means the mirror default. */
  jobTool?: import("../protocol.js").FabricBgJobToolV1;
  submittedAt: number;
  endedAt?: number;
}

export class AgentJobs {
  readonly #jobs = new Map<string, Job>();

  constructor(
    private readonly spawn: (args: AgentCommandArgs) => Promise<WorkerSession> = createWorkerSession,
    private readonly cap = 64,
    /** Completion inbox: called once per terminal transition, never for close(). */
    private readonly onSettle?: (settlement: JobSettlement) => void,
    /** Footer/observer refresh: called after every registry mutation. */
    private readonly onChange?: () => void,
  ) {}

  #terminal(job: Job): void {
    job.settle();
    if (job.notified) return; // timeout settle + run-loop finally must notify exactly once
    job.notified = true;
    if (this.onSettle !== undefined) {
      try {
        this.onSettle({
          id: job.id,
          name: job.name,
          state: job.state,
          ...(job.error === undefined ? {} : { error: job.error }),
        });
      } catch {
        /* the inbox must never break the job machinery */
      }
    }
    this.#changed();
  }

  #changed(): void {
    try {
      this.onChange?.();
    } catch {
      /* observers must never break the registry */
    }
  }

  submit(args: AgentCommandArgs): string {
    let running = 0;
    for (const job of this.#jobs.values()) if (job.state === "running") running++;
    if (running >= this.cap) throw new Error(`agent job cap reached (${this.cap} running)`);
    const id = randomUUID();
    const session = this.spawn(args);
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: Job = {
      id,
      name: args.name ?? id.slice(0, 8),
      state: "running",
      submittedAt: Date.now(),
      json: args.json,
      prompt: args.prompt,
      ...(args.jobTool !== undefined ? { jobTool: args.jobTool } : {}),
      session: undefined,
      notified: false,
      done,
      settle,
    };
    this.#jobs.set(id, job);
    this.#changed();
    const timer = setTimeout(() => {
      if (job.state !== "running") return;
      job.error = `timeout ${args.timeoutMs}ms`;
      job.state = "failed";
      const live = job.session;
      if (live !== undefined) {
        void Promise.resolve(live.abort()).catch(() => undefined);
        job.partial ??= this.#extractPartial(live); // before settle: abort may never unwind the run loop
        job.abortGrace = setTimeout(() => {
          if (job.finalized) return;
          job.finalized = true; // a hanging abort() must not leak the session forever
          live.dispose();
        }, ABORT_GRACE_MS);
      }
      job.endedAt ??= Date.now();
      this.#terminal(job);
    }, args.timeoutMs);
    void (async () => {
      let live: WorkerSession;
      try {
        live = await session;
      } catch (error) {
        clearTimeout(timer);
        job.state = "failed";
        job.error = `spawn failed: ${error instanceof Error ? error.message : String(error)}`;
        this.#terminal(job);
        return;
      }
      if (job.state !== "running") {
        // stopped while the session was still spawning
        clearTimeout(timer);
        live.dispose();
        this.#terminal(job);
        return;
      }
      job.session = live;
      job.timer = timer;
      try {
        await live.prompt(args.prompt);
        if (job.state === "running") {
          job.lines = await workerResultLines(job.json, live.state.messages, args.schema);
          job.state = "done";
        }
      } catch (error) {
        if (job.state === "running") {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        clearTimeout(timer);
        if (job.abortGrace !== undefined) clearTimeout(job.abortGrace);
        job.endedAt ??= Date.now();
        job.partial ??= this.#extractPartial(live); // before dispose: state may empty
        if (!job.finalized) {
          job.finalized = true;
          live.dispose();
        }
        this.#terminal(job); // guarded: at most one settlement per job
      }
    })();
    return id;
  }

  #require(id: string): Job {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new Error(`unknown agent job: ${id} (see agent list)`);
    return job;
  }

  status(id: string): string[] {
    const job = this.#require(id);
    const lines = [
      `state=${job.state}`,
      `name=${job.name}`,
      `elapsedMs=${(job.endedAt ?? Date.now()) - job.submittedAt}`,
    ];
    if (job.error !== undefined) lines.push(`error=${job.error}`);
    return lines;
  }

  async wait(id: string, timeoutMs?: number): Promise<{ ok: boolean; lines: string[] }> {
    const job = this.#require(id);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`wait timeoutMs must be a positive integer`);
    }
    if (timeoutMs === undefined) {
      await job.done;
    } else {
      await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    }
    return { ok: true, lines: this.status(id) };
  }

  async result(id: string): Promise<{ ok: boolean; lines: string[] }> {
    const job = this.#require(id);
    if (job.state === "running") throw new Error(`agent job ${id} is still running (agent wait first)`);
    if (job.state === "done") return { ok: true, lines: job.lines ?? [] };
    const detail = job.error === undefined ? "" : `: ${job.error}`;
    const partial = job.partial;
    const lines = [`agent job ${id} ${job.state}${detail}`];
    if (partial !== undefined && partial !== "") lines.push(...partial.split("\n"));
    return { ok: false, lines };
  }

  async stop(id: string): Promise<{ ok: boolean; lines: string[] }> {
    const job = this.#require(id);
    if (job.state === "running") {
      job.state = "stopped"; // claimed before abort so the run loop cannot overwrite it
      if (job.session === undefined) {
        await job.done; // still spawning: the spawn branch disposes and settles
      } else {
        await Promise.resolve(job.session.abort()).catch(() => undefined);
        await job.done;
      }
    }
    return { ok: true, lines: this.status(id) };
  }

  async steer(id: string, text: string): Promise<string> {
    const job = this.#require(id);
    if (job.state !== "running") throw new Error(`agent job ${id} is ${job.state}; steer needs a running job`);
    if (job.session === undefined) throw new Error(`agent job ${id} is still spawning; retry steer shortly`);
    return String(await Promise.resolve(job.session.steer(text)));
  }

  async follow(id: string, text: string): Promise<string> {
    const job = this.#require(id);
    if (job.state !== "running") throw new Error(`agent job ${id} is ${job.state}; follow needs a running job`);
    if (job.session === undefined) throw new Error(`agent job ${id} is still spawning; retry follow shortly`);
    return String(await Promise.resolve(job.session.followUp(text)));
  }

  list(): string[] {
    if (this.#jobs.size === 0) return ["(no agent jobs)"];
    return [...this.#jobs.values()]
      .map((job) => `${job.id} ${job.state} name=${job.name} elapsedMs=${(job.endedAt ?? Date.now()) - job.submittedAt}`)
      .sort();
  }

  /** Typed snapshot of every job, oldest first; the store mirror's source of truth. */
  entries(): AgentJobEntry[] {
    return [...this.#jobs.values()]
      .map((job) => ({
        id: job.id,
        name: job.name,
        state: job.state,
        ...(job.error === undefined ? {} : { error: job.error }),
        prompt: job.prompt,
        ...(job.jobTool === undefined ? {} : { jobTool: job.jobTool }),
        submittedAt: job.submittedAt,
        ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
      }))
      .sort((left, right) => left.submittedAt - right.submittedAt);
  }

  #extractPartial(session: WorkerSession): string | undefined {
    const messages = session.state?.messages;
    if (!Array.isArray(messages)) return undefined;
    let last: unknown;
    for (const message of messages) {
      if ((message as { role?: unknown }).role === "assistant") last = message;
    }
    if (last === undefined) return undefined;
    const content = (last as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  /** Abort and dispose everything; used when the host session goes down. */
  close(): void {
    for (const job of this.#jobs.values()) {
      if (job.timer !== undefined) clearTimeout(job.timer);
      if (job.abortGrace !== undefined) clearTimeout(job.abortGrace);
      if (job.state === "running" && job.session !== undefined) {
        job.state = "stopped";
        void Promise.resolve(job.session.abort()).catch(() => undefined);
      }
    }
    this.#jobs.clear();
  }
}

const jobIdArg = (argv: string[], command: string): string => {
  const id = argv[2];
  if (id === undefined || id === "") throw new Error(`${command} needs a job id (agent list shows them)`);
  return id;
};

/** Bridge command: `agent <subcommand>` job forms; anything else falls through. */
export const createAgentJobsCommand = (
  jobs: AgentJobs,
  /** Model lister for `agent models`; defaults to the host runtime registry. */
  listModels: () => Promise<readonly HostModelInfo[]> = listHostModels,
): ExternalCommandHandler => {
  return async (argv: string[]) => {
    if (argv[0] !== "agent") return undefined;
    switch (argv[1]) {
      case "models":
        return { ok: true, lines: formatModelLines(await listModels()) };
      case "submit": {
        const id = jobs.submit(parseAgentArgv(argv.slice(2)));
        return { ok: true, lines: [`id=${id}`] };
      }
      case "status":
        return { ok: true, lines: jobs.status(jobIdArg(argv, "status")) };
      case "wait": {
        const id = jobIdArg(argv, "wait");
        let timeoutMs: number | undefined;
        if (argv[3] !== undefined) {
          if (!argv[3].startsWith("timeoutMs=")) throw new Error(`unknown wait argument: ${argv[3]}\n${AGENT_JOBS_HELP}`);
          timeoutMs = Number(argv[3].slice("timeoutMs=".length));
        }
        return await jobs.wait(id, timeoutMs);
      }
      case "result":
        return await jobs.result(jobIdArg(argv, "result"));
      case "stop":
        return await jobs.stop(jobIdArg(argv, "stop"));
      case "steer":
      case "follow": {
        const id = jobIdArg(argv, argv[1]);
        const fileArg = argv[3];
        if (fileArg === undefined || !fileArg.startsWith("textFile=")) {
          throw new Error(`${argv[1]} needs textFile=<path>\n${AGENT_JOBS_HELP}`);
        }
        const text = readTextFile("textFile", fileArg.slice("textFile=".length));
        const disposition = argv[1] === "steer" ? await jobs.steer(id, text) : await jobs.follow(id, text);
        return { ok: true, lines: [`state=${disposition}`] };
      }
      case "list":
        return { ok: true, lines: jobs.list() };
      default:
        return undefined; // blocking form: agent promptFile=…
    }
  };
};
