// External mesh grants: the compiled decision consumes one captured use.
// Authentication, interning, the lock and persistence remain host boundaries.
import { all, bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type GrantBug = "authentication ignored" | "expiry equality admitted" | "exhaustion ignored" | "topic ignored" | "kind ignored" | "use not consumed" | "valid grant denied";
export const GRANT_PLANS = ["Invalid", "Expired", "Exhausted", "Topic", "Kind", "Consume"] as const;
const [INVALID, EXPIRED, EXHAUSTED, TOPIC, KIND, CONSUME] = [0, 1, 2, 3, 4, 5];

const grant = (bug?: GrantBug) => fun("mesh grant consumption")
  .inputs({ authenticated: bool, now: nat, expiresAt: nat, uses: nat, topic: nat, requestedTopic: nat, hasTopic: bool, kind: nat, hasKind: bool, requestedKind: nat, hasRequestedKind: bool, externalKind: nat })
  .returns((e) => {
    const authenticated = bug === "authentication ignored" ? e.authenticated.or(e.authenticated.not()) : e.authenticated;
    const expired = bug === "expiry equality admitted" ? e.expiresAt.lt(e.now) : e.expiresAt.atMost(e.now);
    const exhausted = bug === "exhaustion ignored" ? e.uses.lt(0) : e.uses.eq(0);
    const wrongTopic = bug === "topic ignored" ? e.topic.lt(0) : e.hasTopic.and(e.requestedTopic.ne(e.topic));
    const wrongKind = bug === "kind ignored" ? e.kind.lt(0) : all(e.hasKind, e.hasRequestedKind, e.requestedKind.ne(e.kind));
    const plan = when(authenticated.not(), INVALID, when(expired, EXPIRED, when(exhausted, EXHAUSTED, when(wrongTopic, TOPIC, when(wrongKind, KIND, bug === "valid grant denied" ? INVALID : CONSUME)))));
    return { plan, uses: when(plan.eq(CONSUME), bug === "use not consumed" ? e.uses : e.uses.minus(1), e.uses), topic: e.topic, kind: when(e.hasRequestedKind, e.requestedKind, when(e.hasKind, e.kind, e.externalKind)) };
  });

export const grantKernels = (bug?: GrantBug): Kernel[] => {
  const f = grant(bug);
  // The requirement is stated independently of the implementation's branches.
  const allowed = (e: Parameters<Parameters<typeof f.law>[1]>[0]) => all(e.authenticated, e.now.lt(e.expiresAt), e.uses.gt(0), e.hasTopic.not().or(e.requestedTopic.eq(e.topic)), e.hasKind.not().or(e.hasRequestedKind.not(), e.requestedKind.eq(e.kind)));
  return [{ id: "meshGrantTake", fun: f, decisions: [
    f.law("grant_safe: consumption requires authentication, an unexpired use, and matching requested scopes", () => [], (o, e) => o.plan.eq(CONSUME).implies(allowed(e))),
    f.law("grant_complete: every authenticated unexpired in-scope use is consumed", allowed, (o) => o.plan.eq(CONSUME)),
    f.law("grant_decrement: consumption removes exactly one remaining use", () => [], (o, e) => o.plan.eq(CONSUME).implies(o.uses.plus(1).eq(e.uses))),
    f.law("grant_refusal_preserves: refusal changes no remaining use", () => [], (o, e) => o.plan.ne(CONSUME).implies(o.uses.eq(e.uses))),
    f.law("grant_forwarding: the topic and selected kind are forwarded exactly", () => [], (o, e) => o.topic.eq(e.topic).and(o.kind.eq(when(e.hasRequestedKind, e.requestedKind, when(e.hasKind, e.kind, e.externalKind))))),
    f.law("grant_invalid: failed authentication is the first refusal", ({ authenticated }) => authenticated.not(), (o) => o.plan.eq(INVALID)),
    f.law("grant_expired: an authenticated grant expires at its deadline, before other refusals", (e) => [e.authenticated, e.expiresAt.atMost(e.now)], (o) => o.plan.eq(EXPIRED)),
    f.law("grant_exhausted: an authenticated unexpired grant without uses is refused", (e) => [e.authenticated, e.now.lt(e.expiresAt), e.uses.eq(0)], (o) => o.plan.eq(EXHAUSTED)),
    f.law("grant_topic: a live use cannot name another topic", (e) => [e.authenticated, e.now.lt(e.expiresAt), e.uses.gt(0), e.hasTopic, e.requestedTopic.ne(e.topic)], (o) => o.plan.eq(TOPIC)),
    f.law("grant_kind: a live topic-matching use cannot widen a fixed kind", (e) => [e.authenticated, e.now.lt(e.expiresAt), e.uses.gt(0), e.hasTopic.not().or(e.requestedTopic.eq(e.topic)), e.hasKind, e.hasRequestedKind, e.requestedKind.ne(e.kind)], (o) => o.plan.eq(KIND)),
  ] }];
};
export const GRANT_BUGS: GrantBug[] = ["authentication ignored", "expiry equality admitted", "exhaustion ignored", "topic ignored", "kind ignored", "use not consumed", "valid grant denied"];
