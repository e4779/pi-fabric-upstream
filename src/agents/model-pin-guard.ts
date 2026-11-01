import fs from "node:fs";
import type { KnownApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODEL_PIN_ENV, MODEL_PIN_EXIT_CODE, MODEL_PIN_MARKER, type ModelPinViolation } from "./model-pin.js";

const identity = (model: unknown): string => {
  try {
    if (typeof model !== "object" || model === null) return "none";
    const { provider, id } = model as { provider?: unknown; id?: unknown };
    return typeof provider === "string" && provider && typeof id === "string" && id ? `${provider}/${id}` : "none";
  } catch {
    return "none";
  }
};

/**
 * Where an API's outgoing payload carries the model id, and the value Pi sends
 * there: the registry `id` of the model. Read from pi-ai 1.0.0, 1.0.4 and 1.3.0
 * `api/*.js` (`params = { model: model.id, ... }`, bedrock `modelId: model.id`).
 * Left out on purpose, so their payloads are never compared:
 * - `azure-openai-responses` sends a deployment name chosen from the environment;
 * - `pi-virtual` models route to a physical model at request time;
 * - any API an extension registers, whose payload shape is its own.
 */
// Typed over every pi-ai API except Azure, so a pi-ai release that adds an API fails the typecheck here until someone reads its payload shape.
const PAYLOAD_MODEL_FIELD: Readonly<Record<Exclude<KnownApi, "azure-openai-responses">, string>> = {
  "openai-completions": "model",
  "openai-responses": "model",
  "openai-codex-responses": "model",
  "anthropic-messages": "model",
  "mistral-conversations": "model",
  "google-generative-ai": "model",
  "google-vertex": "model",
  "pi-messages": "model",
  "bedrock-converse-stream": "modelId",
};

/** The model id Pi puts in the payload for `model`, or undefined where the shape is not known. */
const expectedPayloadModel = (model: unknown): { field: string; value: string } | undefined => {
  try {
    if (typeof model !== "object" || model === null) return undefined;
    const { api, id } = model as { api?: unknown; id?: unknown };
    if (typeof api !== "string" || typeof id !== "string" || !id) return undefined;
    const field = Object.hasOwn(PAYLOAD_MODEL_FIELD, api) ? PAYLOAD_MODEL_FIELD[api as keyof typeof PAYLOAD_MODEL_FIELD] : undefined;
    return field ? { field, value: id } : undefined;
  } catch {
    return undefined;
  }
};

const describePayloadModel = (value: string): string => `payload model ${JSON.stringify(value.slice(0, 120))}`;

/**
 * Child-side guard, loaded by the worker with -e only for `modelMatch: "exact"`.
 *
 * Pi swallows an exception thrown by an extension handler and goes on with the
 * request, so throwing is no veto. `ctx.abort()` also kept the provider from being
 * entered in Pi 1.0.4 probes, but only because credential lookup before the stream
 * honours the aborted signal, and the run would fail as a plain abort without a
 * fixed reason. Ending this process before the call depends on neither.
 *
 * Three checks, all against the pin:
 * - `model_select`: any switch away from the pin ends the child at once, so
 *   nothing runs on the other model afterwards, including the summaries that Pi's
 *   compaction and branch summarization build from the session's current model.
 *   Pi emits it only when the model changes, so the `--model` launch and Fabric's
 *   own `set_model` to the pin never reach it. A settings default model does not
 *   either: `--model` wins before any extension runs.
 * - `context`, `context_with_system` and `before_provider_request`: Pi's current
 *   model is the pin before each conversation request.
 * - `before_provider_request`: the model id inside the outgoing payload is the one
 *   Pi sends for the pin, for the APIs listed in PAYLOAD_MODEL_FIELD. This sees
 *   a rewrite made by a handler that ran before this one, and none made after it.
 *
 * Model calls an extension makes itself are outside this guard.
 */
export default function fabricModelPinGuard(pi: ExtensionAPI): void {
  const pinned = process.env[MODEL_PIN_ENV] ?? "";
  const stop = (actual: string): never => {
    const violation: ModelPinViolation = { pinned: pinned || "unset", actual };
    try {
      fs.writeSync(2, `\n${MODEL_PIN_MARKER}${JSON.stringify(violation)}\n`);
    } catch {
      // The exit status alone still fails the run.
    }
    return process.exit(MODEL_PIN_EXIT_CODE);
  };
  const check = (model: unknown): void => {
    if (pinned !== "" && identity(model) === pinned) return;
    stop(identity(model));
  };
  const currentModel = (context: { model?: unknown }): unknown => {
    try {
      return context.model;
    } catch {
      // A stale context or a throwing getter is not evidence of the pin.
      return undefined;
    }
  };
  pi.on("model_select", (event) => { check(event.model); });
  pi.on("context", (_event, context) => { check(currentModel(context)); });
  pi.on("context_with_system", (_event, context) => { check(currentModel(context)); });
  pi.on("before_provider_request", (event, context) => {
    const model = currentModel(context);
    check(model);
    const expected = expectedPayloadModel(model);
    const payload: unknown = event.payload;
    if (!expected || typeof payload !== "object" || payload === null) return;
    const sent = (payload as Record<string, unknown>)[expected.field];
    if (typeof sent === "string" && sent !== expected.value) stop(describePayloadModel(sent));
  });
}
