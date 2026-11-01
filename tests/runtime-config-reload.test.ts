import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { FABRIC_COMPONENT_DISCOVER_EVENT, type FabricComponentDiscovery } from "../src/protocol.js";

// Two enabled entries of "svc" both provide the "svc" provider, so the
// component loader rejects any reload that lists two of them.
const fixture = async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-config-reload-"));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const pi = {
    events: {
      emit: vi.fn((event: string, payload: unknown) => {
        if (event !== FABRIC_COMPONENT_DISCOVER_EVENT) return;
        (payload as FabricComponentDiscovery).register({
          name: "svc",
          provides: ["svc"],
          activate(component) {
            component.provide({
              name: "svc", description: "svc",
              async list() { return []; },
              async describe() { return undefined; },
              async invoke() { return undefined; },
            });
          },
        });
      }),
    },
    getThinkingLevel: () => "off",
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const context = {
    cwd, hasUI: true, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: { getSessionId: () => "config-reload", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => undefined },
    ui: { setStatus: vi.fn(), notify },
  } as unknown as ExtensionContext;
  const configWith = (components: Array<{ id: string; component: string; config?: unknown }>) => normalizeFabricConfig({
    components,
    mcp: { enabled: false, cache: { enabled: false } },
    agents: { enabled: false }, residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false }, mesh: { enabled: false },
  });
  const unused = path.join(cwd, "unused.mjs");
  fs.writeFileSync(unused, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: unused, worker: unused, residentHost: unused, skills: cwd },
  });
  await runtime.initialize(context, configWith([{ id: "one", component: "svc" }]));
  const configured = () => runtime.componentGraph().components
    .filter(component => !component.id.startsWith("fabric."))
    .map(component => [component.id, component.state]);
  const close = async () => { await runtime.shutdown(); vi.unstubAllEnvs(); fs.rmSync(cwd, { recursive: true, force: true }); };
  return { runtime, context, notify, configWith, configured, close };
};

describe("runtime config reload rejection", () => {
  it("restores the active components after a refused reload and applies the next one", async () => {
    const { runtime, context, notify, configWith, configured, close } = await fixture();
    try {
      runtime.reloadConfig(context, configWith([{ id: "one", component: "svc" }, { id: "two", component: "svc" }]));
      await runtime.settleComponents();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("component reload failed"), "error");
      expect(runtime.config.components).toEqual([{ id: "one", component: "svc" }]);

      runtime.reloadConfig(context, configWith([{ id: "one", component: "svc", config: { revision: 2 } }]));
      await runtime.settleComponents();
      expect(runtime.config.components).toEqual([{ id: "one", component: "svc", config: { revision: 2 } }]);
      expect(configured()).toEqual([["one", "active"]]);
    } finally { await close(); }
  });

  it("never restores an earlier refused reload's components when two reloads are refused back to back", async () => {
    const { runtime, context, notify, configWith, configured, close } = await fixture();
    try {
      runtime.reloadConfig(context, configWith([{ id: "a1", component: "svc" }, { id: "a2", component: "svc" }]));
      runtime.reloadConfig(context, configWith([{ id: "b1", component: "svc" }, { id: "b2", component: "svc" }]));
      await runtime.settleComponents();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(configured()).toEqual([["one", "active"]]);
      expect(runtime.config.components).toEqual([{ id: "one", component: "svc" }]);
    } finally { await close(); }
  });

  it("keeps an accepted reload when a later reload in the same turn is refused", async () => {
    const { runtime, context, configWith, close } = await fixture();
    try {
      runtime.reloadConfig(context, configWith([{ id: "one", component: "svc", config: { revision: 2 } }]));
      runtime.reloadConfig(context, configWith([{ id: "b1", component: "svc" }, { id: "b2", component: "svc" }]));
      await runtime.settleComponents();
      expect(runtime.config.components).toEqual([{ id: "one", component: "svc", config: { revision: 2 } }]);
    } finally { await close(); }
  });
});
