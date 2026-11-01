# Durable Pi runner

`agents.runner` defaults to **`pi-durable`**: an isolated Pi SDK process with a real
`AgentSession`, native RPC, and a `DurableAgent` backed by the published durable
Harness. Pinned worker dependencies ship with Fabric; registration and idle hooks
do not load the worker or engines.
No manual setup is required. Main's outer Pi session is unchanged.

The subprocess owns a pinned SDK installed as `pi-fabric-worker-sdk` (an npm
alias), because Pi-managed installs deliberately omit host-provided peers.
Only the durable worker maps Pi imports to that SDK and its dependencies; the
extension continues to use Main's host modules. If a partial/older installation
reports a missing worker SDK, reinstall or update Fabric to restore its runtime
dependencies. Installing Pi peers manually is not required. When Bun launches
the parent worker, the durable SDK host runs through `node` on PATH and requires
Node.js 24+, matching Fabric's declared engine. This keeps module resolution
isolated without passing `NODE_PATH` to tools or borrowing Main's SDK.

Set `agents.runner: "pi"` (or `runner: "pi"` per request) for the previous Pi CLI
worker. Existing explicit configurations and stored actor runners are not
rewritten. Pi JSONL remains the history interchange format. Custom Pi CLI wrappers
and `PI_FABRIC_PI_BINARY` apply only to the explicit legacy `pi` runner; the
durable worker uses the SDK and inherited process environment directly.

## Full Pi/Fabric host

The default keeps native resource discovery, project trust, credentials/model
runtime, tools, extension hooks, images, virtual models, provider hooks, steering,
follow-ups, cancellation, and compaction. Fabric's existing process worker retains
model admission, schema validation, budgets, lineage, question routing, session
import/export, kernels, recursive Fabric, scopes, and write confinement. Actors
accept both Pi runners. Handoffs use the configured Pi runner; `rlm.query` defaults
to `pi-durable` and accepts an explicit `pi` override.

Unknown projects remain untrusted unless an existing policy or trusted bootstrap
extension grants trust. Extension-load errors fail closed; a permission guard is
never silently omitted.

## Recovery boundaries

Private per-run JSONL stores flush payloads and commit markers. An OS-held SQLite
exclusive transaction prevents concurrent writers, including directory aliases;
process death releases it without timeout-based stealing or lock-file deletion.
Reopening the same run uses its initial run ID for idempotent submission and
resumes checkpoints. Completed work is not repeated. An interrupted unsafe tool
fails closed, including writes and shell commands.

In the durable worker, an interrupted `fabric_exec` call can continue after a
crash. The leaf adapter below does not do this. The worker offers the call a
fence. Fabric accepts it only when every effect must cross the host bridge,
which holds for the QuickJS and Monty runtimes but not for CPython or the Node
and Bun processes. An effect is any call outside the read-only set: the tier
that speculation may run early (`pi.read`, `pi.grep`, `pi.find`, `pi.ls`, and
status and lookup actions such as `memory.recall` and `programs.get`), the
native store load, discovery, and progress reporting. A read approval that
would prompt or call the auto classifier is an effect, and so is semantic
search.

A QuickJS program writes a crash journal. Each tool result is recorded before
the program sees it, and results reach the program one at a time. Before an
effect runs, Fabric records an intent and syncs it to disk. On recovery the same
program runs again with the same clock and random seed. Recorded results are
served from the journal, so no provider, approval, or prompt runs again. Calls
after the last recorded result then run live.

A few served calls changed state that lived only in the worker process, so
Fabric redoes them from their recorded arguments, once each and in their
recorded order, before the program sees their result. `compact.request` and
`compact.cancel` are always redone. `prewalk.plan` is redone when the
restarted session's prewalk arm owes a plan, and skipped otherwise.
`compact.carry`, `thinking.set`, and `thinking.reset` are redone only when
the session entry they wrote did not survive, as with an explicit Pi runner
started with `--no-session`, so a surviving session never gets a second entry. A redo runs the
provider again under the current policy, without asking for approval again. If
a redo fails, the program stops, reports that call and its error, and runs
nothing after it. State, mesh, saved programs, and cache releases are already on
disk or safe to skip and are not redone. Schema hypotheses and certificates are
stored in the mesh and bound to the tool call, so a resumed `schema.commit`
still checks the recorded certificate: it is refused once the certificate has
expired or the workspace or state changed since verification. If a call has an intent but no
result, it may have taken effect. Fabric asks whether to run that call again
as a `select` dialog, and pauses the program deadline while it waits (a
`timeout_ms` hard deadline keeps running). Only "Run it again" repeats the
call. "Stop here", a dismissed question, a question left unanswered for 5
minutes, or more than one such call stops the program, which reports the call.
The dialog goes to the worker's RPC client. A parent agent cancels it by
default, so the program stops. With `agents.childQuestions: "route"`, a parent
session asks its person or raises a root-held decision. Fabric also
refuses to resume, and runs nothing, when the program or its settings changed, the runtime or a pinned engine version
changed, the program stops repeating its recorded calls, the journal is missing
or damaged, or a recorded result named work such as a child agent or background
task that does not survive a restart. A call resumes at most three times.

The journal holds the program's identity digest, its random seed and start
time, and for every host call its reference, an argument digest, and the full
result or error the program received. Each line carries a checksum and a hash
of the line before it, so a lost, reordered, or foreign line refuses the
resume. Lines lost from the very end cannot be detected this way; Fabric relies
on `fdatasync` to keep a synced intent. Tool output can include secrets, so the
journal is private to its owner (mode `0600`). The worker deletes it as soon as
the call's final result is committed to the durable store, whether the call
succeeded, failed, was stopped as interrupted, or was aborted. It is never
deleted before that commit. If the worker crashes between the commit and the
delete, a sweep at worker start deletes any journal a day after its last write.

Monty programs keep the earlier fence. Before the first effect, Fabric arms the
fence and the worker commits that mark. On recovery, an accepted fence that was
never armed reruns the program from the start. An armed fence, an unaccepted
one, or a second crash fails closed as before. A rerun can read different file
contents than the first attempt did. It also emits its progress and
`workflow.item` transitions again, with the same `invocationId` and item IDs,
so a listener that acts on them should deduplicate. A journal resume does the
same for the progress calls it serves.

A worker's store lives in its run directory under `durable/`. Recovery never
replays streaming updates, so each provider delta and tool progress update commits
only an ordered marker; the full partial message or partial result reaches
observers from memory after that commit. The journal grows with the transcript,
not with the square of each streamed message. Run retention removes `durable/`
with its run, and unknown or linked files inside it still preserve the run.

### Opt-in: a session file for pi-durable workers

By default a `pi-durable` child without a seeded session runs with
`--no-session`. Set `agents.durableWorkerSession: true` to have it keep a
private Pi session file at `durable-session/session.jsonl` in its run directory
(mode `0600`, folder `0700`). The journal restores messages only; the session
file restores what extensions saved in the session, such as custom entries,
context edits, and compaction, when a relaunched attempt reopens it. This
includes the relaunch described in [Opt-in: reattach after a resident host
restart](#opt-in-reattach-after-a-resident-host-restart): it reuses the run
directory, so the relaunched worker reopens the same session file. Without the
file, the redo rules above rebuild extension state from the journal, and only
some calls can be redone. With the option on, the manager also creates run
directories with mode `0700`. Explicit `pi` children keep `--no-session`
either way. Run retention removes `durable-session/` with its run; see
"Retention" below for what it accepts.

With the option off, nothing below applies: there is no session file, no
worker-role entry, and fork and handoff seeds are written as before.

### Worker role

With `agents.durableWorkerSession`, a `pi-durable` child's session carries a worker-role entry, so a context-aware
extension in the child knows it is a worker. The entry is one custom entry in the Pi
session file:

```json
{ "type": "custom", "customType": "context-aware.policy.v1",
  "data": { "schemaVersion": 1, "layer": "host", "declaredBy": "pi-fabric/durable-worker",
            "values": { "sessionRole": "worker" } } }
```

Delegation extensions write the same entry for their workers. Without it, such an
extension acts as a session with a user at a terminal: it can send a compaction seed as a new
user message, rewrite it with a model, add the cache listing, and compact in the
middle of a reply. Fabric does not import any such extension; without one
the entry is one unread line.

**Create complete, never edit.** Fabric writes the entry only into a session file
it creates, in the same write that creates the file. The worker never appends to,
rewrites, or parses an existing session file, so a file that exists already (a
relaunch, or a `sessionFile` the caller supplies) is used exactly as it is.

The entry is the **root** of the tree: the first entry after the header, with
`parentId: null`. Every entry Pi appends, and every branch a later navigation or
Pi fork reaches, then descends from it. That is why the entry does not depend on
which entry Pi treats as the leaf.

- **New `durable-session/session.jsonl`.** Line 1 is a Pi session header (version
  3), line 2 is the entry with `parentId: null`. The worker writes both to
  `tmp-<uuid>.jsonl` in the same folder (exclusive create, no link following,
  `0600`), syncs it, hard-links it to `session.jsonl` and unlinks the temp name.
  Exactly one of two concurrent attempts wins the link; the other keeps the
  winner's file. On relaunch an existing `session.jsonl` is reused untouched, and
  a leftover `tmp-<uuid>.jsonl` that is a second name of it is removed.
- **Fork and handoff seeds.** For a `pi-durable` child with the option on, the manager passes the seed
  writers (`writeForkSession`, `writeHandoffSession`) `{ workerRole: true }`.
  The file they return has the header, then the entry as the root, then the seed's
  entries unchanged except that the seed's former root has `parentId` set to the
  entry's id. The inherited messages are identical. A seed Pi's own
  `createBranchedSession` writes is rewritten once by the writer, before it
  returns the path and before any worker can open the file.
- **Plain `pi`, other runners, and the option off.** No option is passed. Seeds are byte for byte
  what the writers always produced, there is no entry, and a child with no seed
  keeps `--no-session`.
- **Caller-supplied `sessionFile`.** Never written. Such a child keeps whatever role
  that file already declares.
- **A later explicit declaration wins.** A context-aware extension replays policy entries in
  order and a later entry wins per path, so a later host policy that declares another
  `sessionRole` overrides the seeded one; Fabric does not fight it.

#### Threat model

A process running as the same user is trusted, because it can already write every
session file. Same-user races (swapping a folder for a symlink, adding a hard link
between a check and a write) are therefore out of scope. The worker guards against
other users and against accidental links:

- Before it creates anything, the worker `lstat`s the run directory. It must be a
  real directory (not a link) owned by the worker's user; otherwise the launch fails
  with a clear error before any write. If group or others can write it
  (`mode & 0o022`), the worker removes that write itself through a descriptor opened
  without following links and checked to be the same directory, then confirms the bit
  is gone. A run directory from an earlier Fabric or a test harness may have mode
  `0775`; with the option on, the manager creates run directories with mode `0700`. After the
  tightening no other user can add or swap entries in the run directory, and
  anything already there is refused by the owner and link checks on
  `durable-session/` and by `O_EXCL | O_NOFOLLOW` on the temp file.
- `durable-session/` is created without `recursive` (so the run directory must
  already exist), with mode `0700`; an existing one must be a real directory owned by
  the worker's user.
- The temp file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`.

#### Retention

Run retention accepts only `session.jsonl` and `tmp-<lowercase uuid v4>.jsonl` in
`durable-session/`, each a regular file owned by this user. A file with two names is
accepted only as the crash leftover between the worker's link and unlink: the folder
holds exactly `session.jsonl` and one `tmp-<uuid>.jsonl` that share a device and
inode. A link that leaves the run, an unknown name (including an uppercase or
all-zero uuid), a symlink, or another owner keeps the run.

Fabric does not read the `context-aware.worker-compaction.v1` advisories a worker
writes.

Durability **does not restore arbitrary JavaScript continuations**, promise
general exactly-once external effects, or restart failed workers indefinitely.
The standard process/actor lifecycle controls stop/retry/retention. A new run is
new work; native RPC command IDs are response correlations, not deduplication keys
for arbitrary later prompts. Do not resend acknowledged controls as new commands.
Interrupted request/turn extension callbacks may be re-entered; callbacks with
external effects need their own idempotency policy. Restoring committed message
history does not redeliver message hooks or charge usage again. Normal session
switches receive fresh request identities and do not replay old answers.
Old leaf-adapter locators/journals are not silently migrated into worker stores.

Worker retries retain the original prompt identity, so a completed journal can
restore its answer even if the parent died before saving completion. By
default, automatic reattachment after the owning Fabric/resident process
restarts covers hosted adapters, not this built-in worker; `agents.wait` on such
a run fails at once when its resident host is gone and settles the run failed
with outcome `indeterminate`. Recovery of completed conversations
with additional steering/follow-up user messages also remains incomplete: strict
transcript correlation fails closed to avoid attributing a stale answer.
Control acknowledgements do not provide an end-to-end exactly-once delivery
contract; do not blindly resubmit a command whose acknowledgement was lost.

## Opt-in: reattach after a resident host restart

Set `agents.durableWorkerRecovery: true` to let a resident host recover its
own unfinished `pi-durable` worker runs. It applies only to runs launched with
`residency: "durable"`, runner `pi-durable`, and the `process` transport, on
POSIX. Each such launch writes `worker-recovery.json` beside the run: the run
id, the absolute deadline, the current worker PID, and the worker launch. The
marker is **untrusted input**, not launch authority. The host also writes a
receipt under `<runRoot>.worker-launch-authority/<id>.json`, a sibling of
the host run root, outside all child run directories and nested run roots. The receipt pins every launch argument, PID and deadline, plus
the current host's agent configuration, binaries, inherited tools and policy.
Recovery requires an exact match; this covers optional/future arguments too,
including runner, child binaries, extensions, kernels and capability settings.
The run root and receipt directory, like the host configuration, must remain
host-controlled: this is not isolation against a process with arbitrary
same-user filesystem access. Both files are removed on settlement. An
explicit stop deletes the file as soon as it is requested, before Fabric
signals the worker, so a host that dies partway through a stop leaves nothing
to recover. Every other settlement this host makes deletes the file before it
writes the terminal record. A later host therefore never recovers a run Fabric
already finished or stopped.

When the host closes, it leaves these workers running. The next resident host,
whether started by a new session or by `agents.wait` after the old host died,
reads each file and decides:

- **Worker still running.** Fabric checks the PID and that its command line
  still carries `--id <run id>`. It then adopts the worker and waits for its
  result. Nothing is relaunched.
- **Worker gone.** Fabric relaunches the same launch in the same run directory,
  with the same prompt and the progress so far carried over, and with
  `--timeout-ms` set to what remains of the original deadline. `pi-durable`
  reopens its journal, so completed work is not repeated.
- **Worker recorded a stop but is still running.** Fabric waits up to seven
  seconds for it to exit and then relaunches it. If it is still running, the run
  settles `indeterminate` and no new launch is attempted.
- **Recovery file does not match this host.** A missing or mismatched host
  receipt, including a legacy marker-only run or a changed host policy, settles
  the run `indeterminate` without adopting or starting a process. The launch
  also has to use this host's worker and the run's own id, cwd and file paths.
  Files over 8 MiB, malformed files and files whose id does not name their run
  directory cannot authorize a launch.
- **No first status.** A valid marker can precede the worker's first status
  write. Recovery explicitly publishes a failed, `indeterminate` status and
  removes the marker. The run is not silently left without an owner.
  It does not guess at, signal or relaunch a possibly still-running worker.
- **Deadline passed, or liveness cannot be verified.** This covers a PID owned
  by another user and an unreadable command line. The run settles `failed` with
  `outcome: "indeterminate"` and a reason. `agents.wait` returns that result
  and does not throw.

The option is off by default; with it off, no file is written and behaviour is
unchanged. A run launched while the option was on keeps its marker; changing
the host policy (including turning the option off) settles it indeterminate.
The former authority is not revived. Windows, other transports, and
waits from another session of the project (`waitProjectAgent`) are not covered.

A hard-killed outer worker can leave its detached durable child alive briefly.
Outer-PID disappearance does **not** prove the child released its SQLite lease;
a relaunch during that window can fail with a storage-lock error. Recovery does
not steal/delete leases or kill guessed child PIDs. The lease still excludes
concurrent journal writers, but automatic recovery across that cleanup window
is not guaranteed. Graceful external-stop recovery waits for child shutdown;
unknown worker liveness always settles indeterminate without a relaunch.

Lifecycle events that the worker wrote but the old host had not read when it
died are not replayed. The new host starts reading `lifecycle.jsonl` from its
size at recovery. The run's status, turns, tool calls and usage are unaffected,
because they come from `status.json`; only those intermediate `pi.*` events
and their token-usage ledger entries are lost.

## Advanced: manually registered leaf adapter

The rest of this guide concerns the restricted `pi-fabric/durable` factory, **not**
the built-in default. `createPiDurableRunner` still accepts host-supplied Models,
Registry, environment, and storage. Its default ID is now `pi-durable-leaf`; the
built-in `pi-durable` ID is reserved. Existing custom registrations should select
the separate ID explicitly.

Exports include `PiDurableRunner`, `PiDurableRunnerOptions`,
`PiDurableStorageOptions`, `PiDurableStorageLease`, `PiDurableLocator`, and
`PiDurableMessageOptions`. Import/construction stays lazy and does not register a
runner. First use checks pinned `@earendil-works/pi-durable@1.4.0` and
`@earendil-works/chord@1.4.0`. Credentials remain in Models/environment, never in
a locator.

### Leaf host setup

```ts
import { createPiDurableRunner } from "pi-fabric/durable";
import { registerAgentRunner } from "pi-fabric/runners";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// Supply a configured pi-ai Models collection and a durable Registry.
// Install only trusted tool implementations in that registry.
const runner = createPiDurableRunner({
  id: "pi-durable-leaf", // separate from the built-in full host
  models,
  registry,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }),
  allowedModels: [{ provider: "openai", modelId: "your-model-id" }],
  defaultModel: { provider: "openai", modelId: "your-model-id" },
  storage: { kind: "jsonl", directory: "/absolute/private/durable-runs" },
  // Required for standard residency: "durable":
  // residentModule: "/absolute/path/to/host-registration.mjs",
});
const unregister = registerAgentRunner(runner);

// Select this runner explicitly, or set agents.runner to its registered id
// for a host that only uses the supported leaf-run capabilities.
// model can be omitted when defaultModel is configured above.
// { runner: "pi-durable-leaf", task: "...", tools: ["read"],
//   recursive: false, thinking: "off" }

// Detach only after the host has stopped delivering requests to this instance.
await runner.close();
unregister();
```

`residentModule` must be a real host-owned ES module that registers the adapter
with the same storage and credentials in the resident process. Merely setting the
path does not create a daemon. A session-resident runner needs no resident module.
The factory does not discover providers or credentials. `models()` advertises only
currently resolvable entries in `allowedModels`, with credential-free metadata.
An optional `defaultModel` must be allowlisted; without it an explicit model is
required. Model execution continues through the supplied `Models` collection.
Thinking is passed explicitly (omission means `off` at the adapter boundary);
unsupported levels are rejected; the adapter does not clamp them.

## Leaf adapter supported requests

- **Image input:** `images` is submitted as native image blocks alongside the task.
  The selected model must declare image input. PNG, JPEG, GIF and WebP are accepted
  as padded base64, with at most 32 images and 16 MiB of base64 characters total.
  Durable storage retains the images; Fabric's text transcript projection does not
  reproduce their bytes. Images never enter the locator.
- **Structured output:** `schema` is included in the model instructions, and the
  final answer is parsed and validated with Fabric's normal result validator.
  Invalid output fails the run; valid output is reported as `structured` and
  reaches the agent result's `value`. This is validation, not provider-enforced
  constrained decoding. Schemas are bounded to 262144 JSON characters.
- **Steering and follow-up:** admitted messages extend the same Fabric run's
  completion boundary. See below; a completed run cannot be reopened with a new
  message. This is not persistent actor/session support.

The committed request fingerprint includes image content and output schema;
reattaching the same run ID with changed inputs is refused.

## Storage and ownership

There is one isolated durable Session/root conversation **per Fabric run ID**.

### Built-in JSONL

`{ kind: "jsonl", directory }` opens the published Node JSONL backend with
`fsync: true`. Files live under `directory/sha256(runId)`; an atomic mkdir of
`directory/sha256(runId).writer` grants exclusive ownership. The base directory is
canonicalized before opening the lock and storage, so symlink aliases contend for
the same filesystem lock. A process-global ownership set also rejects two active
adapter instances with the same identity/run ID. An active run retains ownership,
including after settlement, until `close()`.

**No automatic stale-lock stealing.** Any existing lock (including malformed,
empty, unknown or remote ownership) is a refusal, never evidence of death. This
avoids both lease-timeout false deaths and the two-contender read/dead/unlink race.
Locks are intentionally empty and contain no credentials. Keep the directory
private to cooperating trusted hosts; this is not a hostile-filesystem sandbox.

After a crash, the host must:

1. Quiesce **all** recovery contenders/writers for this storage/run.
2. Positively establish that the previous process and any invocation using the
   storage have terminated (e.g. the supervised process's exit receipt). Timeouts,
   old mtimes, missing heartbeats, and unknown PID namespaces are insufficient.
3. Remove only the exact empty `sha256(runId).writer` directory while recovery is
   administratively serialized. Never blindly unlink a possibly replaced lock.
4. Reopen a new factory instance with the same directory and call attach using
   Fabric's persisted locator/context. Do not call start to repair missing work.

SIGKILL recovery is tested with exactly this manual restore procedure. Automatic
unattended crash recovery needs a host factory that supplies an appropriate lock.
JSONL durability remains subject to the published storage/filesystem contract;
this adapter does not promise power-loss-proof filesystem metadata.

### Host-provided storage

```ts
storage: {
  kind: "factory",
  identity: "tenant-a-durable-v1", // stable opaque identity, no secret required
  async acquire(runId) {
    // Acquire an exclusive process/host-wide lease; OS crash-released locking
    // can provide unattended recovery. Open the SAME isolated storage for runId.
    return { storage, async release() { /* release ownership, not work */ } };
  },
}
```

`acquire` must reject conflicting ownership, including other processes and
aliases, and must return a distinct isolated storage namespace per run ID.
It must clean up partial acquisition on failure. The adapter closes storage via
Harness before `release`, never releases while its invocations still run, and
joins accepted open/start operations during `close`. In-memory storage is useful
for tests but is not restart persistence. Failed closure/release fails closed;
its lease remains owned, and competing writers are refused. Well-behaved
host tools must observe cancellation: upstream close joins even tools that ignore
it, so such tools can block close indefinitely.

## Admission, attach, and reporting

Fabric persists the pure JSON locator before `start`. It contains backend/version,
a storage identity hash, and Fabric run ID only. `start` commits a request manifest
and submits with **requestId = Fabric run ID**. Repeated starts, including after
reopen, reuse the committed submission. A changed task/model/tools/cwd/thinking/
system prompt/images/schema under that run ID is rejected.

`attach` looks up the existing root and `submissionByRequest`; it never creates a
conversation or submits an input. A locator with no admitted submission throws;
the existing HostedRun protocol records the outcome as **indeterminate**, not
retryable work. A crash between manifest creation and submission is therefore
not automatically repaired. Locators must be retained with Fabric's context.

Committed conversation snapshots feed progress (turns, calls, current tool,
partial text), cumulative model/tool usage, and transcript messages/tool events.
Transcript attachment reconstructs the current committed history; it does not
rerun effects or guarantee exactly-once transcript delivery across host restarts.
The admitted submissions map to completed/text, aborted/stopped, or unanswered/failed.
Completion waits for the initial input and every accepted control message, and
returns their latest answer by answer-entry order (not message-admission order).
Liveness is running, settled, cancelled, interrupted, or unknown. Unowned/missing
work is unknown; explicit stop returns unconfirmed when no owned submission exists.

`stop` aborts the owned root's work, including background descendants, and joins
it. `close` instead seals the adapter, detaches observers, closes Harness without
writing an abort outcome, joins invocations, and releases ownership. A new
factory instance can attach afterward. `close` is idempotent, but a closed
instance cannot reopen. This is a resource lifecycle surface, not a sleep/wake
capability. Fabric's own explicit stop/shutdown/deadline policy is unchanged.

## Durable steering and follow-up

`runner.steer(locator, message, options?)` places input at a tool boundary;
`runner.followUp(locator, message, options?)` queues the next generation after
the current answer. The public methods can take a host-issued stable identity:

```ts
await runner.followUp(locator, "Also verify the migration", { requestId: "verify-1" });
```

Retrying the same `requestId`, message and method is a no-op, including after
reattachment or completion. Reusing it for different work is rejected. Without
`requestId`, each invocation is a distinct message. Other message-option fields
are rejected, not ignored. Normal Fabric `agents.steer`/`agents.followUp` calls
are also supported; their delivery acknowledgement is not a new completion receipt.

Admission uses the upstream submission's atomic, persisted request identity.
Recovery discovers committed submissions directly from storage, including a
message admitted just before a crash; it never replays the message as a new
submission. A persisted completion boundary rejects new messages after settlement.
Limits are 128 control messages per run, 16384 characters per message and 256
characters per supplied `requestId`. A failed generation withdraws queued
follow-ups so the Fabric run does not wait indefinitely. `stop` also
aborts an executing follow-up, even if the original input is already answered.

## Tools and limitations

Only names in `request.tools` are selected. Unknown names and unknown/disallowed
provider/model keys fail closed before admission. Registered tool definitions
are resolved last-installed-wins, host tool wrappers are applied in registry
order, and selected implementations are pinned in a private per-open registry.
Changes to the host registry do not rewrite in-flight code; reopen resolves the
host's current definitions and refuses missing requested names.

**This is a tool-only Registry integration.** Host extension sections, hooks,
and custom tasks are not installed in the private registry. The request system
prompt becomes conversation instructions; cwd is handed to the host environment.
Tool execution remains trusted host code, not a security sandbox. Host tools can
use their durable execution API; the adapter does not claim to confine arbitrary
host side effects or sub-work they create. Tool result `addTools` and `handoff`
controls are rejected. The requested allowlist stays fixed.

There is no built-in Fabric tool bridge, kernel, or JavaScript continuation
restoration. Replay is the published explicit task/checkpoint protocol: tools
are unsafe by default, and interruption returns an error. An uncertain side effect
is not replayed. Only a host's explicit replay-safe tool declaration
permits replay; the adapter never blanket-marks tools safe. A host-registered
`fabric_exec` implementation is always forced unsafe even if the host accidentally
marks it safe; no Fabric bridge is synthesized.

Unsupported capabilities still fail closed: recursive Fabric, kernels,
branch/session seeding, actors/persistent sessions, write confinement, scopes,
routed questions, explicit compaction, and sleep/wake.

## Full-host and leaf boundaries

The default is a **worker** adapter, preserving native permission and lifecycle
ownership. The manually registered leaf adapter remains **hosted**, with its
unsupported capability checks intact. Neither silently falls back to a native
Agent when durable execution fails.

Full-host coverage is in `tests/durable-agent.test.ts`,
`tests/durable-session.test.ts`, `tests/durable-worker-storage.test.ts`,
`tests/durable-worker-host.test.ts`, `tests/durable-worker-routing.test.ts`,
`tests/durable-worker-e2e.test.ts`, `tests/durable-fabric-exec.test.ts`,
`tests/handoff-continuation-worker.test.ts`, and `tests/durable-actors.test.ts`.

## Embedding a durable session: `pi-fabric/durable-host`

A host process that runs one long-lived durable `AgentSession` of its own (a
daemon, not a Fabric-managed worker) imports `pi-fabric/durable-host`. The host
supplies the Pi SDK (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`)
as peers, as for the extension. Fabric's registration graph never loads this
entry, and it does not read `agents.durableWorkerSession` or any other Fabric
setting: the embedder chooses its own session file.

Exports: `createDurableAgentSession` (the session), `DurableAgent`,
`openDurableWorkerStorage` (exclusive, fsync'd JSONL storage with a lease),
`createDurableWorkerRuntime` and `DurableWorkerOptions` (the full native runtime
with `/new`, `/fork` and `/resume`), `declareWorkerSessionRole` and
`DURABLE_WORKER_POLICY_ENTRY_TYPE`.

```ts
import {
  createDurableAgentSession, declareWorkerSessionRole, openDurableWorkerStorage,
} from "pi-fabric/durable-host";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const lease = await openDurableWorkerStorage("/absolute/private/run-dir"); // throws if another process owns it
const sessionManager = SessionManager.open(sessionFile, undefined, cwd);   // or create(...)
declareWorkerSessionRole(sessionManager); // before the first prompt; "already-seeded" on resume
const host = await createDurableAgentSession({
  cwd, sessionManager, storage: lease.storage, runId: "my-daemon:main", // stable across restarts
  // modelRuntime, model, tools, customTools, resourceLoader: as for createAgentSession
});
await host.session.bindExtensions({}); // not done for you; bind your own mode/UI/error hooks
await host.session.prompt("...");
// Shutdown: await host.close(); await lease.storage.close(BACKGROUND_CONTEXT); await lease.release();
```

**Worker role.** `declareWorkerSessionRole(sessionManager)` appends the same
worker-role entry described under "Worker role" above to a session you already
opened. It returns `"seeded"` when it wrote the entry and `"already-seeded"`
when the latest host role declaration on the active branch is worker, so a restart
loop does not grow the file. A sibling branch does not count, and a later host
role override causes the helper to append a fresh worker declaration. Call it before the first prompt and before `bindExtensions`.
Unlike a Fabric child, whose entry is the tree root, this one is appended after
whatever the session already holds. Without it the session counts as a
foreground session with a user at a terminal.

**Supervision is the host's job.** An embedder gets journal resume through
`createDurableWorkerRuntime` and `createDurableAgentSession`, but not Fabric's
opt-in worker recovery (`agents.durableWorkerRecovery` and
`worker-recovery.json`), which only Fabric's agent manager performs. Nothing in
this entry restarts a process. After a crash, the host starts a new process,
reopens the same storage directory and session file, and calls
`createDurableAgentSession` again with the **same `runId`**, then
`host.agent.continue()` to finish interrupted work. Do not replay the original
prompt. The host also owns backoff, a restart budget, and releasing the storage
lease before another process takes over.

## Evidence

`tests/durable-runner.test.ts` exercises the real published packages with offline
faux models, MemoryStorage and fsync JSONL: real AgentManager execution, duplicate
admission, reopen/attach, cancellable unsafe interruption, a killed
process/manual recovery/no replay, exclusive ownership, stale-lock refusal,
close/open races, exact tools/model/thinking, usage/progress, configured leaf
defaults, model-metadata privacy, images, schema validation, message ordering and
deduplication, queued-message recovery, cancellation and unsupported requests.
`tests/durable-input.test.ts` covers request snapshots and input bounds.
`tests/durable-controls.test.ts` covers the completion-versus-cancellation race.
`tests/optional-durable-startup.test.ts` checks lazy engine loading even with built-in runner registration.
