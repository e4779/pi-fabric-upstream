import type { FabricShellJobHandle, FabricShellJobStore } from "./shell-jobs.js";
import type { FabricSandboxTerminationReason } from "../runtime/kernel.js";

type ProgramJob = FabricShellJobHandle & { stop(reason?: string): boolean };

export interface FabricProgramRunOptions {
  code: string;
  description?: string;
  cwd?: string;
  /** Pi's tool signal. It cancels the program only while the program is in the foreground. */
  parentSignal?: AbortSignal;
  jobs: () => FabricShellJobStore | undefined;
  /** Owning session id; stamped into the detached task's log for the orphan sweep. */
  ownerId?: string;
  /** Zero-action auto-detach: a program still running past this many ms moves itself to the task store and the tool call returns its handle. 0/undefined keeps the program in the foreground until it settles or the user detaches it. */
  hangMs?: number;
}

/** Who moved the program to the background: an explicit `background: true` request, the user's chord/command, or the zero-action hang timer. */
export type FabricProgramDetachReason = "requested" | "user" | "hang";

export type FabricProgramRace<T> =
  | { detached: false; value: T }
  | { detached: true; job: ProgramJob; elapsedMs: number; reason: FabricProgramDetachReason };

/**
 * One `fabric_exec` program that can leave its tool call and keep running as a
 * session task. The program always runs on this run's own signal; Pi's tool
 * signal reaches it only until it is detached.
 */
export class FabricProgramRun {
  readonly #relay = new AbortController();
  readonly #startedAt = Date.now();
  readonly #onParentAbort = (): void => {
    if (!this.#job) this.#relay.abort(this.options.parentSignal?.reason ?? new Error("fabric_exec aborted"));
  };
  #job: ProgramJob | undefined;
  #settled = false;
  #detachReason: FabricProgramDetachReason = "user";
  #progress: string | undefined;
  #wake: (() => void) | undefined;

  constructor(readonly owner: FabricProgramTasks, readonly options: FabricProgramRunOptions) {
    const parent = options.parentSignal;
    if (parent?.aborted) this.#onParentAbort();
    else parent?.addEventListener("abort", this.#onParentAbort, { once: true });
  }

  get signal(): AbortSignal { return this.#relay.signal; }
  get job(): ProgramJob | undefined { return this.#job; }
  get waiting(): boolean { return !this.#job && !this.#settled && !this.#relay.signal.aborted; }

  /** Moves the program into the session task store; false when it cannot leave. */
  detach(reason: FabricProgramDetachReason = "user"): boolean {
    if (!this.waiting) return false;
    this.#detachReason = reason;
    const jobs = this.options.jobs();
    if (!jobs) return false;
    let job: ProgramJob;
    try {
      job = jobs.begin("fabric_exec", this.options.code, {
        ...(this.options.description ? { description: this.options.description } : {}),
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(this.options.ownerId !== undefined ? { ownerId: this.options.ownerId } : {}),
      });
    } catch {
      return false;
    }
    this.#job = job;
    this.options.parentSignal?.removeEventListener("abort", this.#onParentAbort);
    job.abort.signal.addEventListener("abort", () => this.#relay.abort(job.abort.signal.reason), { once: true });
    if (this.#progress) job.append(Buffer.from(`${this.#progress}\n`));
    job.spill();
    void job.persistLog().catch(() => undefined);
    this.owner.release(this);
    this.#wake?.();
    return true;
  }

  /** Mirrors changed progress into the task's output once detached. */
  progress(text: string | undefined): void {
    if (!text || text === this.#progress) return;
    this.#progress = text;
    this.#job?.append(Buffer.from(`${text}\n`));
  }

  /** Settles with the program, or earlier when it is detached (by the user, `background: true`, or the zero-action hang timer). */
  async race<T>(work: Promise<T>): Promise<FabricProgramRace<T>> {
    const detached = new Promise<"detached">((resolve) => {
      this.#wake = () => resolve("detached");
      if (this.#job) resolve("detached");
    });
    // Zero-action contract: past the hang threshold the RUNNING program
    // detaches itself instead of holding the turn; the caller receives a task
    // handle and the wake event keeps delivering the result. A timer that
    // cannot detach (no store, already settled) simply leaves the race to work.
    const hangMs = this.options.hangMs ?? 0;
    const hangTimer = hangMs > 0 ? setTimeout(() => { this.detach("hang"); }, hangMs) : undefined;
    hangTimer?.unref?.();
    let first: "detached" | { value: T } | { error: unknown };
    try {
      first = await Promise.race([
        work.then((value) => ({ value }), (error: unknown) => ({ error })),
        detached,
      ]);
    } finally {
      if (hangTimer) clearTimeout(hangTimer);
    }
    if (first === "detached") return { detached: true, job: this.#job!, elapsedMs: Date.now() - this.#startedAt, reason: this.#detachReason };
    this.#settled = true;
    this.owner.release(this);
    if ("error" in first) throw first.error;
    return { detached: false, value: first.value };
  }

  /**
   * Records the program's final model-facing text and ends the task. The
   * runtime's typed `terminationReason` rides along so the wake event names a
   * wall-deadline death (`timed_out`) instead of a bare `failed`.
   */
  async complete(text: string, success: boolean, stopReason?: FabricSandboxTerminationReason): Promise<void> {
    this.#settled = true;
    const job = this.#job;
    if (!job) return;
    job.append(Buffer.from(`${text}\n`));
    job.exitCode = success ? 0 : 1;
    // finish() is its own guard: no finished-check here for a concurrent
    // finisher (session close) to slip between the check and the terminal write.
    await job.finish(job.exitCode, undefined, stopReason);
  }
}

/** The foreground programs that the Ctrl+B chord can still detach. */
export class FabricProgramTasks {
  readonly #waiting = new Set<FabricProgramRun>();

  begin(options: FabricProgramRunOptions): FabricProgramRun {
    const run = new FabricProgramRun(this, options);
    this.#waiting.add(run);
    return run;
  }

  release(run: FabricProgramRun): void {
    this.#waiting.delete(run);
  }

  waiting(): number {
    let count = 0;
    for (const run of this.#waiting) if (run.waiting) count++;
    return count;
  }

  detachWaiting(): number {
    let count = 0;
    for (const run of [...this.#waiting]) if (run.detach()) count++;
    return count;
  }
}
