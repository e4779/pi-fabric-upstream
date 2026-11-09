import type { Skill } from "@earendil-works/pi-coding-agent";

// Local mirrors of the host skill helpers (pi core/skills.js and
// core/agent-session.js). Kept line-for-line identical so prompt output and
// skill-block parsing behave exactly as the host's, without importing the
// host package during extension load.

const escapeXml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Names the tool that loads skill files; `indirect` names none, for a reader
 * that is reachable only through another tool. */
export type SkillFileReadTool = "read" | "bash" | "indirect";

export const formatSkillsForPrompt = (
  skills: readonly Skill[],
  fileReadTool: SkillFileReadTool = "read",
): string => {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    fileReadTool === "read"
      ? "Use the read tool to load a skill's file when the task matches its description."
      : fileReadTool === "bash"
        ? "Use bash to load a skill's file when the task matches its description."
        : "Load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
};

export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

export const parseSkillBlock = (text: string): ParsedSkillBlock | null => {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1]!,
    location: match[2]!,
    content: match[3]!,
    userMessage: match[4]?.trim() || undefined,
  };
};
