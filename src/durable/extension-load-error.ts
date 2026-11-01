/** One extension load failure as reported by the SDK resource loader. */
export interface DurableExtensionLoadFailure { path: string; error: string }

// The pinned worker SDK aliases "typebox" to its single entry file, and jiti treats an
// alias as a path prefix, so a subpath import fails as "<.../typebox/...>.mjs/<subpath>".
const TYPEBOX_ALIAS_FAILURE = /Cannot find module '[^']*[\\/]typebox[\\/][^']*\.[cm]?js[\\/][^']+'/;

/** Build the fatal durable worker error, naming the typebox alias cause when it applies. */
export function durableExtensionLoadError(errors: readonly DurableExtensionLoadFailure[]): Error {
  const message = `Durable worker extension loading failed: ${JSON.stringify(errors)}`;
  if (!errors.some(failure => TYPEBOX_ALIAS_FAILURE.test(failure.error))) return new Error(message);
  return new Error(`${message}\nAn extension imported a typebox subpath that the durable worker cannot resolve, because the worker SDK aliases "typebox" to a single file; import from the "typebox" root instead, or use runner "pi".`);
}
