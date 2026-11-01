#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline";

// A fake RPC host with a counted synthetic provider boundary, never network I/O.
const root = process.env.FAKE_PROMPT_ROOT;
const scenario = fs.readFileSync(`${root}/scenario`, "utf8");
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
fs.writeFileSync(`${root}/child-pid`, String(process.pid));
fs.writeFileSync(`${root}/sends`, "0");
fs.writeFileSync(`${root}/prompts`, "0");
const input = createInterface({ input: process.stdin });
const finish = () => {
  fs.writeFileSync(`${root}/sends`, "1");
  emit({ type: "message_end", message: { role: "assistant", content: "done" } });
  emit({ type: "turn_end" });
  emit({ type: "agent_settled" });
};
input.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "steer" || frame.type === "follow_up") {
    emit({ type: "response", command: frame.type, success: true, data: { disposition: "handled" } });
    finish();
    return;
  }
  if (frame.type !== "prompt") return;
  fs.writeFileSync(`${root}/prompts`, String(Number(fs.readFileSync(`${root}/prompts`, "utf8")) + 1));
  const ack = disposition => emit({ type: "response", id: frame.id, command: "prompt", success: true,
    ...(disposition ? { data: { disposition } } : {}) });
  if (scenario === "handled-notice") {
    emit({ type: "extension_ui_request", id: "ui", method: "notify", notifyType: "warning",
      message: "Synthetic refusal. Select in-group/model, then send again." });
  }
  if (scenario.startsWith("handled")) {
    const response = { type: "response", id: frame.id, command: "prompt", success: true,
      data: { disposition: "handled" } };
    if (scenario === "handled-tail") {
      process.stdout.write(JSON.stringify(response), () => process.exit(0));
      return;
    }
    emit(response);
    emit(response);
    if (scenario === "handled-stubborn") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 60_000);
    }
    // An extension command reports "handled" and starts its own turn afterwards.
    if (scenario === "handled-then-turn") {
      emit({ type: "agent_start" });
      finish();
    }
  } else if (scenario === "legacy" || scenario === "cancel") {
    ack();
    fs.writeFileSync(`${root}/acknowledged`, "true");
  } else if (scenario === "native-reject") {
    emit({ type: "response", id: frame.id, command: "prompt", success: false, error: "native rejection" });
  } else if (scenario === "race" || scenario === "started-handled") {
    emit({ type: "agent_start" });
    ack(scenario === "race" ? "started" : "handled");
    finish();
  } else if (scenario === "control") {
    ack("started");
    emit({ type: "agent_start" });
    emit({ type: "response", id: "operator", command: "prompt", success: true, data: { disposition: "handled" } });
    fs.writeFileSync(`${root}/active`, "true");
  } else {
    ack(scenario);
    setTimeout(() => {
      emit({ type: "agent_start" });
      finish();
    }, 20);
  }
});
input.on("close", () => { if (scenario !== "handled-stubborn") process.exit(0); });
