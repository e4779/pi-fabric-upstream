import { beforeEach, describe, expect, it, vi } from "vitest";
import { prove, type Kernel } from "../proofs/kernel.js";

const prover = vi.hoisted(() => ({ proveSteps: vi.fn(), proveDecision: vi.fn() }));
vi.mock("gdp-wired", () => prover);

const ruleKernel: Kernel = {
  id: "scope",
  rule: {} as NonNullable<Kernel["rule"]>,
  stepLaws: [{ name: "scope" } as NonNullable<Kernel["stepLaws"]>[number]],
};
const decisionKernel: Kernel = {
  id: "decision",
  decisions: [{ name: "scope" } as NonNullable<Kernel["decisions"]>[number]],
};

beforeEach(() => vi.resetAllMocks());

it("requests every allowed state while leaving search enabled", () => {
  prover.proveSteps.mockReturnValue({ proven: true, checked: true });
  prove(ruleKernel);
  expect(prover.proveSteps).toHaveBeenCalledWith(ruleKernel.rule, [], ruleKernel.stepLaws, { from: "any" });
});

describe.each([
  { kind: "rule", kernel: ruleKernel, mock: prover.proveSteps },
  { kind: "decision", kernel: decisionKernel, mock: prover.proveDecision },
])("$kind verdict acceptance", ({ kernel, mock }) => {
  it("accepts checked proofs with found lemmas and no reachability assumptions", () => {
    mock.mockReturnValue({ proven: true, checked: true, found: { lemmas: { helper: { lemmas: ["universal"] } } } });
    expect(prove(kernel)[0]).toMatchObject({ proven: true, checked: true, detail: undefined });
  });

  it("rejects a proven claim whose certificate was not checked", () => {
    mock.mockReturnValue({ proven: true, checked: false });
    expect(prove(kernel)[0]).toMatchObject({ proven: false, checked: false, detail: "not checked by the kernel" });
  });

  it("rejects checked proofs that assume reachable states", () => {
    mock.mockReturnValue({ proven: true, checked: true, assumes: { states: "reachable", laws: ["only from init"] } });
    const verdict = prove(kernel)[0]!;
    expect(verdict.proven).toBe(false);
    expect(verdict.detail).toContain("proven only from reachable states");
    expect(verdict.detail).toContain("only from init");
  });

  it("keeps a refutation and its diagnostics unproven", () => {
    mock.mockReturnValue({ proven: false, checked: false, stuck: "sat", goal: "scope @step", why: "witness" });
    expect(prove(kernel)[0]).toMatchObject({ proven: false, stuck: "sat", detail: "scope @step sat witness" });
  });
});
