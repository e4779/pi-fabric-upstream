// Empty SSE keepalive tolerance for the OpenAI SDK's streaming decoder.
//
// Gateways in front of OpenAI-compatible endpoints (observed with GLM-5.2
// behind ai-sbt-hub) hold the connection open during long reasoning pauses
// with bare `data: \n\n` lines instead of SSE comments. The SDK's
// `Stream.fromSSEResponse` only special-cases `[DONE]`, so an empty payload
// reaches `JSON.parse("")` and aborts the whole generation with
// "Error reading response: malformed server-sent event JSON.", discarding
// the partial output. An empty `data:` carries no payload: the consumer loop
// skips it instead. The patch is applied in memory by the durable worker's
// module load hook (see durable/worker.ts); nothing on disk is modified.

/** Inserted right after the SDK's `[DONE]` guard inside the SSE consumer loop. */
export const openAiSseKeepaliveMarker = "\nif (!sse.data || !sse.data.trim()) continue;";

const doneGuardPattern = /if\s*\(\s*sse\.data\s*===\s*(["'])\[DONE\]\1\s*\)\s*\{[^{}]*\}/;

export interface OpenAiSsePatchResult {
  source: string;
  applied: boolean;
}

/**
 * Rewrite the SDK's SSE consumer so empty or whitespace-only `data:` events
 * are skipped instead of reaching `JSON.parse`. Idempotent; throws when the
 * `[DONE]` guard is absent so an upstream refactor surfaces as a loud
 * warning (the load hook skips patching) rather than a silent regression.
 */
export function patchOpenAiSseStreaming(source: string): OpenAiSsePatchResult {
  if (source.includes("!sse.data.trim()) continue;") || source.includes("!sse.data.trim())continue;")) {
    return { source, applied: false };
  }
  const guard = doneGuardPattern.exec(source);
  if (!guard) {
    throw new Error(
      "openai SSE keepalive patch: `[DONE]` guard not found in the streaming decoder source (upstream layout changed)",
    );
  }
  const insertAt = guard.index + guard[0].length;
  return {
    source: source.slice(0, insertAt) + openAiSseKeepaliveMarker + source.slice(insertAt),
    applied: true,
  };
}

/**
 * Whether a module URL is the OpenAI SDK's SSE decoder (`core/streaming.*`).
 * Deliberately loose about the package scope (any package literally named
 * `openai`) and strict about the path, so lookalikes (`not-openai/...`)
 * and unrelated files (`openai/index.mjs`) stay untouched.
 */
export function isOpenAiStreamingModuleUrl(url: string): boolean {
  return url.includes("/openai/core/streaming.");
}
