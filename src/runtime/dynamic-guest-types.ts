import { providerGlobalNames } from "../provider-globals.js";
import { sanitizeMcpRefPart } from "../ref-names.js";
import type {
  FabricDynamicGuestDeclarations,
  FabricGuestTypeSources,
  FabricNamedActionTypeSource,
  FabricProviderTypeSource,
} from "../protocol.js";

// Renders guest .d.ts fragments for the dynamic call surfaces
// (mcp.<server>.<tool> and extensions.<tool>) from live provider descriptors,
// closing the type-check gap those globals had as Record<string, unknown>
// callables: argument-shape mistakes surfaced only at dispatch time. The
// generated surface stays advisory — the registry still validates every
// call's args against the action's own inputSchema before invoke, so drift
// between these declarations and a live server fails at the usual validate
// stage rather than silently.

// Every lossy rendering points back to the unmodified schema, not the preview.
const RAW_SCHEMA_GUIDANCE = "exact raw inputSchema: fabric.tools.describe";
const truncation = (reason: string): string =>
  `/* truncated: ${reason}; ${RAW_SCHEMA_GUIDANCE} */`;
const truncatedUnknown = (reason: string): string => `unknown ${truncation(reason)}`;

const MAX_DEPTH = 6;
// Each attempt is bounded independently of source JSON size.
const MAX_RENDER_NODES = 4_096;
const MAX_MEMBER_TYPE_CHARS = 2_500;
const MAX_SECTION_CHARS = 60_000;
const MAX_MCP_SERVERS = 64;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_EXTENSION_TOOLS = 256;
const MAX_ACTIONS_PER_PROVIDER = 128;
// The provider-global proxy answers these with undefined (no thenable, no
// JSON hook), so declaring them as actions would promise a call that never runs.
const UNCALLABLE_PROVIDER_MEMBERS = new Set(["then", "toJSON"]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

const SIZE_LIMIT = Symbol("preview size limit");
interface RenderState {
  nodes: number;
  descriptionLimit: number;
  descriptionsLost: boolean;
  cutLists: boolean;
  depthLimit: number;
}

const fit = (text: string, budget: number): string => {
  if (text.length > budget) throw SIZE_LIMIT;
  return text;
};

const literalType = (value: unknown, budget: number): string => {
  // Check before serializing: an enormous string must not allocate another copy.
  if (typeof value === "string") {
    if (value.length > budget) throw SIZE_LIMIT;
    return fit(JSON.stringify(value), budget);
  }
  if (value === null) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "unknown";
};

const propertyComment = (schema: unknown, state: RenderState): string => {
  if (!isRecord(schema) || typeof schema.description !== "string" || !schema.description) return "";
  const description = schema.description;
  if (description.length > state.descriptionLimit) state.descriptionsLost = true;
  if (!state.descriptionLimit) return "";
  // Never let provider text close a comment or introduce a line separator.
  const text = description.slice(0, state.descriptionLimit)
    .replace(/\*\//g, "* /").replace(/[\r\n\u2028\u2029]/g, " ");
  return `/** ${text}${description.length > state.descriptionLimit ? "…" : ""} */ `;
};

const schemaType = (schema: unknown, depth: number, budget: number, state: RenderState): string => {
  if (--state.nodes < 0) throw SIZE_LIMIT;
  if (depth > state.depthLimit) return fit(truncatedUnknown("depth limit"), budget);
  if (schema === false) return fit("never", budget);
  if (!isRecord(schema)) return fit("unknown", budget);
  if ("const" in schema) return literalType(schema.const, budget);

  const list = (entries: unknown[], kind: string, separator: string, tuple = false, literals = false, types = false): string => {
    const parts: string[] = [];
    let used = tuple ? 2 : 0;
    for (let i = 0; i < entries.length; i++) {
      const marker = tuple
        ? `...unknown[] ${truncation(`${entries.length - i} ${kind} omitted`)}`
        : truncatedUnknown(`${entries.length - i} ${kind} omitted`);
      // Reserve room for a marker only in the degradation pass. Short complete
      // lists are first tried without this reservation, regardless of count.
      const reserve = state.cutLists ? marker.length + separator.length : 0;
      try {
        const room = budget - used - (parts.length ? separator.length : 0) - reserve;
        let part = literals ? literalType(entries[i], room) : schemaType(types ? { type: entries[i] } : entries[i], depth + 1, room, state);
        if (separator === " & " && part.includes(" | ")) part = `(${part})`;
        fit(part, room);
        parts.push(part);
        used += part.length + (parts.length > 1 ? separator.length : 0);
      } catch (error) {
        if (error !== SIZE_LIMIT || !state.cutLists) throw error;
        parts.push(marker);
        return fit(`${tuple ? "[" : ""}${parts.join(separator)}${tuple ? "]" : ""}`, budget);
      }
    }
    return fit(`${tuple ? "[" : ""}${parts.join(separator) || (tuple ? "" : "unknown")}${tuple ? "]" : ""}`, budget);
  };

  if (Array.isArray(schema.enum) && schema.enum.length) return list(schema.enum, "enum values", " | ", false, true);
  if (Array.isArray(schema.anyOf)) return list(schema.anyOf, "anyOf alternatives", " | ");
  if (Array.isArray(schema.oneOf)) return list(schema.oneOf, "oneOf alternatives", " | ");
  if (Array.isArray(schema.allOf) && schema.allOf.length) return list(schema.allOf, "allOf members", " & ");
  if (Array.isArray(schema.type)) {
    // Do not spread or filter an arbitrarily large schema/type array.
    return list(schema.type, "type alternatives", " | ", false, false, true);
  }
  const type = schema.type;
  if (type === "object" || (!type && isRecord(schema.properties))) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set<string>();
    if (Array.isArray(schema.required)) {
      if (schema.required.length > MAX_RENDER_NODES) throw SIZE_LIMIT;
      for (const entry of schema.required) if (typeof entry === "string") required.add(entry);
    }
    const keys: string[] = [];
    for (const key in properties) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (keys.length >= MAX_RENDER_NODES || key.length > budget) throw SIZE_LIMIT;
      keys.push(key);
    }
    keys.sort();
    const members: string[] = [];
    let used = 4;
    for (const key of keys) {
      const prefix = `${propertyComment(properties[key], state)}${propertyKey(key)}${required.has(key) ? "" : "?"}: `;
      const part = prefix + schemaType(properties[key], depth + 1, budget - used - prefix.length, state);
      members.push(part);
      used += part.length + 2;
      if (used > budget) throw SIZE_LIMIT;
    }
    if (schema.additionalProperties !== false) {
      const prefix = "[key: string]: ";
      members.push(prefix + schemaType(schema.additionalProperties, depth + 1, budget - used - prefix.length, state));
    }
    return fit(`{ ${members.join("; ")} }`, budget);
  }
  if (type === "string" || type === "boolean" || type === "null") return fit(type, budget);
  if (type === "number" || type === "integer") return fit("number", budget);
  if (type === "array") {
    if (Array.isArray(schema.items)) return list(schema.items, "tuple items", ", ", true);
    return fit(`Array<${schemaType(schema.items, depth + 1, budget - 7, state)}>`, budget);
  }
  return fit("unknown", budget);
};

// Budget the rendered type, not the source JSON. Retry without touching raw
// schemas: shorten comments, drop them, cut lists by size, then collapse depth.
const boundedSchemaType = (schema: unknown): string => {
  const descriptionMarker = truncation("descriptions shortened or omitted");
  const attempts = [
    { descriptionLimit: MAX_MEMBER_TYPE_CHARS, cutLists: false, depthLimit: MAX_DEPTH },
    { descriptionLimit: 160, cutLists: false, depthLimit: MAX_DEPTH },
    { descriptionLimit: 0, cutLists: false, depthLimit: MAX_DEPTH },
    ...Array.from({ length: MAX_DEPTH + 1 }, (_, i) => ({ descriptionLimit: 0, cutLists: true, depthLimit: MAX_DEPTH - i })),
  ];
  for (const attempt of attempts) {
    const state: RenderState = { ...attempt, nodes: MAX_RENDER_NODES, descriptionsLost: false };
    try {
      const rendered = schemaType(schema, 0, MAX_MEMBER_TYPE_CHARS, state);
      return fit(state.descriptionsLost ? `${rendered} ${descriptionMarker}` : rendered, MAX_MEMBER_TYPE_CHARS);
    } catch (error) {
      if (error !== SIZE_LIMIT) throw error;
    }
  }
  return truncatedUnknown("type size limit (properties/members may be omitted)");
};

interface FabricRenderBudget {
  chars: number;
}

const spend = (budget: FabricRenderBudget, text: string): boolean => {
  if (budget.chars < text.length) return false;
  budget.chars -= text.length;
  return true;
};

const hasRequiredArgs = (source: FabricNamedActionTypeSource): boolean =>
  Array.isArray(source.inputSchema.required) &&
  source.inputSchema.required.length > 0 &&
  isRecord(source.inputSchema.properties);

const renderMember = (
  name: string,
  source: FabricNamedActionTypeSource,
  resultType: string,
): string => {
  const rendered = boundedSchemaType(source.inputSchema);
  return `${propertyKey(name)}(args${hasRequiredArgs(source) ? "" : "?"}: ${rendered}): ${resultType};`;
};

// Name collisions after sanitization are ambiguous: the MCP provider refuses
// ambiguous sanitized server names and resolves colliding tools to the first
// match, so mirrored members would promise a shape dispatch does not
// guarantee. Unique names render in up to two forms — the sanitized
// identifier the model types and a quoted raw alias for bracket access
// (mcp["my-server"]) — and ambiguous groups render nothing. A raw alias can
// never collide with a sanitized member: aliases always contain a character
// the sanitizer would replace or a leading digit it would prefix.
const renderMemberBlock = (
  sources: FabricNamedActionTypeSource[],
  resultType: string,
  limit: number,
  budget: FabricRenderBudget,
): { lines: string[]; dropped: number } => {
  const bySanitized = new Map<string, FabricNamedActionTypeSource[]>();
  for (const source of sources.slice(0, limit)) {
    const key = sanitizeMcpRefPart(source.name);
    const group = bySanitized.get(key);
    if (group) group.push(source);
    else bySanitized.set(key, [source]);
  }
  const lines: string[] = [];
  let dropped = Math.max(0, sources.length - limit);
  const sortedGroups = [...bySanitized.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [sanitized, group] of sortedGroups) {
    if (group.length > 1) {
      dropped += group.length;
      continue;
    }
    const source = group[0]!;
    const text =
      source.name === sanitized
        ? `  ${renderMember(sanitized, source, resultType)}`
        : `  ${renderMember(sanitized, source, resultType)}\n  ${renderMember(source.name, source, resultType)}`;
    if (!spend(budget, text)) {
      dropped += 1;
      continue;
    }
    lines.push(text);
  }
  return { lines, dropped };
};

const renderMcpDeclaration = (
  sources: NonNullable<FabricGuestTypeSources["mcpServers"]>,
): string => {
  const bySanitized = new Map<string, typeof sources>();
  const rawNames = new Set<string>();
  for (const source of sources.slice(0, MAX_MCP_SERVERS)) {
    if (rawNames.has(source.server)) continue;
    rawNames.add(source.server);
    const key = sanitizeMcpRefPart(source.server);
    const group = bySanitized.get(key);
    if (group) group.push(source);
    else bySanitized.set(key, [source]);
  }
  const budget: FabricRenderBudget = { chars: MAX_SECTION_CHARS };
  const interfaces: string[] = [];
  const mapEntries: string[] = [];
  let droppedServers = Math.max(0, sources.length - rawNames.size);
  let droppedTools = 0;
  const sortedGroups = [...bySanitized.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [sanitized, group] of sortedGroups) {
    if (group.length > 1) {
      droppedServers += group.length;
      droppedTools += group.reduce((total, entry) => total + entry.tools.length, 0);
      continue;
    }
    const source = group[0]!;
    const interfaceName = `FabricMcpServer_${sanitized}`;
    const memberBlock = renderMemberBlock(
      source.tools,
      "Promise<FabricMcpResult | unknown>",
      MAX_TOOLS_PER_SERVER,
      budget,
    );
    droppedTools += memberBlock.dropped;
    const header = `interface ${interfaceName} {\n${memberBlock.lines.join("\n")}\n}`;
    if (!spend(budget, header)) {
      droppedServers += 1;
      droppedTools += source.tools.length;
      break;
    }
    interfaces.push(header);
    mapEntries.push(`  ${sanitized}: ${interfaceName};`);
    if (source.server !== sanitized) {
      mapEntries.push(`  ${propertyKey(source.server)}: ${interfaceName};`);
    }
  }
  const notes: string[] = [];
  if (droppedServers > 0) notes.push(`${droppedServers} server(s) untyped`);
  if (droppedTools > 0) notes.push(`${droppedTools} tool(s) untyped`);
  const note =
    notes.length > 0
      ? `// Omitted from this surface (${notes.join(", ")}); those calls compile\n// as the loose fallback would and still validate at dispatch.\n// ${RAW_SCHEMA_GUIDANCE}.\n`
      : "";
  return (
    "// Generated from the live MCP descriptor cache for this execution. Known\n" +
    "// servers and tools carry their schemas so argument-shape mistakes fail\n" +
    "// type-check before the sandbox runs, like pi.* calls do; anything absent\n" +
    "// (cold cache, ambiguous sanitized names) compiles as it would with the\n" +
    "// loose declarations and is validated by the registry at dispatch.\n" +
    note +
    interfaces.join("\n") +
    (interfaces.length > 0 ? "\n" : "") +
    `declare const mcp: {\n${mapEntries.join("\n")}\n} & FabricMcpManagement;\n`
  );
};

const renderExtensionsDeclaration = (
  sources: NonNullable<FabricGuestTypeSources["extensionTools"]>,
): string => {
  const budget: FabricRenderBudget = { chars: MAX_SECTION_CHARS };
  const memberBlock = renderMemberBlock(
    sources,
    "Promise<FabricCapturedToolResult>",
    MAX_EXTENSION_TOOLS,
    budget,
  );
  const note =
    memberBlock.dropped > 0
      ? `// Omitted ${memberBlock.dropped} tool(s) from this surface; those calls\n// compile as the loose fallback would and still validate at dispatch.\n// ${RAW_SCHEMA_GUIDANCE}.\n`
      : "";
  return (
    "// Generated from the captured extension tool catalog for this execution,\n" +
    "// with the same advisory semantics as the generated mcp surface above.\n" +
    note +
    `interface FabricExtensionsApiDynamic {\n${memberBlock.lines.join("\n")}\n}\n` +
    "declare const extensions: FabricExtensionsApiDynamic;\n"
  );
};

// One global per eligible provider (src/provider-globals.ts), in the same
// order and under the same cap as the globals the kernels install, so the
// type gate and the runtime always agree on which names exist. Typed members
// come from each action's input schema; a provider with no typed actions, or
// one rendered after the section budget ran out, gets the loose
// FabricProviderGlobal shape. When only some actions fit, the rest stay
// callable through an intersection with that loose shape. Calls return
// Promise<any>, as permissive as tools.call, so moving a call from tools.call
// to the global never adds a result-type error.
const renderProviderDeclarations = (
  sources: NonNullable<FabricGuestTypeSources["providers"]>,
): string | undefined => {
  const byName = new Map<string, FabricProviderTypeSource>();
  for (const source of sources) {
    if (typeof source?.provider === "string" && !byName.has(source.provider)) byName.set(source.provider, source);
  }
  const names = providerGlobalNames(byName.keys());
  if (names.length === 0) return undefined;
  const budget: FabricRenderBudget = { chars: MAX_SECTION_CHARS };
  const blocks: string[] = [];
  for (const name of names) {
    const interfaceName = `FabricProviderGlobal_${name}`;
    const frame = `interface ${interfaceName} {\n}\ndeclare const ${name}: ${interfaceName} & FabricProviderGlobal;\n`.length;
    const actions = Array.isArray(byName.get(name)!.actions) ? byName.get(name)!.actions : [];
    const seen = new Set<string>();
    const members: string[] = [];
    let used = 0;
    let omitted = Math.max(0, actions.length - MAX_ACTIONS_PER_PROVIDER);
    for (const action of actions.slice(0, MAX_ACTIONS_PER_PROVIDER)) {
      if (typeof action?.name !== "string" || seen.has(action.name) || UNCALLABLE_PROVIDER_MEMBERS.has(action.name)) continue;
      seen.add(action.name);
      let line: string;
      try {
        line = `  ${renderMember(action.name, action, "Promise<any>")}\n`;
      } catch {
        line = `  ${truncation("schema could not be rendered")} ${propertyKey(action.name)}(args?: Record<string, unknown>): Promise<any>;\n`;
      }
      if (used + line.length + frame > budget.chars) {
        omitted += 1;
        continue;
      }
      used += line.length;
      members.push(line);
    }
    if (members.length === 0) {
      blocks.push(`${omitted > 0 ? `// Omitted ${omitted} action(s); ${RAW_SCHEMA_GUIDANCE}.\n` : ""}declare const ${name}: FabricProviderGlobal;\n`);
      continue;
    }
    const block =
      (omitted > 0 ? `// Omitted ${omitted} action(s); ${RAW_SCHEMA_GUIDANCE}.\n` : "") +
      `interface ${interfaceName} {\n${members.join("")}}\n` +
      `declare const ${name}: ${interfaceName}${omitted > 0 ? " & FabricProviderGlobal" : ""};\n`;
    budget.chars -= block.length;
    blocks.push(block);
  }
  return (
    "// Generated from the providers other extensions registered for this\n" +
    "// execution. Each global calls tools.call({ ref: \"<provider>.<action>\", args }),\n" +
    "// so the registry still validates, approves and audits every call.\n" +
    blocks.join("")
  );
};

// Renders replacement `declare const mcp` / `declare const extensions` blocks
// for guestTypeDeclarations(). Missing or empty sections return undefined so
// the loose static lines survive, matching cold-cache behavior.
/** Bounded advisory declaration for native describeTool compatibility. */
export const describeFabricActionDeclaration = (name: string, inputSchema: Record<string, unknown>, outputSchema?: Record<string, unknown>): string =>
  `${JSON.stringify(name)}: (args: ${boundedSchemaType(inputSchema)}) => Promise<${outputSchema ? boundedSchemaType(outputSchema) : "unknown"}>`;

export const buildDynamicGuestDeclarations = (
  sources: FabricGuestTypeSources,
): FabricDynamicGuestDeclarations => {
  const dynamic: FabricDynamicGuestDeclarations = {};
  if (sources.mcpServers && sources.mcpServers.length > 0) {
    dynamic.mcp = renderMcpDeclaration(sources.mcpServers);
  }
  if (sources.extensionTools && sources.extensionTools.length > 0) {
    dynamic.extensions = renderExtensionsDeclaration(sources.extensionTools);
  }
  if (sources.providers && sources.providers.length > 0) {
    const providers = renderProviderDeclarations(sources.providers);
    if (providers) dynamic.providers = providers;
  }
  return dynamic;
};
