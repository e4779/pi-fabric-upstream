import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercise the published artifact, not only the checkout's manifest.
const repo = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  pi: { extensions: string[] };
};
const PROVIDER = "fixture-provider";
const coralbricks = "pi-coralbricks-provider";
const hostPackages = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

let temp: string;
let packed: string;
let files: string[];
beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-provider-package-"));
  const tarball = path.join(temp, "fabric.tgz");
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", tarball, "--quiet"], {
    cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .trim().split(/\r?\n/).map((file) => file.replace(/^package\//, ""));
  execFileSync("tar", ["-xzf", tarball, "-C", temp]);
  packed = path.join(temp, "package");
  // Pi installs production dependencies next to the package; host peers stay absent.
  for (const name of Object.keys(manifest.dependencies)) {
    const target = path.join(packed, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(repo, "node_modules", name)), target, process.platform === "win32" ? "junction" : "dir");
  }
}, 120_000);
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

describe("Fabric package without bundled Coral Bricks", () => {
  it("does not depend on, bundle, or load Coral Bricks", () => {
    expect(manifest.dependencies[coralbricks]).toBeUndefined();
    expect(manifest.optionalDependencies?.[coralbricks]).toBeUndefined();
    expect(manifest.bundledDependencies ?? []).not.toContain(coralbricks);
    expect(manifest.pi.extensions).toEqual(["./dist/extension-bootstrap.js"]);
  });

  it("ships no provider or physical Pi host packages in the tarball", () => {
    expect(files.filter((file) => file.startsWith(`node_modules/${coralbricks}/`))).toEqual([]);
    expect(files.filter((file) => hostPackages.some((host) => file.includes(`node_modules/${host}/`)))).toEqual([]);
    for (const entry of manifest.pi.extensions) expect(fs.existsSync(path.join(packed, entry)), entry).toBe(true);
  });

  it("loads only Fabric offline in a real Pi host without registering Coral Bricks", async () => {
    const agentDir = path.join(temp, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => { requests.push(String(url)); throw new Error("must stay offline"); });
    const sdk = await import("@earendil-works/pi-coding-agent");
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [packed], compaction: { enabled: false }, retry: { enabled: false } } as never);
    const loader = new sdk.DefaultResourceLoader({
      cwd: agentDir, agentDir, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((extension) => path.relative(packed, extension.path).split(path.sep).join("/")))
      .toEqual(["dist/extension-bootstrap.js"]);
    expect(loaded.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider.id)).not.toContain("coralbricks");
    expect(loaded.runtime.pendingProviderRegistrations.map(({ name }) => name)).not.toContain("coralbricks");
    expect(requests).toEqual([]);
  }, 60_000);
});

describe("bundle-pi-packages prepack step", () => {
  it("materializes a symlinked bundled package and prunes nested Pi host packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-bundle-step-"));
    try {
      const store = path.join(root, "store", PROVIDER);
      fs.mkdirSync(path.join(store, "node_modules", "@earendil-works", "pi-ai"), { recursive: true });
      fs.mkdirSync(path.join(store, "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(store, "package.json"), JSON.stringify({ name: PROVIDER, version: "1.0.0" }));
      fs.writeFileSync(path.join(store, "index.ts"), "export default () => {};\n");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ bundledDependencies: [PROVIDER] }));
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.symlinkSync(store, path.join(root, "node_modules", PROVIDER), process.platform === "win32" ? "junction" : "dir");
      const result = spawnSync(process.execPath, [path.join(repo, "scripts/bundle-pi-packages.mjs"), root], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const target = path.join(root, "node_modules", PROVIDER);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(target, "index.ts"), "utf8")).toContain("export default");
      expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(store, "node_modules", "@earendil-works", "pi-ai"))).toBe(true);
      // Idempotent on a real directory; a nested host copy there is pruned.
      fs.mkdirSync(path.join(target, "node_modules", "typebox"), { recursive: true });
      fs.mkdirSync(path.join(target, "node_modules", "left-pad"), { recursive: true });
      const again = spawnSync(process.execPath, [path.join(repo, "scripts/bundle-pi-packages.mjs"), root], { encoding: "utf8" });
      expect(again.status, again.stderr).toBe(0);
      expect(fs.existsSync(path.join(target, "node_modules", "typebox"))).toBe(false);
      expect(fs.existsSync(path.join(target, "node_modules", "left-pad"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
