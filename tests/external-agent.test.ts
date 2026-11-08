import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  finalAssistantText,
  parseAgentArgv,
  workerResultLines,
} from "../src/external/agent.js";
import { composeCommands, startExternalBridge, type ExternalBridgeHandle } from "../src/external/bridge.js";
import { createRecallCommand } from "../src/external/recall.js";
import { createAgentCommand } from "../src/external/agent.js";
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-external-agent-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

describe("external agent argv parsing", () => {
  const promptFile = (): string => {
    const directory = temporaryDirectory("prompt");
    const file = path.join(directory, "prompt.txt");
    fs.writeFileSync(file, "count to three");
    return file;
  };

  it("accepts canonical arguments and applies defaults", () => {
    const args = parseAgentArgv([`promptFile=${promptFile()}`, "tools=read, grep ,ls", "json=on"]);
    expect(args.prompt).toBe("count to three");
    expect(args.tools).toEqual(["read", "grep", "ls"]);
    expect(args.json).toBe(true);
    expect(args.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
    expect(args.cwd).toBeUndefined();
  });

  it("empty tools= means a tool-less completion", () => {
    const args = parseAgentArgv([`promptFile=${promptFile()}`, "tools=", "timeoutMs=5000"]);
    expect(args.tools).toEqual([]);
    expect(args.timeoutMs).toBe(5000);
  });

  it("rejects unknown keys, missing prompt, bad numbers, unreadable files", () => {
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "wat=1"])).toThrow(/unknown agent argument/);
    expect(() => parseAgentArgv(["tools=read"])).toThrow(/promptFile/);
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "timeoutMs=soon"])).toThrow(/positive integer/);
    expect(() => parseAgentArgv(["promptFile=/nonexistent/nowhere.txt"])).toThrow(/cannot read promptFile/);
  });
});

describe("final assistant text extraction", () => {
  it("joins the last assistant message's text blocks and skips thinking/tool calls", () => {
    const text = finalAssistantText([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "one" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read" }, { type: "text", text: "two" }, { type: "text", text: "three" }],
      },
    ]);
    expect(text).toBe("two\nthree");
  });

  it("returns null without an assistant message", () => {
    expect(finalAssistantText([{ role: "user", content: [] }])).toBeNull();
    expect(finalAssistantText([])).toBeNull();
  });
});

describe("external agent schemaFile and maxTokens arguments", () => {
  const promptFile = (): string => {
    const directory = temporaryDirectory("prompt");
    const file = path.join(directory, "prompt.txt");
    fs.writeFileSync(file, "count to three");
    return file;
  };
  const schemaFile = (contents: string): string => {
    const directory = temporaryDirectory("schema");
    const file = path.join(directory, "schema.json");
    fs.writeFileSync(file, contents);
    return file;
  };
  const tinySchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  };

  it("parses a valid schemaFile into args.schema alongside json=on", () => {
    const args = parseAgentArgv([
      `promptFile=${promptFile()}`,
      "json=on",
      `schemaFile=${schemaFile(JSON.stringify(tinySchema))}`,
    ]);
    expect(args.json).toBe(true);
    expect(args.schema).toEqual(tinySchema);
  });

  it("schemaFile requires json=on", () => {
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, `schemaFile=${schemaFile("{}")}`])).toThrow(
      /schemaFile requires json=on/,
    );
  });

  it("missing schema file errors like a missing promptFile", () => {
    expect(() =>
      parseAgentArgv([`promptFile=${promptFile()}`, "json=on", "schemaFile=/nonexistent/schema.json"]),
    ).toThrow(/cannot read schemaFile/);
  });

  it("non-JSON schema file errors with the parse problem", () => {
    expect(() =>
      parseAgentArgv([`promptFile=${promptFile()}`, "json=on", `schemaFile=${schemaFile("{not json")}`]),
    ).toThrow(/schemaFile is not JSON/);
  });

  it("JSON values that are not objects are not schemas", () => {
    expect(() =>
      parseAgentArgv([`promptFile=${promptFile()}`, "json=on", `schemaFile=${schemaFile("[1,2]")}`]),
    ).toThrow(/schemaFile must contain a JSON object/);
  });

  it("maxTokens must be a positive integer", () => {
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "maxTokens=soon"])).toThrow(
      /maxTokens must be a positive integer/,
    );
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "maxTokens=0"])).toThrow(
      /maxTokens must be a positive integer/,
    );
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "maxTokens=1.5"])).toThrow(
      /maxTokens must be a positive integer/,
    );
  });

  it("a well-formed maxTokens is still rejected: the SDK exposes no per-session knob", () => {
    expect(() => parseAgentArgv([`promptFile=${promptFile()}`, "maxTokens=512"])).toThrow(
      /maxTokens unsupported by SDK/,
    );
  });
});

describe("worker result lines with a schema", () => {
  const assistant = (text: string): readonly unknown[] => [
    { role: "assistant", content: [{ type: "text", text }] },
  ];
  const tinySchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
    additionalProperties: false,
  };

  it("throws with the validator's message head when the reply violates the schema", async () => {
    const error = await workerResultLines(true, assistant('{"count":"two"}'), tinySchema).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^reply does not match schema \(must be number\): \{"count":"two"\}$/);
  });

  it("returns a compact line when the reply satisfies the schema", async () => {
    await expect(workerResultLines(true, assistant('done. {"count":2}'), tinySchema)).resolves.toEqual([
      '{"count":2}',
    ]);
  });

  it("json=on without a schema keeps the old lenient behavior", async () => {
    await expect(workerResultLines(true, assistant('{"count":"two"}'))).resolves.toEqual(['{"count":"two"}']);
  });

  it("a reply that is not JSON at all still fails as before", async () => {
    await expect(workerResultLines(true, assistant("plain prose, no payload"), tinySchema)).rejects.toThrow(
      /^reply is not JSON \(/,
    );
  });
});

describe("external bridge agent command", () => {
  let bridge: ExternalBridgeHandle | undefined;
  let activePromptFile = "";
  const cwd = "/work/external-agent";

  beforeEach(() => {
    const agentDir = temporaryDirectory("agent");
    const indexDir = temporaryDirectory("index");
    const promptDir = temporaryDirectory("prompt");
    const promptFile = path.join(promptDir, "p.txt");
    fs.writeFileSync(promptFile, "worker prompt");
    activePromptFile = promptFile;
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "zyronic.jsonl", [
      sessionHeader("zyronic", cwd),
      messageEntry("zyronic-0", null, new Date(1_700_000_000_000).toISOString(), userMessage("zyronic-anchor note")),
    ]);
    const memoryContext: MemoryProviderContext = {
      agentDir,
      cwd,
      config: {
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
      },
    };
    const seen: string[] = [];
    bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: composeCommands(
        createAgentCommand(async (args) => {
          seen.push(`${args.prompt}|${args.tools.join("+")}`);
          return { ok: true, lines: ["id=stub", `prompt=${args.prompt}`] };
        }),
        createRecallCommand(async () => memoryContext),
      ),
    });
    void seen;
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

  it("routes agent to the injected runner and recall to memory over one bridge", async () => {
    const agentReply = await speak(["agent", `promptFile=${activePromptFile}`, "tools=read"]);
    expect(agentReply.status).toBe("OK");
    expect(agentReply.lines[0]).toBe("id=stub");

    const recallReply = await speak(["recall", "query=zyronic-anchor", "scope=global"]);
    expect(recallReply.status).toBe("OK");
    expect(recallReply.lines.some((line) => line.includes("zyronic-anchor note"))).toBe(true);
  });

  it("protocol errors surface as ERR without breaking later commands", async () => {
    const bad = await speak(["agent", "tools=read"]);
    expect(bad.status).toMatch(/^ERR/);
    expect(bad.status).toContain("promptFile");
    const good = await speak(["ping"]);
    expect(good.status).toBe("OK");
  });
});

describe("composeCommands", () => {
  it("first claim wins and unknown argv falls through", async () => {
    const first = composeCommands(
      async (argv) => (argv[0] === "a" ? { ok: true, lines: ["first"] } : undefined),
      async (argv) => (argv[0] === "b" ? { ok: true, lines: ["second"] } : undefined),
    );
    expect((await first(["a"]))?.lines).toEqual(["first"]);
    expect((await first(["b"]))?.lines).toEqual(["second"]);
    expect(await first(["c"])).toBeUndefined();
  });
});
