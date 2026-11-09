import {
  buildSessionContext,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  formatSkillsForPrompt,
  getAgentDir,
  parseSkillBlock,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentDir } from "../src/core/agent-dir.js";
import { parseSkillBlock as localParseSkillBlock, formatSkillsForPrompt as localFormatSkillsForPrompt } from "../src/core/skill-block.js";
import { calculateContextTokens as localCalculateContextTokens, DEFAULT_COMPACTION_SETTINGS as localCompactionSettings, estimateTokens as localEstimateTokens } from "../src/core/token-math.js";
import { buildSessionContext as localBuildSessionContext, sessionEntryToContextMessages as localSessionEntry } from "../src/core/session-context.js";

const envBackup = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  const path = envBackup;
  if (path === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = path;
});

describe("host parity", () => {
  it("formats skill blocks identically", () => {
    // Shape cast: the parity probe only compares formatter output, while the
    // installed host's Skill type has grown extra fields across versions.
    const skills = [
      { name: "A&B <cool> 'quotes' \"inside\"", description: "desc <1> & 'two'", filePath: "/tmp/skills/a/SKILL.md" },
      { name: "disabled", description: "hidden", filePath: "/tmp/skills/b/SKILL.md", disableModelInvocation: true },
    ] as unknown as import("@earendil-works/pi-coding-agent").Skill[];
    expect(localFormatSkillsForPrompt(skills)).toBe(formatSkillsForPrompt(skills));
    expect(localFormatSkillsForPrompt([])).toBe(formatSkillsForPrompt([]));
    expect(localFormatSkillsForPrompt(skills.slice(1))).toBe(formatSkillsForPrompt(skills.slice(1)));
    for (const fileReadTool of ["read", "bash", "indirect"] as const) {
      expect(localFormatSkillsForPrompt(skills, fileReadTool)).toBe(formatSkillsForPrompt(skills, fileReadTool));
    }
  });

  it("parses skill blocks identically", () => {
    const withMessage = `<skill name="a" location="L">
body
</skill>

user tail`;
    expect(localParseSkillBlock(withMessage)).toEqual(parseSkillBlock(withMessage));
    const withoutMessage = `<skill name="a" location="L">
body
</skill>`;
    expect(localParseSkillBlock(withoutMessage)).toEqual(parseSkillBlock(withoutMessage));
    expect(localParseSkillBlock("plain text")).toBe(parseSkillBlock("plain text"));
  });

  it("estimates and context-counts tokens identically", () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "user", content: [{ type: "text", text: "abc" }, { type: "image" }] },
      { role: "assistant", content: [{ type: "text", text: "abcd" }, { type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] },
      { role: "toolResult", content: "output" },
      { role: "custom", customType: "x", content: "custom text" },
      { role: "bashExecution", command: "echo hi", output: "hi" },
      { role: "branchSummary", summary: "branch" },
      { role: "compactionSummary", summary: "compaction" },
      { role: "unknown", content: "ignored" },
    ];
    for (const message of messages) {
      expect(localEstimateTokens(message as never)).toBe(estimateTokens(message as never));
    }
    // Host accesses .totalTokens directly; Fabric's port also tolerates
    // undefined usage, and empty-numeric components, NaN-producing for the
    // host, so invalid-domain inputs are deliberately left out of parity.
    const usages = [
      { totalTokens: 1000 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 0 },
    ];
    for (const usage of usages) {
      expect(localCalculateContextTokens(usage)).toBe(
        calculateContextTokens(usage as never),
      );
    }
    expect(localCalculateContextTokens(undefined)).toBe(0);
    expect(localCompactionSettings).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it("projects session entries to context messages identically", () => {
    const entries: SessionEntry[] = ([
      { id: "u1", type: "message", timestamp: 10, message: { role: "user", content: null } },
      {
        id: "m1", type: "message", timestamp: 11,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4" },
      },
      {
        id: "c1", type: "custom_message", timestamp: 12, customType: "wave",
        content: [{ type: "text", text: "yo" }], display: true, details: { a: 1 },
      },
      { id: "b1", type: "branch_summary", timestamp: 13, summary: "sum", fromId: "u1" },
      { id: "p1", type: "compaction", timestamp: 14, summary: "compacted", tokensBefore: 500, firstKeptEntryId: "m1" },
      { id: "v1", type: "var", timestamp: 15, key: "k", value: "v" },
    ] as unknown as SessionEntry[]);
    for (const entry of entries) {
      expect(localSessionEntry(entry)).toEqual(sessionEntryToContextMessages(entry));
    }
  });

  it("builds session context identically", () => {
    const entries = ([
      { id: "root", type: "message", timestamp: 1, message: { role: "user", content: "start" } },
      {
        id: "t", type: "thinking_level_change", timestamp: 2, thinkingLevel: "high",
        parentId: "root",
      },
      {
        id: "mc", type: "model_change", timestamp: 3, provider: "anthropic", modelId: "sonnet",
        parentId: "t",
      },
      {
        id: "p1", type: "compaction", timestamp: 4, summary: "sum", tokensBefore: 10,
        firstKeptEntryId: "t", parentId: "mc",
      },
      {
        id: "tail", type: "message", timestamp: 5,
        message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "anthropic", model: "sonnet" },
        parentId: "p1",
      },
      { id: "tk", type: "toolResult", timestamp: 6, message: { role: "toolResult", content: "out" }, parentId: "tail" },
    ] as unknown as SessionEntry[]);
    expect(localBuildSessionContext(entries)).toEqual(buildSessionContext(entries));
    expect(localBuildSessionContext(entries, "tail")).toEqual(buildSessionContext(entries, "tail"));
  });

  it("resolves the agent directory identically", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(resolveAgentDir()).toBe(getAgentDir());
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-parity";
    expect(resolveAgentDir()).toBe(getAgentDir());
    process.env.PI_CODING_AGENT_DIR = "~/pi-agent-parity";
    expect(resolveAgentDir()).toBe(getAgentDir());
  });
});
