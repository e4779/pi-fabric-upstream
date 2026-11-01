import { bit } from "./machine.js";
import { speculationAdmission, speculationCheck, speculationAccounting } from "./generated/speculation.js";
import type { FabricSpeculationStats } from "../speculation/types.js";

const natural = (value: number) => Number.isSafeInteger(value) && value >= 0;
const requireNaturals = (values: number[]) => { if (!values.every(natural)) throw new RangeError("Invalid speculation numeric state"); };
const PLANS = ["admit", "skip", "ended"] as const;
const OUTCOMES = ["ready", "absent", "epoch", "freshness", "failed"] as const;
const EVENTS = ["launched", "served", "epochInvalidated", "freshnessInvalidated", "failed", "wasted", "skipped", "bump"] as const;
export type SpeculationEvent = typeof EVENTS[number];

export const admitSpeculation = (input: { ended: boolean; duplicate: boolean; entries: number; inFlight: number; maxEntries: number; maxConcurrent: number }): typeof PLANS[number] => {
  requireNaturals([input.entries, input.inFlight, input.maxEntries, input.maxConcurrent]);
  const out = speculationAdmission.step({}, speculationAdmission.init({}), { ...input, ended: bit(input.ended), duplicate: bit(input.duplicate) }).scalars;
  const plan = PLANS[out["out.plan"]!];
  if (plan === undefined) throw new Error("Invalid compiled speculation admission");
  return plan;
};

export interface SpeculationObservation { settled: boolean; aborted: boolean; now: number; createdAt: number; ttl: number; birthEpoch: number; epoch: number; fresh: boolean; failed: boolean }
export const checkSpeculation = (input: SpeculationObservation): typeof OUTCOMES[number] => {
  requireNaturals([input.now, input.createdAt, input.ttl, input.birthEpoch, input.epoch]);
  const out = speculationCheck.step({}, speculationCheck.init({}), { ...input, settled: bit(input.settled), aborted: bit(input.aborted), fresh: bit(input.fresh), failed: bit(input.failed) }).scalars;
  const outcome = OUTCOMES[out["out.outcome"]!];
  if (outcome === undefined) throw new Error("Invalid compiled speculation outcome");
  return outcome;
};

/** Expiry-only sweep uses the same compiled TTL predicate, without callbacks. */
export const speculationExpired = (now: number, createdAt: number, ttl: number): boolean =>
  checkSpeculation({ settled: false, aborted: false, now, createdAt, ttl, birthEpoch: 0, epoch: 0, fresh: true, failed: false }) === "absent";

/** The store owns this compiled state. No mutable statistics escape. */
export class SpeculationAccounting {
  #state = speculationAccounting.init({});
  get epoch(): number { return this.#state.scalars.epoch!; }
  record(event: SpeculationEvent): void { this.#state = speculationAccounting.step({}, this.#state, { event: EVENTS.indexOf(event) }); }
  stats(): FabricSpeculationStats {
    const s = this.#state.scalars;
    return { launched: s.launched!, served: s.served!, epochInvalidated: s.epochInvalidated!, freshnessInvalidated: s.freshnessInvalidated!, failed: s.failed!, wasted: s.wasted!, skipped: s.skipped! };
  }
}
