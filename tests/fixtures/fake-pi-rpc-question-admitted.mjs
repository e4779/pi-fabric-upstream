#!/usr/bin/env node
// RPC fake pi for routed child questions behind Fabric's model admission:
// it answers get_state/set_model/set_thinking_level like a real child, then,
// after the prompt, raises one extension_ui_request (a select over A and B)
// and records the worker's extension_ui_response to FAKE_PI_QUESTION_LOG.
import fs from "node:fs";
import readline from "node:readline";

const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const recordPath = process.env.FAKE_PI_QUESTION_LOG;
const record = (entry) => {
  if (recordPath) fs.appendFileSync(recordPath, JSON.stringify(entry) + "\n");
};

let model;
let thinkingLevel = "medium";
let prompted = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (data) => send({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "get_state") {
    reply({ ...(model ? { model } : {}), thinkingLevel, isStreaming: false });
  } else if (command.type === "set_model") {
    model = { provider: command.provider, id: command.modelId };
    reply(model);
  } else if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    reply();
  } else if (command.type === "prompt" && !prompted) {
    prompted = true;
    send({ type: "response", command: "prompt", success: true });
    send({ type: "agent_start" });
    send({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["A", "B"] });
  } else if (command.type === "extension_ui_response") {
    record(command);
    send({
      type: "message_end",
      message: {
        role: "assistant",
        provider: model?.provider,
        model: model?.id,
        content: [{ type: "text", text: `answer ${JSON.stringify(command)}` }],
      },
    });
    setTimeout(() => send({ type: "agent_settled" }), 50);
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 5));
process.stdin.resume();
