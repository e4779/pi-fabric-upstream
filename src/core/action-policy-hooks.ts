import type { ResolvedFabricAction } from "./action-registry.js";

// Extension policy hooks at the fabric_exec approve stage (issue #312).
//
// A hook can only narrow what the configured approvals allow, plus settle a
// prompt the configuration would otherwise show:
// - "deny" is absolute, like an `approvals.actions` deny;
// - "hold" asks a person (or raises the headless decision) even when the
//   configuration would allow the action, and never lifts a configured deny;
// - "allow" settles an `ask` or `auto` prompt, never a configured deny;
// - no opinion leaves the configured policy alone.
// A hook that throws, times out, or answers malformed fails closed as a deny.

/** "program": a fabric_exec program. "jev": a Jev program launched from one. */
export type FabricActionPolicyCallerV1 = "program" | "jev";

export interface FabricActionPolicyContextV1 {
  caller: FabricActionPolicyCallerV1;
  /** The outer fabric_exec tool-call id, when the program has one. For a Jev
   *  program, the tool call that launched it. */
  parentToolCallId?: string;
}

export interface FabricActionPolicyInputV1 {
  version: 1;
  /** A private copy: changing it does not change the action. */
  action: ResolvedFabricAction;
  /** A private copy of the validated arguments. */
  args: Record<string, unknown>;
  context: FabricActionPolicyContextV1;
  /** Aborts when the call is cancelled or the hook's deadline passes. */
  signal: AbortSignal;
}

export type FabricActionPolicyDecisionV1 =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "hold"; reason: string }
  | undefined;

export type FabricActionPolicyHookV1 = (
  input: FabricActionPolicyInputV1,
) => FabricActionPolicyDecisionV1 | Promise<FabricActionPolicyDecisionV1>;

/** The combined answer of every registered hook for one approval. */
export interface FabricActionPolicyVerdict {
  decision: "allow" | "deny" | "hold";
  /** Name of the hook that decided; the first in registration order. */
  hook: string;
  reason?: string;
}

export const DEFAULT_ACTION_POLICY_HOOK_TIMEOUT_MS = 5_000;
const MAX_REASON_CHARS = 500;

// Same alphabet as a decisions `source`, so a name is safe in an error message.
export const ACTION_POLICY_HOOK_NAME_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}$/;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Control characters go first, so a hook cannot inject ANSI escapes or line
// breaks into the approval prompt or the error.
const boundedReason = (raw: string): string => {
  const reason = raw.replace(/\p{Cc}/gu, " ");
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason;
};

/** Read a hook's answer by named fields; anything else is malformed. */
const readDecision = (value: unknown): { decision: "allow" | "deny" | "hold"; reason?: string } | undefined | "malformed" => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "malformed";
  const record = value as Record<string, unknown>;
  const decision = record.decision;
  if (decision === "allow") return { decision };
  if (decision !== "deny" && decision !== "hold") return "malformed";
  const reason = record.reason;
  if (typeof reason !== "string" || reason.trim() === "") return "malformed";
  return { decision, reason: boundedReason(reason) };
};

const precedence = { deny: 3, hold: 2, allow: 1 } as const;

export class FabricActionPolicyHooks {
  readonly #hooks = new Map<string, { hook: FabricActionPolicyHookV1 }>();

  constructor(readonly timeoutMs = DEFAULT_ACTION_POLICY_HOOK_TIMEOUT_MS) {}

  get size(): number {
    return this.#hooks.size;
  }

  /**
   * Register `hook` under `name`; the same name replaces an earlier hook in
   * its original position, so a reloaded extension does not stack copies or
   * change which hook names a tie. The returned function removes only this
   * registration.
   */
  register(name: string, hook: FabricActionPolicyHookV1): () => void {
    if (!ACTION_POLICY_HOOK_NAME_PATTERN.test(name)) {
      throw new Error("Action policy hook name must match [A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}");
    }
    if (typeof hook !== "function") throw new Error("Action policy hook must be a function");
    const registration = { hook };
    this.#hooks.set(name, registration);
    return () => {
      if (this.#hooks.get(name) === registration) this.#hooks.delete(name);
    };
  }

  clear(): void {
    this.#hooks.clear();
  }

  /**
   * Bind the hooks to one call site as an approval policy gate. `signal` is
   * read at each evaluation, so a caller can hand over to a later signal.
   * An explicit per-call signal takes precedence; concurrent calls never
   * share mutable cancellation state.
   */
  bind(
    context: FabricActionPolicyContextV1,
    signal?: () => AbortSignal | undefined,
  ): {
    readonly active: boolean;
    evaluate(action: ResolvedFabricAction, args: Record<string, unknown>, callSignal?: AbortSignal): Promise<FabricActionPolicyVerdict | undefined>;
  } {
    const hooks = this;
    return {
      get active() { return hooks.size > 0; },
      evaluate: (action, args, callSignal) => hooks.evaluate(action, args, context, callSignal ?? signal?.()),
    };
  }

  /**
   * Ask every hook. Deny beats hold beats allow; among equals the earliest
   * registration names the verdict. Undefined means no hook had an opinion.
   * Rejects only when `signal` aborts: the caller was cancelled.
   */
  async evaluate(
    action: ResolvedFabricAction,
    args: Record<string, unknown>,
    context: FabricActionPolicyContextV1,
    signal?: AbortSignal,
  ): Promise<FabricActionPolicyVerdict | undefined> {
    signal?.throwIfAborted();
    const hooks = [...this.#hooks];
    if (hooks.length === 0) return undefined;
    const answers = await Promise.all(hooks.map(([name, { hook }]) => this.#ask(name, hook, action, args, context, signal)));
    signal?.throwIfAborted();
    let verdict: FabricActionPolicyVerdict | undefined;
    for (const answer of answers) {
      if (answer && (!verdict || precedence[answer.decision] > precedence[verdict.decision])) verdict = answer;
    }
    return verdict;
  }

  async #ask(
    name: string,
    hook: FabricActionPolicyHookV1,
    action: ResolvedFabricAction,
    args: Record<string, unknown>,
    context: FabricActionPolicyContextV1,
    signal?: AbortSignal,
  ): Promise<FabricActionPolicyVerdict | undefined> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`timed out after ${this.timeoutMs} ms`);
          controller.abort(error);
          reject(error);
        }, this.timeoutMs);
      });
      const cancelled = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      // Each hook gets its own copies, so one hook cannot change what the
      // next hook or the action sees.
      const input: FabricActionPolicyInputV1 = {
        version: 1,
        action: structuredClone(action),
        args: structuredClone(args),
        context: { ...context },
        signal: controller.signal,
      };
      const answer = readDecision(await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return hook(input);
        }),
        deadline,
        cancelled,
      ]));
      if (answer === "malformed") {
        return { decision: "deny", hook: name, reason: "the hook returned a malformed decision" };
      }
      return answer ? { ...answer, hook: name } : undefined;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { decision: "deny", hook: name, reason: `the hook failed: ${boundedReason(message(error))}` };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
