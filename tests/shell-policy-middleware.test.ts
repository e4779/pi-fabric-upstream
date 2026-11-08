import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActionRegistry } from "../src/core/action-registry.js";
import {
  bashSyntaxCheck,
  digestShellPolicyOutput,
  FabricShellPolicyMiddleware,
  formatShellPolicyBlock,
  shellcheckLint,
  shellPolicyDumpPath,
  sniffShellOutput,
  type ShellPolicyCheckers,
} from "../src/core/shell-policy-middleware.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import type { FabricShellLintFindingV1 } from "../src/protocol.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

// Offline falsifiers first (council Q3: pure cores must be provable without
// spawning anything); the real-spawn suite below pins the production checkers.
const finding = (code: number | string = 2086): FabricShellLintFindingV1 => ({
  code,
  level: "style",
  line: 1,
  column: 6,
  message: "Double quote to prevent globbing and word splitting.",
});

const offlineCheckers = (overrides: Partial<ShellPolicyCheckers> = {}): ShellPolicyCheckers => ({
  syntaxCheck: overrides.syntaxCheck ?? (() => null),
  lint: overrides.lint ?? (() => null),
});

describe("shell policy gate (offline contract)", () => {
  it("blocks on a syntax-check diagnostic with the fix-first message", () => {
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({ syntaxCheck: () => "syntax error near unexpected token `fi'" }),
    });
    const block = policy.gate("if true; then echo one");
    expect(block?.message).toContain("shell-gate: bash cannot parse this — fix before running");
    expect(block?.message).toContain("syntax error near unexpected token");
  });

  it("blocks on linter findings and tells the model how to disable one intentionally", () => {
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({ lint: () => [finding()] }),
    });
    const block = policy.gate("echo $HOME");
    expect(block?.message).toContain("shell-gate: blocked — 1 shellcheck finding(s)");
    expect(block?.message).toContain("put `# shellcheck disable=SCxxxx` on the line BEFORE the offending command");
    expect(block?.message).toContain("SC2086 (style) line 1:6");
    expect(block?.findings).toEqual([finding()]);
  });

  it("retry valve: an identical retry passes unchecked, a fixed command is checked again", () => {
    let lintCalls = 0;
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({
        lint: () => {
          lintCalls += 1;
          return [finding()];
        },
      }),
    });
    expect(policy.gate("echo $HOME")).not.toBeNull();
    // The lesson was seen: re-blocking the same string only burns turns.
    expect(policy.gate("echo $HOME")).toBeNull();
    expect(lintCalls).toBe(1);
    // A fixed command is a different string and is checked again.
    expect(policy.gate('echo "$HOME"')).not.toBeNull();
    expect(lintCalls).toBe(2);
  });

  it("fail-open: a throwing or broken checker never blocks execution", () => {
    const throwing = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: {
        syntaxCheck: () => {
          throw new Error("gate binary vanished");
        },
        lint: () => {
          throw new Error("shellcheck crashed");
        },
      },
    });
    expect(throwing.gate("echo 'payload with $ metachars'")).toBeNull();
    // null lint = linter unavailable → fail-open too
    const unavailable = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({ lint: () => null }),
    });
    expect(unavailable.gate("echo $HOME")).toBeNull();
  });

  it("runs the linter only when shell metacharacters make the string a program", () => {
    const lintCalls: string[] = [];
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({
        lint: (command) => {
          lintCalls.push(command);
          return [finding()];
        },
      }),
    });
    expect(policy.gate("echo plain-words-only")).toBeNull();
    expect(lintCalls).toEqual([]);
    expect(policy.gate("echo one; echo two")).not.toBeNull();
    expect(lintCalls).toEqual(["echo one; echo two"]);
  });

  it("respects the PI_FABRIC_SHELL_GATE=off kill switch on every call", () => {
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({ syntaxCheck: () => "always broken" }),
    });
    vi.stubEnv("PI_FABRIC_SHELL_GATE", "off");
    try {
      expect(policy.gate("if true; then echo one")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(policy.gate("if true; then echo one")).not.toBeNull();
  });

  it("an empty command and a disabled gate never block", () => {
    const policy = new FabricShellPolicyMiddleware({
      gate: true,
      checkers: offlineCheckers({ syntaxCheck: () => "never" }),
    });
    expect(policy.gate("   ")).toBeNull();
    const disabled = new FabricShellPolicyMiddleware({
      gate: false,
      checkers: offlineCheckers({ syntaxCheck: () => "never" }),
    });
    expect(disabled.gate("echo $HOME")).toBeNull();
  });

  it("caps the formatted findings at six plus a remainder count", () => {
    const findings = Array.from({ length: 8 }, (_, i) => finding(2000 + i));
    const message = formatShellPolicyBlock(findings);
    expect(message).toContain("8 shellcheck finding(s)");
    expect(message).toContain("SC2005");
    expect(message).not.toContain("SC2006");
    expect(message).toContain("(+2 more)");
  });
});

describe("shell policy post (output budget, offline contract)", () => {
  const dumpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shell-policy-test-"));

  it("offloads past-budget output whole, with a visible pointer, and digests the result", () => {
    const dir = dumpDir();
    const policy = new FabricShellPolicyMiddleware({ outputBudget: true, dumpDir: dir, offloadBytes: 100 });
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}-payload`);
    const output = lines.join("\n");
    const posted = policy.post("seq 1 40", { ok: true, exitCode: 0, output });
    expect(posted.notes[0]).toContain(`full output → ${shellPolicyDumpPath(dir, "seq 1 40")}`);
    expect(posted.notes[0]).toContain(`text · ${output.length}B — rg/sed it, don't rerun`);
    expect(fs.readFileSync(shellPolicyDumpPath(dir, "seq 1 40"), "utf8")).toBe(output);
    expect(posted.output).toContain("line-0-payload");
    expect(posted.output).toContain("line-39-payload");
    expect(posted.output).toContain("lines cut — full output in the dump");
  });

  it("uses the lower single-line threshold for dense one-line payloads", () => {
    const dir = dumpDir();
    const policy = new FabricShellPolicyMiddleware({
      outputBudget: true,
      dumpDir: dir,
      offloadBytes: 10_000,
      offloadOneLineBytes: 100,
    });
    const payload = "x".repeat(1_500);
    const posted = policy.post("cat dump.bin", { ok: true, exitCode: 0, output: payload });
    expect(posted.notes[0]).toContain("full output → ");
    expect(posted.output).toContain("single-line payload, full output in the dump");
    expect(posted.output).not.toBe(payload);
  });

  it("a trailing `# full` opts out: whole output, no notes, no dump", () => {
    const dir = dumpDir();
    const policy = new FabricShellPolicyMiddleware({ outputBudget: true, dumpDir: dir, offloadBytes: 10 });
    const output = "x".repeat(500);
    const posted = policy.post("cat data # full", { ok: true, exitCode: 0, output });
    expect(posted).toEqual({ notes: [], output });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("sniffs JSON shapes and hints at top keys instead of a blind cat", () => {
    const policy = new FabricShellPolicyMiddleware({ outputBudget: true, dumpDir: dumpDir() });
    const posted = policy.post("curl -s api", {
      ok: true,
      exitCode: 0,
      output: JSON.stringify({ alpha: 1, beta: 2, gamma: 3 }),
    });
    expect(posted.output).toBe(JSON.stringify({ alpha: 1, beta: 2, gamma: 3 }));
    expect(posted.notes).toEqual(["hint: JSON object — top keys: alpha, beta, gamma, don't cat"]);
  });

  it("labels a failed echo-batch so one failed segment cannot hide behind the last exit", () => {
    const policy = new FabricShellPolicyMiddleware({ outputBudget: true, dumpDir: dumpDir() });
    const posted = policy.post("echo step-1 === ; false; echo done ---", {
      ok: false,
      exitCode: 1,
      output: "",
    });
    expect(posted.notes.some((note) => note.startsWith("hint: failed batch — label segments:"))).toBe(true);
    // A passing batch never gets the tip.
    const passing = policy.post("echo step-1 === ; echo done ---", { ok: true, exitCode: 0, output: "" });
    expect(passing.notes.some((note) => note.includes("failed batch"))).toBe(false);
  });

  it("fail-open: an unwritable dump directory keeps the full output in the result", () => {
    const blocker = path.join(dumpDir(), "not-a-directory");
    fs.writeFileSync(blocker, "file where a directory is needed");
    const policy = new FabricShellPolicyMiddleware({
      outputBudget: true,
      dumpDir: path.join(blocker, "dumps"),
      offloadBytes: 10,
    });
    const output = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    const posted = policy.post("big one", { ok: true, exitCode: 0, output });
    expect(posted).toEqual({ notes: [], output });
  });

  it("digest and sniff stay pure: ported head/tail and shape detection", () => {
    expect(digestShellPolicyOutput("short\noutput")).toBe("short\noutput");
    const many = Array.from({ length: 25 }, (_, i) => `l${i}`).join("\n");
    expect(digestShellPolicyOutput(many)).toBe(
      ["l0", "l1", "l2", "l3", "l4", "l5", "[... 7 lines cut — full output in the dump ...]",
        "l13", "l14", "l15", "l16", "l17", "l18", "l19", "l20", "l21", "l22", "l23", "l24"].join("\n"),
    );
    expect(sniffShellOutput('{"items":[1,2]}')).toEqual({ type: "JSON object", keys: "items" });
    expect(sniffShellOutput("[1,2,3]")).toEqual({ type: "JSON array[3]", keys: null });
    expect(sniffShellOutput('"{\\"wrapped\\":1}"')).toEqual({ type: "JSON (double-encoded object)", keys: "wrapped" });
    expect(sniffShellOutput("plain text")).toEqual({ type: "text", keys: null });
    expect(sniffShellOutput("{not json")).toEqual({ type: "text", keys: null });
  });

  it("disabled output budget is a no-op", () => {
    const policy = new FabricShellPolicyMiddleware({ outputBudget: false, dumpDir: dumpDir() });
    expect(policy.post("cat x", { ok: true, exitCode: 0, output: "x".repeat(9_999) }))
      .toEqual({ notes: [], output: "x".repeat(9_999) });
  });
});

const windows = process.platform === "win32";
// Probe the real binaries once; findings from a clean probe mean the linter
// answered (empty array), null means it is absent and those pins skip.
const hasShellcheck = (() => {
  try {
    return shellcheckLint(":", "shellcheck") !== null;
  } catch {
    return false;
  }
})();
// Real-spawn pins: bash -n always exists on POSIX; shellcheck is probed live.
const realGate = it.skipIf(windows);
const realShellcheckGate = it.skipIf(windows || !hasShellcheck);

describe("shell policy gate (real checkers)", () => {
  realGate("bash -n refuses an unbalanced quote before anything runs", () => {
    expect(bashSyntaxCheck("echo ok")).toBeNull();
    expect(bashSyntaxCheck('echo "unclosed')).toBeTruthy();
    const policy = new FabricShellPolicyMiddleware({ gate: true });
    const block = policy.gate('echo "unclosed');
    expect(block?.message).toContain("shell-gate: bash cannot parse this");
  });

  realShellcheckGate("real shellcheck blocks an unquoted expansion", () => {
    const policy = new FabricShellPolicyMiddleware({ gate: true });
    const block = policy.gate("echo $HOME");
    expect(block?.message).toContain("shell-gate: blocked —");
    expect(block?.findings?.[0]?.code).toBe(2086);
  });

  realShellcheckGate("a disable directive on the line before passes the gate", () => {
    const policy = new FabricShellPolicyMiddleware({ gate: true });
    expect(policy.gate("# shellcheck disable=SC2086\necho $HOME")).toBeNull();
  });

  realShellcheckGate("SHELLCHECK_OPTS cannot smuggle options into the gate", () => {
    vi.stubEnv("SHELLCHECK_OPTS", "--exclude=SC2086");
    try {
      const policy = new FabricShellPolicyMiddleware({ gate: true });
      expect(policy.gate("echo $HOME")).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The first consumer: Fabric's own bash arm. One seam covers nested
// fabric_exec calls and top-level shell calls alike.
describe("pi.bash policy middleware integration", () => {
  const registries: ActionRegistry[] = [];
  afterEach(async () => {
    await Promise.all(registries.splice(0).map((registry) => registry.close()));
    vi.unstubAllEnvs();
  });

  const harness = (shellPolicy?: { gate: boolean; outputBudget: boolean }) => {
    const provider = new PiToolsProvider(process.cwd(), undefined, undefined, {
      powerShellToolDefinitionFactory: undefined,
      getShellHangMs: () => 120_000,
      ...(shellPolicy ? { shellPolicy } : {}),
    });
    const registry = new ActionRegistry();
    registry.register(provider);
    registries.push(registry);
    const invoke = (command: string) => registry.invoke(
      "pi.bash",
      { command },
      {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        parentToolCallId: "parent",
        nestedToolCallId: "fabric_shell-policy-test",
        extensionContext: {
          cwd: process.cwd(),
          sessionManager: {
            getSessionId: () => "shell-policy-test",
            getSessionFile: () => undefined,
          },
        } as unknown as ExtensionContext,
        update: () => undefined,
        approve: async () => {},
        audits: [],
        maxResultChars: 100_000,
      },
    ) as Promise<{ ok: boolean; output: string; details: unknown }>;
    return { provider, invoke };
  };

  realGate("a syntax error is blocked before any job exists", async () => {
    const { provider, invoke } = harness({ gate: true, outputBudget: true });
    await expect(invoke('echo "unclosed')).rejects.toThrow("[blocked by shell-gate, command not run]");
    expect(provider.shellJobs.live()).toEqual([]);
  });

  realGate("a JSON result carries the shape hint; `# full` opts out", async () => {
    const { invoke } = harness({ gate: true, outputBudget: true });
    const hinted = await invoke(`printf '{"alpha":1,"beta":2}'`);
    expect(hinted.ok).toBe(true);
    expect(hinted.output).toContain('{"alpha":1,"beta":2}');
    expect(hinted.output).toContain("hint: JSON object — top keys: alpha, beta, don't cat");
    const full = await invoke(`printf '{"alpha":1,"beta":2}' # full`);
    expect(full.output).toBe('{"alpha":1,"beta":2}');
  });

  realGate("without the policy capability the default path is byte-for-byte unchanged", async () => {
    const { invoke } = harness();
    const result = await invoke(`printf '{"alpha":1,"beta":2}'`);
    expect(result.output).toBe('{"alpha":1,"beta":2}');
    // A metachar command also runs verbatim with no policy attached.
    const plain = await invoke("echo ok-metachars; true");
    expect(plain.output).toBe("ok-metachars\n");
  });

  realGate("a disabled gate never blocks, a disabled budget never rewrites", async () => {
    const { invoke } = harness({ gate: false, outputBudget: false });
    const result = await invoke(`printf '{"alpha":1}'`);
    expect(result.output).toBe('{"alpha":1}');
  });
});

describe("executor.shellPolicy configuration", () => {
  it("defaults to gate + output budget on", () => {
    expect(DEFAULT_FABRIC_CONFIG.executor.shellPolicy).toEqual({ gate: true, outputBudget: true });
    expect(normalizeFabricConfig({}).executor.shellPolicy).toEqual({ gate: true, outputBudget: true });
  });

  it("normalizes each half independently and visibly", () => {
    expect(normalizeFabricConfig({ executor: { shellPolicy: { gate: false } } }).executor.shellPolicy)
      .toEqual({ gate: false, outputBudget: true });
    expect(
      normalizeFabricConfig({ executor: { shellPolicy: { gate: "no", outputBudget: 0 } } }).executor.shellPolicy,
    ).toEqual({ gate: true, outputBudget: true });
  });
});
