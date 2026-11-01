// Alias normalization is all the startup graph needs from model resolution (config.ts), so it lives
// apart from the resolver, which model-resolution.ts re-exports and only the agent paths load.
import { isFabricThinking, type FabricThinking } from "../thinking.js";

export const PROVIDER_MODEL_RE = /^[^\s/]+\/[^\s]+$/;

/**
 * One configured alias: an ordered fallback chain plus an optional default
 * thinking level. The thinking level is a Fabric default for runs that select
 * the alias, below an explicit call/actor value and above the global
 * `agents.thinking` default.
 */
export interface FabricModelAlias {
  targets: string[];
  thinking?: FabricThinking;
}

export type FabricModelAliases = Record<string, FabricModelAlias>;

/**
 * Normalize raw `models.aliases` config into alias name → ordered targets.
 * String targets degrade to one-element fallback chains. Entries whose name,
 * target list, or any `provider/model` target string is malformed are
 * dropped entirely, matching the lenient fallback style of the other config
 * normalizers (no partial alias survives with a silently missing target).
 */
export const normalizeModelAliases = (input: unknown): FabricModelAliases => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const aliases: FabricModelAliases = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    // Object entries carry {model, thinking?}; re-normalizing them keeps a
    // config round trip through persisted state or a resident owner idempotent.
    const entry =
      typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue)
        ? (rawValue as { model?: unknown; targets?: unknown; thinking?: unknown })
        : undefined;
    const rawTargets = entry ? entry.model ?? entry.targets : rawValue;
    const values = typeof rawTargets === "string" ? [rawTargets] : rawTargets;
    if (!Array.isArray(values) || values.length === 0) continue;
    const targets: string[] = [];
    let valid = true;
    for (const candidate of values) {
      if (typeof candidate !== "string") {
        valid = false;
        break;
      }
      const target = candidate.trim();
      if (!PROVIDER_MODEL_RE.test(target)) {
        valid = false;
        break;
      }
      if (!targets.includes(target)) targets.push(target);
    }
    if (valid && targets.length > 0) {
      aliases[name] = {
        targets,
        ...(entry && isFabricThinking(entry.thinking) ? { thinking: entry.thinking } : {}),
      };
    }
  }
  return aliases;
};
