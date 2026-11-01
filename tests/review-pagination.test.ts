import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { ComponentsProvider } from "../src/providers/components-provider.js";
import type { FabricInvocationContext, FabricProviderListRequest } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(), signal: undefined, parentToolCallId: "pagination",
  nestedToolCallId: "pagination", extensionContext: {} as ExtensionContext, update() {},
};

describe("discovery enumeration before pagination", () => {
  it("does not pass the user page limit or a hidden 1000 cap to providers", async () => {
    const registry = new ActionRegistry();
    const requests: FabricProviderListRequest[] = [];
    const descriptors = Array.from({ length: 1505 }, (_, index) => ({
      name: `action${index}`, description: "enumerated action", namespace: "all",
      inputSchema: { type: "object" }, risk: "read" as const,
    }));
    registry.register({
      name: "demo", description: "Limit-aware provider",
      async list(request) {
        requests.push(request);
        return request.limit === undefined ? descriptors : descriptors.slice(0, request.limit);
      },
      async describe(name) { return descriptors.find((descriptor) => descriptor.name === name); },
      async invoke() {},
    });
    try {
      const page = await registry.listDetailed({ provider: "demo", limit: 1 }, context);
      expect(page).toMatchObject({ total: 1505, truncated: true });
      expect(page.actions).toHaveLength(1);
      expect(requests).toEqual([{ namespace: undefined, query: undefined }]);
      const capped = await registry.listDetailed({ provider: "demo", limit: 5000 }, context);
      expect(capped.actions).toHaveLength(1000);
      expect(capped).toMatchObject({ total: 1505, truncated: true });
      const filtered = await registry.listDetailed({ provider: "demo", limit: 1 }, context,
        (action) => Number(action.name.slice("action".length)) >= 1500);
      expect(filtered).toMatchObject({ total: 5, truncated: true });
      expect(filtered.actions[0]?.name).toBe("action1500");
    } finally {
      await registry.close(new Set(["demo"]));
    }
  });

  it("reports honest totals for the real ComponentsProvider with limit 1", async () => {
    const registry = new ActionRegistry();
    const loader = new FabricComponentLoader(new FabricComponentCatalog(), new FabricComponentSupervisor(registry, {
      invocationContext: () => context,
    }));
    const provider = new ComponentsProvider(loader);
    registry.register(provider);
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    const service = new FabricExecutionService(registry, config);
    try {
      const all = await provider.list({}, context);
      expect(all.length).toBeGreaterThan(1);
      expect(await provider.list({ limit: 1 }, context)).toHaveLength(1);
      const result = await service.execute({
        code: 'return tools.list({provider:"components",limit:1,envelope:true});',
        signal: undefined, parentToolCallId: "pagination",
        context: { cwd: process.cwd(), hasUI: false } as ExtensionContext, onPartial() {},
      });
      expect(result.success, result.error).toBe(true);
      expect(result.value).toMatchObject({
        kind: "pi-fabric.action-list", total: all.length, truncated: true, limit: 1,
        actions: [expect.objectContaining({ provider: "components" })],
      });
      const matching = await registry.listDetailed({ provider: "components", query: "lifecycle", limit: 1 }, context);
      expect(matching.total).toBe(all.filter((action) => `${action.name} ${action.description}`.includes("lifecycle")).length);
    } finally {
      await loader.close();
      await registry.close(new Set(["components"]));
    }
  });
});
