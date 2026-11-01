import { afterEach, describe, expect, it, vi } from "vitest";
import { constrainChildToolSelection, nativeFabricExecExclusions, readChildToolAllowlist } from "../src/core/child-tool-allowlist.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { ActionRegistry } from "../src/core/action-registry.js";

const context = { cwd: process.cwd(), signal: new AbortController().signal } as FabricInvocationContext;
afterEach(() => vi.unstubAllEnvs());

describe("child optional tool allowlist", () => {
  it("leaves the host unrestricted and fails closed for malformed inherited authority", () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    expect(readChildToolAllowlist()).toBeUndefined();
    for (const value of ["", "null", "{}", "not json", '["read", 1]']) {
      expect(readChildToolAllowlist(value)!.entries).toEqual([]);
    }
    expect(readChildToolAllowlist('["read", "fabric_exec"]')!.entries).toEqual(["read"]);
    expect(readChildToolAllowlist('["read", "fabric_exec"]')!.fabricExec).toBe(true);
    expect(readChildToolAllowlist('["read", "fabric_*"]')!.fabricExec).toBe(false);
    expect(readChildToolAllowlist("not json")!.fabricExec).toBe(false);
  });

  it("matches * entries with the semantics of Pi's --tools (#277)", () => {
    const allowed = readChildToolAllowlist('["read", "mcp__srv__*", "*_search"]')!;
    expect(allowed.has("read")).toBe(true);
    expect(allowed.has("mcp__srv__lookup")).toBe(true);
    expect(allowed.has("mcp__srv__")).toBe(true);
    expect(allowed.has("mcp__other__lookup")).toBe(false);
    expect(allowed.has("web_search")).toBe(true);
    expect(allowed.has("web_search_v2")).toBe(false);
    expect(allowed.has("bash")).toBe(false);
    // Other characters stay literal.
    expect(readChildToolAllowlist('["a.b*"]')!.has("aXb_tool")).toBe(false);
    // A grandchild pattern passes only when an inherited pattern covers it.
    expect(allowed.has("mcp__srv__*")).toBe(true);
    expect(allowed.has("mcp__srv__get*")).toBe(true);
    expect(allowed.has("mcp__*")).toBe(false);
    expect(allowed.has("*")).toBe(false);
    // fabric_exec is never inherited, even through a catch-all pattern.
    const all = readChildToolAllowlist('["*"]')!;
    expect(all.has("mcp__srv__lookup")).toBe(true);
    expect(all.has("fabric_exec")).toBe(false);
  });

  it("constrains signed selectors without inheriting unknown native defaults", () => {
    const read = readChildToolAllowlist('["read"]')!;
    expect(constrainChildToolSelection(["+read", "-write", "+bash"], read)).toEqual(["read"]);
    expect(constrainChildToolSelection(["-write"], read)).toEqual([]);
    expect(readChildToolAllowlist('["+read","+fabric_exec"]')!.fabricExec).toBe(false);
    expect(readChildToolAllowlist('["+read","-read"]')!.entries).toEqual([]);
    for (const raw of ['["read","+bash"]', '["+*"]', '["read,bash"]', '[""]']) {
      expect(readChildToolAllowlist(raw)!.entries).toEqual([]);
      expect(() => constrainChildToolSelection(JSON.parse(raw), read)).toThrow(/Invalid child tools/);
    }
    expect(nativeFabricExecExclusions(["*"])).toEqual(["fabric_exec"]);
    expect(nativeFabricExecExclusions(["fabric_exec"])).toEqual([]);
  });

  it("filters discovery and blocks preparation and execution before any side effect", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const provider = new PiToolsProvider(process.cwd());
    expect((await provider.list({}, context)).map((entry) => entry.name)).toEqual(["read"]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("edit", { path: "must-not-read", oldText: "x", newText: "y", all: true })).toThrow(/allowlist/);
    await expect(provider.invoke("bash", { command: "must-not-execute" }, context)).rejects.toThrow(/allowlist/);
    // Permissions are frozen when the provider is created, not ambient mutable policy.
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["bash"]');
    expect(await provider.describe("read", context)).toBeDefined();
    expect(await provider.describe("bash", context)).toBeUndefined();
  });

  it("cannot bypass the allowlist through the captured-tool namespace", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read", "fabric_exec"]');
    const catalog = new CapturedToolCatalog();
    const entry = { name: "bash", definition: { description: "shell", parameters: {} }, sourceInfo: { path: "/extension/index.ts" }, risk: "execute" };
    const list = vi.spyOn(catalog, "list").mockReturnValue([entry] as never);
    const get = vi.spyOn(catalog, "get").mockReturnValue(entry as never);
    const require = vi.spyOn(catalog, "require");
    const provider = new CapturedToolsProvider(catalog);
    expect(await provider.list({}, context)).toEqual([]);
    expect(await provider.describe("bash", context)).toBeUndefined();
    expect(() => provider.prepareArguments("bash", {})).toThrow(/allowlist/);
    await expect(provider.invoke("bash", {}, context)).rejects.toThrow(/allowlist/);
    expect(require).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });
});

describe("calling a tool outside the child's allowlist", () => {
  const capturedEntry = (name: string) => ({
    name,
    definition: { description: `${name} tool`, parameters: { type: "object", properties: {} } },
    sourceInfo: { path: "/extension/index.ts" },
    risk: "write",
  });
  const registryWith = (names: string[]) => {
    const catalog = new CapturedToolCatalog();
    const entries = new Map(names.map((name) => [name, capturedEntry(name)]));
    vi.spyOn(catalog, "list").mockReturnValue([...entries.values()] as never);
    vi.spyOn(catalog, "get").mockImplementation((name: string) => entries.get(name) as never);
    const captured = new CapturedToolsProvider(catalog);
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), catalog, captured));
    registry.register(captured);
    return registry;
  };
  const invoke = { ...context, approve: async () => {}, audits: [], maxResultChars: 10_000 };

  it("says a core override is not permitted instead of unknown", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read", "edit"]');
    const registry = registryWith(["replace"]);
    await expect(registry.invoke("pi.replace", {}, invoke)).rejects.toThrow(
      "Pi tool replace is not permitted by this child's tool allowlist",
    );
    await expect(registry.invoke("pi.bash", { command: "must-not-execute" }, invoke)).rejects.toThrow(
      "Pi tool bash is not permitted by this child's tool allowlist",
    );
  });

  it("says an extension tool is not permitted instead of unknown", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read"]');
    const registry = registryWith(["replace"]);
    await expect(registry.invoke("extensions.replace", {}, invoke)).rejects.toThrow(
      "Extension tool replace is not permitted by this child's tool allowlist",
    );
  });

  it("still reports a tool the parent does not have as unknown", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read"]');
    const registry = registryWith(["replace"]);
    await expect(registry.invoke("pi.no_such_tool", {}, invoke)).rejects.toThrow("Unknown Fabric action: pi.no_such_tool");
    await expect(registry.invoke("extensions.no_such_tool", {}, invoke)).rejects.toThrow("Unknown Fabric action: extensions.no_such_tool");
  });

  it("keeps blocked tools out of discovery", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read"]');
    const registry = registryWith(["replace"]);
    const refs = (await registry.listDetailed({}, context)).actions.map((action) => action.ref);
    expect(refs).toContain("pi.read");
    expect(refs).not.toContain("pi.replace");
    expect(refs).not.toContain("pi.bash");
    expect(refs).not.toContain("extensions.replace");
  });
});
