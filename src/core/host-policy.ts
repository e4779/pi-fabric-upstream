import { createHash } from "node:crypto";
import {
  FABRIC_HOST_POLICY_FIELDS,
  type FabricHostPolicyReplyV1,
  type FabricHostPolicyV1,
} from "../protocol.js";

/** Providers whose calls replay Pi tool_call hooks, so the host's own guards see them. */
const HOOKED_PROVIDERS: ReadonlySet<string> = new Set(["pi", "extensions"]);

/**
 * Built-in actions Fabric maintains as free of side effects. Provider-declared
 * risk is never consulted: a provider's own label cannot grant anything. Every
 * other action outside `pi.*` and `extensions.*` needs a host `allowedRefs`
 * entry. Every provider named here is reserved (FABRIC_COMPONENT_PROVIDER_NAMES
 * or `components`), so a third-party provider cannot claim one of these refs;
 * tests/host-policy.test.ts checks that.
 */
export const FABRIC_BUILTIN_READ_REFS: ReadonlySet<string> = new Set([
  "cache.status",
  "compact.pressure",
  "compact.status",
  "components.describe",
  "components.graph",
  "components.list",
  "components.status",
  "memory.expand",
  "memory.recall",
  "memory.sessions",
  "programs.get",
  "programs.list",
  "schema.status",
  "state.get",
  "state.history",
  "thinking.status",
]);

const refMatches = (pattern: string, ref: string): boolean =>
  pattern.endsWith(".*") ? ref.startsWith(pattern.slice(0, -1)) : pattern === ref;

/**
 * The one host restriction for a Fabric instance. The host sets it before the
 * instance runs anything; the first program or provider check seals it, so
 * every action Fabric ever admits was checked against the final policy. It
 * lives as long as the extension instance: a new session on the instance keeps
 * it, and /reload builds a new instance that starts without one. Decisions use
 * only the provider and action name, so they run before any provider code,
 * including metadata hooks.
 */
export class FabricHostPolicy {
  #policy: FabricHostPolicyV1 | undefined;
  #sealed = false;

  /** True once a policy is in force. Does not seal. */
  get active(): boolean {
    return this.#policy !== undefined;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  /** Accept the policy only while nothing has run; otherwise refuse it. */
  apply(policy: FabricHostPolicyV1): FabricHostPolicyReplyV1 {
    if (this.#sealed) {
      return { version: 1, accepted: false, reason: "Fabric host policy is sealed: this instance already ran a program or provider call" };
    }
    if (this.#policy) {
      return { version: 1, accepted: false, reason: `Fabric host policy is already set by ${this.#policy.owner}` };
    }
    const copy = structuredClone(policy);
    this.#policy = copy;
    return { version: 1, accepted: true, digest: hostPolicyDigest(copy), enforced: [...FABRIC_HOST_POLICY_FIELDS] };
  }

  /** Refusal message for `provider.name`, or undefined when the policy allows it. Seals. */
  refDenial(provider: string, name: string): string | undefined {
    this.#sealed = true;
    return this.previewDenial(provider, name);
  }

  /**
   * The same decision as refDenial without sealing, for answers that admit no
   * work, such as which tools a program can reach.
   */
  previewDenial(provider: string, name: string): string | undefined {
    const policy = this.#policy;
    if (!policy) return undefined;
    const ref = `${provider}.${name}`;
    const prefix = `${ref} is refused by the Fabric host policy from ${policy.owner}`;
    if (policy.deniedProviders?.includes(provider)) {
      return `${prefix}: provider ${provider} is unavailable here (${policy.reason})`;
    }
    if (HOOKED_PROVIDERS.has(provider)) {
      return policy.deniedTools?.includes(name)
        ? `${prefix}: tool ${name} is unavailable here (${policy.reason})`
        : undefined;
    }
    if (FABRIC_BUILTIN_READ_REFS.has(ref)) return undefined;
    if (policy.allowedRefs?.some((pattern) => refMatches(pattern, ref))) return undefined;
    return `${prefix}: actions outside pi.* and extensions.* need a host allowedRefs entry (${policy.reason})`;
  }

  /** True when the policy refuses every action of a provider, so Fabric never lists it. Seals. */
  providerHidden(provider: string): boolean {
    this.#sealed = true;
    return this.previewProviderHidden(provider);
  }

  /** Provider visibility without admitting work or sealing the policy. */
  previewProviderHidden(provider: string): boolean {
    const policy = this.#policy;
    if (!policy) return false;
    if (policy.deniedProviders?.includes(provider)) return true;
    if (HOOKED_PROVIDERS.has(provider)) return false;
    const head = `${provider}.`;
    return ![...FABRIC_BUILTIN_READ_REFS].some((ref) => ref.startsWith(head)) &&
      !(policy.allowedRefs ?? []).some((pattern) => pattern.startsWith(head));
  }

  /** Native executors run outside every tool hook, so any policy refuses them. Seals. */
  executorDenial(): string | undefined {
    this.#sealed = true;
    const policy = this.#policy;
    if (!policy) return undefined;
    return `Fabric host policy from ${policy.owner} refuses native executors (CPython, node-process, bun-process): ${policy.reason}`;
  }
}

/** Stable digest of the accepted policy, so a host can match the ack to what it sent. */
export const hostPolicyDigest = (policy: FabricHostPolicyV1): string => {
  const sorted = (values: readonly string[] | undefined) => values ? [...values].sort() : null;
  const canonical = JSON.stringify([
    policy.owner,
    policy.reason,
    sorted(policy.deniedTools),
    sorted(policy.deniedProviders),
    sorted(policy.allowedRefs),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};
