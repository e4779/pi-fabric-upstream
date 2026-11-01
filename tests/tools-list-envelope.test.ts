import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricProvider } from "../src/protocol.js";

const bulkProvider = (name: string, count: number): FabricProvider => {
  const descriptors = Array.from({ length: count }, (_, index) => ({
    name: `a${String(index).padStart(5, "0")}`,
    description: `${name} action ${index}`,
    inputSchema: { type: "object", properties: {} },
    risk: "read" as const,
  }));
  return {
    name,
    description: `Bulk provider ${name}`,
    async list() {
      return descriptors;
    },
    async describe(actionName) {
      return descriptors.find((descriptor) => descriptor.name === actionName);
    },
    async invoke() {
      return null;
    },
  };
};

const listEnvelope = async (providers: FabricProvider[], code: string) => {
  const registry = new ActionRegistry();
  for (const provider of providers) registry.register(provider);
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = false;
  config.approvals.read = "allow";
  const service = new FabricExecutionService(registry, config);
  const result = await service.execute({
    code,
    signal: undefined,
    parentToolCallId: "list-envelope-test",
    context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
    onPartial() {},
  });
  return result.value as { kind: string; actions: unknown[]; total: number; truncated: boolean; limit: number };
};

describe("tools.list envelope totals past the 1000-action cap", () => {
  it("counts every action, not only the first 1000", async () => {
    const page = await listEnvelope(
      [bulkProvider("alpha", 1350)],
      'return tools.list({ envelope: true, provider: "alpha", limit: 10 });',
    );
    expect(page.kind).toBe("pi-fabric.action-list");
    expect(page.actions).toHaveLength(10);
    expect(page.total).toBe(1350);
    expect(page.truncated).toBe(true);
  });

  it("reports a full 1000-action page as truncated when more actions exist", async () => {
    const page = await listEnvelope(
      [bulkProvider("alpha", 1001)],
      'return tools.list({ envelope: true, provider: "alpha", limit: 1000 });',
    );
    expect(page.actions).toHaveLength(1000);
    expect(page.total).toBe(1001);
    expect(page.truncated).toBe(true);
  });

  it("reports a page holding every action as complete", async () => {
    const page = await listEnvelope(
      [bulkProvider("alpha", 1000)],
      'return tools.list({ envelope: true, provider: "alpha", limit: 1000 });',
    );
    expect(page.actions).toHaveLength(1000);
    expect(page.total).toBe(1000);
    expect(page.truncated).toBe(false);
  });
});
