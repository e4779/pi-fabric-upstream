import { describe, expect, it } from "vitest";
import {
  FABRIC_REPEAT_BLOCK,
  FabricRepeatGuard,
  fabricRepeatBlockText,
  fabricRepeatWarnText,
} from "../src/repeat-guard.js";

describe("FabricRepeatGuard", () => {
  it("counts consecutive identical code and trips warn then block", () => {
    const g = new FabricRepeatGuard(3, 6);
    // The 2026-09-15 incident repeated code while display names changed.
    // Display metadata is not an input to the guard; keep one threshold trace.
    const code = "return 1";
    for (let count = 1; count <= 7; count += 1) {
      expect(g.observe(code)).toEqual({ count, blocked: count >= 6, warn: count >= 3 });
    }
  });

  it("resets on any differing code", () => {
    const g = new FabricRepeatGuard(3, 6);
    const code = "return 1";
    for (let i = 0; i < 5; i += 1) g.observe(code);
    expect(g.observe(code).blocked).toBe(true);
    expect(g.observe("return 2")).toEqual({ count: 1, blocked: false, warn: false });
  });

  it("does not count the same wrapper code as a loop when the payloads differ", () => {
    // A short wrapper whose payload is the real work.
    const g = new FabricRepeatGuard(3, 6);
    const wrapper = "const r = await pi.bash({ cmd: π.cmd, settle: true }); return r.output;";
    for (let i = 1; i <= 12; i += 1) {
      expect(g.observe(wrapper, { cmd: `echo step-${i}` })).toEqual({ count: 1, blocked: false, warn: false });
    }
  });

  it("still blocks identical code with identical payloads", () => {
    const g = new FabricRepeatGuard(3, 6);
    const wrapper = "const r = await pi.bash({ cmd: π.cmd }); return r.output;";
    let verdict = { count: 0, blocked: false, warn: false };
    for (let i = 1; i <= 6; i += 1) verdict = g.observe(wrapper, { cmd: "echo noop" });
    expect(verdict).toEqual({ count: 6, blocked: true, warn: true });
  });

  it("treats payload key order as cosmetic: reordered keys still loop", () => {
    const g = new FabricRepeatGuard(3, 6);
    const code = "return [π.a, π.b];";
    let verdict = { count: 0, blocked: false, warn: false };
    for (let i = 1; i <= 6; i += 1) {
      verdict = g.observe(code, i % 2 === 0 ? { a: "1", b: "2" } : { b: "2", a: "1" });
    }
    expect(verdict.count).toBe(6);
    expect(verdict.blocked).toBe(true);
  });

  it("treats absent, undefined and empty payloads as the same call", () => {
    const g = new FabricRepeatGuard(3, 6);
    g.observe("return 1");
    g.observe("return 1", undefined);
    expect(g.observe("return 1", {}).count).toBe(3);
  });

  it("cannot be confused by payload boundaries that concatenate alike", () => {
    // {a:"bc"} and {ab:"c"} share every character; they are different calls.
    const g = new FabricRepeatGuard(3, 6);
    g.observe("return 1", { a: "bc" });
    expect(g.observe("return 1", { ab: "c" }).count).toBe(1);
    g.observe("return 1", { k: "x", l: "y" });
    expect(g.observe("return 1", { k: "x\u0000l", l: "y" }).count).toBe(1);
  });

  it("resets the count when a payload value changes mid-run", () => {
    const g = new FabricRepeatGuard(3, 6);
    for (let i = 0; i < 5; i += 1) g.observe("return π.x", { x: "same" });
    expect(g.observe("return π.x", { x: "other" })).toEqual({ count: 1, blocked: false, warn: false });
  });

  it("formats the warn and block copy the tool surfaces to the model", () => {
    expect(fabricRepeatWarnText(3, FABRIC_REPEAT_BLOCK)).toContain("at 6 identical runs will be blocked");
    expect(fabricRepeatBlockText(6)).toContain("executed 6 times in a row and was blocked");
  });
});
