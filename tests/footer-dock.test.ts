import { describe, expect, it } from "vitest";
import { borderBadge } from "../src/ui/format.js";
import { withBorderBadge } from "../src/ui/footer-dock.js";

// Pi colours the editor border by thinking level; the badge must follow it.
const thinking = (text: string, colour = "38;2;255;95;95") => `\x1b[${colour}m${text}\x1b[39m`;

describe("editor border badge", () => {
  it("draws the badge in the border colour and keeps that colour on both sides", () => {
    const [top, body] = withBorderBadge([thinking("─".repeat(30)), "> draft"], "FAB-3");
    expect(top).toBe(`\x1b[38;2;255;95;95m${"─".repeat(21)}\x1b[0m\x1b[48;2;255;95;95;38;2;0;0;0m FAB-3 \x1b[0m\x1b[38;2;255;95;95m──`);
    expect(body).toBe("> draft");
  });

  it("changes colour with the border, as the thinking level changes", () => {
    const low = withBorderBadge([thinking("─".repeat(30), "38;2;40;60;160")], "FAB-3")[0]!;
    expect(low).toContain("\x1b[48;2;40;60;160;38;2;255;255;255m FAB-3 ");
  });

  it("leaves a border that carries Pi's own label, and narrow borders, alone", () => {
    const working = [thinking(`── Working ${"─".repeat(5)}`)];
    expect(withBorderBadge(working, "FAB-3")).toBe(working);
    const narrow = [thinking("─".repeat(10))];
    expect(withBorderBadge(narrow, "FAB-3")).toBe(narrow);
    expect(withBorderBadge([thinking("─".repeat(30))], undefined)).toEqual([thinking("─".repeat(30))]);
  });
});

describe("border badge colours", () => {
  it("picks black text on light colours and white text on dark ones", () => {
    expect(borderBadge(thinking("─", "38;2;250;220;120"), "A")).toBe("\x1b[48;2;250;220;120;38;2;0;0;0m A \x1b[0m");
    expect(borderBadge(thinking("─", "38;2;30;30;60"), "A")).toBe("\x1b[48;2;30;30;60;38;2;255;255;255m A \x1b[0m");
  });

  it("reads 256-colour and basic borders, and strips styling from the label", () => {
    expect(borderBadge("\x1b[38;5;135m─", "\x1b[33mMain\x1b[39m > a")).toBe("\x1b[48;5;135;38;2;0;0;0m Main > a \x1b[0m");
    expect(borderBadge("\x1b[34m─", "A")).toBe("\x1b[44;38;2;255;255;255m A \x1b[0m");
    expect(borderBadge("\x1b[93m─", "A")).toBe("\x1b[103;38;2;0;0;0m A \x1b[0m");
  });

  it("stays plain on a border drawn without colour", () => {
    expect(borderBadge("─", "\x1b[33mA\x1b[39m")).toBe(" A ");
  });
});
