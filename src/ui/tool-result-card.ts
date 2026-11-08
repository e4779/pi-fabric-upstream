// The shared tool-result card: the render side of the typed details contract
// (protocol.ts FabricToolResultCardV1). Any registered tool that fills its
// result `details` with a v1 card gets fork-quality rendering — semantic
// tones, a theme-blended background, collapsed preview with an expand hint —
// through the normal renderResult pipeline, without ANSI of its own.
// Reference card: shell-lab shell-prose.ts buildCardLines/buildCardBgFn.
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { PI_CORE_TOOL_NAMES } from "../core/pi-tools.js";
import { readFabricToolResultCardV1, type FabricToolResultCardV1 } from "../protocol.js";
import {
  applyPaddedBackground,
  blendSemanticBackground,
  BLEND_INTENSITY_MEDIUM,
  BLEND_INTENSITY_SUBTLE,
  type SemanticBgTone,
} from "./blend-background.js";
import { expandHint, safeTerminalText } from "./fabric-render.js";

/** Tail lines shown on the collapsed card (reference: preview 3). */
export const TOOL_RESULT_CARD_PREVIEW_LINES = 3;
/** Line cap for the expanded card body (fork renderResult bodies cap at 200). */
export const TOOL_RESULT_CARD_EXPAND_MAX_LINES = 200;
/** Lines of plain text a non-card result previews when collapsed. */
export const TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES = 12;

/** Blend intensity per tone: success rests, failure alerts (fork diff pair). */
export const TOOL_RESULT_CARD_BG_INTENSITY: Record<SemanticBgTone, number> = {
  success: BLEND_INTENSITY_SUBTLE,
  error: BLEND_INTENSITY_MEDIUM,
  warning: BLEND_INTENSITY_MEDIUM,
  neutral: BLEND_INTENSITY_SUBTLE,
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const formatCardMs = (ms: number | undefined): string | undefined => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
};

/** The card's semantic tone: the status color and the blended background. */
export const fabricToolResultCardTone = (card: FabricToolResultCardV1): SemanticBgTone => {
  switch (card.kind) {
    case "ok":
      return "success";
    case "error":
      return "error";
    case "timeout":
    case "blocked":
      return "warning";
    case "backgrounded":
      return "neutral";
  }
};

const cardStatusLine = (card: FabricToolResultCardV1, theme: Theme): string => {
  const duration = formatCardMs(card.ms);
  const suffix = duration ? ` · ${duration}` : "";
  switch (card.kind) {
    case "ok":
      return theme.fg("success", `✓ exit ${card.exitCode ?? 0}${suffix}`);
    case "error":
      return theme.fg("error", `✗ exit ${card.exitCode ?? "?"}${suffix}`);
    case "timeout":
      return theme.fg("warning", `⏱ timeout${suffix}`);
    case "blocked":
      return theme.fg("warning", `⊘ blocked${suffix}`);
    case "backgrounded": {
      const pid = typeof card.pid === "number" ? theme.fg("dim", ` · pid ${card.pid}`) : "";
      return theme.fg("accent", `● background ${card.taskId}${suffix}`) + pid;
    }
  }
};

/**
 * The card's transcript lines, pure and theme-injected:
 *   [0]   optional accent title
 *   [1]   dim `❯ ` + bold first command line (+ dim ` … +N lines` marker)
 *   [2+]  blank + output tail preview (or the full body when expanded), with a
 *         dim `… +N lines · ctrl-o to expand` hint while collapsed
 *   [last] the outcome line, under the output
 * Blocked cards preview the refusal reason instead of output; backgrounded
 * cards carry the log path handle line.
 */
export const toolResultCardLines = (
  card: FabricToolResultCardV1,
  options: Pick<ToolRenderResultOptions, "expanded">,
  theme: Theme,
): string[] => {
  const lines: string[] = [];
  const title = card.title?.trim();
  if (title) lines.push(theme.fg("accent", safeTerminalText(title)));

  const commandLines = typeof card.cmd === "string" ? card.cmd.split("\n") : [];
  if (commandLines.length > 0) {
    let command = theme.fg("dim", "❯ ") + theme.bold(safeTerminalText(commandLines[0] ?? "") || " ");
    if (commandLines.length > 1) {
      command += theme.fg("dim", ` … +${commandLines.length - 1} lines`);
    }
    lines.push(command);
  }

  const outputLines = typeof card.output === "string" && card.output !== ""
    ? safeTerminalText(card.output).split("\n")
    : [];
  const tail = Array.isArray(card.tail) ? card.tail.map((line) => safeTerminalText(line)) : [];
  if (card.kind === "backgrounded" && typeof card.logPath === "string") {
    lines.push(theme.fg("dim", `log ${safeTerminalText(card.logPath)}`));
  }

  if (card.kind === "blocked") {
    const reasonLines = safeTerminalText(card.reason).split("\n");
    const shown = options.expanded
      ? reasonLines.slice(0, TOOL_RESULT_CARD_EXPAND_MAX_LINES)
      : reasonLines.slice(0, TOOL_RESULT_CARD_PREVIEW_LINES);
    if (shown.length > 0) {
      lines.push("");
      for (const line of shown) lines.push(theme.fg("warning", line || " "));
      const hidden = reasonLines.length - shown.length;
      if (hidden > 0 && !options.expanded) {
        lines.push(theme.fg("dim", `… ${countLabel(hidden, "line")} · `) + expandHint(theme));
      }
    }
  } else {
    const total = typeof card.totalLines === "number" && card.totalLines >= 0
      ? card.totalLines
      : outputLines.length || tail.length;
    if (options.expanded) {
      const full = (outputLines.length > 0 ? outputLines : tail)
        .slice(0, TOOL_RESULT_CARD_EXPAND_MAX_LINES);
      if (full.length > 0) {
        lines.push("");
        // Output stays toolOutput-fg: dim-on-tint reads washed out (reference).
        for (const line of full) lines.push(theme.fg("toolOutput", line || " "));
      }
    } else {
      const preview = (tail.length > 0 ? tail : outputLines.slice(-TOOL_RESULT_CARD_PREVIEW_LINES))
        .slice(0, TOOL_RESULT_CARD_PREVIEW_LINES);
      if (preview.length > 0) {
        lines.push("");
        for (const line of preview) lines.push(theme.fg("toolOutput", line || " "));
        const hidden = total - preview.length;
        if (hidden > 0) {
          lines.push(theme.fg("dim", `… ${countLabel(hidden, "line")} · `) + expandHint(theme));
        }
      }
    }
  }

  const status = cardStatusLine(card, theme);
  if (card.kind === "error" && typeof card.error === "string" && card.error !== ""
    && outputLines.length === 0 && tail.length === 0) {
    lines.push(theme.fg("error", safeTerminalText(card.error)));
  }
  lines.push(status); // the outcome closes the card, under the output
  return lines;
};

/** The card as a Component: one derived background painted on every padded row. */
export const renderFabricToolResultCard = (
  card: FabricToolResultCardV1,
  options: Pick<ToolRenderResultOptions, "expanded">,
  theme: Theme,
): Component => {
  const tone = fabricToolResultCardTone(card);
  const background = blendSemanticBackground(theme, tone, TOOL_RESULT_CARD_BG_INTENSITY[tone]);
  const lines = toolResultCardLines(card, options, theme);
  return new Text(lines.join("\n"), 0, 0, (line) => applyPaddedBackground(line, background));
};

const textOutput = (result: { content?: unknown }): string => {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
};

/**
 * Results the schema does not claim render like pi's native fallback: the text
 * content, toolOutput-colored, with a collapsed preview and expand hint. The
 * card contract replaces nothing it does not understand.
 */
export const renderToolResultTextFallback = (
  result: { content?: unknown },
  options: Pick<ToolRenderResultOptions, "expanded">,
  theme: Theme,
): Component => {
  const output = textOutput(result);
  if (!output) return new Text("", 0, 0);
  const lines = safeTerminalText(output).split("\n");
  const shown = options.expanded ? lines : lines.slice(0, TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES);
  let text = shown.map((line) => theme.fg("toolOutput", line || " ")).join("\n");
  const hidden = lines.length - shown.length;
  if (hidden > 0 && !options.expanded) {
    text += "\n" + theme.fg("dim", `… ${countLabel(hidden, "line")} · `) + expandHint(theme);
  }
  return new Text(text, 0, 0);
};

const renderSchemaCardResult: NonNullable<ToolRenderers["renderResult"]> = (
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component => {
  const card = readFabricToolResultCardV1(result?.details);
  if (card) return renderFabricToolResultCard(card, options, theme);
  return renderToolResultTextFallback(result ?? {}, options, theme);
};

/** Tool names whose result rendering the card contract must never touch. */
const RESERVED_RESULT_RENDERER_TOOLS: ReadonlySet<string> = new Set([...PI_CORE_TOOL_NAMES, "fabric_exec"]);

/**
 * The renderResult side of the typed details contract, as a
 * `registerToolRenderer` resolver: tools that draw their own results (directly
 * or through built-ins and MCP) keep them; every other registered tool gains a
 * renderResult that reads a v1 card from its result details. A tool opting in
 * is one schema-bearing `details` object away — no ANSI, no custom message
 * channel, no transcript surgery.
 */
export const createFabricToolResultCardRenderer = (): ToolRendererResolver =>
  (toolName, next) => {
    if (toolName.startsWith("mcp__") || RESERVED_RESULT_RENDERER_TOOLS.has(toolName)) {
      return next();
    }
    const base = next();
    if (base?.renderResult) return base;
    return { ...base, renderResult: renderSchemaCardResult };
  };
