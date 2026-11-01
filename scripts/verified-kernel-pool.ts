import { Worker } from "node:worker_threads";

/** Isolated, bounded proof workers; neither cached verdicts nor partial results pass. */
export async function runWorkerTasks<T, R>(tasks: readonly T[], options: {
  worker: URL; jobs: number; timeoutMs?: number; onResult?: (result: R, task: T) => void;
}): Promise<R[]> {
  if (!Number.isSafeInteger(options.jobs) || options.jobs < 1 || options.jobs > 4) throw new RangeError("Proof jobs must be an integer from 1 to 4");
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Proof worker timeout must be positive");
  const workers: Worker[] = [];
  const results: R[] = new Array(tasks.length);
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(options.jobs, tasks.length) }, async () => {
      const worker = new Worker(options.worker);
      workers.push(worker);
      // next++ happens synchronously in this thread, before awaiting a worker.
      for (let index = next++; index < tasks.length; index = next++) {
        const result = await new Promise<R>((resolve, reject) => {
          const clean = (): void => {
            clearTimeout(timer);
            worker.off("message", message); worker.off("error", error); worker.off("exit", exit);
          };
          const message = (value: unknown): void => {
            clean();
            if (!value || typeof value !== "object" || !("index" in value) || value.index !== index || !("result" in value)) {
              reject(new Error(`Invalid proof worker response for task ${index}`)); return;
            }
            resolve(value.result as R);
          };
          const error = (cause: Error): void => { clean(); reject(cause); };
          const exit = (code: number): void => error(new Error(`Proof worker exited (${code}) before task ${index} completed`));
          const timer = setTimeout(() => error(new Error(`Proof worker timed out on task ${index}`)), timeoutMs);
          worker.once("message", message); worker.once("error", error); worker.once("exit", exit);
          try { worker.postMessage({ index, task: tasks[index] }); } catch (cause) { error(cause as Error); }
        });
        options.onResult?.(result, tasks[index]!);
        results[index] = result;
      }
    }));
    return results;
  } finally {
    // Rejection, early exit and deadlines stop every sibling, not just the waiter.
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}
