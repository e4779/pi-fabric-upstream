import type {
  ExtensionRunner,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  type ResolvedFabricAction,
} from "../src/core/action-registry.js";
import {
  FabricToolResultProxy,
  type FabricNestedToolResultProxy,
} from "../src/core/tool-result-proxy.js";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
  type FabricInvocationContext,
  type FabricProvider,
} from "../src/protocol.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const action = (provider = "demo"): ResolvedFabricAction => ({
  ref: `${provider}.echo`,
  provider,
  name: "echo",
  description: "Echo a value",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk: "read",
});

const request = (value: unknown, provider = "demo") => ({
  action: action(provider),
  args: { query: "value" },
  toolCallId: `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}test`,
  value,
});

const runnerWith = (
  emitToolResult: ReturnType<typeof vi.fn>,
): ExtensionRunner => ({ emitToolResult }) as unknown as ExtensionRunner;

describe("FabricToolResultProxy", () => {
  it("emits a namespaced nested tool_result and applies a content patch", async () => {
    const emitToolResult = vi.fn(async (_event: ToolResultEvent) => ({
      content: [{ type: "text" as const, text: "bounded preview" }],
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request("unbounded output"))).resolves.toBe("bounded preview");

    expect(emitToolResult).toHaveBeenCalledOnce();
    const event = emitToolResult.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      type: "tool_result",
      toolName: "demo.echo",
      toolCallId: `${FABRIC_NESTED_TOOL_CALL_ID_PREFIX}test`,
      input: { query: "value" },
      content: [{ type: "text", text: "unbounded output" }],
      isError: false,
    });
    expect(event).not.toHaveProperty("parentToolCallId");

    // The caller's id travels with the event when the registry supplies it.
    await proxy.proxy({ ...request("unbounded output"), parentToolCallId: "call_outer" });
    expect(emitToolResult.mock.calls[1]?.[0]).toMatchObject({ toolName: "demo.echo", parentToolCallId: "call_outer" });
    expect(readFabricToolResultProxyDetailsV1(event?.details)).toMatchObject({
      ref: "demo.echo",
      result: "unbounded output",
    });
  });

  it("uses a proxy-details result patch without flattening structured values", async () => {
    const replacement = {
      fabricTruncated: true,
      preview: "bounded",
      artifact: { id: "artifact_test" },
    };
    const emitToolResult = vi.fn(async (event: { details: unknown }) => ({
      details: {
        ...readFabricToolResultProxyDetailsV1(event.details),
        result: replacement,
      },
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request({ rows: [1, 2, 3] }))).resolves.toBe(replacement);
  });

  it("preserves the original value when middleware does not patch it", async () => {
    const original = { rows: [1, 2, 3] };
    const emitToolResult = vi.fn(async () => undefined);
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request(original))).resolves.toBe(original);
  });

  it.each([
    ["array", Array.from({ length: 20 }, (_, index) => ({ id: `agent-${index}` }))],
    ["object", { rows: Array.from({ length: 50 }, (_, index) => index) }],
  ])("keeps a structured %s when an output cap cuts its text", async (_kind, original) => {
    // A generic tool_result output cap keeps the start of the JSON text of a
    // large result and appends a marker. Applying that text would hand the
    // program a truncated string where it expects the value, so
    // `agents.list().filter` would throw.
    const emitToolResult = vi.fn(async (event: ToolResultEvent) => ({
      content: [{
        type: "text" as const,
        text: `${(event.content[0] as { text: string }).text.slice(0, 60)}\n[output capped at 50KB]`,
      }],
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request(original))).resolves.toBe(original);
    expect(emitToolResult).toHaveBeenCalledOnce();
  });

  it.each([
    ["array", ["hunter2"]],
    ["object", { token: "hunter2" }],
    ["number", 42],
    ["boolean", true],
    ["null", null],
  ])("lets a placeholder hide a structured %s", async (_kind, original) => {
    // A redactor that replaces the whole text must not fail open.
    const emitToolResult = vi.fn(async () => ({ content: [{ type: "text" as const, text: "[REDACTED]" }] }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request(original))).resolves.toBe("[REDACTED]");
  });

  it("applies a content patch that keeps a structured value valid JSON", async () => {
    // A redactor rewrites a secret inside the serialized value. The text still
    // parses, so the program gets the redacted value, not the raw one.
    const emitToolResult = vi.fn(async (event: ToolResultEvent) => ({
      content: [{
        type: "text" as const,
        text: (event.content[0] as { text: string }).text.replace("hunter2", "[redacted]"),
      }],
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request({ user: "ada", password: "hunter2" }))).resolves.toEqual({
      user: "ada",
      password: "[redacted]",
    });
    await expect(proxy.proxy(request(["hunter2", "ok"]))).resolves.toEqual(["[redacted]", "ok"]);
  });

  it("keeps a structured value when the patched text changes nothing", async () => {
    const original = { token: "hunter2" };
    const emitToolResult = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify(original) }] }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request(original))).resolves.toBe(original);
  });

  it("replaces a structured value with a patch that has a non-text part", async () => {
    const content = [
      { type: "text" as const, text: "{}" },
      { type: "image" as const, data: "AAAA", mimeType: "image/png" },
    ];
    const emitToolResult = vi.fn(async () => ({ content }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request({ token: "hunter2" }))).resolves.toEqual({ content });
  });

  it("still fails a structured value that middleware marks as an error", async () => {
    const emitToolResult = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "blocked: result holds a credential" }],
      isError: true,
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request({ token: "secret" }))).rejects.toThrow(
      "blocked: result holds a credential",
    );
  });

  it.each(["pi", "extensions"])(
    "does not duplicate the native %s lifecycle",
    async (provider) => {
      const emitToolResult = vi.fn(async () => undefined);
      const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));
      const original = { ok: true };

      await expect(proxy.proxy(request(original, provider))).resolves.toBe(original);
      expect(emitToolResult).not.toHaveBeenCalled();
    },
  );

  it("turns an isError patch into a provider invocation failure", async () => {
    const emitToolResult = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rejected by guard" }],
      isError: true,
    }));
    const proxy = new FabricToolResultProxy(() => runnerWith(emitToolResult));

    await expect(proxy.proxy(request("value"))).rejects.toThrow("rejected by guard");
  });
});

const provider = (): FabricProvider => ({
  name: "demo",
  description: "Demo provider",
  async list() {
    return [action()];
  },
  async describe(name) {
    return name === "echo" ? action() : undefined;
  },
  async invoke() {
    return "x".repeat(1_000);
  },
});

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

describe("ActionRegistry result proxy", () => {
  it("runs the proxy before maxNestedResultChars is enforced", async () => {
    const proxy: FabricNestedToolResultProxy = {
      proxy: vi.fn(async ({ value }) => ({
        artifact: "artifact_test",
        originalChars: (value as string).length,
      })),
    };
    const registry = new ActionRegistry(proxy);
    registry.register(provider());

    const result = await registry.invoke("demo.echo", {}, {
      ...context,
      approve: async () => {},
      audits: [],
      maxResultChars: 100,
    });

    expect(result).toEqual({ artifact: "artifact_test", originalChars: 1_000 });
    expect(proxy.proxy).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: expect.stringMatching(/^fabric_/),
      parentToolCallId: "parent",
      value: "x".repeat(1_000),
    }));
  });
});
