# External surface: Fabric as an engine

`"surface": "external"` turns Fabric into an engine behind somebody else's
tool surface. No model tool of ours is registered - `fabric_exec` is withdrawn
the canonical way (re-registered with `exposure: "hidden"`; never through a
`setActiveTools` snapshot, which freezes and poisons the active set into the
session file - seen live), capture stays inert, and the engine answers through
three equal doors instead:

1. `globalThis[Symbol.for("pi-fabric.external.v1")]` - in-process consumers;
2. a per-process unix socket (0600, `~/.pi/agent/sock/fabric-<pid>.sock`)
   speaking a line protocol - any process on the machine;
3. `process.env.FABRIC_SOCK`, set in the host process and inherited by every
   child that passes the environment through - zero integration.

## Line protocol

One command per connection: the client sends each argv element as one line,
then half-closes; the server replies `OK` or `ERR <first line>` followed by
payload lines, then closes. Text only, friendly to `rg` pipes by design.

The server socket is `allowHalfOpen: true`: replies may be computed
asynchronously, and with the default false bun (and node's auto-FIN window)
can close the writable side before a microtask reply lands - seen live as
empty replies for async dispatch while sync dispatch worked.

`bin/fab` (POSIX sh + `nc -N -U`; override the client via `FAB_NETCAT` for
netcat variants without `-N`) is the reference client. It is staged into
`dist/bin/fab` and linked as the package's `fab` bin.

## Commands

Builtins: `ping`, `status`, `help` (help lists whatever else is wired).
The wired set is composed first-claim-wins (`composeCommands`):

- `agent` - bounded workers over the host's own SDK (`loadHostSdk`; full-control
  children: empty resource loader so host extensions never load twice,
  in-memory sessions, compaction off). Blocking form takes `key=value` lines
  (`promptFile=`, `tools=`, `cwd=`, `model=`, `timeoutMs=`, `json=on`); the
  job subcommands - `submit/status/wait/result/stop/steer/follow/list` - run
  detached workers with mid-run steering (`textFile=` payloads). The reply's
  first line is the run/job `id=`.
- `recall` - ranked session-memory search (`query=` required; `scope=`,
  `queryMode=`, `queryMatch=`, `branches=`, `pageSize=`, `offset=`, `role=`).
- `vcc` - session file views: `summary` / `branch` / `entries [n]` /
  `entry <id>`; active branch by the session manager's leaf, or the newest
  childless leaf when reading standalone.

## Startup budget

The startup static graph is hard-capped (files and bytes, enforced at build).
Everything engine-heavy behind a command - the recall index/search stack, the
agents' JSON salvage - is a stable lazy entry in `scripts/build.mjs` and loads
on first use, not at activation.

## Verification

`tests/external-*.test.ts` cover the parsers, renderers, the job state machine
(injected session fakes), and the socket protocol end-to-end through a real
unix socket. The reference consumer is the shell-lab `ai` wrapper
(recall/agent/llm/vcc with automatic socket-vs-standalone tier selection).

## Published extension APIs (2026-11-09)

Beside the three doors above, the engine now publishes typed services on
`pi.events` (extension-reachable from any loaded extension):

- Shell policy facade: `pi-fabric:shell-policy:gate|post|config:v1` - the
  pre-exec gate and output budget as one policy (see docs/configuration.md,
  executor.shellPolicy; kill switch PI_FABRIC_SHELL_GATE).
- Background job service: registerJob/unregister/subscribe/notifyCompletion -
  the host JobStore with typed wake events carrying stopReason (see
  docs/background-tasks.md).
- Tool-result card contract: a versioned details union any tool can adopt;
  the renderer refuses (never guesses) and emits
  `pi-fabric:render:card:v1` telemetry on every refusal/fallback (see
  docs/tool-result-card.md; opt-out: ui.toolResultCards /
  PI_FABRIC_TOOL_RESULT_CARDS=off).
