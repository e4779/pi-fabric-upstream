# Fabric in a pi-durable host

`pi-fabric/durable-extension` gives a host that runs its own pi-durable `Harness` the `fabric_exec` tool, without a Pi session.
It is one pi-durable `Extension`: a tool and its prompt section. There is no `ExtensionAPI`, no built-in file or shell tools, no Pi UI, no compaction, prewalk or topology.

Use it when your host already owns the agent loop (its own registry, tools, tenant scope and storage) and you want models to batch tool calls in one TypeScript program. For a whole Pi session over durable storage, use [`pi-fabric/durable-host`](durable-pi.md) instead.

## Install

It needs `@earendil-works/pi-durable`, `@earendil-works/pi-codemode` and `@earendil-works/chord` **1.4.0 or later** as peers. pi-durable already depends on pi-codemode; the section uses its declaration renderer.

```ts
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { createFabricExtension } from "pi-fabric/durable-extension";

const registry = createRegistry();
registry.install(hostTools);          // your own tools, hooks, tenant guard
registry.install(createFabricExtension({
  tools: ["search_knowledge", "read_ticket"], // optional: narrow what programs may call
  onError: (error, { conversationId, callId }) => log.error({ conversationId, callId, error }),
}));
const harness = await Harness.open(storage, { models, registry }, ctx);
```

A program the model sends looks like this:

```ts
const [ticket, related] = await Promise.all([
  tools.read_ticket({ id: "T-12" }),
  tools.search_knowledge({ query: "login loop" }),
]);
return { title: ticket.title, related: related.slice(0, 3) };
```

## Options

Every option is optional. `FABRIC_DURABLE_DEFAULTS` exports the defaults.

| Option | Default | What it does |
| --- | --- | --- |
| `name` | `"pi-fabric"` | Extension name. pi-durable reports section errors under it. |
| `toolName` | `"fabric_exec"` | The tool's name. |
| `tools` | every callable tool | Names of host tools programs may call. It only narrows the conversation's `Agent.callable`; it never widens it. `[]` grants none. |
| `providers` | none | Fabric providers granted to programs, as `{ [name]: { description?, actions: { [action]: (args, { api, context }) => value } } }`. |
| `timeoutMs` | `30000` | Deadline for the whole program, nested calls included. |
| `memoryLimitBytes` | `67108864` (64 MiB) | QuickJS heap limit. |
| `maxLogChars` | `20000` | `print()` and `console.*` output kept per program; the rest is cut with a notice. |
| `maxResultChars` | `40000` | Characters of the whole result the model sees; the rest is cut with a notice. |
| `maxArgumentBytes` | `262144` | Largest JSON argument object (UTF-8 bytes) for one nested tool call or provider action. A larger one is refused before the tool runs. |
| `sectionTokenBudget` | `3000` | Token budget (4 characters a token) for the tool declarations in the prompt section. |
| `quickJsWasmModule` | the bundled wasm | A precompiled `WebAssembly.Module` of `@jitl/quickjs-singlefile-mjs-release-sync`, for hosts that cannot compile wasm from bytes (Cloudflare Workers). Ignored when `runtime` is set. |
| `runtime` | in-process QuickJS | Kernel override, for example a sandbox in another isolate. |
| `onError` | none | `(error, { conversationId, callId }) => void`. Receives internal failures (see below). |

An invalid limit (zero, negative, not an integer) or provider name throws when you call `createFabricExtension`.

### What a program can use

- `tools.<name>(args)`: the host tool's result. A tool with `structuredOutputSchema` returns its structured output; any other tool returns its text. A failed call rejects with the tool's own error text.
- `searchTools(query, limit?)` and `describeTool(name)`: find and read tools the section does not list.
- `<provider>.<action>(args)` and `fabric.tools.call({ ref: "<provider>.<action>", args })` for granted providers.
- `print()` and `console.*`; payloads the model passes as `π.<key>`; `setTimeout` (at most 64 pending timers, dropped when the program ends).

The result is the program's return value, after its log lines. A failed program is a tool error that names the nested calls already made; they are not undone.

## Prompt section

The `fabric` section declares the tools a program may call with pi-codemode's renderer (`renderDeclarations` from `@earendil-works/pi-codemode/declarations`), so a host that also runs codemode shows both in one format. Tools are chosen cheapest first within `sectionTokenBudget` and shown in the conversation's order. Each granted provider is declared as its own namespace (`declare const notes: { add(args): Promise<unknown> }`), and the providers line gives each provider's description once. A tool whose name is not an identifier is declared under codemode's identifier (`look-up` becomes `look_up`); a program can call it by either name, and `describeTool` accepts either. Deferred tools (`deferred: true`) stay callable but are not listed, as in pi-durable's codemode. When a tool is left out for either reason, the section says so and points to `searchTools()`.

## Security model

Read each rule as what a hostile program or a careless host must not be able to cause.

- **Default deny.** A program reaches only the conversation's callable tools (`Agent.callable`), narrowed by `tools`, never `fabric_exec` itself. Every Fabric namespace (`pi.*`, `agents.*`, `memory.*`, `mcp.*`, `jev.*`, `mesh.*`, models) is refused unless you grant it as a provider. An unknown action, or a name inherited from `Object.prototype`, is refused too.
- **Hooks see every call.** Each nested call goes through `ToolExecutionApi.executeTool`, so your `ToolTask` hooks (a tenant guard, an audit) see it as a nested call and can refuse it. The tool's tenant comes from the turn's scope, never from program arguments.
- **Plain JSON across the boundary.** Arguments are copied to plain JSON within `maxArgumentBytes` before a tool or action sees them, and an action's result is copied back. No prototype, getter or cycle crosses.
- **No host capabilities.** The program has no file, process, network, module loading or host object (`require`, `process`, `fetch`, `import()`, `WebAssembly`, the host bridge). Each program gets a fresh QuickJS context, so no global, prototype or module state crosses conversations or tenants in one process.
- **No secrets in results.** Program errors show no host paths. A provider action's error reaches the program as `Fabric action <ref> failed` unless the action throws `FabricDurableRefusal`, whose message the program sees. Any other host error (storage, a bug) reaches it as `Fabric host call failed`. The real error goes to `onError`.

### Errors and `onError`

`fabric_exec` never throws to the Harness. When the kernel fails to load or the extension hits a bug, the model gets one fixed tool error, `fabric_exec failed with an internal error. The program may not have run.`, and `onError` gets the error with the conversation and call IDs. It gets no program source or arguments. An `onError` that throws is ignored. A section render error reaches the Harness's `onReport` as `extension_error` under the extension's name. pi-durable gives a tool no report channel of its own; that is why `onError` exists.

## Durability

`fabric_exec` is declared `replay: "safe"`. Each run keeps a journal in a pi-durable task document: a header (journal format, engine, a digest of the program, its payloads and settings, a random seed, the start time) and every tool or provider result in the order the program received it. Each result is saved before the program sees it.

- **Restart mid-program.** pi-durable runs `fabric_exec` again with the same arguments. The program reruns from the top with the recorded seed and clock, so `Math.random()`, `Date` and timers give the same values. Recorded calls return their saved results without running again. A nested tool that was still running is reattached by its call number, so it finishes once.
- **Effects.** A provider action counts as an effect unless it is granted with `repeatable: true`. An intent is saved before an effect runs. If a restart cuts off an effect, or a nested tool reports it was interrupted after it may have run, the program stops there and does not run it again. The model reads:

  ```text
  fabric_exec was interrupted during this call, which may have run:
    notes.add({"text":"paid"})
  2 earlier tool calls finished before the interruption and were replayed from the journal without running again.
  The program stopped here and this call was not repeated. Check whether it took effect, or ask the user, before running it or the rest of the program again.
  ```

  A repeatable action that was cut off simply runs again.
- **Refusals.** A resume is refused, and nothing runs, when the program, its payloads or its settings changed, when the engine changed (`FABRIC_DURABLE_ENGINE` names the journal format, this package's version and the QuickJS build, so any upgrade counts), when the journal is damaged, or when the rerun asks for a different call than the one recorded. The model gets `fabric_exec could not resume after an interruption: <reason>.`
- **Cancel.** Cancelling the turn aborts the in-flight nested call and the program. No later call in the program runs.
- **Fork and compaction.** A forked or compacted conversation still offers `fabric_exec` and its section, rendered for that conversation.

## Cloudflare Workers

The entry's import graph holds no `node:` module and no Pi package (`bun run build` checks this). It runs in a Worker without `nodejs_compat`. A Worker cannot compile wasm from bytes at run time, so you must pass `quickJsWasmModule`:

1. In your build (Node or Bun), write the wasm to a file. `@jitl/quickjs-singlefile-mjs-release-sync` inlines it in JavaScript, so the package exports a helper that returns the installed bytes:

   ```ts
   import { writeFile } from "node:fs/promises";
   import { quickJsWasmBytes } from "pi-fabric/durable-extension/wasm";

   await writeFile("src/quickjs.wasm", await quickJsWasmBytes());
   ```

   Rerun it whenever you update pi-fabric, so the wasm matches the installed glue code.
2. Ship the file as a `CompiledWasm` module (`import quickjsWasm from "./quickjs.wasm"` with a wasm module rule in wrangler). Do not import `pi-fabric/durable-extension/wasm` in the Worker itself.
3. Pass it: `createFabricExtension({ quickJsWasmModule: quickjsWasm })`.
4. Bundle with Node built-ins external. The kernel's lazy TypeScript transpile references them on paths a Worker never takes.

Without the module, every call returns the fixed internal error and `onError` receives `Wasm code generation disallowed by embedder`. The bundle is about 12 MB raw (2.1 MB gzip), mostly the TypeScript compiler, plus 0.5 MB of wasm.
