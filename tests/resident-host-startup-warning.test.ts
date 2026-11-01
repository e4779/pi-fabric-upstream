import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { runResidentHostFromConfigPath } from "../src/residency/host.js";
import { RESIDENT_HOST_FORMAT, residentRoot, type ResidentHostConfig } from "../src/residency/protocol.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";

// The startup cancel of a dead host's routed questions writes to the mesh, and
// a mesh write can fail (a lock held past its timeout). Startup must go on, but
// the failure must not vanish: the host reports it on its stderr, which the
// resident launcher keeps in child-stderr.log.
const CANCEL_FAILURE = "Timed out acquiring Fabric mesh lock (startup-warning test)";

vi.mock("../src/decisions/host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/decisions/host.js")>();
  return {
    DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS: actual.DEFAULT_HEADLESS_APPROVAL_TIMEOUT_MS,
    routeChildQuestion: actual.routeChildQuestion,
    requestHeadlessApproval: actual.requestHeadlessApproval,
    cancelOrphanedChildQuestions: async () => {
      throw new Error(CANCEL_FAILURE);
    },
  };
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for resident host state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const writeHostConfig = (): ResidentHostConfig & { configPath: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resident-warning-"));
  cleanups.push(() => rmTempSync(root));
  const meshRoot = path.join(root, "mesh");
  const rootId = `session:resident-warning:${randomUUID()}`;
  const config: ResidentHostConfig = {
    format: RESIDENT_HOST_FORMAT,
    rootId,
    sessionId: "resident-warning",
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    meshRoot,
    actorRoot: path.join(meshRoot, "actors"),
    sessionActorRoot: path.join(meshRoot, "actors", "resident-warning"),
    residencyRoot: residentRoot(meshRoot, rootId),
    fullCodeMode: false,
    agents: { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, childQuestions: "route" },
    mesh: { ...DEFAULT_FABRIC_CONFIG.mesh, enabled: true, actorPollMs: 20 },
    retention: DEFAULT_FABRIC_CONFIG.retention,
    workerPath: path.resolve("src/worker.ts"),
    fabricExtensionPath: path.resolve("src/index.ts"),
    piBinary: "pi",
    claudeBinary: "claude",
    vedaBinary: "veda",
  };
  fs.mkdirSync(config.residencyRoot, { recursive: true });
  const configPath = path.join(config.residencyRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { ...config, configPath };
};

describe("resident host startup", () => {
  it("finishes when cancelling a dead host's questions fails, and warns once with the error", { timeout: 30_000 }, async () => {
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return write(chunk, ...rest);
    }) as typeof process.stderr.write);

    const config = writeHostConfig();
    const controller = new AbortController();
    const running = runResidentHostFromConfigPath(config.configPath, controller.signal);
    cleanups.push(async () => {
      controller.abort();
      await running;
    });

    // Startup finished: the owner record is written only after #startOwned completes.
    const ownerPath = path.join(config.residencyRoot, "owner.json");
    await waitFor(() => fs.existsSync(ownerPath));
    expect(fs.existsSync(path.join(config.residencyRoot, "error.json"))).toBe(false);
    // Let several request and participant polls pass: the report is not repeated.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const warnings = written.filter((text) => text.includes(CANCEL_FAILURE));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/orphaned child questions/);
  });
});
