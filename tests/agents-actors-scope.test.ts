import { describe, expect, it } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

// #274: agents.actors({ scope: "global" }) type-checked as a zero-argument
// call and the guest binding dropped its arguments.
const code = `const [template] = await agents.actors({ scope: "global" });
const live: { id: string }[] = await agents.actors();
const project = await agents.actors({ scope: "project" });
return [template.name, template.createdAt, live.length, project.length];`;

describe("agents.actors scope", () => {
  it("type-checks the documented global template listing", () => {
    expect(typeCheckFabricCode(code, guestTypeDeclarations(true)).errors).toEqual([]);
    expect(typeCheckFabricCode(
      `return agents.actors({ scope: "everywhere" });`,
      guestTypeDeclarations(true),
    ).errors).not.toEqual([]);
  });

  for (const backend of ["quickjs", "node"] as const) {
    it(`forwards scope through the ${backend} guest binding`, async () => {
      const runtime = backend === "quickjs" ? new QuickJsRuntime() : new NodeProcessRuntime("node");
      const seen: unknown[] = [];
      const result = await runtime.execute(code.replace(/: \{ id: string \}\[\]/, ""), async (ref, args) => {
        expect(ref).toBe("agents.actors");
        seen.push(args);
        return args.scope === "global" ? [{ id: "g", name: "reviewer", createdAt: 1 }] : [];
      }, { timeoutMs: 10000, memoryLimitBytes: 64 * 1024 * 1024 });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(seen).toEqual([{ scope: "global" }, {}, { scope: "project" }]);
      expect(result.value).toEqual(["reviewer", 1, 0, 0]);
    });
  }
});
