import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { runWorkerTasks } from "../scripts/verified-kernel-pool.js";

const worker = new URL("./fixtures/verified-kernel-pool-worker.mjs", import.meta.url);

describe("bounded verified-kernel workers", () => {
  it("runs every task exactly once, preserves input order, and reuses only the bounded worker set", async () => {
    const tasks = Array.from({ length: 9 }, (_, value) => ({ value, delay: value === 0 ? 30 : 0 }));
    const observed: number[] = [];
    const results = await runWorkerTasks<(typeof tasks)[number], { value: number; threadId: number }>(tasks, { worker, jobs: 2, onResult: result => { observed.push(result.value); } });
    expect(results.map(result => result.value)).toEqual(tasks.map(task => task.value));
    expect([...observed].sort((a, b) => a - b)).toEqual(tasks.map(task => task.value));
    expect(new Set(results.map(result => result.threadId)).size).toBe(2);
  });

  it("does not start workers for an empty plan and refuses invalid caps", async () => {
    expect(await runWorkerTasks([], { worker, jobs: 1 })).toEqual([]);
    for (const jobs of [0, 5, 1.5, NaN]) await expect(runWorkerTasks([], { worker, jobs })).rejects.toThrow(/integer from 1 to 4/);
    await expect(runWorkerTasks([], { worker, jobs: 1, timeoutMs: 0 })).rejects.toThrow(/timeout must be positive/);
  });

  it.each(["throw", "exit", "wrong-id", "missing-result"])("fails closed and terminates siblings after %s", async mode => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    await expect(runWorkerTasks([{ mode }, { mode: "stall" }], { worker, jobs: 2 })).rejects.toThrow(/proof fixture failed|exited|Invalid proof worker response/);
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it("bounds hung workers without accepting a partial result", async () => {
    await expect(runWorkerTasks([{ value: 1 }, { mode: "stall" }], { worker, jobs: 1, timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  it("stops every worker when result validation refuses a result", async () => {
    await expect(runWorkerTasks([{ value: 1 }, { mode: "stall" }], { worker, jobs: 2, onResult: () => { throw new Error("unchecked proof"); } })).rejects.toThrow("unchecked proof");
  });
});
