import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { FabricMeshConfig } from "../config.js";
import type { MeshEvent, MeshStore } from "../mesh/store.js";

const MESH_WATCH_RECONCILE_MS = 2_000;

/** Owns observation resources and the format-1 cursor, never actor ownership or dispatch policy. */
export class ActorMeshMonitor {
  #timer: NodeJS.Timeout | undefined;
  #dueTimer: NodeJS.Timeout | undefined;
  #dueAt: number | undefined;
  #watcher: FSWatcher | undefined;
  #offset: number;
  #scheduled = false;
  #polling = false;
  #closed = false;
  #started = false;

  constructor(
    readonly mesh: Pick<MeshStore, "root" | "latestOffset" | "tail"> &
      Partial<Pick<MeshStore, "nextScheduleDueAt" | "releaseDueSchedules">>,
    readonly config: Pick<FabricMeshConfig, "enabled" | "actorPollMs" | "maxReadEvents">,
    readonly callbacks: {
      cursorPath?: string | undefined;
      beforePoll(): boolean;
      onEvent(event: MeshEvent): void;
    },
  ) {
    this.#offset = this.#readCursor() ?? mesh.latestOffset();
  }

  start(): void {
    if (this.#started || this.#closed || !this.config.enabled) return;
    this.#started = true;
    if (process.platform === "win32") {
      this.#startTimer(this.config.actorPollMs);
      this.schedule();
      return;
    }
    try {
      const watcher = fs.watch(this.mesh.root, { persistent: false }, (_event, filename) => {
        const name = filename == null ? undefined : path.basename(filename.toString());
        // schedules.json re-arms the due timer when another process schedules.
        if (name !== undefined && name !== "events.jsonl" && name !== "schedules.json") return;
        this.schedule();
      });
      this.#watcher = watcher;
      watcher.on("error", () => this.#fallback(watcher));
      this.#startTimer(Math.max(MESH_WATCH_RECONCILE_MS, this.config.actorPollMs));
    } catch {
      this.#startTimer(this.config.actorPollMs);
    }
    this.schedule();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#dueTimer) clearTimeout(this.#dueTimer);
    this.#dueTimer = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  schedule(): void {
    if (this.#scheduled || this.#closed || !this.config.enabled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      void this.#poll().catch(() => undefined);
    });
  }

  #fallback(watcher: FSWatcher): void {
    if (this.#closed || this.#watcher !== watcher) return;
    watcher.close();
    this.#watcher = undefined;
    this.#startTimer(this.config.actorPollMs);
    this.schedule();
  }

  // A schedule falling due changes no file, so wake at its due time instead of
  // waiting for the reconcile interval.
  #armDue(dueAt: number | undefined): void {
    if (dueAt === this.#dueAt) return;
    if (this.#dueTimer) clearTimeout(this.#dueTimer);
    this.#dueTimer = undefined;
    this.#dueAt = dueAt;
    if (dueAt === undefined || this.#closed) return;
    this.#dueTimer = setTimeout(() => {
      this.#dueTimer = undefined;
      this.#dueAt = undefined;
      this.schedule();
    }, Math.min(Math.max(0, dueAt - Date.now()), 2_147_000_000));
    this.#dueTimer.unref();
  }

  #startTimer(delay: number): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => this.schedule(), delay);
    this.#timer.unref();
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#closed || !this.config.enabled) return;
    if (!this.callbacks.beforePoll()) return;
    this.#polling = true;
    try {
      // Whichever process polls first releases due schedules; the store lock
      // makes the release exactly-once, and this poll's tail then sees them.
      // The lockless due check keeps an idle poll synchronous.
      let dueAt: number | undefined;
      try { dueAt = this.mesh.nextScheduleDueAt?.(); } catch { dueAt = undefined; }
      if (dueAt !== undefined && dueAt <= Date.now()) {
        await this.mesh.releaseDueSchedules?.().catch(() => undefined);
        if (this.#closed) return;
        try { dueAt = this.mesh.nextScheduleDueAt?.(); } catch { dueAt = undefined; }
      }
      this.#armDue(dueAt);
      const tail = this.mesh.tail(this.#offset, this.config.maxReadEvents);
      this.#offset = tail.nextOffset;
      for (const event of tail.events) this.callbacks.onEvent(event);
      this.#writeCursor();
    } finally {
      this.#polling = false;
    }
  }

  #readCursor(): number | undefined {
    if (!this.callbacks.cursorPath) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(this.callbacks.cursorPath, "utf8")) as {
        format?: unknown;
        cursor?: unknown;
      };
      return value.format === 1 && typeof value.cursor === "number" && value.cursor >= 0
        ? value.cursor
        : undefined;
    } catch {
      return undefined;
    }
  }

  #writeCursor(): void {
    if (!this.callbacks.cursorPath) return;
    try {
      writeJsonAtomic(this.callbacks.cursorPath, { format: 1, cursor: this.#offset }, { space: 2 });
    } catch {
      // Cursor persistence is best-effort; replay resumes from the latest safe cursor.
    }
  }
}
