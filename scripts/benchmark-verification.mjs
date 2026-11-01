#!/usr/bin/env node
// Bounded paired measurements, not a full-suite benchmark. Run on one Modal cell.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "--proofs";
if (process.argv.length > 3 || !["--proofs", "--ci-tests", "--help"].includes(mode)) throw new Error("Usage: node scripts/benchmark-verification.mjs [--proofs|--ci-tests|--help]");
if (mode === "--help") {
  console.log("--proofs: complete proof:check with 1 versus 4 workers; --ci-tests: identical fixed CI suites in 3 versus 1 Vitest launches. No retries or full-suite fallback.");
  process.exit(0);
}
const fixed = ["verified-kernels", "verified-resources", "verified-providers", "verified-authority", "verified-lifecycle", "verified-storage", "verified-grants", "verified-speculation", "verified-budget", "verified-artifact", "verified-proof-scope", "verified-kernel-pool"].map(name => `tests/${name}.test.ts`);
const workflow = ["tests/ci-workflows.test.ts"], python = ["tests/kernel-errors.test.ts"];
const vitest = files => ["bunx", ["vitest", "run", ...files]];
const cases = mode === "--proofs" ? [
  { label: "proof-serial", commands: [["bun", ["run", "proof:check", "--jobs", "1"]]] },
  { label: "proof-parallel", commands: [["bun", ["run", "proof:check", "--jobs", "4"]]] },
] : [
  { label: "fixed-ci-separate", commands: [vitest(workflow), vitest(python), vitest(fixed)] },
  { label: "fixed-ci-combined", commands: [vitest([...workflow, ...python, ...fixed])] },
];
const receipt = () => readFileSync(new URL("../src/verified/generated/manifest.json", import.meta.url), "utf8");
const before = receipt();
const measurements = [];
for (const item of cases) {
  const started = performance.now();
  for (const [command, args] of item.commands) {
    // Each comparison has a fixed budget and no retries. On failure, retain
    // diagnostics and stop instead of printing a partial timing as a success.
    const output = execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(output);
  }
  assert.equal(receipt(), before, "Verification unexpectedly rewrote its policy receipt");
  measurements.push({ label: item.label, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), launches: item.commands.length });
}
console.log(JSON.stringify({ kind: "verification-wall-time", platform: process.platform, arch: process.arch, measurements, reductionPercent: Number((100 * (1 - measurements[1].seconds / measurements[0].seconds)).toFixed(1)) }));
