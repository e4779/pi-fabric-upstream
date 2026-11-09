// Common theme-background blending, lifted out of diff-background.ts so every
// card family — diff previews, tool result cards — derives backgrounds from
// theme keys through one path ("color only from a theme key"). The blend math
// is shared: parse the theme token's SGR (truecolor or 256-index), then mix
// that RGB into the theme's background token at an intensity.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ansi256ToRgb, observedThemeVariant } from "./highlight.js";

/** Theme tokens whose colors are blended into each other. */
export interface BlendBackgroundTokens {
  /** Foreground token whose color is blended into the background. */
  fg: string;
  /** Background token that receives the blend. */
  bg: string;
  /** Background tokens tried in order when `bg` itself does not parse. */
  bgFallbacks?: readonly string[];
}

export type Rgb = { r: number; g: number; b: number };

/** Parse an SGR fg/bg sequence (truecolor `;2;r;g;b` or 256-index `;5;N`) into RGB. */
export const parseSgrRgb = (ansi: string): Rgb | undefined => {
  const trueColor = /\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/.exec(ansi);
  if (trueColor) {
    return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
  }
  const indexed = /\x1b\[(?:38|48);5;(\d+)m/.exec(ansi);
  if (indexed) return ansi256ToRgb(Number(indexed[1]));
  return undefined;
};

/** The theme's background when no token parses: the observed variant's base. */
export const variantBaseRgb = (): Rgb =>
  observedThemeVariant() === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };

/**
 * Blend a foreground token's color into a background token at `intensity`
 * (0..1) and return the opening truecolor background SGR, or undefined when
 * the foreground token itself does not resolve — callers decide their fallback.
 */
export const blendThemeBackground = (
  theme: Theme | undefined,
  tokens: BlendBackgroundTokens,
  intensity: number,
): string | undefined => {
  const themed = theme as
    | (Theme & { getFgAnsi?: (key: string) => string; getBgAnsi?: (key: string) => string })
    | undefined;
  let fg: Rgb | undefined;
  let base: Rgb | undefined;
  try {
    fg = parseSgrRgb(themed?.getFgAnsi?.(tokens.fg) ?? "");
    base = parseSgrRgb(themed?.getBgAnsi?.(tokens.bg) ?? "");
    if (!base) {
      for (const fallback of tokens.bgFallbacks ?? []) {
        base = parseSgrRgb(themed?.getBgAnsi?.(fallback) ?? "");
        if (base) break;
      }
    }
  } catch {
    return undefined;
  }
  if (!fg) return undefined;
  const blended = base ?? variantBaseRgb();
  const mix = (from: number, into: number): number =>
    Math.round(from + (into - from) * intensity);
  return `\x1b[48;2;${mix(blended.r, fg.r)};${mix(blended.g, fg.g)};${mix(blended.b, fg.b)}m`;
};

/** Semantic card tones; each maps to the theme keys its background blends. */
export type SemanticBgTone = "success" | "error" | "warning" | "neutral";

const SEMANTIC_BLEND_TOKENS: Record<SemanticBgTone, BlendBackgroundTokens> = {
  success: { fg: "success", bg: "toolSuccessBg" },
  error: { fg: "error", bg: "toolErrorBg", bgFallbacks: ["toolSuccessBg"] },
  // No toolWarningBg token exists; custom-message cards are the warning family.
  warning: { fg: "warning", bg: "customMessageBg", bgFallbacks: ["toolSuccessBg"] },
  // Handles and other non-outcome cards: the accent blended into the
  // custom-message background, the reference card's neutral fill.
  neutral: { fg: "accent", bg: "customMessageBg", bgFallbacks: ["toolSuccessBg"] },
};

/** Static per-variant fills for themes whose SGR does not parse (or no theme). */
export const FALLBACK_SEMANTIC_BG: Record<SemanticBgTone, Record<"dark" | "light", string>> = {
  success: {
    dark: "\x1b[48;2;10;42;26m",
    light: "\x1b[48;2;198;230;206m",
  },
  error: {
    dark: "\x1b[48;2;50;24;30m",
    light: "\x1b[48;2;242;206;210m",
  },
  warning: {
    dark: "\x1b[48;2;36;29;47m",
    light: "\x1b[48;2;243;239;249m",
  },
  neutral: {
    dark: "\x1b[48;2;36;29;47m",
    light: "\x1b[48;2;243;239;249m",
  },
};

/** The two named blend intensities (diff previews use the same pair). */
export const BLEND_INTENSITY_SUBTLE = 0.14;
export const BLEND_INTENSITY_MEDIUM = 0.24;

/**
 * A semantic tone's background: the tone's theme foreground blended into its
 * theme background, with a static per-variant fill when the theme does not
 * resolve. Never throws.
 */
export const blendSemanticBackground = (
  theme: Theme | undefined,
  tone: SemanticBgTone,
  intensity: number,
): string =>
  blendThemeBackground(theme, SEMANTIC_BLEND_TOKENS[tone], intensity)
  ?? FALLBACK_SEMANTIC_BG[tone][observedThemeVariant() === "light" ? "light" : "dark"];

/**
 * Paint one already padded row: open with the background, re-open it after
 * every in-line reset, and close it at end of line so the fill never bleeds
 * into the rows after the card. Zero visible width.
 */
export const applyPaddedBackground = (line: string, background: string): string => {
  const colored = line
    .replace(/\x1b\[0m/g, `\x1b[0m${background}`)
    .replace(/\x1b\[39m/g, `\x1b[39m${background}`)
    .replace(/\x1b\[49m/g, `\x1b[49m${background}`);
  return `${background}${colored}\x1b[0m`;
};
