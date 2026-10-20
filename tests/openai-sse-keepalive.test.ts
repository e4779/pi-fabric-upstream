import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule as tsTranspile } from "typescript";
import { describe, expect, it } from "vitest";
import {
  isOpenAiStreamingModuleUrl,
  openAiSseKeepaliveMarker,
  patchOpenAiSseStreaming,
} from "../src/durable/openai-sse-patch.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Resolved like the durable worker resolves it: through the normal module
// walk from the installed tree, not a hardcoded store path.
const openaiRoot = (() => {
  try {
    return join(createRequire(import.meta.url).resolve("openai"), "..");
  } catch {
    return undefined;
  }
})();

const streamingMjs = openaiRoot ? join(openaiRoot, "core", "streaming.mjs") : undefined;
const streamingJs = openaiRoot ? join(openaiRoot, "core", "streaming.js") : undefined;

// Two valid chat-completions chunks separated by the killer lines: a bare
// empty `data:` keepalive and a whitespace-only one, as gateways in front of
// OpenAI-compatible endpoints emit during long reasoning pauses.
const killerEvents = [
  `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n`,
  "data: \n\n",
  "data:   \n\n",
  `data: {"id":"2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"b"}}]}\n\n`,
  "data: [DONE]\n\n",
];

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body);
}

interface DeltaChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

async function collectItems(fromSSEResponse: (response: Response, controller: AbortController) => AsyncIterable<unknown>): Promise<DeltaChunk[]> {
  const items: DeltaChunk[] = [];
  for await (const item of fromSSEResponse(sseResponse(killerEvents), new AbortController())) {
    items.push(item as DeltaChunk);
  }
  return items;
}

describe("patchOpenAiSseStreaming", () => {
  it("inserts the skip right after the [DONE] guard in the real dist mjs", { skip: !streamingMjs || !existsSync(streamingMjs) }, () => {
    const source = readFileSync(streamingMjs!, "utf8");
    expect(source).not.toContain("!sse.data.trim()");
    const patched = patchOpenAiSseStreaming(source);
    expect(patched.applied).toBe(true);
    const guard = /if\s*\(\s*sse\.data\s*===\s*(["'])\[DONE\]\1\s*\)\s*\{[^{}]*\}/.exec(patched.source);
    expect(guard).not.toBeNull();
    expect(patched.source.slice(guard!.index + guard![0].length)).toMatch(/^\nif \(!sse\.data \|\| !sse\.data\.trim\(\)\) continue;/);
  });

  it("patches the CJS dist copy too", { skip: !streamingJs || !existsSync(streamingJs) }, () => {
    const patched = patchOpenAiSseStreaming(readFileSync(streamingJs!, "utf8"));
    expect(patched.applied).toBe(true);
    expect(patched.source).toContain(openAiSseKeepaliveMarker);
  });

  it("is idempotent", () => {
    const source = [`for await (const sse of messages) {`, `  if (sse.data === '[DONE]') {`, `    receivedCompletionSentinel = true;`, `    break;`, `  }`, `}`].join("\n");
    const first = patchOpenAiSseStreaming(source);
    expect(first.applied).toBe(true);
    const second = patchOpenAiSseStreaming(first.source);
    expect(second.applied).toBe(false);
    expect(second.source).toBe(first.source);
  });

  it("throws loudly when the upstream [DONE] guard is gone", () => {
    expect(() => patchOpenAiSseStreaming("export const unrelated = 1;\n")).toThrow(/guard not found/);
  });

  it("handles the minified bundle-chunk form", () => {
    const minified =
      'for await(let sse of messages){if(sse.data==="[DONE]"){receivedCompletionSentinel=!0;break}if(sse.event===null||!sse.event.startsWith("thread.")){let data;try{data=JSON.parse(sse.data)}catch{throw new SyntaxError("Error reading response: malformed server-sent event JSON.")}}}';
    const patched = patchOpenAiSseStreaming(minified);
    expect(patched.applied).toBe(true);
    expect(patched.source).toContain('break}\nif (!sse.data || !sse.data.trim()) continue;');
  });
});

describe("isOpenAiStreamingModuleUrl", () => {
  it("matches only the openai streaming decoder files", () => {
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/openai/core/streaming.mjs")).toBe(true);
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/openai/core/streaming.js")).toBe(true);
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/@scope/openai/core/streaming.mjs")).toBe(true);
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/openai/index.mjs")).toBe(false);
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/not-openai/core/streaming.mjs")).toBe(false);
    expect(isOpenAiStreamingModuleUrl("file:///x/node_modules/openai/core/resources/chat.mjs")).toBe(false);
  });
});

describe.skipIf(!openaiRoot)("openai Stream behavior with keepalive tolerance", () => {
  it("the unpatched SDK aborts on an empty data: keepalive (bug reproduced)", async () => {
    expect(readFileSync(streamingMjs!, "utf8")).not.toContain("!sse.data.trim()");
    const { Stream } = (await import(pathToFileURL(streamingMjs!).href)) as {
      Stream: { fromSSEResponse: (response: Response, controller: AbortController) => AsyncIterable<unknown> };
    };
    await expect(collectItems(Stream.fromSSEResponse)).rejects.toThrow("malformed server-sent event JSON");
  });

  it("the patched copy streams both events across empty and whitespace keepalives", async () => {
    const staging = mkdtempSync(join(tmpdir(), "pi-fabric-openai-sse-"));
    try {
      cpSync(openaiRoot!, staging, { recursive: true });
      const file = join(staging, "core", "streaming.mjs");
      const patched = patchOpenAiSseStreaming(readFileSync(file, "utf8"));
      expect(patched.applied).toBe(true);
      writeFileSync(file, patched.source);
      const { Stream } = (await import(pathToFileURL(file).href)) as {
        Stream: { fromSSEResponse: (response: Response, controller: AbortController) => AsyncIterable<unknown> };
      };
      const items = await collectItems(Stream.fromSSEResponse);
      expect(items).toHaveLength(2);
      expect(items[0]?.choices?.[0]?.delta?.content).toBe("a");
      expect(items[1]?.choices?.[0]?.delta?.content).toBe("b");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

// Probes the actual mechanism the durable worker uses: Node's synchronous
// module load hook rewriting the SDK source in memory. Compiles the patch
// module (self-contained, no imports) from src, runs the real node binary
// against it and the unmodified on-disk SDK.
const patchModuleSource = readFileSync(join(repoRoot, "src", "durable", "openai-sse-patch.ts"), "utf8");

function compilePatchModule(): string {
  const { outputText } = tsTranspile(patchModuleSource, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
  });
  const dir = mkdtempSync(join(tmpdir(), "pi-fabric-openai-patch-"));
  const file = join(dir, "openai-sse-patch.mjs");
  writeFileSync(file, outputText);
  return file;
}

describe.skipIf(!streamingMjs)("durable worker load-hook wiring", () => {
  it("a node process with the hook streams through keepalives without touching disk", () => {
    expect(existsSync(join(repoRoot, "dist", "durable", "worker.js"))).toBe(true);
    // the built worker entry carries the load-hook wiring
    expect(readFileSync(join(repoRoot, "dist", "durable", "worker.js"), "utf8")).toContain("openai SSE keepalive patch skipped");
    // the on-disk SDK is NOT patched — the probe must exercise the hook itself
    expect(readFileSync(streamingMjs!, "utf8")).not.toContain("!sse.data.trim()");
    const patchModule = compilePatchModule();
    const probe = `
      import module from "node:module";
      import { pathToFileURL } from "node:url";
      const patch = await import(pathToFileURL(process.env.OPENAI_SSE_PATCH_MODULE).href);
      module.registerHooks({
        load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          if (loaded.source != null && patch.isOpenAiStreamingModuleUrl(url)) {
            const text = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
            const result = patch.patchOpenAiSseStreaming(text);
            if (result.applied) loaded.source = result.source;
          }
          return loaded;
        },
      });
      const { Stream } = await import(pathToFileURL(process.env.OPENAI_STREAMING_MJS).href);
      const encoder = new TextEncoder();
      const events = ${JSON.stringify(killerEvents)};
      const body = new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      });
      const items = [];
      for await (const item of Stream.fromSSEResponse(new Response(body), new AbortController())) items.push(item);
      console.log("ITEMS:" + JSON.stringify(items.map((item) => item.choices?.[0]?.delta?.content)));
    `;
    const result = spawnSync("node", ["--input-type=module", "--eval", probe], {
      env: {
        ...process.env,
        OPENAI_SSE_PATCH_MODULE: patchModule,
        OPENAI_STREAMING_MJS: streamingMjs!,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.stderr).not.toContain("keepalive patch skipped");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ITEMS:["a","b"]');
  });
});
