import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { assertWorkerRuntime, writeWorkerStartupFailure } from "../src/worker/startup.js";
import { explainMissingInstall } from "../src/worker/missing-install.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("worker bootstrap diagnostics", () => {
  it("rejects old Node without rejecting Bun's compatibility version", () => {
    expect(() => assertWorkerRuntime({ node: "22.22.2" })).toThrow("Node.js 24+");
    expect(() => assertWorkerRuntime({ node: "24.0.0" })).not.toThrow();
    expect(() => assertWorkerRuntime({ node: "26.5.0" })).not.toThrow();
    expect(() => assertWorkerRuntime({ node: "22.0.0", bun: "1.3.0" })).not.toThrow();
  });

  it("writes bounded owner-only diagnostics and retains resumed usage even with invalid options", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-startup-"));
    roots.push(root);
    const file = path.join(root, "status.json");
    const carry = { turns: 3, toolCalls: 2, usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.1 } };
    writeWorkerStartupFailure(["node", "worker.js", "--id", "probe", "--status-file", file, "--task-file", path.join(root, "missing"), "--carry-over", JSON.stringify(carry)], new Error("missing module " + "x".repeat(30000)));
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(record).toMatchObject({ id: "probe", status: "failed", task: "", ...carry });
    expect(record.error).toContain("missing module");
    expect(record.error.length).toBeLessThanOrEqual(20000);
    expect(record.stderr.length).toBeLessThanOrEqual(20000);
    expect(record.finishedAt).toBeGreaterThanOrEqual(record.startedAt);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("explains only a package missing from the worker's own build", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-install-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.mkdirSync(path.join(root, "dist/durable"), { recursive: true });
    const entry = pathToFileURL(path.join(root, "dist/durable/worker.js")).href;
    const missing = (specifier: string, importer: string) =>
      Object.assign(new Error(`Cannot find package '${specifier}' imported from ${importer}`), { code: "ERR_MODULE_NOT_FOUND" });
    const scoped = explainMissingInstall(missing("@scope/pkg/sub", path.join(root, "dist/worker.js")), entry) as Error;
    expect(scoped.message).toContain(`Fabric build at ${root} cannot start a worker: its dependency "@scope/pkg" is not installed (the build has no node_modules)`);
    expect(scoped.cause).toBeInstanceOf(Error);
    fs.mkdirSync(path.join(root, "node_modules"));
    expect((explainMissingInstall(missing("diff", path.join(root, "dist/x.js")), entry) as Error).message).not.toContain("has no node_modules");
    const foreign = missing("diff", path.join(path.dirname(root), "other-extension", "index.js"));
    expect(explainMissingInstall(foreign, entry)).toBe(foreign);
    const relative = missing("./gone.js", path.join(root, "dist/worker.js"));
    expect(explainMissingInstall(relative, entry)).toBe(relative);
    const other = Object.assign(new Error("Cannot find package 'diff'"), { code: "EACCES" });
    expect(explainMissingInstall(other, entry)).toBe(other);
    const required = (importer?: string) => Object.assign(new Error(`Cannot find module 'which'\nRequire stack:\n- ${importer}`),
      { code: "MODULE_NOT_FOUND", ...(importer ? { requireStack: [importer] } : {}) });
    expect((explainMissingInstall(required(path.join(root, "node_modules/cross-spawn/index.js")), entry) as Error).message)
      .toContain(`its dependency "which" is not installed`);
    const foreignRequire = required(path.join(path.dirname(root), "other-extension", "index.cjs"));
    expect(explainMissingInstall(foreignRequire, entry)).toBe(foreignRequire);
    const unknown = required();
    expect(explainMissingInstall(unknown, entry)).toBe(unknown);
  });

  it("finds an importer path with spaces and names the remedy for each install kind", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "worker install "));
    roots.push(parent);
    const missing = (root: string) => Object.assign(
      new Error(`Cannot find package 'cross-spawn' imported from ${path.join(root, "dist/worker.js")}`), { code: "ERR_MODULE_NOT_FOUND" });
    const checkout = path.join(parent, "pi fabric");
    fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), "{}");
    const local = (explainMissingInstall(missing(checkout), pathToFileURL(path.join(checkout, "dist/worker.js")).href) as Error).message;
    expect(local).toContain(`Fabric build at ${checkout} cannot start a worker`);
    expect(local).toContain("(the build has no node_modules)");
    expect(local).toContain("Run `bun install` in that directory");
    const managed = path.join(parent, "node_modules", "pi-fabric");
    fs.mkdirSync(path.join(managed, "dist"), { recursive: true });
    fs.writeFileSync(path.join(managed, "package.json"), "{}");
    const installed = (explainMissingInstall(missing(managed), pathToFileURL(path.join(managed, "dist/worker.js")).href) as Error).message;
    expect(installed).toContain(`Fabric build at ${managed} cannot start a worker`);
    expect(installed).not.toContain("has no node_modules");
    expect(installed).toContain("`pi install npm:pi-fabric`");
  });

  it("does not invent a destination when no status path is available", () => {
    expect(() => writeWorkerStartupFailure(["node", "worker.js"], new Error("startup"))).not.toThrow();
  });
});
