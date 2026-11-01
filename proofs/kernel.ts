// One registered kernel: the rule or function that ships, with every claim made
// about it. The generator proves each claim, then emits the compiled machine.
import { proveDecision, proveSteps, type Fun } from "gdp-wired";
import type { Decision } from "gdp-wired";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRule = Parameters<typeof proveSteps>[0];
type Law = Parameters<typeof proveSteps>[1][number];
type StepLaw = Parameters<typeof proveSteps>[2][number];

export interface Kernel {
  /** The export name of the compiled machine in the generated module. */
  readonly id: string;
  readonly fun?: Fun<any, any, any>;
  readonly rule?: AnyRule;
  readonly laws?: Law[];
  readonly stepLaws?: StepLaw[];
  readonly decisions?: Decision[];
  /** A statechart the rule compiles from: its check must reach every state, with none stuck and no event ambiguous. */
  readonly chart?: { check(): { ok: boolean; stuck: string[]; ambiguous: { event: string }[]; reached: Record<string, unknown> } };
}

export interface Verdict { readonly claim: string; readonly proven: boolean; readonly checked: boolean; readonly stuck?: string | undefined; readonly detail?: string | undefined }

export const prove = (kernel: Kernel): Verdict[] => {
  const verdicts: Verdict[] = [];
  const rule = kernel.rule;
  if (rule && (kernel.laws?.length || kernel.stepLaws?.length)) {
    // Fabric steps these machines from host-supplied states, so prove from every state the laws allow.
    // Search can still find breaking runs and state-independent lemmas; reachable-only proofs are not accepted.
    const v = proveSteps(rule, kernel.laws ?? [], kernel.stepLaws ?? [], { from: "any" });
    const proven = v.proven && v.checked && !v.assumes;
    const names = [...(kernel.laws ?? []), ...(kernel.stepLaws ?? [])].map((law) => law.name).join("; ");
    verdicts.push({ claim: `${kernel.id}: ${names}`, proven, checked: v.checked, stuck: v.stuck,
      detail: proven ? undefined : v.assumes ? `proven only from reachable states: ${JSON.stringify(v.assumes)}` : `${v.goal ?? ""} ${v.stuck ?? ""} ${v.why ?? ""}`.trim() || "not checked by the kernel" });
  }
  for (const decision of kernel.decisions ?? []) {
    const v = proveDecision(decision);
    const proven = v.proven && v.checked && !v.assumes;
    verdicts.push({ claim: `${kernel.id}: ${decision.name}`, proven, checked: v.checked, stuck: v.stuck,
      detail: proven ? undefined : v.assumes ? `proven only from reachable states: ${JSON.stringify(v.assumes)}` : `${v.goal ?? ""} ${v.stuck ?? ""} ${v.why ?? ""}`.trim() || "not checked by the kernel" });
  }
  return verdicts;
};
