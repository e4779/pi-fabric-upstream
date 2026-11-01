import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FabricTerminalTitle,
  installTerminalTitle,
  MAX_TERMINAL_TITLE_CHARS,
  TERMINAL_TITLE_ENTRY_TYPE,
  terminalTitleText,
} from "../src/ui/terminal-title.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const entry = (title: unknown) => ({
  type: "custom",
  customType: TERMINAL_TITLE_ENTRY_TYPE,
  data: { version: 1, title },
});

const harness = (options: {
  entries?: unknown[];
  enabled?: boolean;
  mode?: string;
  hasUI?: boolean;
} = {}) => {
  const applied: string[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const enabled = options.enabled ?? true;
  const controller = new FabricTerminalTitle(
    { appendEntry: (customType, data) => { appended.push({ customType, data }); } },
    () => enabled,
  );
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/work/pi-fabric",
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionName: () => "titles",
    },
    ui: { setTitle: (title: string) => applied.push(title) },
  } as unknown as ExtensionContext;
  return { applied, appended, controller, context };
};

describe("terminalTitleText", () => {
  it("drops styling and control characters a raw OSC title cannot carry", () => {
    expect(terminalTitleText("\u001b[1;36mrecord release evidence\u001b[0m")).toBe("record release evidence");
    expect(terminalTitleText("  record\n\trelease  ")).toBe("record release");
    expect(terminalTitleText(undefined)).toBe("");
  });

  it("clips long titles to the window-chrome budget", () => {
    const clipped = terminalTitleText("x".repeat(MAX_TERMINAL_TITLE_CHARS + 40));
    expect(Array.from(clipped)).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("FabricTerminalTitle", () => {
  it("shows the declared title, records it, and coalesces repeats", () => {
    const { applied, appended, controller, context } = harness();

    controller.show(context, "record release evidence");
    controller.show(context, "record release evidence");
    controller.show(context, "  ");

    expect(applied).toEqual(["record release evidence"]);
    expect(appended).toEqual([
      { customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "record release evidence" } },
    ]);
  });

  it("holds the last title instead of reverting", () => {
    const { applied, controller, context } = harness();
    controller.show(context, "record release evidence");
    controller.reassert(context);
    expect(applied).toEqual(["record release evidence", "record release evidence"]);
    expect(controller.current()).toBe("record release evidence");
  });

  it("adopts the newest recorded title on resume without recording again", () => {
    const { applied, appended, controller, context } = harness({
      entries: [entry("older run"), entry("record release evidence"), { type: "session_info", name: "x" }],
    });

    controller.resume(context);

    expect(applied).toEqual(["record release evidence"]);
    expect(appended).toEqual([]);
    expect(controller.current()).toBe("record release evidence");
  });

  it("ignores an unreadable recorded title and an unrecorded session", () => {
    const missing = harness({ entries: [entry(42), entry("")] });
    missing.controller.resume(missing.context);
    expect(missing.applied).toEqual([]);

    const empty = harness();
    empty.controller.resume(empty.context);
    empty.controller.reassert(empty.context);
    expect(empty.applied).toEqual([]);
  });

  it("leaves headless hosts, disabled runs, and unnamed runs alone", () => {
    const rpc = harness({ mode: "rpc" });
    rpc.controller.show(rpc.context, "record release evidence");
    expect(rpc.applied).toEqual([]);

    const headless = harness({ hasUI: false });
    headless.controller.show(headless.context, "record release evidence");
    expect(headless.applied).toEqual([]);

    const disabled = harness({ enabled: false });
    disabled.controller.show(disabled.context, "record release evidence");
    expect(disabled.applied).toEqual([]);
    expect(disabled.appended).toEqual([]);

    const unnamed = harness();
    unnamed.controller.show(unnamed.context, undefined);
    expect(unnamed.applied).toEqual([]);
  });

  it("keeps the live title when the session refuses the entry", () => {
    const applied: string[] = [];
    const controller = new FabricTerminalTitle(
      { appendEntry: () => { throw new Error("read-only session"); } },
      () => true,
    );
    const context = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [], getSessionName: () => undefined },
      ui: { setTitle: (title: string) => applied.push(title) },
    } as unknown as ExtensionContext;

    controller.show(context, "record release evidence");
    expect(applied).toEqual(["record release evidence"]);
  });
});

describe("installTerminalTitle", () => {
  const handlers = () => {
    const registered = new Map<string, (event: unknown, context: unknown) => void>();
    installTerminalTitle(
      {
        on: (event: string, handler: (event: unknown, context: unknown) => void) => {
          registered.set(event, handler);
          return () => {};
        },
      } as never,
      new FabricTerminalTitle({ appendEntry: () => undefined }, () => true),
    );
    return registered;
  };

  it("adopts the title on start and branch switch, and reasserts after Pi retitles", async () => {
    const registered = handlers();
    expect([...registered.keys()].sort()).toEqual([
      "agent_settled",
      "session_info_changed",
      "session_start",
      "session_tree",
    ]);

    const applied: string[] = [];
    const context = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [entry("record release evidence")], getSessionName: () => undefined },
      ui: { setTitle: (title: string) => applied.push(title) },
    } as unknown as ExtensionContext;

    registered.get("session_start")!({}, context);
    expect(applied).toEqual([]);
    await tick();
    expect(applied).toEqual(["record release evidence"]);
  });

  it("tolerates an event with no context", async () => {
    const registered = handlers();
    for (const handler of registered.values()) handler({}, undefined);
    await tick();
  });
});
