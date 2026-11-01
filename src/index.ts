import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FabricManagedHostOptions } from "./managed-host.js";
import { createFabricExtension } from "./extension.js";
export { FABRIC_MANAGED_HOST_VERSION } from "./extension.js";
export type { FabricManagedHostOptions } from "./managed-host.js";
// Do not infer this public type through the library barrels: when the host and
// worker SDK resolve to one installation, declaration emit can choose the
// private worker alias instead of the embedding application's peer SDK.
const fabric: (pi: ExtensionAPI, options?: { managedHost?: FabricManagedHostOptions }) => Promise<void> =
  createFabricExtension(import.meta.url);
export default fabric;

export * from "./audit/index.js";
export * from "./entropy/index.js";
export * from "./protocol.js";
