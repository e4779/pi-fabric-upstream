import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  finalAssistantText,
  formatModelLines,
  nearestKeys,
  parseAgentArgv,
  resolveModelPin,
  workerResultLines,
  type HostModelInfo,
  type ModelPinLookup,
} from "../src/external/agent.js";
import { createAgentJobsCommand, AgentJobs } from "../src/external/agent-jobs.js";
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

describe("agent models registry command", () => {
  const fakeModels: HostModelInfo[] = [
    { key: "anthropic/claude-opus-4-5", context: 200000, thinking: true },
    { key: "deepseek/deepseek-chat", context: 65536, thinking: false },
    { key: "openai/gpt-5.1", context: 400000, thinking: true },
  ];
  const fakeLister = async (): Promise<readonly HostModelInfo[]> => fakeModels;

  it("prints one `key  context=NNN  thinking=yes|no` line per model", async () => {
    const jobs = new AgentJobs(async () => {
      throw new Error("models must not spawn a worker");
    });
    const reply = await createAgentJobsCommand(jobs, fakeLister)(["agent", "models"]);
    expect(reply?.ok).toBe(true);
    expect(reply?.lines).toEqual([
      "anthropic/claude-opus-4-5  context=200000  thinking=yes",
      "deepseek/deepseek-chat  context=65536  thinking=no",
      "openai/gpt-5.1  context=400000  thinking=yes",
    ]);
    for (const line of reply!.lines) expect(line).toMatch(/^\S+\/\S+  context=\d+  thinking=(?:yes|no)$/);
  });

  it("formatModelLines matches the pin syntax --model parses", () => {
    const lines = formatModelLines([{ key: "deepseek/deepseek-reasoner", context: 128000, thinking: true }]);
    expect(lines).toEqual(["deepseek/deepseek-reasoner  context=128000  thinking=yes"]);
  });

  it("is claimed by the jobs command before the blocking form over the bridge", async () => {
    const bridge = startExternalBridge({
      version: 2,
      stateView: () => ({ bootstrapped: true, surface: "external" }),
      socketDir: temporaryDirectory("sock"),
      commands: composeCommands(
        createAgentJobsCommand(new AgentJobs(), fakeLister),
        createAgentCommand(async () => {
          throw new Error("blocking form must not claim agent models");
        }),
      ),
    });
    const reply = await new Promise<{ status: string; lines: string[] }>((resolve, reject) => {
      const socket = net.createConnection(bridge.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("agent\nmodels\n");
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
    bridge.close();
    expect(reply.status).toBe("OK");
    expect(reply.lines).toEqual(formatModelLines(fakeModels));
  });
});

describe("model pin resolution", () => {
  const staticMiss = async (): Promise<unknown> => undefined;
  const registryWith =
    (models: readonly HostModelInfo[]): ModelPinLookup["runtime"] =>
    async () => ({
      model: (provider: string, modelId: string): unknown => {
        const hit = models.find((model) => model.key === `${provider}/${modelId}`);
        return hit === undefined ? undefined : { provider, id: modelId, source: "runtime" };
      },
      list: () => [...models],
    });

  it("falls back to the runtime registry when the static catalog misses", async () => {
    const resolved = await resolveModelPin("deepseek/deepseek-chat", {
      staticModel: staticMiss,
      runtime: registryWith([{ key: "deepseek/deepseek-chat", context: 65536, thinking: false }]),
    });
    expect(resolved).toEqual({ provider: "deepseek", id: "deepseek-chat", source: "runtime" });
  });

  it("a static catalog hit short-circuits before the runtime registry builds", async () => {
    const sentinel = { source: "static" };
    const resolved = await resolveModelPin("anthropic/claude-opus-4-5", {
      staticModel: async () => sentinel,
      runtime: async () => {
        throw new Error("runtime registry must not build for static hits");
      },
    });
    expect(resolved).toBe(sentinel);
  });

  it("reports a miss with the 8 nearest keys, closest first", async () => {
    // x/y1 is distance 1 from the pin, x/y2..x/y9 are distance 2, and the
    // last key is deliberately unrelated — so exactly x/y1..x/y8 rank first.
    const keys = ["x/y1", "x/y2", "x/y3", "x/y4", "x/y5", "x/y6", "x/y7", "x/y8", "x/y9", "zzz/unrelated"];
    let message = "";
    try {
      await resolveModelPin("x/y1a", {
        staticModel: staticMiss,
        runtime: registryWith(keys.map((key) => ({ key, context: 1, thinking: false }))),
      });
      expect.unreachable("miss must throw");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.startsWith("unknown model: x/y1a — nearest keys: ")).toBe(true);
    const listed = message.slice("unknown model: x/y1a — nearest keys: ".length).split(", ");
    expect(listed).toEqual(["x/y1", "x/y2", "x/y3", "x/y4", "x/y5", "x/y6", "x/y7", "x/y8"]);
  });

  it("a realistic typo surfaces the intended custom key first", async () => {
    const keys = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "anthropic/claude-opus-4-5"];
    await expect(
      resolveModelPin("deepseek/deepseek-cht", {
        staticModel: staticMiss,
        runtime: registryWith(keys.map((key) => ({ key, context: 1, thinking: false }))),
      }),
    ).rejects.toThrow(/^unknown model: deepseek\/deepseek-cht — nearest keys: deepseek\/deepseek-chat, /);
  });

  it("a miss against an empty registry says so instead of listing nothing", async () => {
    await expect(
      resolveModelPin("deepseek/deepseek-chat", { staticModel: staticMiss, runtime: registryWith([]) }),
    ).rejects.toThrow(/unknown model: deepseek\/deepseek-chat \(model registry is empty\)/);
  });

  it("still rejects pins without a provider/id shape", async () => {
    await expect(
      resolveModelPin("deepseek", { staticModel: staticMiss, runtime: registryWith([]) }),
    ).rejects.toThrow(/model must be provider\/id/);
  });
});

describe("nearestKeys ranking", () => {
  it("ranks by edit distance then key, and caps the list", () => {
    const keys = ["a/b", "a/b2", "a/bb", "a/bcd", "a/bcde", "a/bcdef", "a/bcdefg", "a/bcdefgh", "a/zz"];
    expect(nearestKeys("a/b", keys, 3)).toEqual(["a/b", "a/b2", "a/bb"]);
    expect(nearestKeys("a/b", keys)).toHaveLength(8);
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
