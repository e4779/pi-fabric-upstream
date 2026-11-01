/** Inherited optional-tool authority: exact tool names and `*` patterns. */
export interface ChildToolAllowlist {
  readonly entries: readonly string[];
  /** The parent itself was launched with fabric_exec, named exactly. */
  readonly fabricExec: boolean;
  has(name: string): boolean;
}

// Same semantics as Pi's --tools; a candidate wildcard must be wholly covered.
const toolPattern = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
const modifier = (name: string): boolean => name.startsWith("+") || name.startsWith("-");
const validEntry = (name: unknown): name is string => typeof name === "string" &&
  name.length > 0 && name.trim() === name && !name.includes(",") &&
  (!modifier(name) || (name.length > 1 && !name.includes("*")));
const validSelection = (entries: unknown): entries is string[] => Array.isArray(entries) &&
  entries.every(validEntry) && (!entries.some(modifier) || entries.every(modifier));

const allowlist = (entries: readonly string[], fabricExec = false): ChildToolAllowlist => {
  const names = new Set(entries.filter((entry) => !entry.includes("*")));
  const patterns = entries.filter((entry) => entry.includes("*")).map(toolPattern);
  return {
    entries,
    fabricExec,
    has: (name) => name !== "fabric_exec" && (names.has(name) || patterns.some((pattern) => pattern.test(name))),
  };
};

/** Positive authority of a relative selector, without assuming the target's defaults. */
const explicitAdditions = (entries: readonly string[]): string[] => {
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("+")) names.add(entry.slice(1));
    else names.delete(entry.slice(1));
  }
  return [...names].filter(name => name !== "fabric_exec");
};

/** Worker-owned optional-tool allowlist; absence leaves the host unrestricted. */
export function readChildToolAllowlist(raw = process.env.PI_FABRIC_TOOL_ALLOWLIST): ChildToolAllowlist | undefined {
  if (raw === undefined) return undefined;
  try {
    const names: unknown = JSON.parse(raw);
    if (validSelection(names)) {
      // Signed lists do not assert authority over unknown native defaults, and
      // neither a wildcard nor +fabric_exec is the required exact entry.
      return names.some(modifier) ? allowlist(explicitAdditions(names))
        : allowlist(names.filter(name => name !== "fabric_exec"), names.includes("fabric_exec"));
    }
  } catch {
    // Malformed inherited authority must fail closed, never widen the surface.
  }
  return allowlist([]);
}

/** Constrain Pi selectors before forwarding; never let relative lists restore defaults. */
export function constrainChildToolSelection(entries: readonly string[], inherited?: ChildToolAllowlist): string[] {
  if (!validSelection(entries)) throw new Error("Invalid child tools: use plain names/patterns or exact +name/-name modifiers");
  const selected = inherited && entries.some(modifier) ? explicitAdditions(entries) : entries;
  return selected.filter(name => name !== "fabric_exec" && name !== "+fabric_exec" &&
    (inherited === undefined || inherited.has(name)));
}

/** Pi's relative selectors change defaults rather than becoming literal tool names. */
export function resolveNativeToolSelection(
  tools: readonly string[] | undefined, defaults: readonly string[], noTools?: "builtin" | "all",
): { active: string[]; allowed?: string[] } {
  if (tools !== undefined && !validSelection(tools)) throw new Error("Invalid tools option: use plain names/patterns or exact +name/-name modifiers");
  const relative = tools?.some(modifier);
  const active = [...(relative || tools === undefined ? noTools ? [] : defaults : tools)];
  if (relative) for (const entry of tools!) {
    const name = entry.slice(1);
    const index = active.indexOf(name);
    if (entry.startsWith("+") && index === -1) active.push(name);
    else if (entry.startsWith("-") && index !== -1) active.splice(index, 1);
  }
  const allowed = relative ? noTools === "all" ? active : undefined : tools ?? (noTools === "all" ? [] : undefined);
  return { active, ...(allowed ? { allowed: [...allowed] } : {}) };
}

/** Native selection expands wildcards after launch; exclusion is the final boundary. */
export function nativeFabricExecExclusions(tools: readonly string[] | undefined): string[] {
  return tools?.includes("fabric_exec") || tools?.includes("+fabric_exec") ? [] : ["fabric_exec"];
}
