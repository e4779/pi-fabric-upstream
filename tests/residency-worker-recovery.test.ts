import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ResidencyClient } from "../src/residency/client.js";
import { RESIDENT_HOST_FORMAT } from "../src/residency/protocol.js";
import { writeWorkerRecovery, removeWorkerRecovery } from "../src/agents/worker-recovery.js";

const roots: string[] = [], clients: ResidencyClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup(status = "stopped", marker = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-recovery-")); roots.push(root);
  const id = "e".repeat(32), directory = path.join(root, "runs", id), rootId = "f".repeat(64);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.join(root, "agents"));
  const record = { id, name: "worker", task: "go", runner: "pi-durable", status, cwd: process.cwd(), startedAt: 1, updatedAt: 2, finishedAt: 2, turns: 1, toolCalls: 0, text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const metadataPath = path.join(root, "agents", id + ".json");
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify(record));
  fs.writeFileSync(metadataPath, JSON.stringify({ format: RESIDENT_HOST_FORMAT, rootId, id, runDirectory: directory, handle: record, createdAt: 1, updatedAt: 1 }));
  if (marker) writeWorkerRecovery(directory, { format: 1, id, runner: "pi-durable", deadlineAt: Date.now() + 60_000, pid: 2147483646, writtenAt: 1, launch: { id, name: "worker", cwd: process.cwd(), workerPath: path.resolve("src/worker.ts"), workerArguments: ["--id", id] } });
  const client = new ResidencyClient({ config: { rootId, residencyRoot: root } } as any); clients.push(client);
  return { client, id, directory, record, metadata: () => JSON.parse(fs.readFileSync(metadataPath, "utf8")) };
}
it("recovers an externally stopped worker before returning or consuming completion", async () => {
  const { client, id, directory, record, metadata } = setup();
  const start = vi.spyOn(client, "ensureHost").mockImplementation(async () => {
    expect(metadata().completionConsumedAt).toBeUndefined();
    removeWorkerRecovery(directory);
    fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ ...record, status: "completed", text: "recovered" }));
    return { format: RESIDENT_HOST_FORMAT, hostId: client.hostId, pid: process.pid, token: "test-owner", startedAt: 1, readyAt: 1 };
  });
  expect(await client.waitAgent(id, AbortSignal.timeout(2000))).toMatchObject({ status: "completed", text: "recovered" });
  expect(start).toHaveBeenCalledOnce(); expect(metadata().completionConsumedAt).toBeTypeOf("number");
});
it.each([["stopped", false], ["completed", true], ["failed", true], ["timed_out", true]])("returns authoritative %s without starting a host (marker %s)", async (status, marker) => {
  const { client, id, metadata } = setup(status as string, marker as boolean);
  const start = vi.spyOn(client, "ensureHost").mockRejectedValue(new Error("must not start"));
  expect((await client.waitAgent(id)).status).toBe(status);
  expect(start).not.toHaveBeenCalled(); expect(metadata().completionConsumedAt).toBeTypeOf("number");
});
it("does not consume a recoverable stop when starting the new owner fails", async () => {
  const { client, id, metadata } = setup();
  vi.spyOn(client, "ensureHost").mockRejectedValue(new Error("host unavailable"));
  await expect(client.waitAgent(id)).rejects.toThrow("host unavailable");
  expect(metadata().completionConsumedAt).toBeUndefined();
});
