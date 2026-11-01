#!/usr/bin/env node
// Build dist/ without ever leaving it missing or half-written.
//
// Pi loads Fabric from dist/. The old build script deleted dist/ first and
// rebuilt it in place, so for the length of a build (about 15 seconds) a Pi
// session that started, or a running one that lazily imported a module, found
// no extension or a partial one. This script builds into a staging directory
// beside dist/, checks it there, and only then swaps it in with two renames.
// A failed build leaves the previous dist/ untouched.
//
// The staging directory sits at the package root like dist/, so relative paths
// in source maps and node_modules resolution are the same after the move.
import { existsSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STAGED = /^\.dist-(?:build|old)-(\d+)(?:-\d+)?$/;
// Windows reports EPERM, EBUSY or EACCES while another process briefly holds a
// directory; EEXIST and ENOTEMPTY mean a concurrent build put dist/ back first.
const RETRYABLE = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY", "EACCES"]);

// Windows can refuse to delete a file another process holds open, such as a Pi
// session reading the retired dist/. The next build removes what is left.
const remove = (path) => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  } catch {}
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Remove staging and retired directories left by builds that are no longer
 * running. A build that stopped between its renames left no dist/ and the
 * previous one retired: that one is put back, not removed.
 */
export function removeStaleBuilds(root) {
  const dist = join(root, "dist");
  for (const name of readdirSync(root)) {
    const match = STAGED.exec(name);
    if (!match || Number(match[1]) === process.pid || alive(Number(match[1]))) continue;
    if (name.startsWith(".dist-old-") && !existsSync(dist)) {
      try {
        renameSync(join(root, name), dist);
      } catch {}
      continue;
    }
    remove(join(root, name));
  }
}

/**
 * Replace root/dist with stage. dist/ is absent only between two renames,
 * never for the length of a build, and a failure restores the previous build.
 */
export function swapIntoPlace(root, stage, { attempts = 40, delayMs = 50, rename = renameSync } = {}) {
  const dist = join(root, "dist");
  const retired = [];
  for (let attempt = 0; ; attempt += 1) {
    const old = join(root, `.dist-old-${process.pid}-${attempt}`);
    try {
      rename(dist, old);
      retired.push(old);
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (attempt + 1 < attempts && RETRYABLE.has(error.code)) {
          sleep(delayMs);
          continue;
        }
        throw error;
      }
    }
    try {
      rename(stage, dist);
      break;
    } catch (error) {
      if (attempt + 1 < attempts && RETRYABLE.has(error.code)) {
        sleep(delayMs);
        continue;
      }
      // dist/ may have been retired on an earlier attempt. If putting it back
      // fails too, the next build does it (removeStaleBuilds).
      const previous = retired.pop();
      if (previous !== undefined && !existsSync(dist)) {
        try {
          rename(previous, dist);
        } catch {}
      }
      throw error;
    }
  }
  for (const old of retired) remove(old);
}

/**
 * Run each build step against a fresh staging directory, then swap it in.
 * steps(outdir) returns [command, ...args] lists; outdir is relative to root.
 */
export function buildDist({ root, steps, stage = join(root, `.dist-build-${process.pid}`) }) {
  removeStaleBuilds(root);
  remove(stage);
  try {
    for (const [command, ...args] of steps(relative(root, stage))) {
      const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Build step failed (${result.status ?? result.signal}); dist/ was left as it was: ${[command, ...args].join(" ")}`);
      }
    }
    swapIntoPlace(root, stage);
  } finally {
    remove(stage);
  }
}

// Node resolves the main module's URL through realpathSync; compare the same way
// so a checkout reached through a symlink or junction still builds.
const main = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  buildDist({
    root,
    steps: (outdir) => [
      [process.execPath, tsc, "-p", "tsconfig.build.json", "--emitDeclarationOnly", "--outDir", outdir],
      [process.execPath, "scripts/build.mjs", "--outdir", outdir],
      [process.execPath, "scripts/assert-build-artifacts.mjs", "--dist", outdir],
    ],
  });
}
