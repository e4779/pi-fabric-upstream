import { Interner, bit, idSet, members, type MachineState } from "./machine.js";
import { capabilityAuthority } from "./generated/authority.js";
import type { FabricCapabilityBindingView } from "../protocol.js";

const ISSUE = 0, DERIVE = 1, USE = 2, RELEASE = 3;

/** Trusted codec: JSON's fixed-position string/number tuple preserves ref,
 * provider, binding identity, generation and descriptor identity, and one
 * injective table per authority tree turns each complete tuple into an id.
 * Descriptor hashing itself remains trusted; the kernel proves equality of
 * identities, not hash injectivity. */
const encodeGrant = (grant: Readonly<FabricCapabilityBindingView>): string => JSON.stringify([
  grant.ref, grant.provider, grant.providerBindingId, grant.generation, grant.descriptorHash,
]);

/** Private canonical state behind ActionRegistry's WeakMap-owned public views.
 * Root issuance is a trusted registry operation, not a caller-supplied permission
 * Boolean. The compiled kernel decides derivation/use/release over exact grants.
 * JS identity, WeakMap ownership, binding observations and abort delivery remain trusted.
 */
export class CapabilityAuthority {
  #state: MachineState;
  readonly #names: Interner;
  readonly #grants: ReadonlyMap<string, Readonly<FabricCapabilityBindingView>>;

  private constructor(grants: readonly FabricCapabilityBindingView[], parent?: CapabilityAuthority) {
    const canonical = grants.map(grant => Object.freeze({ ...grant }));
    this.#grants = new Map(canonical.map(grant => [grant.ref, grant]));
    this.#names = parent ? parent.#names : new Interner();
    const candidate = idSet(canonical.map(grant => this.#names.id(encodeGrant(grant))));
    const parentGrants = parent ? idSet(members(parent.#state, "Grants")) : new Map<number, number>();
    this.#state = capabilityAuthority.step({}, capabilityAuthority.init({}), {
      op: parent ? DERIVE : ISSUE, name: 0, parentLive: bit(parent?.active ?? false),
      Candidate: candidate, Parent: parentGrants,
    });
  }

  static issue(grants: readonly FabricCapabilityBindingView[]): CapabilityAuthority {
    return new CapabilityAuthority(grants);
  }

  derive(grants: readonly FabricCapabilityBindingView[]): CapabilityAuthority {
    return new CapabilityAuthority(grants, this);
  }

  get active(): boolean {
    return this.#state.scalars.live === 1;
  }

  release(): void {
    this.#state = capabilityAuthority.step({}, this.#state, { op: RELEASE, name: 0, parentLive: 0, Candidate: new Map(), Parent: new Map() });
  }

  resolve(ref: string): FabricCapabilityBindingView | undefined {
    const grant = this.#grants.get(ref);
    if (!grant) return undefined;
    this.#state = capabilityAuthority.step({}, this.#state, {
      op: USE, name: this.#names.id(encodeGrant(grant)), parentLive: 0, Candidate: new Map(), Parent: new Map(),
    });
    return this.#state.scalars.granted === 1 ? { ...grant } : undefined;
  }

  bindings(): FabricCapabilityBindingView[] {
    return this.active ? [...this.#grants.values()].map(grant => ({ ...grant })) : [];
  }
}
