import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFabricShellPolicyFacade,
  registerFabricShellPolicyService,
} from "../src/core/shell-policy-facade.js";
import {
  defaultShellPolicyDumpDir,
  SHELL_POLICY_GATE_KILL_SWITCH,
  type ShellPolicyCheckers,
} from "../src/core/shell-policy-middleware.js";
import {
  FABRIC_SHELL_POLICY_CONFIG_EVENT,
  FABRIC_SHELL_POLICY_GATE_EVENT,
  FABRIC_SHELL_POLICY_POST_EVENT,
  MAX_FABRIC_SHELL_POLICY_OUTCOME_OUTPUT,
  readFabricShellPolicyConfigRequestV1,
  readFabricShellPolicyGateRequestV1,
  readFabricShellPolicyPostRequestV1,
} from "../src/protocol.js";
import type { FabricShellLintFindingV1 } from "../src/protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-policy-facade-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const finding = (code: number | string = 2086): FabricShellLintFindingV1 => ({
  code,
  level: "style",
  line: 1,
  column: 6,
  message: "Double quote to prevent globbing and word splitting.",
});

/** Offline falsifiers: pure cores must be provable without spawning anything. */
const offlineCheckers = (overrides: Partial<ShellPolicyCheckers> = {}): ShellPolicyCheckers => ({
  syntaxCheck: overrides.syntaxCheck ?? (() => null),
  lint: overrides.lint ?? (() => null),
});

type Handler = (value: unknown) => unknown;

/** Minimal `pi.events` double mirroring how extension.ts subscribes channels. */
const fakePi = () => {
  const channels = new Map<string, Handler>();
  const on = vi.fn((channel: string, handler: Handler) => {
    channels.set(channel, handler);
    return () => channels.delete(channel);
  });
  const emit = (channel: string, value: unknown): unknown => channels.get(channel)?.(value);
  return { events: { on }, channels, on, emit };
};

describe("shell policy facade over the middleware (gate/post/config)", () => {
  it("gate delegates to the middleware contract and carries the linter findings", () => {
    const facade = createFabricShellPolicyFacade(
      () => ({ gate: true, outputBudget: true }),
      { checkers: offlineCheckers({ lint: () => [finding()] }) },
    );
    const block = facade.gate("echo $HOME");
    expect(block?.version).toBe(1);
    expect(block?.message).toContain("shell-gate: blocked");
    expect(block?.findings).toEqual([finding()]);
    // No metacharacters, no lint; a clean command passes as null.
    expect(facade.gate("ls")).toBeNull();
  });

  it("the bounded retry valve persists across facade calls within one config", () => {
    let lintCalls = 0;
    const config = { gate: true, outputBudget: true };
    const facade = createFabricShellPolicyFacade(
      () => config,
      { checkers: offlineCheckers({ lint: () => { lintCalls += 1; return [finding()]; } }) },
    );
    expect(facade.gate("echo $HOME")).not.toBeNull();
    // Same session config, same middleware: the identical retry passes.
    expect(facade.gate("echo $HOME")).toBeNull();
    expect(lintCalls).toBe(1);
    // A fixed command is a different string and is checked again.
    expect(facade.gate('echo "$HOME"')).not.toBeNull();
    expect(lintCalls).toBe(2);
  });

  it("a same-shaped config object does not reset the valve; a changed config rebuilds it", () => {
    let lintCalls = 0;
    let config = { gate: true, outputBudget: true };
    const facade = createFabricShellPolicyFacade(
      () => config,
      { checkers: offlineCheckers({ lint: () => { lintCalls += 1; return [finding()]; } }) },
    );
    expect(facade.gate("echo $HOME")).not.toBeNull();
    expect(facade.gate("echo $HOME")).toBeNull();
    config = { gate: true, outputBudget: true }; // same surface, new object: valve holds
    expect(facade.gate("echo $HOME")).toBeNull();
    expect(lintCalls).toBe(1);
    config = { gate: true, outputBudget: false }; // config change: fresh middleware
    expect(facade.gate("echo $HOME")).not.toBeNull();
    expect(lintCalls).toBe(2);
  });

  it(`the kill switch is ${SHELL_POLICY_GATE_KILL_SWITCH}=off, checked per call; the lab alias is dead`, () => {
    const facade = createFabricShellPolicyFacade(
      () => ({ gate: true, outputBudget: true }),
      { checkers: offlineCheckers({ lint: () => [finding()] }) },
    );
    const previous = process.env[SHELL_POLICY_GATE_KILL_SWITCH];
    const labAlias = "PI_SHELL_GATE";
    const previousAlias = process.env[labAlias];
    cleanups.push(() => {
      if (previous === undefined) delete process.env[SHELL_POLICY_GATE_KILL_SWITCH];
      else process.env[SHELL_POLICY_GATE_KILL_SWITCH] = previous;
      if (previousAlias === undefined) delete process.env[labAlias];
      else process.env[labAlias] = previousAlias;
    });
    // One name, and only that name: the adopted lab alias must not work.
    process.env[labAlias] = "off";
    expect(facade.gate("echo $HOME")).not.toBeNull();
    process.env[SHELL_POLICY_GATE_KILL_SWITCH] = "off";
    expect(facade.gate("echo $HOME")).toBeNull();
    delete process.env[SHELL_POLICY_GATE_KILL_SWITCH];
    expect(facade.gate('echo "$HOME"')).not.toBeNull(); // unseen string: gate live again
  });

  it("post offloads past-budget output into the dump dir and points at the whole artifact", () => {
    const dumpDir = tempRoot();
    const facade = createFabricShellPolicyFacade(
      () => ({ gate: true, outputBudget: true }),
      { checkers: offlineCheckers(), dumpDir, offloadBytes: 20, offloadOneLineBytes: 10 },
    );
    const output = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}-aaaaaaaaaa`).join("\n");
    const posted = facade.post("cat big.log", { ok: true, exitCode: 0, output });
    expect(posted.notes).toHaveLength(1);
    expect(posted.notes[0]).toContain(dumpDir);
    expect(posted.notes[0]).toContain("full output");
    expect(posted.output).not.toBe(output); // head+tail digest
    expect(posted.output).toContain("lines cut");
    const dumpPath = posted.notes[0]!.split(" ")[3]!;
    expect(fs.readFileSync(dumpPath, "utf8")).toBe(output); // whole output, never a shadow cache
  });

  it("post keeps small output whole and hints at JSON shape; `# full` opts out entirely", () => {
    const dumpDir = tempRoot();
    const facade = createFabricShellPolicyFacade(
      () => ({ gate: true, outputBudget: true }),
      { checkers: offlineCheckers(), dumpDir, offloadBytes: 20, offloadOneLineBytes: 50 },
    );
    const posted = facade.post("curl api", { ok: true, exitCode: 0, output: '{"a":1,"b":2}' });
    expect(posted.output).toBe('{"a":1,"b":2}');
    expect(posted.notes).toEqual(["hint: JSON object — top keys: a, b, don't cat"]);
    const opted = facade.post("curl api # full", { ok: true, exitCode: 0, output: '{"a":1,"b":2}' });
    expect(opted).toEqual({ notes: [], output: '{"a":1,"b":2}' });
  });

  it("config() reports the one kill-switch name, the per-pid dump dir, and the live halves", () => {
    const on = createFabricShellPolicyFacade(() => ({ gate: true, outputBudget: true }));
    expect(on.config()).toEqual({
      version: 1,
      available: true,
      gate: true,
      outputBudget: true,
      killSwitchEnv: "PI_FABRIC_SHELL_GATE",
      offloadBytes: 4_000,
      offloadOneLineBytes: 1_500,
      dumpDir: defaultShellPolicyDumpDir(),
    });
    expect(on.config().dumpDir.endsWith(String(process.pid))).toBe(true);
    const off = createFabricShellPolicyFacade(() => ({ gate: false, outputBudget: false }));
    expect(off.config().gate).toBe(false);
    expect(off.config().outputBudget).toBe(false);
  });

  it("before the session config exists the facade answers fail-open and reports unavailable", () => {
    let config: { gate: boolean; outputBudget: boolean } | undefined;
    const facade = createFabricShellPolicyFacade(
      () => config,
      { checkers: offlineCheckers({ lint: () => [finding()] }) },
    );
    expect(facade.gate("echo $HOME")).toBeNull(); // never blocks without a live policy
    const outcome = { ok: true, exitCode: 0, output: "kept whole" };
    expect(facade.post("cat", outcome)).toEqual({ notes: [], output: "kept whole" });
    expect(facade.config()).toMatchObject({ available: false, gate: false, outputBudget: false });
    config = { gate: true, outputBudget: true };
    expect(facade.gate("echo $HOME")).not.toBeNull(); // live again, same facade
    expect(facade.config().available).toBe(true);
  });
});

describe("shell policy extension registration (pi.events surface)", () => {
  const context = {} as ExtensionContext;

  it("wires gate/post/config channels and answers via respond", () => {
    const dumpDir = tempRoot();
    const pi = fakePi();
    const unsubscribe = registerFabricShellPolicyService(
      pi as never,
      () => ({ gate: true, outputBudget: true }),
      { checkers: offlineCheckers({ lint: () => [finding()] }), dumpDir, offloadBytes: 20, offloadOneLineBytes: 10 },
    );
    cleanups.push(unsubscribe);
    expect(pi.on).toHaveBeenCalledTimes(3);

    const blocks: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_GATE_EVENT, {
      version: 1,
      command: "echo $HOME",
      respond: (block: unknown) => blocks.push(block),
    });
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { findings: FabricShellLintFindingV1[] }).findings).toEqual([finding()]);

    const passes: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_GATE_EVENT, {
      version: 1,
      command: "ls",
      respond: (block: unknown) => passes.push(block),
    });
    expect(passes).toEqual([null]);

    const posts: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_POST_EVENT, {
      version: 1,
      command: "cat big.log",
      outcome: { ok: true, exitCode: 0, output: "x".repeat(40) },
      respond: (result: unknown) => posts.push(result),
    });
    expect(posts).toHaveLength(1);
    expect((posts[0] as { notes: string[] }).notes[0]).toContain(dumpDir);

    const configs: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_CONFIG_EVENT, {
      version: 1,
      respond: (config: unknown) => configs.push(config),
    });
    expect(configs[0]).toMatchObject({
      version: 1,
      available: true,
      gate: true,
      outputBudget: true,
      killSwitchEnv: "PI_FABRIC_SHELL_GATE",
    });

    // Malformed payloads are rejected before any state is touched.
    expect(() => pi.emit(FABRIC_SHELL_POLICY_GATE_EVENT, { version: 2, command: "x" }))
      .toThrow("Invalid Pi Fabric shell policy gate request");
    expect(() => pi.emit(FABRIC_SHELL_POLICY_POST_EVENT, { version: 1, command: "x", outcome: { ok: "yes" } }))
      .toThrow("Invalid Pi Fabric shell policy post request");
    expect(() => pi.emit(FABRIC_SHELL_POLICY_CONFIG_EVENT, { version: 1, respond: "nope" }))
      .toThrow("Invalid Pi Fabric shell policy config request");

    unsubscribe();
    expect(pi.channels.size).toBe(0);
  });

  it("over events, a session without config answers fail-open on every channel", () => {
    const pi = fakePi();
    const unsubscribe = registerFabricShellPolicyService(pi as never, () => undefined);
    cleanups.push(unsubscribe);
    const blocks: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_GATE_EVENT, {
      version: 1,
      command: "echo $HOME",
      respond: (block: unknown) => blocks.push(block),
    });
    expect(blocks).toEqual([null]);
    const posts: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_POST_EVENT, {
      version: 1,
      command: "cat",
      outcome: { ok: true, exitCode: 0, output: "kept whole" },
      respond: (result: unknown) => posts.push(result),
    });
    expect(posts).toEqual([{ notes: [], output: "kept whole" }]);
    const configs: unknown[] = [];
    pi.emit(FABRIC_SHELL_POLICY_CONFIG_EVENT, {
      version: 1,
      respond: (config: unknown) => configs.push(config),
    });
    expect(configs[0]).toMatchObject({ available: false, gate: false, outputBudget: false });
  });

  it("context stays unused; the facade never needs a live session object", () => {
    expect(context).toBeDefined();
  });
});

describe("shell policy protocol readers", () => {
  it("accepts and copies a valid gate request", () => {
    const respond = () => {};
    expect(readFabricShellPolicyGateRequestV1({ version: 1, command: "ls -la", respond })).toEqual({
      version: 1,
      command: "ls -la",
      respond,
    });
    expect(readFabricShellPolicyGateRequestV1({ version: 1, command: "ls" })).toEqual({
      version: 1,
      command: "ls",
    });
  });

  it("rejects malformed gate requests", () => {
    const valid = { version: 1, command: "ls" };
    expect(readFabricShellPolicyGateRequestV1(null)).toBeUndefined();
    expect(readFabricShellPolicyGateRequestV1([valid])).toBeUndefined();
    expect(readFabricShellPolicyGateRequestV1({ ...valid, version: 2 })).toBeUndefined();
    expect(readFabricShellPolicyGateRequestV1({ ...valid, command: "" })).toBeUndefined();
    expect(readFabricShellPolicyGateRequestV1({ ...valid, command: "x".repeat(16_385) })).toBeUndefined();
    expect(readFabricShellPolicyGateRequestV1({ ...valid, respond: "nope" })).toBeUndefined();
  });

  it("accepts a valid post request, including a null exit code", () => {
    const outcome = { ok: false, exitCode: null, output: "boom" };
    expect(readFabricShellPolicyPostRequestV1({ version: 1, command: "ls", outcome })).toEqual({
      version: 1,
      command: "ls",
      outcome,
    });
    expect(
      readFabricShellPolicyPostRequestV1({
        version: 1,
        command: "ls",
        outcome: { ok: true, exitCode: 3, output: "" },
      })?.outcome,
    ).toEqual({ ok: true, exitCode: 3, output: "" });
  });

  it("rejects malformed post outcomes and bounds the output", () => {
    const valid = { version: 1, command: "ls", outcome: { ok: true, exitCode: 0, output: "x" } };
    expect(readFabricShellPolicyPostRequestV1(valid)).toBeDefined();
    expect(readFabricShellPolicyPostRequestV1({ ...valid, version: 2 })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({ ...valid, command: "" })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({ ...valid, outcome: undefined })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({
      ...valid,
      outcome: { ok: "yes", exitCode: 0, output: "x" },
    })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({
      ...valid,
      outcome: { ok: true, exitCode: 1.5, output: "x" },
    })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({
      ...valid,
      outcome: { ok: true, exitCode: 0, output: "x".repeat(MAX_FABRIC_SHELL_POLICY_OUTCOME_OUTPUT + 1) },
    })).toBeUndefined();
    expect(readFabricShellPolicyPostRequestV1({
      ...valid,
      outcome: { ok: true, exitCode: 0 },
    })).toBeUndefined();
  });

  it("accepts a bare config probe and rejects a wrong version", () => {
    expect(readFabricShellPolicyConfigRequestV1({ version: 1 })).toEqual({ version: 1 });
    expect(readFabricShellPolicyConfigRequestV1({ version: 2 })).toBeUndefined();
    expect(readFabricShellPolicyConfigRequestV1({ version: 1, respond: () => {} })).toBeDefined();
    expect(readFabricShellPolicyConfigRequestV1({ version: 1, respond: 4 })).toBeUndefined();
    expect(readFabricShellPolicyConfigRequestV1("config")).toBeUndefined();
  });
});
