import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { authorizeWorkerRecovery, readWorkerRecovery, removeWorkerRecovery, workerRecoveryMismatch, writeWorkerRecovery, workerRecoveryAuthorityRoot, type WorkerRecoveryRecord } from "../src/agents/worker-recovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workerRecoveryAuthorityRoot(root), { recursive: true, force: true }); } });
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-authority-")); roots.push(root);
  const id = "a".repeat(32), directory = path.join(root, id); fs.mkdirSync(directory);
  const record: WorkerRecoveryRecord = { format: 1, id, runner: "pi-durable", pid: 1234, deadlineAt: Date.now() + 60_000, writtenAt: Date.now(), launch: {
    id, name: "test", cwd: root, workerPath: "/trusted/worker.js", workerArguments: [
      "--id", id, "--cwd", root, "--runner", "pi-durable",
      ...["status-file", "lifecycle-file", "task-file", "log-file"].flatMap(name => ["--" + name, path.join(directory, name === "status-file" ? "status.json" : name === "lifecycle-file" ? "lifecycle.jsonl" : name)]),
      "--pi-binary", "/trusted/pi", "--claude-binary", "/trusted/claude", "--veda-binary", "/trusted/veda",
      "--extensions", "true", "--fabric-extension", "/trusted/extension", "--kernel", "python", "--python-runtime", "cpython",
      "--tools", '["read","fabric_exec"]', "--granted-risks", '["agent"]', "--depth", "2", "--max-tokens", "1000",
      "--full-code-mode", "true", "--scope", '{"kind":"session"}', "--write-policy", '{"mode":"deny"}',
      "--inherited-session-pins", '[{"pool":"trusted"}]', "--capability-requirements", '["fs.read"]', "--capability-digest", "trusted",
      "--project-root", root, "--mesh-root", root, "--run-root", path.join(directory, "nested"), "--owner-host-id", "host", "--owner-identity-id", "identity",
    ],
  } };
  const expected = { runDirectory: directory, workerPath: record.launch.workerPath, cwd: root, policy: "trusted-host-policy" };
  authorizeWorkerRecovery(directory, record, expected.policy); writeWorkerRecovery(directory, record);
  return { root, directory, record, expected };
};
it("accepts the entire host-authorized launch, including supported optional capabilities", () => {
  const { directory, expected } = setup();
  expect(workerRecoveryMismatch(readWorkerRecovery(directory)!, expected)).toBeUndefined();
  const relative = path.relative(path.dirname(directory), workerRecoveryAuthorityRoot(path.dirname(directory)));
  expect(relative.startsWith("..")).toBe(true);
});
it("pins EVERY launch argument, rejecting altered, removed, appended and duplicated settings", () => {
  const { directory, record, expected } = setup();
  for (let index = 1; index < record.launch.workerArguments.length; index += 2) {
    const changed = structuredClone(record); changed.launch.workerArguments[index] += "-attacker";
    writeWorkerRecovery(directory, changed);
    expect(workerRecoveryMismatch(readWorkerRecovery(directory)!, expected), record.launch.workerArguments[index - 1]).toBe("host launch receipt");
    const removed = structuredClone(record); removed.launch.workerArguments.splice(index - 1, 2);
    expect(workerRecoveryMismatch(removed, expected)).toBe("host launch receipt");
  }
  for (const extra of [["--runner", "pi"], ["--pi-binary", "/attacker"], ["--future-capability", "true"]]) {
    const changed = structuredClone(record); changed.launch.workerArguments.push(...extra);
    expect(workerRecoveryMismatch(changed, expected)).toBe("host launch receipt");
  }
});
it("rejects forged PID/deadline and changed current host policy, even with an unchanged launch", () => {
  const { record, expected } = setup();
  for (const changed of [{ ...record, pid: process.pid }, { ...record, deadlineAt: record.deadlineAt + 1 }]) {
    expect(workerRecoveryMismatch(changed, expected)).toBe("host launch receipt");
  }
  expect(workerRecoveryMismatch(record, { ...expected, policy: "stricter-host" })).toBe("host launch receipt");
});
it("does not authorize old marker-only launches and removes the receipt on settlement", () => {
  const { directory, record, expected } = setup(); removeWorkerRecovery(directory);
  writeWorkerRecovery(directory, record);
  expect(workerRecoveryMismatch(readWorkerRecovery(directory)!, expected)).toBe("host launch receipt");
  expect(fs.existsSync(path.join(workerRecoveryAuthorityRoot(path.dirname(directory)), record.id + ".json"))).toBe(false);
});
