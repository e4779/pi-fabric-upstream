# Typed tool-result details: the shared render card

A tool result carries its own presentation. Fill the result's `details` with
one versioned object and the host renders a full card for it through the
normal `renderResult` pipeline: semantic status tones, a theme-blended
background, a collapsed output preview with an expand hint. Any registered
tool can adopt this; the host owns the drawing, so the tool encodes no ANSI
and reads no theme.

## The schema (v1)

Fill a tool result's `details` with one discriminated object:

```ts
import type { FabricToolResultCardV1 } from "pi-fabric/protocol";

const details: FabricToolResultCardV1 = {
  schemaVersion: 1,
  kind: "error",            // ok | error | timeout | blocked | backgrounded
  cmd: "cargo test",        //   | sh | img | bg
  exitCode: 101,
  ms: 45_000,
  tail: ["test suite failed", "3 passed; 12 failed"],
  totalLines: 120,
};
```

Common optional fields: `title`, `cmd`, `ms`, `logPath`, `tail`, `output`,
`totalLines`. Per kind:

| kind           | required     | carries                                        |
| -------------- | ------------ | ---------------------------------------------- |
| `ok`           |              | `exitCode` (conventionally 0), output preview  |
| `error`        |              | `exitCode` (number or null), one-line `error`, `aborted` |
| `timeout`      |              | `exitCode` observed at the kill                |
| `blocked`      | `reason`     | refusal text (pre-exec gate, policy veto)      |
| `backgrounded` | `taskId`     | `logPath`, `pid`, output seen before the detach |
| `sh`           | `cmd`        | `exit`, `ms`, `timedOut`, `tail`, `out`, `totalLines`, `title` |
| `img`          | `paths`      | delivered image paths                          |
| `bg`           | `id`, `cmd`, `logPath` | `pid`                                |

The `sh`, `img`, and `bg` kinds keep the field names their payloads already
use (`exit`, `out`, `id`, `paths`), so adopting the schema means adding
`schemaVersion: 1` and nothing else.

## Producer shapes

The v1 union covers every producer shape that exists today:

- A shell-tool result cast (`ShellResult { ok, exitCode, output, timedOut,
  aborted, backgrounded?, taskId?, logPath?, pid? }`) maps field-for-field:
  `timedOut` becomes the `timeout` kind, `backgrounded` becomes the
  `backgrounded` kind with `taskId`, `logPath`, and `pid` carried, an
  `aborted` stop becomes `error` with `aborted: true`, and everything else
  maps by `ok`.
- A blocked ad-hoc result (`{ ok: false, blocked: true, exitCode: null,
  output: <refusal text>, timedOut: false, aborted: false }`) becomes the
  `blocked` kind with `reason` carrying the refusal text.
- The prose kinds map onto their same-named union members, listed above.

The background facade stays outside the contract by decision:
`notifyCompletion` is untyped input, carries `{ exitCode }` only, and its
payload is an untyped terminal tail string. A completion never manufactures a
card kind.

## Reading

The reader (`readFabricToolResultCardV1`, exported from `pi-fabric/protocol`)
is strict: a missing or newer `schemaVersion`, an unknown `kind`, or any
malformed field yields `undefined`. The contract refuses payloads it does not
understand; fields are never guessed.

`readFabricToolResultCardContractV1` classifies a `details` payload for the
renderer and for telemetry: `legacy` payloads (no `schemaVersion`) claim no
contract; a claimed contract reads as a card or as a refusal with a
field-level reason (`schemaVersion 2`, `kind "deploy"`, `malformed field`).

## Rendering

The host registers a tool renderer resolver that gives every tool without its
own `renderResult` one that reads the schema. Reserved surfaces (pi core
tools, `fabric_exec`, `mcp__*`) keep their renderers. The card draws:

- an optional accent `title`,
- the first command line (dim `❯` prefix, bold text, `… +N lines` marker for
  multi-line commands),
- a collapsed preview of the output tail with a `… +N lines · ctrl-o to
  expand` hint, or the full bounded body when expanded,
- the outcome line last: `✓ exit 0`, `✗ exit 1`, `⏹ stopped`, `⏱ timeout`,
  `⊘ blocked`, `● background <taskId>`, `● img <paths>`, `● bg <id>`.

Colors come only from theme keys, and the card's background is the tone's
theme foreground blended into its theme background (`success` into
`toolSuccessBg`, `error` into `toolErrorBg`, `warning`/`accent` into
`customMessageBg`) through the shared `blendThemeBackground` layer that diff
previews also use. Tools never parse ANSI or guess the terminal theme.

A `bg` card stays a collapsed handle (command line, log path, job id) and
shows its full command body on expand. An `img` card renders one dim path
line.

Every refused card contract and every legacy fallback emits one telemetry
line per tool call on the `pi-fabric:render:card:v1` event:
`{ version: 1, tool, outcome: "refused" | "fallback", reason?, toolCallId }`.
A refusal also warns on the console, because a refused contract is a producer
bug; a plain legacy fallback (details without a `schemaVersion`) is normal
text rendering and stays on the event only.

## Opting out

Two switches hand the next resolver back untouched, so tools keep their
native rendering:

- config key `ui.toolResultCards` (default `true`) under the `ui` section,
- environment variable `PI_FABRIC_TOOL_RESULT_CARDS=off`, checked per
  resolve, so an operator can flip it for one session.
