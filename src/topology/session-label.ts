import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdrSocketRequest } from "../agents/transports/herdr-socket.js";
import type { FabricSessionLabelConfig, FabricSessionLabelHerdrTarget } from "./session-label-settings.js";
import { FABRIC_PEER_ENTRY_TYPE, FABRIC_PEER_LABEL_SEQUENCE, type FabricPeerEntryV1 } from "../protocol.js";

/**
 * The label a session recorded for `participantId` in its `pi-fabric-peer`
 * entries, newest first. Forks and clones carry the entry but get a new id,
 * and labels from an older counter generation are retired.
 */
export const recordedPeerLabel = (context: ExtensionContext, participantId: string): string | undefined => {
  const entries = context.sessionManager?.getBranch?.() ?? context.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== FABRIC_PEER_ENTRY_TYPE) continue;
    const data = entry.data as Partial<FabricPeerEntryV1> | undefined;
    if (data?.participantId !== participantId || typeof data.label !== "string") continue;
    return data.sequence === FABRIC_PEER_LABEL_SEQUENCE ? data.label : undefined;
  }
  return undefined;
};

/** Footer status key; Pi sorts extension statuses by key. */
export const SESSION_LABEL_STATUS_KEY = "fabric-label";

/** How often Fabric checks that its label is still on the Herdr names. */
const SESSION_LABEL_INTERVAL_MS = 5_000;
/** Debounce after a Pi session-name change, so a renamer that runs on the same event goes first. */
const SESSION_LABEL_EVENT_DELAY_MS = 500;

type HerdrName = "tab" | "pane";

interface AppliedName {
  kind: HerdrName;
  id: string;
  label: string;
}

export interface SessionLabelPresenterOptions {
  /** The minted peer label, once the participant directory has one. */
  label: () => string | undefined;
  /** This session's participant id, recorded beside the label for headless hosts. */
  participantId?: () => string | undefined;
  /** Read on every sync, so a config reload takes effect on the next one. */
  settings: () => FabricSessionLabelConfig;
  /**
   * True while Fabric's TUI widget heads its agent list with the label. The
   * footer then stays empty, so the label shows once. RPC clients have no
   * widget and always get the footer status.
   */
  shownInWidget?: () => boolean;
  environment?: NodeJS.ProcessEnv;
  /** 0 disables the timer; tests drive sync() directly. */
  intervalMs?: number;
}

const tokens = (name: string): string[] => name.split(/\s+/).filter(Boolean);

/** Remove every whole-word copy of the label, keeping the rest of the name. */
const stripAffix = (name: string, label: string): string =>
  tokens(name).filter((token) => token !== label).join(" ");

const withAffix = (name: string, label: string): string => (name ? `${label} ${name}` : label);

/**
 * True when the label is already a whole word of the name. Two sessions can
 * share a tab, so the label need not be at the edge: each session keeps its
 * own word where it is instead of moving it back to the edge on every sync.
 */
const hasAffix = (name: string, label: string): boolean => tokens(name).includes(label);

const targets = (target: FabricSessionLabelHerdrTarget): HerdrName[] =>
  target === "both" ? ["tab", "pane"] : target === "off" ? [] : [target];

/**
 * Shows a root session's Fabric peer label (for example `FAB-3`) in the Pi
 * footer and, when configured, adds it to the Herdr tab or pane name.
 *
 * Herdr names have other writers (Pi name sync renames the pane on every
 * session-name change), so Fabric never caches a name: each sync reads the
 * live label, adds its own token only when missing, and on close or opt-out
 * strips only that token so another writer's changes survive.
 */
export class SessionLabelPresenter {
  readonly #unsubscribe: Array<() => void> = [];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #applied = new Map<string, AppliedName>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #eventTimer: ReturnType<typeof setTimeout> | undefined;
  #footer: string | undefined;
  #recordedPeer: string | undefined;
  #syncing: Promise<void> | undefined;
  #syncAgain = false;
  #closed = false;
  /** Set once the session shuts down or its context goes stale: no more syncs start. */
  #stopped = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly context: ExtensionContext,
    private readonly options: SessionLabelPresenterOptions,
  ) {
    this.#environment = options.environment ?? process.env;
    if (typeof pi.on === "function") {
      const unsubscribe = (pi.on as (event: string, handler: () => void) => unknown)(
        "session_info_changed",
        () => this.#scheduleEventSync(),
      );
      if (typeof unsubscribe === "function") this.#unsubscribe.push(unsubscribe as () => void);
      // Pi invalidates this context right after session_shutdown, so no timer may
      // outlive it. close() still restores the tab and pane names.
      const unsubscribeShutdown = (pi.on as (event: string, handler: () => void) => unknown)(
        "session_shutdown",
        () => this.#stop(),
      );
      if (typeof unsubscribeShutdown === "function") this.#unsubscribe.push(unsubscribeShutdown as () => void);
    }
    const intervalMs = options.intervalMs ?? SESSION_LABEL_INTERVAL_MS;
    if (intervalMs > 0) {
      this.#timer = setInterval(() => void this.sync(), intervalMs);
      this.#timer.unref?.();
    }
  }

  /** The label the session shows, or undefined while unminted or turned off by `ui.sessionLabel.footer`. */
  get visibleLabel(): string | undefined {
    return this.#closed || !this.options.settings().footer ? undefined : this.options.label();
  }

  /** True while the session will show a label the directory has not minted yet. */
  get labelPending(): boolean {
    return !this.#closed && this.options.settings().footer && this.options.label() === undefined;
  }

  /** True when this process may rename Herdr names: an interactive Pi inside Herdr. */
  get herdrAvailable(): boolean {
    return this.context.mode === "tui"
      && this.#environment.HERDR_ENV === "1"
      && Boolean(this.#environment.HERDR_SOCKET_PATH)
      && Boolean(this.#environment.HERDR_PANE_ID);
  }

  /**
   * Bring the footer and Herdr names in line with the label and settings.
   * Never rejects: a failed socket request is retried on the next sync, and a
   * stale context (the session was replaced or reloaded) stops the timers.
   */
  sync(): Promise<void> {
    if (this.#closed || this.#stopped) return Promise.resolve();
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    const run = (async () => {
      try {
        do {
          this.#syncAgain = false;
          await this.#syncOnce();
        } while (this.#syncAgain && !this.#closed && !this.#stopped);
      } catch {
        // Timer callbacks must not reject. Once the context is stale, every
        // later sync would throw the same way, so stop instead of retrying.
        if (!this.#contextActive()) this.#stop();
      } finally {
        this.#syncing = undefined;
      }
    })();
    this.#syncing = run;
    return run;
  }

  /** Resolves after any scheduled or running sync has finished. */
  async settled(): Promise<void> {
    while (this.#syncing) await this.#syncing;
  }

  /** Stop syncing, clear the footer, and remove the label from every Herdr name Fabric changed. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    await this.#syncing?.catch(() => undefined);
    try {
      this.#setFooter(undefined);
    } catch {
      // A stale context has no footer left to clear; the tab and pane names still do.
    }
    for (const name of [...this.#applied.values()]) await this.#remove(name);
  }

  /** Stop the timers and event subscriptions; close() still restores the names. */
  #stop(): void {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#timer) clearInterval(this.#timer);
    if (this.#eventTimer) clearTimeout(this.#eventTimer);
    this.#timer = undefined;
    this.#eventTimer = undefined;
  }

  /** False once Pi has invalidated the captured context after a session replacement or reload. */
  #contextActive(): boolean {
    try {
      void this.context.mode;
      return true;
    } catch {
      return false;
    }
  }

  #scheduleEventSync(): void {
    if (this.#closed || this.#stopped) return;
    if (this.#eventTimer) clearTimeout(this.#eventTimer);
    this.#eventTimer = setTimeout(() => {
      this.#eventTimer = undefined;
      void this.sync();
    }, SESSION_LABEL_EVENT_DELAY_MS);
    this.#eventTimer.unref?.();
  }

  async #syncOnce(): Promise<void> {
    const settings = this.options.settings();
    const label = this.options.label();
    if (label) this.#recordPeer(label);
    const inWidget = this.context.mode === "tui" && this.options.shownInWidget?.() === true;
    this.#setFooter(settings.footer && label && !inWidget ? `Fabric ${label}` : undefined);
    const wanted = new Set<HerdrName>(label && this.herdrAvailable ? targets(settings.herdr) : []);
    try {
      for (const [key, name] of [...this.#applied]) {
        if (!wanted.has(name.kind) || name.label !== label) {
          await this.#remove(name);
          this.#applied.delete(key);
        }
      }
      if (!label) return;
      for (const kind of wanted) await this.#apply(kind, label);
    } catch {
      // Herdr is unreachable or refused; the next sync reads the live names again.
    }
  }

  /**
   * Record the label as a session entry for RPC clients (`get_entries`). It is
   * data, not display, so `ui.sessionLabel` settings never suppress it, and a
   * resumed session that recorded the same label appends nothing.
   */
  #recordPeer(label: string): void {
    const participantId = this.options.participantId?.();
    const pi = this.pi as Partial<Pick<ExtensionAPI, "appendEntry">>;
    if (!participantId || typeof pi.appendEntry !== "function") return;
    const key = `${participantId}\n${label}`;
    if (key === this.#recordedPeer) return;
    this.#recordedPeer = key;
    if (recordedPeerLabel(this.context, participantId) === label) return;
    const entry: FabricPeerEntryV1 = { version: 1, sequence: FABRIC_PEER_LABEL_SEQUENCE, participantId, label };
    pi.appendEntry(FABRIC_PEER_ENTRY_TYPE, entry);
  }

  #setFooter(text: string | undefined): void {
    // Pi draws extension statuses verbatim, so an unstyled label reads brighter
    // than Pi's own dim cwd and stats lines. Match them with the live theme.
    // RPC clients render the status themselves and get the raw text.
    const styled = text === undefined || this.context.mode !== "tui"
      ? text
      : this.#dim(text);
    if (styled === this.#footer) return;
    this.#footer = styled;
    if (this.context.hasUI) this.context.ui.setStatus(SESSION_LABEL_STATUS_KEY, styled);
  }

  #dim(text: string): string {
    const theme = this.context.ui.theme;
    return typeof theme?.fg === "function" ? theme.fg("dim", text) : text;
  }

  async #apply(kind: HerdrName, label: string): Promise<void> {
    const current = await this.#read(kind);
    if (!current) return;
    const name: AppliedName = { kind, id: current.id, label };
    // The pane can move to another tab; forget the label on the old one.
    for (const [key, applied] of [...this.#applied]) {
      if (applied.kind === kind && applied.id !== current.id) {
        await this.#remove(applied);
        this.#applied.delete(key);
      }
    }
    this.#applied.set(`${kind}:${current.id}`, name);
    if (hasAffix(current.label, label)) return;
    const base = stripAffix(current.label, label);
    await this.#rename(kind, current.id, withAffix(base, label));
  }

  async #remove(name: AppliedName): Promise<void> {
    try {
      const current = await this.#read(name.kind, name.id);
      if (!current) return;
      const base = stripAffix(current.label, name.label);
      if (base !== current.label) await this.#rename(name.kind, name.id, base);
    } catch {
      // Best effort: shutdown and opt-out must not fail on Herdr.
    }
  }

  /** The live tab or pane and its current label. The tab comes from the pane, since a pane can move. */
  async #read(kind: HerdrName, id?: string): Promise<{ id: string; label: string } | undefined> {
    if (kind === "pane" || id === undefined) {
      const response = await this.#request("pane.get", { pane_id: this.#environment.HERDR_PANE_ID });
      const pane = (response as { result?: { pane?: { pane_id?: string; tab_id?: string; label?: string | null } } })
        .result?.pane;
      if (kind === "pane") return pane?.pane_id ? { id: pane.pane_id, label: pane.label ?? "" } : undefined;
      id = pane?.tab_id;
      if (!id) return undefined;
    }
    const response = await this.#request("tab.get", { tab_id: id });
    const tab = (response as { result?: { tab?: { tab_id?: string; label?: string } } }).result?.tab;
    return tab?.tab_id ? { id: tab.tab_id, label: tab.label ?? "" } : undefined;
  }

  async #rename(kind: HerdrName, id: string, label: string): Promise<void> {
    // An empty pane label clears it; Herdr requires a tab label.
    if (kind === "pane") await this.#request("pane.rename", { pane_id: id, label: label || null });
    else if (label) await this.#request("tab.rename", { tab_id: id, label });
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return herdrSocketRequest(this.#environment.HERDR_SOCKET_PATH, { method, params }, "Fabric session label");
  }
}
