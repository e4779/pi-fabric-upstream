#!/usr/bin/env bun
/**
 * Standalone memory recall — the no-session tier of `ai recall`. Reads the
 * same agent tree the engine serves (config defaults; fabric.json memory
 * overrides are engine-side today) and renders the same text as the bridge
 * command. Usage: bun recall-standalone.ts [flags] query terms...
 */
import { DEFAULT_FABRIC_CONFIG } from "../config.js";
import { resolveAgentDir } from "../core/agent-dir.js";
import { renderRecall, runRecall } from "./recall.js";

const usage = [
  "usage: recall-standalone [flags] query terms...",
  "flags:",
  "  --scope <scope>      session | project | global (default: global)",
  "  --phrase | --regex   query mode (default: literal)",
  "  --all                require every term in one hot entry",
  "  --limit <n>          page size",
  "  --offset <n>         ranked-hit offset",
  "  --branches <b>       active | all",
].join("\n");

const args: Record<string, unknown> = {};
const terms: string[] = [];
const input = process.argv.slice(2);
for (let index = 0; index < input.length; index++) {
  const argument = input[index];
  if (argument === undefined) continue;
  const value = (): string => {
    const next = input[++index];
    if (next === undefined) throw new Error(`${argument} needs a value`);
    return next;
  };
  const numberValue = (): number => {
    const parsed = Number(value());
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${argument} needs a non-negative integer`);
    return parsed;
  };
  switch (argument) {
    case "--scope":
      args.scope = value();
      break;
    case "--phrase":
      args.queryMode = "phrase";
      break;
    case "--regex":
      args.queryMode = "regex";
      break;
    case "--all":
      args.queryMatch = "all";
      break;
    case "--limit":
      args.pageSize = numberValue();
      break;
    case "--offset":
      args.offset = numberValue();
      break;
    case "--branches":
      args.branches = value();
      break;
    case "-h":
    case "--help":
      console.log(usage);
      process.exit(0);
    default:
      if (argument.startsWith("--")) throw new Error(`unknown flag: ${argument}\n${usage}`);
      terms.push(argument);
  }
}
args.query = terms.join(" ");
if (args.query === "") {
  console.error(usage);
  process.exit(2);
}
if (args.scope === undefined) args.scope = "global";

try {
  const response = await runRecall(args, {
    agentDir: resolveAgentDir(),
    cwd: process.cwd(),
    config: DEFAULT_FABRIC_CONFIG.memory,
  });
  const rendered = renderRecall(response);
  for (const line of rendered.lines) console.log(line);
  process.exit(rendered.ok ? 0 : 1);
} catch (error) {
  console.error(`recall: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
