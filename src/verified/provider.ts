import { Interner, bit } from "./machine.js";
import { providerTicket } from "./generated/provider.js";

/** A one-use ticket. Grant key, expected revision and payload slot are opaque strings. */
export interface ProviderTicket { readonly active: boolean; readonly key: string; readonly expected: string; readonly payload: string }
export type ProviderPlan = { readonly $: "Denied" } | { readonly $: "Write"; readonly key: string; readonly expected: string; readonly value: string };

const TAKE = 0, REVOKE = 1, WRITE = 1;

const run = (ticket: ProviderTicket, op: number, key = "", observed = "", stopped = false) => {
  // Ids start at 1 so the machine's 0 never names a string.
  const names = new Interner(1);
  const state = {
    scalars: {
      active: bit(ticket.active), grantKey: names.id(ticket.key), expected: names.id(ticket.expected),
      payload: names.id(ticket.payload), plan: 0, planKey: 0, planExpected: 0, planValue: 0,
    },
    maps: {},
  };
  const next = providerTicket.step({}, state, { op, key: names.id(key), observed: names.id(observed), stopped: bit(stopped) }).scalars;
  const after: ProviderTicket = {
    active: next.active === 1, key: names.name(next.grantKey!), expected: names.name(next.expected!), payload: names.name(next.payload!),
  };
  const plan: ProviderPlan = next.plan === WRITE
    ? { $: "Write", key: names.name(next.planKey!), expected: names.name(next.planExpected!), value: names.name(next.planValue!) }
    : { $: "Denied" };
  return { next: after, plan };
};

/** Consume the ticket and plan its write, when the live grant names this key at the expected revision. */
export const providerTake = (ticket: ProviderTicket, key: string, observed: string, stopped: boolean): { next: ProviderTicket; plan: ProviderPlan } =>
  run(ticket, TAKE, key, observed, stopped);

export const providerRevoke = (ticket: ProviderTicket): ProviderTicket => run(ticket, REVOKE).next;
