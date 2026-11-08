import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  FabricExecutionPolicyBlockV1,
  FabricExecutionPolicyMiddlewareV1,
  FabricExecutionPolicyOutcomeV1,
  FabricExecutionPolicyPostResultV1,
  FabricShellLintFindingV1,
} from "../protocol.js";

/**
 * Gate + context guard as reusable execution policy, applicable by ANY
 * execution tool (council synthesis step 2, PR 1; ported from shell-lab
 * `.pi/extensions/shell.ts:85-203` gate and `:205-288` postProcess — gap-table
 * rows 2-3). Fabric's own `pi.bash` arm runs it so nested `fabric_exec` calls
 * and top-level shell calls pass one gate; external-surface tools can apply
 * the same `FabricExecutionPolicyMiddlewareV1` contract and stay uniform.
 *
 * Gate contract:
 *   - fail-open: a broken check NEVER blocks a command
 *   - retry valve: an identical retry passes unchecked (the lesson was seen;
 *     a fixed command is a different string)
 *   - disable: `# shellcheck disable=SCxxxx` on the line BEFORE the offending
 *     command (shellcheck 0.11 semantics; trailing same-line directives trip
 *     SC1126) — the linter honors it, the gate never second-guesses it
 *   - suppressed by default: SC1090/SC1091 (unfollowable source), SC2148
 *     (no shebang — one-shot strings are linted), SC2012/SC2009 (ls|head and
 *     ps|grep are blessed filter-before-return patterns)
 *   - deterministic: `--norc` (no ambient .shellcheckrc/.editorconfig) and
 *     SHELLCHECK_OPTS stripped from the gate env
 *   - kill switch: PI_FABRIC_SHELL_GATE=off (checked per call, so an operator
 *     can drop it into a running session)
 *
 * Post contract: outputs past the budget land whole in a stable dump file with
 * a visible in-band pointer (never a shadow cache), JSON gets a keys hint, a
 * failed echo-batch gets the segment-labeling tip, and a trailing `# full`
 * opts out — prose to read linearly beats three digest round-trips.
 * Fail-open one-liners; no silent transformations.
 */

/** Environment kill switch for the gate half of the policy. */
export const SHELL_POLICY_GATE_KILL_SWITCH = "PI_FABRIC_SHELL_GATE";

const GATE_TIMEOUT_MS = 5_000;
const MAX_FINDINGS = 6;
const SC_EXCLUDE = "SC1090,SC1091,SC2148,SC2012,SC2009";
const SHELL_METACHARS = /[$"\\`|&;<>()\n]/;
const FULL_MARKER = /#\s*full\s*$/;
const FAILED_BATCH_MARKER = /echo .*(===|---)/;
/** The valve is per-middleware (per session), not a module global, and bounded. */
const RETRY_VALVE_MAX_COMMANDS = 512;

export const DEFAULT_SHELL_POLICY_OFFLOAD_BYTES = 4_000;
/** Dense single-line payloads (one-line JSON, dump files) cannot be visually
 * scanned — they offload at a much lower threshold. */
export const DEFAULT_SHELL_POLICY_ONE_LINE_BYTES = 1_500;

/** Per-process dump directory: stable across reruns within a session, never
 * clobbered by a parallel host process. */
export const defaultShellPolicyDumpDir = (): string =>
  path.join(os.tmpdir(), "pi-fabric-shell-policy", String(process.pid));

const lintFindings = (parsed: unknown): FabricShellLintFindingV1[] | null => {
  if (!Array.isArray(parsed)) return null;
  const findings: FabricShellLintFindingV1[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const finding: FabricShellLintFindingV1 = {
      code: record.code as number | string,
      level: String(record.level ?? ""),
      line: Number(record.line ?? 0),
      column: Number(record.column ?? 0),
      message: String(record.message ?? ""),
    };
    if ((typeof finding.code !== "number" && typeof finding.code !== "string") ||
      finding.code === "" || !Number.isFinite(finding.line) || !Number.isFinite(finding.column)) {
      return null;
    }
    findings.push(finding);
  }
  return findings;
};

/** Parse layer. null = gate broken (fail-open); string = parse diagnostic. */
export const bashSyntaxCheck = (command: string, shell = "bash"): string | null => {
  try {
    const result = spawnSync(shell, ["--norc", "-n", "-c", command], {
      timeout: GATE_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.error || result.signal) return null;
    if (result.status === 0) return null;
    const out = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    return out.length > 0 ? out.slice(0, 600) : "bash refused to parse the command";
  } catch {
    return null;
  }
};

/** Semantic layer. null = shellcheck unavailable (fail-open). */
export const shellcheckLint = (
  command: string,
  binary = "shellcheck",
  env: NodeJS.ProcessEnv = process.env,
): FabricShellLintFindingV1[] | null => {
  // Determinism: SHELLCHECK_OPTS must not leak ambient operator config in.
  const { SHELLCHECK_OPTS: _stripped, ...rest } = env;
  try {
    const result = spawnSync(
      binary,
      ["--norc", "-f", "json", "-S", "info", "--shell=bash", `--exclude=${SC_EXCLUDE}`, "-"],
      { input: command, timeout: GATE_TIMEOUT_MS, encoding: "utf8", env: rest },
    );
    // exit 0 = clean, 1 = findings, >=2 = shellcheck itself failed → fail-open
    if (result.error || result.signal || result.status === null || result.status >= 2) return null;
    return lintFindings(JSON.parse(result.stdout || "[]"));
  } catch {
    return null;
  }
};

export const formatShellPolicyBlock = (findings: FabricShellLintFindingV1[]): string => {
  const shown = findings.slice(0, MAX_FINDINGS);
  const lines = shown.map(
    (finding, index) =>
      `${index + 1}. SC${finding.code} (${finding.level}) line ${finding.line}:${finding.column} — ${finding.message}`,
  );
  if (findings.length > shown.length) {
    lines.push(`(+${findings.length - shown.length} more)`);
  }
  return (
    `shell-gate: blocked — ${findings.length} shellcheck finding(s). Fix and retry; if intentional, ` +
    "put `# shellcheck disable=SCxxxx` on the line BEFORE the offending command.\n" +
    lines.join("\n")
  );
};

/** Head+tail view of an offloaded output; the marker names the dump. */
export const digestShellPolicyOutput = (out: string): string => {
  const lines = out.split("\n");
  if (lines.length > 20) {
    const cut = lines.length - 18;
    return [
      ...lines.slice(0, 6),
      `[... ${cut} lines cut — full output in the dump ...]`,
      ...lines.slice(-12),
    ].join("\n");
  }
  if (out.length > 1_200) {
    // single-line payloads (one-line JSON, dump files) need a byte cut
    return (
      out.slice(0, 600) +
      `\n[... ${out.length - 1_000} bytes cut — single-line payload, full output in the dump ...]\n` +
      out.slice(-400)
    );
  }
  return out;
};

/** Detect the payload shape; unwraps double-encoded JSON (a string wrapping JSON). */
export const sniffShellOutput = (out: string): { type: string; keys: string | null } => {
  const t = out.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[") && !t.startsWith('"')) {
    return { type: "text", keys: null };
  }
  try {
    let parsed: unknown = JSON.parse(out.length <= 65_536 ? out : out.slice(0, 65_536));
    let double = false;
    if (typeof parsed === "string") {
      const inner = parsed.trimStart();
      if (!inner.startsWith("{") && !inner.startsWith("[")) return { type: "text", keys: null };
      parsed = JSON.parse(parsed); // JSON string wrapping JSON
      double = true;
    }
    if (Array.isArray(parsed)) {
      return { type: double ? "JSON (double-encoded array)" : `JSON array[${parsed.length}]`, keys: null };
    }
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 12).join(", ");
      return { type: double ? "JSON (double-encoded object)" : "JSON object", keys };
    }
    return { type: "text", keys: null };
  } catch {
    return { type: "text", keys: null };
  }
};

/** Stable across reruns of the same command, isolated per dump directory. */
export const shellPolicyDumpPath = (dumpDir: string, command: string): string =>
  path.join(dumpDir, `${createHash("sha1").update(command).digest("hex").slice(0, 8)}.out`);

const writeShellDump = (dumpDir: string, command: string, output: string): string | undefined => {
  try {
    mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
    const target = shellPolicyDumpPath(dumpDir, command);
    writeFileSync(target, output, { mode: 0o600, flag: "w" });
    return target;
  } catch {
    return undefined; // fail-open: no dump, the output stays in the result
  }
};

/** Injected checkers keep the gate testable offline (falsifiers, no spawns). */
export interface ShellPolicyCheckers {
  /** null = pass, or the check itself is broken (fail-open); string = diagnostic. */
  syntaxCheck: (command: string) => string | null;
  /** null = linter unavailable (fail-open). */
  lint: (command: string) => FabricShellLintFindingV1[] | null;
}

export interface ShellPolicyOptions {
  /** Pre-exec gate; the env kill switch still wins when this is true. */
  gate?: boolean;
  /** Post-exec output budget (offload + pointer, JSON sniff, `# full`). */
  outputBudget?: boolean;
  shellPath?: string;
  shellcheckPath?: string;
  checkers?: ShellPolicyCheckers;
  dumpDir?: string;
  offloadBytes?: number;
  offloadOneLineBytes?: number;
}

export class FabricShellPolicyMiddleware implements FabricExecutionPolicyMiddlewareV1 {
  readonly version = 1 as const;
  readonly #checkers: ShellPolicyCheckers;
  readonly #gate: boolean;
  readonly #outputBudget: boolean;
  readonly #dumpDir: string;
  readonly #offloadBytes: number;
  readonly #offloadOneLineBytes: number;
  #attempts = new Map<string, number>();

  constructor(options: ShellPolicyOptions = {}) {
    this.#gate = options.gate !== false;
    this.#outputBudget = options.outputBudget !== false;
    this.#dumpDir = options.dumpDir ?? defaultShellPolicyDumpDir();
    this.#offloadBytes = options.offloadBytes ?? DEFAULT_SHELL_POLICY_OFFLOAD_BYTES;
    this.#offloadOneLineBytes = options.offloadOneLineBytes ?? DEFAULT_SHELL_POLICY_ONE_LINE_BYTES;
    this.#checkers = options.checkers ?? {
      syntaxCheck: (command) => bashSyntaxCheck(command, options.shellPath),
      lint: (command) => shellcheckLint(command, options.shellcheckPath),
    };
  }

  gate(command: string): FabricExecutionPolicyBlockV1 | null {
    if (!this.#gate || process.env[SHELL_POLICY_GATE_KILL_SWITCH] === "off") return null;
    if (command.trim().length === 0) return null;
    // Retry valve: the first attempt is checked, an identical retry passes —
    // re-blocking the same string only burns turns. A fixed command differs.
    const key = command.slice(0, 300);
    const attempts = (this.#attempts.get(key) ?? 0) + 1;
    if (!this.#attempts.has(key) && this.#attempts.size >= RETRY_VALVE_MAX_COMMANDS) {
      // Map iterates insertion order; drop the oldest remembered command.
      this.#attempts.delete(this.#attempts.keys().next().value as string);
    }
    this.#attempts.set(key, attempts);
    if (attempts > 1) return null;
    // Fail-open wraps the checkers themselves: an injected or default checker
    // that throws is a broken gate, and a broken gate never blocks a command.
    let parseError: string | null = null;
    try {
      parseError = this.#checkers.syntaxCheck(command);
    } catch {
      parseError = null;
    }
    if (parseError) {
      return {
        version: 1,
        message: `shell-gate: bash cannot parse this — fix before running:\n${parseError}`,
      };
    }
    // Plain words cannot misuse shell semantics; the linter adds signal only
    // once metacharacters make the string a shell program.
    if (SHELL_METACHARS.test(command)) {
      let findings: FabricShellLintFindingV1[] | null = null;
      try {
        findings = this.#checkers.lint(command);
      } catch {
        findings = null;
      }
      if (findings && findings.length > 0) {
        return { version: 1, message: formatShellPolicyBlock(findings), findings };
      }
    }
    return null;
  }

  post(
    command: string,
    outcome: FabricExecutionPolicyOutcomeV1,
  ): FabricExecutionPolicyPostResultV1 {
    if (!this.#outputBudget) return { notes: [], output: outcome.output };
    // Explicit valve: a trailing "# full" means the model wants the whole
    // thing in one piece — prose to read linearly, not data to slice.
    if (FULL_MARKER.test(command)) return { notes: [], output: outcome.output };

    const notes: string[] = [];
    let output = outcome.output;
    const out = outcome.output ?? "";
    const shape = sniffShellOutput(out);

    const threshold = out.split("\n").length <= 3
      ? this.#offloadOneLineBytes
      : this.#offloadBytes;
    if (out.length > threshold) {
      const dumpPath = writeShellDump(this.#dumpDir, command, out);
      if (dumpPath !== undefined) {
        notes.push(`full output → ${dumpPath} · ${shape.type} · ${out.length}B — rg/sed it, don't rerun`);
        output = digestShellPolicyOutput(out);
      }
    }

    if (shape.keys !== null || shape.type.includes("array")) {
      const detail = shape.keys ? `top keys: ${shape.keys}` : "slice with jq";
      notes.push(`hint: ${shape.type} — ${detail}, don't cat`);
    }

    // `a; b; c` reports the LAST exit — a failed first segment hides behind a
    // zero. Label segments so one failure doesn't smear the batch.
    if ((!outcome.ok || (outcome.exitCode ?? 0) !== 0) && FAILED_BATCH_MARKER.test(command)) {
      notes.push(
        `hint: failed batch — label segments: ( cmd ) || printf '[label FAIL %s]\\n' "$?"`,
      );
    }

    return { notes, output };
  }
}
