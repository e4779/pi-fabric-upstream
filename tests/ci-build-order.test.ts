import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(fs.readFileSync(fileURLToPath(new URL("../.github/workflows/test.yml", import.meta.url)), "utf8"));
const steps = workflow.jobs.check.steps as Array<{ name?: string; run?: string }>;

describe("CI build prerequisites", () => {
  it("builds the published workers before every test step", () => {
    const build = steps.findIndex((step) => step.run === "bun run build");
    const tests = steps.flatMap((step, index) => /^(bunx vitest|bun run test:)/.test(step.run ?? "") ? [index] : []);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(tests.length).toBeGreaterThan(0);
    for (const index of tests) expect(build, `build must precede ${steps[index]!.name}`).toBeLessThan(index);
  });

  it("proves the kernels with the receipt's pinned gdp-wired before building", () => {
    const { prover } = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../src/verified/generated/manifest.json", import.meta.url)), "utf8")) as { prover: string };
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { devDependencies: Record<string, string> };
    expect(prover).toBe(`gdp-wired@${pkg.devDependencies["gdp-wired"]}`);
    const proof = steps.findIndex((step) => step.run === "bun run proof:check");
    expect(proof).toBeGreaterThanOrEqual(0);
    expect(proof).toBeLessThan(steps.findIndex((step) => step.run === "bun run build"));
    expect(steps.some((step) => /bendlang|bend\.tar/.test(step.run ?? ""))).toBe(false);
  });

  it("refreshes apt metadata before installing Linux runtime prerequisites", () => {
    const prerequisites = steps.find((step) => step.name === "Install runtime prerequisites")?.run ?? "";
    const update = prerequisites.indexOf("sudo apt-get update");
    const install = prerequisites.indexOf("sudo apt-get install");
    expect(update).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(update);
  });

  it("lets both platforms finish when one fails", () => {
    expect(workflow.jobs.check.strategy["fail-fast"]).toBe(false);
    expect(workflow.jobs.check.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
  });
});
