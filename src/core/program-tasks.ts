import type { FabricShellJobHandle, FabricShellJobStore } from "./shell-jobs.js";

type ProgramJob = FabricShellJobHandle & { stop(reason?: string): boolean };

export interface FabricProgramRunOptions {
  code: string;
  description?: string;
  cwd?: string;
  /** Pi's tool signal. It cancels the program only while the program is in the foreground. */
  parentSignal?: AbortSignal;
  jobs: () => FabricShellJobStore | undefined;
}

export type FabricProgramRace<T> =
  | { detached: false; value: T }
  | { detached: true; job: ProgramJob; elapsedMs: number };

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
  detach(): boolean {
    if (!this.waiting) return false;
    const jobs = this.options.jobs();
    if (!jobs) return false;
    let job: ProgramJob;
    try {
      job = jobs.begin("fabric_exec", this.options.code, {
        ...(this.options.description ? { description: this.options.description } : {}),
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
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

  /** Settles with the program, or earlier when it is detached. */
  async race<T>(work: Promise<T>): Promise<FabricProgramRace<T>> {
    const detached = new Promise<"detached">((resolve) => {
      this.#wake = () => resolve("detached");
      if (this.#job) resolve("detached");
    });
    const first = await Promise.race([
      work.then((value) => ({ value }), (error: unknown) => ({ error })),
      detached,
    ]);
    if (first === "detached") return { detached: true, job: this.#job!, elapsedMs: Date.now() - this.#startedAt };
    this.#settled = true;
    this.owner.release(this);
    if ("error" in first) throw first.error;
    return { detached: false, value: first.value };
  }

  /** Records the program's final model-facing text and ends the task. */
  async complete(text: string, success: boolean): Promise<void> {
    this.#settled = true;
    const job = this.#job;
    if (!job || job.finished) return;
    job.append(Buffer.from(`${text}\n`));
    job.exitCode = success ? 0 : 1;
    await job.finish(job.exitCode);
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
