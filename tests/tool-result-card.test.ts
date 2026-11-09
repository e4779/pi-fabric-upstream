import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  toolResultCardsEnvOff,
  TOOL_RESULT_CARDS_ENV,
  renderFabricToolResultCard,
  renderToolResultTextFallback,
  TOOL_RESULT_CARD_BG_INTENSITY,
  TOOL_RESULT_CARD_EXPAND_MAX_LINES,
  TOOL_RESULT_CARD_PREVIEW_LINES,
  TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES,
  toolResultCardLines,
} from "../src/ui/tool-result-card.js";
import {
  FABRIC_RENDER_CARD_EVENT,
  FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
  readFabricToolResultCardContractV1,
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
    // `sh` is a v1 kind now (a producer shape), only with its required cmd.
    expect(readFabricToolResultCardV1({ schemaVersion: 1, kind: "sh" })).toBeUndefined();
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

  it("keeps the named intensity pair: success rests, failure alerts", () => {
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


// ---- Producer-shape conformance: the union must carry every
// producer shape that exists today, so adoption is adding schemaVersion: 1.

describe("v1 union covers the producer shapes", () => {
  /** Today's tool-arm cast: ShellResult (shell.ts ~:526). */
  const shellCast = {
    ok: false,
    exitCode: null,
    output: "fatal: not a git repository",
    timedOut: false,
    aborted: true,
  };

  it("carries a foreground shell-tool cast field-for-field as error", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "error",
      exitCode: shellCast.exitCode,
      aborted: shellCast.aborted,
      output: shellCast.output,
      totalLines: 1,
    });
    expect(card).toMatchObject({ kind: "error", exitCode: null, aborted: true });
    expect(fabricToolResultCardTone(card!)).toBe("warning");
    const lines = toolResultCardLines(card!, { expanded: false }, plainTheme);
    expect(lines.at(-1)).toBe("⏹ stopped");
  });

  it("maps the cast's timedOut run onto the timeout kind", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "timeout",
      exitCode: null,
      ms: 30_000,
      tail: ["partial output"],
    });
    expect(card).toMatchObject({ kind: "timeout", exitCode: null });
    expect(fabricToolResultCardTone(card!)).toBe("warning");
  });

  it("keeps a timeout that raced an abort distinguishable from a plain timeout", () => {
    // The shell-exec race: the deadline kill and the operator abort can both
    // land on one outcome (timedOut AND aborted true). The timeout kind wins
    // (the deadline is the more specific stop) and the aborted slot keeps the
    // second state visible — the card must discriminate the two outcomes.
    const raced = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "timeout",
      exitCode: null,
      ms: 30_000,
      aborted: true,
      tail: ["partial output"],
    });
    const plain = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "timeout",
      exitCode: null,
      ms: 30_000,
      tail: ["partial output"],
    });
    expect(raced).toMatchObject({ kind: "timeout", aborted: true });
    expect((plain as { aborted?: boolean }).aborted).toBeUndefined();
    expect(fabricToolResultCardTone(raced!)).toBe("warning");
    const racedLine = toolResultCardLines(raced!, { expanded: false }, plainTheme).at(-1);
    const plainLine = toolResultCardLines(plain!, { expanded: false }, plainTheme).at(-1);
    expect(racedLine).toBe("⏱ timeout · aborted · 30.0s");
    expect(plainLine).toBe("⏱ timeout · 30.0s");
    expect(racedLine).not.toBe(plainLine); // the states stay distinguishable
    // Refuse-not-guess: a malformed aborted slot rejects the whole card.
    expect(readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "timeout",
      aborted: "yes",
    })).toBeUndefined();
  });

  it("maps the cast's detached run onto backgrounded with taskId, logPath, pid", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "backgrounded",
      taskId: "bg-7",
      logPath: "/tmp/bg-7.log",
      pid: 4242,
    });
    expect(card).toMatchObject({ kind: "backgrounded", taskId: "bg-7", logPath: "/tmp/bg-7.log", pid: 4242 });
  });

  it("maps the blocked ad-hoc result onto blocked with the refusal text", () => {
    // Today's blocked shape: { ok:false, blocked:true, exitCode:null, output, timedOut:false, aborted:false }.
    const card = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "blocked",
      reason: "[blocked by shell-gate, command not run]",
    });
    expect(card).toMatchObject({ kind: "blocked", reason: "[blocked by shell-gate, command not run]" });
  });

  it("round-trips a prose sh payload under its own field names", () => {
    const payload = {
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "sh",
      cmd: "cargo test",
      exit: 101,
      ms: 45_000,
      timedOut: false,
      tail: ["failures:"],
      out: "test result: FAILED",
      totalLines: 12,
      title: "build",
    };
    const card = readFabricToolResultCardV1(payload);
    expect(card).toEqual(payload); // byte-for-byte adoption: nothing renamed
    expect(fabricToolResultCardTone(card!)).toBe("error");
    const lines = toolResultCardLines(card!, { expanded: false }, plainTheme);
    expect(lines.at(-1)).toBe("✗ exit 101 · 45.0s");
  });

  it("maps a timed-out prose sh payload onto the warning tone", () => {
    const card = readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "sh",
      cmd: "sleep 100",
      exit: null,
      timedOut: true,
    });
    expect(card).toMatchObject({ kind: "sh", timedOut: true });
    expect(fabricToolResultCardTone(card!)).toBe("warning");
    expect(toolResultCardLines(card!, { expanded: false }, plainTheme).at(-1)).toBe("⏱ timeout");
  });

  it("round-trips a prose img payload", () => {
    const payload = {
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "img",
      paths: ["/tmp/a.png", "/tmp/b.png"],
    };
    const card = readFabricToolResultCardV1(payload);
    expect(card).toEqual(payload);
    const lines = toolResultCardLines(card!, { expanded: false }, plainTheme);
    expect(lines).toEqual(["● img /tmp/a.png, /tmp/b.png"]);
    expect(fabricToolResultCardTone(card!)).toBe("neutral");
  });

  it("refuses an img payload without paths", () => {
    expect(readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "img",
      paths: [],
    })).toBeUndefined();
    expect(readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "img",
      paths: "nope",
    })).toBeUndefined();
  });

  it("round-trips a prose bg payload and keeps the collapsed handle two lines", () => {
    const payload = {
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "bg",
      id: "bg-3",
      cmd: "make build\necho done",
      logPath: "/tmp/bg-3.log",
      pid: 7,
    };
    const card = readFabricToolResultCardV1(payload);
    expect(card).toEqual(payload);
    const collapsed = toolResultCardLines(card!, { expanded: false }, plainTheme);
    expect(collapsed).toEqual([
      "❯ make build … +1 lines",
      "log /tmp/bg-3.log",
      "● bg bg-3 · pid 7",
    ]);
    const expanded = toolResultCardLines(card!, { expanded: true }, plainTheme);
    expect(expanded.join("\n")).toContain("done");
    expect(expanded.at(-1)).toBe("● bg bg-3 · pid 7");
  });

  it("refuses a bg payload missing its required handles", () => {
    expect(readFabricToolResultCardV1({
      schemaVersion: FABRIC_TOOL_RESULT_CARD_SCHEMA_VERSION,
      kind: "bg",
      id: "bg-3",
      cmd: "make build",
    })).toBeUndefined();
  });

  it("still refuses the raw unversioned producer shapes", () => {
    // Adoption is opt-in: the cast, the blocked ad-hoc shape, and the prose
    // payloads without schemaVersion claim no contract and stay plain text.
    expect(readFabricToolResultCardV1(shellCast)).toBeUndefined();
    expect(readFabricToolResultCardV1({
      ok: false, blocked: true, exitCode: null, output: "veto", timedOut: false, aborted: false,
    })).toBeUndefined();
    expect(readFabricToolResultCardV1({ kind: "sh", cmd: "true", exit: 0 })).toBeUndefined();
    expect(readFabricToolResultCardContractV1(shellCast)).toEqual({ contract: false });
  });
});

describe("readFabricToolResultCardContractV1", () => {
  it("classifies legacy details as claiming no contract", () => {
    expect(readFabricToolResultCardContractV1(undefined)).toEqual({ contract: false });
    expect(readFabricToolResultCardContractV1({ rows: 3 })).toEqual({ contract: false });
    expect(readFabricToolResultCardContractV1("text")).toEqual({ contract: false });
    expect(readFabricToolResultCardContractV1([])).toEqual({ contract: false });
  });

  it("reports a card for a well-formed payload", () => {
    const read = readFabricToolResultCardContractV1({ ...okCard });
    expect(read).toEqual({ contract: true, card: { ...okCard } });
  });

  it("refuses a claimed contract with the version reason", () => {
    const read = readFabricToolResultCardContractV1({ schemaVersion: 2, kind: "ok" });
    expect(read).toEqual({ contract: true, refused: true, reason: "schemaVersion 2" });
    expect(readFabricToolResultCardContractV1({ schemaVersion: "1", kind: "ok" })).toMatchObject({
      refused: true, reason: "schemaVersion 1",
    });
  });

  it("refuses a claimed contract with the kind reason", () => {
    expect(readFabricToolResultCardContractV1({ schemaVersion: 1, kind: "deploy" })).toMatchObject({
      refused: true, reason: 'kind "deploy"',
    });
    expect(readFabricToolResultCardContractV1({ schemaVersion: 1, blocked: true })).toMatchObject({
      refused: true, reason: "kind undefined",
    });
  });

  it("refuses a malformed v1 payload with a field reason", () => {
    expect(readFabricToolResultCardContractV1({ schemaVersion: 1, kind: "ok", tail: [1] })).toMatchObject({
      refused: true, reason: "malformed field",
    });
  });
});

describe("card telemetry", () => {
  const render = (
    resolver: ReturnType<typeof createFabricToolResultCardRenderer>,
    details: unknown,
    toolCallId = "call-1",
  ): string[] => {
    const added = resolver("shell", () => ({} as ToolRenderers))!;
    return added.renderResult!(
      { content: [{ type: "text", text: "plain output" }], details } as never,
      { expanded: false, isPartial: false },
      plainTheme,
      { toolCallId } as never,
    ).render(40).map(stripAnsi);
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one fallback line per tool call for legacy details", () => {
    const events: unknown[] = [];
    const resolver = createFabricToolResultCardRenderer({ emit: (event) => events.push(event) });
    const rows = render(resolver, { rows: 3 });
    expect(rows.some((row) => row.trim() === "plain output")).toBe(true);
    expect(events).toEqual([{ version: 1, tool: "shell", outcome: "fallback", toolCallId: "call-1" }]);
    render(resolver, { rows: 3 });
    expect(events.length).toBe(1); // one line per tool call, re-renders included
    render(resolver, { rows: 3 }, "call-2");
    expect(events.length).toBe(2);
  });

  it("emits one refused line with the reason and warns on the console", () => {
    const events: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = createFabricToolResultCardRenderer({ emit: (event) => events.push(event) });
    render(resolver, { schemaVersion: 2, kind: "ok" });
    expect(events).toEqual([{
      version: 1, tool: "shell", outcome: "refused", reason: "schemaVersion 2", toolCallId: "call-1",
    }]);
    expect(warn).toHaveBeenCalledWith(
      "[pi-fabric] tool-result card refused for shell (schemaVersion 2); rendered as plain text",
    );
    render(resolver, { schemaVersion: 2, kind: "ok" });
    expect(events.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when the card reads", () => {
    const events: unknown[] = [];
    const resolver = createFabricToolResultCardRenderer({ emit: (event) => events.push(event) });
    const rows = render(resolver, { ...okCard });
    expect(rows.some((row) => row.includes("✓ exit 0 · 1.2s"))).toBe(true);
    expect(events).toEqual([]);
  });

  it("keeps rendering when the telemetry sink throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = createFabricToolResultCardRenderer({
      emit: () => {
        throw new Error("sink down");
      },
    });
    const rows = render(resolver, { rows: 3 });
    expect(rows.some((row) => row.trim() === "plain output")).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // a fallback stays off the console
  });
});

describe("card renderer opt-out", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("documents the env switch name and the off value", () => {
    expect(TOOL_RESULT_CARDS_ENV).toBe("PI_FABRIC_TOOL_RESULT_CARDS");
    expect(toolResultCardsEnvOff({ [TOOL_RESULT_CARDS_ENV]: "off" })).toBe(true);
    expect(toolResultCardsEnvOff({ [TOOL_RESULT_CARDS_ENV]: "on" })).toBe(false);
    expect(toolResultCardsEnvOff({})).toBe(false);
  });

  it("hands the next resolver back when disabled, config side or env side", () => {
    const base = { renderResult: () => null as never };
    const next = () => base;
    const off = createFabricToolResultCardRenderer({ enabled: () => false });
    expect(off("shell", next)).toBe(base);
    vi.stubEnv(TOOL_RESULT_CARDS_ENV, "off");
    const envOff = createFabricToolResultCardRenderer();
    expect(envOff("shell", next)).toBe(next());
    vi.stubEnv(TOOL_RESULT_CARDS_ENV, "on");
    const on = createFabricToolResultCardRenderer();
    expect(typeof on("shell", () => undefined)?.renderResult).toBe("function");
  });

  it("exposes the telemetry channel name from the protocol", () => {
    expect(FABRIC_RENDER_CARD_EVENT).toBe("pi-fabric:render:card:v1");
  });
});
