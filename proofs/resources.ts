// Effect resource scopes. A resource name is interned to a natural: 0 is the
// empty (or malformed) name, 1 is the wildcard "*", and every other string gets
// its own id. A scope is a set of ids; `Len` carries each name's UTF-16 length.
// The codec interns a proposal's names first, so ids 2..65 hold up to 64 names.
import { all, bool, everyKey, forall, nat, oneOf, record, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export const EMPTY = 0, WILDCARD = 1, LIMIT = 64, NAMES = 2 + LIMIT, LENGTH = 256;

export type ResourceBug =
  | "skips backward coverage" | "admits the wildcard" | "keeps an unknown source"
  | "admits long names" | "ignores the bound" | "commutative effects conflict" | "unknown scopes are independent"
  | "pairs only the diagonal" | "skips the last left effect" | "checks only the first right effect" | "checks one side against itself";

/* eslint-disable @typescript-eslint/no-explicit-any */
const same = (a: any, b: any) => everyKey((k) => a.at(k).eq(b.at(k)));

export const scope = (bug?: ResourceBug) => rule("resource scope")
  .inputs({ op: oneOf("source", "normalize"), first: nat })
  .state({ exact: 0 })
  .maps({ Names: 0 })
  .carries("Given", "Len")
  .flags(({ Given, Len, Names }) => ({
    bits: everyKey((k) => Given.at(k).atMost(1)),
    identities: everyKey((k) => Given.has(k).implies(k.ne(EMPTY).and(bug === "admits the wildcard" ? yes : k.ne(WILDCARD)))),
    // One condition per key: the candidate names exactly the scope, and each
    // name is a valid identity within the 64-name window and 256 code units.
    fits: everyKey((k) => (bug === "skips backward coverage" ? Names.has(k).implies(Given.has(k)) : Given.has(k).iff(Names.has(k)))
      .and(Given.has(k).implies(all(k.ne(EMPTY), k.ne(WILDCARD), bug === "ignores the bound" ? yes : k.lt(NAMES), bug === "admits long names" ? yes : Len.at(k).atMost(LENGTH))))),
  }))
  // The specification's recheck: the proposal is the current scope, each name
  // within 256 code units. Stated apart from `fits`; the step never reads them.
  .flags(({ Given, Len, Names }) => ({
    unchanged: everyKey((k) => Given.at(k).eq(Names.at(k))),
    short: everyKey((k) => Given.has(k).implies(Len.at(k).atMost(LENGTH))),
  }))
  .flags(({ op, exact, first, Given, identities, fits }) => ({
    accepted: Given.has(first).and(op.match({
      source: () => identities,
      normalize: () => (bug === "keeps an unknown source" ? yes : exact.eq(1)).and(fits),
    })),
  }))
  .assume(({ bits }) => bits)
  .step(({ accepted, Given, Names }) => ({
    exact: when(accepted, 1, 0),
    Names: Names.each((k) => when(accepted, Given.at(k), 0)),
  }));

export const conflict = (bug?: ResourceBug) => rule("resource conflict")
  // `witness` names a shared resource for the completeness law; the step never reads it.
  .inputs({ leftEffect: bool, rightEffect: bool, leftExact: bool, rightExact: bool, leftOrdered: bool, rightOrdered: bool, witness: nat })
  .state({ conflict: 0 })
  .carries("Left", "Right")
  .flags(({ Left, Right }) => ({
    bits: everyKey((k) => Left.at(k).atMost(1).and(Right.at(k).atMost(1))),
    shared: Left.disjointFrom(Right).not(),
    // The specification's disjointness, stated apart from `shared`; the step never reads it.
    apart: everyKey((k) => Left.has(k).implies(Right.has(k).not())),
  }))
  .assume(({ bits }) => bits)
  .step(({ leftEffect, rightEffect, leftExact, rightExact, leftOrdered, rightOrdered, shared }) => ({
    conflict: when(all(leftEffect, rightEffect, bug === "commutative effects conflict" ? yes : leftOrdered.or(rightOrdered),
      bug === "unknown scopes are independent" ? leftExact.and(rightExact, shared) : leftExact.and(rightExact).not().or(shared)), 1, 0),
  }));

// Two components' effects, decided over every pair at once. Each side is a list
// of effects plus rows (item, name) for its exact scopes, where `item` is the
// effect's position in its list: a row reads its effect at the position it
// names, so which name belongs to which effect is the request's own data.
// The codec names both sides' rows from one shared table.
const Effect = record({ effect: bool, ordered: bool, exact: bool });
const Row = record({ item: nat, name: nat });
export const groups = (bug?: ResourceBug) => rule("resource groups")
  .carriesList("L", Effect).carriesList("R", Effect).carriesList("LN", Row).carriesList("RN", Row)
  .state({ conflict: 0 })
  .flags(({ L, R, LN, RN }) => {
    const right = bug === "checks one side against itself" ? L : R, rightN = bug === "checks one side against itself" ? LN : RN;
    const ordered = (l: any, r: any) => all(l.effect, r.effect, l.ordered.or(r.ordered));
    return {
      // Every row names an effect of its group.
      rows: everyKey((p) => p.lt(LN.len).implies(LN.at(p).item.lt(L.len))).and(everyKey((q) => q.lt(RN.len).implies(RN.at(q).item.lt(R.len)))),
      // No ordered pair of effects with an unknown scope.
      known: everyKey((i, j) => all(i.lt(bug === "skips the last left effect" ? L.len.minus(1) : L.len), j.lt(bug === "checks only the first right effect" ? 1 : right.len),
        bug === "pairs only the diagonal" ? i.eq(j) : yes)
        .implies(all(ordered(L.at(i), right.at(j)), L.at(i).exact.and(right.at(j).exact).not()).not())),
      // No ordered pair of effects naming one resource.
      unshared: everyKey((p, q) => all(p.lt(LN.len), q.lt(rightN.len), LN.at(p).name.eq(rightN.at(q).name),
        bug === "pairs only the diagonal" ? LN.at(p).item.eq(rightN.at(q).item) : yes)
        .implies(ordered(L.at(LN.at(p).item), right.at(rightN.at(q).item)).not())),
    };
  })
  .assume(({ rows }) => rows)
  .step(({ known, unshared }) => ({ conflict: when(known.and(unshared), 0, 1) }));

export const resourceKernels = (bug?: ResourceBug): Kernel[] => {
  const s = scope(bug), c = conflict(bug), g = groups(bug);
  const valid = (Names: any, first: any) => Names.has(first).and(everyKey((k) => Names.has(k).implies(k.ne(EMPTY).and(k.ne(WILDCARD)))));
  return [{
    id: "resourceScope",
    rule: s,
    laws: [s.law("scope names are a set", ({ Names }) => everyKey((k) => Names.at(k).atMost(1)))],
    stepLaws: [
      s.stepLaw("resource_source_refinement: an exact source keeps every declared name, and only those",
        ({ Given }, a) => a.exact.eq(1).implies(same(a.Names, Given)), ({ op }) => op.is("source")),
      s.stepLaw("resource_source_valid: an exact source is nonempty, with no empty or wildcard identity",
        ({ first }, a) => valid(a.Names, first), ({ op, accepted }) => op.is("source").and(accepted)),
      s.stepLaw("resource_source_complete: every nonempty source of valid identities is exact",
        ({ Given }, a) => a.exact.eq(1).and(same(a.Names, Given)), ({ op, first, Given, identities }) => op.is("source").and(Given.has(first), identities)),
      s.stepLaw("resource_refinement: normalization keeps a scope's names in both directions or widens it to unknown",
        ({ exact, Names }, a) => a.exact.eq(1).implies(exact.eq(1).and(same(a.Names, Names))), ({ op }) => op.is("normalize")),
      s.stepLaw("resource_output_valid: an exact normal form is nonempty, at most 64 valid names of at most 256 code units",
        ({ first, Len }, a) => valid(a.Names, first).and(everyKey((k) => a.Names.has(k).implies(k.atLeast(2).and(k.lt(NAMES), Len.at(k).atMost(LENGTH))))),
        ({ op, accepted }) => op.is("normalize").and(accepted)),
      s.stepLaw("resource_unknown: a refused scope is unknown and names nothing",
        (_, a) => a.exact.eq(0).and(everyKey((k) => a.Names.at(k).eq(0))), ({ accepted }) => accepted.not()),
      s.stepLaw("resource_precision: a valid bounded set-equivalent proposal is accepted as given (so the identity proposal is unchanged)",
        ({ Given }, a) => a.exact.eq(1).and(same(a.Names, Given)), ({ op, exact, first, Given, fits }) => op.is("normalize").and(exact.eq(1), Given.has(first), fits)),
      s.stepsLaw("resource_recheck_idempotent: rechecking a normal form against itself keeps it", 2,
        ({ Given }, last) => last.exact.eq(1).and(same(last.Names, Given)),
        ({ op, accepted, first, Given, unchanged, short }, j) => (j === 0 ? op.is("normalize").and(accepted) : op.is("normalize").and(unchanged, short, Given.has(first)))),
    ],
  }, {
    id: "resourceConflict",
    rule: c,
    stepLaws: [
      c.stepLaw("resource_pair_sound: quiet effects never conflict, nor do two commutative ones",
        (_, a) => a.conflict.eq(0), ({ leftEffect, rightEffect, leftOrdered, rightOrdered }) => leftEffect.and(rightEffect, leftOrdered.or(rightOrdered)).not()),
      c.stepLaw("resource_conflict_exact: exact disjoint scopes never conflict",
        (_, a) => a.conflict.eq(0), ({ leftExact, rightExact, apart }) => all(leftExact, rightExact, apart)),
      c.stepLaw("resource_conflict_complete: an ordered pair of effects with an unknown scope conflicts",
        (_, a) => a.conflict.eq(1), ({ leftEffect, rightEffect, leftOrdered, rightOrdered, leftExact, rightExact }) =>
          all(leftEffect, rightEffect, leftOrdered.or(rightOrdered), leftExact.and(rightExact).not())),
      c.stepLaw("resource_pair_complete: an ordered pair of effects sharing a named resource conflicts",
        (_, a) => a.conflict.eq(1), ({ leftEffect, rightEffect, leftOrdered, rightOrdered, witness, Left, Right }) =>
          all(leftEffect, rightEffect, leftOrdered.or(rightOrdered), Left.has(witness), Right.has(witness))),
    ],
  }, {
    id: "resourceGroups",
    rule: g,
    stepLaws: [
      g.stepLaw("resource_groups_known: independent groups have no ordered pair of effects with an unknown scope",
        ({ L, R }, a) => forall((i, j) => all(a.conflict.eq(0), i.lt(L.len), j.lt(R.len), L.at(i).effect, R.at(j).effect, L.at(i).ordered.or(R.at(j).ordered))
          .implies(L.at(i).exact.and(R.at(j).exact)))),
      g.stepLaw("resource_groups_unshared: independent groups have no ordered pair of effects naming one resource",
        ({ L, R, LN, RN }, a) => forall((p, q) => all(a.conflict.eq(0), p.lt(LN.len), q.lt(RN.len), LN.at(p).name.eq(RN.at(q).name), L.at(LN.at(p).item).effect, R.at(RN.at(q).item).effect)
          .implies(L.at(LN.at(p).item).ordered.or(R.at(RN.at(q).item).ordered).not()))),
      g.stepLaw("resource_groups_unknown_complete: an ordered pair of effects with an unknown scope makes the groups conflict",
        ({ L, R }, a) => forall((i, j) => all(i.lt(L.len), j.lt(R.len), L.at(i).effect, R.at(j).effect, L.at(i).ordered.or(R.at(j).ordered), L.at(i).exact.and(R.at(j).exact).not())
          .implies(a.conflict.eq(1)))),
      g.stepLaw("resource_groups_shared_complete: an ordered pair of effects naming one resource makes the groups conflict",
        ({ L, R, LN, RN }, a) => forall((p, q) => all(p.lt(LN.len), q.lt(RN.len), LN.at(p).name.eq(RN.at(q).name), L.at(LN.at(p).item).effect, R.at(RN.at(q).item).effect,
          L.at(LN.at(p).item).ordered.or(R.at(RN.at(q).item).ordered)).implies(a.conflict.eq(1)))),
    ],
  }];
};
export const RESOURCE_BUGS: ResourceBug[] = [
  "skips backward coverage", "admits the wildcard", "keeps an unknown source", "admits long names",
  "ignores the bound", "commutative effects conflict", "unknown scopes are independent",
  "pairs only the diagonal", "skips the last left effect", "checks only the first right effect", "checks one side against itself",
];
