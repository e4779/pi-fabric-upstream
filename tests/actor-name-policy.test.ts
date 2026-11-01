import { describe, expect, it } from "vitest";
import { actorNameDecision } from "../src/actors/name-policy.js";

describe("actor name decision", () => {
  it.each([
    [false, false, "available"],
    [true, false, "active"],
    [false, true, "stopped"],
    [true, true, "active"],
  ] as const)("decides active=%s stopped=%s", (active, stopped, expected) => {
    expect(actorNameDecision(active, stopped)).toBe(expected);
  });
});
