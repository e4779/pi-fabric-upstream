import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  FabricCompactionOwnerActionNameV1,
  FabricCompactionOwnerActionsV1,
  FabricCompactionOwnerClaimV1,
  FabricCompactionOwnerMessageV1,
  FabricCompactionOwnerWithdrawV1,
} from "../protocol.js";
import { DEFAULT_FABRIC_CONFIG, type FabricConfig } from "../config.js";
import { latestCarryItems } from "./carry.js";
import {
  COMPACTION_OWNER_CARRY_FIELDS,
  COMPACTION_OWNER_REQUEST_FIELDS,
  CompactionOwnerRegistry,
  deterministicCompactionFallback,
  type ActiveCompactionOwner,
} from "./claim.js";

// The compaction owner claim code. Fabric loads this module when the first
// claim or withdrawal arrives, never at startup (see the listener in
// extension.ts), so the reader and the registry stay out of the startup graph.

export type FabricCompactionOwnerReadResultV1 =
  | { ok: true; message: FabricCompactionOwnerMessageV1 }
  | { ok: false; error: string; reply?: (result: { ok: false; error: string }) => void };

const COMPACTION_OWNER_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const ownerText = (value: unknown, max: number): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= max
  && value.trim() === value
  && COMPACTION_OWNER_TEXT.test(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unknownKey = (record: Record<string, unknown>, known: readonly string[]): string | undefined =>
  Object.keys(record).find((key) => !known.includes(key));

const readOwnerFields = <T extends string>(
  value: unknown,
  known: readonly T[],
  action: string,
): T[] | string => {
  if (!Array.isArray(value) || value.length > known.length * 2) {
    return `actions.${action}.fields must be an array of ${known.join(", ")}`;
  }
  const fields: T[] = [];
  for (const field of value) {
    if (typeof field !== "string" || !(known as readonly string[]).includes(field)) {
      return `actions.${action}.fields has an unknown field: ${String(field).slice(0, 64)}`;
    }
    if (!fields.includes(field as T)) fields.push(field as T);
  }
  return fields;
};

const readOwnerActions = (value: unknown): FabricCompactionOwnerActionsV1 | string => {
  if (!isPlainRecord(value)) return "actions must be an object";
  const names: readonly FabricCompactionOwnerActionNameV1[] = ["request", "status", "pressure", "carry", "cancel"];
  const unknown = unknownKey(value, names);
  if (unknown !== undefined) return `actions has an unknown action: ${unknown.slice(0, 64)}`;
  const actions: FabricCompactionOwnerActionsV1 = {};
  for (const name of names) {
    const entry = value[name];
    if (entry === undefined) continue;
    // Each caller field is read once: a getter cannot pass the check with
    // one value and be stored with another.
    const handler = isPlainRecord(entry) ? entry.handler : undefined;
    if (!isPlainRecord(entry) || typeof handler !== "function") {
      return `actions.${name} must be an object with a handler function`;
    }
    const extra = unknownKey(entry, name === "request" || name === "carry" ? ["fields", "handler"] : ["handler"]);
    if (extra !== undefined) return `actions.${name} has an unknown key: ${extra.slice(0, 64)}`;
    if (name === "request" || name === "carry") {
      const declared = entry.fields;
      const fields = name === "request"
        ? readOwnerFields(declared, COMPACTION_OWNER_REQUEST_FIELDS, name)
        : readOwnerFields(declared, COMPACTION_OWNER_CARRY_FIELDS, name);
      if (typeof fields === "string") return fields;
      (actions as Record<string, unknown>)[name] = { fields, handler };
    } else {
      (actions as Record<string, unknown>)[name] = { handler };
    }
  }
  return actions;
};

const isAbortSignalLike = (value: unknown): value is AbortSignal =>
  typeof value === "object"
  && value !== null
  && typeof (value as { aborted?: unknown }).aborted === "boolean"
  && typeof (value as { addEventListener?: unknown }).addEventListener === "function"
  && typeof (value as { removeEventListener?: unknown }).removeEventListener === "function";

/**
 * Validates a compaction-owner message and returns a fresh copy built from
 * named fields only; the caller's object never reaches stored state.
 */
export const readFabricCompactionOwnerMessageV1 = (value: unknown): FabricCompactionOwnerReadResultV1 => {
  if (!isPlainRecord(value)) return { ok: false, error: "message must be an object" };
  const rawReply = value.reply;
  const reply = typeof rawReply === "function"
    ? rawReply as (result: { ok: false; error: string }) => void
    : undefined;
  const fail = (error: string): FabricCompactionOwnerReadResultV1 => ({ ok: false, error, ...(reply ? { reply } : {}) });
  if (value.version !== 1) return fail("version must be 1");
  // Each caller field is read once into a local: a getter cannot pass a check
  // with one value and be stored with another.
  const type = value.type;
  if (type === "withdraw") {
    const extra = unknownKey(value, ["version", "type", "token", "reply"]);
    if (extra !== undefined) return fail(`withdraw has an unknown key: ${extra.slice(0, 64)}`);
    if (rawReply !== undefined && !reply) return fail("reply must be a function");
    const token = value.token;
    if (!ownerText(token, 128)) return fail("token must be the claim handle's token");
    return {
      ok: true,
      message: {
        version: 1,
        type: "withdraw",
        token,
        ...(reply ? { reply: reply as NonNullable<FabricCompactionOwnerWithdrawV1["reply"]> } : {}),
      },
    };
  }
  if (type !== "claim") return fail('type must be "claim" or "withdraw"');
  const extra = unknownKey(value, ["version", "type", "owner", "actions", "branchSummary", "signal", "reply"]);
  if (extra !== undefined) return fail(`claim has an unknown key: ${extra.slice(0, 64)}`);
  if (!reply) return fail("reply must be a function");
  const owner = value.owner;
  const name = isPlainRecord(owner) ? owner.name : undefined;
  const ownerVersion = isPlainRecord(owner) ? owner.version : undefined;
  if (!ownerText(name, 128) || !ownerText(ownerVersion, 64)) {
    return fail("owner must be { name, version } with non-empty printable text");
  }
  const actions = readOwnerActions(value.actions);
  if (typeof actions === "string") return fail(actions);
  const branchSummary = value.branchSummary;
  if (branchSummary !== undefined && typeof branchSummary !== "boolean") {
    return fail("branchSummary must be a boolean");
  }
  const signal = value.signal;
  if (signal !== undefined && !isAbortSignalLike(signal)) return fail("signal must be an AbortSignal");
  return {
    ok: true,
    message: {
      version: 1,
      type: "claim",
      owner: { name, version: ownerVersion },
      actions,
      ...(branchSummary === true ? { branchSummary: true } : {}),
      ...(signal !== undefined ? { signal } : {}),
      reply: reply as FabricCompactionOwnerClaimV1["reply"],
    },
  };
};

export interface CompactionOwnerHostOptions {
  /** The live session context, once Fabric knows it; undefined before. */
  context: () => ExtensionContext | undefined;
  targetContextRatio: () => number | undefined;
  /** Called each time a held claim ends. */
  onRelease: () => void;
}

/** What Fabric's extension shares with the claim code; the code fills `host` on the first message. */
export interface CompactionOwnerSlot {
  host?: CompactionOwnerHost;
  /** Set at session_shutdown: no claim is granted from then on. */
  closed: boolean;
  /**
   * A deliberate yield the compaction hook noted for the ownership observer.
   * One noted while the owner held compaction, and never consumed, is
   * cleared when the claim ends so it cannot hide the next foreign compaction.
   */
  yielded: boolean;
}

/** The part of Fabric's state the claim code reads. */
export interface CompactionOwnerConfigSource {
  readonly cwd: string | undefined;
  readonly config: FabricConfig;
}

/** Answers one message once the claim code has loaded; messages arrive in emit order. */
export const handleCompactionOwnerMessage = (
  slot: CompactionOwnerSlot,
  value: unknown,
  source: CompactionOwnerConfigSource,
  context: () => ExtensionContext | undefined,
): void => {
  const options: CompactionOwnerHostOptions = {
    context,
    targetContextRatio: () =>
      source.cwd
        ? source.config.compaction.targetContextRatio
        : DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
    onRelease: () => {
      slot.yielded = false;
    },
  };
  if (slot.closed) {
    new CompactionOwnerHost(options).refuse(value, "Fabric is shutting down and holds no compaction owner claims");
    return;
  }
  (slot.host ??= new CompactionOwnerHost(options)).handle(value);
};

/**
 * The registry plus the reader. Nothing here throws to the emitter: a message
 * that cannot be answered, or a reply that throws, becomes a warning (a
 * granted claim whose reply throws is withdrawn first).
 */
export class CompactionOwnerHost {
  readonly #registry: CompactionOwnerRegistry;
  readonly #warn: (message: string) => void;

  constructor(options: CompactionOwnerHostOptions) {
    this.#warn = (message) => {
      const context = options.context();
      if (context?.hasUI) context.ui.notify(message, "warning");
      else console.warn(`[pi-fabric] ${message}`);
    };
    this.#registry = new CompactionOwnerRegistry({
      warn: this.#warn,
      fallback: deterministicCompactionFallback(options.targetContextRatio),
      onRelease: options.onRelease,
      // Read from the session Fabric last started; unknown before Fabric's own
      // session_start has run.
      carry: () => {
        try {
          const context = options.context();
          return context ? latestCarryItems(context.sessionManager.getBranch()) : undefined;
        } catch {
          return undefined;
        }
      },
    });
  }

  get active(): ActiveCompactionOwner | undefined {
    return this.#registry.active;
  }

  clear(): void {
    this.#registry.clear();
  }

  handle(value: unknown): void {
    this.#answer(value, (message) => this.#registry.handle(message));
  }

  /** Answers with a refusal; no claim is granted and none is held. */
  refuse(value: unknown, reason: string): void {
    this.#answer(value, (message) => {
      message.reply?.({ ok: false, error: `Fabric refused the compaction owner message: ${reason}` });
    });
  }

  #answer(value: unknown, handle: (message: FabricCompactionOwnerMessageV1) => void): void {
    const read = readFabricCompactionOwnerMessageV1(value);
    if (!read.ok) {
      const error = `Invalid Pi Fabric compaction owner message: ${read.error}`;
      if (!read.reply) {
        this.#warn(error);
        return;
      }
      try {
        read.reply({ ok: false, error });
      } catch (replyError) {
        this.#warn(`${error} (and its reply threw: ${String(replyError)})`);
      }
      return;
    }
    try {
      handle(read.message);
    } catch (error) {
      this.#warn(`Pi Fabric compaction owner reply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
