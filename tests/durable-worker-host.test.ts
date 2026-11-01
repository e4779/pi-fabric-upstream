import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { durableExtensionLoadError } from "../src/durable/extension-load-error.js";
import { parseDurableWorkerOptions } from "../src/durable/worker-options.js";
import { createDurableSessionFile } from "../src/durable/worker-role-seed.js";
import { sweepFabricJournals } from "../src/durable/worker-host.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-host-"));
// Extensions outside `root` cannot reach the checkout's node_modules through an ancestor.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-outside-"));
const extension = path.resolve("tests/fixtures/durable-pi-extension.ts");
let entry: string;
beforeAll(async () => {
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  entry = path.join(root, "build", "worker.js");
  await build({ entryPoints: ["src/durable/worker.ts"], outdir: path.dirname(entry), bundle: true, packages: "external", platform: "node", format: "esm", splitting: true, target: "node24", logLevel: "silent" });
}, 30000);
afterAll(() => { for (const directory of [root, outside]) fs.rmSync(directory, { recursive: true, force: true }); });

async function worker(name: string, extra: string[] = [], environment: NodeJS.ProcessEnv = {}, discover = false, session = true, sessionFile?: string) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd, { recursive: true });
  const agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: environment.DURABLE_TEST_TRUST ?? "ask", compaction: { enabled: false }, retry: { enabled: false } }));
  const fixture = path.join(cwd, "fixture.txt"); if (!fs.existsSync(fixture)) fs.writeFileSync(fixture, "private fixture");
  const effect = path.join(cwd, "effect.txt");
  const child = spawn(process.execPath, [entry, "--mode", "rpc", "--durable-directory", path.join(cwd, "durable"), "--durable-run-id", name,
    ...(session ? ["--session", sessionFile ?? path.join(cwd, "session.jsonl")] : ["--no-session"]), ...(discover ? [] : ["--no-extensions"]), "-e", extension, "--model", "durable-offline/test", ...extra],
    { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, DURABLE_TEST_FAUX_MODULE: import.meta.resolve("@earendil-works/pi-ai/providers/faux"), DURABLE_TEST_FILE: fixture, DURABLE_TEST_EFFECT: effect, ...environment }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const messages: any[] = []; let pending = "", stderr = ""; const change = new Set<() => void>();
  child.stdout.on("data", chunk => {
    pending += chunk.toString();
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { messages.push(JSON.parse(line)); } catch { stderr += `\nNon-RPC output: ${line}`; }
    }
    for (const notify of change) notify();
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.on("exit", () => { for (const notify of change) notify(); });
  const send = (command: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const wait = (predicate: (message: any) => boolean, from = 0) => new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => done(new Error(`RPC timeout: ${stderr}\n${JSON.stringify(messages)}`)), 15000);
    const done = (error?: Error, value?: any) => { clearTimeout(timeout); change.delete(check); error ? reject(error) : resolve(value); };
    const check = () => {
      const found = messages.slice(from).find(predicate);
      if (found) done(undefined, found);
      else if (child.exitCode !== null || child.signalCode !== null) done(new Error(`Worker exited: ${stderr}\n${JSON.stringify(messages)}`));
    };
    change.add(check); check();
  });
  const stop = async (kill = false) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    if (kill) child.kill("SIGKILL"); else child.stdin.end();
    await exited;
  };
  send({ type: "get_state", id: "ready" });
  try { await wait(message => message.type === "response" && message.id === "ready" && message.success); }
  catch (error) { await stop(true); throw error; }
  return { child, messages, send, wait, stop, cwd, fixture, effect };
}

// Load the built Fabric extension next to the fixture, with a program that polls
// a gate file until the test opens it. A resume serves the recorded polls from the
// journal, then polls live.
const fabricWorker = (name: string, code: string) => {
  const agentDir = path.join(root, name, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({ fullCodeMode: true, mesh: { enabled: false }, mcp: { enabled: false } }));
  const inherited = Object.fromEntries(["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID", "PI_FABRIC_WRITE_POLICY", "PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_SCOPE", "PI_FABRIC_LINEAGE", "PI_FABRIC_PARENT_RUN", "PI_FABRIC_ACTOR_ID"].map(key => [key, undefined]));
  // Loading an extension is not authority to call it. These journal probes need
  // an exact fabric_exec grant as well as the core tools their programs use.
  return worker(name, ["--tools", "read,write,bash,fabric_exec", "-e", path.resolve("dist/index.js")], { ...inherited, PI_OFFLINE: "1", DURABLE_TEST_FABRIC_CODE: code });
};
const holdOnGate = (gate: string) => `let gate = await pi.read({ path: ${JSON.stringify(gate)} });\nif (gate.includes("hold")) await tools.progress({ message: "holding" });\nwhile (gate.includes("hold")) { await new Promise(resolve => setTimeout(resolve, 50)); gate = await pi.read({ path: ${JSON.stringify(gate)} }); }\nreturn gate.includes("open") ? "gate-open" : "gate-closed";`;

const answer = (messages: any[]) => messages.filter(event => event.type === "message_end" && event.message?.role === "assistant")
  .flatMap(event => event.message.content).filter(part => part.type === "text").map(part => part.text).join("\n");

describe("durable native RPC worker", () => {
  it("deletes fabric_exec journals a day after their last write and leaves everything else", async () => {
    const directory = path.join(root, "journal-sweep"); fs.mkdirSync(directory, { recursive: true });
    const stale = path.join(directory, `${"a".repeat(32)}.jsonl`);
    const fresh = path.join(directory, `${"b".repeat(32)}.jsonl`);
    const other = path.join(directory, "notes.jsonl");
    for (const file of [stale, fresh, other]) fs.writeFileSync(file, "x\n");
    const now = Date.now();
    const old = new Date(now - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old); fs.utimesSync(other, old, old);
    await sweepFabricJournals(directory, now);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    await expect(sweepFabricJournals(path.join(root, "journal-missing"), now)).resolves.toBeUndefined();
  });

  it("parses the internal protocol, appends both prompts, and rejects unknown or missing options", () => {
    const args = ["--durable-directory", "state", "--durable-run-id", "run", "--append-system-prompt", "instructions", "--append-system-prompt", "schema", "--tools", "read,bash"];
    expect(parseDurableWorkerOptions(args).appendSystemPrompt).toBe("instructions\n\nschema");
    expect(parseDurableWorkerOptions(args).tools).toEqual(["read", "bash"]);
    expect(parseDurableWorkerOptions([...args, "--exclude-tools", "fabric_exec"]).excludeTools).toEqual(["fabric_exec"]);
    expect(() => parseDurableWorkerOptions([])).toThrow("require");
    expect(() => parseDurableWorkerOptions([...args, "--unsafe"])).toThrow("Unsupported");
    expect(() => parseDurableWorkerOptions([...args, "--model"])).toThrow("Missing");
    expect(() => parseDurableWorkerOptions([...args, "--no-tools"])).toThrow("mutually exclusive");
  });

  it("names the typebox alias cause and workaround only for alias-rewritten typebox paths", () => {
    const aliased = [{ path: "/x/ext.ts", error: "Failed to load extension: Cannot find module '/app/node_modules/typebox/build/index.mjs/does-not-exist'\nRequire stack:\n- /x/ext.ts" }];
    const aliasMessage = durableExtensionLoadError(aliased).message;
    expect(aliasMessage.startsWith(`Durable worker extension loading failed: ${JSON.stringify(aliased)}`)).toBe(true);
    expect(aliasMessage).toMatch(/typebox[\s\S]*"typebox" root[\s\S]*runner "pi"/);
    const missing = [{ path: "/x/ext.ts", error: "Failed to load extension: Cannot find module 'left-pad'\nRequire stack:\n- /x/ext.ts" }];
    expect(durableExtensionLoadError(missing).message).toBe(`Durable worker extension loading failed: ${JSON.stringify(missing)}`);
  });

  it("runs real SDK tools, exports history, and reopens completed work without repeating it", async () => {
    const first = await worker("read", ["--tools", "read"]);
    try {
      first.send({ type: "prompt", id: "request-1", message: "read fixture" });
      await first.wait(event => event.type === "agent_settled");
      expect(answer(first.messages)).toContain("private fixture");
      expect(first.messages.some(event => event.type === "tool_execution_end")).toBe(true);
      expect(fs.readFileSync(path.join(first.cwd, "session.jsonl"), "utf8")).toContain("private fixture");
    } finally { await first.stop(); }
    const reopened = await worker("read", ["--tools", "read"]);
    try {
      reopened.send({ type: "prompt", id: "request-1", message: "read fixture" });
      await reopened.wait(event => event.type === "agent_settled");
      expect(reopened.messages.filter(event => event.type === "tool_execution_start")).toHaveLength(0);
    } finally { await reopened.stop(); }
  }, 40000);

  it("retains native wildcard exclusion across new, switch and reopened durable sessions", async () => {
    const name = "authority-replay";
    const probeFile = path.join(root, name, "active.jsonl");
    const args = ["--tools", "*", "--exclude-tools", "fabric_exec", "-e", path.resolve("tests/fixtures/authority-pi-extension.ts"), "--model", "authority-offline/test"];
    const environment = { AUTHORITY_PROBE_FILE: probeFile };
    const host = await worker(name, args, environment);
    const command = async (id: string, args: Record<string, unknown>) => {
      host.send({ ...args, id });
      const response = await host.wait(event => event.type === "response" && event.id === id);
      expect(response).toMatchObject({ success: true });
      return response;
    };
    const prompt = async (id: string) => {
      const start = host.messages.length;
      host.send({ type: "prompt", id, message: "report" });
      await host.wait(event => event.type === "agent_settled", start);
    };
    const snapshots = () => fs.readFileSync(probeFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    let beforeReopen = 0;
    try {
      await prompt("first");
      const initial = await command("initial", { type: "get_state" });
      const initialCount = snapshots().length;
      await command("new", { type: "new_session" });
      await prompt("second");
      const newCount = snapshots().length;
      expect(newCount).toBeGreaterThan(initialCount);
      await command("switch", { type: "switch_session", sessionPath: initial.data.sessionFile });
      beforeReopen = snapshots().length;
      expect(beforeReopen).toBeGreaterThan(newCount);
    } finally { await host.stop(); }
    const reopened = await worker(name, args, environment);
    try {
      expect(snapshots().length).toBeGreaterThan(beforeReopen);
      for (const tools of snapshots()) {
        expect(tools).toContain("read");
        expect(tools).not.toContain("fabric_exec");
      }
    } finally { await reopened.stop(); }
  }, 30000);

  it("keeps native image input, model selection, and distinct later prompts", async () => {
    const host = await worker("images", ["--no-tools"]);
    try {
      host.send({ type: "set_thinking_level", id: "thinking", level: "off" });
      expect(await host.wait(event => event.type === "response" && event.id === "thinking")).toMatchObject({ success: true });
      host.send({ type: "prompt", id: "first", message: "inspect", images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" }] });
      await host.wait(event => event.type === "agent_settled");
      expect(answer(host.messages)).toContain('"images":1');
      const boundary = host.messages.length;
      host.send({ type: "prompt", id: "second", message: "next" });
      await host.wait(event => event.type === "agent_settled", boundary);
      expect(answer(host.messages.slice(boundary))).toContain('"reply":"next"');
      host.send({ type: "get_state", id: "selected" });
      expect(await host.wait(event => event.id === "selected")).toMatchObject({ success: true, data: { model: { provider: "durable-offline", id: "test" }, thinkingLevel: "off" } });
    } finally { await host.stop(); }
  }, 30000);

  it("does not execute project extensions before headless trust, but honors explicit global trust", async () => {
    const cwd = path.join(root, "trust");
    const extensions = path.join(cwd, ".pi", "extensions");
    fs.mkdirSync(extensions, { recursive: true });
    const marker = path.join(cwd, "project-loaded");
    fs.writeFileSync(path.join(extensions, "probe.ts"), `import fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify(marker)}, "loaded"); }`);
    const denied = await worker("trust", ["--no-tools"], {}, true);
    try { expect(fs.existsSync(marker)).toBe(false); } finally { await denied.stop(); }
    const trusted = await worker("trust", ["--no-tools"], { DURABLE_TEST_TRUST: "always" }, true);
    try { expect(fs.readFileSync(marker, "utf8")).toBe("loaded"); } finally { await trusted.stop(); }
  }, 30000);

  it("accepts the first new prompt on a revisited session instead of deduplicating it", async () => {
    const host = await worker("switching", ["--no-tools"]);
    const prompt = async (text: string) => {
      const start = host.messages.length;
      host.send({ type: "prompt", id: text, message: text });
      await host.wait(event => event.type === "agent_settled", start);
      expect(answer(host.messages.slice(start))).toContain(JSON.stringify(text));
    };
    const command = async (id: string, args: Record<string, unknown>) => {
      host.send({ ...args, id });
      const response = await host.wait(event => event.type === "response" && event.id === id);
      expect(response, JSON.stringify(response)).toMatchObject({ success: true });
      return response;
    };
    try {
      await prompt("initial A");
      const initial = await command("state-a", { type: "get_state" });
      await command("new-b", { type: "new_session" });
      await prompt("initial B");
      const second = await command("state-b", { type: "get_state" });
      await command("switch-a", { type: "switch_session", sessionPath: initial.data.sessionFile });
      await prompt("later A");
      await command("switch-b", { type: "switch_session", sessionPath: second.data.sessionFile });
      await prompt("later B");
    } finally { await host.stop(); }
  }, 45000);

  it("preserves real write confinement through the SDK tool_call hook", async () => {
    const guard = path.resolve("src/agents/write-guard.ts");
    const host = await worker("guard", ["--tools", "write", "-e", guard], {
      PI_FABRIC_WRITE_POLICY: JSON.stringify({ readOnly: true, writableRoots: [], shell: "deny" }),
    });
    try {
      host.send({ type: "prompt", id: "guard", message: "write fixture" });
      await host.wait(event => event.type === "agent_settled");
      expect(fs.readFileSync(host.fixture, "utf8")).toBe("private fixture");
      expect(answer(host.messages)).toMatch(/denied|read.only|confine/i);
    } finally { await host.stop(); }
  }, 30000);

  it("does not rerun an uncertain unsafe tool after confirmed process death", async () => {
    const first = await worker("crash", ["--tools", "hold_effect"]);
    try {
      first.send({ type: "prompt", id: "crash", message: "hold effect" });
      await first.wait(event => event.type === "tool_execution_start");
      await expect.poll(() => fs.existsSync(first.effect), { timeout: 5000 }).toBe(true);
    } finally { await first.stop(true); }
    const resumed = await worker("crash", ["--tools", "hold_effect"]);
    try {
      resumed.send({ type: "prompt", id: "crash", message: "hold effect" });
      await resumed.wait(event => event.type === "agent_settled");
      expect(fs.readFileSync(resumed.effect, "utf8")).toBe("effect\n");
      expect(resumed.messages.some(event => JSON.stringify(event).match(/unsafe|interrupted|replay|failed/i))).toBe(true);
    } finally { await resumed.stop(); }
  }, 40000);

  it("opens a freshly created durable-session file as a valid Pi session and appends to it after a relaunch", async () => {
    const cwd = path.join(root, "role-seed"); const runDirectory = path.join(cwd, "run");
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const file = createDurableSessionFile(runDirectory, cwd); // header and worker-role entry arrive together
    const lines = () => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const policy = (entries: any[]) => entries.filter(entry => entry.type === "custom" && entry.customType === "context-aware.policy.v1");
    const onDisk = lines();
    expect(onDisk.map(entry => entry.type)).toEqual(["session", "custom"]);
    expect(onDisk[1].parentId).toBe(null);
    const first = await worker("role-seed", ["--no-tools"], {}, false, true, file);
    try {
      first.send({ type: "prompt", id: "role", message: "remember" });
      await first.wait(event => event.type === "agent_settled");
      first.send({ type: "get_state", id: "state" });
      expect(await first.wait(event => event.id === "state")).toMatchObject({ success: true, data: { sessionFile: file } });
    } finally { await first.stop(true); }
    const afterTurn = lines();
    expect(afterTurn.slice(0, 2)).toEqual(onDisk); // Pi kept the header and entry, and appended after them.
    expect(afterTurn.filter(entry => entry.type === "session")).toHaveLength(1);
    expect(afterTurn.some(entry => entry.type === "message" && entry.message.role === "assistant")).toBe(true);
    expect(policy(afterTurn)).toHaveLength(1);
    // Real Pi opened the file, appended its turn after the policy, and the policy is on the branch from the new leaf.
    expect(afterTurn.slice(2).every(entry => entry.parentId !== null)).toBe(true);
    expect(afterTurn[2].parentId).toBe(onDisk[1].id);
    expect(fs.readFileSync(file, "utf8")).toBe(afterTurn.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const resumed = await worker("role-seed", ["--no-tools"], {}, false, true, file);
    try {
      resumed.send({ type: "get_state", id: "state" });
      expect(await resumed.wait(event => event.id === "state")).toMatchObject({ success: true, data: { sessionFile: file } });
    } finally { await resumed.stop(); }
    expect(lines()).toEqual(afterTurn); // reopening neither truncates nor adds a second entry
    expect(policy(lines())).toHaveLength(1);
  }, 45000);

  it.each([
    { session: true, restored: "1" },
    { session: false, restored: "0" },
  ])("restores extension session entries after process death only from a session file: %o", async ({ session, restored }) => {
    const name = session ? "entries-file" : "entries-memory";
    const report = path.join(root, `${name}.txt`);
    const counts = () => fs.existsSync(report) ? fs.readFileSync(report, "utf8").trim().split("\n") : [];
    const first = await worker(name, ["--no-tools"], { DURABLE_TEST_ENTRIES: report }, false, session);
    try {
      first.send({ type: "prompt", id: "entries", message: "remember" });
      await first.wait(event => event.type === "agent_settled");
    } finally { await first.stop(true); }
    const resumed = await worker(name, ["--no-tools"], { DURABLE_TEST_ENTRIES: report }, false, session);
    try {
      await expect.poll(counts, { timeout: 5000 }).toEqual(["0", restored]);
    } finally { await resumed.stop(); }
  }, 40000);
  // The pinned SDK's jiti aliases "typebox" (and "@sinclair/typebox") to one file and treats an
  // alias as a path prefix, so "typebox/type" reaches resolution as "<entry>/type".
  // Keep the extension outside `root` so only the SDK's alias, not an ancestor node_modules, can resolve typebox.
  const typeboxProbe = (name: string, source: (marker: string) => string) => {
    const directory = path.join(outside, name); fs.mkdirSync(directory, { recursive: true });
    const marker = path.join(directory, "typebox-loaded.json");
    const file = path.join(directory, "typebox-probe.ts");
    fs.writeFileSync(file, source(marker));
    expect(() => createRequire(file).resolve("typebox")).toThrow();
    return { file, marker };
  };

  it("loads extensions that import exported typebox subpaths through the SDK alias", async () => {
    const probe = typeboxProbe("typebox-subpath", marker => `import fs from "node:fs";
import { Object as TObject, String as TString } from "typebox/type";
import { Number as SNumber } from "@sinclair/typebox/type";
export default function () {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(TObject({ name: TString(), size: SNumber() })));
}
`);
    const host = await worker("typebox-subpath", ["--no-tools", "-e", probe.file]);
    try {
      expect(JSON.parse(fs.readFileSync(probe.marker, "utf8"))).toMatchObject({
        type: "object", properties: { name: { type: "string" }, size: { type: "number" } },
      });
    } finally { await host.stop(); }
  }, 30000);

  it("keeps unexported typebox subpaths fatal and names the cause and workaround", async () => {
    const probe = typeboxProbe("typebox-unexported", marker => `import fs from "node:fs";
import * as missing from "typebox/does-not-exist";
export default function () { fs.writeFileSync(${JSON.stringify(marker)}, String(Object.keys(missing).length)); }
`);
    await expect(worker("typebox-unexported", ["--no-tools", "-e", probe.file])).rejects.toThrow(
      /Durable worker extension loading failed[\s\S]*index\.mjs\/does-not-exist[\s\S]*"typebox" root[\s\S]*runner "pi"/,
    );
    expect(fs.existsSync(probe.marker)).toBe(false);
  }, 30000);
  it("resumes an interrupted read-only fabric_exec after confirmed process death", async () => {
    const gate = path.join(root, "fabric-read", "gate.txt");
    const first = await fabricWorker("fabric-read", holdOnGate(gate));
    try {
      fs.writeFileSync(gate, "hold\n");
      first.send({ type: "prompt", id: "read", message: "fabric fixture" });
      // Progress follows the durable accept, so the kill lands after it.
      await first.wait(event => event.type === "tool_execution_update" && JSON.stringify(event).includes("holding"));
    } finally { await first.stop(true); }
    fs.writeFileSync(gate, "open\n");
    const resumed = await fabricWorker("fabric-read", holdOnGate(gate));
    try {
      resumed.send({ type: "prompt", id: "read", message: "fabric fixture" });
      await resumed.wait(event => event.type === "agent_settled");
      expect(answer(resumed.messages)).toContain("gate-open");
      expect(answer(resumed.messages)).not.toMatch(/interrupted/i);
    } finally { await resumed.stop(); }
  }, 60000);

  it("resumes an interrupted fabric_exec from its journal without repeating a finished effect", async () => {
    const gate = path.join(root, "fabric-effect", "gate.txt");
    const effect = path.join(root, "fabric-effect", "effect.txt");
    const code = `await pi.write({ path: ${JSON.stringify(effect)}, content: "effect\\n" });\n${holdOnGate(gate)}`;
    const first = await fabricWorker("fabric-effect", code);
    try {
      fs.writeFileSync(gate, "hold\n");
      first.send({ type: "prompt", id: "effect", message: "fabric fixture" });
      await first.wait(event => event.type === "tool_execution_update" && JSON.stringify(event).includes("holding"));
    } finally { await first.stop(true); }
    fs.writeFileSync(gate, "open\n");
    const resumed = await fabricWorker("fabric-effect", code);
    try {
      resumed.send({ type: "prompt", id: "effect", message: "fabric fixture" });
      await resumed.wait(event => event.type === "agent_settled");
      expect(fs.readFileSync(effect, "utf8")).toBe("effect\n");
      expect(answer(resumed.messages)).toContain("gate-open");
      expect(answer(resumed.messages)).not.toMatch(/interrupted/i);
    } finally { await resumed.stop(); }
  }, 60000);

  it("stops at an effect the crash interrupted and never repeats it", async () => {
    const effect = path.join(root, "fabric-uncertain", "effect.txt");
    // A Node script records its effect, then hangs until the kill lands mid-call.
    // It avoids shell syntax that differs between POSIX shells and Windows.
    fs.mkdirSync(path.dirname(effect), { recursive: true });
    const hang = path.join(path.dirname(effect), "hang.mjs");
    const pidFile = path.join(path.dirname(effect), "hang.pid");
    // The kill reaches the worker only, so the command it started outlives it. The script
    // records its pid for the cleanup below, and ends by itself when the bash timeout would.
    fs.writeFileSync(hang, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nfs.appendFileSync(${JSON.stringify(effect)}, "effect\\n");\nsetTimeout(() => {}, 120000);\n`);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const stopHang = async () => {
      if (!fs.existsSync(pidFile)) return;
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      // pi.bash starts its shell in a new process group on POSIX. On Linux, end that whole group.
      const stat = process.platform === "linux" ? fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") : undefined;
      const group = stat ? Number(stat[2]) : 0;
      if (group > 1 && group !== process.pid) { try { process.kill(-group, "SIGKILL"); } catch {} }
      try { process.kill(pid, "SIGKILL"); } catch {}
      await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    };
    try {
      const code = `await pi.bash({ cmd: ${JSON.stringify(`"${process.execPath}" "${hang}"`)}, timeout: 120 });\nreturn "program-done";`;
      const first = await fabricWorker("fabric-uncertain", code);
      try {
        first.send({ type: "prompt", id: "uncertain", message: "fabric fixture" });
        await expect.poll(() => fs.existsSync(effect), { timeout: 15000 }).toBe(true);
      } finally { await first.stop(true); }
      // The SIGKILL ends the worker but not the command it was running.
      expect(alive(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
      const resumed = await fabricWorker("fabric-uncertain", code);
      try {
        resumed.send({ type: "prompt", id: "uncertain", message: "fabric fixture" });
        // The worker has an RPC UI, so it asks first. A dismissed question keeps the stop,
        // as when a parent cancels a child's dialog.
        const question = await resumed.wait(event => event.type === "extension_ui_request" && event.method === "select");
        expect(question.title).toContain("Run it again?");
        expect(question.options).toEqual(["Run it again", "Stop here"]);
        resumed.send({ type: "extension_ui_response", id: question.id, cancelled: true });
        await resumed.wait(event => event.type === "agent_settled");
        expect(fs.readFileSync(effect, "utf8")).toBe("effect\n");
        expect(answer(resumed.messages)).toContain("fabric_exec was interrupted during this call, which may have run:");
        expect(answer(resumed.messages)).not.toContain("program-done");
      } finally { await resumed.stop(); }
    } finally { await stopHang(); }
  }, 60000);
});
