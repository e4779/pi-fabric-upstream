import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { startExternalBridge, type ExternalBridgeHandle } from "../src/external/bridge.js";
import {
  createExpandCommand,
  parseExpandArgv,
  resolveMemoryId,
} from "../src/external/expand.js";
import type { MemoryProviderContext } from "../src/memory/request-context.js";
import { messageEntry, sessionHeader, userMessage, writeSessionFile } from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-external-expand-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const config = (indexDir: string): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 100_000,
  indexThinking: false,
  indexToolOutput: true,
  hotSessions: 5,
  maxColdVocabularyBytes: 512 * 1024,
  maxColdCacheBytes: 1024 * 1024,
  maxSyncSessions: 10_000,
  maxSyncSourceBytes: 512 * 1024 * 512,
  maxCacheCleanupFiles: 100_000,
  regexMaxPatternBytes: 1_024,
  regexMaxHaystackTerms: 20_000,
  regexMaxHaystackBytes: 2 * 1024 * 1024,
  regexTimeoutMs: 250,
});

describe("expand argv parsing", () => {
  it("accepts canonical key=value arguments", () => {
    expect(parseExpandArgv(["session=/tmp/s.jsonl", "idx=3,7"])).toEqual({
      session: "/tmp/s.jsonl",
      idx: [3, 7],
    });
    expect(parseExpandArgv(["id=abcd1234"])).toEqual({ id: "abcd1234", idx: [] });
    expect(parseExpandArgv(["session=/tmp/s.jsonl", "idx=0", "textOffset=512", "branches=all"])).toEqual({
      session: "/tmp/s.jsonl",
      idx: [0],
      textOffset: 512,
      branches: "all",
    });
  });

  it("rejects malformed input the loud way", () => {
    expect(() => parseExpandArgv(["wat=1"])).toThrow(/unknown expand argument/);
    expect(() => parseExpandArgv(["idx=-2", "session=/tmp/s.jsonl"])).toThrow(/non-negative integer/);
    expect(() => parseExpandArgv([])).toThrow(/needs id=/);
    expect(() => parseExpandArgv(["id=abcd1234", "idx=3"])).toThrow(/drop idx=/);
  });
});

describe("expand id resolution", () => {
  it("resolves an 8-hex id to session file and index, newest digest first", () => {
    const indexDir = temporaryDirectory("index");
    const sessionFile = path.join(indexDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf8");
    fs.writeFileSync(
      path.join(indexDir, "demo.digest.json"),
      JSON.stringify({
        sessionId: "sess-1",
        file: sessionFile,
        addresses: [[0, "abcd1234", null, "user", null, 1_700_000_000_000]],
      }),
      "utf8",
    );
    const context: MemoryProviderContext = {
      agentDir: temporaryDirectory("agent"),
      cwd: process.cwd(),
      config: config(indexDir),
    };
    expect(resolveMemoryId("abcd1234", context)).toEqual([
      {
        sessionId: "sess-1",
        sessionFile,
        index: 0,
        timestamp: 1_700_000_000_000,
      },
    ]);
    expect(resolveMemoryId("ffff0000", context)).toEqual([]);
  });
});

afterEach(() => {
  bridge?.close();
  bridge = undefined;
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

let bridge: ExternalBridgeHandle | undefined;

describe("expand over the bridge", () => {
  const openSocket = (payload: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(bridge!.socketPath);
      socket.setEncoding("utf8");
      let received = "";
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${[...payload, ""].join("\n")}`);
        socket.end();
      });
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      socket.on("close", () => resolve(received));
    });

  beforeEach(() => {
    const indexDir = temporaryDirectory("idx");
    const sessionsDir = temporaryDirectory("sessions");
    const sessionFile = writeSessionFile(sessionsDir, "s.jsonl", [
      sessionHeader("sess-1", "/work"),
      messageEntry("e1", "sess-1", "2024-12-03T14:00:01.000Z", {
        role: "user",
        content: [{ type: "text", text: "expand-me: the full entry text" }],
      }),
    ]);
    fs.writeFileSync(
      path.join(indexDir, "demo.digest.json"),
      JSON.stringify({
        sessionId: "sess-1",
        file: sessionFile,
        addresses: [[0, "abcd1234", null, "user", null, 1_700_000_000_000]],
      }),
      "utf8",
    );
    const context: MemoryProviderContext = {
      agentDir: temporaryDirectory("agent"),
      cwd: process.cwd(),
      config: config(indexDir),
    };
    bridge = startExternalBridge({
      version: 1,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: composeSingle(createExpandCommand(() => context)),
    });
  });

  it("expands an entry by id and by session+idx with provenance", async () => {
    const byId = await openSocket(["expand", "id=abcd1234"]);
    expect(byId).toMatch(/^OK\n/);
    expect(byId).toContain("# session ");
    expect(byId).toContain("expand-me: the full entry text");

    const byIndex = await openSocket([
      "expand",
      `session=${path.join(temporaryDirectories[1]!, "s.jsonl")}`,
      "idx=0",
    ]);
    expect(byIndex).toMatch(/^OK\n/);
    expect(byIndex).toContain("expand-me: the full entry text");
  });

  it("fails loudly for unknown ids and malformed argv", async () => {
    const unknown = await openSocket(["expand", "id=ffff0000"]);
    expect(unknown).toMatch(/^ERR/);
    expect(unknown).toContain("not found");
    const malformed = await openSocket(["expand", "wat=1"]);
    expect(malformed).toMatch(/^ERR/);
  });
});

/** composeCommands lives in bridge.ts; a single-handler variant keeps the
 * test honest about handler fall-through without importing the composer. */
const composeSingle = (
  handler: Parameters<typeof import("../src/external/bridge.js").composeCommands>[0],
): typeof handler => handler;
