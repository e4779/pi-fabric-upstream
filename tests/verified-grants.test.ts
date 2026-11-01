import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeMeshGrant } from "../src/verified/grants.js";
import { meshGrantTake } from "../src/verified/generated/grants.js";
import { createMeshGrant, postWithMeshGrant } from "../src/mesh/grants.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity: MeshIdentity = { id: "grant-proof", name: "grant-proof", kind: "agent" };

describe("compiled mesh grant bridge", () => {
  it("preserves unequal numeric fields, optional scope positions and complete string identities", () => {
    const grant = Object.freeze({ expiresAt: 107, uses: 3, topic: "topic\0😀\ud800", kind: "kind\0\udfff" });
    const request = { authenticated: true, now: 101 };
    expect(takeMeshGrant(grant, request)).toEqual({ plan: "Consume", uses: 2, topic: grant.topic, kind: grant.kind });
    expect(takeMeshGrant(grant, { ...request, topic: grant.topic, kind: grant.kind })).toMatchObject({ plan: "Consume" });
    expect(takeMeshGrant(grant, { ...request, topic: grant.topic + "!" }).plan).toBe("Topic");
    expect(takeMeshGrant(grant, { ...request, kind: grant.kind + "!" }).plan).toBe("Kind");
    expect(takeMeshGrant({ expiresAt: 107, uses: 3, topic: "same" }, request).kind).toBe("external");
    expect(takeMeshGrant({ expiresAt: 107, uses: 3, topic: "same" }, { ...request, kind: "same" }).kind).toBe("same");
    expect(takeMeshGrant(grant, { ...request, now: 107 }).plan).toBe("Expired");
    expect(takeMeshGrant(undefined, request).plan).toBe("Invalid");
    expect(grant.uses).toBe(3);
  });

  it("preserves legacy negative-state refusals and refuses nonrepresentable observations", () => {
    const grant = { expiresAt: 107, uses: -2, topic: "topic" };
    expect(takeMeshGrant(grant, { authenticated: true, now: 101 })).toMatchObject({ plan: "Exhausted", uses: -2 });
    expect(takeMeshGrant({ ...grant, expiresAt: -1 }, { authenticated: true, now: 0 }).plan).toBe("Expired");
    expect(takeMeshGrant(grant, { authenticated: false, now: 101 }).plan).toBe("Invalid");
    for (const uses of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => takeMeshGrant({ ...grant, uses }, { authenticated: true, now: 101 })).toThrow(RangeError);
    }
  });

  it("runs the compiled decision inside the real lock so concurrent posts cannot reuse the last use", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-grant-proof-")); roots.push(root);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const now = 100_000;
    const { token } = await createMeshGrant(mesh, { topic: "inbox", ttlMs: 60_000, uses: 1, createdBy: identity }, now);
    const step = vi.spyOn(meshGrantTake, "step");
    const results = await Promise.allSettled([postWithMeshGrant(mesh, { token }, now), postWithMeshGrant(mesh, { token }, now)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(mesh.read({ topic: "inbox" })).toHaveLength(1);
    expect(step).toHaveBeenCalledTimes(2);
    const file = path.join(mesh.root, "grants.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.grants[0].uses).toBe(0);
    stored.grants[0].uses = -2; fs.writeFileSync(file, JSON.stringify(stored));
    await expect(postWithMeshGrant(mesh, { token }, now)).rejects.toThrow("no uses left");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).grants[0].uses).toBe(-2);
  });
});
