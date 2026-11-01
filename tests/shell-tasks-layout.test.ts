import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { ShellTasksView } from "../src/ui/shell-tasks.js";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
const fixture = () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const jobs = new FabricShellJobStore(); cleanup.push(() => jobs.close());
  let rows = 40;
  const requestRender = vi.fn(), done = vi.fn();
  const open = (id = jobs.list()[0]?.id ?? "missing", customTheme = theme, keys?: KeybindingsManager) => {
    const view = new ShellTasksView({ jobs, id, theme: customTheme, rows: () => rows, requestRender, done, ...(keys ? { keys } : {}) });
    cleanup.push(() => view.dispose()); return view;
  };
  const add = (description: string) => { const job = jobs.begin("bash", `echo ${description}`, { description, cwd: "/work" }); job.spill(); return job; };
  return { jobs, add, open, requestRender, done, resize: (height: number) => { rows = height; } };
};

describe("shell task detail layout", () => {
  it("frames only the requested task, with no secondary task list", async () => {
    const h = fixture(); const finished = h.add("Other completed task"); await finished.finish(0);
    const job = h.add("Watch CI 界"); h.add("Other running task");
    const view = h.open(job.id), lines = view.render(100), text = lines.join("\n");
    expect(lines[0]).toContain(`Fabric · task ${job.id}`);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(lines.slice(1, -1).every(line => /^(│|├).*(│|┤)$/.test(line))).toBe(true);
    expect(lines.every(line => visibleWidth(line) === 100)).toBe(true);
    expect(text).toContain("Watch CI 界"); expect(text).toContain("esc close");
    expect(text).not.toContain("Other completed task"); expect(text).not.toContain("Other running task");
    view.handleInput("\u001b"); expect(h.done).toHaveBeenCalledOnce();
    expect(job.abort.signal.aborted).toBe(false);
  });

  it("animates only the selected live task, never reads logs per frame, and releases timers/subscriptions", async () => {
    const h = fixture(); const job = h.add("Quiet task"); h.add("Unrelated task");
    const read = vi.spyOn(job, "outputText");
    const view = h.open(job.id); await Promise.resolve();
    expect(view.render(80).join("\n")).toContain("◐ spilled");
    read.mockClear(); h.requestRender.mockClear(); await vi.advanceTimersByTimeAsync(250);
    expect(view.render(80).join("\n")).toContain("◓ spilled");
    expect(h.requestRender).toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    await job.finish(0); await Promise.resolve();
    expect(view.render(80).join("\n")).toContain("✓ exited");
    h.requestRender.mockClear(); read.mockClear(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    view.dispose(); view.dispose(); h.add("After close"); expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("uses injected cancellation keybindings without cancelling work", () => {
    const h = fixture(); const job = h.add("First"); h.add("Second");
    const keys = { matches: (data: string, action: string) => data === "back" && action === "tui.select.cancel" } as KeybindingsManager;
    const view = h.open(job.id, theme, keys); view.handleInput("back"); view.handleInput("back");
    expect(h.done).toHaveBeenCalledOnce(); expect(job.abort.signal.aborted).toBe(false);
  });

  it("keeps detail borders and output bounded for tiny, narrow and wide terminals", () => {
    const h = fixture(); const job = h.add("Watch 界 👩‍💻 é\u001b[2J"); const view = h.open(job.id);
    for (const rows of [1, 2, 8, 9, 12, 24, 50]) {
      h.resize(rows);
      for (const width of [0, 1, 7, 8, 12, 30, 40, 80, 140]) {
        const lines = view.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.floor(rows * 0.8)));
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\u001b[2J");
        if (width >= 8 && rows >= 9) expect(lines.at(-1)).toMatch(/^╰.*╯$/);
      }
    }
  });

  it("wraps safe output without losing indentation, scrolls and follows the tail", async () => {
    const h = fixture(); h.resize(24); const job = h.add("Output check");
    job.append(Buffer.from(Array.from({ length: 30 }, (_, i) => `  line ${i} 界\u001b[2J`).join("\n")));
    const view = h.open(job.id); await Promise.resolve(); let text = view.render(80).join("\n");
    expect(text).toContain("  line 29 界"); expect(text).not.toContain("\u001b");
    expect(text).toContain("Output · tail · bounded"); expect(text).toContain("Command");
    view.handleInput("\u001b[5~"); text = view.render(80).join("\n");
    expect(text).not.toContain("line 29"); expect(text).toMatch(/Output · \d+–\d+\/30/);
    view.handleInput("G"); expect(view.render(80).join("\n")).toContain("line 29");
    job.append(Buffer.from("\n  new output")); await Promise.resolve(); expect(view.render(80).join("\n")).toContain("  new output");
  });

  it("renders monitor changes, expires stop confirmation, and stays theme-aware", async () => {
    const h = fixture(); const job = h.jobs.begin("bash", "watch-ci", { description: "Watch CI", monitor: { delivery: "ui", timeoutMs: 300000, intervalMs: 5000 } }); job.spill();
    let color = 36;
    const ansiTheme = { fg: (_: string, text: string) => `\u001b[${color}m${text}\u001b[39m`, bg: (_: string, text: string) => text } as Theme;
    const view = h.open(job.id, ansiTheme);
    expect(view.render(100).join("\n")).toContain("Monitor: UI only · deadline 5m00s · 0 events");
    view.handleInput("x"); expect(view.render(100).join("\n")).toContain("Press x again");
    await vi.advanceTimersByTimeAsync(3000); expect(view.render(100).join("\n")).not.toContain("Press x again");
    view.handleInput("x"); expect(job.abort.signal.aborted).toBe(false);
    view.handleInput("x"); expect(job.abort.signal.aborted).toBe(true);
    expect(view.render(100).join("\n")).toContain("stopping"); await job.finish(null);
    expect(view.render(100).join("\n")).toContain("■ killed");
    color = 35; view.invalidate(); expect(view.render(100).join("\n")).not.toContain("\u001b[36m");
  });

  it("keeps missing and finished details timer-free, handles read errors and ignores late reads after closing", async () => {
    const h = fixture(); const missing = h.open();
    expect(vi.getTimerCount()).toBe(0); expect(missing.render(80).join("\n")).toContain("Task no longer retained."); missing.dispose();
    const job = h.add("Completed"); await job.finish(0);
    vi.spyOn(job, "outputText").mockRejectedValueOnce(new Error("missing log"));
    const view = h.open(job.id); await Promise.resolve();
    expect(view.render(80).join("\n")).toContain("Output unavailable: missing log"); expect(vi.getTimerCount()).toBe(0); view.dispose();
    let finishRead!: (output: string) => void;
    vi.spyOn(job, "outputText").mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const pending = h.open(job.id); pending.dispose(); h.requestRender.mockClear(); finishRead("late result"); await Promise.resolve();
    expect(h.requestRender).not.toHaveBeenCalled();
  });
});
