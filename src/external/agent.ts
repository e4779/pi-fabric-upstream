import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExternalCommandHandler } from "./bridge.js";

/**
 * `agent` on the external bridge: a bounded worker over the running host's
 * own SDK (`loadHostSdk`). Children are full-control sessions — an empty
 * resource loader, in-memory session manager, compaction off — so nothing
 * (fabric included) loads twice in this process. The blocking form holds one
 * connection until the child settles; the job form (agent-jobs.ts) shares
 * the same session factory. Concurrency is N parallel connections.
 */

export const AGENT_ARGV_HELP = [
  "agent arguments (key=value lines after the command):",
  "  promptFile=<path>   required; file with the full worker prompt",
  "  tools=a,b,c         tool names; empty line pair (tools=) means none",
  "  cwd=<path>          working directory (default: host cwd)",
  "  model=<provider/id> override the configured default model",
  "  timeoutMs=<n>       abort bound (default 600000)",
  "  json=on             reply must be a JSON value; extracted and re-emitted compact",
  "  name=<label>        job label for lists (job form only)",
].join("\n");

export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

const WORKER_SYSTEM_PROMPT = [
  "You are a bounded worker agent invoked programmatically by an orchestrator.",
  "Complete exactly the task in the prompt, then stop. Be concise and factual;",
  "state findings and evidence, not generalities. When the caller asks for JSON,",
  "emit only the JSON value — no prose, no markdown fences.",
].join("\n");

export interface AgentCommandArgs {
  prompt: string;
  tools: string[];
  cwd?: string;
  model?: string;
  timeoutMs: number;
  json: boolean;
  name?: string;
}

export const parseAgentArgv = (lines: readonly string[]): AgentCommandArgs => {
  const raw: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`malformed agent argument (expected key=value): ${line}\n${AGENT_ARGV_HELP}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!["promptFile", "tools", "cwd", "model", "timeoutMs", "json", "name"].includes(key)) {
      throw new Error(`unknown agent argument: ${key}\n${AGENT_ARGV_HELP}`);
    }
    raw[key] = value;
  }
  const promptFile = raw.promptFile;
  if (promptFile === undefined || promptFile === "") {
    throw new Error(`agent needs a promptFile=<path> line\n${AGENT_ARGV_HELP}`);
  }
  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf8");
  } catch (error) {
    throw new Error(`cannot read promptFile ${promptFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const timeoutRaw = raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs);
  if (timeoutRaw !== undefined && (!Number.isInteger(timeoutRaw) || timeoutRaw <= 0)) {
    throw new Error(`timeoutMs must be a positive integer, got: ${raw.timeoutMs}`);
  }
  return {
    prompt,
    tools: raw.tools === undefined ? [] : raw.tools.split(",").map(t => t.trim()).filter(Boolean),
    ...(raw.cwd ? { cwd: raw.cwd } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    timeoutMs: timeoutRaw ?? DEFAULT_AGENT_TIMEOUT_MS,
    json: raw.json === "on",
    ...(raw.name ? { name: raw.name } : {}),
  };
};

/** The session surface the worker paths drive; the SDK session fits structurally. */
export interface WorkerSession {
  prompt(text: string): Promise<void>;
  steer(text: string): string | Promise<string>;
  followUp(text: string): string | Promise<string>;
  abort(): Promise<void> | void;
  dispose(): void;
  readonly state: { readonly messages: readonly unknown[] };
}

export const createWorkerSession = async (args: {
  cwd?: string;
  model?: string;
  tools: string[];
}): Promise<WorkerSession> => {
  const { loadHostSdk } = await import("../core/host-sdk.js");
  const sdk = await loadHostSdk();
  const cwd = args.cwd ?? process.cwd();
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => WORKER_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
  let model: unknown;
  if (args.model !== undefined) {
    const separator = args.model.indexOf("/");
    if (separator <= 0 || separator === args.model.length - 1) {
      throw new Error(`model must be provider/id, got: ${args.model}`);
    }
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    // Static catalog read: provider names are a typed union, our input is a
    // runtime string — narrow through an untyped view of the same function.
    const lookup = getModel as unknown as (provider: string, modelId: string) => unknown;
    model = lookup(args.model.slice(0, separator), args.model.slice(separator + 1));
    if (model === undefined || model === null) throw new Error(`unknown model: ${args.model}`);
  }
  const { session } = await sdk.createAgentSession({
    cwd,
    ...(model === undefined ? {} : { model: model as never }),
    tools: args.tools,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }),
  });
  return session as unknown as WorkerSession;
};

/** @internal test seam: last assistant message's text blocks joined. */
export const finalAssistantText = (messages: readonly unknown[]): string | null => {
  let last: unknown;
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") last = message;
  }
  if (last === undefined) return null;
  const content = (last as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
};

/** Result lines for a settled worker: text, or the salvaged compact JSON. */
export const workerResultLines = async (json: boolean, messages: readonly unknown[]): Promise<string[]> => {
  const text = finalAssistantText(messages);
  if (text === null) throw new Error("agent run produced no assistant text");
  if (!json) return text.split("\n");
  const { parseStructuredValue } = await import("../agents/result.js");
  try {
    return [JSON.stringify(parseStructuredValue(text))];
  } catch (error) {
    const head = text.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`reply is not JSON (${error instanceof Error ? error.message : String(error)}): ${head}`);
  }
};

export const runAgent = async (args: AgentCommandArgs): Promise<{ ok: boolean; lines: string[] }> => {
  const session = await createWorkerSession(args);
  const id = randomUUID();
  let timedOut = false;
  let messages: readonly unknown[] = [];
  const timer = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, args.timeoutMs);
  try {
    await session.prompt(args.prompt);
    messages = session.state.messages;
  } catch (error) {
    throw new Error(`agent run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
  if (timedOut) throw new Error(`agent run aborted: timeout ${args.timeoutMs}ms`);
  return { ok: true, lines: [`id=${id}`, ...(await workerResultLines(args.json, messages))] };
};

/** Bridge command: `agent` + key=value lines. Everything else falls through. */
export const createAgentCommand = (
  run: (args: AgentCommandArgs) => Promise<{ ok: boolean; lines: string[] }> = runAgent,
): ExternalCommandHandler => {
  return async (argv: string[]) => {
    if (argv[0] !== "agent") return undefined;
    return await run(parseAgentArgv(argv.slice(1)));
  };
};
