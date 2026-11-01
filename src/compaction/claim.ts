import { randomUUID } from "node:crypto";
import type { CompactionResult, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { applyCarryUpdate } from "./carry.js";
import type { CompactionEnricher } from "./enrichers.js";
import { compileFabricCompactionForEvent, type FabricCompactionDetailsV2 } from "./hook.js";
import type {
  FabricCompactionFallbackOptionsV1,
  FabricCompactionFallbackResultV1,
  FabricCompactionOwnerActionsV1,
  FabricCompactionOwnerClaimResultV1,
  FabricCompactionOwnerClaimV1,
  FabricCompactionOwnerHandleV1,
  FabricCompactionOwnerCarryFieldV1,
  FabricCompactionOwnerIdentityV1,
  FabricCompactionOwnerMessageV1,
  FabricCompactionOwnerRequestFieldV1,
  FabricCompactionOwnerWithdrawResultV1,
} from "../protocol.js";

// The fields `compact.request` and `compact.carry` accept from an owner. They
// live here, in the lazily loaded claim code, not in the startup graph.
export const COMPACTION_OWNER_REQUEST_FIELDS: readonly FabricCompactionOwnerRequestFieldV1[] =
  ["reason", "instructions", "preserve", "requestedBy", "seed"];
/** Upper bound on one owner handler call; past it Fabric aborts the call's signal and fails the program call. */
export const COMPACTION_OWNER_HANDLER_TIMEOUT_MS = 30_000;
export const COMPACTION_OWNER_CARRY_FIELDS: readonly FabricCompactionOwnerCarryFieldV1[] =
  ["items", "add", "remove", "clear"];

// One extension at a time may claim compaction from Fabric through
// `pi-fabric:compaction-owner:v1` (see protocol.ts). The registry holds only
// the validated copy the protocol reader built; the claimant's own object is
// never stored. The claim lives no longer than the owner asks: withdrawal by
// token, the owner's abort signal, or Fabric's session_shutdown clears it.

export interface ActiveCompactionOwner {
  readonly owner: Readonly<FabricCompactionOwnerIdentityV1>;
  readonly actions: Readonly<FabricCompactionOwnerActionsV1>;
  readonly branchSummary: boolean;
}

export const compactionOwnerLabel = (owner: FabricCompactionOwnerIdentityV1): string =>
  `${owner.name}@${owner.version}`;

export type CompactionFallback = (
  event: SessionBeforeCompactEvent,
  context: ExtensionContext | undefined,
  options: FabricCompactionFallbackOptionsV1 | undefined,
) => { ok: true; compaction: CompactionResult<FabricCompactionDetailsV2> } | { ok: false; reason: string };

export interface CompactionOwnerRegistryOptions {
  /** Shown when a claim is refused because another owner holds it. */
  warn: (message: string) => void;
  /** Fabric's deterministic summary, offered to the holder only. */
  fallback: CompactionFallback;
  /** Called once each time a held claim ends, before Fabric resumes. */
  onRelease?: () => void;
  /** Fabric's current carry-forward items; undefined before Fabric knows the session. */
  carry?: () => readonly string[] | undefined;
}

/**
 * The owner's fallback: Fabric's deterministic summary for the event, with
 * the same budget and enrichers as Fabric's own hook. Owner-supplied carry
 * items must fit the `compact.carry` limits and replace the stored list.
 */
export const deterministicCompactionFallback = (
  targetContextRatio: () => number | undefined,
  enrichers?: readonly CompactionEnricher[],
): CompactionFallback => (event, context, options) => {
  let carryItems: string[] | undefined;
  if (options?.carry !== undefined) {
    const carry: unknown = options.carry;
    if (!Array.isArray(carry) || !carry.every((item) => typeof item === "string")) {
      return { ok: false, reason: "fabric: fallback carry must be an array of strings" };
    }
    try {
      carryItems = applyCarryUpdate([], { items: [...carry as string[]] });
    } catch (error) {
      return { ok: false, reason: `fabric: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const ratio = targetContextRatio();
  const result = compileFabricCompactionForEvent(event, context, ratio, enrichers, carryItems);
  return "cancel" in result
    ? { ok: false, reason: result.reason }
    : { ok: true, compaction: result.compaction };
};

interface HeldClaim {
  token: string;
  claim: ActiveCompactionOwner;
  release: () => void;
}

const NOT_HELD = "fabric: the compaction owner claim is no longer held";

export class CompactionOwnerRegistry {
  #held: HeldClaim | undefined;

  constructor(private readonly options: CompactionOwnerRegistryOptions) {}

  get active(): ActiveCompactionOwner | undefined {
    return this.#held?.claim;
  }

  /** Answers one validated protocol message. */
  handle(message: FabricCompactionOwnerMessageV1): void {
    if (message.type === "withdraw") {
      const result: FabricCompactionOwnerWithdrawResultV1 = this.withdraw(message.token)
        ? { ok: true }
        : { ok: false, error: "Fabric refused the compaction owner withdrawal: the token does not hold the claim" };
      message.reply?.(result);
      return;
    }
    const result = this.claim(message);
    try {
      message.reply(result);
    } catch (error) {
      // The owner never received its token, so it could never withdraw.
      if (result.ok) this.withdraw(result.handle.token);
      throw error;
    }
  }

  claim(message: FabricCompactionOwnerClaimV1): FabricCompactionOwnerClaimResultV1 {
    const owner = { name: message.owner.name, version: message.owner.version };
    const held = this.#held;
    if (held) {
      const error = `Fabric refused the compaction owner claim from ${compactionOwnerLabel(owner)}: ${
        compactionOwnerLabel(held.claim.owner)
      } already owns compaction. Only one extension can own it; the holder must withdraw first.`;
      this.options.warn(error);
      return { ok: false, error, holder: { name: held.claim.owner.name, version: held.claim.owner.version } };
    }
    if (message.signal?.aborted) {
      return { ok: false, error: `Fabric refused the compaction owner claim from ${compactionOwnerLabel(owner)}: its signal is already aborted` };
    }
    // The owner takes over compact.carry; hand it Fabric's list at cut-over.
    const current = this.options.carry?.();
    const carry = current === undefined ? undefined : Object.freeze([...current]);
    const token = randomUUID();
    const signal = message.signal;
    const onAbort = (): void => {
      this.withdraw(token);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#held = {
      token,
      claim: Object.freeze({
        owner: Object.freeze(owner),
        actions: Object.freeze({ ...message.actions }),
        branchSummary: message.branchSummary === true,
      }),
      release: () => signal?.removeEventListener("abort", onAbort),
    };
    return { ok: true, handle: this.#handle(token, owner.name), ...(carry ? { carry } : {}) };
  }

  /** Only the holder's token releases the claim. */
  withdraw(token: string): boolean {
    if (this.#held?.token !== token) return false;
    this.clear();
    return true;
  }

  /** Drops any claim; Fabric's engine is back in charge. */
  clear(): void {
    const held = this.#held;
    this.#held = undefined;
    if (!held) return;
    held.release();
    this.options.onRelease?.();
  }

  #handle(token: string, ownerName: string): FabricCompactionOwnerHandleV1 {
    const holds = (): boolean => this.#held?.token === token;
    return Object.freeze({
      token,
      get active() {
        return holds();
      },
      withdraw: () => this.withdraw(token),
      fallback: (
        event: SessionBeforeCompactEvent,
        context?: ExtensionContext,
        options?: FabricCompactionFallbackOptionsV1,
      ): FabricCompactionFallbackResultV1 => {
        if (!holds()) return { ok: false, reason: NOT_HELD };
        const result = this.options.fallback(event, context, options);
        if (!result.ok) return result;
        // Marks the entry as made for the claim owner, so a provenance check
        // can tell it from Fabric's own engine. Fabric's own entries never
        // carry the field.
        return {
          ok: true,
          compaction: {
            ...result.compaction,
            ...(result.compaction.details
              ? { details: { ...result.compaction.details, claimOwner: ownerName } }
              : {}),
          },
        };
      },
    });
  }
}
