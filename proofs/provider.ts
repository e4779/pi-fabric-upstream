// Universal provider dispatch: a one-use ticket that plans a compare-and-swap
// write. Keys, revisions and payloads are interned names, compared by identity.
// The state is the ticket; step laws carry no invariant, so they hold for every ticket.
import { all, bool, nat, oneOf, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export const PLANS = ["Denied", "Write"] as const;
const [DENIED, WRITE] = [0, 1];

export type ProviderBug = "revocation keeps the ticket live" | "take ignores the key" | "stale revisions pass" | "cancellation is ignored" | "payload is swapped";

export const provider = (bug?: ProviderBug) => rule("provider ticket")
  .inputs({ op: oneOf("take", "revoke"), key: nat, observed: nat, stopped: bool })
  .state({ active: 1, grantKey: 0, expected: 0, payload: 0, plan: DENIED, planKey: 0, planExpected: 0, planValue: 0 })
  .flags(({ op, key, observed, stopped, active, grantKey, expected }) => ({
    allowed: op.is("take").and(active.eq(1), bug === "cancellation is ignored" ? active.eq(1) : stopped.not(),
      bug === "take ignores the key" ? active.eq(1) : grantKey.eq(key), bug === "stale revisions pass" ? active.eq(1) : expected.eq(observed)),
  }))
  .step(({ op, key, active, expected, payload, allowed }) => ({
    active: bug === "revocation keeps the ticket live" ? when(op.is("take"), 0, active) : 0,
    plan: when(allowed, WRITE, DENIED),
    planKey: when(allowed, key, 0),
    planExpected: when(allowed, expected, 0),
    planValue: when(allowed, bug === "payload is swapped" ? expected : payload, 0),
  }));

export const providerKernels = (bug?: ProviderBug): Kernel[] => {
  const r = provider(bug);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // The ticket after the step keeps its grant key, revision and payload, and is no longer live.
  const consumed = (b: any, a: any) => all(a.active.eq(0), a.grantKey.eq(b.grantKey), a.expected.eq(b.expected), a.payload.eq(b.payload));
  return [{
    id: "providerTicket",
    rule: r,
    stepLaws: [
      r.stepLaw("provider_plan_safe: a planned write had a live grant for this key, no cancellation and the expected revision, and forwards them exactly",
        (b, a) => a.plan.eq(WRITE).implies(all(b.active.eq(1), b.stopped.not(), b.grantKey.eq(b.key), b.expected.eq(b.observed),
          a.planKey.eq(b.key), a.planExpected.eq(b.expected), a.planValue.eq(b.payload))), ({ op }) => op.is("take")),
      r.stepLaw("provider_ticket_consumed: taking consumes the ticket and keeps its contents", (b, a) => consumed(b, a), ({ op }) => op.is("take")),
      r.stepLaw("provider_revocation_consumes: revoking consumes the ticket and plans nothing", (b, a) => consumed(b, a).and(a.plan.eq(DENIED)), ({ op }) => op.is("revoke")),
      r.stepLaw("provider_revoked_refused: a consumed ticket plans nothing", (b, a) => b.active.eq(0).implies(a.plan.eq(DENIED)), ({ op }) => op.is("take")),
      r.stepLaw("provider_canceled_refused: a canceled take plans nothing", (_, a) => a.plan.eq(DENIED), ({ op, stopped }) => op.is("take").and(stopped)),
      r.stepLaw("state_stale_refused: a revision other than the expected one plans nothing", (_, a) => a.plan.eq(DENIED), ({ op, expected, observed }) => op.is("take").and(expected.ne(observed))),
      r.stepLaw("provider_admission_complete: a live ticket taken for its key at its revision plans exactly its write",
        (b, a) => all(a.plan.eq(WRITE), a.planKey.eq(b.key), a.planExpected.eq(b.expected), a.planValue.eq(b.payload)),
        ({ op, active, stopped, grantKey, key, expected, observed }) => op.is("take").and(active.eq(1), stopped.not(), grantKey.eq(key), expected.eq(observed))),
      r.stepsLaw("provider_replay_refused: a second take of the same ticket plans nothing", 2, (_, last) => last.plan.eq(DENIED),
        ({ op }, j) => (j === 0 ? op.is("take") : op.is("take"))),
    ],
  }];
};
export const PROVIDER_BUGS: ProviderBug[] = ["revocation keeps the ticket live", "take ignores the key", "stale revisions pass", "cancellation is ignored", "payload is swapped"];
