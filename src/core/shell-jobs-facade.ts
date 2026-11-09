import type {
  FabricBgServiceFacadeV1,
  FabricShellJobCompletionResultV1,
  FabricShellJobRegistrationOptionsV1,
  FabricShellJobRegistrationResultV1,
} from "../protocol.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_SHELL_JOB_NOTIFY_EVENT,
  FABRIC_SHELL_JOB_REGISTER_EVENT,
  FABRIC_SHELL_JOB_SUBSCRIBE_EVENT,
  readFabricShellJobCompletionV1,
  readFabricShellJobRegistrationV1,
  readFabricShellJobSubscriptionV1,
} from "../protocol.js";
import type { FabricShellJobEvent, FabricShellJobStore } from "./shell-jobs.js";

/**
 * Extension-facing publication of the host background-job store (charter PR2).
 * Every method is a thin wrapper over the one `FabricShellJobStore` this
 * session already runs — no second store, no second delivery channel. A
 * `notifyCompletion` lands as the job's terminal store event, so it reaches
 * the session through the same sanctioned path as any other wake:
 * ShellEventInbox renders the typed wake event behind the untrusted preamble
 * and steers it into the conversation.
 *
 * The store resolves lazily per call: it exists once the fabric runtime state
 * is initialized and is replaced on session switches, so a facade held across
 * sessions always operates on the live store.
 */
export const createFabricBgServiceFacade = (
  resolveStore: () => FabricShellJobStore | undefined,
): FabricBgServiceFacadeV1 => {
  const unavailable = (): Error =>
    new Error("Background job service is unavailable before the fabric session is initialized");

  const register = (
    tool: Parameters<FabricBgServiceFacadeV1["registerJob"]>[0],
    command: string,
    options?: FabricShellJobRegistrationOptionsV1,
  ): FabricShellJobRegistrationResultV1 => {
    try {
      const store = resolveStore();
      if (!store) throw unavailable();
      // Registration through this facade is by definition background work owned
      // elsewhere: no local process to spill or kill, listed in the dock and
      // delivered through the one wake channel (see FabricShellJobOptions).
      // The `external` mark is the store's own marker for exactly that: the
      // session inbox delivers the job's completion through the one wake
      // channel without a registration-time spill.
      const job = store.begin(tool, command, { ...(options ?? {}), external: true });
      return { ok: true, jobId: job.id, info: job.info() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    registerJob: register,
    // Backward-compatible alias within this PR: the store's own method is
    // named `begin`; the charter API name is `registerJob`.
    begin: register,

    unregister: (jobId) => {
      try {
        return resolveStore()?.unregister(jobId) ?? false;
      } catch {
        return false;
      }
    },

    subscribe: (jobId, listener) => {
      const store = resolveStore();
      if (!store) throw unavailable();
      // The store already isolates listener failures; the filter only narrows delivery.
      return store.subscribe((event: FabricShellJobEvent) => {
        if (event.job.id === jobId) listener(event);
      });
    },

    notifyCompletion: async (jobId, payload, options): Promise<FabricShellJobCompletionResultV1> => {
      try {
        const store = resolveStore();
        if (!store) throw unavailable();
        const job = store.get(jobId);
        if (!job) return { ok: false, error: `Unknown background job: ${jobId}` };
        if (job.finished) return { ok: false, error: `Background job already finished: ${jobId}` };
        // The payload is the job's terminal tail: retained by the bounded log
        // and carried by the finished event's typed wake tail. Provenance is
        // written once into the log, not into model-facing text.
        if (payload.length > 0) job.append(Buffer.from(payload, "utf8"));
        // The owner names why the run ended; knowing only the exit code, 0
        // completes and anything else is a runtime failure — the typed wake
        // never carries an untyped stop. `null` records a run that ended
        // without an exit code (a kill leaves none).
        const exitCode = options?.exitCode === undefined ? 0 : options.exitCode;
        const stopReason = options?.stopReason ?? (exitCode === 0 ? "completed" : "runtime_error");
        // finish() answers whether THIS call performed the terminal transition.
        // A concurrent finisher (session close, process exit) landing between
        // the finished check and this call must not be reported as ok:true with
        // the payload dropped.
        const finished = await job.finish(exitCode, "[Completed by owner via notifyCompletion]", stopReason);
        if (!finished) return { ok: false, error: `Background job already finished: ${jobId}` };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
};

/**
 * Registers the facade on the extension API surface (`pi.events`), the way the
 * other host services publish their channels. Returns one unsubscribe that
 * removes all three handlers; call it from `session_shutdown`.
 */
export const registerFabricBgJobService = (
  pi: ExtensionAPI,
  resolveStore: () => FabricShellJobStore | undefined,
): () => void => {
  const service = createFabricBgServiceFacade(resolveStore);

  const offRegister = pi.events.on(FABRIC_SHELL_JOB_REGISTER_EVENT, (value: unknown) => {
    const registration = readFabricShellJobRegistrationV1(value);
    if (!registration) throw new Error("Invalid Pi Fabric background job registration");
    registration.respond?.(
      service.registerJob(registration.tool, registration.command, registration.options),
    );
  });

  const offSubscribe = pi.events.on(FABRIC_SHELL_JOB_SUBSCRIBE_EVENT, (value: unknown) => {
    const subscription = readFabricShellJobSubscriptionV1(value);
    if (!subscription) throw new Error("Invalid Pi Fabric background job subscription");
    try {
      const unsubscribe = service.subscribe(subscription.jobId, subscription.listener);
      subscription.respond?.({ ok: true, unsubscribe });
    } catch (error) {
      subscription.respond?.({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const offNotify = pi.events.on(FABRIC_SHELL_JOB_NOTIFY_EVENT, (value: unknown) => {
    const completion = readFabricShellJobCompletionV1(value);
    if (!completion) throw new Error("Invalid Pi Fabric background job completion");
    const options = {
      ...(completion.exitCode !== undefined ? { exitCode: completion.exitCode } : {}),
      ...(completion.stopReason !== undefined ? { stopReason: completion.stopReason } : {}),
    };
    void service
      .notifyCompletion(completion.jobId, completion.payload, options)
      .then((result) => completion.respond?.(result));
  });

  return () => {
    offRegister();
    offSubscribe();
    offNotify();
  };
};
