import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeForkSession, writeHandoffSession } from "../src/agents/handoff.js";
import type { AgentToolResultMessage } from "../src/agents/types.js";
import { createDurableSessionFile, declareWorkerSessionRole } from "../src/durable/worker-role-seed.js";

// The literal payload a context-aware extension reads as the host-declared worker role.
// Written out here on purpose: never imported from the code under test.
const workerPolicy = {
  schemaVersion: 1, layer: "host", declaredBy: "pi-fabric/durable-worker", values: { sessionRole: "worker" },
};
const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-role-seed-"));
  roots.push(root);
  return root;
};
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const parse = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const policies = (entries: any[]) => entries.filter(entry => entry.type === "custom" && entry.customType === "context-aware.policy.v1");
const isPolicy = (entry: any) => entry.type === "custom" && entry.customType === "context-aware.policy.v1";

describe("durable-session folder safety", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // process.getuid is the id the code compares the directory owner with. Stubbing it makes this
  // user's own directory look foreign; the assertions are on what the code does, never on the stub.
  it.skipIf(process.platform === "win32")("refuses a run directory owned by another user and creates nothing", () => {
    const run = temporary();
    const owner = fs.statSync(run).uid;
    fs.writeFileSync(path.join(run, "task.txt"), "keep");
    const before = fs.readdirSync(run).sort();
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    expect(() => createDurableSessionFile(run, run)).toThrow(/Run directory is not owned by this user/);
    expect(fs.readdirSync(run).sort()).toEqual(before);
    expect(fs.existsSync(path.join(run, "durable-session"))).toBe(false);
    vi.restoreAllMocks();
    expect(fs.existsSync(createDurableSessionFile(run, run))).toBe(true); // same directory, same owner id: accepted
  });

  it.skipIf(process.platform === "win32")("fails the launch when durable-session is a link, touching nothing behind it", () => {
    const run = temporary();
    const target = temporary();
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(run, "durable-session"), "dir");
    expect(() => createDurableSessionFile(run, run)).toThrow(/real directory, not a link/);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("creates the folder 0700 under an existing run directory, and never creates the run directory", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, run);
    expect(file).toBe(path.join(run, "durable-session", "session.jsonl"));
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(() => createDurableSessionFile(path.join(run, "missing", "run"), run)).toThrow();
    expect(fs.existsSync(path.join(run, "missing"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("tightens a run directory that group or others can write, then creates the session with the policy root", () => {
    const cases: Array<[number, number]> = [[0o770, 0o750], [0o707, 0o705], [0o702, 0o700], [0o720, 0o700]];
    for (const [mode, expected] of cases) {
      const run = temporary();
      fs.chmodSync(run, mode);
      const file = createDurableSessionFile(run, run);
      expect(fs.statSync(run).mode & 0o7777).toBe(expected);
      expect(file).toBe(path.join(run, "durable-session", "session.jsonl"));
      const entries = parse(file);
      expect(policies(entries)).toHaveLength(1);
      expect(entries[1]).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null, data: workerPolicy });
    }
  });

  it.skipIf(process.platform === "win32")("accepts a run directory that others can read but not write", () => {
    const run = temporary();
    fs.chmodSync(run, 0o755);
    expect(fs.existsSync(createDurableSessionFile(run, run))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a run directory that is a link", () => {
    const real = temporary();
    fs.chmodSync(real, 0o775);
    const link = path.join(temporary(), "run-link");
    fs.symlinkSync(real, link, "dir");
    expect(() => createDurableSessionFile(link, link)).toThrow(/real directory, not a link/);
    expect(fs.readdirSync(real)).toEqual([]);
    expect(fs.statSync(real).mode & 0o7777).toBe(0o775); // not tightened through the link either
  });
});

describe("a new durable-session file", () => {
  it("is a Pi header, then the worker-role entry as the tree root with the literal payload", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    expect(lines).toHaveLength(3); // header, policy, trailing newline
    expect(lines[2]).toBe("");
    const [header, policy] = parse(file);
    expect(header).toMatchObject({ type: "session", version: 3, cwd: "/work" });
    expect(Object.keys(policy).sort()).toEqual(["customType", "data", "id", "parentId", "timestamp", "type"]);
    expect(policy).toMatchObject({ type: "custom", customType: "context-aware.policy.v1", parentId: null });
    expect(policy.data).toEqual({
      schemaVersion: 1, layer: "host", declaredBy: "pi-fabric/durable-worker", values: { sessionRole: "worker" },
    });
    expect(policy.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is opened by real Pi, which appends after the policy so every branch from the new leaf includes it", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    const before = parse(file);
    const pi = SessionManager.open(file, path.dirname(file), "/work");
    expect(pi.getBranch().map(entry => entry.id)).toEqual([before[1].id]);
    pi.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const leaf = pi.appendCustomEntry("test.after", { n: 1 });
    expect(policies(pi.getBranch(leaf) as any[]).map(entry => entry.data)).toEqual([workerPolicy]);
    expect(pi.getBranch(leaf).map(entry => entry.type)).toEqual(["custom", "message", "custom"]);
    // A fresh open of what Pi wrote sees the same, and the first two lines are untouched.
    const reopened = SessionManager.open(file, path.dirname(file), "/work");
    expect(policies(reopened.getBranch() as any[]).map(entry => entry.data)).toEqual([workerPolicy]);
    expect(parse(file).slice(0, 2)).toEqual(before);
  });

  it("leaves an existing file untouched on relaunch, byte for byte", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    const pi = SessionManager.open(file, path.dirname(file), "/work");
    pi.appendMessage({ role: "user", content: "kept", timestamp: 1 });
    const before = fs.readFileSync(file, "utf8");
    expect(createDurableSessionFile(run, "/other-cwd")).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(policies(parse(file))).toHaveLength(1);
  });

  it("reuses a file with any content as it is, without reading or editing it", () => {
    const run = temporary();
    fs.mkdirSync(path.join(run, "durable-session"), { mode: 0o700 });
    const file = path.join(run, "durable-session", "session.jsonl");
    for (const content of ["", "{\"type\":\"sess", "not json\n"]) {
      fs.writeFileSync(file, content, { mode: 0o600 });
      expect(createDurableSessionFile(run, "/work")).toBe(file);
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
  });
});

describe("durable-session file safety", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const setup = () => {
    const run = temporary();
    const folder = path.join(run, "durable-session");
    fs.mkdirSync(folder, { mode: 0o700 });
    return { run, folder, file: path.join(folder, "session.jsonl") };
  };

  it.skipIf(process.platform === "win32")("rejects symlinks, including dangling ones, without touching targets", () => {
    for (const dangling of [false, true]) {
      const { run, file } = setup();
      const target = path.join(temporary(), "target");
      if (!dangling) { fs.writeFileSync(target, "keep"); fs.chmodSync(target, 0o644); }
      fs.symlinkSync(target, file);
      expect(() => createDurableSessionFile(run, run)).toThrow(/regular file/);
      if (!dangling) { expect(fs.readFileSync(target, "utf8")).toBe("keep"); expect(fs.statSync(target).mode & 0o777).toBe(0o644); }
    }
  });

  it("rejects a directory at the session path", () => {
    const { run, file } = setup();
    fs.mkdirSync(file);
    expect(() => createDurableSessionFile(run, run)).toThrow(/regular file/);
  });

  it.skipIf(process.platform === "win32")("rejects foreign-owned files before cleanup or chmod", () => {
    const { run, file } = setup();
    fs.writeFileSync(file, "keep", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const original = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...args: unknown[]) => {
      const stat = original(p) as fs.Stats;
      if (String(p) === file) Object.defineProperty(stat, "uid", { value: process.getuid!() + 1 });
      return stat;
    }) as typeof fs.lstatSync);
    expect(() => createDurableSessionFile(run, run)).toThrow(/not owned/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("rejects external hard links without changing their permissions or bytes", () => {
    const { run, file } = setup();
    const external = path.join(temporary(), "external");
    fs.writeFileSync(external, "keep"); fs.chmodSync(external, 0o644);
    fs.linkSync(external, file);
    expect(() => createDurableSessionFile(run, run)).toThrow(/hard links/);
    expect(fs.statSync(external).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(external, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("tightens an existing safe file without changing its contents", () => {
    const { run, file } = setup();
    fs.writeFileSync(file, "keep"); fs.chmodSync(file, 0o666);
    expect(createDurableSessionFile(run, run)).toBe(file);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("rejects unsafe race winners and cleans the losing temporary file", () => {
    for (const kind of ["symlink", "directory", "hardlink"] as const) {
      const run = temporary();
      const folder = path.join(run, "durable-session");
      const file = path.join(folder, "session.jsonl");
      const target = path.join(temporary(), "target");
      fs.writeFileSync(target, "keep"); fs.chmodSync(target, 0o644);
      expect(() => createDurableSessionFile(run, run, { beforeLink: () => {
        if (kind === "symlink") fs.symlinkSync(target, file);
        else if (kind === "directory") fs.mkdirSync(file);
        else fs.linkSync(target, file);
      } })).toThrow(kind === "hardlink" ? /hard links/ : /regular file/);
      expect(fs.readdirSync(folder)).toEqual(["session.jsonl"]);
      expect(fs.readFileSync(target, "utf8")).toBe("keep");
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    }
  });
});

describe("durable-session creation is atomic", () => {
  const leftovers = (folder: string) => fs.readdirSync(folder).filter(name => name !== "session.jsonl");

  it("shows session.jsonl only complete, by link, with no temp name left", () => {
    const run = temporary();
    let seenAtLink: string[] = [];
    const file = createDurableSessionFile(run, "/work", {
      beforeLink: () => { seenAtLink = fs.readdirSync(path.join(run, "durable-session")); },
    });
    expect(seenAtLink.some(name => /^tmp-.*\.jsonl$/.test(name))).toBe(true);
    expect(seenAtLink).not.toContain("session.jsonl");
    expect(parse(file).map(entry => entry.type)).toEqual(["session", "custom"]);
    expect(leftovers(path.dirname(file))).toEqual([]);
    expect(fs.statSync(file).nlink).toBe(1);
  });

  it("lets exactly one of two racing creators win, and the loser keeps the winner's file", () => {
    const run = temporary();
    const folder = path.join(run, "durable-session");
    let winnerBytes = "";
    // Creator A pauses just before its link; creator B runs to completion in that gap.
    const fileA = createDurableSessionFile(run, "/work-a", {
      beforeLink: () => { winnerBytes = fs.readFileSync(createDurableSessionFile(run, "/work-b"), "utf8"); },
    });
    expect(winnerBytes).not.toBe("");
    expect(fs.readFileSync(fileA, "utf8")).toBe(winnerBytes);
    const entries = parse(fileA);
    expect(entries.filter(entry => entry.type === "session")).toHaveLength(1);
    expect(policies(entries)).toHaveLength(1);
    expect(entries[0].cwd).toBe("/work-b");
    expect(leftovers(folder)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("removes its own temp name when a crash left it linked next to session.jsonl", () => {
    const run = temporary();
    const file = createDurableSessionFile(run, "/work");
    const stray = path.join(path.dirname(file), "tmp-00000000-0000-4000-8000-000000000000.jsonl");
    fs.linkSync(file, stray); // crash between link and unlink
    expect(fs.statSync(file).nlink).toBe(2);
    createDurableSessionFile(run, "/work"); // the relaunch
    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.statSync(file).nlink).toBe(1);
  });
});

// Seeds from the real writers. Entries come from a real Pi source session.
const outerResult = (toolCallId: string): AgentToolResultMessage => ({
  role: "toolResult", toolCallId, toolName: "fabric_exec", content: [{ type: "text", text: "done" }], isError: false, timestamp: 9,
});
const assistantTurn = (callId: string) => ({
  role: "assistant", content: [
    { type: "text", text: "working" },
    { type: "toolCall", id: callId, name: "fabric_exec", arguments: { code: "1" } },
  ],
  api: "anthropic", provider: "anthropic", model: "frontier", stopReason: "toolUse", timestamp: 3,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

/** Entry ids, session id and timestamps differ per write; map them to their order of appearance so two writes compare byte for byte otherwise. */
const normalized = (file: string): string => {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const ids = parse(file).filter(entry => entry.type !== "session").map(entry => entry.id as string);
  let text = lines.join("\n");
  ids.forEach((id, index) => { text = text.split(JSON.stringify(id)).join(JSON.stringify("ID" + index)); });
  return text
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"T"')
    .replace(/("type":"session","version":3,"id":)"[^"]*"/, '$1"H"')
    .replace(/handoff-[0-9a-f-]{36}/g, "handoff-H")
    .replace(/[^"]*fabric-role-seed-[A-Za-z0-9]+/g, "ROOT")
    // parentSession is path.join(root, "source", <name>) as JSON text: "/" on POSIX, an escaped "\\" on Windows.
    .replace(/(ROOT(?:\/|\\\\)source(?:\/|\\\\))[^"]*\.jsonl/g, "$1S.jsonl");
};

type Kind = "fork" | "handoff in-memory" | "handoff persisted";
const seedFile = (kind: Kind, workerRole: boolean | undefined) => {
  const root = temporary();
  const source = kind === "handoff persisted"
    ? SessionManager.create(root, path.join(root, "source"))
    : SessionManager.inMemory(root);
  const first = source.appendMessage({ role: "user", content: "inherited question", timestamp: 1 });
  source.appendMessage(assistantTurn(kind === "fork" ? "unused" : "outer-call"));
  const options = workerRole === undefined ? undefined : { workerRole };
  if (kind === "fork") {
    const branch = source.getBranch();
    return { first, root, file: writeForkSession({ sourceSessionId: "source", sourceBranch: branch }, root, path.join(root, "child"), undefined, options) };
  }
  const branch = source.getBranch();
  const seed = {
    sourceSessionId: "source", sourceBranchLeafId: branch.at(-1)!.id,
    ...(kind === "handoff persisted" ? { sourceSessionFile: source.getSessionFile()! } : { sourceBranch: branch }),
    outerToolResult: outerResult("outer-call"),
  };
  return { first, root, file: writeHandoffSession(seed, root, path.join(root, "child"), undefined, undefined, undefined, options) };
};

describe.each(["fork", "handoff in-memory", "handoff persisted"] as const)("a pi-durable %s seed", kind => {
  it("puts the worker-role entry first as the root and hangs the seed's former root under it", () => {
    const { first, file } = seedFile(kind, true);
    const lines = parse(file);
    expect(lines[0].type).toBe("session");
    expect(lines.filter(isPolicy)).toHaveLength(1);
    expect(isPolicy(lines[1])).toBe(true);
    expect(lines[1].parentId).toBe(null);
    expect(lines[1].data).toEqual(workerPolicy);
    expect(lines[2]).toMatchObject({ id: first, type: "message", parentId: lines[1].id });
    expect(lines.slice(1).filter(entry => entry.parentId === null)).toEqual([lines[1]]); // one root
  });

  it("is opened by real Pi, and every branch from the new leaf includes the policy", () => {
    const { file, root } = seedFile(kind, true);
    const pi = SessionManager.open(file, path.dirname(file), root);
    const leaf = pi.appendMessage({ role: "user", content: "next task", timestamp: 5 });
    const branch = pi.getBranch(leaf) as any[];
    expect(branch[0].data).toEqual(workerPolicy);
    expect(policies(branch)).toHaveLength(1);
    expect(policies(pi.getBranch() as any[]).map(entry => entry.data)).toEqual([workerPolicy]);
    // A branch reached by navigating back to the seed's first message still descends from the policy.
    const lines = parse(file);
    expect(policies(pi.getBranch(lines[2].id) as any[]).map(entry => entry.data)).toEqual([workerPolicy]);
  });

  it("leaves the inherited history unchanged: same messages as the same seed written without the option", () => {
    const withRole = seedFile(kind, true);
    const without = seedFile(kind, undefined);
    const messages = (s: { file: string; root: string }) => SessionManager.open(s.file, path.dirname(s.file), s.root).buildSessionContext().messages;
    const expected = messages(without);
    expect(expected.map(message => message.role)).toEqual(
      kind === "fork" ? ["user", "assistant"] : ["user", "assistant", "toolResult"],
    );
    expect(messages(withRole)).toEqual(expected);
    // Everything but the root is the same entries in the same order.
    const rest = (file: string) => parse(file).slice(1).filter(entry => !isPolicy(entry)).map(entry => entry.type);
    expect(rest(withRole.file)).toEqual(rest(without.file));
  });
});

describe.each(["fork", "handoff in-memory", "handoff persisted"] as const)("a plain pi %s seed", kind => {
  it("is byte-identical to the writer output without the option, with no worker-role entry", () => {
    const plain = seedFile(kind, undefined);
    const explicitlyOff = seedFile(kind, false);
    const absent = normalized(plain.file);
    expect(normalized(explicitlyOff.file)).toBe(absent);
    expect(policies(parse(plain.file))).toEqual([]);
    expect(parse(plain.file)[1]).toMatchObject({ id: plain.first, parentId: null });
  });
});

describe("declareWorkerSessionRole (embedding host)", () => {
  it("writes the worker policy entry once and nothing on a repeat call", () => {
    const manager = SessionManager.inMemory("/tmp");
    expect(declareWorkerSessionRole(manager)).toBe("seeded");
    expect(declareWorkerSessionRole(manager)).toBe("already-seeded");
    const written = manager.getEntries().filter(isPolicy);
    expect(written).toHaveLength(1);
    expect((written[0] as any).data).toEqual(workerPolicy);
  });

  it("seeds a branch even when a sibling branch declares worker, then stays idempotent", () => {
    const manager = SessionManager.inMemory("/tmp");
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    manager.appendCustomEntry("context-aware.policy.v1", workerPolicy);
    manager.branch(root);
    expect(declareWorkerSessionRole(manager)).toBe("seeded");
    expect(declareWorkerSessionRole(manager)).toBe("already-seeded");
    expect(policies(manager.getEntries() as any[])).toHaveLength(2);
    expect(policies(manager.getBranch() as any[])).toHaveLength(1);
  });

  it("reasserts worker after a later host override and ignores unrelated policy paths", () => {
    const manager = SessionManager.inMemory("/tmp");
    expect(declareWorkerSessionRole(manager)).toBe("seeded");
    manager.appendCustomEntry("context-aware.policy.v1", { schemaVersion: 1, layer: "host", values: { sessionRole: "foreground" } });
    manager.appendCustomEntry("context-aware.policy.v1", { schemaVersion: 1, layer: "host", values: { anotherSetting: true } });
    expect(declareWorkerSessionRole(manager)).toBe("seeded");
    manager.appendCustomEntry("context-aware.policy.v1", { schemaVersion: 1, layer: "host", values: { anotherSetting: false } });
    expect(declareWorkerSessionRole(manager)).toBe("already-seeded");
    expect(policies(manager.getBranch() as any[]).filter(entry => entry.data.values.sessionRole === "worker")).toHaveLength(2);
  });

  it("still writes when the only policy on the session declares another role", () => {
    const manager = SessionManager.inMemory("/tmp");
    manager.appendCustomEntry("context-aware.policy.v1", { schemaVersion: 1, layer: "host", values: { sessionRole: "foreground" } });
    expect(declareWorkerSessionRole(manager)).toBe("seeded");
    expect(manager.getEntries().filter(isPolicy)).toHaveLength(2);
  });
});
