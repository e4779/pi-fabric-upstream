import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  FabricShellPolicyConfigSurfaceV1,
  FabricShellPolicyFacadeV1,
} from "../protocol.js";
import {
  FABRIC_SHELL_POLICY_CONFIG_EVENT,
  FABRIC_SHELL_POLICY_GATE_EVENT,
  FABRIC_SHELL_POLICY_POST_EVENT,
  readFabricShellPolicyConfigRequestV1,
  readFabricShellPolicyGateRequestV1,
  readFabricShellPolicyPostRequestV1,
} from "../protocol.js";
import {
  DEFAULT_SHELL_POLICY_OFFLOAD_BYTES,
  DEFAULT_SHELL_POLICY_ONE_LINE_BYTES,
  defaultShellPolicyDumpDir,
  FabricShellPolicyMiddleware,
  SHELL_POLICY_GATE_KILL_SWITCH,
  type ShellPolicyOptions,
} from "./shell-policy-middleware.js";

/**
 * Extension-facing publication of the host shell policy. Every method delegates to the one `FabricShellPolicyMiddleware`
 * contract fabric_exec itself runs: same bounded retry valve, same per-pid
 * offload directory, same per-call `PI_FABRIC_SHELL_GATE` kill switch. The
 * facade is exposure only; it adds no second policy and changes no
 * fabric_exec behavior. This mirrors the PR2 background-job publication
 * (pi.events channels plus respond callbacks over `registerFabricBgJobService`).
 *
 * The middleware resolves lazily from the session's `executor.shellPolicy`
 * config and is rebuilt only when that surface changes, so the bounded retry
 * valve persists across calls within a session exactly as it does for
 * fabric_exec's own instance. Before the session config exists the facade
 * answers fail-open (gate never blocks, post passes through) and `config()`
 * reports `available: false`.
 */

/** The per-session policy halves; the resolved `executor.shellPolicy` config. */
export type FabricShellPolicyHalves = { gate: boolean; outputBudget: boolean };

export const createFabricShellPolicyFacade = (
  resolveConfig: () => FabricShellPolicyHalves | undefined,
  options: ShellPolicyOptions = {},
): FabricShellPolicyFacadeV1 => {
  let middleware: FabricShellPolicyMiddleware | undefined;
  let configKey: string | undefined;

  const liveMiddleware = (): FabricShellPolicyMiddleware | undefined => {
    const config = resolveConfig();
    if (!config) {
      middleware = undefined;
      configKey = undefined;
      return undefined;
    }
    const key = JSON.stringify(config);
    if (middleware === undefined || key !== configKey) {
      // The session config decides the halves; injected options decide only
      // the offline-testable plumbing (checkers, dump dir, thresholds).
      middleware = new FabricShellPolicyMiddleware({ ...options, ...config });
      configKey = key;
    }
    return middleware;
  };

  return {
    gate: (command) => liveMiddleware()?.gate(command) ?? null,

    post: (command, outcome) =>
      liveMiddleware()?.post(command, outcome) ?? { notes: [], output: outcome.output },

    config: (): FabricShellPolicyConfigSurfaceV1 => {
      const config = resolveConfig();
      return {
        version: 1,
        available: config !== undefined,
        gate: config?.gate ?? false,
        outputBudget: config?.outputBudget ?? false,
        killSwitchEnv: SHELL_POLICY_GATE_KILL_SWITCH,
        offloadBytes: options.offloadBytes ?? DEFAULT_SHELL_POLICY_OFFLOAD_BYTES,
        offloadOneLineBytes: options.offloadOneLineBytes ?? DEFAULT_SHELL_POLICY_ONE_LINE_BYTES,
        dumpDir: options.dumpDir ?? defaultShellPolicyDumpDir(),
      };
    },
  };
};

/**
 * Registers the facade on the extension API surface (`pi.events`), the way the
 * other host services publish their channels. Returns one unsubscribe that
 * removes all three handlers; call it from `session_shutdown`.
 */
export const registerFabricShellPolicyService = (
  pi: ExtensionAPI,
  resolveConfig: () => FabricShellPolicyHalves | undefined,
  options: ShellPolicyOptions = {},
): () => void => {
  const service = createFabricShellPolicyFacade(resolveConfig, options);

  const offGate = pi.events.on(FABRIC_SHELL_POLICY_GATE_EVENT, (value: unknown) => {
    const request = readFabricShellPolicyGateRequestV1(value);
    if (!request) throw new Error("Invalid Pi Fabric shell policy gate request");
    request.respond?.(service.gate(request.command));
  });

  const offPost = pi.events.on(FABRIC_SHELL_POLICY_POST_EVENT, (value: unknown) => {
    const request = readFabricShellPolicyPostRequestV1(value);
    if (!request) throw new Error("Invalid Pi Fabric shell policy post request");
    request.respond?.(service.post(request.command, request.outcome));
  });

  const offConfig = pi.events.on(FABRIC_SHELL_POLICY_CONFIG_EVENT, (value: unknown) => {
    const request = readFabricShellPolicyConfigRequestV1(value);
    if (!request) throw new Error("Invalid Pi Fabric shell policy config request");
    request.respond?.(service.config());
  });

  return () => {
    offGate();
    offPost();
    offConfig();
  };
};
