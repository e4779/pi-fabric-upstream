import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

interface Point { row: number; col: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
// Match Pi's terminal word boundaries, including model IDs and filesystem paths.
const wordJoiners = new Set(["/", "-"]);

/** One immutable rendered-history reference; no history-sized copy on drag. */
export class ConversationTextSelection {
  source: readonly string[] | undefined;
  private anchor: Point | undefined;
  private focus: Point | undefined;
  private initialRange: { start: Point; end: Point } | undefined;
  private granularity: "character" | "word" | "line" = "character";
  dragging = false;

  clear(): void {
    this.source = undefined;
    this.anchor = this.focus = undefined;
    this.initialRange = undefined;
    this.granularity = "character";
    this.dragging = false;
  }

  start(source: readonly string[], row: number, col: number, clickCount = 1): void {
    this.source = source;
    const point = this.point(row, col);
    this.granularity = clickCount === 2 ? "word" : clickCount === 3 ? "line" : "character";
    this.initialRange = this.range(point);
    this.anchor = this.initialRange?.start ?? point;
    this.focus = this.initialRange?.end ?? point;
    this.dragging = true;
  }

  move(row: number, col: number): void {
    if (!this.dragging) return;
    const point = this.point(row, col);
    const range = this.range(point);
    if (!this.initialRange || !range) { this.focus = point; return; }
    const before = range.start.row < this.initialRange.start.row ||
      (range.start.row === this.initialRange.start.row && range.start.col < this.initialRange.start.col);
    this.anchor = before ? this.initialRange.end : this.initialRange.start;
    this.focus = before ? range.start : range.end;
  }

  private range(point: Point): { start: Point; end: Point } | undefined {
    if (this.granularity === "character") return undefined;
    const line = stripTerminalSequences(this.source?.[point.row] ?? "");
    if (this.granularity === "line") return {
      start: { row: point.row, col: 0 }, end: { row: point.row, col: visibleWidth(line) },
    };
    let col = 0;
    const segments = Array.from(words.segment(line), ({ segment, isWordLike }) => {
      const start = col;
      col += visibleWidth(segment);
      const joiner = wordJoiners.has(segment);
      return { start, end: col, selectable: isWordLike === true || joiner, joiner };
    });
    let index = segments.findIndex(segment => point.col >= segment.start && point.col < segment.end);
    if (index < 0) return undefined;
    let endIndex = index;
    const joins = (left: typeof segments[number], right: typeof segments[number]) =>
      left.selectable && right.selectable && (left.joiner || right.joiner);
    while (index > 0 && joins(segments[index - 1]!, segments[index]!)) index--;
    while (endIndex + 1 < segments.length && joins(segments[endIndex]!, segments[endIndex + 1]!)) endIndex++;
    return { start: { row: point.row, col: segments[index]!.start }, end: { row: point.row, col: segments[endIndex]!.end } };
  }

  finish(row: number, col: number): void {
    this.move(row, col);
    this.dragging = false;
    if (!this.bounds()) this.clear();
  }

  get active(): boolean { return this.bounds() !== undefined; }

  private point(row: number, col: number): Point {
    row = Math.max(0, Math.min(this.source!.length - 1, row));
    let boundary = 0;
    for (const { segment } of graphemes.segment(stripTerminalSequences(this.source![row] ?? ""))) {
      const next = boundary + visibleWidth(segment);
      if (next > col) break;
      boundary = next;
    }
    return { row, col: boundary };
  }

  private bounds(): { start: Point; end: Point } | undefined {
    const a = this.anchor;
    const b = this.focus;
    if (!a || !b || (a.row === b.row && a.col === b.col)) return undefined;
    return a.row < b.row || (a.row === b.row && a.col < b.col) ? { start: a, end: b } : { start: b, end: a };
  }

  text(): string | undefined {
    const bounds = this.bounds();
    if (!bounds || !this.source) return undefined;
    const lines: string[] = [];
    for (let row = bounds.start.row; row <= bounds.end.row; row++) {
      const line = this.source[row] ?? "";
      const start = row === bounds.start.row ? bounds.start.col : 0;
      const end = row === bounds.end.row ? bounds.end.col : visibleWidth(line);
      lines.push(stripTerminalSequences(sliceByColumn(line, start, end - start, true)).trimEnd());
    }
    return lines.join("\n") || undefined;
  }

  highlight(line: string, row: number, theme: Theme): string {
    const bounds = this.bounds();
    if (!bounds || row < bounds.start.row || row > bounds.end.row) return line;
    // Never slice/re-emit image control payloads while painting a selection.
    if (/\x1b(?:_G|\]1337;File=|P)/.test(line)) return line;
    const width = visibleWidth(line);
    const start = row === bounds.start.row ? bounds.start.col : 0;
    const end = row === bounds.end.row ? bounds.end.col : width;
    if (end <= start) return line;
    const selected = stripTerminalSequences(sliceByColumn(line, start, end - start, true));
    return sliceByColumn(line, 0, start, true) + theme.bg("selectedBg", theme.fg("text", selected)) +
      sliceByColumn(line, end, Math.max(0, width - end), true);
  }
}
