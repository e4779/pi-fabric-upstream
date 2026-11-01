import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
const workflowDirectory = fileURLToPath(new URL(".github/workflows/", root));
const workflows = fs.readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name));

describe("CI Node runtime prerequisites", () => {
  it("runs Python diagnostics with an explicit modern interpreter on both platforms", () => {
    const workflow = parse(fs.readFileSync(new URL(".github/workflows/test.yml", root), "utf8"));
    const { steps, strategy } = workflow.jobs.check;
    expect(strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    const setup = steps.findIndex((step: Step) => step.uses?.startsWith("actions/setup-python@"));
    const diagnostics = steps.findIndex((step: Step) => step.run?.startsWith("bunx vitest run ") && step.run.split(/\s+/).includes("tests/kernel-errors.test.ts"));
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(steps[setup].with["python-version"]).toBe("3.14");
    expect(steps[setup].if).toBeUndefined();
    expect(diagnostics).toBeGreaterThan(setup);
    expect(steps[diagnostics].if).toBeUndefined();
    const prerequisites = steps.find((step: Step) => step.run?.includes("choco install ripgrep"));
    expect(prerequisites.run).toContain("mkdir -p /tmp");
  });

  it("keeps every fixed assurance floor unconditional in one Vitest launch", () => {
    const workflow = parse(fs.readFileSync(new URL(".github/workflows/test.yml", root), "utf8"));
    const steps = workflow.jobs.check.steps as Step[];
    const required = ["ci-workflows", "kernel-errors", "verified-kernels", "verified-resources", "verified-providers", "verified-authority", "verified-lifecycle", "verified-storage", "verified-grants", "verified-speculation", "verified-budget", "verified-artifact", "verified-proof-scope", "verified-kernel-pool"];
    const batches = steps.filter(step => step.run?.startsWith("bunx vitest run ") && step.run.includes("tests/verified-kernels.test.ts"));
    expect(batches).toHaveLength(1); expect(batches[0]!.if).toBeUndefined();
    const files = batches[0]!.run!.split(/\s+/).slice(3);
    expect(files).toHaveLength(required.length);
    for (const name of required) expect(files.filter(file => file === `tests/${name}.test.ts`)).toHaveLength(1);
  });

  it.each(workflows)("%s configures the declared Node runtime before install and execution", (file) => {
    const workflow = parse(fs.readFileSync(new URL(`.github/workflows/${file}`, root), "utf8")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
      const executions = steps.flatMap((step, index) => /\b(?:node|bun|bunx)\s/.test(step.run ?? "") ? [index] : []);
      if (executions.length === 0) continue;
      const setup = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setup, `${file}:${job} must set up Node, not rely on the runner default`).toBeGreaterThanOrEqual(0);
      const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout).toBeGreaterThanOrEqual(0);
      expect(checkout).toBeLessThan(setup);
      expect(manifest.engines.node).toBeTruthy();
      expect(steps[setup]!.with?.["node-version-file"]).toBe("package.json");
      expect(steps[setup]!.with?.["node-version"]).toBeUndefined();
      expect(steps[setup]!.if).toBeUndefined();
      for (const index of executions) {
        expect(setup, `${file}:${job} must set up Node before ${steps[index]!.run}`).toBeLessThan(index);
      }
    }
  });
});
