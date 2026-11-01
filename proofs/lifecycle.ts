// The provider-binding lifecycle reducer, as a statechart: one step applies one
// event to a life record and leaves the command it decided in `command`, which
// is Denied when no transition fires. Step laws carry no invariant, so each one
// holds from every life record, reachable or not.
import { all, bool, chart, no, oneOf, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export const PHASES = ["Staged", "Active", "Retiring", "Closing", "Closed", "Failed"] as const;
export const EVENTS = ["Inspect", "Activate", "Retire", "DropOwner", "Revoke", "Retain", "Release", "Begin", "End", "Shut", "Complete", "Abort"] as const;
export const COMMANDS = ["Denied", "Granted", "StartClose"] as const;
const [STAGED, ACTIVE, RETIRING, CLOSING, CLOSED, FAILED] = [0, 1, 2, 3, 4, 5];
const [DENIED, GRANTED, START_CLOSE] = [0, 1, 2];

export type LifecycleBug =
  | "closing admits work" | "revocation drops holds" | "release underflows" | "close ignores calls"
  | "failed admits ordinary work" | "abort reopens closed" | "begin counts nothing";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Open(phase, revoked, cleanup), written apart from the reducer: Closing and
// Closed admit nothing, Failed admits cleanup only, the rest admit cleanup or unrevoked work.
const Open = (phase: any, revoked: any, cleanup: any) =>
  phase.eq(CLOSING).or(phase.eq(CLOSED)).not().and(phase.eq(FAILED).implies(cleanup), cleanup.or(revoked.eq(0)));
const retiredPhase = (phase: any) => when(phase.eq(STAGED).or(phase.eq(ACTIVE)), phase.of("Retiring"), phase);

// Phases that admit ordinary work, and the rest.
const WORK = ["Staged", "Active", "Retiring"], SETTLED = ["Retiring", "Closing", "Closed", "Failed"], EVERY = [...PHASES];
export const lifecycle = (bug?: LifecycleBug) => {
  const granted = () => ({ command: "Granted" as const });
  const revoke = ({ holds }: any) => ({ owner: 0, revoked: 1, command: "Granted" as const, ...(bug === "revocation drops holds" ? { holds: 0 } : {}) });
  // Ordinary work while unrevoked, cleanup always; Failed admits cleanup only; Closing and Closed admit nothing.
  const working = bug === "closing admits work" ? [...WORK, "Closing"] : WORK;
  const ordinary = ({ cleanup, revoked }: any) => cleanup.or(revoked.eq(0));
  const cleanupOnly = ({ cleanup, revoked }: any) => (bug === "failed admits ordinary work" ? cleanup.or(revoked.eq(0)) : cleanup);
  const retain = ({ holds }: any) => ({ holds: holds.plus(1), command: "Granted" as const });
  const begin = ({ calls }: any) => ({ calls: bug === "begin counts nothing" ? calls : calls.plus(1), command: "Granted" as const });
  return chart("binding lifecycle")
    .events(...EVENTS)
    .inputs({ cleanup: bool })
    .context({ owner: 1, holds: 0, calls: 0, revoked: 0 })
    .outputs({ command: oneOf(...COMMANDS).from("Denied") })
    .states({ Staged: {}, Active: {}, Retiring: {}, Closing: {}, Closed: { final: true }, Failed: { final: true } }, { field: "phase" })
    .on("Inspect", { from: WORK, when: ({ revoked }) => revoked.eq(0), set: granted })
    .on("Activate", { from: ["Staged", "Active"], to: "Active", set: granted })
    .on("Retire", { from: ["Staged", "Active"], to: "Retiring", set: granted })
    .on("Retire", { from: SETTLED, set: granted })
    .on("DropOwner", { from: EVERY, set: () => ({ owner: 0, command: "Granted" as const }) })
    .on("Revoke", { from: ["Staged", "Active"], to: "Retiring", set: revoke })
    .on("Revoke", { from: SETTLED, set: revoke })
    .on("Retain", { from: working, when: ordinary, set: retain })
    .on("Retain", { from: "Failed", when: cleanupOnly, set: retain })
    .on("Begin", { from: working, when: ordinary, set: begin })
    .on("Begin", { from: "Failed", when: cleanupOnly, set: begin })
    .on("Release", { from: EVERY, when: ({ holds }) => (bug === "release underflows" ? holds.atLeast(0) : holds.atLeast(1)), set: ({ holds }) => ({ holds: holds.minus(1), command: "Granted" as const }) })
    .on("End", { from: EVERY, when: ({ calls }) => calls.atLeast(1), set: ({ calls }) => ({ calls: calls.minus(1), command: "Granted" as const }) })
    .on("Shut", { from: "Retiring", to: "Closing", when: ({ owner, holds, calls }) => all(owner.eq(0), holds.eq(0), bug === "close ignores calls" ? holds.eq(0) : calls.eq(0)),
      set: () => ({ command: "StartClose" as const }) })
    .on("Complete", { from: "Closing", to: "Closed", set: granted })
    .on("Abort", { from: bug === "abort reopens closed" ? EVERY : EVERY.filter((phase) => phase !== "Closed"), to: "Failed", set: () => ({ owner: 0, revoked: 1, command: "Granted" as const }) });
};

export const lifecycleKernels = (bug?: LifecycleBug): Kernel[] => {
  const c = lifecycle(bug), r = c.rule;
  type E = any;
  const unchanged = (b: E, a: E) => all(a.phase.eq(b.phase), a.owner.eq(b.owner), a.holds.eq(b.holds), a.calls.eq(b.calls), a.revoked.eq(b.revoked));
  const life = (a: E, phase: E, owner: E, holds: E, calls: E, revoked: E) =>
    all(a.phase.eq(phase), a.owner.eq(owner), a.holds.eq(holds), a.calls.eq(calls), a.revoked.eq(revoked));
  const on = (name: (typeof EVENTS)[number]) => ({ event }: E) => event.is(name);
  return [{
    id: "bindingStep",
    rule: c.rule,
    chart: c,
    stepLaws: [
      r.stepLaw("inspect_safe: a granted inspection is open to ordinary work and changes nothing; every inspection changes nothing",
        (b, a) => unchanged(b, a).and(a.command.eq(GRANTED).implies(Open(b.phase, b.revoked, no)), a.command.ne(START_CLOSE)), on("Inspect")),
      r.stepLaw("inspect_open_complete: an inspection open to ordinary work is granted",
        (b, a) => Open(b.phase, b.revoked, no).implies(a.command.eq(GRANTED)), on("Inspect")),
      r.stepLaw("begin_safe: a granted begin was open and adds exactly one call; a denied one changes nothing",
        (b, a) => a.command.ne(START_CLOSE).and(
          a.command.eq(GRANTED).implies(Open(b.phase, b.revoked, b.cleanup).and(life(a, b.phase, b.owner, b.holds, b.calls.plus(1), b.revoked))),
          a.command.eq(DENIED).implies(unchanged(b, a))), on("Begin")),
      r.stepLaw("begin_open_complete: every open begin is granted with one more call",
        (b, a) => Open(b.phase, b.revoked, b.cleanup).implies(a.command.eq(GRANTED).and(life(a, b.phase, b.owner, b.holds, b.calls.plus(1), b.revoked))), on("Begin")),
      r.stepLaw("retain_safe: a granted retain was open and adds exactly one hold; a denied one changes nothing",
        (b, a) => a.command.ne(START_CLOSE).and(
          a.command.eq(GRANTED).implies(Open(b.phase, b.revoked, b.cleanup).and(life(a, b.phase, b.owner, b.holds.plus(1), b.calls, b.revoked))),
          a.command.eq(DENIED).implies(unchanged(b, a))), on("Retain")),
      r.stepLaw("retain_open_complete: every open retain is granted with one more hold",
        (b, a) => Open(b.phase, b.revoked, b.cleanup).implies(a.command.eq(GRANTED).and(life(a, b.phase, b.owner, b.holds.plus(1), b.calls, b.revoked))), on("Retain")),
      r.stepLaw("close_safe: close starts only from a retiring, ownerless, idle binding, into Closing; otherwise nothing changes",
        (b, a) => a.command.ne(GRANTED).and(
          a.command.eq(START_CLOSE).implies(all(b.phase.eq(RETIRING), b.owner.eq(0), b.holds.eq(0), b.calls.eq(0)).and(life(a, CLOSING, 0, 0, 0, b.revoked))),
          a.command.eq(DENIED).implies(unchanged(b, a))), on("Shut")),
      r.stepLaw("close_complete: a retiring, ownerless, idle binding starts closing",
        (b, a) => all(b.phase.eq(RETIRING), b.owner.eq(0), b.holds.eq(0), b.calls.eq(0)).implies(a.command.eq(START_CLOSE)), on("Shut")),
      r.stepLaw("release_exact: a release with holds removes exactly one; with none it is refused and changes nothing",
        (b, a) => b.holds.atLeast(1).implies(a.command.eq(GRANTED).and(life(a, b.phase, b.owner, b.holds.minus(1), b.calls, b.revoked)))
          .and(b.holds.eq(0).implies(a.command.eq(DENIED).and(unchanged(b, a)))), on("Release")),
      r.stepLaw("end_exact: an end with calls removes exactly one; with none it is refused and changes nothing",
        (b, a) => b.calls.atLeast(1).implies(a.command.eq(GRANTED).and(life(a, b.phase, b.owner, b.holds, b.calls.minus(1), b.revoked)))
          .and(b.calls.eq(0).implies(a.command.eq(DENIED).and(unchanged(b, a)))), on("End")),
      r.stepLaw("revoke_preserves_work: revocation retires, drops the owner and keeps every hold and call",
        (b, a) => a.command.eq(GRANTED).and(life(a, retiredPhase(b.phase), 0, b.holds, b.calls, 1)), on("Revoke")),
      r.stepLaw("drop_owner_preserves_work: dropping the owner keeps everything else",
        (b, a) => a.command.eq(GRANTED).and(life(a, b.phase, 0, b.holds, b.calls, b.revoked)), on("DropOwner")),
      r.stepLaw("retire_preserves_work: retirement changes only the phase",
        (b, a) => a.command.eq(GRANTED).and(life(a, retiredPhase(b.phase), b.owner, b.holds, b.calls, b.revoked)), on("Retire")),
      r.stepLaw("activation_exact: Staged and Active activate; every other phase is refused unchanged",
        (b, a) => when(b.phase.eq(STAGED).or(b.phase.eq(ACTIVE)), 1, 0).eq(1).implies(a.command.eq(GRANTED).and(life(a, ACTIVE, b.owner, b.holds, b.calls, b.revoked)))
          .and(b.phase.eq(STAGED).or(b.phase.eq(ACTIVE)).not().implies(a.command.eq(DENIED).and(unchanged(b, a)))), on("Activate")),
      r.stepLaw("completion_exact: Closing completes into Closed; every other phase is refused unchanged",
        (b, a) => b.phase.eq(CLOSING).implies(a.command.eq(GRANTED).and(life(a, CLOSED, b.owner, b.holds, b.calls, b.revoked)))
          .and(b.phase.ne(CLOSING).implies(a.command.eq(DENIED).and(unchanged(b, a)))), on("Complete")),
      r.stepLaw("failure_exact: abort quarantines every unclosed binding, keeping its work; Closed is refused unchanged",
        (b, a) => b.phase.ne(CLOSED).implies(a.command.eq(GRANTED).and(life(a, FAILED, 0, b.holds, b.calls, 1)))
          .and(b.phase.eq(CLOSED).implies(a.command.eq(DENIED).and(unchanged(b, a)))), on("Abort")),
      r.stepLaw("closing_refuses_work: a closing binding refuses every begin",
        (b, a) => b.phase.eq(CLOSING).implies(a.command.eq(DENIED).and(unchanged(b, a))), on("Begin")),
      r.stepLaw("revoked_refuses_work: a revoked binding refuses ordinary work",
        (b, a) => b.revoked.eq(1).and(b.cleanup.not()).implies(a.command.eq(DENIED).and(unchanged(b, a))), on("Begin")),
      r.stepLaw("cleanup_after_revocation: a revoked retiring binding still admits cleanup",
        (b, a) => all(b.phase.eq(RETIRING), b.revoked.eq(1), b.cleanup).implies(a.command.eq(GRANTED).and(life(a, RETIRING, b.owner, b.holds, b.calls.plus(1), 1))), on("Begin")),
    ],
  }];
};
export const LIFECYCLE_BUGS: LifecycleBug[] = [
  "closing admits work", "revocation drops holds", "release underflows", "close ignores calls",
  "failed admits ordinary work", "abort reopens closed", "begin counts nothing",
];
