import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadHostSdk } from "../core/host-sdk.js";

/**
 * The `provider/id` key a Pi child launched with `extensions: false` must
 * resolve. The worker sets it only when it also loads this bridge with `-e`.
 */
export const PROVIDER_BRIDGE_MODEL_ENV = "PI_FABRIC_EXTENSION_MODEL";

export interface ExtensionProviderRegistrations {
  configs: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
  natives: Array<{ provider: Provider; extensionPath: string }>;
}

export interface ResolveExtensionProvidersOptions {
  model: string;
  cwd: string;
  agentDir: string;
  /** Extension entry files never probed (Fabric's own entries by default). */
  exclude?: readonly string[];
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/** Split a canonical `provider/id` key at its first slash. */
export function parseModelKey(key: string): { provider: string; id: string } | undefined {
  const value = key.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/**
 * Probe extensions whose own path names the provider first (the usual
 * `pi-<provider>-provider` package), so the common case runs one registration
 * function instead of every installed extension.
 */
export function orderProviderCandidates(
  paths: readonly string[],
  provider: string,
): { named: string[]; rest: string[] } {
  const needle = provider.toLowerCase();
  const named: string[] = [];
  const rest: string[] = [];
  for (const candidate of paths) {
    const tail = candidate.split(/[\\/]+/).filter(Boolean).slice(-3);
    (tail.some((segment) => segment.toLowerCase().includes(needle)) ? named : rest).push(candidate);
  }
  return { named, rest };
}

const realPath = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** A manifest entry that loads a Pi package Fabric bundles (`node_modules/<package>/...`). */
const isBundledPackageEntry = (entry: string): boolean =>
  entry.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").startsWith("node_modules/");

/**
 * Fabric's own manifest entries: they never register chat providers. Entries
 * of bundled Pi packages are not Fabric's own: they stay probe candidates,
 * so a bundled provider can resolve without loading
 * Fabric's main extension.
 */
export function fabricExtensionEntries(moduleUrl = import.meta.url): string[] {
  const root = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: unknown;
      main?: unknown;
      pi?: { extensions?: unknown };
    };
    if (manifest.name !== "pi-fabric") return [];
    const entries = [manifest.main, ...(Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions : [])];
    return entries
      .filter((entry): entry is string => typeof entry === "string" && !isBundledPackageEntry(entry))
      .map((entry) => path.resolve(root, entry));
  } catch {
    return [];
  }
}

const emptyRegistrations = (): ExtensionProviderRegistrations => ({ configs: [], natives: [] });

/**
 * Load extension paths with Pi's own loader into an isolated runtime and keep
 * only the requested provider's registrations. The loaded extensions are
 * discarded: their tools, commands, flags, shortcuts, renderers, and event
 * handlers never bind to the child session, and their event bus is private.
 */
async function loadProviderRegistrations(
  sdk: PiSdk,
  paths: readonly string[],
  provider: string,
  options: { cwd: string; agentDir: string; settingsManager: SettingsManager },
  failures: string[],
): Promise<ExtensionProviderRegistrations> {
  if (paths.length === 0) return emptyRegistrations();
  const loader = new sdk.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [...paths],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { runtime, errors } = loader.getExtensions();
  failures.push(...errors.map((error) => error.path));
  return {
    configs: runtime.pendingProviderRegistrations
      .filter((registration) => registration.name === provider)
      .map(({ name, config, extensionPath }) => ({ name, config, extensionPath })),
    natives: runtime.pendingNativeProviderRegistrations
      .filter((registration) => registration.provider.id === provider)
      .map(({ provider: registered, extensionPath }) => ({ provider: registered, extensionPath })),
  };
}

/**
 * Find the extension registrations that make `model` resolvable in a child
 * without its other extensions. Returns `undefined` when Pi can already serve
 * the model on its own (a known model whose API a built-in provider streams),
 * so those children keep their exact extension-free behaviour. Throws an
 * actionable error when the model is unknown and no installed extension
 * registers its provider.
 */
export async function resolveExtensionProviders(
  options: ResolveExtensionProvidersOptions,
  sdk?: PiSdk,
): Promise<ExtensionProviderRegistrations | undefined> {
  const key = parseModelKey(options.model);
  if (!key) return undefined;
  const pi = sdk ?? await loadHostSdk();
  const models = await pi.ModelRuntime.create({
    authPath: path.join(options.agentDir, "auth.json"),
    modelsPath: path.join(options.agentDir, "models.json"),
    refreshOnCreate: false,
  });
  let known = models.getModel(key.provider, key.id);
  if (!known) {
    await models.refresh({ allowNetwork: false, signal: AbortSignal.timeout(15_000) });
    known = models.getModel(key.provider, key.id);
  }
  // A known model (models.json, a cached catalog) still needs an extension when
  // its API is one no built-in provider streams: an extension supplies that
  // stream, through registerProvider's streamSimple or pi-ai's registerApiProvider.
  if (known && await builtInStreamsApi(pi, options.agentDir, known.api)) return undefined;

  // Same trust a headless child applies without consulting extension
  // project_trust handlers: those belong to the extensions left out here.
  const untrusted = pi.SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
  const trusted = !pi.hasTrustRequiringProjectResources(options.cwd) ||
    (new pi.ProjectTrustStore(options.agentDir).get(options.cwd) ?? untrusted.getDefaultProjectTrust() === "always");
  const settingsManager = trusted
    ? pi.SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true })
    : untrusted;
  const resolved = await new pi.DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  }).resolve();
  const excluded = new Set((options.exclude ?? fabricExtensionEntries()).map(realPath));
  const candidates = resolved.extensions
    .filter((resource) => resource.enabled && !resource.path.startsWith("builtin:"))
    .map((resource) => resource.path)
    .filter((candidate) => !excluded.has(realPath(candidate)));
  const context = { cwd: options.cwd, agentDir: options.agentDir, settingsManager };
  const failures: string[] = [];
  if (known) {
    // Loading runs each candidate's factory in the isolated runtime; a factory
    // that calls registerApiProvider fills the API registry this child streams
    // through. Fabric cannot observe that registry from its own module realm,
    // so stop early only on a provider registration that brings the stream.
    const { named, rest } = orderProviderCandidates(candidates, key.provider);
    const byApi = orderProviderCandidates(rest, known.api);
    const found = emptyRegistrations();
    for (const group of [named, byApi.named, byApi.rest]) {
      const loaded = await loadProviderRegistrations(pi, group, key.provider, context, failures);
      found.configs.push(...loaded.configs);
      found.natives.push(...loaded.natives);
      if (found.natives.length > 0 || found.configs.some(({ config }) => config.streamSimple && config.api === known.api)) break;
    }
    if (failures.length > 0) {
      // The global API registry may still have been populated, so this is only
      // diagnostic. stderr is retained in the worker log without corrupting RPC.
      const paths = [...new Set(failures)];
      const shown = paths.slice(0, 5).map((file) => JSON.stringify(file.slice(0, 200)));
      console.warn(`Provider bridge: extensions failed to load while searching for ${JSON.stringify(options.model.slice(0, 200))}: ${shown.join(", ")}${paths.length > 5 ? ` (and ${paths.length - 5} more)` : ""}. Check these extensions if inference fails, or use extensions: true.`);
    }
    return found;
  }
  const { named, rest } = orderProviderCandidates(candidates, key.provider);
  for (const group of [named, rest]) {
    const found = await loadProviderRegistrations(pi, group, key.provider, context, failures);
    if (found.configs.length > 0 || found.natives.length > 0) return found;
  }
  throw new Error(
    `Model "${options.model}" needs provider "${key.provider}", which is not built into Pi or defined in models.json, ` +
      "and no installed Pi extension registers it for this extensions: false child. " +
      "Install the extension that provides it, or run the child with extensions: true." +
      (failures.length > 0 ? ` Extensions that failed to load while searching: ${[...new Set(failures)].join(", ")}.` : ""),
  );
}

/** Whether a provider built into Pi streams `api`, so no extension has to. */
async function builtInStreamsApi(pi: PiSdk, agentDir: string, api: string): Promise<boolean> {
  const builtIns = await pi.ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  return builtIns.getAllModels().some((model) => model.api === api);
}

/**
 * Loaded with `-e` into Pi children launched with `extensions: false`. It
 * registers only the requested model's provider, as its extension registered
 * it, so credentials still resolve in the child through auth.json, the
 * environment, or the credential store. Nothing else from that extension loads.
 */
export default async function fabricProviderBridge(pi: ExtensionAPI): Promise<void> {
  const model = process.env[PROVIDER_BRIDGE_MODEL_ENV]?.trim();
  if (!model) return;
  const sdk = await loadHostSdk();
  const found = await resolveExtensionProviders({ model, cwd: process.cwd(), agentDir: sdk.getAgentDir() }, sdk);
  if (!found) return;
  for (const { name, config } of found.configs) pi.registerProvider(name, config);
  for (const { provider } of found.natives) pi.registerProvider(provider);
}
