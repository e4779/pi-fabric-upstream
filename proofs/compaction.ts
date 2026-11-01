// A compaction cut is checked as a fold: one header step, then one step per
// call/result span. The production check feeds every span to this machine.
import { all, bool, nat, oneOf, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type CutBug = "a span may straddle the boundary" | "spans may precede the header" | "refusal can recover" | "budget is not checked";

/** Phases: 0 unstarted, 1 open, 2 refused. */
export const START = 0, OPEN = 1, REFUSED = 2;
export const cut = (bug?: CutBug) => rule("compaction cut")
  .params({ eligible: bool, afterPrevious: bool, retained: nat, budget: nat, boundary: nat })
  .inputs({ op: oneOf("header", "span"), first: nat, last: nat, paired: bool })
  .state({ phase: START })
  .flags(({ eligible, afterPrevious, retained, budget, boundary, first, last, paired }) => ({
    header: all(eligible, afterPrevious, bug === "budget is not checked" ? eligible : retained.atMost(budget)),
    safe: bug === "a span may straddle the boundary" ? paired.or(paired.not()) : paired.not().or(boundary.atMost(first), last.lt(boundary)),
  }))
  .step(({ op, phase, header, safe }) => ({
    phase: op.match({
      header: () => when(phase.eq(START).and(header), OPEN, bug === "refusal can recover" ? OPEN : REFUSED),
      span: () => when((bug === "spans may precede the header" ? phase.ne(REFUSED) : phase.eq(OPEN)).and(safe), OPEN, REFUSED),
    }),
  }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spanAllowed = (e: any) =>
  e.paired.not().or(e.boundary.atMost(e.first), e.last.lt(e.boundary));

export const compactionKernels = (bug?: CutBug): Kernel[] => {
  const r = cut(bug);
  return [{
    id: "compactionCut",
    rule: r,
    laws: [
      r.law("cut_sound: an open cut is eligible, after the previous marker, and within its tail budget",
        ({ phase, eligible, afterPrevious, retained, budget }) => phase.eq(OPEN).implies(all(eligible, afterPrevious, retained.atMost(budget)))),
    ],
    stepLaws: [
      r.stepLaw("span_sound: a span keeps the cut open only if it was open and the span does not straddle the boundary",
        (e, after) => after.phase.eq(OPEN).implies(e.phase.eq(OPEN).and(spanAllowed(e))), ({ op }) => op.is("span")),
      r.stepLaw("refusal_final: a refused cut stays refused", ({ phase }, after) => phase.eq(REFUSED).implies(after.phase.eq(REFUSED))),
      r.stepLaw("header_once: a header opens only an unstarted cut", ({ phase }, after) => after.phase.eq(OPEN).implies(phase.eq(START)), ({ op }) => op.is("header")),
      r.stepLaw("cut_complete: a valid header opens a fresh cut, and an allowed span keeps it open",
        (e, after) => e.op.match({
          header: () => e.phase.eq(START).and(e.eligible, e.afterPrevious, e.retained.atMost(e.budget)).implies(after.phase.eq(OPEN)),
          span: () => e.phase.eq(OPEN).and(spanAllowed(e)).implies(after.phase.eq(OPEN)),
        })),
    ],
  }];
};
export const CUT_BUGS: CutBug[] = ["a span may straddle the boundary", "spans may precede the header", "refusal can recover", "budget is not checked"];
