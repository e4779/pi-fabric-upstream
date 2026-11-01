// Speculation's policy decisions and accounting. Promise settlement, keyed
// storage, freshness observations and abort delivery remain host responsibilities.
import { all, bool, fun, nat, oneOf, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type SpeculationBug = "entry cap ignored" | "concurrency equality admitted" | "duplicates admitted" | "ended invocation admitted" | "expiry equality refused" | "epoch ignored" | "freshness ignored" | "failed result served" | "post-settlement expiry wins over abort" | "launch counted as skip" | "expiry not counted" | "epoch not advanced" | "serve counted twice";
const [ADMIT, SKIP, ENDED] = [0, 1, 2];
const [READY, ABSENT, EPOCH, FRESHNESS, FAILED] = [0, 1, 2, 3, 4];

const admission = (bug?: SpeculationBug) => fun("speculation admission")
  .inputs({ ended: bool, duplicate: bool, entries: nat, inFlight: nat, maxEntries: nat, maxConcurrent: nat })
  .returns((e) => ({ plan: when(bug === "ended invocation admitted" ? e.ended.and(e.ended.not()) : e.ended, ENDED, when(
    (bug === "entry cap ignored" ? e.entries.lt(0) : e.entries.atLeast(e.maxEntries)).or(
      bug === "concurrency equality admitted" ? e.inFlight.gt(e.maxConcurrent) : e.inFlight.atLeast(e.maxConcurrent),
      bug === "duplicates admitted" ? e.duplicate.and(e.duplicate.not()) : e.duplicate), SKIP, ADMIT)) }));

const check = (bug?: SpeculationBug) => fun("speculation serve check")
  .inputs({ settled: bool, aborted: bool, now: nat, createdAt: nat, ttl: nat, birthEpoch: nat, epoch: nat, fresh: bool, failed: bool })
  .returns((e) => {
    const elapsed = e.now.minus(e.createdAt);
    const expired = bug === "expiry equality refused" ? elapsed.atLeast(e.ttl) : elapsed.gt(e.ttl);
    const stale = bug === "epoch ignored" ? e.epoch.lt(0) : e.birthEpoch.ne(e.epoch).or(e.settled.and(e.aborted));
    return { outcome: when(e.settled.and(stale, bug === "post-settlement expiry wins over abort" ? expired.not() : e.settled), EPOCH, when(expired, ABSENT, when(stale, EPOCH, when(
      bug === "freshness ignored" ? e.fresh.and(e.fresh.not()) : e.fresh.not(), FRESHNESS, when(
        e.settled.and(bug === "failed result served" ? e.failed.and(e.failed.not()) : e.failed), FAILED, READY))))) };
  });

const accounting = (bug?: SpeculationBug) => rule("speculation accounting")
  .inputs({ event: oneOf("launched", "served", "epochInvalidated", "freshnessInvalidated", "failed", "wasted", "skipped", "bump") })
  .state({ launched: 0, served: 0, epochInvalidated: 0, freshnessInvalidated: 0, failed: 0, wasted: 0, skipped: 0, epoch: 0 })
  .step((e) => ({
    launched: e.launched.plus(when(e.event.is(bug === "launch counted as skip" ? "skipped" : "launched"), 1, 0)),
    served: e.served.plus(when(e.event.is("served"), bug === "serve counted twice" ? 2 : 1, 0)),
    epochInvalidated: e.epochInvalidated.plus(when(e.event.is("epochInvalidated"), 1, 0)),
    freshnessInvalidated: e.freshnessInvalidated.plus(when(e.event.is("freshnessInvalidated"), 1, 0)),
    failed: e.failed.plus(when(e.event.is("failed"), 1, 0)),
    wasted: e.wasted.plus(when(e.event.is("wasted"), bug === "expiry not counted" ? 0 : 1, 0)),
    skipped: e.skipped.plus(when(e.event.is("skipped"), 1, 0)),
    epoch: e.epoch.plus(when(e.event.is("bump"), bug === "epoch not advanced" ? 0 : 1, 0)),
  }));

export const speculationKernels = (bug?: SpeculationBug): Kernel[] => {
  const a = admission(bug), c = check(bug), r = accounting(bug);
  return [
    { id: "speculationAdmission", fun: a, decisions: [
      a.law("speculation_admission_exact: only a new live entry below both caps is admitted", () => [], (o, e) => o.plan.eq(ADMIT).iff(all(e.ended.not(), e.duplicate.not(), e.entries.lt(e.maxEntries), e.inFlight.lt(e.maxConcurrent)))),
      a.law("speculation_ended: ended invocations are refused without counting a skip", () => [], (o, e) => o.plan.eq(ENDED).iff(e.ended)),
      a.law("speculation_skipped: a live duplicate or full store counts a skip", () => [], (o, e) => o.plan.eq(SKIP).iff(e.ended.not().and(e.duplicate.or(e.entries.atLeast(e.maxEntries), e.inFlight.atLeast(e.maxConcurrent))))),
    ] },
    { id: "speculationCheck", fun: c, decisions: [
      c.law("speculation_ready_exact: readiness requires a fresh, unexpired current entry and, after settlement, no abort or failure", () => [], (o, e) => o.outcome.eq(READY).iff(all(e.now.minus(e.createdAt).atMost(e.ttl), e.birthEpoch.eq(e.epoch), e.fresh, e.settled.not().or(e.aborted.not().and(e.failed.not()))))),
      c.law("speculation_expiry_exact: expiry precedes other pre-settlement failures, but not a post-settlement abort or epoch change", () => [], (o, e) => o.outcome.eq(ABSENT).iff(e.now.minus(e.createdAt).gt(e.ttl).and(e.settled.not().or(e.aborted.not().and(e.birthEpoch.eq(e.epoch)))))),
      c.law("speculation_epoch_exact: an epoch change or settled abort wins unless a pre-settlement entry has expired", () => [], (o, e) => o.outcome.eq(EPOCH).iff(e.birthEpoch.ne(e.epoch).or(e.settled.and(e.aborted)).and(e.settled.or(e.now.minus(e.createdAt).atMost(e.ttl))))),
      c.law("speculation_freshness_exact: a current unexpired entry with failed freshness is refused", () => [], (o, e) => o.outcome.eq(FRESHNESS).iff(all(e.now.minus(e.createdAt).atMost(e.ttl), e.birthEpoch.eq(e.epoch), e.settled.not().or(e.aborted.not()), e.fresh.not()))),
      c.law("speculation_failure_exact: provider failure is checked only after settlement, following epoch, expiry and freshness", () => [], (o, e) => o.outcome.eq(FAILED).iff(all(e.settled, e.aborted.not(), e.now.minus(e.createdAt).atMost(e.ttl), e.birthEpoch.eq(e.epoch), e.fresh, e.failed))),
    ] },
    { id: "speculationAccounting", rule: r, stepLaws: [
      r.stepLaw("speculation_launch_count: launch adds exactly one, other events preserve launches", (e, o) => o.launched.eq(e.launched.plus(when(e.event.is("launched"), 1, 0)))),
      r.stepLaw("speculation_serve_count: service adds exactly one, other events preserve services", (e, o) => o.served.eq(e.served.plus(when(e.event.is("served"), 1, 0)))),
      r.stepLaw("speculation_epoch_count: epoch invalidation adds exactly one only for its event", (e, o) => o.epochInvalidated.eq(e.epochInvalidated.plus(when(e.event.is("epochInvalidated"), 1, 0)))),
      r.stepLaw("speculation_freshness_count: freshness invalidation adds exactly one only for its event", (e, o) => o.freshnessInvalidated.eq(e.freshnessInvalidated.plus(when(e.event.is("freshnessInvalidated"), 1, 0)))),
      r.stepLaw("speculation_failure_count: failure adds exactly one only for its event", (e, o) => o.failed.eq(e.failed.plus(when(e.event.is("failed"), 1, 0)))),
      r.stepLaw("speculation_waste_count: discarded work adds exactly one only for its event", (e, o) => o.wasted.eq(e.wasted.plus(when(e.event.is("wasted"), 1, 0)))),
      r.stepLaw("speculation_skip_count: skipped admission adds exactly one only for its event", (e, o) => o.skipped.eq(e.skipped.plus(when(e.event.is("skipped"), 1, 0)))),
      r.stepLaw("speculation_epoch_successor: a bump advances the epoch exactly once and preserves it on every other event", (e, o) => o.epoch.eq(e.epoch.plus(when(e.event.is("bump"), 1, 0)))),
    ] },
  ];
};
export const SPECULATION_BUGS: SpeculationBug[] = ["entry cap ignored", "concurrency equality admitted", "duplicates admitted", "ended invocation admitted", "expiry equality refused", "epoch ignored", "freshness ignored", "failed result served", "post-settlement expiry wins over abort", "launch counted as skip", "expiry not counted", "epoch not advanced", "serve counted twice"];
