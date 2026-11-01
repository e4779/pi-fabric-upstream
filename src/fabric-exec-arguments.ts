import type { FabricKernel } from "./runtime/kernel.js";
import { normalizeRunDisplay } from "./run-display.js";
import { repairFabricGuestCode } from "./runtime/guest-code-repair.js";

const OPTIONAL_FABRIC_EXEC_KEYS = [
  "payloads",
  "strings",
  "resultFormat",
  "tokenBudget",
  "agentBudget",
  "timeoutMs",
  "timeout_ms",
  "maxOutputTokens",
  "max_output_tokens",
  "display",
  "background",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeJsonObject = (text: string): boolean =>
  text.startsWith("{") && text.endsWith("}");

const looksLikeJsonString = (text: string): boolean =>
  text.startsWith('"') && text.endsWith('"');

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const trimmed = text.trim();
  if (!looksLikeJsonObject(trimmed) && !looksLikeJsonString(trimmed)) return undefined;
  try {
    let parsed: unknown = JSON.parse(trimmed);
    // One extra unwrap: models sometimes JSON-encode the object twice.
    if (typeof parsed === "string") {
      const inner = parsed.trim();
      if (!looksLikeJsonObject(inner)) return undefined;
      parsed = JSON.parse(inner);
    }
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const asStringRecord = (record: Record<string, unknown>): Record<string, string> | undefined => {
  if (Object.values(record).some((value) => typeof value !== "string")) return undefined;
  return record as Record<string, string>;
};

// Silent repair for the named-payload map. The declared shape is
// Record<string, string>, but models stringify nested maps (the highest-entropy
// escaped field in an otherwise flat tool), which strict schema validation
// rejects at the cost of a zero-work round trip. `strings` is a legacy alias:
// the name collides with the JSON string type and taught models to pass one.
const normalizeFabricExecStrings = (
  input: unknown,
): Record<string, string> | undefined => {
  if (isRecord(input)) return asStringRecord(input);
  if (typeof input !== "string") return undefined;
  const parsed = parseJsonObject(input);
  return parsed ? asStringRecord(parsed) : undefined;
};

export const resolveFabricExecPayloads = (params: {
  payloads?: unknown;
  strings?: unknown;
}): Record<string, string> | undefined =>
  normalizeFabricExecStrings(params.payloads) ?? normalizeFabricExecStrings(params.strings);

export const prepareFabricExecArguments = (input: unknown, kernel: FabricKernel = "typescript"): unknown => {
  if (typeof input === "string") return prepareFabricExecArguments({ code: input }, kernel);
  if (!isRecord(input)) return input;

  let prepared = input;
  const writable = (): Record<string, unknown> => {
    if (prepared === input) prepared = { ...input };
    return prepared;
  };

  if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
    writable().code = prepared.code.join("\n");
  }
  if (kernel === "typescript" && typeof prepared.code === "string") {
    const repaired = repairFabricGuestCode(prepared.code);
    if (repaired !== prepared.code) writable().code = repaired;
  }

  if (kernel === "typescript" && typeof prepared.code === "string") {
    const match = /^\s*\/\/\s*@options:\s*([^\r\n]*)/.exec(prepared.code);
    if (match) {
      const options: unknown = JSON.parse(match[1]!);
      if (!isRecord(options)) throw new Error("@options must be a JSON object");
      for (const [key, value] of Object.entries(options)) {
        if (key !== "timeout_ms" && key !== "max_output_tokens") throw new Error(`Unsupported @options key: ${key}`);
        if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${key} must be a positive integer`);
        if (prepared[key] !== undefined && prepared[key] !== value) throw new Error(`Conflicting ${key} options`);
        writable()[key] = value;
      }
    }
  }
  if (prepared.max_output_tokens != null) {
    if (prepared.maxOutputTokens != null && prepared.maxOutputTokens !== prepared.max_output_tokens) throw new Error("Conflicting maxOutputTokens and max_output_tokens");
    writable().maxOutputTokens = prepared.max_output_tokens;
    delete writable().max_output_tokens;
  }

  for (const key of OPTIONAL_FABRIC_EXEC_KEYS) {
    if (!Object.hasOwn(prepared, key)) continue;
    if (prepared[key] === null || prepared[key] === undefined) delete writable()[key];
  }

  const display = prepared.display;
  if (typeof display === "string" || isRecord(display)) {
    const normalized = normalizeRunDisplay(display);
    if (normalized) writable().display = normalized;
    else delete writable().display;
  }

  const hasPayloads = Object.hasOwn(prepared, "payloads");
  const hasStrings = Object.hasOwn(prepared, "strings");
  if (hasPayloads || hasStrings) {
    const raw = hasPayloads ? prepared.payloads : prepared.strings;
    const normalized = normalizeFabricExecStrings(raw);
    if (normalized) {
      if (prepared.payloads !== normalized) writable().payloads = normalized;
    } else if (!hasPayloads) {
      writable().payloads = raw;
    }
    if (hasStrings) delete writable().strings;
  }

  return prepared;
};
