import { describe, expect, it } from "vitest";
import { searchNativeTools, type NativeToolEntry } from "../src/native-tool-catalog.js";

const entry = (overrides: Partial<NativeToolEntry>): NativeToolEntry => ({
  name: "unrelated", rawName: "unrelated", ref: "extensions.unrelated", description: "", searchDescription: "", declaration: "", inputSchema: {}, ...overrides,
});
const target = entry({ name: "mcp__browser__inspect", rawName: "mcp__browser__inspect", ref: "mcp.browser.inspect", namespace: { name: "browser-tools" }, searchDescription: "Read a page " + "content ".repeat(200) });
const decoy = entry({ searchDescription: "inspect mcp browser inspect mcp browser inspect" , namespace: { name: "other" } });

describe("exact native tool search", () => {
  it.each([target.name, target.ref, "inspect"])("prefers trimmed exact %s over misleading descriptions", query => {
    expect(searchNativeTools([decoy, target], `  ${query}  `)).toEqual([target]);
  });
  it("matches raw names separately from sanitized names", () => {
    const raw = entry({ name: "raw_tool", rawName: "raw-tool" });
    expect(searchNativeTools([decoy, raw], "raw-tool")).toEqual([raw]);
  });
  it("filters namespaces before exact matching and falls back to BM25 within the namespace", () => {
    expect(searchNativeTools([decoy, target], "inspect", 8, "other")).toEqual([decoy]);
    expect(searchNativeTools([decoy, target], "inspect", 8, "browser-tools")).toEqual([target]);
    expect(searchNativeTools([decoy, target], "inspect", 8, "browser_tools")).toEqual([target]);
    expect(searchNativeTools([decoy, target], "inspect", 8, "missing")).toEqual([]);
  });
  it("returns only exact matches in stable order, respecting the limit", () => {
    const second = entry({ name: "inspect", rawName: "inspect" });
    expect(searchNativeTools([decoy, target, second], "inspect")).toEqual([target, second]);
    expect(searchNativeTools([decoy, target, second], "inspect", 1)).toEqual([target]);
  });
});
