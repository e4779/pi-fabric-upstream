import { describe, expect, it } from "vitest";
import { budgetAdmits } from "../src/verified/budget.js";

describe("compiled binary64 budget admission codec", () => {
  it("preserves adjacent low words, word carries, subnormals, signed zero and large finite observations", () => {
    // These distinguish the trusted float codec, not the proven lexicographic predicate.
    const limits = [Number.MIN_VALUE, 0.1, 0.10000000000000002, 0.9999999999999999, 1, 2 ** 32, Number.MAX_VALUE];
    let previous = 0;
    for (const limit of limits) {
      expect(budgetAdmits(previous, limit)).toBe(true);
      expect(budgetAdmits(limit, limit)).toBe(false);
      expect(budgetAdmits(limit, previous)).toBe(false);
      previous = limit;
    }
    expect(budgetAdmits(-0, Number.MIN_VALUE)).toBe(true);
    expect(budgetAdmits(0, Number.MIN_VALUE)).toBe(true);
    expect(budgetAdmits(-Number.MAX_VALUE, Number.MIN_VALUE)).toBe(true);
    expect(budgetAdmits(0.1 + 0.2, 0.3)).toBe(false);
  });

  it("fails nonfinite observations closed without treating an invalid present budget as unlimited", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(budgetAdmits(invalid, 1)).toBe(false);
      expect(budgetAdmits(0, invalid)).toBe(false);
    }
    expect(budgetAdmits(0, 0)).toBe(false);
    expect(budgetAdmits(-1, -0)).toBe(false);
    expect(budgetAdmits(-1, -2)).toBe(false);
  });
});
