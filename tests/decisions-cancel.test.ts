import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runDecisionsCli } from "../src/cli/decisions.js";
import { openFabricDecisions } from "../src/decisions/command.js";
import { answerFabricDecisionRequest } from "../src/decisions/events.js";
import { requestHeadlessApproval } from "../src/decisions/host.js";
import { DecisionStore } from "../src/decisions/store.js";
import { MeshStore } from "../src/mesh/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decisions-cancel-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 500);
  const store = new DecisionStore(mesh, { id: "session:main", name: "main", kind: "main", sessionId: "main" });
  return { root, mesh, store };
};

const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  let stderr = "";
  const code = await runDecisionsCli(argv, {
    stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    env,
  });
  return { code, stdout, stderr };
};

describe("pi-fabric decisions cancel", () => {
  it("cancels an open text decision with via cli and the OS user", async () => {
    const { root, store } = fixture();
    const orphan = await store.raise({ title: "Why?" });
    const cancelled = await run(["cancel", "--root", root, orphan.id, "--json"]);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.stdout)).toMatchObject({
      id: orphan.id,
      status: "cancelled",
      answer: { via: "cli", answeredBy: os.userInfo().username },
    });
    expect(await store.get(orphan.id)).toMatchObject({ status: "cancelled" });
    expect((await run(["list", "--root", root])).stdout).toBe("No decisions\n");
  });

  it("prints the cancelled record as a line and reads the root from the environment", async () => {
    const { root, store } = fixture();
    const orphan = await store.raise({ title: "Pick" , options: [{ id: "a", label: "A" }] });
    const cancelled = await run(["cancel", orphan.id], { PI_FABRIC_MESH_ROOT: root });
    expect(cancelled.code).toBe(0);
    expect(cancelled.stdout).toContain(`${orphan.id}  cancelled`);
  });

  it("fails with the store error and exit 1 when the decision is not open", async () => {
    const { root, store } = fixture();
    const orphan = await store.raise({ title: "Why?" });
    expect((await run(["cancel", "--root", root, orphan.id])).code).toBe(0);
    const again = await run(["cancel", "--root", root, orphan.id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/cancelled, not open/);

    const answered = await store.raise({ title: "Done?" });
    await store.answer(answered.id, { text: "yes" }, { answeredBy: "x", via: "test" });
    const late = await run(["cancel", "--root", root, answered.id]);
    expect(late.code).toBe(1);
    expect(late.stderr).toMatch(/answered, not open/);
    expect(await store.get(answered.id)).toMatchObject({ status: "answered" });
  });

  it("settles every kind of waiter as cancelled", async () => {
    const { root, store } = fixture();
    const text = await store.raise({ title: "Why?" });
    const waited = store.wait(text.id, { pollMs: 10 });
    expect((await run(["cancel", "--root", root, text.id])).code).toBe(0);
    expect(await waited).toMatchObject({ id: text.id, status: "cancelled" });

    const approval = requestHeadlessApproval(store, { ref: "pi.bash", risk: "execute", description: "run" });
    const pending = await vi.waitFor(async () => {
      const [open] = await store.list({ status: "open" });
      if (!open) throw new Error("approval not raised yet");
      return open;
    });
    expect((await run(["cancel", "--root", root, pending.id])).code).toBe(0);
    expect(await approval).toBe(false);

    const asked = new Promise((respond) => {
      void answerFabricDecisionRequest({
        version: 1,
        context: {} as ExtensionContext,
        question: { title: "Name?" },
        claim: () => true,
        respond,
        onRaised: (id) => { void run(["cancel", "--root", root, id]); },
      }, async () => ({ store }));
    });
    expect(await asked).toMatchObject({ ok: true, status: "cancelled" });
  });

  it("returns a usage error without exactly one id", async () => {
    const { root } = fixture();
    expect((await run(["cancel", "--root", root])).code).toBe(2);
    expect((await run(["cancel", "--root", root, "dec_abcdefgh12", "dec_abcdefgh13"])).code).toBe(2);
    expect((await run(["cancel", "--root", root, "dec_abcdefgh12", "--text", "x"])).code).toBe(2);
    expect((await run(["help"])).stdout).toContain("decisions cancel");
  });
});

describe("/fabric decisions cancel for text and editor decisions", () => {
  it.each(["input", "editor"] as const)("cancels a %s decision without answering it", async (kind) => {
    const { mesh, store } = fixture();
    const orphan = await store.raise({ title: "Why?", ...(kind === "editor" ? { input: "editor" as const } : {}) });
    const select = vi.fn(async (_title: string, labels: string[]) => labels.find((label) => /cancel/i.test(label)));
    const input = vi.fn();
    const editor = vi.fn();
    const notify = vi.fn();
    await openFabricDecisions(mesh, { hasUI: true, ui: { select, input, editor, notify } } as unknown as ExtensionContext, orphan.id);
    expect(input).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
    expect(await store.get(orphan.id)).toMatchObject({ status: "cancelled", answer: { via: "tui" } });
    expect((await store.get(orphan.id))?.answer?.text).toBeUndefined();
  });

  it("keeps an empty answer distinct from a cancel", async () => {
    const { mesh, store } = fixture();
    const orphan = await store.raise({ title: "Why?" });
    const select = vi.fn(async (_title: string, labels: string[]) => labels.find((label) => !/cancel/i.test(label)));
    const input = vi.fn(async () => "");
    await openFabricDecisions(mesh, { hasUI: true, ui: { select, input, notify: vi.fn() } } as unknown as ExtensionContext, orphan.id);
    expect(input).toHaveBeenCalledOnce();
    expect(await store.get(orphan.id)).toMatchObject({ status: "answered", answer: { text: "", via: "tui" } });
  });

  it("leaves the decision open when the person dismisses the action choice", async () => {
    const { mesh, store } = fixture();
    const orphan = await store.raise({ title: "Why?" });
    const select = vi.fn(async () => undefined);
    await openFabricDecisions(mesh, { hasUI: true, ui: { select, notify: vi.fn() } } as unknown as ExtensionContext, orphan.id);
    expect(await store.get(orphan.id)).toMatchObject({ status: "open" });
  });
});
