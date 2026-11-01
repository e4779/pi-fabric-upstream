import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", async ({ index, task }) => {
  if (task.mode === "throw") throw new Error("proof fixture failed");
  if (task.mode === "exit") process.exit(0);
  if (task.mode === "stall") return;
  if (task.mode === "missing-result") { parentPort.postMessage({ index }); return; }
  if (task.delay) await new Promise(resolve => setTimeout(resolve, task.delay));
  parentPort.postMessage({ index: task.mode === "wrong-id" ? index + 1 : index, result: { value: task.value, threadId } });
});
