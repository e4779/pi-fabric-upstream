import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { validationMessage } from "../src/core/action-arguments.js";

vi.mock("typebox/value", async importOriginal => {
  const actual = await importOriginal<typeof import("typebox/value")>();
  return { ...actual, Value: { ...actual.Value, Errors: vi.fn(actual.Value.Errors) } };
});

const schema = { type: "object", properties: { target: { type: "object", properties: { css: { type: "string" } }, required: ["css"] } }, required: ["target"] };

describe("validation error paths", () => {
  it("reports the real TypeBox nested /target/css failure", () => {
    expect(validationMessage(schema, { target: { css: 42 } })).toMatch(/^\/target\/css: /);
    expect(validationMessage(schema, { target: { css: "main" } })).toBeUndefined();
  });
  it.each([
    [{ instancePath: "/target/css", path: "/legacy" }, "/target/css: invalid"],
    [{ path: "/target/css" }, "/target/css: invalid"],
    [{ instancePath: null, path: "/target/css" }, "/target/css: invalid"],
    [{ instancePath: "", path: "/legacy" }, "invalid"],
  ])("prefers instancePath with a nullish legacy fallback: %j", (location, expected) => {
    const spy = vi.spyOn(Value, "Errors").mockReturnValue([{ ...location, message: "invalid" }] as any);
    try {
      expect(validationMessage(schema, { target: { css: 42 } })).toBe(expected);
    } finally { spy.mockRestore(); }
  });
});
