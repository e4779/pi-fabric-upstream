import { bit, idSet, members } from "./machine.js";
import { resourceScope, resourceConflict, resourceGroups as groupsMachine } from "./generated/resources.js";

/** A resource scope as the host sees it: exact names, or unknown ("*"). */
export interface ResourceScope { readonly exact: boolean; readonly names: readonly string[] }
export interface ResourceEffect { readonly effect: boolean; readonly ordered: boolean; readonly scope: ResourceScope }

const EMPTY = 0, WILDCARD = 1, FIRST = 2;
const UNKNOWN: ResourceScope = Object.freeze({ exact: false, names: Object.freeze([]) as readonly string[] });

/** Trusted codec: one injective table per decision. The empty name (and any
 * non-string resource) is 0, the wildcard is 1, and every other string,
 * NULs and lone surrogates included, gets its own id from 2. Never truncate,
 * hash or normalize Unicode here. */
class ResourceNames {
  readonly #ids = new Map<string, number>();
  readonly #names: string[] = [];
  id(value: unknown): number {
    if (typeof value !== "string" || value === "") return EMPTY;
    if (value === "*") return WILDCARD;
    let id = this.#ids.get(value);
    if (id === undefined) {
      id = FIRST + this.#names.length;
      this.#ids.set(value, id);
      this.#names.push(value);
    }
    return id;
  }
  name(id: number): string {
    const name = this.#names[id - FIRST];
    if (name === undefined) throw new Error(`Invalid verified resource id ${id}`);
    return name;
  }
  /** Each id's complete UTF-16 length, for the kernel's 256-unit bound. */
  lengths(ids: Iterable<number>): Map<number, number> {
    const cells = new Map<number, number>();
    for (const id of ids) if (id >= FIRST) cells.set(id, this.name(id).length);
    return cells;
  }
}

const SOURCE = 0, NORMALIZE = 1;
const step = (names: ResourceNames, state: ReturnType<typeof resourceScope.init>, op: number, values: readonly unknown[]) => {
  const ids = values.map((value) => names.id(value));
  return resourceScope.step({}, state, { op, first: ids[0] ?? EMPTY, Given: idSet(ids), Len: names.lengths(ids) });
};

const decode = (names: ResourceNames, state: ReturnType<typeof resourceScope.init>, order: readonly unknown[]): ResourceScope => {
  if (state.scalars.exact !== 1) return UNKNOWN;
  // Present the kernel's set in declaration order; membership is the kernel's.
  const held = new Set(members(state, "Names"));
  const listed = [...new Set(order.map((value) => names.id(value)))].filter((id) => held.delete(id));
  if (held.size > 0) throw new Error("Verified resource scope names an undeclared resource");
  return { exact: true, names: listed.map((id) => names.name(id)) };
};

/** Interpret a complete declaration: exact when nonempty with no empty or wildcard identity. */
export const resourceSource = (values: readonly unknown[] | undefined): ResourceScope => {
  const declared: unknown[] = Array.isArray(values) ? Array.from(values) : [];
  const names = new ResourceNames();
  return decode(names, step(names, resourceScope.init({}), SOURCE, declared), declared);
};

export const decodeResourceScope = (scope: ResourceScope): string[] => (scope.exact ? [...scope.names] : ["*"]);

/** Check an untrusted proposal against the complete declaration: exact only when
 * the proposal names the same set, at most 64 valid names of at most 256 units. */
export const resourceNormalize = (values: readonly unknown[] | undefined, proposal: readonly unknown[]): ResourceScope => {
  const declared: unknown[] = Array.isArray(values) ? Array.from(values) : [];
  const candidate = Array.from(proposal);
  const names = new ResourceNames();
  // Intern the proposal first: its names take the ids the 64-name window covers.
  for (const value of candidate) names.id(value);
  const source = step(names, resourceScope.init({}), SOURCE, declared);
  return decode(names, step(names, source, NORMALIZE, candidate), candidate);
};

export const boundedEffectResources = (resources: readonly string[] | undefined): string[] => {
  // Capture the entire declaration before running the untrusted proposer.
  const declared: unknown[] = Array.isArray(resources) ? Array.from(resources) : [];
  const proposal = new Set<unknown>();
  for (const resource of declared) {
    proposal.add(resource);
    if (proposal.size > 64) break;
  }
  return decodeResourceScope(resourceNormalize(declared, [...proposal]));
};

export const encodeResourceEffects = (
  effects: readonly { kind: string; ordering: string; resources: readonly string[] }[],
): ResourceEffect[] => effects.map((effect) => effect.kind === "none"
  ? { effect: false, ordered: false, scope: UNKNOWN }
  : { effect: true, ordered: effect.ordering !== "commutative", scope: resourceSource(effect.resources) });

const conflicts = (names: ResourceNames, left: ResourceEffect, right: ResourceEffect): boolean => {
  const state = resourceConflict.step({}, resourceConflict.init({}), {
    leftEffect: bit(left.effect), rightEffect: bit(right.effect),
    leftExact: bit(left.scope.exact), rightExact: bit(right.scope.exact),
    leftOrdered: bit(left.ordered), rightOrdered: bit(right.ordered), witness: EMPTY,
    Left: idSet(left.scope.names.map((name) => names.id(name))),
    Right: idSet(right.scope.names.map((name) => names.id(name))),
  });
  return state.scalars.conflict === 1;
};

/** Effect flags as list cells: one 0/1 map per field, keyed by position. */
const effectCells = (side: readonly ResourceEffect[]) => ({
  effect: new Map(side.map((e, i) => [i, bit(e.effect)])),
  ordered: new Map(side.map((e, i) => [i, bit(e.ordered)])),
  exact: new Map(side.map((e, i) => [i, bit(e.scope.exact)])),
});

/** Each exact scope's names as rows (item, name), where `item` is the effect's
 * position. Rows name an effect of their own side by construction. */
const rowCells = (names: ResourceNames, side: readonly ResourceEffect[]) => {
  const rows = side.flatMap((e, item) => (e.scope.exact ? e.scope.names : []).map((name) => [item, names.id(name)] as const));
  return { len: rows.length, item: new Map(rows.map(([item], p) => [p, item])), name: new Map(rows.map(([, name], p) => [p, name])) };
};

/** Whether any effect on the left conflicts with any effect on the right,
 * decided over every pair by the compiled groups kernel. Both sides' names
 * come from one table, so a name shared across them shares its id. */
export const resourceGroups = (left: readonly ResourceEffect[], right: readonly ResourceEffect[]): boolean => {
  const names = new ResourceNames();
  const L = effectCells(left), R = effectCells(right), LN = rowCells(names, left), RN = rowCells(names, right);
  const state = groupsMachine.step({}, groupsMachine.init({}), {
    L_len: left.length, R_len: right.length, LN_len: LN.len, RN_len: RN.len,
    "L.effect": L.effect, "L.ordered": L.ordered, "L.exact": L.exact,
    "R.effect": R.effect, "R.ordered": R.ordered, "R.exact": R.exact,
    "LN.item": LN.item, "LN.name": LN.name, "RN.item": RN.item, "RN.name": RN.name,
  });
  return state.scalars.conflict === 1;
};

export const resourceConflictOf = (left: ResourceScope, right: ResourceScope, leftOrdered: boolean, rightOrdered: boolean): boolean =>
  conflicts(new ResourceNames(), { effect: true, ordered: leftOrdered, scope: left }, { effect: true, ordered: rightOrdered, scope: right });
