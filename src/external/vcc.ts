import type { ExternalCommandHandler } from "./bridge.js";

/**
 * `vcc` — structured views over a Pi session file (or the live session):
 * summary, the active branch, tail entries, single entries. Verifiers and
 * post-hoc debugging read WHAT ACTUALLY HAPPENED from here; the renderer is
 * rg-friendly by the house style. Shared by the bridge command (live
 * entries via sessionManager) and the standalone file reader.
 */

export const VCC_ARGV_HELP = [
  "vcc views:",
  "  vcc                    summary: counts, leaves, active branch head",
  "  vcc entries [n]        last n branch entries (default 20), oldest first",
  "  vcc branch             active branch ids, root to leaf",
  "  vcc entry <id>         one raw entry, lossless JSON",
].join("\n");

export interface VccEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly raw: Record<string, unknown>;
}

export interface VccSession {
  readonly header: Record<string, unknown> | null;
  readonly entries: readonly VccEntry[];
}

export const parseVccSession = (text: string): VccSession => {
  const entries: VccEntry[] = [];
  let header: Record<string, unknown> | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue; // torn tail line from a live writer: skip, stay useful
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.type === "session") {
      header = record;
      continue;
    }
    entries.push({
      type: typeof record.type === "string" ? record.type : "?",
      id: typeof record.id === "string" ? record.id : "?",
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
      raw: record,
    });
  }
  return { header, entries };
};

/** Entries with no children — roots are not leaves. */
export const vccLeaves = (entries: readonly VccEntry[]): readonly VccEntry[] => {
  const parents = new Set(
    entries.map((entry) => entry.parentId).filter((parent): parent is string => parent !== null),
  );
  return entries.filter((entry) => !parents.has(entry.id));
};

/** The most recently stamped leaf — the standalone heuristic for "active". */
export const vccActiveLeaf = (entries: readonly VccEntry[]): string | null => {
  const leaves = vccLeaves(entries);
  if (leaves.length === 0) return null;
  let best = leaves[0]!;
  for (const leaf of leaves) {
    if (leaf.timestamp >= best.timestamp) best = leaf;
  }
  return best.id;
};

export const vccBranchIds = (entries: readonly VccEntry[], leafId: string | null): string[] => {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: string[] = [];
  let cursor = byId.get(leafId);
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.push(cursor.id);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return chain.reverse();
};

const entryHead = (entry: VccEntry): string => {
  const message = entry.raw.message as Record<string, unknown> | undefined;
  if (entry.type === "message" && message !== undefined) {
    const role = typeof message.role === "string" ? message.role : "?";
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") parts.push(record.text);
        else if (typeof record.name === "string") parts.push(`[${record.name}]`);
      }
      text = parts.join(" ");
    }
    if (typeof message.toolName === "string") {
      return `role=${role} tool=${message.toolName}${message.isError === true ? " ERR" : ""} ${text}`.trim();
    }
    return `role=${role} ${text}`.trim();
  }
  if (entry.type === "compaction") {
    return `COMPACTED tokensBefore=${entry.raw.tokensBefore ?? "?"} firstKept=${entry.raw.firstKeptEntryId ?? "?"}`;
  }
  if (entry.type === "model_change") {
    return `model=${entry.raw.provider ?? "?"}/${entry.raw.modelId ?? "?"}`;
  }
  if (entry.type === "context_edit") {
    return `target=${entry.raw.targetId ?? "?"} replacement=${entry.raw.replacement === null ? "null" : "set"}`;
  }
  return "";
};

const oneLine = (text: string, limit = 100): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

const clock = (timestamp: string): string =>
  timestamp === "" ? "--:--:--" : timestamp.replace(/^.*[T]/, "").replace(/Z$/, "").slice(0, 8);

export const renderVccSummary = (session: VccSession, leafId: string | null, file?: string): string[] => {
  const counts = new Map<string, number>();
  for (const entry of session.entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  const leaves = vccLeaves(session.entries).length;
  const parts = [
    `entries=${session.entries.length}`,
    `types=${[...counts.entries()].map(([type, count]) => `${type}:${count}`).join(",")}`,
    `leaves=${leaves}`,
    `branchLen=${vccBranchIds(session.entries, leafId).length}`,
  ];
  if (file !== undefined) parts.push(`file=${file}`);
  const lines = [parts.join(" ")];
  if (session.header !== null) {
    const cwd = session.header.cwd;
    const id = session.header.id;
    lines.push(`session=${typeof id === "string" ? id : "?"} cwd=${typeof cwd === "string" ? cwd : "?"}`);
  }
  const first = session.entries[0];
  const last = session.entries[session.entries.length - 1];
  if (first !== undefined && last !== undefined) {
    lines.push(`span=${first.timestamp} .. ${last.timestamp}`);
  }
  return lines;
};

export const renderVccEntries = (
  session: VccSession,
  leafId: string | null,
  limit: number,
): string[] => {
  const branch = new Set(vccBranchIds(session.entries, leafId));
  const scoped = session.entries.filter((entry) => branch.size === 0 || branch.has(entry.id));
  const tail = scoped.slice(-limit);
  return tail.map((entry) => {
    const parent = entry.parentId === null ? "-" : entry.parentId;
    return `${entry.id} p=${parent} ${clock(entry.timestamp)} ${entry.type} ${oneLine(entryHead(entry))}`.trimEnd();
  });
};

export const renderVccBranch = (session: VccSession, leafId: string | null): string[] => {
  const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
  return vccBranchIds(session.entries, leafId).map(
    (id) => `${id} ${clock(byId.get(id)?.timestamp ?? "")} ${byId.get(id)?.type ?? "?"}`,
  );
};

export const renderVccEntry = (session: VccSession, id: string): string[] | undefined => {
  const entry = session.entries.find((candidate) => candidate.id === id);
  return entry === undefined ? undefined : [JSON.stringify(entry.raw)];
};

export interface VccLiveSource {
  file?: () => string | undefined;
  entries: () => readonly VccEntry[];
  leafId: () => string | null;
}

export const createVccCommand = (source: () => VccLiveSource | undefined): ExternalCommandHandler => {
  return async (argv: string[]) => {
    if (argv[0] !== "vcc") return undefined;
    const live = source();
    if (live === undefined) {
      return { ok: false, lines: ["vcc unavailable: no session context"] };
    }
    const session: VccSession = { header: null, entries: live.entries() };
    const leafId = live.leafId();
    switch (argv[1] ?? "") {
      case "":
        return { ok: true, lines: renderVccSummary(session, leafId, live.file?.()) };
      case "entries": {
        const limit = argv[2] === undefined ? 20 : Number(argv[2]);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error(`vcc entries takes a positive count, got: ${argv[2]}`);
        }
        return { ok: true, lines: renderVccEntries(session, leafId, limit) };
      }
      case "branch":
        return { ok: true, lines: renderVccBranch(session, leafId) };
      case "entry": {
        if (argv[2] === undefined) throw new Error("vcc entry needs an id");
        const lines = renderVccEntry(session, argv[2]);
        return lines === undefined
          ? { ok: false, lines: [`no entry with id ${argv[2]}`] }
          : { ok: true, lines };
      }
      default:
        throw new Error(`unknown vcc view: ${argv[1]}\n${VCC_ARGV_HELP}`);
    }
  };
};
