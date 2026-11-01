import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  compactionRequestBoundsError,
  encodeCompactionRequest,
  MAX_COMPACTION_INSTRUCTIONS_CHARS,
  MAX_PRESERVE_ITEM_CHARS,
  MAX_PRESERVE_ITEMS,
} from "../compaction/instructions.js";
import {
  applyCarryUpdate,
  COMPACTION_CARRY_ENTRY_TYPE,
  isCarryUpdate,
  latestCarryItems,
  MAX_CARRY_ITEM_CHARS,
  MAX_CARRY_ITEMS,
  sameCarryItems,
  type CompactionCarryEntryData,
  type CompactionCarryUpdate,
} from "../compaction/carry.js";
import {
  COMPACTION_OWNER_CARRY_FIELDS,
  COMPACTION_OWNER_HANDLER_TIMEOUT_MS,
  COMPACTION_OWNER_REQUEST_FIELDS,
  compactionOwnerLabel,
  type ActiveCompactionOwner,
} from "../compaction/claim.js";
import { ownerFromContext } from "../compaction/owner.js";
import { compactionPressure } from "../compaction/pressure.js";
import { DEFAULT_FABRIC_CONFIG, type FabricConfig } from "../config.js";
import {
  checkedSeed,
  CompactController,
  MAX_COMPACTION_SEED_CHARS,
  type CompactPendingIntent,
} from "../core/compact-controller.js";
import {
  type FabricActionDescriptor,
  type FabricCompactionOwnerActionNameV1,
  type FabricCompactionOwnerCallV1,
  type FabricCompactionOwnerCarryUpdateV1,
  type FabricCompactionOwnerPressureV1,
  type FabricCompactionOwnerRequestV1,
  type FabricInvocationContext,
  type FabricProvider,
  type FabricProviderListRequest,
} from "../protocol.js";
import { actionArgNormalizer } from "./arg-normalization.js";

// Fabric provider exposing the host-session compaction controller to
// `fabric_exec`. Compaction is advisory-then-committed: `request` only records
// an intent the host commits at the next `agent_settled` boundary; the model
// cannot compact the running context directly. Always available (no config
// guard) — it is a first-principles primitive, not an optional capability.

const requestSchema = Type.Object({
  reason: Type.Optional(Type.String({
    maxLength: 1024,
    description: "Short human-readable reason for the compaction",
  })),
  instructions: Type.Optional(Type.String({
    maxLength: MAX_COMPACTION_INSTRUCTIONS_CHARS,
    description: "Custom compaction instructions forwarded to Pi core",
  })),
  preserve: Type.Optional(Type.Array(
    Type.String({ maxLength: MAX_PRESERVE_ITEM_CHARS }),
    {
      maxItems: MAX_PRESERVE_ITEMS,
      description: "Explicit bounded facts to preserve, encoded as a typed Fabric compaction request",
    },
  )),
  requestedBy: Type.Optional(Type.String({
    maxLength: 256,
    description: "Who requested the compaction (default: model)",
  })),
  seed: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_COMPACTION_SEED_CHARS,
    description: "Text to start the next phase, queued after the compaction commits as a labelled Fabric message that starts a turn; a prompt submitted during the compaction runs first",
  })),
}, { additionalProperties: false });

interface CompactRequestArguments {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy?: string;
  seed?: string;
}

const checkedRequestArguments = (args: Record<string, unknown>): CompactRequestArguments => {
  if (!Value.Check(requestSchema, args)) {
    const message = [...Value.Errors(requestSchema, args)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Invalid compact.request arguments: ${message}`);
  }
  const input = args as CompactRequestArguments;
  const boundsError = compactionRequestBoundsError({
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.preserve !== undefined ? { preserve: input.preserve } : {}),
  });
  if (boundsError) throw new Error(`Invalid compact.request arguments: ${boundsError.message}`);
  // The same seed check as Fabric's controller, so an owner never receives a
  // seed Fabric itself would refuse.
  try {
    checkedSeed(input.seed);
  } catch (error) {
    throw new Error(`Invalid compact.request arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (input.preserve !== undefined) {
    encodeCompactionRequest({
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      preserve: input.preserve,
    });
  }
  return input;
};

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const carryItemsSchema = (description: string) => Type.Optional(Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_CARRY_ITEM_CHARS }),
  { maxItems: MAX_CARRY_ITEMS, description },
));

const carrySchema = Type.Object({
  items: carryItemsSchema("Replace the carry-forward list"),
  add: carryItemsSchema("Append items not already present"),
  remove: carryItemsSchema("Remove exact items"),
  clear: Type.Optional(Type.Boolean({ description: "Empty the list before applying items/add" })),
}, { additionalProperties: false });

const checkedCarryArguments = (args: Record<string, unknown>): CompactionCarryUpdate => {
  if (!Value.Check(carrySchema, args)) {
    const message = [...Value.Errors(carrySchema, args)]
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Invalid compact.carry arguments: ${message}`);
  }
  return args as CompactionCarryUpdate;
};



const descriptors: FabricActionDescriptor[] = [
  {
    name: "request",
    description:
      "Request an advisory compaction of the host session's context at the next safe boundary (agent_settled). The host commits it only between turns, never mid-turn. A new request replaces any pending one. An optional seed is queued after the compaction commits as a labelled Fabric message that starts a turn. Under a compaction owner claim the request goes to that owner.",
    inputSchema: requestSchema as unknown as Record<string, unknown>,
    risk: "write",
  },
  {
    name: "status",
    description:
      "Read the pending compaction intent, the last compaction outcome, and any compaction owner claim",
    inputSchema: emptySchema,
    risk: "read",
  },
  {
    name: "pressure",
    description:
      "Read host context pressure: tokens, window, fraction, headroom, band (ok/warn/urgent/unknown), output reserve, configured threshold, and the observed compaction owner; under a claim, the owner's stage and thresholds",
    inputSchema: emptySchema,
    risk: "read",
  },
  {
    name: "carry",
    description:
      "Read or update the persistent carry-forward focus list that Fabric's compactor renders in every summary until cleared. No arguments reads it. Under a compaction owner claim the list belongs to that owner.",
    inputSchema: carrySchema as unknown as Record<string, unknown>,
    // A persisted session entry that changes every later summary: a control
    // write, classified like request.
    risk: "write",
  },
  {
    name: "cancel",
    description: "Clear a pending compaction intent before the host commits it",
    inputSchema: emptySchema,
    // Cancel mutates the compaction controller; it is not a read. The "read"
    // label predates effect tracking and would have let speculative PTC
    // pre-fire a control action that may never execute in the real program.
    risk: "write",
  },
];

// Argument repair derives from the action schemas plus the shared synonym
// lexicon; no compact-specific table remains.
export const normalizeCompactArgs = actionArgNormalizer(() => descriptors);

type CompactionConfig = FabricConfig["compaction"];

export interface CompactProviderOptions {
  /** Live compaction config (bands, output reserve, thresholds). */
  config?: () => CompactionConfig;
  /** Session custom-entry writer (`pi.appendEntry`); required for carry updates. */
  appendEntry?: (customType: string, data: CompactionCarryEntryData) => void;
  /** The extension holding the compaction owner claim, if any. */
  owner?: () => ActiveCompactionOwner | undefined;
}

// Owner handler results cross into program results: JSON only, bounded.
const MAX_OWNER_RESULT_BYTES = 16 * 1024;
const MAX_OWNER_THRESHOLDS = 16;
// Names an object copy would drop or treat as prototype machinery; refused
// so a threshold never silently disappears.
const RESERVED_THRESHOLD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const ownerRef = (claim: ActiveCompactionOwner): { name: string; version: string } => ({
  name: claim.owner.name,
  version: claim.owner.version,
});

const ownerError = (claim: ActiveCompactionOwner, message: string): Error =>
  new Error(`compaction owner ${compactionOwnerLabel(claim.owner)}: ${message}`);

const ownerJson = (claim: ActiveCompactionOwner, action: string, value: unknown): unknown => {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw ownerError(claim, `compact.${action} returned a value that is not JSON`);
  }
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") > MAX_OWNER_RESULT_BYTES) {
    throw ownerError(claim, `compact.${action} returned more than ${MAX_OWNER_RESULT_BYTES} bytes`);
  }
  return JSON.parse(text) as unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ownerPressure = (claim: ActiveCompactionOwner, value: unknown): FabricCompactionOwnerPressureV1 => {
  const invalid = () => ownerError(claim, "compact.pressure must return { stage, thresholds? }");
  if (!isRecord(value) || typeof value.stage !== "string" || value.stage.length === 0 || value.stage.length > 64) {
    throw invalid();
  }
  if (value.thresholds === undefined) return { stage: value.stage };
  if (!isRecord(value.thresholds)) throw invalid();
  const entries = Object.entries(value.thresholds);
  if (entries.length > MAX_OWNER_THRESHOLDS) throw invalid();
  const thresholds: Record<string, number> = {};
  for (const [name, threshold] of entries) {
    if (RESERVED_THRESHOLD_NAMES.has(name)) {
      throw ownerError(claim, `compact.pressure threshold name "${name}" is reserved`);
    }
    if (name.length === 0 || name.length > 64 || typeof threshold !== "number" || !Number.isFinite(threshold)) {
      throw invalid();
    }
    thresholds[name] = threshold;
  }
  return { stage: value.stage, thresholds };
};

const ownerCarryItems = (claim: ActiveCompactionOwner, value: unknown): string[] => {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every((item) => typeof item === "string")) {
    throw ownerError(claim, "compact.carry must return { items: string[] }");
  }
  return [...value.items as string[]];
};

const branchOf = (context: FabricInvocationContext) => {
  try {
    const branch = context.extensionContext?.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : undefined;
  } catch {
    return undefined;
  }
};

export class CompactProvider implements FabricProvider {
  readonly name = "compact";
  readonly description =
    "Programmatic, advisory-then-committed context compaction for the host Pi session";

  constructor(
    readonly controller: CompactController,
    private readonly options: CompactProviderOptions = {},
  ) {}

  #config(): CompactionConfig {
    return this.options.config?.() ?? DEFAULT_FABRIC_CONFIG.compaction;
  }

  #carry(update: CompactionCarryUpdate, context: FabricInvocationContext): { items: string[] } {
    const branch = branchOf(context);
    const current = branch ? latestCarryItems(branch) : [];
    if (!isCarryUpdate(update)) return { items: current };
    if (!branch || !this.options.appendEntry) {
      throw new Error("compact.carry cannot persist: no host session is available");
    }
    const items = applyCarryUpdate(current, update);
    if (!sameCarryItems(current, items)) {
      this.options.appendEntry(COMPACTION_CARRY_ENTRY_TYPE, { version: 1, items });
      context.activity?.({
        type: "progress",
        message: items.length > 0
          ? `Compaction carry-forward: ${items.length} item${items.length === 1 ? "" : "s"}`
          : "Compaction carry-forward cleared",
      });
    }
    return { items };
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return normalizeCompactArgs(actionName, args);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const claim = this.options.owner?.();
    if (claim) return this.#invokeOwner(claim, actionName, args, context);
    switch (actionName) {
      case "request": {
        const input = checkedRequestArguments(args);
        const intent = this.controller.request({
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.preserve !== undefined ? { preserve: input.preserve } : {}),
          ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        });
        context.activity?.({
          type: "entity",
          id: "host-compact",
          kind: "custom",
          name: "Context compaction",
        });
        context.activity?.({
          type: "progress",
          message: intent.reason
            ? `Compaction requested: ${intent.reason}`
            : "Compaction requested (advisory; commits at next agent_settled)",
        });
        return { requested: true, intent };
      }
      case "status":
        return {
          ...this.controller.status(),
          owner: ownerFromContext(context.extensionContext),
          outputReserveTokens: this.#config().outputReserveTokens,
        };
      case "pressure":
        return compactionPressure(context.extensionContext, this.#config());
      case "carry":
        return this.#carry(checkedCarryArguments(args), context);
      case "cancel":
        this.controller.cancel();
        context.activity?.({ type: "progress", message: "Compaction request cancelled" });
        return { cancelled: true };
      default:
        throw new Error(`Unknown compact action: ${actionName}`);
    }
  }

  // Under a claim Fabric validates the call exactly as before, then hands the
  // owner a copy holding only fields it declared. An undeclared action or
  // field fails before anything is recorded, stored, or forwarded.
  async #invokeOwner(
    claim: ActiveCompactionOwner,
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const owner = ownerRef(claim);
    const hostContext = context.extensionContext;
    // Each handler call gets its own signal. It aborts when the program call
    // is cancelled or the handler outlives the timeout, and the program call
    // then fails at once instead of waiting for the owner.
    const call = async <T>(
      action: FabricCompactionOwnerActionNameV1,
      run: (ownerCall: FabricCompactionOwnerCallV1) => T,
    ): Promise<Awaited<T>> => {
      const programSignal = context.signal;
      if (programSignal?.aborted) {
        throw ownerError(claim, `compact.${action} was not called: the calling program was cancelled`);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onProgramAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        const stop = (why: string): void => {
          const error = ownerError(claim, `compact.${action} ${why}`);
          controller.abort(error);
          reject(error);
        };
        timer = setTimeout(
          () => stop(`did not finish within ${COMPACTION_OWNER_HANDLER_TIMEOUT_MS / 1000} s`),
          COMPACTION_OWNER_HANDLER_TIMEOUT_MS,
        );
        onProgramAbort = () => stop("was cancelled by the calling program");
        programSignal?.addEventListener("abort", onProgramAbort, { once: true });
      });
      const handled = (async () => {
        try {
          return await run({ context: hostContext, signal: controller.signal });
        } catch (error) {
          throw ownerError(claim, `compact.${action} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      try {
        return await Promise.race([handled, stopped]);
      } finally {
        clearTimeout(timer);
        if (onProgramAbort) programSignal?.removeEventListener("abort", onProgramAbort);
      }
    };
    const unsupported = (action: string, field?: string): Error => ownerError(
      claim,
      field === undefined
        ? `does not support compact.${action}; nothing was recorded`
        : `does not support the compact.${action} field "${field}"; nothing was recorded`,
    );
    switch (actionName) {
      case "request": {
        const input = checkedRequestArguments(args);
        const action = claim.actions.request;
        if (!action) throw unsupported("request");
        const request: FabricCompactionOwnerRequestV1 = {};
        for (const field of COMPACTION_OWNER_REQUEST_FIELDS) {
          const value = input[field];
          if (value === undefined) continue;
          if (!action.fields.includes(field)) throw unsupported("request", field);
          if (field === "preserve") request.preserve = [...value as string[]];
          else request[field] = value as string;
        }
        const result = ownerJson(claim, "request", await call("request", (ownerCall) => action.handler(request, ownerCall)));
        context.activity?.({
          type: "progress",
          message: `Compaction requested from owner ${compactionOwnerLabel(owner)}`,
        });
        // The same intent shape Fabric's own path returns, describing what
        // went to the owner. Fabric records none of it.
        const intent: CompactPendingIntent = {
          requestedBy: request.requestedBy || "model",
          requestedAt: Date.now(),
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.instructions ? { instructions: request.instructions } : {}),
          ...(request.preserve ? { preserve: [...request.preserve] } : {}),
          ...(request.seed ? { seed: request.seed } : {}),
        };
        return { requested: true, intent, claim: owner, ...(result !== undefined ? { result } : {}) };
      }
      case "status": {
        const status = {
          ...this.controller.status(),
          owner: ownerFromContext(hostContext),
          outputReserveTokens: this.#config().outputReserveTokens,
          claim: {
            ...owner,
            branchSummary: claim.branchSummary,
            actions: (Object.keys(claim.actions) as FabricCompactionOwnerActionNameV1[]).sort(),
          },
        };
        const action = claim.actions.status;
        if (!action) return status;
        const ownerStatus = ownerJson(claim, "status", await call("status", (ownerCall) => action.handler(ownerCall)));
        return { ...status, ...(ownerStatus !== undefined ? { ownerStatus } : {}) };
      }
      case "pressure": {
        // Fabric's own thresholds are inactive under a claim, so they are not
        // reported as if they would trigger.
        const {
          thresholdFraction: _fraction,
          thresholdTokens: _tokens,
          ...pressure
        } = compactionPressure(hostContext, this.#config());
        const action = claim.actions.pressure;
        if (!action) return { ...pressure, claim: owner };
        const reported = ownerPressure(claim, ownerJson(claim, "pressure", await call("pressure", (ownerCall) => action.handler(ownerCall))));
        return { ...pressure, claim: owner, ownerPressure: reported };
      }
      case "carry": {
        const input = checkedCarryArguments(args);
        const action = claim.actions.carry;
        if (!action) throw unsupported("carry");
        const update: FabricCompactionOwnerCarryUpdateV1 = {};
        for (const field of COMPACTION_OWNER_CARRY_FIELDS) {
          const value = input[field];
          if (value === undefined) continue;
          if (!action.fields.includes(field)) throw unsupported("carry", field);
          if (field === "clear") update.clear = value as boolean;
          else update[field] = [...value as string[]];
        }
        const items = ownerCarryItems(claim, ownerJson(claim, "carry", await call("carry", (ownerCall) => action.handler(update, ownerCall))));
        return { items, claim: owner };
      }
      case "cancel": {
        // An intent Fabric recorded before the claim would still commit
        // through the owner at the next boundary, with Fabric-encoded
        // instructions and Fabric's seed. Clear it first, owner or not.
        const fabricIntentCleared = this.controller.status().pending !== undefined;
        this.controller.cancel();
        const action = claim.actions.cancel;
        if (!action) {
          if (!fabricIntentCleared) {
            throw ownerError(claim, "does not support compact.cancel, and Fabric had no pending compaction request; nothing was cancelled");
          }
          context.activity?.({ type: "progress", message: "Fabric's pending compaction request cancelled" });
          return { cancelled: true, claim: owner, fabricIntentCleared, ownerCancelled: false };
        }
        let result: unknown;
        try {
          result = ownerJson(claim, "cancel", await call("cancel", (ownerCall) => action.handler(ownerCall)));
        } catch (error) {
          if (!fabricIntentCleared) throw error;
          throw new Error(`${error instanceof Error ? error.message : String(error)}; Fabric's own pending compaction request was cleared`);
        }
        context.activity?.({ type: "progress", message: `Compaction request cancelled by owner ${compactionOwnerLabel(owner)}` });
        return {
          cancelled: true,
          claim: owner,
          fabricIntentCleared,
          ownerCancelled: true,
          ...(result !== undefined ? { result } : {}),
        };
      }
      default:
        throw new Error(`Unknown compact action: ${actionName}`);
    }
  }
}
