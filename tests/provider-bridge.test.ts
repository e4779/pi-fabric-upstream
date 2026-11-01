import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fabricProviderBridge, {
  fabricExtensionEntries,
  orderProviderCandidates,
  parseModelKey,
  PROVIDER_BRIDGE_MODEL_ENV,
  resolveExtensionProviders,
} from "../src/agents/provider-bridge.js";
import { hostBundleSdkEntry, hostSdkEntry, loadHostSdk } from "../src/core/host-sdk.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

/** An extension that records its own load and registers one config provider. */
const extensionSource = (marker: string, provider?: string) => `
import fs from "node:fs";
export default function (pi) {
  fs.appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  pi.registerTool({ name: "leaked_tool", label: "Leaked", description: "must not bind", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "leaked" }], details: {} }; } });
  pi.registerCommand("leaked-command", { description: "must not bind", handler: async () => {} });
  pi.on("session_start", () => fs.appendFileSync(${JSON.stringify(marker)}, "session_start\\n"));
  ${provider ? `pi.registerProvider(${JSON.stringify(provider)}, {
    baseUrl: "https://${provider}.invalid/v1", apiKey: "$FIXTURE_PROVIDER_KEY", api: "openai-completions",
    models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });` : ""}
}
`;

function fixture(options: {
  extensions: Array<{ dir: string; provider?: string; project?: boolean; source?: (marker: string) => string }>;
  settings?: Record<string, unknown>;
  models?: Record<string, unknown>;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-provider-bridge-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const markers: Record<string, string> = {};
  const globalPaths: string[] = [];
  for (const extension of options.extensions) {
    const base = extension.project ? path.join(cwd, ".pi", "extensions") : path.join(root, "packages");
    const file = path.join(base, extension.dir, "index.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const marker = path.join(root, `${extension.dir}.marker`);
    markers[extension.dir] = marker;
    fs.writeFileSync(file, extension.source?.(marker) ?? extensionSource(marker, extension.provider));
    if (!extension.project) globalPaths.push(file);
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: globalPaths, ...options.settings }));
  if (options.models) fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(options.models));
  const loads = (dir: string) => fs.existsSync(markers[dir]!) ? fs.readFileSync(markers[dir]!, "utf8").trim().split("\n") : [];
  return { root, cwd, agentDir, markers, loads };
}

describe("extension provider bridge", () => {
  it("parses canonical model keys at the first slash", () => {
    expect(parseModelKey("coralbricks/glm-5.3-fast")).toEqual({ provider: "coralbricks", id: "glm-5.3-fast" });
    expect(parseModelKey("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", id: "anthropic/claude" });
    expect(parseModelKey("bare")).toBeUndefined();
    expect(parseModelKey("/id")).toBeUndefined();
    expect(parseModelKey("provider/")).toBeUndefined();
  });

  it("probes extensions whose own path names the provider first", () => {
    const ordered = orderProviderCandidates([
      "/home/u/.pi/agent/npm/node_modules/pi-better-openai/index.ts",
      "/home/u/.pi/agent/npm/node_modules/pi-coralbricks-provider/index.ts",
      "/home/u/coralbricks-fan/work/node_modules/unrelated/dist/index.js",
      "/home/u/.pi/agent/extensions/CoralBricks.ts",
    ], "coralbricks");
    expect(ordered.named).toEqual([
      "/home/u/.pi/agent/npm/node_modules/pi-coralbricks-provider/index.ts",
      "/home/u/.pi/agent/extensions/CoralBricks.ts",
    ]);
    expect(ordered.rest).toHaveLength(2);
  });

  it("excludes Fabric's own manifest entries from probing, but not bundled packages", () => {
    const entries = fabricExtensionEntries();
    expect(entries).toEqual(expect.arrayContaining([
      path.resolve("dist/index.js"),
      path.resolve("dist/extension-bootstrap.js"),
    ]));
    expect(entries.some((entry) => entry.split(path.sep).includes("node_modules"))).toBe(false);
  });

  it("treats every node_modules manifest entry as a bundled package, in any spelling", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-bridge-manifest-")));
    roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "pi-fabric", main: "./dist/index.js",
      pi: { extensions: ["./dist/extension-bootstrap.js", "./node_modules/a/index.ts", "node_modules/@scope/b/x.ts", "node_modules\\c\\y.ts"] },
    }));
    const entries = fabricExtensionEntries(pathToFileURL(path.join(root, "dist", "agents", "provider-bridge.js")).href);
    expect(entries).toEqual([path.join(root, "dist", "index.js"), path.join(root, "dist", "extension-bootstrap.js")]);
  });

  it("uses the bundled Pi CLI's own SDK entry instead of evaluating the unbundled package", async () => {
    const pkg = fs.realpathSync(path.resolve("node_modules/@earendil-works/pi-coding-agent"));
    const bundle = path.join(pkg, "dist", "bundle");
    expect(hostBundleSdkEntry(path.join(bundle, "cli.js"))).toBe(path.join(bundle, "index.js"));
    const sdk = await loadHostSdk(path.join(bundle, "cli.js"));
    const bundled = await import(pathToFileURL(path.join(bundle, "index.js")).href) as typeof sdk;
    expect(sdk.DefaultResourceLoader).toBe(bundled.DefaultResourceLoader);
    expect(sdk.DefaultResourceLoader).not.toBe(DefaultResourceLoader);
    for (const name of ["ModelRuntime", "SettingsManager", "hasTrustRequiringProjectResources", "ProjectTrustStore",
      "DefaultPackageManager", "getAgentDir"] as const) expect(typeof sdk[name]).toBe("function");

    // Unbundled CLIs, the durable worker, embeds, and look-alike paths keep the package entry.
    const lookalike = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-bridge-host-"))), "dist", "bundle");
    roots.push(path.dirname(path.dirname(lookalike)));
    fs.mkdirSync(lookalike, { recursive: true });
    fs.writeFileSync(path.join(lookalike, "..", "..", "package.json"), '{"name":"not-pi"}');
    fs.writeFileSync(path.join(lookalike, "cli.js"), "");
    fs.writeFileSync(path.join(lookalike, "index.js"), "");
    for (const host of [path.join(pkg, "dist", "cli.js"), path.resolve("src/durable/worker.ts"),
      path.join(lookalike, "cli.js"), path.join(bundle, "missing", "cli.js"), undefined]) {
      expect(hostBundleSdkEntry(host)).toBeUndefined();
    }
    expect((await loadHostSdk(path.join(pkg, "dist", "cli.js"))).DefaultResourceLoader).toBe(DefaultResourceLoader);

    // The running CLI's own entry, never a package lookup: managed installs have no host SDK on disk beside Fabric.
    expect(hostSdkEntry(path.join(bundle, "cli.js"))).toBe(path.join(bundle, "index.js"));
    expect(hostSdkEntry(path.join(pkg, "dist", "cli.js"))).toBe(path.join(pkg, "dist", "index.js"));
    for (const host of [path.resolve("src/durable/worker.ts"), path.join(lookalike, "cli.js"),
      path.join(lookalike, "..", "cli.js"), path.join(bundle, "missing", "cli.js"), undefined]) {
      expect(hostSdkEntry(host)).toBeUndefined();
    }
  });

  it("registers only the named extension's provider and runs no other extension", async () => {
    const { cwd, agentDir, loads } = fixture({ extensions: [
      { dir: "pi-unrelated" },
      { dir: "pi-acme-provider", provider: "acme" },
    ] });
    const found = await resolveExtensionProviders({ model: "acme/m1", cwd, agentDir });
    expect(found?.configs.map(({ name, config }) => [name, config.apiKey])).toEqual([["acme", "$FIXTURE_PROVIDER_KEY"]]);
    expect(found?.natives).toEqual([]);
    expect(loads("pi-acme-provider")).toEqual(["loaded"]);
    expect(loads("pi-unrelated")).toEqual([]);
  });

  it("falls back to the other installed extensions when no path names the provider", async () => {
    const { cwd, agentDir, loads } = fixture({ extensions: [
      { dir: "pi-unrelated" },
      { dir: "pi-misc-tools", provider: "zeta" },
    ] });
    const found = await resolveExtensionProviders({ model: "zeta/m1", cwd, agentDir });
    expect(found?.configs.map(({ name }) => name)).toEqual(["zeta"]);
    expect(loads("pi-misc-tools")).toEqual(["loaded"]);
  });

  it("leaves models Pi already knows untouched and loads no extension", async () => {
    const builtin = (await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })).getModels()[0]!;
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: `pi-${builtin.provider}-override`, provider: builtin.provider }, { dir: "pi-local-provider", provider: "local" }],
      models: { providers: { local: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "none", api: "openai-completions",
        models: [{ id: "m1", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } },
    });
    await expect(resolveExtensionProviders({ model: `${builtin.provider}/${builtin.id}`, cwd, agentDir })).resolves.toBeUndefined();
    await expect(resolveExtensionProviders({ model: "local/m1", cwd, agentDir })).resolves.toBeUndefined();
    expect(loads(`pi-${builtin.provider}-override`)).toEqual([]);
    expect(loads("pi-local-provider")).toEqual([]);
  });

  it("fails closed with an actionable error when nothing registers the provider", async () => {
    const { cwd, agentDir } = fixture({ extensions: [{ dir: "pi-acme-provider", provider: "acme" }] });
    await expect(resolveExtensionProviders({ model: "absent/m1", cwd, agentDir }))
      .rejects.toThrow(/needs provider "absent"[\s\S]*extensions: true/);
    const excluded = path.join(path.dirname(agentDir), "packages", "pi-acme-provider", "index.ts");
    await expect(resolveExtensionProviders({ model: "acme/m1", cwd, agentDir, exclude: [excluded] }))
      .rejects.toThrow(/needs provider "acme"/);
  });

  it.each([
    ["a provider registration with its own stream", (marker: string) => `
import fs from "node:fs";
export default function (pi) {
  fs.appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  pi.registerProvider("relay", { api: "relay-api", streamSimple: () => { throw new Error("fixture stream"); } });
}
`],
    ["a global API provider registration", (marker: string) => `
import fs from "node:fs";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
export default function (pi) {
  fs.appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  const stream = () => { throw new Error("fixture stream"); };
  registerApiProvider({ api: "relay-api", stream, streamSimple: stream }, "relay-fixture");
}
`],
  ] as const)("loads the extension that provides a models.json model's stream API through %s", async (_kind, source) => {
    const { getApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: "pi-unrelated" }, { dir: "pi-relay", source }],
      models: { providers: { relay: { baseUrl: "https://relay.invalid/v1", apiKey: "none", api: "relay-api",
        models: [{ id: "m1", name: "Relay", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } },
    });
    try {
      expect(getApiProvider("relay-api")).toBeUndefined();
      const found = await resolveExtensionProviders({ model: "relay/m1", cwd, agentDir });
      expect(loads("pi-relay")).toEqual(["loaded"]);
      const viaConfig = found?.configs.some(({ name, config }) => name === "relay" && config.api === "relay-api" && config.streamSimple);
      expect(viaConfig || getApiProvider("relay-api") !== undefined).toBe(true);
    } finally {
      unregisterApiProviders("relay-fixture");
    }
  });

  it("warns about broken candidates without rejecting a global API registration", async () => {
    const { getApiProvider, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
    const { cwd, agentDir } = fixture({
      extensions: [
        { dir: "pi-relay-broken", source: () => `export default function () { throw new Error("broken fixture"); }` },
        { dir: "pi-relay-global", source: () => `
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
export default function () {
  const stream = () => { throw new Error("fixture stream"); };
  registerApiProvider({ api: "relay-api", stream, streamSimple: stream }, "relay-warning-fixture");
}` },
      ],
      models: { providers: { relay: { baseUrl: "https://relay.invalid/v1", apiKey: "none", api: "relay-api",
        models: [{ id: "m1", name: "Relay", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(resolveExtensionProviders({ model: "relay/m1", cwd, agentDir })).resolves.toEqual({ configs: [], natives: [] });
      expect(getApiProvider("relay-api")).toBeDefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/pi-relay-broken[\s\S]*inference fails[\s\S]*extensions: true/);
    } finally {
      warn.mockRestore();
      unregisterApiProviders("relay-warning-fixture");
    }
  });

  it.each([
    ["ask", false],
    ["always", true],
  ] as const)("applies project trust %s to project-local provider extensions", async (defaultProjectTrust, trusted) => {
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: "pi-proj-provider", provider: "proj", project: true }],
      settings: { defaultProjectTrust },
    });
    const pending = resolveExtensionProviders({ model: "proj/m1", cwd, agentDir });
    if (trusted) await expect(pending).resolves.toMatchObject({ configs: [{ name: "proj" }] });
    else await expect(pending).rejects.toThrow(/needs provider "proj"/);
    expect(loads("pi-proj-provider")).toEqual(trusted ? ["loaded"] : []);
  });

  it("registers the provider through the bridge's own Pi API only when asked", async () => {
    const { cwd, agentDir } = fixture({ extensions: [{ dir: "pi-acme-provider", provider: "acme" }] });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const registerProvider = vi.fn();
    const pi = { registerProvider } as unknown as Parameters<typeof fabricProviderBridge>[0];
    vi.stubEnv(PROVIDER_BRIDGE_MODEL_ENV, "");
    await fabricProviderBridge(pi);
    expect(registerProvider).not.toHaveBeenCalled();
    vi.stubEnv(PROVIDER_BRIDGE_MODEL_ENV, "acme/m1");
    await fabricProviderBridge(pi);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]![0]).toBe("acme");
    expect(registerProvider.mock.calls[0]![1]).toMatchObject({ api: "openai-completions", apiKey: "$FIXTURE_PROVIDER_KEY" });
  });
});

const repo = path.resolve(import.meta.dirname, "..");

describe("resolveExtensionProviders without bundled providers", () => {
  it("fails closed for Coral Bricks when only Fabric is installed", async () => {
    const { cwd, agentDir } = fixture({ extensions: [], settings: { packages: [repo] } });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    await expect(resolveExtensionProviders({ model: "coralbricks/glm-5.3-fast", cwd, agentDir }))
      .rejects.toThrow(/needs provider "coralbricks"[\s\S]*extensions: true/);
  }, 30_000);

  it("still resolves a separately installed Coral Bricks provider extension", async () => {
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: "pi-coralbricks-provider", provider: "coralbricks" }],
      settings: { packages: [repo] },
    });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const found = await resolveExtensionProviders({ model: "coralbricks/m1", cwd, agentDir });
    expect(found?.configs.map(({ name }) => name)).toEqual(["coralbricks"]);
    expect(loads("pi-coralbricks-provider")).toEqual(["loaded"]);
  }, 30_000);
});
