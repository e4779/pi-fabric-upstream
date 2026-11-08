# Typed tool-result details: the shared render card

A tool's result presentation belongs to the host's `renderResult` pipeline.
Custom message channels, transcript surgery and hand-rolled ANSI keep a tool
working only as long as nobody replaces it. This contract gives every
registered tool the host's card quality through one versioned details schema.

## The schema (v1)

Fill a tool result's `details` with one discriminated object:

```ts
import type { FabricToolResultCardV1 } from "pi-fabric/protocol";

const details: FabricToolResultCardV1 = {
  schemaVersion: 1,
  kind: "error",            // ok | error | timeout | blocked | backgrounded
  cmd: "cargo test",
  exitCode: 101,
  ms: 45_000,
  tail: ["test suite failed", "3 passed; 12 failed"],
  totalLines: 120,
};
```

Common optional fields: `title`, `cmd`, `ms`, `logPath`, `tail`, `output`,
`totalLines`. Per kind:

| kind          | required     | carries                                             |
| ------------- | ------------ | --------------------------------------------------- |
| `ok`          |              | `exitCode` (conventionally 0), output preview        |
| `error`       |              | `exitCode` (number or null), one-line `error`        |
| `timeout`     |              | `exitCode` observed at the kill                     |
| `blocked`     | `reason`     | refusal text (pre-exec gate, policy veto)            |
| `backgrounded`| `taskId`     | `logPath`, `pid`, output seen before the detach      |

The reader (`readFabricToolResultCardV1`, exported from `pi-fabric/protocol`)
is strict: a missing or newer `schemaVersion`, an unknown `kind`, or any
malformed field yields `undefined`. The contract refuses payloads it does not
understand; there are no legacy fallbacks that silently guess fields away.

## Rendering

The host registers a tool renderer resolver that gives every tool without its
own `renderResult` one that reads the schema. Reserved surfaces (pi core
tools, `fabric_exec`, `mcp__*`) keep their renderers. The card draws:

- an optional accent `title`,
- the first command line (dim `❯` prefix, bold text, `… +N lines` marker for
  multi-line commands),
- a collapsed preview of the output tail with a `… +N lines · ctrl-o to
  expand` hint, or the full bounded body when expanded,
- the outcome line last: `✓ exit 0`, `✗ exit 1`, `⏱ timeout`, `⊘ blocked`,
  `● background <taskId>`.

Colors come only from theme keys, and the card's background is the tone's
theme foreground blended into its theme background (`success` into
`toolSuccessBg`, `error` into `toolErrorBg`, `warning`/`accent` into
`customMessageBg`) through the shared `blendThemeBackground` layer that diff
previews also use. Tools never parse ANSI or guess the terminal theme.

Details that carry no card fall back to the native text preview, so a tool
adopts the card by adding one schema-bearing `details` object and nothing else.
