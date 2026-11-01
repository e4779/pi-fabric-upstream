// Build-time helper for hosts that cannot compile wasm from bytes at run time (Cloudflare Workers).
// `@jitl/quickjs-singlefile-mjs-release-sync` inlines its wasm in JavaScript; a Worker needs it as a
// separate CompiledWasm module, passed to createFabricExtension({ quickJsWasmModule }).
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

const toBytes = (source: unknown): Uint8Array | undefined => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return undefined;
};

/**
 * The wasm bytes of the QuickJS build this package runs, read from the installed
 * `@jitl/quickjs-singlefile-mjs-release-sync`. Run it in your build (Node or Bun), write the
 * bytes to `quickjs.wasm`, and import that file as a CompiledWasm module in the Worker. The bytes
 * always match the installed glue code, because they come from the same package.
 */
export async function quickJsWasmBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const original = WebAssembly.instantiate;
  let captured: Uint8Array<ArrayBuffer> | undefined;
  const capture = ((source: unknown, imports?: WebAssembly.Imports) => {
    const bytes = toBytes(source);
    if (bytes && captured === undefined) captured = new Uint8Array(bytes);
    return (original as (source: unknown, imports?: WebAssembly.Imports) => Promise<unknown>)(source, imports);
  }) as typeof WebAssembly.instantiate;
  WebAssembly.instantiate = capture;
  try {
    await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  } finally {
    WebAssembly.instantiate = original;
  }
  if (!captured || !WASM_MAGIC.every((byte, index) => captured![index] === byte)) {
    throw new Error("Could not read the QuickJS wasm from @jitl/quickjs-singlefile-mjs-release-sync");
  }
  return captured;
}
