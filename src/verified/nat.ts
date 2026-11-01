// The compiled gdp-wired runtime refuses any natural past 2^53 - 1, where the
// proofs over the naturals stop describing the run. Counters fail closed first.
export const VERIFIED_NAT_MAX = Number.MAX_SAFE_INTEGER;
