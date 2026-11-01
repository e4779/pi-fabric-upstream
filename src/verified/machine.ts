import type { Machine, MachineState } from "./generated/policy.js";

export type { Machine, MachineState };

/** Trusted codec: Booleans cross the machine boundary as 0/1 naturals. */
export const bit = (value: boolean): number => (value ? 1 : 0);

/** Injective string interning for one machine call. Equal strings share an id;
 * ids are never reused, so identity comparisons in the kernel are exact. */
export class Interner {
  readonly #ids = new Map<string, number>();
  readonly #names: string[] = [];
  constructor(readonly first = 0) {}
  id(name: string): number {
    let id = this.#ids.get(name);
    if (id === undefined) {
      id = this.first + this.#names.length;
      this.#ids.set(name, id);
      this.#names.push(name);
    }
    return id;
  }
  name(id: number): string {
    const name = this.#names[id - this.first];
    if (name === undefined) throw new Error(`Unknown interned id ${id}`);
    return name;
  }
}

/** A set of interned ids as the 0/1 cells a carried machine set reads. */
export const idSet = (ids: Iterable<number>): Map<number, number> => {
  const cells = new Map<number, number>();
  for (const id of ids) cells.set(id, 1);
  return cells;
};

/** The ids a machine map holds, refusing anything but a 0/1 set with a 0 default. */
export const members = (state: MachineState, map: string): number[] => {
  if ((state.defaults?.[map] ?? 0) !== 0) throw new Error(`Verified set ${map} has a nonzero default`);
  const cells = state.maps[map];
  if (!cells) throw new Error(`Verified state has no set ${map}`);
  const ids: number[] = [];
  for (const [id, cell] of cells) {
    if (cell === 1) ids.push(id);
    else if (cell !== 0) throw new Error(`Verified set ${map} holds a non-bit cell`);
  }
  return ids;
};
