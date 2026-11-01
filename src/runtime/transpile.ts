import ts from "typescript";

// Guest transpilation without the type checker's compiler host: no node:path or
// file system, so the QuickJS kernel loads in a Cloudflare Worker too.

/** Guest programs execute inside this wrapper; user code starts on wrapped line 2. */
export const wrapFabricGuestCode = (code: string): string =>
  `async function __piFabricMain() {\n${code}\n}\n`;

export interface FabricTranspileResult {
  code: string;
  sourceMap?: string;
}

export const transpileFabricCodeWithSourceMap = (code: string): FabricTranspileResult => {
  const result = ts.transpileModule(wrapFabricGuestCode(code), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
  });
  return {
    code: result.outputText,
    ...(result.sourceMapText ? { sourceMap: result.sourceMapText } : {}),
  };
};
