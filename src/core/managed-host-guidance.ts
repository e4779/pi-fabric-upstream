import type { FabricManagedHostOptions } from "../managed-host.js";

/** Names come from sealed host authority, not the ambient provider catalog. */
export const managedHostExecutionGuidance = (options: Readonly<FabricManagedHostOptions>): string => [
  `Managed provider namespaces: ${options.providers.length ? options.providers.join(", ") : "none"}. Only registered host actions are available; do not assume other providers or coding tools exist.`,
  "Use fabric.tools.search/describe for exact contracts and raw inputSchema, then fabric.tools.call({ref,args}) or the discovered provider namespace. nativeDiscovery.searchTools/describeTool and nativeTools also expose the authorized native catalog. Use exact discovered callable names.",
  "store/load persist branch-local JSON across successful scripts; they are not business memory tools. Host authorization, approval and cancellation remain authoritative.",
].join(" ");

export const managedHostKernelGuidance = (options: Readonly<FabricManagedHostOptions>): string => [
  "Configured fabric_exec kernel: type-checked TypeScript in isolated QuickJS. Top-level await and return are supported. Each invocation starts fresh; use store/load for branch-local JSON state.",
  options.skillReader ? `Read supplied files and skills through the host reader \`${options.skillReader}\` inside \`fabric_exec\`; never assume their contents.` : "The embedding host owns file and skill loading; do not assume a filesystem reader is available.",
].join(" ");
