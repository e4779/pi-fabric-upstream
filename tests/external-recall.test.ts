import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { startExternalBridge, type ExternalBridgeHandle } from "../src/external/bridge.js";
import { createRecallCommand, parseRecallArgv, renderRecall } from "../src/external/recall.js";
import type { MemoryProviderContext } from "../src/memory/request-context.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import {
  messageEntry,
  sessionHeader,
  userMessage,
  writeSessionFile,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-external-recall-${name}-`));
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
  maxSyncSourceBytes: 512 * 1024 * 1024,
  maxCacheCleanupFiles: 100_000,
  regexMaxPatternBytes: 1_024,
  regexMaxHaystackTerms: 20_000,
  regexMaxHaystackBytes: 2 * 1024 * 1024,
  regexTimeoutMs: 250,
});

describe("external recall argv parsing", () => {
  it("accepts canonical key=value arguments", () => {
    expect(parseRecallArgv(["query=bcachefs recovery", "scope=global", "pageSize=5", "offset=10"])).toEqual({
      query: "bcachefs recovery",
      scope: "global",
      pageSize: 5,
      offset: 10,
    });
  });

  it("rejects malformed, unknown, and missing pieces", () => {
    expect(() => parseRecallArgv(["query"])).toThrow(/key=value/);
    expect(() => parseRecallArgv(["wat=1", "query=x"])).toThrow(/unknown recall argument/);
    expect(() => parseRecallArgv(["query=x", "pageSize=2.5"])).toThrow(/non-negative integer/);
    expect(() => parseRecallArgv(["scope=global"])).toThrow(/needs a query/);
  });
});

describe("external recall rendering", () => {
  it("renders entry hits, snippets, coverage, and the continuation pointer", () => {
    const rendered = renderRecall({
      total: 2,
      hits: [
        {
          kind: "entry",
          sessionId: "sess-1",
          tier: "hot",
          index: 7,
          type: "message",
          role: "assistant",
          tool: null,
          timestamp: 1_700_000_000_000,
          isError: true,
          score: 12.3456,
          entryId: "entry-1",
          snippet: "flat\n  me",
          truncated: true,
        },
        { kind: "session", sessionId: "sess-2", cwd: "/work", lastTimestamp: null, score: 4, matchedTerms: 3, matchedStructuralEntries: 1 },
      ],
      next: { ref: "memory.recall", args: { offset: 2 } },
      coverage: {
        complete: true,
        indexedSessions: 9,
        eligibleSessions: 9,
        staleSessions: 0,
        incompleteSessions: 0,
        reasons: [],
      },
    });
    expect(rendered.ok).toBe(true);
    const [head, entryHeader, snippet, sessionLine, tail] = rendered.lines;
    expect(head).toBe("total=2 indexed=9 eligible=9");
    expect(entryHeader).toContain("entry ts=2023-11-14T22:13:20.000Z sid=sess-1 tier=hot idx=7");
    expect(entryHeader).toContain("err");
    expect(entryHeader).toContain("score=12.35");
    expect(entryHeader).toContain("id=entry-1");
    expect(snippet).toBe("  flat me …");
    expect(sessionLine).toContain("session sid=sess-2");
    expect(sessionLine).toContain("terms=3");
    expect(tail).toBe("next offset=2");
  });

  it("fails on error payloads instead of printing empty results", () => {
    const rendered = renderRecall({
      total: 0,
      hits: [],
      next: null,
      coverage: { complete: false, indexedSessions: 0, eligibleSessions: 0, staleSessions: 0, incompleteSessions: 0, reasons: ["ambiguous_session"] },
      error: { code: "ambiguous_session", message: "two sessions match" },
    });
    expect(rendered.ok).toBe(false);
    expect(rendered.lines[0]).toContain("ambiguous_session");
    expect(rendered.lines[0]).toContain("two sessions match");
  });
});

describe("external bridge recall command", () => {
  let agentDir: string;
  let bridge: ExternalBridgeHandle | undefined;
  const cwd = "/work/external-recall";

  beforeEach(() => {
    agentDir = temporaryDirectory("agent");
    const indexDir = temporaryDirectory("index");
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "zyronic.jsonl", [
      sessionHeader("zyronic", cwd),
      messageEntry("zyronic-0", null, new Date(1_700_000_000_000).toISOString(), userMessage("zyronic-anchor discovery note")),
    ]);
    const context: MemoryProviderContext = {
      agentDir,
      cwd,
      config: config(indexDir),
    };
    bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: createRecallCommand(() => context),
    });
  });

  afterEach(() => {
    bridge?.close();
    bridge = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const speak = (payload: string[]): Promise<{ status: string; lines: string[] }> =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(bridge!.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(`${[...payload, ""].join("\n")}`);
        socket.end();
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
      });
      socket.on("close", () => {
        const parts = buffer.replace(/\n$/, "").split("\n");
        const status = parts.shift() ?? "";
        resolve({ status, lines: parts });
      });
    });

  it("serves recall over the socket with the shared renderer", async () => {
    const reply = await speak(["recall", "query=zyronic-anchor", "scope=global"]);
    expect(reply.status).toBe("OK");
    expect(reply.lines[0]).toMatch(/total=/);
    expect(reply.lines.some((line) => line.includes("zyronic-anchor discovery note"))).toBe(true);
  });

  it("reports protocol errors as ERR without killing the bridge", async () => {
    const bad = await speak(["recall", "query=zyronic", "wat=1"]);
    expect(bad.status).toMatch(/^ERR/);
    expect(bad.status).toContain("unknown recall argument");
    const good = await speak(["recall", "query=zyronic-anchor", "scope=global"]);
    expect(good.status).toBe("OK");
  });

  it("falls through to builtins for unknown commands", async () => {
    const reply = await speak(["ping"]);
    expect(reply.status).toBe("OK");
    expect(reply.lines[0]).toBe("fabric-external 2");
  });
});
