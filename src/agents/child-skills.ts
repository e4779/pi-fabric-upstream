import fs from "node:fs";
import path from "node:path";
import { editDistance } from "../util.js";

/**
 * Child skills: the `skills` option of agents.run and agents.spawn, and the
 * `skills` / `context.skills` fields of agent files.
 *
 * Skills are named, never given as paths. Each name resolves to a skill this
 * session can see, so a child never gets a skill its parent does not have.
 * Listed skills are preloaded in full into the child's system prompt. With
 * `inherit` (the default for a list), the child's catalog is exactly this
 * session's skills; without it, the child has no catalog.
 *
 * First-use only (see lazyEntryPoints in scripts/build.mjs).
 */

/** A skill this session can see, from Pi's getCommands() skill entries. */
export interface ParentSkill {
  name: string;
  filePath: string;
}

/**
 * The skills this session loaded. Pi lists each one as a `skill:<name>`
 * command whose source path is the skill file, after its own narrowing
 * (--no-skills, --skill, settings), so a child never gets more than this.
 */
export const sessionSkills = (
  commands: ReadonlyArray<{ name: string; source: string; sourceInfo?: { path?: string } }>,
): ParentSkill[] => commands.flatMap((command) =>
  command.source === "skill" && command.name.startsWith("skill:") && command.sourceInfo?.path
    ? [{ name: command.name.slice("skill:".length), filePath: command.sourceInfo.path }]
    : []);

/** One listed skill. A request names required skills; an agent file may mark one optional. */
export interface ChildSkillEntry {
  name: string;
  required: boolean;
}

/** The skills option after an agent file was merged into the call. */
export interface ChildSkillsSelection {
  preload: ChildSkillEntry[];
  /** The child also sees this session's other skills. */
  inherit: boolean;
}

/** What the child is launched with. */
export interface ChildSkillsLaunch {
  /** Skill files the child loads instead of its own discovery; [] means none. */
  catalog: string[];
  /** System prompt block holding the preloaded skills in full. */
  preload?: string;
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entryOf = (value: unknown): ChildSkillEntry => {
  const entry = typeof value === "string"
    ? { name: value.trim(), required: true }
    : isMapping(value) && typeof value.name === "string"
      ? { name: value.name.trim(), required: value.required !== false }
      : undefined;
  if (!entry?.name) throw new Error("Each skills entry must be a skill name");
  // Names only: a path would let a caller load a file this session never discovered.
  if (/[\\/]/.test(entry.name)) throw new Error("Skill " + JSON.stringify(entry.name) + " is a path; give the skill's name");
  return entry;
};

/**
 * Read the skills option: false (no skills), a list of names (preload them and
 * keep this session's other skills), or { preload, inherit }. Undefined leaves
 * the child's own skill discovery unchanged.
 */
export const childSkillsSelection = (value: unknown): ChildSkillsSelection | undefined => {
  if (value === undefined) return undefined;
  if (value === false) return { preload: [], inherit: false };
  if (Array.isArray(value)) return { preload: value.map(entryOf), inherit: true };
  if (isMapping(value)) {
    const preload = value.preload ?? [];
    if (!Array.isArray(preload)) throw new Error("skills.preload must be a list of skill names");
    if (value.inherit !== undefined && typeof value.inherit !== "boolean") throw new Error("skills.inherit must be true or false");
    return { preload: preload.map(entryOf), inherit: value.inherit !== false };
  }
  throw new Error("skills must be false, a list of skill names, or { preload, inherit }");
};

const stripFrontmatter = (source: string): string => {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  return end < 0 ? text.trim() : text.slice(end + 4).trim();
};

const attribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const show = (value: string): string => JSON.stringify(value);

const unknownSkills = (missing: string[], available: string[]): Error => {
  const [first] = missing;
  let suggestion: { name: string; distance: number } | undefined;
  for (const candidate of available) {
    const distance = editDistance(first!.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(first!.length / 3)) && (!suggestion || distance < suggestion.distance)) {
      suggestion = { name: candidate, distance };
    }
  }
  return new Error(
    (missing.length === 1 ? "Unknown skill " : "Unknown skills ") + missing.map(show).join(", ") + "." +
      (suggestion ? " Did you mean " + show(suggestion.name) + "?" : "") +
      (available.length > 0
        ? " Available skills: " + available.join(", ") + "."
        : " This session has no skills."),
  );
};

/**
 * Resolve the selection against this session's skills and read each listed
 * skill. Throws before any child starts when a required skill is unknown or
 * unreadable; a missing optional skill is skipped and reported through warn.
 */
export const resolveChildSkills = (
  selection: ChildSkillsSelection,
  parentSkills: readonly ParentSkill[],
  warn: (message: string) => void,
): ChildSkillsLaunch => {
  const byName = new Map<string, ParentSkill>();
  for (const skill of parentSkills) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const listed = new Map<string, ChildSkillEntry>();
  for (const entry of selection.preload) {
    const seen = listed.get(entry.name);
    listed.set(entry.name, seen ? { name: entry.name, required: seen.required || entry.required } : entry);
  }
  const missing = [...listed.values()].filter((entry) => entry.required && !byName.has(entry.name)).map((entry) => entry.name);
  if (missing.length > 0) throw unknownSkills(missing, [...byName.keys()].sort());

  const blocks: string[] = [];
  for (const entry of listed.values()) {
    const skill = byName.get(entry.name);
    if (!skill) {
      warn("Skill " + show(entry.name) + " is not available in this session; skipped because it is optional.");
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(skill.filePath, "utf8");
    } catch (error) {
      const detail = "Cannot read skill " + show(skill.name) + " at " + skill.filePath + ": " + (error instanceof Error ? error.message : String(error));
      if (entry.required) throw new Error(detail);
      warn(detail + "; skipped because it is optional.");
      continue;
    }
    blocks.push(
      `<skill name="${attribute(skill.name)}" location="${attribute(skill.filePath)}">\n` +
        `References are relative to ${path.dirname(skill.filePath)}.\n\n${stripFrontmatter(source)}\n</skill>`,
    );
  }
  const catalog = selection.inherit ? [...new Set(parentSkills.map((skill) => skill.filePath))] : [];
  return {
    catalog,
    ...(blocks.length > 0
      ? { preload: ["Apply the following skills when working on this task:", ...blocks].join("\n\n") }
      : {}),
  };
};
