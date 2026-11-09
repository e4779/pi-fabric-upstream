// The shared tool-result card: the render side of the typed details contract
// (protocol.ts FabricToolResultCardV1). Any registered tool that fills its
// result `details` with a v1 card gets host-quality rendering - semantic
// tones, a theme-blended background, collapsed preview with an expand hint -
// through the normal renderResult pipeline, without ANSI of its own.
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
import {
  FABRIC_RENDER_CARD_EVENT,
  readFabricToolResultCardContractV1,
  type FabricRenderCardEventV1,
  type FabricToolResultCardV1,
} from "../protocol.js";
import {
  applyPaddedBackground,
  blendSemanticBackground,
  BLEND_INTENSITY_MEDIUM,
  BLEND_INTENSITY_SUBTLE,
  type SemanticBgTone,
} from "./blend-background.js";
import { expandHint, safeTerminalText } from "./fabric-render.js";

/** Tail lines shown on the collapsed card. */
export const TOOL_RESULT_CARD_PREVIEW_LINES = 3;
/** Line cap for the expanded card body (renderResult bodies cap at 200). */
export const TOOL_RESULT_CARD_EXPAND_MAX_LINES = 200;
/** Lines of plain text a non-card result previews when collapsed. */
export const TOOL_RESULT_TEXT_FALLBACK_PREVIEW_LINES = 12;

/** Environment off switch for the shared card renderer (`=off` disables the resolver). */
export const TOOL_RESULT_CARDS_ENV = "PI_FABRIC_TOOL_RESULT_CARDS";

/** True when the env switch turns the shared card renderer off. */
export const toolResultCardsEnvOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[TOOL_RESULT_CARDS_ENV] === "off";

/** Blend intensity per tone: success rests, failure alerts (the diff pair). */
export const TOOL_RESULT_CARD_BG_INTENSITY: Record<SemanticBgTone, number> = {
  success: BLEND_INTENSITY_SUBTLE,
  error: BLEND_INTENSITY_MEDIUM,
  warning: BLEND_INTENSITY_MEDIUM,
  neutral: BLEND_INTENSITY_SUBTLE,
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const formatCardMs = (ms: unknown): string | undefined => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
};

/** The card's semantic tone: the status color and the blended background. */
export const fabricToolResultCardTone = (card: FabricToolResultCardV1): SemanticBgTone => {
  switch (card.kind) {
    case "ok":
      return "success";
    case "error":
      return card.aborted === true ? "warning" : "error";
    case "timeout":
    case "blocked":
      return "warning";
    case "backgrounded":
    case "img":
    case "bg":
      return "neutral";
    case "sh":
      if (card.timedOut === true) return "warning";
      return card.exit === 0 ? "success" : "error";
  }
};

const cardStatusLine = (card: FabricToolResultCardV1, theme: Theme): string => {
  const ms = "ms" in card ? card.ms : undefined;
  const duration = formatCardMs(ms);
  const suffix = duration ? ` · ${duration}` : "";
  switch (card.kind) {
    case "ok":
      return theme.fg("success", `✓ exit ${card.exitCode ?? 0}${suffix}`);
    case "error":
      if (card.aborted === true) return theme.fg("warning", `⏹ stopped${suffix}`);
      return theme.fg("error", `✗ exit ${card.exitCode ?? "?"}${suffix}`);
    case "timeout": {
      // A timeout that also raced an abort keeps the deadline as the headline
      // (the more specific stop) and carries `aborted` beside it — the two
      // states stay distinguishable instead of collapsing into one bit.
      const aborted = card.aborted === true ? theme.fg("dim", " · aborted") : "";
      return theme.fg("warning", `⏱ timeout`) + aborted + (suffix ? theme.fg("warning", suffix) : "");
    }
    case "blocked":
      return theme.fg("warning", `⊘ blocked${suffix}`);
    case "backgrounded": {
      const pid = typeof card.pid === "number" ? theme.fg("dim", ` · pid ${card.pid}`) : "";
      return theme.fg("accent", `● background ${card.taskId}${suffix}`) + pid;
    }
    case "sh": {
      if (card.timedOut === true) return theme.fg("warning", `⏱ timeout${suffix}`);
      const exit = typeof card.exit === "number" ? card.exit : null;
      if (exit === 0) return theme.fg("success", `✓ exit 0${suffix}`);
      return theme.fg("error", `✗ exit ${exit ?? "?"}${suffix}`);
    }
    case "img":
      return theme.fg("dim", `● img ${card.paths.join(", ")}`);
    case "bg": {
      const pid = typeof card.pid === "number" ? theme.fg("dim", ` · pid ${card.pid}`) : "";
      return theme.fg("accent", `● bg ${card.id}${suffix}`) + pid;
    }
  }
};

const cardCommand = (card: FabricToolResultCardV1): string | undefined =>
  card.kind === "sh" || card.kind === "bg" ? card.cmd : "cmd" in card ? card.cmd : undefined;

const cardOutput = (card: FabricToolResultCardV1): string | undefined =>
  card.kind === "sh" ? card.out : "output" in card ? card.output : undefined;

const cardLogPath = (card: FabricToolResultCardV1): string | undefined =>
  card.kind === "backgrounded" || card.kind === "bg"
    ? card.logPath
    : "logPath" in card ? card.logPath : undefined;

/**
 * The card's transcript lines, pure and theme-injected:
 *   [0]   optional accent title
 *   [1]   dim `❯ ` + bold first command line (+ dim ` … +N lines` marker)
 *   [2+]  blank + output tail preview (or the full body when expanded), with a
 *         dim `… +N lines · ctrl-o to expand` hint while collapsed
 *   [last] the outcome line, under the output
 * Blocked cards preview the refusal reason; `img` cards render one dim path
 * line; `bg` cards are the detached marker (handle + log path, full command
 * on expand).
 */
export const toolResultCardLines = (
  card: FabricToolResultCardV1,
  options: Pick<ToolRenderResultOptions, "expanded">,
  theme: Theme,
): string[] => {
  const lines: string[] = [];
  if (card.kind === "img") return [cardStatusLine(card, theme)];

  const title = "title" in card && typeof card.title === "string" ? card.title.trim() : undefined;
  if (title) lines.push(theme.fg("accent", safeTerminalText(title)));

  const commandLines = cardCommand(card)?.split("\n") ?? [];
  if (commandLines.length > 0) {
    let command = theme.fg("dim", "❯ ") + theme.bold(safeTerminalText(commandLines[0] ?? "") || " ");
    if (commandLines.length > 1) {
      command += theme.fg("dim", ` … +${commandLines.length - 1} lines`);
    }
    lines.push(command);
  }

  const outputLines = cardOutput(card) ? safeTerminalText(cardOutput(card)!).split("\n") : [];
  const tail = "tail" in card && Array.isArray(card.tail)
    ? card.tail.map((line) => safeTerminalText(line))
    : [];
  const logPath = cardLogPath(card);
  if (logPath !== undefined) lines.push(theme.fg("dim", `log ${safeTerminalText(logPath)}`));

  if (card.kind === "bg") {
    // The detached marker: collapsed it stays a handle (command, log, id); the
    // full command body shows on expand.
    if (options.expanded && commandLines.length > 0) {
      lines.push("");
      const shown = commandLines.slice(0, TOOL_RESULT_CARD_EXPAND_MAX_LINES);
      for (const line of shown) lines.push(theme.fg("toolOutput", safeTerminalText(line) || " "));
      const hidden = commandLines.length - shown.length;
      if (hidden > 0) lines.push(theme.fg("dim", `… +${hidden} lines`));
    }
    lines.push(cardStatusLine(card, theme));
    return lines;
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
    const total = "totalLines" in card && typeof card.totalLines === "number" && card.totalLines >= 0
      ? card.totalLines
      : outputLines.length || tail.length;
    if (options.expanded) {
      const full = (outputLines.length > 0 ? outputLines : tail)
        .slice(0, TOOL_RESULT_CARD_EXPAND_MAX_LINES);
      if (full.length > 0) {
        lines.push("");
        // Output stays toolOutput-fg: dim-on-tint reads washed out.
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

/** Options for the shared card renderer resolver. */
export interface FabricToolResultCardRendererOptions {
  /**
   * Master switch, consulted per resolve. Default: the env switch only
   * (`PI_FABRIC_TOOL_RESULT_CARDS=off`); the host composes its config key in.
   */
  enabled?: () => boolean;
  /** Telemetry sink: one line per refused card contract or legacy fallback. */
  emit?: (event: FabricRenderCardEventV1) => void;
}

/** The one context field the fallback telemetry needs, kept structural so the
 * resolver stays loadable on hosts that never hand a render context. */
interface CardRenderCallContext {
  toolCallId?: unknown;
}

const renderSchemaCardResult = (
  toolName: string,
  emit: ((event: FabricRenderCardEventV1) => void) | undefined,
  reported: Set<string>,
) =>
(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context?: CardRenderCallContext,
): Component => {
  const read = readFabricToolResultCardContractV1(result?.details);
  if (read.contract && "card" in read) return renderFabricToolResultCard(read.card, options, theme);
  const toolCallId = typeof context?.toolCallId === "string" ? context.toolCallId : "";
  const reportedKey = `${toolName}:${toolCallId}`;
  if (!reported.has(reportedKey)) {
    reported.add(reportedKey);
    const event: FabricRenderCardEventV1 = read.contract
      ? { version: 1, tool: toolName, outcome: "refused", reason: read.reason, toolCallId }
      : { version: 1, tool: toolName, outcome: "fallback", toolCallId };
    try {
      emit?.(event);
      if (read.contract) {
        console.warn(`[pi-fabric] tool-result card refused for ${toolName} (${read.reason}); rendered as plain text`);
      }
    } catch {
      // Telemetry cannot break rendering.
    }
  }
  return renderToolResultTextFallback(result ?? {}, options, theme);
};

/** Tool names whose result rendering the card contract must never touch. */
const RESERVED_RESULT_RENDERER_TOOLS: ReadonlySet<string> = new Set([...PI_CORE_TOOL_NAMES, "fabric_exec"]);

/**
 * The renderResult side of the typed details contract, as a
 * `registerToolRenderer` resolver: tools that draw their own results (directly
 * or through built-ins and MCP) keep them; every other registered tool gains a
 * renderResult that reads a v1 card from its result details. A tool opting in
 * is one schema-bearing `details` object away. `enabled` false hands the next
 * resolver back untouched; every refusal and legacy fallback emits exactly one
 * telemetry line per tool call.
 */
export const createFabricToolResultCardRenderer = (
  options: FabricToolResultCardRendererOptions = {},
): ToolRendererResolver => {
  const enabled = options.enabled ?? (() => !toolResultCardsEnvOff());
  const reported = new Set<string>(); // one telemetry line per tool call, per resolver
  return (toolName, next) => {
    if (!enabled()) return next();
    if (toolName.startsWith("mcp__") || RESERVED_RESULT_RENDERER_TOOLS.has(toolName)) {
      return next();
    }
    const base = next();
    if (base?.renderResult) return base;
    const renderResult = renderSchemaCardResult(toolName, options.emit, reported);
    return { ...base, renderResult };
  };
};

export { FABRIC_RENDER_CARD_EVENT };
export type { ToolRenderers };
