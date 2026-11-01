import { bit } from "./machine.js";
import { bindingStep as lifecycleMachine } from "./generated/lifecycle.js";

const PHASES = ["Staged", "Active", "Retiring", "Closing", "Closed", "Failed"] as const;
const EVENTS = ["Inspect", "Activate", "Retire", "DropOwner", "Revoke", "Retain", "Release", "Begin", "End", "Shut", "Complete", "Abort"] as const;
const COMMANDS = ["Denied", "Granted", "StartClose"] as const;

export type BindingPhase = { $: (typeof PHASES)[number] };
export interface BindingLife { $: "Life"; phase: BindingPhase; owner: boolean; holds: number; calls: number; revoked: boolean }
export type BindingEvent = { $: "Inspect" | "Activate" | "Retire" | "DropOwner" | "Revoke" | "Release" | "End" | "Shut" | "Complete" | "Abort" } | { $: "Retain" | "Begin"; cleanup: boolean };
export interface BindingOutcome { $: "Outcome"; next: BindingLife; command: { $: (typeof COMMANDS)[number] } }

const index = <T extends string>(values: readonly T[], value: T, what: string): number => {
  const i = values.indexOf(value);
  if (i < 0) throw new Error(`Invalid verified ${what}: ${value}`);
  return i;
};
const named = <T extends string>(values: readonly T[], i: number | undefined, what: string): T => {
  const value = i === undefined ? undefined : values[i];
  if (value === undefined) throw new Error(`Invalid verified ${what} index ${i}`);
  return value;
};
const flag = (value: number | undefined): boolean => {
  if (value !== 0 && value !== 1) throw new Error("Invalid verified lifecycle flag");
  return value === 1;
};

/** Trusted codec around the compiled lifecycle reducer: the life record is the
 * machine state, and the event and its cleanup bit are the request. */
export const bindingStep = (life: BindingLife, event: BindingEvent): BindingOutcome => {
  const state = {
    scalars: {
      phase: index(PHASES, life.phase.$, "phase"), owner: bit(life.owner), holds: life.holds,
      calls: life.calls, revoked: bit(life.revoked), command: 0,
    },
    maps: {},
  };
  const next = lifecycleMachine.step({}, state, {
    event: index(EVENTS, event.$, "event"), cleanup: bit("cleanup" in event && event.cleanup),
  }).scalars;
  return {
    $: "Outcome",
    next: {
      $: "Life", phase: { $: named(PHASES, next.phase, "phase") }, owner: flag(next.owner),
      holds: next.holds!, calls: next.calls!, revoked: flag(next.revoked),
    },
    command: { $: named(COMMANDS, next.command, "command") },
  };
};
