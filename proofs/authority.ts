// Capability authority, one machine per authority object. A grant is the
// interned name of its complete canonical tuple; a set of grants is a map of
// 0/1 cells. Derivation reads the parent's state as the carried `Parent` set.
import { all, bool, everyKey, nat, oneOf, rule, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type AuthorityBug = "derivation checks one grant" | "release keeps grants usable" | "released parents derive" | "derivation widens";

export const authority = (bug?: AuthorityBug) => rule("capability authority")
  .inputs({ op: oneOf("issue", "derive", "use", "release"), name: nat, parentLive: bool })
  .state({ live: 0, granted: 0 })
  .maps({ Grants: 0 })
  .carries("Candidate", "Parent")
  .flags(({ name, Candidate, Parent }) => ({
    bits: everyKey((k) => Candidate.at(k).atMost(1).and(Parent.at(k).atMost(1))),
    // The specification's subset, stated apart from `covered`; the step never reads it.
    withinParent: everyKey((k) => Candidate.has(k).implies(Parent.has(k))),
    covered: bug === "derivation checks one grant" ? Candidate.has(name).implies(Parent.has(name)) : Candidate.subsetOf(Parent),
  }))
  .flags(({ op, parentLive, covered, live, name, Grants }) => ({
    issued: op.is("issue"),
    derived: op.is("derive").and(bug === "released parents derive" ? covered : parentLive.and(covered)),
    allowed: op.is("use").and(bug === "release keeps grants usable" ? Grants.has(name) : live.eq(1).and(Grants.has(name))),
  }))
  .assume(({ bits }) => bits)
  .step(({ op, live, issued, derived, allowed, Candidate, Parent, Grants }) => ({
    live: when(issued.or(derived), 1, when(op.is("use"), live, 0)),
    granted: when(allowed, 1, 0),
    Grants: Grants.each((k) => when(issued.or(derived), bug === "derivation widens" ? Parent.at(k) : Candidate.at(k),
      when(op.is("use"), Grants.at(k), bug === "release keeps grants usable" ? Grants.at(k) : 0))),
  }));

export const authorityKernels = (bug?: AuthorityBug): Kernel[] => {
  const r = authority(bug);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const exactly = (a: any, b: any) => everyKey((k) => a.at(k).eq(b.at(k)));
  const within = (a: any, b: any) => everyKey((k) => a.has(k).implies(b.has(k)));
  return [{
    id: "capabilityAuthority",
    rule: r,
    laws: [r.law("grants are a set", ({ Grants }) => everyKey((k) => Grants.at(k).atMost(1)))],
    stepLaws: [
      r.stepLaw("authority_issue_exact: issuance is live and holds exactly its grants", ({ Candidate }, a) => a.live.eq(1).and(exactly(a.Grants, Candidate)), ({ op }) => op.is("issue")),
      r.stepLaw("authority_use_safe: a granted use was live and named a held grant", ({ live, name, Grants }, a) => a.granted.eq(1).implies(live.eq(1).and(Grants.has(name))), ({ op }) => op.is("use")),
      r.stepLaw("authority_use_complete: a live use of a held grant is granted", ({ live, name, Grants }, a) => live.eq(1).and(Grants.has(name)).implies(a.granted.eq(1)), ({ op }) => op.is("use")),
      r.stepLaw("authority_use_preserves: a use changes no authority", ({ live, Grants }, a) => a.live.eq(live).and(exactly(a.Grants, Grants)), ({ op }) => op.is("use")),
      r.stepLaw("authority_derive_safe: a live child had a live parent and holds exactly its candidate, all within the parent",
        ({ parentLive, Candidate, Parent }, a) => a.live.eq(1).implies(all(parentLive, within(Candidate, Parent), exactly(a.Grants, Candidate))), ({ op }) => op.is("derive")),
      r.stepLaw("authority_derive_complete: a candidate within a live parent is derived exactly",
        ({ Candidate }, a) => a.live.eq(1).and(exactly(a.Grants, Candidate)),
        ({ op, parentLive, withinParent }) => op.is("derive").and(parentLive, withinParent)),
      r.stepLaw("authority_released_cannot_derive: a released parent derives only a released child", (_, a) => a.live.eq(0), ({ op, parentLive }) => op.is("derive").and(parentLive.not())),
      r.stepLaw("authority_released_not_live: release leaves no live authority and no grants", (_, a) => a.live.eq(0).and(everyKey((k) => a.Grants.at(k).eq(0))), ({ op }) => op.is("release")),
      r.stepsLaw("authority_child_use_safe: a derived child's granted use names a grant of its parent", 2,
        ({ Parent }, last, [, use]) => last.granted.eq(1).implies(Parent.has(use!.name)),
        ({ op }, j) => (j === 0 ? op.is("derive") : op.is("use"))),
      r.stepsLaw("authority_released_refused: a released authority grants nothing", 2, (_, last) => last.granted.eq(0),
        ({ op }, j) => (j === 0 ? op.is("release") : op.is("use"))),
    ],
  }];
};
export const AUTHORITY_BUGS: AuthorityBug[] = ["derivation checks one grant", "release keeps grants usable", "released parents derive", "derivation widens"];
