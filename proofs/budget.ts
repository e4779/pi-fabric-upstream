// The budget is an admission threshold, not a reservation or a spending cap.
// The codec orders complete IEEE-754 values without rounding to microdollars.
import { all, bool, fun, nat } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type BudgetBug = "equal spend admitted" | "low word ignored" | "invalid budget admitted" | "below threshold denied";
const admission = (bug?: BudgetBug) => fun("budget admission")
  .inputs({ valid: bool, spentHigh: nat, spentLow: nat, limitHigh: nat, limitLow: nat })
  .returns(({ valid, spentHigh, spentLow, limitHigh, limitLow }) => ({
    admitted: (bug === "invalid budget admitted" ? valid.or(valid.not()) : valid).and(
      bug === "below threshold denied" ? spentHigh.lt(0) : spentHigh.lt(limitHigh).or(spentHigh.eq(limitHigh).and(
        bug === "low word ignored" ? spentLow.eq(spentLow) : bug === "equal spend admitted" ? spentLow.atMost(limitLow) : spentLow.lt(limitLow))),
    ),
  }));
export const budgetKernels = (bug?: BudgetBug): Kernel[] => {
  const f = admission(bug);
  return [{ id: "budgetAdmission", fun: f, decisions: [
    f.law("budget_safe: admission has valid observations strictly below the ordered threshold", () => [], (o, e) => o.admitted.implies(all(e.valid, e.spentHigh.atMost(e.limitHigh), e.spentHigh.eq(e.limitHigh).implies(e.spentLow.lt(e.limitLow))))),
    f.law("budget_complete: valid observations below the threshold are admitted", (e) => [e.valid, e.spentHigh.lt(e.limitHigh).or(e.spentHigh.eq(e.limitHigh).and(e.spentLow.lt(e.limitLow)))], (o) => o.admitted),
    f.law("budget_exhausted: equality and larger observations are refused", (e) => e.spentHigh.gt(e.limitHigh).or(e.spentHigh.eq(e.limitHigh).and(e.spentLow.atLeast(e.limitLow))), (o) => o.admitted.not()),
    f.law("budget_invalid: invalid observations are never admitted", ({ valid }) => valid.not(), (o) => o.admitted.not()),
  ] }];
};
export const BUDGET_BUGS: BudgetBug[] = ["equal spend admitted", "low word ignored", "invalid budget admitted", "below threshold denied"];
