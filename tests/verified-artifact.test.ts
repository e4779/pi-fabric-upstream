import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("verified kernel artifact receipt", () => {
  it("checks without the prover and rejects source, executable, pin and receipt drift", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-proof-artifact-"));
    temporary.push(dir);
    const manifestPath = "src/verified/generated/manifest.json";
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), "utf8")) as { inputs: Record<string, string>; outputs: Record<string, string> };
    for (const file of [...Object.keys(manifest.inputs), manifestPath, "package.json", ...Object.keys(manifest.outputs)]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    // No node_modules: the artifact check must never load gdp-wired.
    const script = path.join(dir, "scripts/verified-kernels.ts");
    const options = { encoding: "utf8" as const, timeout: 20_000 };
    expect(execFileSync("bun", [script, "--artifact"], options)).toContain("matches its proof sources");
    const pinned = (text: string) => text.replace(/"gdp-wired": "[^"]+"/, '"gdp-wired": "0.0.1"');
    for (const file of [...Object.keys(manifest.inputs), ...Object.keys(manifest.outputs), manifestPath, "package.json"]) {
      const target = path.join(dir, file);
      const original = fs.readFileSync(target, "utf8");
      const changed = file === manifestPath
        ? JSON.stringify({ ...JSON.parse(original), prover: "gdp-wired@0.0.0" }, null, 2) + "\n"
        : file === "package.json" ? pinned(original) : original + "\n// changed\n";
      expect(changed).not.toBe(original);
      fs.writeFileSync(target, changed);
      const result = spawnSync("bun", [script, "--artifact"], options);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Verified kernel artifact is stale");
      fs.writeFileSync(target, original);
    }
  }, 60_000);
});
