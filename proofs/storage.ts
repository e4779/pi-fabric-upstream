// Mesh storage compare-and-swap. Keys, values and identities are interned
// names: the reducer forwards them, and the laws prove the forwarding exact.
// Revisions are naturals below 2^53, the bound the compiled runtime enforces.
import { all, bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

/** The largest revision: a revision below it still has a successor. */
export const REVISION_MAX = Number.MAX_SAFE_INTEGER;
export const PLANS = ["Conflict", "Exhausted", "Unchanged", "PutNext", "DeleteNext"] as const;
const [CONFLICT, EXHAUSTED, UNCHANGED, PUT_NEXT, DELETE_NEXT] = [0, 1, 2, 3, 4];

export type StorageBug = "stale writes pass" | "absent puts restart at zero" | "deletes skip the clock" | "overflow wraps" | "value is not forwarded";

export const storage = (bug?: StorageBug) => fun("storage transition")
  .inputs({
    key: nat, any: bool, expected: nat, put: bool, value: nat, identity: nat,
    present: bool, version: nat, highWater: nat,
  })
  .returns(({ key, any, expected, put, value, identity, present, version, highWater }) => {
    const matches = bug === "stale writes pass" ? any.or(any.not()) : any.or(expected.eq(version));
    const base = when(present, version, bug === "absent puts restart at zero" ? 0 : highWater);
    const before = when(put, base, version);
    const room = bug === "overflow wraps" ? before.atMost(REVISION_MAX) : before.lt(REVISION_MAX).and(highWater.lt(REVISION_MAX));
    const unchanged = put.not().and(present.not());
    const plan = when(matches.not(), CONFLICT, when(unchanged, UNCHANGED, when(room.not(), EXHAUSTED, when(put, PUT_NEXT, DELETE_NEXT))));
    const moved = matches.and(unchanged.not(), room);
    return {
      plan,
      key: when(moved, key, 0),
      value: when(moved.and(put), bug === "value is not forwarded" ? identity : value, 0),
      identity: when(moved.and(put), identity, 0),
      version: when(moved, before.plus(1), 0),
      highWater: when(moved, bug === "deletes skip the clock" ? when(put, highWater.plus(1), highWater) : highWater.plus(1), 0),
    };
  });

export const storageKernels = (bug?: StorageBug): Kernel[] => {
  const f = storage(bug);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const CAS = (e: any) => e.any.or(e.expected.eq(e.version));
  const Room = (v: any) => v.lt(REVISION_MAX);
  const Base = (e: any) => when(e.present, e.version, e.highWater);
  return [{
    id: "storageTransition",
    fun: f,
    decisions: [
      f.law("storage_safe: an unchanged plan is an admitted delete of an absent key", () => [], (o, e) =>
        o.plan.eq(UNCHANGED).implies(all(CAS(e), e.put.not(), e.present.not()))),
      f.law("storage_safe: a put forwards its key, value and identity exactly, at the successors of its base and of the clock", () => [], (o, e) =>
        o.plan.eq(PUT_NEXT).implies(all(CAS(e), e.put, Room(Base(e)), Room(e.highWater), o.key.eq(e.key), o.value.eq(e.value), o.identity.eq(e.identity),
          o.version.eq(Base(e).plus(1)), o.highWater.eq(e.highWater.plus(1))))),
      f.law("storage_safe: a delete forwards its key from a present slot, at the successors of its version and of the clock", () => [], (o, e) =>
        o.plan.eq(DELETE_NEXT).implies(all(CAS(e), e.put.not(), e.present, Room(e.version), Room(e.highWater), o.key.eq(e.key),
          o.version.eq(e.version.plus(1)), o.highWater.eq(e.highWater.plus(1))))),
      f.law("storage_put_complete: an admitted put with room is written", (e) => [CAS(e), e.put, Room(Base(e)), Room(e.highWater)], (o, e) =>
        all(o.plan.eq(PUT_NEXT), o.key.eq(e.key), o.value.eq(e.value), o.identity.eq(e.identity), o.version.eq(Base(e).plus(1)), o.highWater.eq(e.highWater.plus(1)))),
      f.law("storage_delete_complete: an admitted delete of a present key with room is applied", (e) => [CAS(e), e.put.not(), e.present, Room(e.version), Room(e.highWater)], (o, e) =>
        all(o.plan.eq(DELETE_NEXT), o.key.eq(e.key), o.version.eq(e.version.plus(1)), o.highWater.eq(e.highWater.plus(1)))),
      f.law("storage_absent_delete_complete: an admitted delete of an absent key changes nothing", (e) => [CAS(e), e.put.not(), e.present.not()], (o) => o.plan.eq(UNCHANGED)),
      f.law("storage_stale_refused: an expected revision other than the actual one is a conflict", (e) => [e.any.not(), e.expected.ne(e.version)], (o) => o.plan.eq(CONFLICT)),
      f.law("storage_put_overflow: an admitted put without room is exhausted", (e) => [CAS(e), e.put, Room(Base(e)).and(Room(e.highWater)).not()], (o) => o.plan.eq(EXHAUSTED)),
      f.law("storage_delete_overflow: an admitted delete of a present key without room is exhausted", (e) => [CAS(e), e.put.not(), e.present, Room(e.version).and(Room(e.highWater)).not()], (o) => o.plan.eq(EXHAUSTED)),
    ],
  }];
};
export const STORAGE_BUGS: StorageBug[] = ["stale writes pass", "absent puts restart at zero", "deletes skip the clock", "overflow wraps", "value is not forwarded"];
