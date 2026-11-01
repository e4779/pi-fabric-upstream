import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isFabricThinking, THINKING_LEVELS, type FabricThinking } from "../thinking.js";
import { editDistance } from "../util.js";
import { isFabricRunnerId } from "./runner-registry.js";

/**
 * Named agent files: Markdown with YAML frontmatter that agents.run and
 * agents.spawn resolve through their `agent` field.
 *
 * This module and the yaml parser it loads are first-use only (see
 * lazyEntryPoints in scripts/build.mjs). Nothing here runs at startup.
 */

export type AgentFileScope = "user" | "project";

export interface AgentFileRoots {
  /** Directory that holds the project's .pi folder; the root Fabric already uses for the mesh. */
  projectRoot: string;
  /** Project files are repository content: they load only for a trusted project. */
  projectTrusted: boolean;
  /** Pi agent directory (resolveAgentDir() in the host). */
  agentDir: string;
}

/** Folders searched for agent files, lowest to highest precedence. The one place that names them. */
export const AGENT_FILE_FOLDERS: ReadonlyArray<{ scope: AgentFileScope; dir(roots: { agentDir: string; projectRoot: string }): string }> = [
  { scope: "user", dir: ({ agentDir }) => path.join(agentDir, "agents") },
  { scope: "project", dir: ({ projectRoot }) => path.join(projectRoot, ".pi", "agents") },
];

/** Request fields an agent file can fill. A field the caller passes on the call always wins. */
export interface AgentFileRequest {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  thinking?: FabricThinking;
  runner?: string;
  kernel?: "typescript" | "python" | "inherit";
  timeoutMs?: number;
  readOnly?: boolean;
  /** Top-level `skills` and `context.skills`, resolved by name when the agent runs (see child-skills.ts). */
  skills?: { preload: Array<{ name: string; required: boolean }>; inherit: boolean };
}

export interface AgentDefinition {
  name: string;
  description: string;
  path: string;
  scope: AgentFileScope;
  request: AgentFileRequest;
  warnings: string[];
}

export interface AgentFileListing {
  name: string;
  description: string;
  path: string;
  scope: AgentFileScope;
  /** Path of the lower-precedence file this one replaces. */
  shadows?: string;
  warnings: string[];
  /** Set when the file cannot be used; name is then the file name without .md. */
  error?: string;
}

export class AgentFileError extends Error {}

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_FILES_PER_FOLDER = 500;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP_LEVEL_FIELDS = new Set(["name", "description", "model", "tools", "thinking", "effort", "skills", "context", "runtimes"]);
const FABRIC_BLOCK_FIELDS = ["runner", "kernel", "model", "thinking", "tools", "timeoutMs", "readOnly"] as const;
const KERNELS = ["typescript", "python", "inherit"] as const;
/** Claude Code tool names (lower case) to the Pi tool that does the same job. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "read", grep: "grep", glob: "find", ls: "ls", bash: "bash", edit: "edit", write: "write", multiedit: "edit",
};

const require = createRequire(import.meta.url);
let yamlModule: typeof import("yaml") | undefined;
// Compiled Bun hosts need the extension loader to resolve bare package names.
const loadYaml = (): typeof import("yaml") =>
  (yamlModule ??= require(fileURLToPath(import.meta.resolve("yaml"))) as typeof import("yaml"));

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value: unknown): string => JSON.stringify(String(value).slice(0, 40));

/** Parse one agent file. Every refusal names the file and, where it can, the line. */
export const parseAgentFile = (source: string, file: string, scope: AgentFileScope): AgentDefinition => {
  const fail = (detail: string, line?: number): never => {
    throw new AgentFileError("Agent file " + file + (line === undefined ? "" : ":" + line) + ": " + detail);
  };
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  if (lines[0]?.trimEnd() !== "---") fail("the file must start with a YAML frontmatter block opened by a --- line", 1);
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close < 0) fail("the frontmatter block opened on line 1 is never closed by a --- line", 1);
  const body = lines.slice(close + 1).join("\n").trim();

  const yaml = loadYaml();
  const counter = new yaml.LineCounter();
  const doc = yaml.parseDocument(lines.slice(1, close).join("\n"), { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  // Frontmatter line 1 is file line 2.
  const fileLine = (offset: number): number => counter.linePos(offset).line + 1;
  const error = doc.errors[0];
  if (error) fail(error.message, fileLine(error.pos[0]));
  const parsed: unknown = doc.toJS({ maxAliasCount: 50 }) ?? {};
  if (!isMapping(parsed)) return fail("the frontmatter must be a mapping of fields", 2);
  const data = parsed;

  /** File line of the key reached by this path, when the YAML still has it. */
  const lineOf = (...keys: string[]): number | undefined => {
    let node: unknown = doc.contents;
    let pair: { key: unknown; value: unknown } | undefined;
    for (const key of keys) {
      if (!yaml.isMap(node)) return undefined;
      pair = node.items.find((item) => yaml.isScalar(item.key) && item.key.value === key);
      if (!pair) return undefined;
      node = pair.value;
    }
    const range = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
    return range ? fileLine(range[0]) : undefined;
  };
  const has = (target: Record<string, unknown>, key: string): boolean => Object.hasOwn(target, key);
  const modelOf = (value: unknown, where: string[]): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return fail(where.join(".") + " must be a string", lineOf(...where));
    const model = value.trim();
    return model === "" || model.toLowerCase() === "inherit" ? undefined : model;
  };
  const thinkingOf = (value: unknown, where: string[]): FabricThinking | undefined => {
    if (value === undefined || value === null) return undefined;
    const level = typeof value === "string" ? value.trim().toLowerCase() : value;
    if (!isFabricThinking(level)) {
      return fail(where.join(".") + " " + show(value) + " is not a Fabric thinking level; use one of " + THINKING_LEVELS.join(", "), lineOf(...where));
    }
    return level;
  };
  const toolsOf = (value: unknown, where: string[]): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    let names: unknown[];
    if (typeof value === "string") names = value.split(",");
    else if (Array.isArray(value)) names = value;
    else return fail(where.join(".") + " must be a YAML list or a comma-separated string", lineOf(...where));
    const mapped: string[] = [];
    for (const entry of names) {
      if (typeof entry !== "string") return fail(where.join(".") + " entries must be strings", lineOf(...where));
      const tool = entry.trim();
      if (tool === "") continue;
      const name = TOOL_NAMES[tool.toLowerCase()] ?? tool;
      if (!mapped.includes(name)) mapped.push(name);
    }
    // A blank string is the same as no field. An explicit empty list asks for no tools.
    return typeof value === "string" && mapped.length === 0 ? undefined : mapped;
  };

  const fieldWarnings: string[] = [];
  const skillsOf = (value: unknown, where: string[]): Array<{ name: string; required: boolean }> | undefined => {
    if (value === undefined || value === null) return undefined;
    const at = lineOf(...where);
    let entries: unknown[];
    if (typeof value === "string") entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    else if (Array.isArray(value)) entries = value;
    else return fail(where.join(".") + " must be a YAML list of skill names", at);
    return entries.map((entry) => {
      let name: unknown = entry;
      let required = true;
      if (isMapping(entry)) {
        for (const key of Object.keys(entry)) {
          if (key === "source" || key === "version") {
            fieldWarnings.push("skills entry " + show(entry.name) + ": " + key + " is not supported; Fabric finds skills by name" + (at === undefined ? "" : " (line " + at + ")"));
          } else if (key !== "name" && key !== "required") {
            fail("unknown key " + show(key) + " in a skills entry; the keys are name, required, source, version", at);
          }
        }
        if (entry.required !== undefined && typeof entry.required !== "boolean") fail("skills entry required must be true or false", at);
        name = entry.name;
        required = entry.required !== false;
      }
      if (typeof name !== "string" || !name.trim()) return fail(where.join(".") + " entries must be skill names", at);
      if (/[\\/]/.test(name)) fail("skills entry " + show(name) + " is a path; give the skill's name", at);
      return { name: name.trim(), required };
    });
  };

  if (typeof data.name !== "string" || !NAME_PATTERN.test(data.name)) {
    fail("name is required and must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit", lineOf("name") ?? 2);
  }
  const name = data.name as string;
  if (data.description !== undefined && data.description !== null && typeof data.description !== "string") {
    fail("description must be a string", lineOf("description"));
  }
  if (has(data, "thinking") && has(data, "effort")) {
    fail("thinking and effort are two spellings of one field; write only one", lineOf("effort"));
  }

  const request: AgentFileRequest = {};
  if (body) request.systemPrompt = body;
  const model = modelOf(data.model, ["model"]);
  if (model) request.model = model;
  const thinking = thinkingOf(has(data, "effort") ? data.effort : data.thinking, [has(data, "effort") ? "effort" : "thinking"]);
  if (thinking) request.thinking = thinking;
  const tools = toolsOf(data.tools, ["tools"]);
  if (tools) request.tools = tools;

  // skills are preloaded in full; context.skills says whether the parent's other skills stay visible.
  const contextBlock = data.context;
  if (contextBlock !== undefined && contextBlock !== null && !isMapping(contextBlock)) fail("context must be a mapping", lineOf("context"));
  let inheritSkills: boolean | undefined;
  if (isMapping(contextBlock)) {
    for (const key of Object.keys(contextBlock)) {
      if (key === "skills") continue;
      const line = lineOf("context", key);
      fieldWarnings.push("ignored field " + show("context." + key) + (line === undefined ? "" : " (line " + line + ")"));
    }
    if (contextBlock.skills !== undefined && contextBlock.skills !== null) {
      if (typeof contextBlock.skills !== "boolean") fail("context.skills must be true or false", lineOf("context", "skills"));
      inheritSkills = contextBlock.skills as boolean;
    }
  }
  const skills = skillsOf(data.skills, ["skills"]);
  if (skills !== undefined || inheritSkills !== undefined) request.skills = { preload: skills ?? [], inherit: inheritSkills ?? true };

  // Fabric-only settings. They use request field names and override the shared fields above.
  const runtimes = data.runtimes;
  if (runtimes !== undefined && runtimes !== null && !isMapping(runtimes)) fail("runtimes must be a mapping", lineOf("runtimes"));
  const block = isMapping(runtimes) ? runtimes.fabric : undefined;
  if (block !== undefined && block !== null) {
    if (!isMapping(block)) return fail("runtimes.fabric must be a mapping", lineOf("runtimes", "fabric"));
    for (const key of Object.keys(block)) {
      if (!(FABRIC_BLOCK_FIELDS as readonly string[]).includes(key)) {
        fail("unknown key " + show(key) + " in runtimes.fabric; the keys are " + FABRIC_BLOCK_FIELDS.join(", "), lineOf("runtimes", "fabric", key));
      }
    }
    const at = (key: string) => ["runtimes", "fabric", key];
    if (has(block, "model")) {
      const value = modelOf(block.model, at("model"));
      if (value) request.model = value; else delete request.model;
    }
    if (has(block, "thinking")) {
      const value = thinkingOf(block.thinking, at("thinking"));
      if (value) request.thinking = value; else delete request.thinking;
    }
    if (has(block, "tools")) {
      const value = toolsOf(block.tools, at("tools"));
      if (value) request.tools = value; else delete request.tools;
    }
    if (has(block, "runner")) {
      if (!isFabricRunnerId(block.runner)) fail("runtimes.fabric.runner " + show(block.runner) + " is not a valid runner id", lineOf(...at("runner")));
      request.runner = block.runner as string;
    }
    if (has(block, "kernel")) {
      if (!(KERNELS as readonly unknown[]).includes(block.kernel)) fail("runtimes.fabric.kernel must be one of " + KERNELS.join(", "), lineOf(...at("kernel")));
      request.kernel = block.kernel as (typeof KERNELS)[number];
    }
    if (has(block, "timeoutMs")) {
      if (typeof block.timeoutMs !== "number" || !Number.isFinite(block.timeoutMs) || block.timeoutMs <= 0) {
        fail("runtimes.fabric.timeoutMs must be a positive number of milliseconds", lineOf(...at("timeoutMs")));
      }
      request.timeoutMs = block.timeoutMs as number;
    }
    if (has(block, "readOnly")) {
      if (typeof block.readOnly !== "boolean") fail("runtimes.fabric.readOnly must be true or false", lineOf(...at("readOnly")));
      request.readOnly = block.readOnly as boolean;
    }
  }

  const warnings = Object.keys(data)
    .filter((key) => !TOP_LEVEL_FIELDS.has(key))
    .map((key) => {
      const line = lineOf(key);
      return "ignored field " + show(key) + (line === undefined ? "" : " (line " + line + ")");
    });
  warnings.push(...fieldWarnings);
  return { name, description: typeof data.description === "string" ? data.description : "", path: file, scope, request, warnings };
};

interface Layer {
  scope: AgentFileScope;
  dir: string;
  definitions: Map<string, AgentDefinition>;
  broken: Array<{ stem: string; path: string; error: string }>;
}
interface Catalog {
  /** Highest precedence first. */
  layers: Layer[];
  notices: string[];
  folders: string[];
}

const readLayer = (scope: AgentFileScope, dir: string, notices: string[]): Layer => {
  const layer: Layer = { scope, dir, definitions: new Map(), broken: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") notices.push("Cannot read " + dir + " (" + (code ?? "unknown error") + ").");
    return layer;
  }
  const files = names.filter((entry) => !entry.startsWith(".") && entry.endsWith(".md")).sort();
  if (files.length > MAX_FILES_PER_FOLDER) notices.push(dir + " holds " + files.length + " agent files; only the first " + MAX_FILES_PER_FOLDER + " are read.");
  for (const entry of files.slice(0, MAX_FILES_PER_FOLDER)) {
    const file = path.join(dir, entry);
    const stem = entry.slice(0, -".md".length);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_AGENT_FILE_BYTES) throw new AgentFileError("Agent file " + file + ": larger than " + MAX_AGENT_FILE_BYTES + " bytes");
      const definition = parseAgentFile(fs.readFileSync(file, "utf8"), file, scope);
      const first = layer.definitions.get(definition.name);
      if (first) throw new AgentFileError("Agent file " + file + ": the name " + show(definition.name) + " is already defined by " + first.path);
      layer.definitions.set(definition.name, definition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      layer.broken.push({ stem, path: file, error: message });
    }
  }
  return layer;
};

const loadCatalog = (roots: AgentFileRoots): Catalog => {
  const places = { agentDir: roots.agentDir, projectRoot: roots.projectRoot };
  const notices: string[] = [];
  const folders: string[] = [];
  const layers: Layer[] = [];
  for (const folder of [...AGENT_FILE_FOLDERS].reverse()) {
    const dir = folder.dir(places);
    if (folder.scope === "project" && !roots.projectTrusted) {
      if (fs.existsSync(dir)) notices.push("Project agent files in " + dir + " are not loaded because this project is not trusted.");
      continue;
    }
    folders.push(dir);
    layers.push(readLayer(folder.scope, dir, notices));
  }
  return { layers, notices, folders };
};

/**
 * Read-only listing for agents.definitions(): the effective file for each name, plus files that
 * cannot load. onNotice receives folder-level problems such as an untrusted project.
 */
export const listAgentFiles = (roots: AgentFileRoots, onNotice?: (notice: string) => void): AgentFileListing[] => {
  const catalog = loadCatalog(roots);
  for (const notice of catalog.notices) onNotice?.(notice);
  const listing: AgentFileListing[] = [];
  const taken = new Set<string>();
  catalog.layers.forEach((layer, index) => {
    for (const definition of layer.definitions.values()) {
      if (taken.has(definition.name)) continue;
      taken.add(definition.name);
      const shadowed = catalog.layers.slice(index + 1).map((lower) => lower.definitions.get(definition.name)).find(Boolean);
      listing.push({
        name: definition.name, description: definition.description, path: definition.path, scope: definition.scope,
        ...(shadowed ? { shadows: shadowed.path } : {}), warnings: [...definition.warnings],
      });
    }
    for (const broken of layer.broken) {
      listing.push({ name: broken.stem, description: "", path: broken.path, scope: layer.scope, warnings: [], error: broken.error });
    }
  });
  return listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** Find one agent by name. An unknown name or an unusable file throws before any child starts. */
export const resolveAgentFile = (name: string, roots: AgentFileRoots): AgentDefinition => {
  const catalog = loadCatalog(roots);
  for (const layer of catalog.layers) {
    const found = layer.definitions.get(name);
    if (found) return found;
    // A file that cannot load has no declared name: its file name stands in, so a broken
    // project file is reported instead of silently falling back to a user file.
    const broken = layer.broken.find((entry) => entry.stem === name);
    if (broken) throw new AgentFileError(broken.error);
  }
  const available = [...new Set(catalog.layers.flatMap((layer) => [...layer.definitions.keys()]))].sort();
  const lowered = name.toLowerCase();
  let suggestion: { name: string; distance: number } | undefined;
  for (const candidate of available) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!suggestion || distance < suggestion.distance)) suggestion = { name: candidate, distance };
  }
  throw new AgentFileError(
    "Unknown agent " + show(name) + "." +
      (suggestion ? " Did you mean " + show(suggestion.name) + "?" : "") +
      (available.length > 0 ? " Available agents: " + available.join(", ") + "." : " No agent files were found.") +
      " Searched " + catalog.folders.join(" and ") + "." +
      (catalog.notices.length > 0 ? " " + catalog.notices.join(" ") : ""),
  );
};

const FILLABLE: ReadonlyArray<keyof AgentFileRequest> = ["systemPrompt", "model", "tools", "thinking", "runner", "kernel", "timeoutMs", "readOnly", "skills"];

/**
 * Fill the request from the file. A field the caller passed, even an empty one, is never replaced.
 * The run is named after the agent unless the caller names it.
 */
export const applyAgentDefinition = (args: Record<string, unknown>, definition: AgentDefinition): Record<string, unknown> => {
  const { agent: _agent, ...merged } = args;
  if (merged.name === undefined) merged.name = definition.name;
  for (const key of FILLABLE) {
    const value = definition.request[key];
    if (value !== undefined && merged[key] === undefined) merged[key] = typeof value === "object" ? structuredClone(value) : value;
  }
  return merged;
};
