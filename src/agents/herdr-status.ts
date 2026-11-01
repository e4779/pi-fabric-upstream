import { herdrSocketRequest, type HerdrSocketRequest } from "./transports/herdr-socket.js";
import type { AgentActivity } from "./types.js";

// Herdr's Pi integration (source "herdr:pi") reports a pane idle when the root
// turn ends, even while this session's Fabric agents keep running. This
// presenter tells Herdr about them in three ways:
// - herdr:busy {active, label} on pi.events while any agent runs. Herdr 0.9.5
//   does not listen for it yet; other Pi extensions emit the same event.
// - herdr:blocked {active, label} while a child question waits on the user.
//   Herdr's Pi integration counts these raises and marks the pane blocked.
// - pane.report_metadata on Herdr's socket, which replaces the idle, done and
//   working text with a count of running agents. It is display-only, never
//   takes lifecycle authority from herdr:pi, and expires by TTL if Pi dies.

export const HERDR_STATUS_SOURCE = "pi-fabric:herdr";
const HERDR_PI_SOURCE = "herdr:pi";
const DEFAULT_TTL_MS = 120_000;
const DEFAULT_REFRESH_MS = 45_000;
/** Herdr caps metadata values at 80 characters. */
const MAX_TEXT_CHARS = 80;

export interface HerdrAgentStatusOptions {
  events: { emit(event: string, data: unknown): void };
  /** This session's unsettled runs, read on every sync. */
  activity(): readonly AgentActivity[];
  environment?: Readonly<Record<string, string | undefined>>;
  request?: (socketPath: string, request: HerdrSocketRequest) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
  refreshMs?: number;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

const clip = (text: string): string =>
  text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;

const summaryText = (runs: readonly AgentActivity[]): string => {
  const waiting = runs.filter((run) => run.question !== undefined).length;
  const names = [...new Set(runs.map((run) => run.name))].join(", ");
  return clip(
    `⏳ ${plural(runs.length, "Fabric agent")}${waiting > 0 ? ` · ⚠ ${waiting} waiting` : ""} · ${names}`,
  );
};

/** Publishes this session's running agents to the Herdr pane it runs in. */
export class HerdrAgentStatus {
  readonly #options: HerdrAgentStatusOptions;
  readonly #paneId: string | undefined;
  readonly #socketPath: string | undefined;
  readonly #request: (socketPath: string, request: HerdrSocketRequest) => Promise<unknown>;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #refreshMs: number;
  /** Raised herdr:blocked labels by run id; each is released exactly once. */
  readonly #blocked = new Map<string, string>();
  #busyLabel: string | undefined;
  #text: string | undefined;
  #published = false;
  #seq = 0;
  #refresh: ReturnType<typeof setInterval> | undefined;
  #pending: Record<string, unknown> | undefined;
  #drain: Promise<void> | undefined;
  #closed = false;

  constructor(options: HerdrAgentStatusOptions) {
    this.#options = options;
    const environment = options.environment ?? process.env;
    const inHerdr = environment.HERDR_ENV === "1";
    this.#paneId = inHerdr ? environment.HERDR_PANE_ID || undefined : undefined;
    this.#socketPath = inHerdr ? environment.HERDR_SOCKET_PATH || undefined : undefined;
    this.#request =
      options.request ?? ((socketPath, request) => herdrSocketRequest(socketPath, request, "Herdr status"));
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  }

  get enabled(): boolean {
    return this.#paneId !== undefined && this.#socketPath !== undefined;
  }

  /** Bring Herdr in line with the current activity; unchanged state sends nothing. */
  sync(): void {
    if (!this.enabled || this.#closed) return;
    const runs = this.#options.activity();
    this.#syncBlocked(runs);
    this.#syncBusy(runs.length === 0 ? undefined : `Fabric: ${plural(runs.length, "agent")} running`);
    this.#syncMetadata(runs.length === 0 ? undefined : summaryText(runs));
  }

  /** Release every hold and clear the pane metadata; later syncs do nothing. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.enabled) return;
    this.#syncBlocked([]);
    this.#syncBusy(undefined);
    this.#syncMetadata(undefined);
    await this.#drain;
  }

  #syncBlocked(runs: readonly AgentActivity[]): void {
    const asking = new Map(
      runs
        .filter((run) => run.question !== undefined)
        .map((run) => [run.id, clip(`${run.name}: ${run.question}`)] as const),
    );
    for (const id of [...this.#blocked.keys()]) {
      if (asking.has(id)) continue;
      this.#blocked.delete(id);
      this.#options.events.emit("herdr:blocked", { active: false });
    }
    for (const [id, label] of asking) {
      if (this.#blocked.has(id)) continue;
      this.#blocked.set(id, label);
      this.#options.events.emit("herdr:blocked", { active: true, label });
    }
  }

  #syncBusy(label: string | undefined): void {
    if (label === this.#busyLabel) return;
    // A listener may count raises, so a new label releases the old raise first.
    if (this.#busyLabel !== undefined) this.#options.events.emit("herdr:busy", { active: false });
    this.#busyLabel = label;
    if (label !== undefined) this.#options.events.emit("herdr:busy", { active: true, label });
  }

  #syncMetadata(text: string | undefined): void {
    if (text === this.#text) return;
    this.#text = text;
    if (text !== undefined) {
      this.#report();
      if (!this.#refresh && this.#refreshMs > 0 && !this.#closed) {
        this.#refresh = setInterval(() => this.#report(), this.#refreshMs);
        this.#refresh.unref?.();
      }
      return;
    }
    if (this.#refresh) clearInterval(this.#refresh);
    this.#refresh = undefined;
    if (!this.#published) return;
    this.#published = false;
    this.#enqueue({
      ...this.#target(),
      clear_state_labels: true,
      tokens: { summary: null },
      seq: this.#nextSeq(),
    });
  }

  #report(): void {
    const text = this.#text;
    if (text === undefined) return;
    this.#published = true;
    this.#enqueue({
      ...this.#target(),
      state_labels: { idle: text, done: text, working: text },
      tokens: { summary: text },
      ttl_ms: this.#ttlMs,
      seq: this.#nextSeq(),
    });
  }

  #target(): Record<string, unknown> {
    return {
      pane_id: this.#paneId,
      source: HERDR_STATUS_SOURCE,
      agent: "pi",
      applies_to_source: HERDR_PI_SOURCE,
    };
  }

  /** Herdr ignores a seq at or below the last accepted one for this source. */
  #nextSeq(): number {
    this.#seq = Math.max(this.#seq + 1, this.#now() * 1_000);
    return this.#seq;
  }

  /** Send reports in order, keeping only the newest one waiting. */
  #enqueue(params: Record<string, unknown>): void {
    this.#pending = params;
    if (this.#drain) return;
    const socketPath = this.#socketPath!;
    this.#drain = (async () => {
      while (this.#pending) {
        const next = this.#pending;
        this.#pending = undefined;
        try {
          await this.#request(socketPath, { method: "pane.report_metadata", params: next });
        } catch {
          // Best effort: the next change or TTL refresh sends the newest state.
        }
      }
    })().finally(() => {
      this.#drain = undefined;
    });
  }
}
