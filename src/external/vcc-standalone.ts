#!/usr/bin/env bun
/**
 * Standalone vcc — session file views without a bridge: summary, branch,
 * entries, one entry. Usage:
 *   bun vcc-standalone.ts [session.jsonl] [entries [n] | branch | entry <id>]
 * Without a file argument the newest session for the current cwd is used.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  parseVccSession,
  renderVccBranch,
  renderVccEntries,
  renderVccEntry,
  renderVccSummary,
  vccActiveLeaf,
} from "./vcc.js";

const encodeCwdDir = (cwd: string): string =>
  cwd.replace(/^\//, "").replace(/[/\\:]/g, "-");

const discoverSessionFile = (): string | undefined => {
  const sessionsRoot = path.join(homedir(), ".pi", "agent", "sessions");
  const dir = path.join(sessionsRoot, `--${encodeCwdDir(process.cwd())}--`);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  return files.sort((a, b) => {
    const statA = fs.statSync(a).mtimeMs;
    const statB = fs.statSync(b).mtimeMs;
    return statB - statA;
  })[0];
};

const input = process.argv.slice(2).filter((argument) => argument !== "");
let file = input[0];
let view = input.slice(1);
if (file !== undefined && !fs.existsSync(file)) {
  // not a file: treat everything as the view
  view = input;
  file = undefined;
}
file ??= discoverSessionFile();
if (file === undefined) {
  console.error("vcc: no session file found for this cwd (pass one explicitly)");
  process.exit(2);
}
const session = parseVccSession(fs.readFileSync(file, "utf8"));
const leaf = vccActiveLeaf(session.entries);

const out = (lines: string[]): void => {
  for (const line of lines) console.log(line);
};

try {
  switch (view[0] ?? "") {
    case "":
      out(renderVccSummary(session, leaf, file));
      break;
    case "entries": {
      const limit = view[1] === undefined ? 20 : Number(view[1]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`entries takes a positive count`);
      out(renderVccEntries(session, leaf, limit));
      break;
    }
    case "branch":
      out(renderVccBranch(session, leaf));
      break;
    case "entry": {
      if (view[1] === undefined) throw new Error("entry needs an id");
      const lines = renderVccEntry(session, view[1]);
      if (lines === undefined) throw new Error(`no entry with id ${view[1]}`);
      out(lines);
      break;
    }
    default:
      throw new Error(`unknown view: ${view[0]}`);
  }
} catch (error) {
  console.error(`vcc: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
