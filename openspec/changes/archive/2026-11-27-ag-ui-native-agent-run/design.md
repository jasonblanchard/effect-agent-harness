## Context

See proposal.md for the motivation. The current pipeline is:

```
Agent.run ──Agent.Event──▶ conflateProgress ─▶ tap(StepFinished → attempt.commit) ─▶ failInBand
          ─▶ mapEffect(Finished|Failed → attempt.end) ─▶ AgUi.fold(input, { resumed }) ─▶ traced ─▶ AG-UI
```

The constraints that shape the new design:

- `Agent.run` is a `Stream.callback` over an **unbounded** queue ([Agent.ts](../../../packages/effect-agent-harness/src/Agent.ts), `run`). The loop already runs ahead of its consumer, and its `model:<step>` and `tool:<id>` checkpoints can be stored before their events reach the event log.
- `fold` holds four kinds of state: per-owner step and span state (`StepState`, `levels`); subagent lifecycle (`open`, `closed`, `replayed`, `awaitingResult`); the replay decision (`published`, from the `resumed` log); and the terminal mapping (outcome to `RUN_FINISHED` / `RUN_ERROR`). Each has to land somewhere.
- `history.end` must run after every earlier event has gone downstream and before the terminal event is emitted. It releases the claim, and it can replace the terminal event with `RUN_ERROR ThreadError`.
- `traced` needs the failure's original error to end the root span with `Exit.fail(error)`.
- Effect's `AgUiServer.agentHandler` captures its context once, when the `HttpApiBuilder.group` is built. Per-request services, such as an authenticated principal, don't reach an agent served that way.

## Goals / Non-Goals

**Goals:**
- `Agent.run: Stream<AgUiSchema.Event, never, Requirements>`. The loop emits 21 of the protocol's event types; there is no narrower union, because nothing relied on one, and a second name for the same events is what this change removes. The loop emits each event where it already holds the state.
- Wire behaviour stays identical to today's `fold` output, apart from the additions in the specs (`usage`, `FrontendToolConflict`). Every existing `verify`-based sequence test keeps passing against the new output.
- After the change, `fold` doesn't exist in any form. A thin runner-side filter (`publish`) is all that remains between the loop and the wire.

**Non-Goals:**
- Changing the thread store, the checkpoint keys or the event log format.
- Reusing effect's `AgUi.fromStreamParts`. Its message ids come from the provider, it derives no reasoning ids and it emits no activity.
- Middleware or hooks over the event stream. That's a separate change, deferred, though it would naturally sit on AG-UI events after this one.

## Decisions

### 1. The element type is exactly `AgUiSchema.Event`

Alternatives considered:
- **(a) Keep `Agent.Event`.** This is the status quo, with two vocabularies.
- **(b) A typed `Control` member** (`Commit | Failure`) in the stream. It's honest, but every consumer of `Agent.run`, evals included, then has to filter it, and anything that serves the stream raw can leak it.
- **(c) Entries in `metadata`.** Entries aren't JSON-safe (`Uint8Array`, `URL`), so `AgUiServer.handler`'s `normalizeEvent` round-trip would fail or mangle them. They would also leak reasoning signatures and subagent transcripts.

Runner state therefore leaves the stream through services (decision 2) and the span (decision 3). The one exception is the replay marker (decision 5), which is tiny and safe for clients.

### 2. Entries go through an internal `OnStepFinished` hook, called by the loop

`OnStepFinished` is a `Context.Reference<(entries: ReadonlyArray<Messages.Entry>) => Effect<void, unknown>>` whose default does nothing. It lives in `src/internal/` and is **not exported** from the package. It links the loop to its runner and to its parent run, and isn't an extension point:
- Evals assert on AG-UI events. An eval that checks what is stored runs through a runner with `History.layerServer` over `Thread.layerMemory` and reads the thread back with `History.restore`.
- Custom persistence is done by implementing `Thread`.
- Keeping the hook private leaves its signature free to change, for example if a step later needs to pass more than its entries.
- The library's own tests import it from the internal path.

The loop calls it with the step's entries **after** the step's last content event and **before** `STEP_FINISHED`. That is the same place the runner's `tap` committed before.

- **Replayed steps call it too.** Thread commits are idempotent, and an earlier attempt may have stopped before committing. Today a replayed `StepFinished` is committed in the same way.
- **The call sits outside every checkpoint, and outside `guard`.** A cancel must not tear a commit. A hung store is bounded by `makeAttached`'s `cancelTimeout`, as it is today.
- **A failure** becomes the run's failure: `RUN_ERROR` with `errorCode(error)`. `ThreadError` keeps its tag, so the "Commit fails mid-run" scenario is unchanged.
- **Subagents.** `callSubagent` runs the child with an `OnStepFinished` that appends to the parent step's child-entry buffer, tagging each entry with `subagentIdFor(toolCallId)` unless a deeper owner has already tagged it. The child never reaches the store on its own. This replaces collecting the child's `StepFinished.entries`.
- **The runner** provides `OnStepFinished` from `attempt.commit` inside `opened`, alongside the per-run services.

There is a trade-off. Today the loop never waits for a commit: the runner commits downstream, behind the unbounded queue. Now the next model call waits until the step is committed. This is slower by one store write per step, and stricter: a thread can no longer fall a step behind the loop. Commits can now run ahead of the event log, but the checkpoints already do, so this adds no new failure mode. A crash between a commit and the log append leaves a log that a resumed attempt completes through `closeOpen`, exactly as it does after a checkpoint today.

Alternative considered: keep the commit in the runner, keyed on `STEP_FINISHED`. The entries would then have to travel with the event, which brings back decision 1's options (b) or (c).

### 3. The terminal event drives `end` and `traced`, and the cause goes to an internal hook

- **`history.end`** takes the AG-UI terminal event. Its outcome tag comes from `RUN_FINISHED.outcome.type` (`success`, `interrupt`, `cancelled`) or from `RUN_ERROR.code`. Its signature becomes `(terminal: RunFinishedEvent | RunErrorEvent) => Effect<RunFinishedEvent | RunErrorEvent>`, keeping its power to replace the terminal event with `RUN_ERROR ThreadError`. It still runs in the runner, on the terminal event, so ordering against the log is unchanged.
- **The error cause.** Before it emits `RUN_ERROR`, the loop hands the original `Cause` to an internal hook, `OnRunFailed` (`internal/hooks.ts`, next to `OnStepFinished`). So do the runner's own failures (`failInBand`: claim, load, the per-run layer, a refused input) and `history.end` when it replaces the terminal event with `RUN_ERROR ThreadError`. `traced` sets the hook: it logs the cause and keeps it, then ends the root span with `Exit.failCause(cause)` and `error.type` taken from `RUN_ERROR.code`. An exporter (`OtlpTracer`) turns that exit into the span's one `exception` event, with the original error's type, message and stack, as `main` did. Nothing adds an `exception` event by hand, which would record the error twice. Without a runner (an eval), the hook's default logs the cause. A parent sets the hook on its subagent to keep the cause without logging it, and ends the `invoke_agent` span with it: the parent reports the failure as a failed tool result, so only a top-level run logs at error level.

### 4. Where `fold`'s state lands

| `fold` state | New home |
|---|---|
| `StepState`, `handlePart` (text, reasoning and tool spans; derived reasoning ids) | `internal/events.ts`: a per-step emitter the model step creates and drives with each part. `close()` serves step end, failure and `cancelStep`. |
| per-owner `levels` | gone: each run, a child's included, owns only its own steps |
| `ToolProgress` → `activitySnapshot`, closing an open `TOOL_CALL_START` first | `handleTool`, through the step emitter, so it can close the call |
| subagent `open`/`closed`, `SUBAGENT_STARTED` on the first live event | `callSubagent` (see below) |
| `awaitingResult` (holding `SUBAGENT_FINISHED` until the parent's result) | gone: the parent emits a step's results together once its calls finish, so it emits `SUBAGENT_FINISHED` right before that call's `TOOL_CALL_RESULT` |
| `published` (decided from `resumed`) | the runner's `publish` (decision 5) |
| `Finished`/`Failed` → terminal | the loop, which builds `RUN_FINISHED` (with `approvalInterrupt`, `pendingToolCallIds`, `usage`) and `RUN_ERROR` |

The AG-UI builders (`runStarted`, `toolCallResult`, `activitySnapshot`, `approvalInterrupt`, `reasoningMessageId`, …) live in `internal/events.ts`. `History.restore` and the loop share them, which keeps the rule "what the run streams is what `restore` returns" true by construction. They are not public, and there is no `AgUi` module: the run's events are typed as `effect/ai`'s `AgUiSchema.Event`, and `Agent` re-exports the rest of the client contract (`ApprovalResponse`, `isTerminal`). The runners' operators, `closeOpen`, `conflateActivity` and `publish`, live in `internal/publish.ts`.

**Subagents.** `callSubagent` consumes the child's `Agent.run` stream:
- **Before forwarding**, it attributes each event. A `SUBAGENT_*` event that lacks `parentSubagentRunId` gets the child's id there. Any other event that lacks `subagentRunId` gets the child's id. Events a deeper descendant already attributed are left alone, which gives nesting at any depth.
- **The child's `RUN_STARTED`** is dropped. `SUBAGENT_STARTED` (name, description, `parentToolCallId`, `parentMessageId`) is emitted before the child's first forwarded event, or before its closing event if it forwards none. It carries the replay marker when that first event does.
- **The child's terminal event** becomes the call's outcome. For a failure it is `SUBAGENT_ERROR` (code `Cancelled` for a child cancelled with its parent), emitted at once. A suspension is `SUBAGENT_FINISHED suspended`, with the `interruptIds` of the interrupts that have no `subagentRunId`, also emitted at once. A success is `SUBAGENT_FINISHED success` with the result, emitted by the parent next to the call's result. The child's `usage` is added to the parent's total.
- **A child's replayed work is forwarded marked.** The child marks its replayed `TOOL_CALL_RESULT`s and its own subagents' lifecycle events, and the parent forwards them as they are. A child that replayed something and emitted no live event has its `SUBAGENT_STARTED` and closing event marked too. The runner's `publish` (decision 5) decides what of that goes out. The child always runs again: the parent's `tool:<id>` memo holds the outcome for the parent's checkpoint, and the child's own steps replay from their checkpoints.

### 5. Replay: the loop marks, the runner decides

The loop emits nothing for replayed work except a replayed `TOOL_CALL_RESULT`, a subagent's forwarded replayed results, and the `SUBAGENT_STARTED` and closing event of a subagent that emitted nothing live. Each carries `metadata["effect-agent-harness"] = { replayed: true }`. A private runner operator, `publish(resumed)`, sits where `fold` was. The runner drops the loop's `RUN_STARTED` and prepends its own, so a run that fails before the loop starts still opens with one; with a `resumed` log, the detached runner leaves it out when the log has it.

- **No `resumed` log** (attached runs, a first detached attempt): every marked event is dropped. Today's `published === undefined` behaves the same, and the `awaitingResult` exception is gone with decision 4.
- **With `resumed`:**
  - A marked `TOOL_CALL_RESULT` goes out if the log has no result for that `toolCallId`, or if it belongs to a subagent whose closing goes out in this attempt (`awaiting`: the subagent's results come before its closing).
  - A marked closing event goes out if the log opened that subagent and didn't close it (today's `subagentsIn`), or if this attempt started it.
  - A marked `SUBAGENT_STARTED` is held, and goes out just before the first of that subagent's events that goes out. One whose subagent sends nothing is never published.
  - A subagent the log left open and this attempt doesn't close is closed before `RUN_FINISHED`.
- **In every case**, it removes the `effect-agent-harness` key (and `metadata` itself if that leaves it empty) from every event it lets through.

`closeOpen(resumed)` is still prepended by the detached runner before the attempt's events, as today.

### 6. Usage

`ModelStep` gains `usage: Schema.optionalKey(Usage)`, built from the step's `finish` part. A replayed step counts what its checkpoint holds, and a checkpoint written before this change counts nothing. A subagent call's memoised outcome (`Result` and `Suspended` in `ToolStep`) gets no usage field. The child always runs again and replays its own model steps, so its usage comes back on its terminal event. Storing it in the outcome too would count it twice. If the parent ever skips the child on a memo hit, the outcome must gain the field. The loop sums usage the same way `AgUiServer.makeRunSummary` does, including `totalTokens` from input plus output, and sets one `usage` entry on `RUN_FINISHED` and on `RUN_ERROR` when any count exists. A cancelled step has no `finish` part and counts nothing.

### 7. The `AgUiServer.Agent` adapter

`Runner.toAgUiServerAgent(agent, options?)` is an adapter, not a runner. It takes the same options as `makeAttached` and returns an `AgUiServer.Agent<Requirements<…>>`. Its `run(input)` first checks `input.tools` against the toolkit's names and the subagent names, failing with `HttpApiError.BadRequest`, then succeeds with `makeAttached(agent, options)(input)`. It works with `layerHttp({ agent })` and `agentHandler`. The 400 is the only thing it adds: a plain stream can report a clash only in-band, while Effect's `Agent.run` returns `Effect<Stream, BadRequest>` and can reject before the stream opens.

It also gives something up. `agentHandler` captures its context once, when the group is built, so runs served through the adapter see only those services, never per-request ones such as an authenticated principal. Its doc comment and robodocs say so plainly, and send applications with per-request services to `endpoint` + `handler((input) => run(input))` over `makeAttached`.

Alternatives considered:
- **No adapter.** Users write `{ run: (input) => Effect.succeed(attached(input)) }` themselves. That's one less name, but the drop-in becomes a recipe rather than a call, and the clash stays in-band.
- **A `.agent` property on `makeAttached`'s returned function.** That avoids a new name, but it hides the context caveat behind a property of a different serving style.
- **Naming it `make*`,** as the runners are named. That would suggest a third kind of runner. The `to` prefix says it converts.

Tools see the run input as decision 9 describes.

`Agent.run` makes the `FrontendToolConflict` check too, emitting `RUN_STARTED` then `RUN_ERROR` before step 0. Runners that aren't served through `toAgUiServerAgent` (`handler((input) => run(input))`, detached, workflow) report the conflict in-band that way.

### 8. Overlap with `interrupt-metadata`

That change applies its `interruptMetadata` hook inside `fold`. After this change, the hook applies in `publish`, on the `RUN_FINISHED` interrupt outcome, which is simpler because nothing else in `publish` builds interrupts. Whichever change lands second moves the hook.

### 9. One run service: `AgUiServer.RunInput` replaces `CurrentRun`

`Agent.run(agent, { input, prompt, subagentPrompts?, cancelled? })` takes the run's `AgUiSchema.RunAgentInput` and provides it as `AgUiServer.RunInput` exactly where it provides `CurrentRun` today: around the system prompt, the volatile system prompt, approval predicates and tool handlers. `CurrentRun`, `RunInfo` and `FrontendTool` are deleted.
- **What it derives from the input:**
  - `threadId`/`runId` for checkpoint keys, spans and terminal events;
  - `forwardedProps` as the props;
  - `input.tools` as the frontend tools (the runner's `frontendTool` mapping, including the empty-object default for a tool without `parameters`, moves into `Agent.run`).
- **`RunInput` is excluded from `Requirements`**, as `CurrentRun` is today, so neither runners nor evals provide it.
- **Subagents** run with the parent's `input`. `callSubagent` withholds frontend tools from children by passing the child an empty tool list rather than a separate parameter.
- **`prompt` stays a separate argument.** It is the projected conversation, memoised as `prompt`. The loop never reads `input.messages`. Under the server history that holds only the client's delta, and the robodocs note on `RunInput` says so.
- **The runners already hold the input**, so `agUiRun` passes it through: `makeWorkflow`'s payload, `makeDetached`'s `start`, and the input fingerprint check are all unchanged.

Alternatives considered:
- **Keep both services.** That means two names for one fact, and a tool has to choose between them.
- **Keep `CurrentRun` and drop `RunInput`.** Tools written for `effect/ai`'s agent then wouldn't port unchanged, and the drop-in claim would be incomplete.
- **Make `CurrentRun` an alias with the same key.** That keeps two names, and a service key is the identity, so an alias adds nothing.

Trade-offs:
- Handlers can now see `messages`, `state` and `context`, all of which the client controls. Nothing becomes more trusted: `props` was already untrusted, and the rule that trusted data arrives only through runner-provided services is unchanged.
- Evals construct a full input. A public helper to build one with defaults, or `AgUiSchema.RunAgentInput.make` if its defaults suffice, keeps that to one line.

### 10. Failed results use `effect/ai`'s marker

`toolCallResult` takes `isFailure` and, when it is set, adds `metadata: { "effect/ai": { isFailure: true } }`, the exact shape `AgUi.fromStreamParts` emits and `AgUi.toPrompt` reads. One private `isFailedToolMessage(message)` (`error` set, or the marker) in `internal/conversions.ts` is used by both `fromHistory` and `answers`. `restore` builds failed tool messages through the same `toolCallResult` encoding plus `error`, so the live and restored shapes come from one place.

The marker lives under `effect/ai`'s key, not ours, so `publish` (decision 5), which strips only `effect-agent-harness`, leaves it alone. A replayed failed result carries both keys until `publish` removes ours.

Alternatives considered:
- **A marker under `effect-agent-harness`.** Clients and effect's `toPrompt` wouldn't recognise it, which loses the drop-in round trip.
- **Keep relying on `restore`'s `error`.** That leaves live clients sending failures back as successes, the gap this closes.

## Risks / Trade-offs

- [`Agent.ts` grows past its current ~1,700 lines] → The emission state machine, the builders the loop uses and the subagent attribution go into `internal/events.ts`. `Agent.ts` keeps the control flow.
- [A step now waits for its commit before the next model call] → This is accepted and intended (decision 2). It costs one store round trip per step.
- [Wire regressions while moving `fold`'s logic] → The existing `AgUi.test.ts`, `Subagents.test.ts` and `Cancellation.test.ts` sequence assertions are ported first and kept byte-for-byte where they compare events, so a difference in output fails a test.
- [Serving `Agent.run` raw could leak the replay marker] → It appears only on re-execution with a durable checkpoint store, which only runners set up. The marker is a boolean, holds no data, and passes `normalizeEvent`.
- [`layerHttp({ agent })` can't see per-request services] → This is a limitation of effect's `agentHandler`. It is documented, and `endpoint` + `handler` remains the recommended route for authenticated apps.
- [Breaking changes for `Agent.Event` consumers] → The project is pre-1.0. The robodocs "Testing and evals" section gains a migration table from each old event to its AG-UI counterpart.

## Migration Plan

This is a single change with no data migration. The new checkpoint fields are optional, so in-flight runs replay across a deploy (the steps they replay report no usage). Event log entries keep their format. To roll back, revert the change: checkpoints written with `usage` still decode under the old schema, because unknown keys are ignored when a struct is decoded.

## Open Questions

- The final name of the `internal/events.ts` module. Renaming any of them changes no spec or task.
