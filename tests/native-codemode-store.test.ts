import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeCodemodeProvider } from "../src/native-codemode.js";

function fixture(original: string | null = "root") {
  let leaf = original;
  let session = "session";
  let branch: any[] = original === null ? [] : [{ id: original, type: "message" }];
  const controller = new AbortController();
  const context = { signal: controller.signal, sessionManager: {
    getLeafId: () => leaf, getSessionId: () => session, getBranch: () => branch,
  } } as unknown as ExtensionContext;
  const provider = new NativeCodemodeProvider();
  const append = vi.fn();
  provider.setPersistence(append);
  return { provider, context, append, controller,
    session: () => { session = "other"; },
    navigate: () => { branch = []; leaf = null; },
    add: (entry: Record<string, unknown>) => { leaf = `entry-${branch.length}`; branch.push({ ...entry, id: leaf }); },
    stage: async (id: string, nativeStore: boolean) => {
      const tx = provider.begin(id, context, nativeStore);
      await provider.invoke("store", { values: { saved: true } }, { extensionContext: context, parentToolCallId: id } as any);
      return tx;
    },
  };
}

describe.each([false, true])("script store native writer=%s", nativeStore => {
  it.each(["root", null])("commits across multiple custom receipts from %s", async original => {
    const f = fixture(original);
    const tx = await f.stage("a", nativeStore);
    f.add({ type: "custom", customType: "execution-receipt" });
    f.add({ type: "custom", customType: "audit-receipt" });
    expect(tx.finish(true)).toEqual([]);
    expect(f.append).toHaveBeenCalledExactlyOnceWith(
      nativeStore ? "codemode-store" : "fabric-codemode-store",
      nativeStore ? { set: { saved: true }, delete: [] } : { values: { saved: true } },
    );
  });
  it.each(["root", null])("commits without advancement from %s", async original => {
    const f = fixture(original);
    (await f.stage("a", nativeStore)).finish(true);
    expect(f.append).toHaveBeenCalledTimes(1);
  });
  it.each(["message", "compaction", "fabric-codemode-store", "codemode-store"])("rejects %s even followed by a receipt", async kind => {
    const f = fixture();
    const tx = await f.stage("a", nativeStore);
    f.add(kind.endsWith("store") ? { type: "custom", customType: kind } : { type: kind });
    f.add({ type: "custom", customType: "execution-receipt" });
    expect(() => tx.finish(true)).toThrow(/stale/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it.each(["session", "generation", "abort", "navigation"])("rejects %s changes despite a receipt", async kind => {
    const f = fixture();
    const tx = await f.stage("a", nativeStore);
    if (kind === "session") f.session();
    if (kind === "generation") f.provider.invalidate();
    if (kind === "abort") f.controller.abort();
    if (kind === "navigation") f.navigate();
    f.add({ type: "custom", customType: "execution-receipt" });
    expect(() => tx.finish(true)).toThrow(/stale/);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("does not commit a failed execution after receipts", async () => {
    const f = fixture();
    const tx = await f.stage("a", nativeStore);
    f.add({ type: "custom", customType: "execution-receipt" });
    tx.finish(false);
    expect(f.append).not.toHaveBeenCalled();
  });
  it.each([false, true])("rejects a concurrent writer native=%s", async otherNative => {
    const f = fixture();
    const tx = await f.stage("a", nativeStore);
    const other = await f.stage("b", otherNative);
    f.provider.setPersistence((customType, data) => {
      f.append(customType, data);
      f.add({ type: "custom", customType, data });
    });
    other.finish(true);
    f.add({ type: "custom", customType: "execution-receipt" });
    expect(() => tx.finish(true)).toThrow(/stale/);
    expect(f.append).toHaveBeenCalledTimes(1);
  });
});
