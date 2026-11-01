import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneTree, CowUnavailableError } from "../src/agents/cow-clone.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const sourceTree = (): { source: string; dest: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-cow-clone-"));
  roots.push(root);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "file.txt"), "content\n");
  return { source, dest: path.join(root, "dest") };
};

describe("cloneTree error classification", () => {
  it.each(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "ENOTTY"])(
    "reports %s as copy-on-write unavailable",
    async (code) => {
      const { source, dest } = sourceTree();
      vi.spyOn(fs.promises, "cp").mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(cloneTree(source, dest)).rejects.toBeInstanceOf(CowUnavailableError);
    },
  );

  it("excludes a nested destination through an alias without excluding siblings", async () => {
    const { source } = sourceTree();
    const alias = path.join(path.dirname(source), "alias");
    fs.symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
    const dest = path.join(alias, "nested", "worktree");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "nested", "sibling.txt"), "sibling");
    const cp = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, "cp").mockImplementation((from, to, options) => cp(from, to, { ...options, mode: 0 }));
    await cloneTree(source, dest);
    expect(fs.readFileSync(path.join(dest, "nested", "sibling.txt"), "utf8")).toBe("sibling");
    expect(fs.existsSync(path.join(dest, "nested", "worktree"))).toBe(false);
  });

  it("rejects cloning into the same directory through an alias", async () => {
    const { source } = sourceTree();
    const alias = path.join(path.dirname(source), "alias");
    fs.symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(cloneTree(source, alias)).rejects.toThrow("into itself");
  });

  it.each(["EACCES", "EINVAL", "ERR_FS_CP_EINVAL"])("passes %s copy errors through unchanged", async (code) => {
    const { source, dest } = sourceTree();
    const failure = Object.assign(new Error(code), { code });
    vi.spyOn(fs.promises, "cp").mockRejectedValue(failure);
    await expect(cloneTree(source, dest)).rejects.toBe(failure);
  });

  it("does not copy a destination that lies inside the source into itself", async () => {
    const { source } = sourceTree();
    const dest = path.join(source, "linked-wt");
    const copied: string[] = [];
    vi.spyOn(fs.promises, "cp").mockImplementation(async (from) => {
      copied.push(String(from));
    });
    await cloneTree(source, dest);
    expect(copied).toEqual([path.join(await fs.promises.realpath(source), "file.txt")]);
  });
});
