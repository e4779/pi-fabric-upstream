import { VERIFIED_NAT_MAX } from "./nat.js";
import type { Machine } from "./machine.js";
import {
  transitionCurrent as transitionMachine, cleanupState as cleanupMachine, unknownConflict as unknownMachine,
  knownConflict as knownMachine, lineageSelected as lineageMachine, pointerCurrent as pointerMachine,
  coverageComplete as coverageMachine, useNormalized as normalizedMachine, headReadable as headMachine,
  certificateAccepted as certificateMachine, consume as consumeMachine, summaryWithin as summaryMachine,
  sampleWithin as sampleMachine, chunkAccepted as chunkMachine,
} from "./generated/policy.js";
import { compactionCut } from "./generated/compaction.js";

// Kept local rather than shared with ./machine.js: these decisions sit in the
// startup graph, and the stateful kernels' codecs load at first use.
const bit = (value: boolean): number => (value ? 1 : 0);
const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const call = (machine: Machine, input: object): Record<string, number> => machine.step({}, machine.init({}), input).scalars;
const yes = (value: number | undefined): boolean => value === 1;

export const transitionCurrent = (retired: boolean, sameEpoch: boolean, sameOwner: boolean, closed: boolean): boolean =>
  yes(call(transitionMachine, { retired: bit(retired), sameEpoch: bit(sameEpoch), sameOwner: bit(sameOwner), closed: bit(closed) })["out.ok"]);

/** 0 disposed, 1 diverted, 2 quarantined. */
export const cleanupState = (failed: boolean, diverted: boolean): number =>
  call(cleanupMachine, { failed: bit(failed), diverted: bit(diverted) })["out.state"]!;

export const unknownConflict = (lu: boolean, luo: boolean, lo: boolean, ru: boolean, ruo: boolean, ro: boolean): boolean =>
  yes(call(unknownMachine, { lu: bit(lu), luo: bit(luo), lo: bit(lo), ru: bit(ru), ruo: bit(ruo), ro: bit(ro) })["out.conflict"]);

export const knownConflict = (shared: boolean, leftOrdered: boolean, rightOrdered: boolean): boolean =>
  yes(call(knownMachine, { shared: bit(shared), leftOrdered: bit(leftOrdered), rightOrdered: bit(rightOrdered) })["out.conflict"]);

export const lineageSelected = (allBranches: boolean, member: boolean): boolean =>
  yes(call(lineageMachine, { allBranches: bit(allBranches), member: bit(member) })["out.selected"]);

export const pointerCurrent = (source: boolean, lineage: boolean): boolean =>
  yes(call(pointerMachine, { source: bit(source), lineage: bit(lineage) })["out.current"]);

export const coverageComplete = (sourceComplete: boolean, truncated: boolean): boolean =>
  yes(call(coverageMachine, { sourceComplete: bit(sourceComplete), truncated: bit(truncated) })["out.complete"]);

export const useNormalized = (canonical: boolean, plan: boolean, changed: boolean, accepted: boolean): boolean =>
  yes(call(normalizedMachine, { canonical: bit(canonical), plan: bit(plan), changed: bit(changed), accepted: bit(accepted) })["out.use"]);

export const headReadable = (sequence: boolean, version: boolean, committed: boolean, pending: boolean, marker: boolean): boolean =>
  yes(call(headMachine, { sequence: bit(sequence), version: bit(version), committed: bit(committed), pending: bit(pending), marker: bit(marker) })["out.readable"]);

/** One-use consumption: whether this use releases the token, and whether it stays active. */
export const consume = (active: boolean): { released: boolean; active: boolean } => {
  const out = call(consumeMachine, { active: bit(active) });
  return { released: yes(out["out.released"]), active: yes(out["out.active"]) };
};

export const acceptSummaryBounds = (bytes: number, byteLimit: number, projected: number, target: number): boolean =>
  [bytes, byteLimit, projected, target].every(isNatural) &&
  yes(call(summaryMachine, { bytes, byteLimit, projected, target })["out.within"]);

export const acceptSampleAccounting = (total: number, retained: number, omitted: number, limit: number): boolean =>
  [total, retained, omitted, limit].every(isNatural) && retained + omitted <= VERIFIED_NAT_MAX &&
  yes(call(sampleMachine, { total, retained, omitted, limit })["out.within"]);

export interface CutSpan {
  first: number;
  last: number;
  hasCall: boolean;
  hasResult: boolean;
}

export interface CutCandidate {
  eligible: boolean;
  afterPrevious: boolean;
  retained: number;
  budget: number;
  boundary: number;
}

const OPEN = 1;
/** The producer may reject cheaply, but cannot publish a cut without this check.
 * The compiled cut machine folds the header and then every source span. */
export const acceptCompactionCut = (candidate: CutCandidate, spans: Iterable<CutSpan>): boolean => {
  if (![candidate.retained, candidate.budget, candidate.boundary].every(isNatural) ||
      typeof candidate.eligible !== "boolean" || typeof candidate.afterPrevious !== "boolean") return false;
  const params = {
    eligible: bit(candidate.eligible), afterPrevious: bit(candidate.afterPrevious),
    retained: candidate.retained, budget: candidate.budget, boundary: candidate.boundary,
  };
  let state = compactionCut.step(params, compactionCut.init(params), { op: 0, first: 0, last: 0, paired: 0 });
  if (state.scalars.phase !== OPEN) return false;
  for (const span of spans) {
    if (!isNatural(span.first) || !isNatural(span.last) || span.first > span.last ||
        typeof span.hasCall !== "boolean" || typeof span.hasResult !== "boolean") return false;
    state = compactionCut.step(params, state, { op: 1, first: span.first, last: span.last, paired: bit(span.hasCall && span.hasResult) });
    if (state.scalars.phase !== OPEN) return false;
  }
  return true;
};

export interface TextRange { start: number; end: number; total: number; complete: boolean }
export const acceptMemoryChunk = (
  range: TextRange, length: number, expectedStart: number, expectedTotal: number,
): boolean => {
  if (![range.start, range.end, range.total, length, expectedStart, expectedTotal].every(isNatural) ||
      range.start + length > VERIFIED_NAT_MAX || typeof range.complete !== "boolean") return false;
  return yes(call(chunkMachine, {
    start: range.start, end: range.end, total: range.total, expectedStart, expectedTotal,
    length, complete: bit(range.complete),
  })["out.accepted"]);
};

/** A fixed ordered tuple prevents a missing check from becoming an empty,
 * vacuously accepted certificate. Messages are diagnostics, never authority. */
export const assertCertificateFacts = (
  facts: readonly [CertificateFact, CertificateFact, CertificateFact, CertificateFact, CertificateFact, CertificateFact, CertificateFact, CertificateFact],
): void => {
  if (facts.length !== 8 || facts.some((fact) => typeof fact.valid !== "boolean")) {
    throw new Error("Invalid Schema certificate evidence");
  }
  const input = Object.fromEntries(facts.map((fact, index) => [`f${index}`, bit(fact.valid)]));
  if (!yes(call(certificateMachine, input)["out.accepted"])) {
    throw new Error(facts.find((fact) => !fact.valid)?.error ?? "Schema certificate rejected");
  }
};
interface CertificateFact { valid: boolean; error: string }
