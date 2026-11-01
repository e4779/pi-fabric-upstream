import { bit, Interner } from "./machine.js";
import { meshGrantTake } from "./generated/grants.js";

export interface CapturedMeshGrant { readonly expiresAt: number; readonly uses: number; readonly topic: string; readonly kind?: string }
const PLANS = ["Invalid", "Expired", "Exhausted", "Topic", "Kind", "Consume"] as const;
const integer = (value: number) => Number.isSafeInteger(value);

/** Trusted codec: complete identities share one table; no hash or prefix is used.
 * Authentication is a host observation. Only the compiled plan authorizes use. */
export const takeMeshGrant = (
  grant: CapturedMeshGrant | undefined,
  request: { authenticated: boolean; now: number; topic?: string; kind?: string },
): { plan: typeof PLANS[number]; uses: number; topic: string; kind: string } => {
  if (!integer(request.now) || request.now < 0 || (grant && ![grant.expiresAt, grant.uses].every(integer))) {
    throw new RangeError("Invalid mesh grant numeric state");
  }
  const names = new Interner();
  const out = meshGrantTake.step({}, meshGrantTake.init({}), {
    authenticated: bit(grant !== undefined && request.authenticated), now: request.now,
    // Legacy negative deadlines are expired and negative counts exhausted.
    // At a nonnegative clock, clamping preserves both refusal classifications.
    expiresAt: Math.max(0, grant?.expiresAt ?? 0), uses: Math.max(0, grant?.uses ?? 0),
    topic: names.id(grant?.topic ?? ""), requestedTopic: names.id(request.topic ?? ""), hasTopic: bit(request.topic !== undefined),
    kind: names.id(grant?.kind ?? ""), hasKind: bit(grant?.kind !== undefined),
    requestedKind: names.id(request.kind ?? ""), hasRequestedKind: bit(request.kind !== undefined), externalKind: names.id("external"),
  }).scalars;
  const plan = PLANS[out["out.plan"]!];
  if (plan === undefined) throw new Error("Invalid compiled mesh grant plan");
  return { plan, uses: plan === "Consume" ? out["out.uses"]! : grant?.uses ?? 0, topic: names.name(out["out.topic"]!), kind: names.name(out["out.kind"]!) };
};
