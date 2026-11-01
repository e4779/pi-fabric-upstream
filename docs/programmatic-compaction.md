# Programmatic compaction

A model, skill, or peer can **ask** the host to compact its context at a safe
boundary. The request also works on a running agent's context.

One gated channel carries the request to the host. The host selects the safe
time. Fabric performs deterministic compaction without another model call,
which keeps repeated results testable. Each request records a labeled
**advisory** intent. The host later performs the **committed** context change.

## Advisory and committed steps

The model runs inside the context that it requests to compact. A direct change
during the active turn could race with in-flight tool work or unresolved state.
Fabric records the request through a typed, validated write path. An open status
path reports its state.

1. **Advisory.** `compact.request` (host) or `agents.compact` (child) only
   *records an intent*. The request never touches the context. It is a
   write-risk, schema-validated declaration: "Compact this context with these
   instructions. Reason: <reason>."

2. **Committed.** At a boundary it knows to be safe, the host forwards the
   intent to `ExtensionContext.compact()` for the host session, or to the
   child pi's `compact` RPC frame for a child. The host boundary is
   `agent_settled`: the handler awaits Pi's callback completion or error
   before Pi publishes its public settled event. For a child, the worker waits
   for the child's own `agent_settled`. It then sends a correlated compact
   request and keeps the RPC channel open until it observes both the response
   and `compaction_end`. The worker never sends compact while the child turn
   is active.

Exactly one write path leads from intent to action. The model cannot compact
the running context directly. It can only ask. The controller stores one replaceable
request. A new request replaces the pending one, so the slot always holds the
latest instructions.

## Compaction properties

| Property | Fabric behavior |
| --- | --- |
| The context is a cache for the store. | Compaction changes the cache through an explicit, labeled transition. `status()` records the intent and last commit outside the context, where they survive compaction. |
| Derived views are pure functions of the log. | `CompactStatus` reads the controller's recorded intents and commits. It never reads the compacted context itself. |
| The host enforces transition boundaries. | The model requests compaction. The host commits at `agent_settled`. `maybeCommit` and the `agent_settled` handler contain the boundary gate. |
| A task boundary can carry a compaction request. | The model selects the request time and instructions. The host selects a safe commit time. Pi core keeps its token-threshold trigger. |

## API surface

### Host session: the `compact` provider

The provider is always available, with no config guard. Fabric exposes it
through `fabric_exec` as `compact.request`, `compact.status`,
`compact.pressure`, `compact.carry`, and `compact.cancel`.

```ts
// Record an advisory intent. Replaces any pending one and returns
// immediately. The host commits it at the next agent_settled boundary.
await compact.request({
  reason: "the file map and the failing test are the only live state",
  instructions: "Keep the failing test name and the file map; drop the rest.",
  preserve: ["Auth regression is still open", "tests/auth.test.ts"], // optional
  requestedBy: "model", // optional, default "model"
  seed: "Start phase 2: wire the API", // optional, queued after the commit as a labelled Fabric message
});

// Read the pending intent and the last committed/failed compaction info.
const status = await compact.status();
// { pending?: { reason?, instructions?, preserve?, seed?, requestedBy, requestedAt },
//   last?:   { at, requestedBy, status: "committed"|"cancelled"|"failed",
//             summary?, tokensBefore?, estimatedTokensAfter?, error?, seeded? },
//   lastAuto?: { at, trigger: "headroom"|"tokens"|"ratio", committed },
//   owner: "fabric"|"pi"|"external"|"none",
//   outputReserveTokens,
//   claim?: { name, version, branchSummary, actions }, // under a claim
//   ownerStatus? }                                      // owner's own report

// Read context pressure. Never compacts; the program decides what to do.
const pressure = await compact.pressure();
// { tokens, contextWindow, fraction, headroomTokens,
//   band: "ok"|"warn"|"urgent"|"unknown", outputReserveTokens,
//   thresholdFraction?, thresholdTokens?, owner,
//   claim?: { name, version },                          // under a claim
//   ownerPressure?: { stage, thresholds? } }            // owner's ladder

// Keep a bounded focus list in every Fabric summary until it is cleared.
await compact.carry({ add: ["Auth regression is still open"] });
await compact.carry({ remove: ["Auth regression is still open"] });
await compact.carry({ clear: true });
const { items } = await compact.carry(); // no arguments reads

// Clear a pending intent before the host commits it.
await compact.cancel();
```

Risk classes: `request`, `carry`, and `cancel` are `write` (they change host
session state). `status` and `pressure` are `read`, carry no effect, and are
eligible for speculative pre-launch and for Schema enforce mode.

#### Pressure

`compact.pressure()` reads Pi's `getContextUsage()` and the active model.
`fraction` is `tokens / contextWindow`, and `headroomTokens` is
`contextWindow - tokens`. `band` compares `fraction` with
`compaction.pressureBands` (default `{ warn: 0.6, urgent: 0.8 }`). The band is
also `urgent` whenever `compaction.outputReserveTokens` is set and the
headroom is below it. When Pi has no token count, for example right after a
compaction and before the next response, the numeric fields are `null` and
the band is `unknown`. `thresholdTokens` or `thresholdFraction` reports the
active model's configured Fabric threshold; the token threshold wins when
both exist. `owner` is the [observed compaction owner](compaction.md#compaction-ownership).

#### Carry-forward focus

`compact.carry` maintains a list that Fabric's deterministic compactor renders
under `[Carry Forward]` in **every** summary until it is cleared. It is the
persistent counterpart of the one-shot `preserve` field. Arguments apply in
this order: `clear` empties the list, `items` replaces it, `remove` drops exact
matches, and `add` appends items that are not already present. The result must
fit the `preserve` limits: at most 16 non-empty items of 2048 characters and
2048 UTF-8 bytes each. A violation rejects the call and leaves the list
unchanged.

Fabric persists each change as a `pi-fabric-compact-carry` session custom
entry. The latest entry on the active branch is the current list, so reload,
restart, and tree navigation restore it without extra state, and a branch
keeps its own list. A malformed latest entry reads as an empty list. Custom
entries never enter the model context. The rendered block is bounded to
3 KiB like the request block; compaction details record
`carry: { count, renderedOmittedBytes }`. With `compaction.engine: "pi"`, or
when an extension wins compaction by load order without a claim, the list is
stored but not rendered. Under a [compaction owner claim](#compaction-owner-claim)
the list belongs to the owner and Fabric stores nothing.

##### Carry update contract

Fabric applies one `compact.carry` call to the current list in this order.
A claim owner that takes `carry` applies the same rules to its own list, so
the call means the same thing either way.

1. Fabric validates the call first. It accepts only `items`, `add`, and
   `remove` (arrays of at most 16 strings of 1 to 2048 characters) and
   `clear` (a boolean).
2. A call without `items`, `add`, `remove`, or `clear: true` reads the
   list and changes nothing.
3. `clear: true` starts from an empty list; otherwise the update starts from
   the current list.
4. `items` replaces the list.
5. `remove` drops every item exactly equal to one of its strings.
6. `add` appends, in order, each item that is not already present.
7. Duplicates are dropped; the first occurrence stays.
8. The result must hold at most 16 items, each not blank and at most 2048
   characters and 2048 UTF-8 bytes. Otherwise the whole call is rejected
   and the list is unchanged.
9. Fabric writes no entry when the result equals the current list.

With only `instructions` present, Fabric forwards it as ordinary Pi
`customInstructions`. Manual `/compact` text and programmatic requests then
get the same Fabric rendering. When `preserve` is present, the controller
encodes `{version: 1, instructions?, preserve}` behind an exact versioned
prefix plus JSON. The compaction and branch hooks strictly decode that shape
and render valid bounded values under `[Compaction Request]`. On tree
navigation, Pi's explicit `replaceInstructions: true` mode delegates to
Pi/default summarization. Fabric cannot execute an arbitrary replacement
summarizer prompt, so it produces no typed Fabric branch details in that mode.

The prefix is reserved. Malformed JSON or scalars, duplicate decoded protocol
keys (including escaped aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded limits return a
structured decode error and cancel the operation. Fabric never falls back to
prose for such a payload. A bounded structural parser performs these checks
before canonicalization, and it never uses regex to recover protocol
data. Fabric never renders a rejected payload. A context with UI/RPC notification support
receives a bounded error. The exact `__pi_vcc__` value keeps its
compaction-routing precedence, and it has no special effect on the tree hook.

`compact.request` validates its input with a bounded TypeBox schema before
argument mapping. Instructions cap at 8192 characters and 8192 UTF-8 bytes.
`preserve` accepts at most 16 items, and each item caps at 2048 characters and
2048 UTF-8 bytes. The complete encoded prefix-plus-JSON request must fit
within 16 KiB. The decoder checks aggregate source bytes before structural
parsing, then validates duplicate keys, scalars, and surrogate pairing while
parsing. It checks the preserve count before iterating or canonicalizing
items. Ordinary manual and Pi instructions remain bounded explicit text and
never become typed protocol input.

The rendered request block is separately bounded to 3 KiB. Complete items are
kept when they fit; otherwise each item receives an excerpt with an explicit
UTF-8 byte-loss marker. Compaction details set `instructionPolicy.truncated`
for rendering loss too, and `renderedOmittedBytes` records its size. Input
validation limits are not a promise that every accepted byte appears inline.

`preserve` is **one-shot**, not a persistent task ledger: it applies to this
compaction and is not automatically carried into the next one. Recent dialogue
has its own protected projection; `state.goal` remains an executable predicate,
not an automatically inferred conversational objective.

#### Commit semantics

- The host's `agent_settled` handler awaits `maybeCommit(context)`. It never
  runs mid-turn or while a turn is in flight. The returned Promise settles on
  `onComplete`, `onError`, a synchronous startup throw, or a pre-start abort.
- The call is a no-op when nothing is pending. Reentrant calls share the
  in-flight Promise and never start a second compaction.
- Fabric accepts a new `request()` during an in-flight commit, and that
  request replaces the pending intent. The in-flight commit proceeds with the
  intent it captured.
  On completion it clears *that* intent by identity, and any newer intent
  waits for the next settled boundary.
- On pi's `onComplete`, Fabric clears the intent and `last` records
  `status: "committed"` with the summary and token counts.
- On pi's `onError` with `"Compaction cancelled"`, `"Already compacted"`,
  or `"Nothing to compact (session too small)"`, Fabric clears the intent
  and `last` records `status: "cancelled"` with the raw pi message in
  `error`. No compaction happened. The too-small message is Pi rejecting a
  manual compaction whose session sits below `keepRecentTokens`, so every
  message would be kept anyway. The outcome stays observable without
  being silently dropped. Only exact messages are benign: an error merely
  containing one of the phrases stays `failed`.
- On any other error, Fabric clears the intent and `last` records
  `status: "failed"` with the message. A synchronous throw from `compact()`
  itself follows the same failure path.
- A `seed` (at most 8192 characters, not blank) is sent only after
  `onComplete`. Fabric sends it as a labelled custom message, never as a
  user message, because the compaction removes the context that showed a
  program wrote it:

  ```ts
  pi.sendMessage({
    customType: "fabric-compaction-seed",
    content: "A Fabric program requested this continuation when it compacted the context. It is not a message from the user.\n"
      + `<fabric-compaction-seed>\n${escaped}\n</fabric-compaction-seed>`,
    display: true,
    details: { version: 1 },
  }, { triggerTurn: true, deliverAs: "followUp" });
  ```

  Pi gives the model a custom message as user-role text without its type or
  details, so the first line carries the origin. Fabric escapes `&`, `<`,
  and `>` in the seed, so it cannot close the wrapper, and no slash command
  or template expands. The seed is queued after the compaction commits; a
  prompt submitted during the compaction runs first. Pi defers a
  turn-starting message sent during `agent_settled` until the settle
  finishes, then runs deferred prompts and messages in submission order.
  `last.seeded` is `true` once Fabric handed the seed to Pi. A cancelled
  or failed commit never sends it. The seed applies to Fabric's own
  controller whatever summarizer runs, including `compaction.engine: "pi"`.
  Under a claim the owner receives the seed instead and sends it the same
  way (see below).

### Compaction owner claim

Another extension can take compaction from Fabric without
`compaction.engine: "pi"`, which would also hand `/tree` summaries to Pi.
The owner emits `pi-fabric:compaction-owner:v1`
(`FABRIC_COMPACTION_OWNER_EVENT` in `pi-fabric/protocol`) from its
`session_start` handler or later:

```ts
import {
  FABRIC_COMPACTION_OWNER_EVENT,
  type FabricCompactionOwnerClaimV1,
  type FabricCompactionOwnerHandleV1,
} from "pi-fabric/protocol";

let claim: FabricCompactionOwnerHandleV1 | undefined;
const lifetime = new AbortController();
pi.on("session_start", (_event, ctx) => {
  // Fabric may answer after emit returns, so wait for the reply with a timeout.
  const giveUp = setTimeout(() => lifetime.abort(), 5_000); // no reply: Fabric is not loaded
  pi.events.emit(FABRIC_COMPACTION_OWNER_EVENT, {
    version: 1,
    type: "claim",
    owner: { name: "example-owner", version: "1.4.0" },
    actions: {
      request: { fields: ["instructions", "preserve", "seed"], handler: (request, { signal }) => focus(request, signal) },
      carry: { fields: ["items", "add", "remove", "clear"], handler: (update) => ({ items: carry(update) }) },
      status: { handler: () => ({ stage: ladder.stage }) },
      pressure: { handler: () => ({ stage: ladder.stage, thresholds: { fold: 0.7, compact: 0.9 } }) },
      cancel: { handler: () => cancelPending() },
    },
    // branchSummary: true, // also take /tree summaries
    signal: lifetime.signal,
    reply: (result) => {
      clearTimeout(giveUp);
      if (!result.ok) {
        ctx.ui.notify(result.error, "warning");
        return;
      }
      if (lifetime.signal.aborted) {
        result.handle.withdraw(); // granted after the claimant gave up
        return;
      }
      claim = result.handle;
      if (result.carry) adoptCarry(result.carry); // Fabric's list at cut-over
    },
  } satisfies FabricCompactionOwnerClaimV1);
});
```

The first message loads Fabric's claim code, so `reply` is called once, after
`emit` returns (a Fabric that answers during `emit` is also valid; accept
both). If it never comes, Fabric is not loaded: abort the claim's `signal` and
carry on without it. If `{ ok: true }` arrives after you gave up, call
`handle.withdraw()`. Fabric refuses a claim whose `signal` is already aborted
when it handles it. It handles messages in the order they were emitted and reads
each field when it handles the message, so do not change the message after
emitting it. A message still queued at Fabric's `session_shutdown` is refused:
a claim gets `{ ok: false, error }` saying Fabric is shutting down. If the
claim code fails to load, the reply is `{ ok: false, error }` naming the failure.

A successful reply is `{ ok: true, handle, carry? }`. `carry` is a frozen
copy of Fabric's carry-forward items when the claim was made: the list the
owner takes over, because `compact.carry` now goes to the owner. It is
absent when Fabric has not started the session yet, which happens when the
owner's `session_start` handler runs before Fabric's. The owner then reads
the latest `pi-fabric-compact-carry` custom entry on the branch itself
(`data: { version: 1, items }`).

While the claim is held:

- Fabric's `session_before_compact` handler returns nothing, before its
  threshold deferral. Fabric produces no summary and never cancels the
  owner's compaction. The owner's own `session_before_compact` handler
  decides; when it returns nothing, Pi's summarizer runs.
- Fabric's settled-boundary threshold and headroom trigger stay off.
- `/tree` summaries stay with Fabric's configured engine unless the claim
  sets `branchSummary: true`.
- `compact.request`, `compact.carry`, and `compact.cancel` go to the owner.
  Fabric validates arguments as usual, then passes a fresh copy holding only
  the fields the owner declared. An undeclared action or field fails with an
  error naming the owner (`compaction owner example-owner@1.4.0: ...`),
  and nothing is recorded, stored, or forwarded. `request` returns
  `{ requested: true, intent, claim, result? }`. `intent` is a receipt that
  describes what went to the owner; Fabric records none of it, so
  `compact.status().pending` stays empty. `carry` handlers return
  `{ items }` and should apply the [carry update contract](#carry-update-contract)
  to the owner's own list.
- A request's `seed` reaches the owner only when it declares the `seed`
  field, after the same checks as Fabric's own path. Fabric does not send
  it. Send it after the owner's compaction commits, the way Fabric does: a
  labelled custom message with `{ triggerTurn: true, deliverAs: "followUp" }`
  whose text names its origin, not `sendUserMessage`.
- `compact.cancel` first clears any intent Fabric recorded before the
  claim. That intent would otherwise commit through the owner at the next
  settle, with Fabric-encoded instructions and Fabric's seed. It then calls
  the owner's `cancel`. The result says which happened:
  `{ cancelled: true, claim, fabricIntentCleared, ownerCancelled, result? }`.
  Without an owner `cancel`, the call succeeds when Fabric had an intent to
  clear and fails otherwise.
- `compact.status` adds `claim: { name, version, branchSummary, actions }`
  and, when the owner supports `status`, `ownerStatus`. `compact.pressure`
  adds `claim` and `ownerPressure: { stage, thresholds? }` beside Fabric's
  band. Fabric omits its own `thresholdFraction` and `thresholdTokens`
  there because they do not trigger under a claim.
- Every handler receives `{ context, signal }` (`FabricCompactionOwnerCallV1`):
  `request` and `carry` as the second argument, the others as the only
  one. `context` is the invoking session's extension context when Fabric
  has one. Fabric bounds each handler call at 30 seconds. When the calling program
  is cancelled or the bound passes, Fabric aborts `signal` and fails the
  program call at once with `compaction owner <name>@<version>:
  compact.<action> was cancelled by the calling program` or
  `... did not finish within 30 s`. Stop the work when `signal` aborts.
- Owner handler results must be JSON of at most 16 KiB. A handler that throws
  or returns an invalid shape fails the call with the owner's name. Pressure
  threshold names `__proto__`, `constructor`, and `prototype` are refused.
- An expected owner result does not raise Fabric's ownership warning.

The handle's `fallback(event, ctx, { carry? })` returns Fabric's
deterministic summary for a `session_before_compact` event: the same
compiler, enrichers, and budget as Fabric's own hook, as
`{ ok: true, compaction }` or `{ ok: false, reason }`. Return
`{ compaction }` from the owner's handler when its model summary fails.
`carry` replaces Fabric's stored carry list and must fit the
`compact.carry` limits. The result carries Fabric's v2 details
(`compactor: "fabric"`) plus `claimOwner`, the owner's name, so a
provenance check can tell the owner's fallback from Fabric's own engine,
which never sets `claimOwner`. The fallback works only while the claim is
held.

One claim at a time. A second claim gets `{ ok: false, error, holder }`,
and Fabric shows a warning that names both owners. If the claimant's
`reply` throws, Fabric withdraws the claim it just granted and reports the
error as a warning (UI notice, else `console.warn`), because the owner never
received its token. A message with no usable `reply` is also reported as a
warning and dropped; nothing throws from `emit`. The claim ends when:

- the holder calls `handle.withdraw()` or emits
  `{ version: 1, type: "withdraw", token: handle.token, reply? }`. Any other
  token is refused with `{ ok: false, error }` and the claim stays;
- the claim's `signal` aborts; or
- Fabric receives `session_shutdown`. Pi sends it on reload, session
  replacement (new, resume, fork), and quit, then loads every extension
  again, so the owner claims again from its next `session_start`. Fabric
  clears the claim first, before any other shutdown work.

Withdrawal restores Fabric's engine, thresholds, and `compact.*` behavior.
Fabric validates the claim and copies only named fields, reading each once:
`owner.name` and `owner.version` (printable text, at most 128 and 64
characters), the five known actions with their handlers and known fields,
`branchSummary`, and `signal`. Unknown keys, actions, or fields are
rejected with a reply naming the problem.
### Agent compaction: `agents.compact`

```ts
const handle = await agents.spawn({
  task: "Audit auth flows.",
  tools: ["read", "grep", "find", "ls"],
});

// Advisory: the worker queues this until the child is fully settled.
await agents.compact({ id: handle.id, instructions: "Keep the finding list." });

return await agents.wait({ id: handle.id });
```

- Fabric appends the request to the same `<runDir>/steer.jsonl` channel as
  `agents.steer`. The orchestrator, or any peer through the mesh relay, can
  request a child compaction without stopping or respawning the child, and the
  child keeps its accumulated context.
- The worker tails `steer.jsonl` and never forwards compact during an active
  child turn. It waits for `agent_settled`, then sends
  `{"id":"...","type":"compact","customInstructions":"..."}`, with the
  instructions field omitted when absent. See pi's [RPC `compact`](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/rpc.md).
- The worker correlates the compact response by `id`. It observes the matching
  compaction lifecycle through `compaction_end`, records queued, in-flight,
  completed, or failed status, and only then closes stdin for one-shot
  shutdown. The worker records a rejected response, an aborted compaction,
  or a `compaction_end.errorMessage` as failed, and the child turn keeps
  running.
- Multiple requests that wait before the boundary coalesce into one request
  with the latest instructions. Requests that arrive during an in-flight
  compaction merge into one deterministic follow-on request before shutdown.
- Fabric **rejects Claude-runner children** with a clear error. The official
  Claude Code CLI exposes no compact RPC, so a fresh run is the only way to
  reset a Claude child's context. Compaction is a Pi-runner primitive.
- Risk class: `agent`.

## Audit and observability

- **Activity surface**: `compact.request` and `agents.compact` emit
  `context.activity` updates (entity + progress) inside the `fabric_exec` call
  that issued them, following the existing provider pattern. Host commits and
  child enqueues show up in the dashboard and widget.
- **Mesh**: when the mesh is enabled, the host controller publishes
  best-effort events to the durable `fabric.compact` topic on each transition.
  Recorded intents publish `kind: "requested"`, and settled intents publish
  `kind: "committed" | "cancelled" | "failed"`. Pi's benign
  `"Compaction cancelled"`, `"Already compacted"`, and `"Nothing to
  compact (session too small)"` outcomes publish with `kind: "cancelled"`.
  Other Fabric participants, such as persistent actors
  and peer sessions, can subscribe to observe compaction transitions.
  Activity-only sessions with the mesh disabled silently skip this step.
- **Status query**: `compact.status()` gives the context-independent,
  in-memory record of the pending intent, the last commit, and the last
  threshold or headroom compaction (`lastAuto`) for the current initialized
  extension session. The record survives compaction itself. Extension
  reload, session replacement, process restart, and shutdown clear it.
  `owner` and the carry list are derived from the session log and survive
  all of these.

## Configuration

None required. Programmatic compaction is a first-principles primitive and
always available. Fabric defines no `compact` config block. The
model decides when and how to ask, and the host decides when to commit, so
safety needs no configuration. The optional `compaction.pressureBands` and
`compaction.outputReserveTokens` keys tune what `compact.pressure()` reports;
see [compaction](compaction.md#headroom-trigger).

## Files

| File | Role |
| --- | --- |
| `src/core/compact-controller.ts` | Pending-intent controller with `request`, `cancel`, `status`, and `maybeCommit`. Uses a single replaceable slot, typed preserve encoding, an in-flight guard, and a quiet clear on benign no-op outcomes (cancelled, already compacted, or session too small). |
| `src/providers/compact-provider.ts` | Fabric provider that exposes a bounded TypeBox-validated `request` (write, including optional `preserve: string[]`), `status` (read), `pressure` (read), `carry` (write), and `cancel` (write). Registered always, with activity audit. |
| `src/compaction/pressure.ts` | Pure pressure projection from Pi's context usage, the active model, and config. |
| `src/compaction/carry.ts` | Carry-forward entry codec, update semantics, and summary lines. |
| `src/compaction/owner.ts` | Compaction owner classification and the once-per-session ownership warning. |
| `src/compaction/claim.ts` | Compaction owner claim registry: one holder, token withdrawal, abort-signal and shutdown release, and the deterministic fallback. |
| `src/protocol.ts` | `pi-fabric:compaction-owner:v1` message types and the validating, field-copying reader. |
| `src/fabric-state.ts` | Constructs the controller with mesh-publish hooks, registers the provider, and resets on re-init or shutdown. |
| `src/index.ts` | Invokes `state.compact.maybeCommit(context)` in the existing `agent_settled` handler. |
| `src/agents/types.ts` | Extends `AgentSteerEntry["type"]` with `"compact"` and adds the optional `instructions` field. |
| `src/agents/manager.ts` | `compact(id, instructions?)` appends a compact entry through the steer channel and rejects Claude-runner children. |
| `src/worker.ts` | Feeds compact controls into the child boundary coordinator and observes Pi RPC lifecycle events. |
| `src/agents/compact-control.ts` | Coalesces child requests, waits for `agent_settled`, correlates the compact response with `compaction_end`, records the outcome, and gates one-shot stdin close. |
| `src/providers/agents-provider.ts` | `agents.compact({id, instructions?})` action (risk: agent) with activity audit. |
