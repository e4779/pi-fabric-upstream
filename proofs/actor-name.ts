// A decision over one host-supplied snapshot, not a name reservation.
import { bool, fun } from "gdp-wired";
import type { Kernel } from "./kernel.js";

type ActorNameBug = "stopped overrides active" | "admit stopped-only" | "refuse absent";
const decision = (bug?: ActorNameBug) => fun("actor name decision")
  .inputs({ hasActive: bool, hasStopped: bool })
  .returns(({ hasActive, hasStopped }) => ({
    active: bug === "stopped overrides active" ? hasActive.and(hasStopped.not()) : hasActive,
    stopped: bug === "stopped overrides active" ? hasStopped
      : bug === "admit stopped-only" ? hasActive.and(hasActive.not())
      : bug === "refuse absent" ? hasActive.not()
      : hasActive.not().and(hasStopped),
    available: bug === "admit stopped-only" ? hasActive.not()
      : bug === "refuse absent" ? hasActive.and(hasActive.not())
      : hasActive.not().and(hasStopped.not()),
  }));

export const actorNameKernels = (bug?: ActorNameBug): Kernel[] => {
  const f = decision(bug);
  return [{ id: "actorName", fun: f, decisions: [
    f.law("active dominates even when stopped exists", ({ hasActive }) => hasActive, (o) => o.active.and(o.stopped.not(), o.available.not())),
    f.law("stopped is refused when no active exists", ({ hasActive, hasStopped }) => hasActive.not().and(hasStopped), (o) => o.stopped.and(o.active.not(), o.available.not())),
    f.law("neither exists means available", ({ hasActive, hasStopped }) => hasActive.not().and(hasStopped.not()), (o) => o.available.and(o.active.not(), o.stopped.not())),
  ] }];
};
export const ACTOR_NAME_BUGS: ActorNameBug[] = ["stopped overrides active", "admit stopped-only", "refuse absent"];
