import { budgetAdmission } from "./generated/budget.js";

/** Trusted order codec for complete binary64 observations, without decimal
 * rounding. Flip the sign bit for nonnegative values, complement negative
 * values, and normalize signed zero: lexicographic words then match JS order. */
const orderedWords = (value: number): readonly [number, number] => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value);
  const high = view.getUint32(0), low = view.getUint32(4);
  return (high & 0x80000000) !== 0 ? [~high >>> 0, ~low >>> 0] : [(high ^ 0x80000000) >>> 0, low];
};

/** Admission threshold only: incurred child costs are recorded after settlement.
 * Concurrent admitted children may overshoot. Nonfinite observations fail closed. */
export const budgetAdmits = (spent: number, limit: number): boolean => {
  const valid = Number.isFinite(spent) && Number.isFinite(limit) && limit > 0;
  const [spentHigh, spentLow] = orderedWords(valid ? spent : 0);
  const [limitHigh, limitLow] = orderedWords(valid ? limit : 0);
  return budgetAdmission.step({}, budgetAdmission.init({}), { valid: valid ? 1 : 0, spentHigh, spentLow, limitHigh, limitLow }).scalars["out.admitted"] === 1;
};
