import { runAbortable } from "../async-settlement.js";
import type {
  AgentToolResult,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import {
  FABRIC_TOOL_RESULT_PROXY_KIND,
  readFabricToolResultProxyDetailsV1,
  type FabricToolResultProxyDetailsV1,
} from "../protocol.js";
import type { ResolvedFabricAction } from "./action-registry.js";

type ToolContent = AgentToolResult<unknown>["content"];

export interface FabricToolResultProxyRequest {
  action: ResolvedFabricAction;
  args: Record<string, unknown>;
  toolCallId: string;
  /** The call that issued this one, normally the outer `fabric_exec`. */
  parentToolCallId?: string;
  value: unknown;
  signal?: AbortSignal;
}

export interface FabricNestedToolResultProxy {
  proxy(request: FabricToolResultProxyRequest): Promise<unknown>;
}

const nativeLifecycleProviders = new Set(["pi", "extensions"]);

const textFromContent = (content: ToolContent): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const textForValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const valueFromContent = (content: ToolContent): unknown => {
  if (content.every((part) => part.type === "text")) return textFromContent(content);
  return { content };
};

// A cut-off projection keeps a real prefix of the original text, at least
// half of what it returns, and drops the rest. A placeholder shares little or
// nothing with the original, so it never counts as one.
const isCutOff = (patched: string, original: string): boolean => {
  const limit = Math.min(patched.length, original.length);
  let shared = 0;
  while (shared < limit && patched.charCodeAt(shared) === original.charCodeAt(shared)) shared++;
  return shared < original.length && shared * 2 >= patched.length;
};

export class FabricToolResultProxy implements FabricNestedToolResultProxy {
  constructor(readonly runner: () => ExtensionRunner | undefined) {}

  async proxy(request: FabricToolResultProxyRequest): Promise<unknown> {
    if (nativeLifecycleProviders.has(request.action.provider)) return request.value;
    const runner = this.runner();
    if (!runner) return request.value;

    const content: ToolContent = [{ type: "text", text: textForValue(request.value) }];
    const details: FabricToolResultProxyDetailsV1 = {
      kind: FABRIC_TOOL_RESULT_PROXY_KIND,
      ref: request.action.ref,
      result: request.value,
    };
    const patch = await runAbortable(request.signal, () => runner.emitToolResult({
      type: "tool_result",
      toolName: request.action.ref,
      toolCallId: request.toolCallId,
      ...(request.parentToolCallId !== undefined ? { parentToolCallId: request.parentToolCallId } : {}),
      input: request.args,
      content,
      details,
      isError: false,
    }));
    if (!patch) return request.value;

    const patchedContent = patch.content ?? content;
    if (patch.isError === true) {
      throw new Error(
        textFromContent(patchedContent).trim() ||
          `Fabric result middleware marked ${request.action.ref} as failed.`,
      );
    }

    const patchedDetails = readFabricToolResultProxyDetailsV1(patch.details);
    if (
      patchedDetails?.ref === request.action.ref &&
      !Object.is(patchedDetails.result, request.value)
    ) {
      return patchedDetails.result;
    }
    if (patchedContent === content) return request.value;
    // A content-only patch replaces a string result.
    if (typeof request.value === "string") return valueFromContent(patchedContent);
    // A structured value keeps its shape only when the patch shows it kept
    // the value. Text that still parses as JSON is a redaction or rewrite that
    // kept the shape, so the program receives the parsed value. A generic
    // output cap keeps the start of the JSON projection and cuts the rest;
    // applying that text would hand the program a truncated string where it
    // expects an array or object, so the original stays and
    // `maxNestedResultChars` still bounds it. Anything else, such as a
    // placeholder that hides the value, replaces it as before: middleware
    // that hides a result must not fail open.
    if (!patchedContent.every((part) => part.type === "text")) return valueFromContent(patchedContent);
    const patchedText = textFromContent(patchedContent);
    const originalText = textForValue(request.value);
    if (patchedText === originalText) return request.value;
    try {
      return JSON.parse(patchedText) as unknown;
    } catch {
      return isCutOff(patchedText, originalText) ? request.value : patchedText;
    }
  }
}
