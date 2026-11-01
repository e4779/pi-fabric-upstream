import fs from "node:fs";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricSessionLabelConfig } from "../src/topology/session-label-settings.js";
import { recordedPeerLabel, SESSION_LABEL_STATUS_KEY, SessionLabelPresenter } from "../src/topology/session-label.js";
import { FABRIC_PEER_ENTRY_TYPE, FABRIC_PEER_LABEL_SEQUENCE } from "../src/protocol.js";

interface HerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

const roots: string[] = [];
const servers: Server[] = [];
const presenters: SessionLabelPresenter[] = [];

afterEach(async () => {
  for (const presenter of presenters.splice(0)) await presenter.close();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Herdr socket that keeps pane and tab labels and records every request. */
const startHerdr = async (initial: {
  paneLabel?: string | null;
  tabLabel?: string;
  failRename?: boolean;
} = {}) => {
  // Short on purpose: a unix socket path is capped at 104 bytes on macOS, and
  // the suite already runs under an isolated per-run TMPDIR.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pfl-"));
  roots.push(root);
  const socketPath = path.join(root, "herdr.sock");
  const pane: { pane_id: string; tab_id: string; label: string | null } = {
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    label: initial.paneLabel === undefined ? "research" : initial.paneLabel,
  };
  const tab = { tab_id: "w1:t1", label: initial.tabLabel ?? "fabric-in-pi" };
  const requests: HerdrRequest[] = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as HerdrRequest & { id: string };
      requests.push({ method: request.method, params: request.params });
      const reply = (body: Record<string, unknown>) => socket.end(`${JSON.stringify({ id: request.id, ...body })}\n`);
      if (request.method === "pane.get" && request.params.pane_id === pane.pane_id) {
        reply({ result: { type: "pane_info", pane: { ...pane } } });
      } else if (request.method === "tab.get" && request.params.tab_id === tab.tab_id) {
        reply({ result: { type: "tab_info", tab: { ...tab } } });
      } else if (initial.failRename && request.method.endsWith(".rename")) {
        reply({ error: { code: "busy", message: "rename refused" } });
      } else if (request.method === "pane.rename" && request.params.pane_id === pane.pane_id) {
        pane.label = request.params.label as string | null;
        reply({ result: { type: "ok" } });
      } else if (request.method === "tab.rename" && request.params.tab_id === tab.tab_id) {
        tab.label = request.params.label as string;
        reply({ result: { type: "ok" } });
      } else {
        reply({ error: { code: "not_found", message: `${request.method} target not found` } });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const environment: NodeJS.ProcessEnv = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: pane.pane_id,
    // Stale on purpose: the live tab comes from pane.get.
    HERDR_TAB_ID: "w1:t9",
  };
  const renames = () => requests.filter((request) => request.method.endsWith(".rename"));
  return { pane, tab, requests, renames, environment };
};

const settings = (overrides: Partial<FabricSessionLabelConfig> = {}): FabricSessionLabelConfig => ({
  footer: true,
  herdr: "off",
  ...overrides,
});

const present = (options: {
  label?: () => string | undefined;
  settings: () => FabricSessionLabelConfig;
  environment?: NodeJS.ProcessEnv;
  mode?: ExtensionContext["mode"];
  intervalMs?: number;
  hasUI?: boolean;
  on?: ExtensionAPI["on"];
  theme?: ExtensionContext["ui"]["theme"];
  shownInWidget?: () => boolean;
}) => {
  const setStatus = vi.fn();
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui: { setStatus, ...(options.theme ? { theme: options.theme } : {}) },
  } as unknown as ExtensionContext;
  const pi = { on: options.on ?? (() => () => undefined) } as unknown as ExtensionAPI;
  const presenter = new SessionLabelPresenter(pi, context, {
    label: options.label ?? (() => "FAB-3"),
    settings: options.settings,
    environment: options.environment ?? {},
    intervalMs: options.intervalMs ?? 0,
    ...(options.shownInWidget ? { shownInWidget: options.shownInWidget } : {}),
  });
  presenters.push(presenter);
  return { presenter, setStatus, context };
};

describe("session label footer", () => {
  it.each(["interval", "event", "explicit"])("stops syncing a stale context after an %s sync", async (trigger) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const handlers = new Map<string, () => unknown>();
      const on = ((event: string, handler: () => unknown) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }) as unknown as ExtensionAPI["on"];
      const { presenter, setStatus, context } = present({ settings: () => settings(), intervalMs: 1_000, on });
      await presenter.sync();
      expect(setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");

      const mode = vi.fn(() => {
        throw new Error("This extension ctx is stale after session replacement or reload...");
      });
      Object.defineProperty(context, "mode", { get: mode, configurable: true });
      if (trigger === "interval") await vi.advanceTimersByTimeAsync(750);
      handlers.get("session_info_changed")?.();
      expect(vi.getTimerCount()).toBe(2);
      if (trigger === "explicit") await expect(presenter.sync()).resolves.toBeUndefined();
      else await vi.advanceTimersByTimeAsync(trigger === "interval" ? 250 : 500);
      await presenter.settled();

      // The sync reads mode once, then the catch checks whether the context is stale.
      expect(mode).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      handlers.get("session_info_changed")?.();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(presenter.sync()).resolves.toBeUndefined();
      expect(mode).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the Fabric label in the footer once and clears it on close", async () => {
    const { presenter, setStatus } = present({ settings: () => settings() });

    await presenter.sync();
    await presenter.sync();

    expect(setStatus.mock.calls).toEqual([[SESSION_LABEL_STATUS_KEY, "Fabric FAB-3"]]);
    await presenter.close();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, undefined);
  });

  it("dims the footer label to match Pi's own footer lines", async () => {
    const { presenter, setStatus } = present({
      settings: () => settings(),
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      } as unknown as ExtensionContext["ui"]["theme"],
    });

    await presenter.sync();

    expect(setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "<dim>Fabric FAB-3</dim>");
  });

  it("keeps the status raw outside the TUI or without a host theme", async () => {
    const rpc = present({
      settings: () => settings(),
      mode: "rpc",
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      } as unknown as ExtensionContext["ui"]["theme"],
    });
    await rpc.presenter.sync();
    expect(rpc.setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");

    const plain = present({ settings: () => settings() });
    await plain.presenter.sync();
    expect(plain.setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");
  });

  it("reads the label recorded for this participant, newest first, ignoring a fork's parent", () => {
    const entry = (participantId: string, label: string, sequence = FABRIC_PEER_LABEL_SEQUENCE) =>
      ({ type: "custom", customType: FABRIC_PEER_ENTRY_TYPE, data: { version: 1, ...(sequence ? { sequence } : {}), participantId, label } });
    const context = (entries: unknown[]) => ({ sessionManager: { getBranch: () => entries } }) as unknown as ExtensionContext;
    const entries = [entry("session:abc", "FAB-3"), { type: "message" }, entry("session:abc", "FAB-4"), entry("session:parent", "FAB-1")];
    expect(recordedPeerLabel(context(entries), "session:abc")).toBe("FAB-4");
    expect(recordedPeerLabel(context(entries), "session:fork")).toBeUndefined();
    expect(recordedPeerLabel({} as ExtensionContext, "session:abc")).toBeUndefined();
    // A label from an older counter generation is retired, even behind a current one.
    expect(recordedPeerLabel(context([entry("session:abc", "FAB-2"), entry("session:abc", "FAB-341", 0)]), "session:abc")).toBeUndefined();
    expect(recordedPeerLabel(context([entry("session:abc", "FAB-1", FABRIC_PEER_LABEL_SEQUENCE - 1)]), "session:abc")).toBeUndefined();
  });

  it("records the peer label once as a session entry for headless RPC hosts", async () => {
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const appendEntry = vi.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); });
    let label: string | undefined;
    const current = settings({ footer: false });
    const make = () => {
      const context = {
        mode: "rpc", hasUI: true, ui: { setStatus: vi.fn() },
        sessionManager: { getBranch: () => entries },
      } as unknown as ExtensionContext;
      const presenter = new SessionLabelPresenter({ on: () => () => undefined, appendEntry } as unknown as ExtensionAPI, context, {
        label: () => label, participantId: () => "session:abc", settings: () => current, environment: {}, intervalMs: 0,
      });
      presenters.push(presenter);
      return presenter;
    };
    const presenter = make();
    await presenter.sync();
    expect(appendEntry).not.toHaveBeenCalled();
    // Data, not display: ui.sessionLabel.footer: false does not suppress it.
    label = "FAB-3";
    await presenter.sync();
    await presenter.sync();
    expect(appendEntry.mock.calls).toEqual([[FABRIC_PEER_ENTRY_TYPE, { version: 1, sequence: FABRIC_PEER_LABEL_SEQUENCE, participantId: "session:abc", label: "FAB-3" }]]);
    // A resumed session that already recorded this label appends nothing.
    await make().sync();
    expect(appendEntry).toHaveBeenCalledTimes(1);
    label = "FAB-4";
    await presenter.sync();
    expect(appendEntry).toHaveBeenLastCalledWith(FABRIC_PEER_ENTRY_TYPE, { version: 1, sequence: FABRIC_PEER_LABEL_SEQUENCE, participantId: "session:abc", label: "FAB-4" });
  });

  it("leaves the TUI footer to the widget header but keeps the RPC status", async () => {
    let widget = true;
    const tui = present({ settings: () => settings(), shownInWidget: () => widget });
    await tui.presenter.sync();
    expect(tui.setStatus).not.toHaveBeenCalled();
    expect(tui.presenter.visibleLabel).toBe("FAB-3");
    // ui.widget: "hidden" gives the label back to the footer.
    widget = false;
    await tui.presenter.sync();
    expect(tui.setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");

    const rpc = present({ settings: () => settings(), mode: "rpc", shownInWidget: () => true });
    await rpc.presenter.sync();
    expect(rpc.setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");
  });

  it("reports a pending label until minted and none while the setting is off", async () => {
    let label: string | undefined;
    const current = settings();
    const { presenter } = present({ label: () => label, settings: () => current, shownInWidget: () => true });
    expect(presenter.labelPending).toBe(true);
    expect(presenter.visibleLabel).toBeUndefined();
    label = "FAB-3";
    expect(presenter.labelPending).toBe(false);
    expect(presenter.visibleLabel).toBe("FAB-3");
    current.footer = false;
    expect(presenter.visibleLabel).toBeUndefined();
    label = undefined;
    expect(presenter.labelPending).toBe(false);
  });

  it("stops its timers at session_shutdown, before Pi invalidates the context", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      const handlers = new Map<string, Array<() => unknown>>();
      const on = ((event: string, handler: () => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
      }) as unknown as ExtensionAPI["on"];
      const label = vi.fn(() => "FAB-3");
      const context = { mode: "tui", hasUI: true, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
      const presenter = new SessionLabelPresenter({ on } as unknown as ExtensionAPI, context, {
        label, settings: () => settings(), environment: {}, intervalMs: 5_000,
      });
      presenters.push(presenter);
      await vi.advanceTimersByTimeAsync(5_000);
      await presenter.settled();
      expect(label).toHaveBeenCalled();

      for (const handler of handlers.get("session_shutdown") ?? []) handler();
      label.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      for (const handler of handlers.get("session_info_changed") ?? []) handler();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(label).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never rejects a sync on a stale context and stops syncing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    try {
      let stale = false;
      const reads = vi.fn();
      const setStatus = vi.fn();
      // Pi's context getters throw once the session is replaced or reloaded.
      const context = {
        get mode() {
          reads();
          if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
          return "tui";
        },
        hasUI: true,
        ui: { setStatus },
      } as unknown as ExtensionContext;
      const presenter = new SessionLabelPresenter({ on: () => () => undefined } as unknown as ExtensionAPI, context, {
        label: () => "FAB-3", settings: () => settings(), environment: {}, intervalMs: 5_000,
      });
      presenters.push(presenter);
      await presenter.sync();
      expect(setStatus).toHaveBeenCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-3");

      stale = true;
      await expect(presenter.sync()).resolves.toBeUndefined();
      reads.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      await presenter.settled();

      expect(reads).not.toHaveBeenCalled();
      await expect(presenter.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the label to be minted and hides it when the setting is off", async () => {
    let label: string | undefined;
    const current = settings();
    const { presenter, setStatus } = present({ label: () => label, settings: () => current });

    await presenter.sync();
    expect(setStatus).not.toHaveBeenCalled();

    label = "FAB-7";
    await presenter.sync();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, "Fabric FAB-7");

    current.footer = false;
    await presenter.sync();
    expect(setStatus).toHaveBeenLastCalledWith(SESSION_LABEL_STATUS_KEY, undefined);
  });
});

// The fake Herdr server listens on a Unix socket path; on Windows the client
// dials a named pipe instead, as in tests/herdr-transport.test.ts.
describe.skipIf(process.platform === "win32")("session label in Herdr", () => {
  it("leaves Herdr untouched while the integration is off", async () => {
    const herdr = await startHerdr();
    const { presenter } = present({ settings: () => settings(), environment: herdr.environment });

    await presenter.sync();
    await presenter.close();

    expect(herdr.requests).toEqual([]);
  });

  it("prefixes the live tab label once and restores it on close", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "tab" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    await presenter.sync();

    expect(herdr.tab.label).toBe("FAB-3 fabric-in-pi");
    expect(herdr.pane.label).toBe("research");
    expect(herdr.renames()).toEqual([
      { method: "tab.rename", params: { tab_id: "w1:t1", label: "FAB-3 fabric-in-pi" } },
    ]);

    await presenter.close();
    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("puts the label back after another writer renames the pane", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "pane" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    expect(herdr.pane.label).toBe("FAB-3 research");

    herdr.pane.label = "renamed-by-name-sync";
    await presenter.sync();
    expect(herdr.pane.label).toBe("FAB-3 renamed-by-name-sync");
    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("shares one tab between two sessions without renaming back and forth", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "tab" });
    const first = present({ label: () => "FAB-3", settings: () => current, environment: herdr.environment });
    const second = present({ label: () => "FAB-4", settings: () => current, environment: herdr.environment });

    for (let round = 0; round < 3; round++) {
      await first.presenter.sync();
      await second.presenter.sync();
    }

    expect(herdr.tab.label).toBe("FAB-4 FAB-3 fabric-in-pi");
    expect(herdr.renames()).toHaveLength(2);

    await first.presenter.close();
    expect(herdr.tab.label).toBe("FAB-4 fabric-in-pi");
  });

  it("restores both names as soon as the target is turned off, clearing an unlabelled pane", async () => {
    const herdr = await startHerdr({ paneLabel: null });
    const current = settings({ herdr: "both" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await presenter.sync();
    expect(herdr.pane.label).toBe("FAB-3");
    expect(herdr.tab.label).toBe("FAB-3 fabric-in-pi");

    current.herdr = "off";
    await presenter.sync();

    expect(herdr.pane.label).toBeNull();
    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("does not rename anything outside an interactive TUI or outside Herdr", async () => {
    const herdr = await startHerdr();
    const current = settings({ herdr: "both" });
    const printMode = present({ settings: () => current, environment: herdr.environment, mode: "print", hasUI: false });
    const { HERDR_ENV: _herdr, ...outside } = herdr.environment;
    const notHerdr = present({ settings: () => current, environment: outside });

    await printMode.presenter.sync();
    await notHerdr.presenter.sync();

    expect(herdr.requests).toEqual([]);
  });

  it("survives a Herdr failure without throwing", async () => {
    const herdr = await startHerdr({ failRename: true });
    const current = settings({ herdr: "tab" });
    const { presenter } = present({ settings: () => current, environment: herdr.environment });

    await expect(presenter.sync()).resolves.toBeUndefined();

    expect(herdr.tab.label).toBe("fabric-in-pi");
  });

  it("reapplies after a session name change without waiting for the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const herdr = await startHerdr();
      const handlers = new Map<string, () => unknown>();
      const on = ((event: string, handler: () => unknown) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }) as unknown as ExtensionAPI["on"];
      const current = settings({ herdr: "pane" });
      const { presenter } = present({ settings: () => current, environment: herdr.environment, on });
      await presenter.sync();
      herdr.pane.label = "new-name";

      handlers.get("session_info_changed")?.();
      await vi.advanceTimersByTimeAsync(1_000);
      await presenter.settled();

      expect(herdr.pane.label).toBe("FAB-3 new-name");
      expect(herdr.renames().filter((request) => request.params.label === "FAB-3 new-name")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
