#!/usr/bin/env bun
/**
 * Standalone expand — the no-engine tier of `ai show`: resolves a recall
 * hit (8-hex memory id, or session file/sid + index) to the full entry
 * text straight from the memory index + session files. Never touches the
 * bridge, so it works regardless of engine version in the live socket.
 * Usage: bun expand-standalone.ts id=<8hex> | session=<path|sid> idx=<n[,…]>
 *        [offset=] [textOffset=] [maxChars=] [branches=]
 */
import { DEFAULT_FABRIC_CONFIG } from "../config.js";
import { resolveAgentDir } from "../core/agent-dir.js";
import { parseExpandArgv, runExpandCall } from "./expand.js";
import type { MemoryProviderContext } from "../memory/request-context.js";

const input = process.argv.slice(2).filter((argument) => argument !== "");
let call;
try {
  call = parseExpandArgv(input);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

try {
  const context: MemoryProviderContext = {
    agentDir: resolveAgentDir(),
    cwd: process.cwd(),
    config: DEFAULT_FABRIC_CONFIG.memory,
  };
  const result = await runExpandCall(call, context);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(`expand: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
