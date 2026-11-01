// Fabric's scalar policy decisions, each a gdp-wired `fun`. The generated module
// ships the compiled terms of these functions; nothing here is translated by hand.
// Every law restates its requirement independently of the function body, and
// every function keeps the deliberately broken variants the prover must refuse.
import { all, bool, fun, nat, oneOf, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type PolicyBug =
  | "transition ignores the epoch"
  | "cleanup failure is disposed"
  | "unknown conflict reads one side"
  | "known conflict ignores ordering"
  | "lineage admits non-members"
  | "pointer ignores lineage"
  | "coverage ignores truncation"
  | "canonical arguments are rewritten"
  | "pending head needs no marker"
  | "marked pending head is hidden"
  | "certificate skips its last fact"
  | "consumption stays active"
  | "summary ignores the byte limit"
  | "sample loses an entry"
  | "chunk ignores completion";

const transition = (bug?: PolicyBug) => fun("transition current")
  .inputs({ retired: bool, sameEpoch: bool, sameOwner: bool, closed: bool })
  .returns(({ retired, sameEpoch, sameOwner, closed }) => ({
    ok: all(retired.not(), bug === "transition ignores the epoch" ? sameOwner : sameEpoch, sameOwner, closed.not()),
  }));

const cleanup = (bug?: PolicyBug) => fun("cleanup state")
  .inputs({ failed: bool, diverted: bool })
  .returns(({ failed, diverted }) => ({
    state: when(failed, bug === "cleanup failure is disposed" ? 0 : 2, when(diverted, 1, 0)),
  }));

const unknown = (bug?: PolicyBug) => fun("unknown conflict")
  .inputs({ lu: bool, luo: bool, lo: bool, ru: bool, ruo: bool, ro: bool })
  .returns(({ lu, luo, lo, ru, ruo, ro }) => ({
    conflict: bug === "unknown conflict reads one side" ? lu.and(luo.or(ro)) : lu.and(luo.or(ro)).or(ru.and(ruo.or(lo))),
  }));

const known = (bug?: PolicyBug) => fun("known conflict")
  .inputs({ shared: bool, leftOrdered: bool, rightOrdered: bool })
  .returns(({ shared, leftOrdered, rightOrdered }) => ({
    conflict: bug === "known conflict ignores ordering" ? shared : shared.and(leftOrdered.or(rightOrdered)),
  }));

const lineage = (bug?: PolicyBug) => fun("lineage selected")
  .inputs({ allBranches: bool, member: bool })
  .returns(({ allBranches, member }) => ({
    selected: bug === "lineage admits non-members" ? allBranches.or(member.not()) : allBranches.or(member),
  }));

const pointer = (bug?: PolicyBug) => fun("pointer current")
  .inputs({ source: bool, lineage: bool })
  .returns(({ source, lineage }) => ({ current: bug === "pointer ignores lineage" ? source : source.and(lineage) }));

const coverage = (bug?: PolicyBug) => fun("coverage complete")
  .inputs({ sourceComplete: bool, truncated: bool })
  .returns(({ sourceComplete, truncated }) => ({
    complete: bug === "coverage ignores truncation" ? sourceComplete : sourceComplete.and(truncated.not()),
  }));

const normalized = (bug?: PolicyBug) => fun("use normalized")
  .inputs({ canonical: bool, plan: bool, changed: bool, accepted: bool })
  .returns(({ canonical, plan, changed, accepted }) => ({
    use: bug === "canonical arguments are rewritten" ? all(plan, changed, accepted) : all(canonical.not(), plan, changed, accepted),
  }));

const head = (bug?: PolicyBug) => fun("head readable")
  .inputs({ sequence: bool, version: bool, committed: bool, pending: bool, marker: bool })
  .returns(({ sequence, version, committed, pending, marker }) => ({
    readable: all(sequence, version, bug === "marked pending head is hidden" ? committed : committed.or(bug === "pending head needs no marker" ? pending : pending.and(marker))),
  }));

const FACTS = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"] as const;
const certificate = (bug?: PolicyBug) => fun("certificate accepted")
  .inputs({ f0: bool, f1: bool, f2: bool, f3: bool, f4: bool, f5: bool, f6: bool, f7: bool })
  .returns((env) => ({
    accepted: all(...FACTS.slice(0, bug === "certificate skips its last fact" ? 7 : 8).map((name) => env[name])),
  }));

const consume = (bug?: PolicyBug) => fun("consume")
  .inputs({ active: bool })
  .returns(({ active }) => ({ released: active, active: bug === "consumption stays active" ? active : active.and(active.not()) }));

const summary = (bug?: PolicyBug) => fun("summary within")
  .inputs({ bytes: nat, byteLimit: nat, projected: nat, target: nat })
  .returns(({ bytes, byteLimit, projected, target }) => ({
    within: bug === "summary ignores the byte limit" ? projected.atMost(target) : bytes.atMost(byteLimit).and(projected.atMost(target)),
  }));

const sample = (bug?: PolicyBug) => fun("sample within")
  .inputs({ total: nat, retained: nat, omitted: nat, limit: nat })
  .returns(({ total, retained, omitted, limit }) => ({
    within: (bug === "sample loses an entry" ? total.atMost(retained.plus(omitted)) : total.eq(retained.plus(omitted))).and(retained.atMost(limit)),
  }));

const chunk = (bug?: PolicyBug) => fun("chunk accepted")
  .inputs({ start: nat, end: nat, total: nat, expectedStart: nat, expectedTotal: nat, length: nat, complete: bool })
  .returns(({ start, end, total, expectedStart, expectedTotal, length, complete }) => ({
    accepted: all(
      start.eq(expectedStart), total.eq(expectedTotal), start.atMost(end), end.atMost(total),
      length.plus(start).eq(end),
      bug === "chunk ignores completion" ? complete.or(complete.not()) : complete.iff(end.eq(total)),
      complete.or(start.lt(end)),
    ),
  }));

// Each law names the Bend law it replaces. A soundness/completeness pair states
// the requirement once, so a function that drops a check or denies everything fails.
export const policyKernels = (bug?: PolicyBug): Kernel[] => {
  const t = transition(bug), cl = cleanup(bug), u = unknown(bug), k = known(bug), li = lineage(bug);
  const p = pointer(bug), co = coverage(bug), n = normalized(bug), h = head(bug), ce = certificate(bug);
  const cs = consume(bug), su = summary(bug), sa = sample(bug), ch = chunk(bug);
  return [
    { id: "transitionCurrent", fun: t, decisions: [
      t.law("transition_sound: a current transition is unretired, same-epoch, same-owner and open", () => [], ({ ok }, e) => ok.implies(all(e.retired.not(), e.sameEpoch, e.sameOwner, e.closed.not()))),
      t.law("transition_complete: every unretired, same-epoch, same-owner, open transition is current", () => [], ({ ok }, e) => all(e.retired.not(), e.sameEpoch, e.sameOwner, e.closed.not()).implies(ok)),
    ] },
    { id: "cleanupState", fun: cl, decisions: [
      cl.law("cleanup_failure_quarantines: a cleanup failure always quarantines", ({ failed }) => failed, ({ state }) => state.eq(2)),
      cl.law("cleanup_diverted: an unfailed diverted cleanup is diverted", ({ failed, diverted }) => [failed.not(), diverted], ({ state }) => state.eq(1)),
      cl.law("cleanup_disposed: an unfailed undiverted cleanup is disposed", ({ failed, diverted }) => [failed.not(), diverted.not()], ({ state }) => state.eq(0)),
    ] },
    { id: "unknownConflict", fun: u, decisions: [
      u.law("unknown_conflict_exact: an unknown scope conflicts exactly when it or its peer is noncommutative", () => [], ({ conflict }, e) => conflict.iff(e.lu.and(e.luo.or(e.ro)).or(e.ru.and(e.ruo.or(e.lo))))),
      u.relate("unknown_conflict_symmetric: swapping the sides never changes the decision",
        (a, b) => [a.lu.iff(b.ru), a.luo.iff(b.ruo), a.lo.iff(b.ro), a.ru.iff(b.lu), a.ruo.iff(b.luo), a.ro.iff(b.lo)],
        (x, y) => x.conflict.iff(y.conflict)),
    ] },
    { id: "knownConflict", fun: k, decisions: [
      k.law("known_conflict_exact: a shared resource conflicts exactly when one side is ordered", () => [], ({ conflict }, e) => conflict.iff(e.shared.and(e.leftOrdered.or(e.rightOrdered)))),
    ] },
    { id: "lineageSelected", fun: li, decisions: [
      li.law("active_lineage_only: without all-branch selection only members are selected", ({ allBranches }) => allBranches.not(), ({ selected }, e) => selected.iff(e.member)),
      li.law("explicit_all_lineages: explicit all-branch selection selects every entry", ({ allBranches }) => allBranches, ({ selected }) => selected),
    ] },
    { id: "pointerCurrent", fun: p, decisions: [
      p.law("pointer_sound: a current pointer matches its source and its lineage", () => [], ({ current }, e) => current.implies(e.source.and(e.lineage))),
      p.law("pointer_complete: a pointer matching its source and lineage is current", () => [], ({ current }, e) => e.source.and(e.lineage).implies(current)),
    ] },
    { id: "coverageComplete", fun: co, decisions: [
      co.law("coverage_sound: complete coverage needs a complete source and no truncation", () => [], ({ complete }, e) => complete.implies(e.sourceComplete.and(e.truncated.not()))),
      co.law("coverage_complete: an untruncated complete source is complete coverage", () => [], ({ complete }, e) => e.sourceComplete.and(e.truncated.not()).implies(complete)),
    ] },
    { id: "useNormalized", fun: n, decisions: [
      n.law("normalization_sound: a normal form is used only for non-canonical, planned, changed, accepted arguments", () => [], ({ use }, e) => use.implies(all(e.canonical.not(), e.plan, e.changed, e.accepted))),
      n.law("normalization_complete: every non-canonical, planned, changed, accepted normal form is used", () => [], ({ use }, e) => all(e.canonical.not(), e.plan, e.changed, e.accepted).implies(use)),
      n.law("canonical_identity: canonical arguments stay original", ({ canonical }) => canonical, ({ use }) => use.not()),
    ] },
    { id: "headReadable", fun: h, decisions: [
      h.law("head_sound: a readable head has its sequence, its version, and a commit or a marked pending write", () => [], ({ readable }, e) => readable.implies(all(e.sequence, e.version, e.committed.or(e.pending.and(e.marker))))),
      h.law("pending_without_marker_hidden: a pending uncommitted head without its marker is hidden", ({ committed, pending, marker }) => [committed.not(), pending, marker.not()], ({ readable }) => readable.not()),
      h.law("committed_head_visible: a committed head with its sequence and version is visible", ({ sequence, version, committed }) => [sequence, version, committed], ({ readable }) => readable),
      h.law("pending_head_visible: a pending head with its sequence, version and commit marker is visible", ({ sequence, version, pending, marker }) => [sequence, version, pending, marker], ({ readable }) => readable),
    ] },
    { id: "certificateAccepted", fun: ce, decisions: [
      ce.law("certificate_sound: an accepted certificate has every fact", () => [], ({ accepted }, e) => accepted.implies(all(...FACTS.map((name) => e[name])))),
      ce.law("certificate_complete: a certificate with every fact is accepted", () => [], ({ accepted }, e) => all(...FACTS.map((name) => e[name])).implies(accepted)),
    ] },
    { id: "consume", fun: cs, decisions: [
      cs.law("consume_once: an inactive token releases nothing", ({ active }) => active.not(), ({ released, active }) => released.not().and(active.not())),
      cs.law("consume_retires: consumption releases an active token and leaves it inactive", () => [], ({ released, active }, e) => released.iff(e.active).and(active.not())),
    ] },
    { id: "summaryWithin", fun: su, decisions: [
      su.law("summary_bounds: an accepted summary is within its byte limit and token target", () => [], ({ within }, e) => within.implies(e.bytes.atMost(e.byteLimit).and(e.projected.atMost(e.target)))),
      su.law("summary_complete: a summary within both bounds is accepted", () => [], ({ within }, e) => e.bytes.atMost(e.byteLimit).and(e.projected.atMost(e.target)).implies(within)),
    ] },
    { id: "sampleWithin", fun: sa, decisions: [
      sa.law("sample_accounting: retained plus omitted is the total, and the retained fit the limit", () => [], ({ within }, e) => within.implies(e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)))),
      sa.law("sample_complete: exact accounting within the limit is accepted", () => [], ({ within }, e) => e.total.eq(e.retained.plus(e.omitted)).and(e.retained.atMost(e.limit)).implies(within)),
    ] },
    { id: "chunkAccepted", fun: ch, decisions: [
      ch.law("chunk_sound: an accepted chunk starts where expected, has the expected total, an exact length, truthful completion and progress", () => [], ({ accepted }, e) => accepted.implies(all(
        e.start.eq(e.expectedStart), e.total.eq(e.expectedTotal), e.start.atMost(e.end), e.end.atMost(e.total),
        e.length.eq(e.end.minus(e.start)), e.complete.iff(e.end.eq(e.total)), e.complete.or(e.start.lt(e.end)),
      ))),
      ch.law("chunk_complete: every chunk meeting those requirements is accepted", () => [], ({ accepted }, e) => all(
        e.start.eq(e.expectedStart), e.total.eq(e.expectedTotal), e.start.atMost(e.end), e.end.atMost(e.total),
        e.length.eq(e.end.minus(e.start)), e.complete.iff(e.end.eq(e.total)), e.complete.or(e.start.lt(e.end)),
      ).implies(accepted)),
    ] },
  ];
};

export const POLICY_BUGS: PolicyBug[] = [
  "transition ignores the epoch", "cleanup failure is disposed", "unknown conflict reads one side",
  "known conflict ignores ordering", "lineage admits non-members", "pointer ignores lineage",
  "coverage ignores truncation", "canonical arguments are rewritten", "pending head needs no marker", "marked pending head is hidden",
  "certificate skips its last fact", "consumption stays active", "summary ignores the byte limit",
  "sample loses an entry", "chunk ignores completion",
];
void oneOf;
