import { parentPort } from "node:worker_threads";
import { crossCheckDecision } from "gdp-wired";
import { compileJs } from "gdp-wired/machine";
import { modules } from "../proofs/index.js";
import { prove } from "../proofs/kernel.js";

export type ProofTask = { stem: string; kind: "kernel"; id: string } | { stem: string; kind: "mutations" };
export type ProofResult = { stem: string; failures: string[]; seconds: number } & (
  { kind: "kernel"; id: string; claims: string[]; compiled: string } |
  { kind: "mutations"; refused: number }
);

function evaluate(task: ProofTask): ProofResult {
  const started = performance.now();
  const module = modules.find(module => module.stem === task.stem);
  if (!module) throw new Error(`Unregistered kernel module ${task.stem}`);
  const kernels = module.kernels();
  const compiled = (kernel: (typeof kernels)[number]) => compileJs((kernel.rule ?? kernel.fun?.rule)!.machine);
  const failures: string[] = [];
  if (task.kind === "mutations") {
    const shipped = new Map(kernels.map(kernel => [kernel.id, compiled(kernel)]));
    let refused = 0;
    for (const bug of module.bugs) {
      // Identical machines were proved by the required kernel jobs. Skipping
      // them cannot introduce a false refusal of a changed broken machine.
      // Preserve upstream's stronger refusal: a counterexample, not a timeout.
      const rejected = module.kernels(bug).some(kernel => compiled(kernel) !== shipped.get(kernel.id) && prove(kernel).some(verdict => !verdict.proven && verdict.stuck === "sat"));
      if (rejected) refused++;
      else failures.push(`${module.stem}: broken variant "${bug}" was not refused`);
    }
    return { stem: task.stem, kind: task.kind, refused, failures, seconds: (performance.now() - started) / 1000 };
  }
  const kernel = kernels.find(kernel => kernel.id === task.id);
  if (!kernel) throw new Error(`Unregistered kernel ${task.stem}.${task.id}`);
  const claims: string[] = [];
  // Never split invariant contexts: use precisely the existing whole-kernel prover.
  for (const verdict of prove(kernel)) {
    claims.push(verdict.claim);
    if (!(verdict.proven && verdict.checked)) failures.push(`${verdict.claim}: ${verdict.detail ?? "not checked by the kernel"}`);
  }
  const rule = kernel.rule ?? kernel.fun?.rule;
  if (rule) {
    const replay = rule.crossCheck(kernel.laws ?? [], kernel.stepLaws ?? []);
    if (replay.failure) failures.push(`${kernel.id}: builders disagree with the interpreter: ${replay.failure}`);
  }
  for (const decision of kernel.decisions ?? []) {
    const replay = crossCheckDecision(decision);
    if (replay.failure) failures.push(`${kernel.id}: ${decision.name}: builders disagree with the interpreter: ${replay.failure}`);
  }
  if (kernel.chart) {
    const report = kernel.chart.check();
    const unreached = Object.entries(report.reached).filter(([, run]) => typeof run === "string").map(([state]) => state);
    if (!report.ok) failures.push(`${kernel.id}: chart check failed (unreached: ${unreached.join(", ") || "none"}; stuck: ${report.stuck.join(", ") || "none"}; ambiguous: ${report.ambiguous.map(a => a.event).join(", ") || "none"})`);
  }
  return { stem: task.stem, kind: task.kind, id: task.id, claims, compiled: compiled(kernel), failures, seconds: (performance.now() - started) / 1000 };
}

if (!parentPort) throw new Error("Proof worker must run in an isolated worker thread");
parentPort.on("message", ({ index, task }: { index: number; task: ProofTask }) => {
  parentPort!.postMessage({ index, result: evaluate(task) });
});
