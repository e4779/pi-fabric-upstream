import { describe, expect, it } from "vitest";
import {
  createVccCommand,
  parseVccSession,
  renderVccBranch,
  renderVccEntries,
  renderVccEntry,
  renderVccSummary,
  vccActiveLeaf,
  vccBranchIds,
} from "../src/external/vcc.js";
import type { VccEntry } from "../src/external/vcc.js";

const fixture = [
  '{"type":"session","version":3,"id":"s-1","timestamp":"2026-11-07T10:00:00.000Z","cwd":"/work/lab"}',
  '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-07T10:00:01.000Z","message":{"role":"user","content":"start","timestamp":1}}',
  '{"type":"message","id":"b2","parentId":"a1","timestamp":"2026-11-07T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}],"timestamp":2}}',
  '{"type":"message","id":"c3","parentId":"b2","timestamp":"2026-11-07T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"shell","content":[{"type":"text","text":"exit 0"}],"isError":false,"timestamp":3}}',
  '{"type":"message","id":"d4","parentId":"c3","timestamp":"2026-11-07T10:00:04.000Z","message":{"role":"toolResult","toolCallId":"t2","toolName":"shell","content":[{"type":"text","text":"boom"}],"isError":true,"timestamp":4}}',
  '{"type":"compaction","id":"e5","parentId":"d4","timestamp":"2026-11-07T10:00:05.000Z","summary":"old stuff","firstKeptEntryId":"c3","tokensBefore":50000}',
  '{"type":"message","id":"f6","parentId":"e5","timestamp":"2026-11-07T10:00:06.000Z","message":{"role":"user","content":"after compaction","timestamp":6}}',
  '{"type":"message","id":"9a","parentId":"b2","timestamp":"2026-11-07T09:59:00.000Z","message":{"role":"user","content":"abandoned branch","timestamp":0}}',
].join("\n");

describe("vcc parsing and tree logic", () => {
  const session = parseVccSession(fixture);

  it("parses entries, skips the header, survives a torn tail line", () => {
    expect(session.header?.id).toBe("s-1");
    expect(session.entries).toHaveLength(7);
    const torn = parseVccSession(`${fixture}\n{"type":"mes`);
    expect(torn.entries).toHaveLength(7);
  });

  it("finds leaves and the active branch through compaction", () => {
    expect(vccActiveLeaf(session.entries)).toBe("f6");
    expect(vccBranchIds(session.entries, "f6")).toEqual(["a1", "b2", "c3", "d4", "e5", "f6"]);
  });

  it("renders an rg-friendly summary", () => {
    const lines = renderVccSummary(session, "f6", "/tmp/s.jsonl");
    expect(lines[0]).toContain("entries=7");
    expect(lines[0]).toContain("message:6");
    expect(lines[0]).toContain("compaction:1");
    expect(lines[0]).toContain("leaves=2");
    expect(lines[0]).toContain("branchLen=6");
    expect(lines[0]).toContain("file=/tmp/s.jsonl");
  });

  it("renders branch-scoped tails with roles, tools, and errors", () => {
    const lines = renderVccEntries(session, "f6", 3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^d4 p=c3 10:00:04 message role=toolResult tool=shell ERR/);
    expect(lines[1]).toMatch(/^e5 p=d4 10:00:05 compaction COMPACTED tokensBefore=50000/);
    expect(lines[2]).toContain("role=user after compaction");
    const abandoned = renderVccEntries(session, "9a", 5);
    expect(abandoned.some((line) => line.includes("abandoned branch"))).toBe(true);
    expect(abandoned.some((line) => line.includes("after compaction"))).toBe(false);
  });

  it("branch view lists ids root to leaf; entry view is lossless", () => {
    expect(renderVccBranch(session, "f6").map((line) => line.split(" ")[0])).toEqual([
      "a1", "b2", "c3", "d4", "e5", "f6",
    ]);
    const raw = renderVccEntry(session, "e5")?.[0];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw ?? "{}").summary).toBe("old stuff");
  });
});

describe("vcc bridge command", () => {
  const entries = parseVccSession(fixture).entries;
  const command = createVccCommand(() => ({
    file: () => "/tmp/live.jsonl",
    entries: (): readonly VccEntry[] => entries,
    leafId: () => "f6",
  }));

  it("serves summary, entries, branch, and entry views", async () => {
    expect((await command(["vcc"]))?.lines[0]).toContain("entries=7");
    expect((await command(["vcc", "entries", "2"]))?.lines).toHaveLength(2);
    expect((await command(["vcc", "branch"]))?.lines).toHaveLength(6);
    expect((await command(["vcc", "entry", "a1"]))?.ok).toBe(true);
  });

  it("refuses unknown views, bad counts, missing ids; undefined source fails soft", async () => {
    await expect(command(["vcc", "wat"])).rejects.toThrow(/unknown vcc view/);
    await expect(command(["vcc", "entries", "x"])).rejects.toThrow(/positive count/);
    expect((await command(["vcc", "entry", "nope"]))?.ok).toBe(false);
    const bare = createVccCommand(() => undefined);
    expect((await bare(["vcc"]))?.ok).toBe(false);
    expect(await command(["recall", "query=x"])).toBeUndefined();
  });
});
