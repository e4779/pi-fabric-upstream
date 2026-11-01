import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDist, swapIntoPlace } from "../scripts/build-dist.mjs";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const packageRoot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-build-dist-"));
  temporary.push(dir);
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "old");
  fs.writeFileSync(path.join(dir, "dist", "removed.js"), "old");
  return dir;
};
const node = (source: string): string[] => [process.execPath, "-e", source];
const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name.startsWith(".dist-"));

describe("build-dist", () => {
  it("keeps the previous dist/ loadable while the build runs, then replaces it", () => {
    const dir = packageRoot();
    buildDist({
      root: dir,
      steps: (outdir) => [
        node(`if (require("node:fs").readFileSync("dist/index.js", "utf8") !== "old") process.exit(3)`),
        node(`const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(outdir)}); fs.writeFileSync(${JSON.stringify(`${outdir}/index.js`)}, "new")`),
        node(`if (require("node:fs").readFileSync("dist/index.js", "utf8") !== "old") process.exit(4)`),
      ],
    });
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(dir, "dist", "removed.js"))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  });

  it("leaves the previous dist/ untouched when a step fails", () => {
    const dir = packageRoot();
    expect(() => buildDist({
      root: dir,
      steps: (outdir) => [
        node(`const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(outdir)}); fs.writeFileSync(${JSON.stringify(`${outdir}/index.js`)}, "half")`),
        node("process.exit(2)"),
      ],
    })).toThrow("dist/ was left as it was");
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(dir, "dist", "removed.js"))).toBe(true);
    expect(leftovers(dir)).toEqual([]);
  });

  it("creates dist/ when there is none", () => {
    const dir = packageRoot();
    fs.rmSync(path.join(dir, "dist"), { recursive: true });
    buildDist({
      root: dir,
      steps: (outdir) => [node(`require("node:fs").mkdirSync(${JSON.stringify(outdir)}); require("node:fs").writeFileSync(${JSON.stringify(`${outdir}/index.js`)}, "new")`)],
    });
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("new");
  });

  it("removes staging directories of dead builds and keeps those of running ones", () => {
    const dir = packageRoot();
    const dead = path.join(dir, ".dist-build-2147483646");
    const running = path.join(dir, `.dist-build-${process.ppid}`);
    for (const stale of [dead, running]) fs.mkdirSync(stale);
    buildDist({ root: dir, steps: (outdir) => [node(`require("node:fs").mkdirSync(${JSON.stringify(outdir)})`)] });
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(running)).toBe(true);
  });

  it("puts the previous dist/ back when installing the staged build keeps failing", () => {
    const dir = packageRoot();
    const stage = path.join(dir, ".dist-build-1");
    fs.mkdirSync(stage);
    const rename = (from: string, to: string): void => {
      if (from === stage) throw Object.assign(new Error("busy"), { code: "EPERM" });
      fs.renameSync(from, to);
    };
    expect(() => swapIntoPlace(dir, stage, { attempts: 3, delayMs: 1, rename })).toThrow("busy");
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("old");
    expect(leftovers(dir)).toEqual([".dist-build-1"]);
  });

  it("puts back a dist/ that a dead build retired before removing its leftovers", () => {
    const dir = packageRoot();
    const retired = path.join(dir, ".dist-old-2147483646-0");
    fs.renameSync(path.join(dir, "dist"), retired);
    expect(() => buildDist({ root: dir, steps: () => [node("process.exit(2)")] })).toThrow("dist/ was left as it was");
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("old");
    expect(leftovers(dir)).toEqual([]);
  });

  it("swaps in again when a concurrent build restored dist/ between the renames", () => {
    const dir = packageRoot();
    const stage = path.join(dir, ".dist-build-1");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "index.js"), "new");
    let raced = false;
    const rename = (from: string, to: string): void => {
      if (!raced && from === stage) {
        raced = true;
        fs.mkdirSync(path.join(dir, "dist"));
        fs.writeFileSync(path.join(dir, "dist", "index.js"), "other");
      }
      fs.renameSync(from, to);
    };
    swapIntoPlace(dir, stage, { delayMs: 1, rename });
    expect(raced).toBe(true);
    expect(fs.readFileSync(path.join(dir, "dist", "index.js"), "utf8")).toBe("new");
    expect(leftovers(dir)).toEqual([]);
  });

  it("is what the package build runs, with no step that deletes dist/ first", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const build = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts.build as string;
    expect(build).toContain("node scripts/build-dist.mjs");
    expect(build).not.toMatch(/rmSync|rm -rf|rimraf/);
  });
});
