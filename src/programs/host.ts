import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricState } from "../fabric-state.js";
import type { FabricProgramRunReplyV1, FabricProgramRunSnapshotV1 } from "../protocol.js";
import { callerCodeLabel, callerCodeProgram, hostProgramRunSource, sha256Hex } from "./source.js";
import {
  MAX_PROGRAM_CODE_CHARS,
  MAX_PROGRAM_REF_CHARS,
  normalizeProgramInput,
  ProgramStore,
  programRef,
  programsDirectory,
  type FabricProgramSummary,
} from "./store.js";

// Host-invoked program runs: `/fabric run`, `/fabric programs ...`, and the
// `pi-fabric:program:run:v1` event. A host run is a one-call program that
// invokes `programs.run`, so it takes the session's root capability view and
// the same approval policy as a model call; only the caller differs, and the
// trace records it as `invokedBy: "host"`.

export const PROGRAM_RUN_MESSAGE_TYPE = "pi-fabric-program-run";
const MAX_MESSAGE_VALUE_CHARS = 8_000;

export interface ProgramHostDeps {
  state: Pick<FabricState, "ensure" | "config" | "execution" | "registry">;
  pi: Pick<ExtensionAPI, "sendMessage">;
}

interface HostProgramRunBase {
  input?: unknown;
  signal?: AbortSignal;
}

/** A saved program, chosen by name or digest. */
export interface HostSavedProgramRunRequest extends HostProgramRunBase {
  ref: string;
  requirePromoted?: boolean;
}

/** Caller-supplied TypeScript. Fabric computes its SHA-256 for the run's identity. */
export interface HostCodeProgramRunRequest extends HostProgramRunBase {
  code: string;
}

export type HostProgramRunRequest = HostSavedProgramRunRequest | HostCodeProgramRunRequest;

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Local on purpose: importing the shared util would split it into its own
// startup chunk.
const bounded = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n… ${value.length - maxChars} characters omitted`;

const valueText = (value: unknown): string => {
  if (value === undefined) return "(no result)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const runHostProgram = async (
  deps: ProgramHostDeps,
  context: ExtensionContext,
  request: HostProgramRunRequest,
): Promise<FabricProgramRunReplyV1> => {
  let program: string | undefined;
  let reply: FabricProgramRunReplyV1;
  let details: Record<string, unknown> = {};
  const caller = "code" in request;
  // Hashed here, from the text that runs, so the run's identity cannot name other text.
  const sha256 = caller ? sha256Hex(request.code) : "";
  try {
    await deps.state.ensure(context);
    if (!deps.state.registry.has("programs")) {
      throw new Error(caller ? "Program runs are unavailable in this session" : "Saved programs are unavailable in this session");
    }
    const kernel = deps.state.config.executor.kernel;
    // Either way the run is a one-call program that invokes `programs.run`, so
    // saved and caller-supplied programs share its authorization, approval and trace.
    let ref: string;
    let displayName: string;
    let requirePromoted = false;
    if (caller) {
      // Nothing is saved: `programs.run` resolves this ref to the verified code.
      if (kernel !== "typescript") {
        throw new Error(`This session's kernel is ${kernel}; caller-supplied code runs only in the typescript kernel`);
      }
      program = callerCodeProgram(sha256);
      ref = program;
      displayName = `Program ${callerCodeLabel(sha256)}`;
    } else {
      const store = new ProgramStore(programsDirectory(context.cwd));
      const record = await store.resolve(request.ref, { requirePromoted: request.requirePromoted === true });
      program = programRef(record, true);
      // Pin the resolved digest so a concurrent promotion cannot swap versions.
      ref = record.digest;
      displayName = `Program ${record.name}`;
      requirePromoted = request.requirePromoted === true;
    }
    const input = normalizeProgramInput(request.input);
    const result = await deps.state.execution.execute({
      code: hostProgramRunSource(kernel, {
        ref,
        ...(input !== undefined ? { input } : {}),
        ...(requirePromoted ? { requirePromoted: true } : {}),
      }),
      ...(caller ? { callerProgram: { code: request.code, sha256 } } : {}),
      signal: request.signal,
      parentToolCallId: `fabric_program_${randomUUID()}`,
      context,
      display: { name: displayName },
      invokedBy: "host",
      onPartial() {},
    });
    details = { trace: result.trace };
    reply = result.success
      ? { ok: true, program, value: result.value, logs: result.logs }
      : {
          ok: false,
          program,
          error: result.error
            ?? (result.typeErrors?.length ? `Type errors: ${result.typeErrors.map((error) => error.message).join("; ")}` : "Program run failed"),
        };
  } catch (error) {
    reply = { ok: false, error: errorText(error), ...(program ? { program } : {}) };
  }
  const label = caller ? callerCodeLabel(sha256) : reply.program ?? request.ref;
  const body = reply.ok
    ? [...reply.logs, valueText(reply.value)].join("\n")
    : `Error: ${reply.error}`;
  try {
    deps.pi.sendMessage({
      customType: PROGRAM_RUN_MESSAGE_TYPE,
      content: `Program ${label} (host run, ${reply.ok ? "succeeded" : "failed"})\n${bounded(body, MAX_MESSAGE_VALUE_CHARS)}`,
      display: true,
      details: {
        version: 1,
        invokedBy: "host",
        ...(reply.program ? { program: reply.program } : caller ? {} : { ref: request.ref }),
        ...(caller ? { source: "caller-code", sha256 } : {}),
        success: reply.ok,
        ...(reply.ok ? {} : { error: reply.error }),
        ...details,
      },
    }, { triggerTurn: false });
  } catch {
    // The transcript entry is best effort; the reply still reports the run.
  }
  return reply;
};

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === "object" && value !== null && typeof (value as AbortSignal).aborted === "boolean" &&
  typeof (value as AbortSignal).addEventListener === "function";

/**
 * `pi-fabric:program:run:v1`; replies exactly once, never throws. It reads only
 * the snapshot the listener took at the event boundary, never the caller's object.
 */
export const handleFabricProgramRunEvent = async (
  request: FabricProgramRunSnapshotV1,
  deps: ProgramHostDeps & { context: ExtensionContext | undefined },
): Promise<void> => {
  const { ref, code, input, requirePromoted, signal, unreadable, respond } = request;
  const refuse = (reason: string): void => respond({ ok: false, error: `Invalid program run request: ${reason}` });
  try {
    // The first unreadable field, in read order, is refused by name before any other check.
    if (unreadable) return refuse(`${unreadable} could not be read`);
    let run: HostProgramRunRequest;
    if (code === undefined) {
      if (typeof ref !== "string" || !ref || ref.length > MAX_PROGRAM_REF_CHARS) {
        return refuse("ref must be a non-empty string");
      }
      if (requirePromoted !== undefined && typeof requirePromoted !== "boolean") {
        return refuse("requirePromoted must be a boolean");
      }
      if (signal !== undefined && !isAbortSignal(signal)) return refuse("signal must be an AbortSignal");
      run = {
        ref,
        ...(input !== undefined ? { input } : {}),
        ...(requirePromoted ? { requirePromoted: true } : {}),
        ...(signal ? { signal } : {}),
      };
    } else {
      if (typeof code !== "string" || !code.trim()) return refuse("code must be a non-empty string");
      if (code.length > MAX_PROGRAM_CODE_CHARS) return refuse(`code exceeds ${MAX_PROGRAM_CODE_CHARS} characters`);
      if (signal !== undefined && !isAbortSignal(signal)) return refuse("signal must be an AbortSignal");
      run = { code, ...(input !== undefined ? { input } : {}), ...(signal ? { signal } : {}) };
    }
    if (!deps.context) {
      respond({ ok: false, error: "No active Pi session to run the program in" });
      return;
    }
    respond(await runHostProgram(deps, deps.context, run));
  } catch (error) {
    respond({ ok: false, error: errorText(error) });
  }
};

const summaryLine = (program: FabricProgramSummary): string =>
  `${program.ref} [${program.status}] ${program.kind}${program.kernel ? `/${program.kernel}` : ""} · ${new Date(program.createdAt).toISOString()}${program.description ? ` — ${program.description}` : ""}`;

/** `/fabric programs [list|promote <ref>|retire <ref>]` and `/fabric run <ref> [json input]`. */
export const runFabricProgramsCommand = async (
  deps: ProgramHostDeps,
  context: ExtensionContext,
  command: "programs" | "run",
  argumentsText: string,
): Promise<void> => {
  const store = new ProgramStore(programsDirectory(context.cwd));
  try {
    if (command === "run") {
      const text = argumentsText.trim();
      const space = text.search(/\s/);
      const ref = space < 0 ? text : text.slice(0, space);
      const inputText = space < 0 ? "" : text.slice(space).trim();
      if (!ref) {
        context.ui.notify("Usage: /fabric run <ref> [json input]", "warning");
        return;
      }
      let input: unknown;
      if (inputText) {
        try {
          input = JSON.parse(inputText) as unknown;
        } catch {
          context.ui.notify(`Program input is not valid JSON: ${bounded(inputText, 200)}`, "error");
          return;
        }
      }
      const reply = await runHostProgram(deps, context, { ref, ...(input !== undefined ? { input } : {}) });
      context.ui.notify(
        reply.ok ? `Program ${reply.program} finished` : `Program ${reply.program ?? ref} failed: ${reply.error}`,
        reply.ok ? "info" : "error",
      );
      return;
    }
    const [action = "list", ref] = argumentsText.trim().split(/\s+/).filter(Boolean);
    if (action === "list") {
      const programs = await store.list();
      context.ui.notify(programs.length ? programs.map(summaryLine).join("\n") : "No saved Fabric programs", "info");
      return;
    }
    if ((action === "promote" || action === "retire") && ref) {
      const record = action === "promote" ? await store.promote(ref) : await store.retire(ref);
      context.ui.notify(`Program ${programRef(record)} is ${record.status}`, "info");
      return;
    }
    context.ui.notify("Usage: /fabric programs [list|promote <ref>|retire <ref>]", "warning");
  } catch (error) {
    context.ui.notify(`Fabric programs: ${errorText(error)}`, "error");
  }
};
