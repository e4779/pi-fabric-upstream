import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Value } from "typebox/value";
import { isFabricBgJobToolV1, type FabricBgJobToolV1 } from "../protocol.js";
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
  "  tools=a,b,c         omitted = read-only default (read,grep,find,ls);",
  "                      `tools=` empty = none; +name/-name modifiers still work",
  "  cwd=<path>          working directory (default: host cwd)",
  "  model=<provider/id> override the configured default model; any key",
  "                      listed by `agent models` works, custom providers included",
  "  thinking=<level>    off|minimal|low|medium|high|xhigh|max (default: medium)",
  "  timeoutMs=<n>       abort bound (default 600000)",
  "  json=on             reply must be a JSON value; extracted and re-emitted compact",
  "  schemaFile=<path>   JSON Schema (typebox-compatible) the json=on reply must match;",
  "                      requires json=on",
  "  maxTokens=<n>       positive integer; accepted syntactically but rejected: the SDK",
  "                      exposes no per-session max-tokens option (models.json only)",
  "  name=<label>        job label for lists (job form only)",
  "  jobTool=<kind>      background-job kind the JobStore dock lists this job under:",
  "                      bash|powershell|fabric_exec|monitor (default: monitor)",
].join("\n");

export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

/**
 * What an agent gets when the `tools=` key is absent (HOM-28): a read-only
 * quartet, so a multi-step brief keeps a worker that can look around instead
 * of a tool-less completion. An explicit `tools=` line still pins the exact
 * set (`tools=` empty = none); `+name`/`-name` entries adjust relative to
 * this default (or to the plain names, when any are given).
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * Tri-state `tools=` parse: absent key -> the read-only default quartet;
 * `tools=` empty -> none; a list pins it exactly. `+name` adds and `-name`
 * removes — relative to the plain names when any are given, otherwise to
 * the default quartet (the same relative-selector convention inherited
 * child allowlists use, see docs/agents.md).
 */
const parseTools = (raw: string | undefined): string[] => {
  if (raw === undefined) return [...DEFAULT_AGENT_TOOLS]; // absent key: read-only default
  if (raw === "") return []; // explicit `tools=`: none
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  const plain = tokens.filter((token) => !token.startsWith("+") && !token.startsWith("-"));
  const tools = plain.length > 0 ? [...plain] : [...DEFAULT_AGENT_TOOLS];
  for (const token of tokens) {
    const name = token.slice(1);
    if (token.startsWith("+")) {
      if (name !== "" && !tools.includes(name)) tools.push(name);
    } else if (token.startsWith("-")) {
      const at = tools.indexOf(name);
      if (at >= 0) tools.splice(at, 1);
    }
  }
  return tools;
};

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
  thinking?: string;
  timeoutMs: number;
  json: boolean;
  schema?: Record<string, unknown>;
  name?: string;
  /** JobStore registration kind for the job form; default is `monitor`. */
  jobTool?: FabricBgJobToolV1;
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
    if (
      !["promptFile", "tools", "cwd", "model", "thinking", "timeoutMs", "json", "schemaFile", "maxTokens", "name", "jobTool"].includes(key)
    ) {
      throw new Error(`unknown agent argument: ${key}\n${AGENT_ARGV_HELP}`);
    }
    if (key === "jobTool" && !isFabricBgJobToolV1(value)) {
      // Refuse-not-guess: the JobStore kind union stays closed; an unknown
      // kind names the allowed values instead of mimicking one.
      throw new Error(`jobTool must be one of bash|powershell|fabric_exec|monitor, got: ${value}\n${AGENT_ARGV_HELP}`);
    }
    if (
      key === "thinking" &&
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ) {
      throw new Error(`thinking must be one of off|minimal|low|medium|high|xhigh|max, got: ${value}`);
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
  if (raw.maxTokens !== undefined) {
    const maxTokens = Number(raw.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error(`maxTokens must be a positive integer, got: ${raw.maxTokens}`);
    }
    // Researched: CreateAgentSessionOptions has no maxTokens field, Settings has no
    // maxTokens key (so SettingsManager.inMemory({ maxTokens }) is not a path), and
    // AgentSession.prompt() does not expose pi-ai's per-request maxTokens. Only the
    // models.json model definitions carry one — a catalog property, not per-session.
    throw new Error(
      "maxTokens unsupported by SDK: pi-coding-agent's createAgentSession has no per-session "
      + "max-tokens option (configure maxTokens in models.json model definitions instead)",
    );
  }
  let schema: Record<string, unknown> | undefined;
  if (raw.schemaFile !== undefined && raw.schemaFile !== "") {
    if (raw.json !== "on") {
      throw new Error(`schemaFile requires json=on (there is nothing to validate otherwise)\n${AGENT_ARGV_HELP}`);
    }
    let schemaText: string;
    try {
      schemaText = readFileSync(raw.schemaFile, "utf8");
    } catch (error) {
      throw new Error(`cannot read schemaFile ${raw.schemaFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsedSchema: unknown;
    try {
      parsedSchema = JSON.parse(schemaText);
    } catch (error) {
      throw new Error(`schemaFile is not JSON (${error instanceof Error ? error.message : String(error)}): ${raw.schemaFile}`);
    }
    if (parsedSchema === null || typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
      throw new Error(`schemaFile must contain a JSON object, got: ${JSON.stringify(parsedSchema)}`);
    }
    schema = parsedSchema as Record<string, unknown>;
  }
  return {
    prompt,
    tools: parseTools(raw.tools),
    ...(raw.cwd ? { cwd: raw.cwd } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.thinking ? { thinking: raw.thinking } : {}),
    timeoutMs: timeoutRaw ?? DEFAULT_AGENT_TIMEOUT_MS,
    json: raw.json === "on",
    ...(schema ? { schema } : {}),
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.jobTool !== undefined && raw.jobTool !== "" ? { jobTool: raw.jobTool as FabricBgJobToolV1 } : {}),
  };
};

/** One servable model: `agent models` prints it, `model=` pins it by `key`. */
export interface HostModelInfo {
  key: string;
  context: number;
  thinking: boolean;
}

/** Read-only view of the host model registry; seams for tests. */
export interface ModelRegistryView {
  model: (provider: string, modelId: string) => unknown;
  list: () => HostModelInfo[];
}

let registryCache: Promise<ModelRegistryView> | undefined;

/**
 * The running host's model registry. `ModelRuntime.create()` is the same
 * canonical runtime `createAgentSession` builds by default (agentDir
 * models.json + auth.json), so user-configured providers — deepseek/* and
 * friends — resolve here while the static pi-ai catalog misses them.
 * models.json composition happens in the constructor; `refreshOnCreate:
 * false` only skips the local catalog/availability refresh pass.
 */
export const hostModelRegistry = (): Promise<ModelRegistryView> => {
  if (registryCache !== undefined) return registryCache;
  registryCache = (async (): Promise<ModelRegistryView> => {
    try {
      const { loadHostSdk } = await import("../core/host-sdk.js");
      const sdk = await loadHostSdk();
      const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
      return {
        model: (provider: string, modelId: string): unknown => runtime.getModel(provider, modelId),
        list: (): HostModelInfo[] =>
          runtime
            .getModels()
            .map((model) => ({
              key: `${model.provider}/${model.id}`,
              context: model.contextWindow,
              thinking: model.reasoning,
            }))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      };
    } catch (error) {
      registryCache = undefined; // a later command may retry; the host may come up
      throw error;
    }
  })();
  return registryCache;
};

/** Default `agent models` lister: the host's own runtime registry. */
export const listHostModels = async (): Promise<HostModelInfo[]> => (await hostModelRegistry()).list();

/** `agent models` payload lines: `key  context=NNN  thinking=yes|no`. */
export const formatModelLines = (models: readonly HostModelInfo[]): string[] =>
  models.map((model) => `${model.key}  context=${model.context}  thinking=${model.thinking ? "yes" : "no"}`);

const editDistance = (a: string, b: string): number => {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
};

/** The `count` registry keys closest to a missed pin, nearest first. */
export const nearestKeys = (pin: string, keys: readonly string[], count = 8): string[] =>
  keys
    .map((key) => ({ key, distance: editDistance(pin.toLowerCase(), key.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, count)
    .map((entry) => entry.key);

/** Injection seam over the two catalogs `model=` resolves through. */
export interface ModelPinLookup {
  /** Static builtin catalog read (@earendil-works/pi-ai/compat getModel). */
  staticModel: (provider: string, modelId: string) => Promise<unknown>;
  /** The host runtime registry, built lazily so plain runs never touch it. */
  runtime: () => Promise<ModelRegistryView>;
}

const defaultModelPinLookup: ModelPinLookup = {
  staticModel: async (provider, modelId) => {
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    // Static catalog read: provider names are a typed union, our input is a
    // runtime string — narrow through an untyped view of the same function.
    return (getModel as unknown as (p: string, id: string) => unknown)(provider, modelId);
  },
  runtime: hostModelRegistry,
};

/**
 * Resolve a `provider/id` pin: static catalog first (cheap, typed), then the
 * host runtime registry (user models.json, extension providers, virtual
 * models). The error lists the 8 nearest servable keys — on a 900-key
 * catalog a bare "unknown model" gives nothing to correct with.
 */
export const resolveModelPin = async (pin: string, lookup: ModelPinLookup = defaultModelPinLookup): Promise<unknown> => {
  const separator = pin.indexOf("/");
  if (separator <= 0 || separator === pin.length - 1) {
    throw new Error(`model must be provider/id, got: ${pin}`);
  }
  const provider = pin.slice(0, separator);
  const modelId = pin.slice(separator + 1);
  const staticHit = await lookup.staticModel(provider, modelId);
  if (staticHit !== undefined && staticHit !== null) return staticHit;
  const registry = await lookup.runtime();
  const runtimeHit = registry.model(provider, modelId);
  if (runtimeHit !== undefined && runtimeHit !== null) return runtimeHit;
  const nearest = nearestKeys(pin, registry.list().map((model) => model.key));
  const hint = nearest.length > 0 ? ` — nearest keys: ${nearest.join(", ")}` : " (model registry is empty)";
  throw new Error(`unknown model: ${pin}${hint}`);
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
  thinking?: string;
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
  if (args.model !== undefined) model = await resolveModelPin(args.model);
  const { session } = await sdk.createAgentSession({
    cwd,
    ...(model === undefined ? {} : { model: model as never }),
    ...(args.thinking === undefined ? {} : { thinkingLevel: args.thinking as never }),
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
export const workerResultLines = async (
  json: boolean,
  messages: readonly unknown[],
  schema?: Record<string, unknown>,
): Promise<string[]> => {
  const text = finalAssistantText(messages);
  if (text === null) throw new Error("agent run produced no assistant text");
  if (!json) return text.split("\n");
  const { parseStructuredValue } = await import("../agents/result.js");
  let value: unknown;
  try {
    value = parseStructuredValue(text, schema);
  } catch (error) {
    const head = text.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`reply is not JSON (${error instanceof Error ? error.message : String(error)}): ${head}`);
  }
  if (schema !== undefined) {
    if (!Value.Check(schema, value)) {
      const errors = [...Value.Errors(schema, value)].slice(0, 5).map((error) => error.message).join("; ");
      const head = text.slice(0, 80).replace(/\s+/g, " ");
      throw new Error(`reply does not match schema (${errors || "value does not match schema"}): ${head}`);
    }
  }
  return [JSON.stringify(value)];
};

export const runAgent = async (
  args: AgentCommandArgs,
  spawn: (args: AgentCommandArgs) => Promise<WorkerSession> = createWorkerSession,
): Promise<{ ok: boolean; lines: string[] }> => {
  let session: WorkerSession;
  try {
    session = await spawn(args);
  } catch (error) {
    // Same shape as agent-jobs' spawn-fail handling: a spawn-time failure —
    // a static-catalog model pin without credentials ("No API key for
    // provider: x" class) — surfaces immediately instead of hanging under
    // the timeout bound, which only arms after the session exists.
    throw new Error(`agent spawn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const id = randomUUID();
  let timedOut = false;
  let messages: readonly unknown[] = [];
  const abortHead = (source: readonly unknown[]): string => {
    // Salvage the partial assistant text (first ~200 chars, one line) while
    // the session messages are still readable — before dispose clears them.
    const partial = finalAssistantText(source);
    return partial === null ? "" : `; partial: ${partial.slice(0, 200).replace(/\s+/g, " ")}`;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, args.timeoutMs);
  try {
    await session.prompt(args.prompt);
    messages = session.state.messages;
  } catch (error) {
    if (timedOut) {
      throw new Error(`agent run aborted: timeout ${args.timeoutMs}ms${abortHead(session.state.messages)}`);
    }
    throw new Error(`agent run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
  if (timedOut) throw new Error(`agent run aborted: timeout ${args.timeoutMs}ms${abortHead(messages)}`);
  return { ok: true, lines: [`id=${id}`, ...(await workerResultLines(args.json, messages, args.schema))] };
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
