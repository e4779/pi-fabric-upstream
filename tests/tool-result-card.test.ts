import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  BLEND_INTENSITY_MEDIUM,
  BLEND_INTENSITY_SUBTLE,
  FALLBACK_SEMANTIC_BG,
  blendSemanticBackground,
  blendThemeBackground,
  applyPaddedBackground,
} from "../src/ui/blend-background.js";
import {
  createFabricToolResultCardRenderer,
  fabricToolResultCardTone,
  renderFabricToolResultCard,
  renderToolResultTextFallback,
  TOOL_RESULT_CARD_BG_INTENSITY,
  TOOL_RESULT_CARD_EXPAND_MAX_LINES,
  TOOL_RESULT_CARD_PREVIEW_LINES,
  TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES,
  toolResultCardLines,
} from "../src/ui/tool-result-card.js";
import {
  FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
  readFabricToolResultCardV1,
  type FabricToolResultCardV1,
} from "../src/protocol.js";

const semanticTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const ansiTheme = (fgAnsi: Record<string, string>, bgAnsi: Record<string, string>) =>
  ({
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    getFgAnsi: (color: string) => fgAnsi[color],
    getBgAnsi: (color: string) => bgAnsi[color],
  }) as unknown as Theme;

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const visibleWidth = (text: string): number => stripAnsi(text).length;

const okCard = {
  schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
  kind: "ok",
  cmd: "make test",
  exitCode: 0,
  ms: 1234,
  tail: ["ok 1", "ok 2", "ok 3", "ok 4"],
  totalLines: 9,
  title: "suite",
} as const;

describe("readFabricToolResultCardV1", () => {
  it.each(["ok", "error", "timeout", "blocked", "backgrounded"] as const)(
    "accepts a well-formed %s card and copies it",
    (kind) => {
      const base = { schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION, cmd: "true", ms: 5 };
      const details = {
        ...base,
        ...(kind === "ok" ? { kind, exitCode: 0 } : {}),
        ...(kind === "error" ? { kind, exitCode: 2, error: "boom" } : {}),
        ...(kind === "timeout" ? { kind, exitCode: null } : {}),
        ...(kind === "blocked" ? { kind, reason: "bash -n refused" } : {}),
        ...(kind === "backgrounded" ? { kind, taskId: "bg-1", logPath: "/tmp/bg-1.log", pid: 42 } : {}),
      };
      const card = readFabricToolResultCardV1(details);
      expect(card?.kind).toBe(kind);
      // Defensive copy: mutating the input changes nothing.
      (details as { cmd?: string }).cmd = "changed";
      expect(card).not.toMatchObject({ cmd: "changed" });
    },
  );

  it("refuses payloads that are not complete v1 cards", () => {
    expect(readFabricToolResultCardV1(undefined)).toBeUndefined();
    expect(readFabricToolResultCardV1("ok")).toBeUndefined();
    expect(readFabricToolResultCardV1([])).toBeUndefined();
    expect(readFabricToolResultCardV1({ kind: "ok", exitCode: 0 })).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 2, kind: "ok" }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "sh", cmd: "true" }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "blocked" }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "backgrounded" }),
    ).toBeUndefined();
  });

  it("refuses malformed fields instead of guessing them away", () => {
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "ok", ms: "1200" }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "ok", tail: [1, 2] }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "ok", exitCode: null }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "ok", exitCode: "0" }),
    ).toBeUndefined();
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "error", totalLines: -1 }),
    ).toBeUndefined();
  });

  it("allows null exit codes on error and timeout only", () => {
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "error", exitCode: null }),
    ).toMatchObject({ kind: "error", exitCode: null });
    expect(
      readFabricToolResultCardV1({ schemaVersion: 1, kind: "timeout" }),
    ).toMatchObject({ kind: "timeout" });
  });
});

describe("fabricToolResultCardTone", () => {
  it("maps every kind to its semantic tone", () => {
    const toneOf = (kind: FabricToolResultCardV1["kind"]): string => {
      const card = readFabricToolResultCardV1({
        schemaVersion: 1,
        kind,
        ...(kind === "blocked" ? { reason: "no" } : {}),
        ...(kind === "backgrounded" ? { taskId: "bg-1" } : {}),
      })!;
      return fabricToolResultCardTone(card);
    };
    expect(toneOf("ok")).toBe("success");
    expect(toneOf("error")).toBe("error");
    expect(toneOf("timeout")).toBe("warning");
    expect(toneOf("blocked")).toBe("warning");
    expect(toneOf("backgrounded")).toBe("neutral");
  });

  it("keeps the fork's intensity pair: success rests, failure alerts", () => {
    expect(TOOL_RESULT_CARD_BG_INTENSITY.success).toBe(BLEND_INTENSITY_SUBTLE);
    expect(TOOL_RESULT_CARD_BG_INTENSITY.error).toBe(BLEND_INTENSITY_MEDIUM);
    expect(TOOL_RESULT_CARD_BG_INTENSITY.warning).toBe(BLEND_INTENSITY_MEDIUM);
    expect(TOOL_RESULT_CARD_BG_INTENSITY.neutral).toBe(BLEND_INTENSITY_SUBTLE);
  });
});

describe("toolResultCardLines", () => {
  it("draws the collapsed card: title, command, preview, expand hint, status last", () => {
    const lines = toolResultCardLines(readFabricToolResultCardV1(okCard)!, { expanded: false }, semanticTheme);
    expect(lines[0]).toBe("<accent>suite</accent>");
    expect(lines[1]).toBe("<dim>❯ </dim><bold>make test</bold>");
    expect(lines[2]).toBe("");
    expect(lines.slice(3, 3 + TOOL_RESULT_CARD_PREVIEW_LINES)).toEqual([
      "<toolOutput>ok 1</toolOutput>",
      "<toolOutput>ok 2</toolOutput>",
      "<toolOutput>ok 3</toolOutput>",
    ]);
    expect(lines[6]).toBe("<dim>… 6 lines · </dim><dim>ctrl-o to expand</dim>");
    expect(lines.at(-1)).toBe("<success>✓ exit 0 · 1.2s</success>");
  });

  it("marks multi-line commands with a +N lines marker", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "ok",
      cmd: "echo one\necho two\necho three",
    })!;
    const lines = toolResultCardLines(card, { expanded: false }, plainTheme);
    expect(lines[0]).toBe("❯ echo one … +2 lines");
  });

  it("renders the full output when expanded, without a hint", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "error",
      cmd: "false",
      exitCode: 1,
      output: ["l1", "l2", "l3", "l4", "l4"].join("\n"),
      totalLines: 5,
    })!;
    const lines = toolResultCardLines(card, { expanded: true }, plainTheme);
    expect(lines).toEqual([
      "❯ false",
      "",
      "l1",
      "l2",
      "l3",
      "l4",
      "l4",
      "✗ exit 1",
    ]);
    expect(lines.some((line) => line.includes("expand"))).toBe(false);
  });

  it("caps the expanded body at the renderResult line budget", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "ok",
      output: Array.from({ length: TOOL_RESULT_CARD_EXPAND_MAX_LINES + 25 }, (_, i) => `l${i}`).join("\n"),
    })!;
    const lines = toolResultCardLines(card, { expanded: true }, plainTheme);
    const body = lines.slice(1, -1); // between the leading blank and the status line
    expect(body.length).toBe(TOOL_RESULT_CARD_EXPAND_MAX_LINES);
    expect(body.at(-1)).toBe(`l${TOOL_RESULT_CARD_EXPAND_MAX_LINES - 1}`);
    expect(lines.at(-1)).toBe("✓ exit 0");
  });

  it("shows the error summary when the output is empty", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "error",
      exitCode: 127,
      error: "command not found",
    })!;
    const lines = toolResultCardLines(card, { expanded: false }, plainTheme);
    expect(lines).toEqual(["command not found", "✗ exit 127"]);
  });

  it("previews the blocked reason and renders the veto glyph", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "blocked",
      reason: ["bash -n: line 2: syntax error", "context", "third", "fourth", "fifth"].join("\n"),
    })!;
    const lines = toolResultCardLines(card, { expanded: false }, plainTheme);
    expect(lines).toEqual([
      "",
      "bash -n: line 2: syntax error",
      "context",
      "third",
      "… 2 lines · ctrl-o to expand",
      "⊘ blocked",
    ]);
  });

  it("renders the backgrounded handle: task id, log path, pid", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: 1,
      kind: "backgrounded",
      taskId: "bg-7",
      cmd: "sleep 300",
      logPath: "/tmp/bg-7.log",
      pid: 4242,
      ms: 90_000,
    })!;
    const lines = toolResultCardLines(card, { expanded: false }, plainTheme);
    expect(lines).toEqual([
      "❯ sleep 300",
      "log /tmp/bg-7.log",
      "● background bg-7 · 90.0s · pid 4242",
    ]);
  });
});

describe("blendSemanticBackground", () => {
  it("blends the tone foreground into the tone background", () => {
    const theme = ansiTheme(
      { success: "\x1b[38;2;74;150;84m" },
      { toolSuccessBg: "\x1b[48;2;10;10;10m" },
    );
    // 10 + (74-10)*0.5 = 42, 10 + (150-10)*0.5 = 80, 10 + (84-10)*0.5 = 47
    expect(blendSemanticBackground(theme, "success", 0.5)).toBe("\x1b[48;2;42;80;47m");
  });

  it("parses 256-index theme colors", () => {
    const theme = ansiTheme({ error: "\x1b[38;5;196m" }, { toolErrorBg: "\x1b[48;5;16m" });
    // 196 -> (255,0,0); 16 -> (0,0,0); 0 + 255*0.1 = 26 (rounded)
    expect(blendThemeBackground(theme, { fg: "error", bg: "toolErrorBg" }, 0.1)).toBe(
      "\x1b[48;2;26;0;0m",
    );
  });

  it("falls back per theme variant when the theme has no usable SGR", () => {
    expect(blendSemanticBackground(plainTheme, "success", 0.2)).toBe(
      FALLBACK_SEMANTIC_BG.success.dark,
    );
    expect(blendSemanticBackground(undefined, "error", 0.2)).toBe(
      FALLBACK_SEMANTIC_BG.error.dark,
    );
  });

  it("returns undefined from blendThemeBackground when the fg token does not resolve", () => {
    expect(blendThemeBackground(plainTheme, { fg: "success", bg: "toolSuccessBg" }, 0.5)).toBeUndefined();
  });
});

describe("applyPaddedBackground", () => {
  it("opens the fill, re-opens it after resets, and closes at end of line", () => {
    const bg = "\x1b[48;2;1;2;3m";
    const painted = applyPaddedBackground(`a\x1b[0mb`, bg);
    expect(painted.startsWith(bg)).toBe(true);
    expect(painted.endsWith("\x1b[0m")).toBe(true);
    expect(painted).toContain(`\x1b[0m${bg}b`);
    expect(visibleWidth(painted)).toBe(2);
  });
});

describe("renderFabricToolResultCard", () => {
  it("paints one derived background on every padded row of the card", () => {
    const card = readFabricToolResultCardV1(okCard)!;
    const rows = renderFabricToolResultCard(card, { expanded: false }, plainTheme).render(40);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.startsWith("\x1b[48;2;")).toBe(true);
      expect(row.endsWith("\x1b[0m")).toBe(true);
      expect(visibleWidth(row)).toBe(40);
    }
    expect(rows.some((row) => stripAnsi(row).includes("✓ exit 0 · 1.2s"))).toBe(true);
    expect(rows.some((row) => stripAnsi(row).includes("… +5 lines · ctrl-o to expand")
      || stripAnsi(row).includes("… 6 lines · ctrl-o to expand"))).toBe(true);
  });

  it("matches the reference snapshots (semantic theme, width 40)", () => {
    const okRows = renderFabricToolResultCard(readFabricToolResultCardV1(okCard)!, { expanded: false }, semanticTheme).render(40);
    expect(okRows).toMatchSnapshot("ok-collapsed");
    const errorRows = renderFabricToolResultCard(
      readFabricToolResultCardV1({
        schemaVersion: 1,
        kind: "error",
        cmd: "cargo build",
        exitCode: 101,
        ms: 45_000,
        tail: ["error[E0308]: mismatched types", " --> src/main.rs:2:3"],
        totalLines: 120,
      })!,
      { expanded: true },
      semanticTheme,
    ).render(40);
    expect(errorRows).toMatchSnapshot("error-expanded");
  });
});

describe("renderToolResultTextFallback", () => {
  const result = (lines: number) => ({
    content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") }],
  });

  it("previews 12 lines with an expand hint while collapsed", () => {
    const rows = renderToolResultTextFallback(result(20), { expanded: false }, plainTheme).render(80);
    expect(rows.length).toBe(TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES + 1);
    expect(stripAnsi(rows[0]!).trimEnd()).toBe("line 1");
    expect(stripAnsi(rows.at(-1)!).trimEnd())
      .toBe(`… ${20 - TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES} lines · ctrl-o to expand`);
  });

  it("shows everything when expanded, nothing when empty", () => {
    expect(
      renderToolResultTextFallback(result(3), { expanded: true }, plainTheme).render(80).length,
    ).toBe(3);
    expect(renderToolResultTextFallback({ content: [] }, { expanded: false }, plainTheme).render(80)).toEqual([]);
  });
});

describe("createFabricToolResultCardRenderer", () => {
  const renderer = createFabricToolResultCardRenderer();

  it("leaves reserved tools and MCP tools to their own renderers", () => {
    for (const name of ["fabric_exec", "bash", "read", "mcp__docs__search"]) {
      const base = { renderResult: () => null as never };
      expect(renderer(name, () => base)).toBe(base);
    }
  });

  it("keeps a renderResult a tool already brings", () => {
    const own = () => null as never;
    const base = { renderResult: own };
    expect(renderer("shell", () => base)).toBe(base);
  });

  it("adds a schema-reading renderResult to any other tool", () => {
    const added = renderer("shell", () => undefined);
    expect(typeof added?.renderResult).toBe("function");
    const rows = added!.renderResult!(
      { content: [], details: { ...okCard } } as never,
      { expanded: false, isPartial: false },
      plainTheme,
      {} as never,
    ).render(40);
    expect(rows.some((row) => stripAnsi(row).includes("✓ exit 0 · 1.2s"))).toBe(true);
  });

  it("falls back to plain text for details outside the schema", () => {
    const added = renderer("shell", () => ({} as ToolRenderers));
    const rows = added!.renderResult!(
      { content: [{ type: "text", text: "plain output" }] } as never,
      { expanded: false, isPartial: false },
      plainTheme,
      {} as never,
    ).render(40);
    expect(rows.some((row) => stripAnsi(row).trim() === "plain output")).toBe(true);
  });
});
