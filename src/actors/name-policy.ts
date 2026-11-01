import { actorName } from "../verified/generated/actor-name.js";

/** Decision over a host-supplied snapshot, not a distributed lock or reservation. */
export function actorNameDecision(hasActive: boolean, hasStopped: boolean): "available" | "active" | "stopped" {
  const result = actorName.step({}, actorName.init({}), { hasActive: hasActive ? 1 : 0, hasStopped: hasStopped ? 1 : 0 }).scalars;
  if (result["out.active"] === 1) return "active";
  if (result["out.stopped"] === 1) return "stopped";
  if (result["out.available"] === 1) return "available";
  throw new Error("Invalid verified actor name decision");
}
