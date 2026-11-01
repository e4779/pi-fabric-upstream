import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { FABRIC_PARTIAL_UPDATE_MAX_BYTES } from "../src/audit/details.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

const CALLS = 400;
// Each call sends and returns about 2.3 KB, like one batched classifier request.
const PAYLOAD = "q".repeat(2_300);
// A fixed ceiling far below a 4 MB transport line, independent of the call count.
const MAX_UPDATE_BYTES = FABRIC_PARTIAL_UPDATE_MAX_BYTES;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const harness = () => {
  const registry = new ActionRegistry();
  const descriptor = {
    name: "echo",
    description: "return the request",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
    risk: "read" as const,
  };
  registry.register({
    name: "demo",
    description: "echo fixture",
    async list() { return [descriptor]; },
    async describe(name) { return name === "echo" ? descriptor : undefined; },
    async invoke(_name, args) { return { echoed: args.text }; },
  });
  const config = normalizeFabricConfig({ fullCodeMode: false });
  config.approvals.read = "allow";
  config.ui.updateDebounceMs = 0;
  const service = new FabricExecutionService(registry, config);
  const state = {
    bootstrapped: true,
    initialized: true,
    config,
    ensure: vi.fn(async () => {}),
    claimHandoff: vi.fn(async () => undefined),
    prewalk: { planRequired: () => false, status: () => ({ state: "idle" }) },
    execution: service,
  } as unknown as FabricState;
  const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (value) => value);
  const context = {
    mode: "tui",
    hasUI: false,
    cwd: process.cwd(),
    ui: { setTitle: () => {}, setStatus: () => {}, notify: () => {} },
    sessionManager: { getEntries: () => [], getSessionId: () => "session-1", getSessionName: () => "updates" },
  } as unknown as ExtensionContext;
  return { tool, context };
};

describe("fabric_exec progress updates", () => {
  it("stay under a fixed size however many nested calls one program makes", async () => {
    const { tool, context } = harness();
    const updates: Array<{ bytes: number; value: { content: unknown[]; details?: unknown } }> = [];
    const code = `let n = 0;
for (let i = 0; i < ${CALLS}; i++) {
  const r = await tools.call({ ref: "demo.echo", args: { text: ${JSON.stringify(PAYLOAD)} + i } });
  n += r.echoed.length;
}
return n;`;
    const result = await tool.execute!(
      "many-calls",
      { code, resultFormat: "json" } as never,
      undefined,
      (update) => updates.push({ bytes: Buffer.byteLength(JSON.stringify(update), "utf8"), value: update as never }),
      context as never,
    );

    expect(result.isError ?? false).toBe(false);
    // The program's own return is untouched by the update bound.
    const expected = Array.from({ length: CALLS }, (_v, i) => PAYLOAD.length + String(i).length)
      .reduce((sum, length) => sum + length, 0);
    expect(result.content).toEqual([{ type: "text", text: String(expected) }]);

    expect(updates.length).toBeGreaterThanOrEqual(CALLS);
    const largest = Math.max(...updates.map((update) => update.bytes));
    expect(largest).toBeLessThan(MAX_UPDATE_BYTES);

    // The live card still counts every call, including those left out of the update.
    const last = updates.at(-1)!.value;
    const card = tool.renderResult!(
      last as never,
      { expanded: false, isPartial: true },
      plainTheme,
      {
        args: { code }, toolCallId: "many-calls", invalidate: () => {}, lastComponent: undefined,
        state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true,
        isPartial: true, expanded: false, showImages: false, isError: false,
      } as never,
    ).render(160).join("\n");
    expect(card).toContain(`${CALLS}/${CALLS} calls`);
    expect(card).toContain(`… ${CALLS - 8} nested calls hidden`);
  }, 120_000);

  it("bounds real phase updates while keeping the return value and deadline", async () => {
    const { tool, context } = harness();
    const sizes: number[] = [];
    const deadlines: number[] = [];
    const result = await tool.execute!(
      "large-phases",
      { code: 'for (let i = 0; i < 8; i++) await phase("phase-" + i + "\\0".repeat(20_000)); return 8;', resultFormat: "json", timeout_ms: 30_000 } as never,
      undefined,
      (update) => {
        sizes.push(Buffer.byteLength(JSON.stringify(update), "utf8"));
        const deadline = (update.details as { deadlineAt?: number } | undefined)?.deadlineAt;
        if (deadline !== undefined) deadlines.push(deadline);
      },
      context as never,
    );
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "8" }]);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_UPDATE_BYTES);
    expect(deadlines.length).toBeGreaterThan(0);
  }, 30_000);
});
