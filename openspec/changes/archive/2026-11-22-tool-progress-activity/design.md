## Context

`effect/ai`'s `Toolkit.handle` returns a stream of `HandlerResult`s. Each value a handler passes to `ctx.preliminary` arrives as a result with `preliminary: true`, encoded with the tool's success schema (`encodedResult`). The final value follows with `preliminary: false`. `Agent.handleTool` keeps only the last non-preliminary result (`Stream.runLast(Stream.filter(results, (r) => !r.preliminary))`). It runs inside `memoTool`, which checkpoints the final `ToolStep`. A step's `ToolResult` events go out only after all of its calls finish. `AgUi.fold` projects `Agent.Event`s onto AG-UI events, and both runners consume the folded stream: `makeAttached` through a queue the run is forked into, and the detached and workflow runners by appending each event to the `EventLog`.

`effect/ai` defines `AgUiSchema.ActivitySnapshotEvent`, and TanStack AI renders it as a `role: "activity"` UI message whose part carries `activityType` and `content`. The message merges the event's `metadata`.

## Goals / Non-Goals

**Goals:**

- A handler reports progress with `ctx.preliminary` and nothing from this library.
- Progress stays correct across replay, a re-executed step and a resumed detached run, with no new checkpointed state.
- A slow consumer doesn't receive a backlog of stale progress.

**Non-Goals:**

- Throttling progress at the source. A handler that reports on every byte will still append every snapshot when the consumer keeps up. Pacing is the handler's job.
- Telemetry for progress (span events or attributes).
- An AG-UI mapping for `effect/ai`'s `LanguageModel` or `AgUiServer` paths. This only changes the library's own loop.

## Decisions

### 1. Use `ctx.preliminary`, not a library `Activity` service

Progress is the tool's preliminary result, typed by its `Success` schema. A tool whose progress differs from its result declares a tagged union.

- *Alternative: a per-run `Activity` service declared as a handler dependency.* It would allow arbitrary content and several activities per call, but it adds public API for needs the proposal puts out of scope. Both options produce the same `ToolProgress` event, so the service can be added later as a second source without changing this design.
- *Cost accepted:* the final value isn't narrowed to the "done" variant, so a handler can return a progress value as its result and the model will see it. The type system can't prevent that, so the docs state the convention.

### 2. An AG-UI-independent `ToolProgress` event in `Agent.Event`

```ts
| {
    readonly _tag: "ToolProgress";
    readonly step: number;
    readonly messageId: string | undefined; // the calling step's assistant message id; undefined for an approved call run in step 0
    readonly toolCallId: string;
    readonly toolName: string;
    readonly encodedValue: unknown;
    readonly replayed: false;
  }
```

`agent-run` is defined without AG-UI, so the event carries the encoded value and the ids, and `fold` decides how they look on the wire. `replayed` is always `false`, because a replayed call never runs its handler. The field exists so the existing `"replayed" in event` guards in `fold` treat the event the same way as the others.

`handleTool` changes from `runLast` to a fold over the stream. Each preliminary result calls `emit` with `ToolProgress`, and the last final result is kept as today. Emission happens inside `memoTool`'s effect, so a call served from the checkpoint store emits nothing, and nothing new is stored. `handleTool` needs the step number and the step's assistant message id, so `executeTool` takes them from its callers.

### 3. Activity id derived from the step's message id and the tool call id

The id is `` `${stepMessageId}:activity:${toolCallId}` ``, treated as opaque. An approved call executed in step 0 was made by an earlier run, whose step message id the prompt doesn't carry, so `ToolProgress.messageId` is `undefined` there and the id is `` `${approvalIdFor(toolCallId)}:activity` ``. The approval id is already the call's stable handle across runs, and it carries the same assumption that call ids aren't reused.

- The step's assistant message id is minted inside the model step's checkpoint. Tools run after the model step completes, so a step executed again because of a crash during a tool call replays the model step with the same id, and the second attempt's snapshots replace the first's.
- Step message ids are unique across steps and runs, and tool call ids are unique within a step. Together that handles providers that reuse call ids across turns, for calls made in the current run. The step-0 form for an approved call does not: it assumes tool call ids are unique within a thread, as approval ids already do.
- *Alternative: run id plus tool call id.* This breaks the rule that deterministic ids come only from the id generator, and it depends on client-supplied run ids.
- *Alternative: a freshly generated id.* It can't be minted inside a checkpoint that exists before the call completes, so a re-executed call would get a new id and leave a duplicate widget.

### 4. Wire shape

`fold` maps `ToolProgress` to:

```ts
{
  type: "ACTIVITY_SNAPSHOT",
  messageId: activityId,
  activityType: toolName,
  content: isJsonObject(encodedValue) ? encodedValue : { value: encodedValue },
  metadata: { "effect-agent-harness:toolCallId": toolCallId },
}
```

The event is attributed like any other, so a subagent's snapshot gets its `subagentRunId`. `replace` is left unset (AG-UI defaults it to `true`).

- *Why `metadata` for the call id:* `content` belongs to the tool, and putting a library field in it could collide with the tool's own fields. Every AG-UI event has `metadata`, and TanStack keeps it on the message. The key is prefixed because AG-UI asks producers to prefix keys they invent, and merges metadata key by key with the last write winning: an unprefixed `toolCallId` written by another party would silently replace the link. TanStack names its own keys the same way (`tanstack:interruptBinding`).
- *Why wrap rather than drop non-objects:* a `Schema.Number` progress counter is a reasonable tool, and AG-UI requires `content` to be an object.

`ActivitySnapshotEvent` joins `AgUi.Event`, so `EventLog` stores it, and `closeOpen` and the `resumed` handling ignore it because it opens no span.

### 5. Conflate superseded progress per chunk where each runner's backlog builds up

Two internal `Stream` operators (`AgUi.conflateProgress` for `Agent.Event`s, `AgUi.conflateActivity` for AG-UI events) work chunk by chunk. Within one chunk, a progress event or snapshot followed by a later one for the same call (keyed through any `Subagent` wrapping) is dropped. Everything else passes through in order.

A stream read through a queue (`Stream.callback`, `Stream.fromQueue`, both `Queue.takeAll`) delivers what piled up since the last read as one chunk. So this does nothing for a fast consumer, and for a slow one it shrinks exactly the backlog. The last event for a call is never dropped.

Placement:

- **Every runner (`agUiRun`):** `conflateProgress` directly on `Agent.run`'s output, before the per-step commits and the terminal `end`. On the detached and workflow paths each `append` holds the pipeline, so the backlog builds up in `Agent.run`'s own queue, here.
- **`makeAttached`:** `conflateActivity` after `Stream.fromQueue(queue)`. The run is forked and drains its stream into that queue at once, so the consumer's backlog builds up there.

- *Alternative: a `Stream.buffer` before `append` in the detached runners, then conflating AG-UI events.* The buffer would let the run's commits and its `end` (which releases the thread) run ahead of the log by the whole backlog, so a crash would more easily leave a released thread with a log that never ends.
- *Alternative: conflate inside `fold`.* Its chunks follow the per-element stages before it, so they hold one event, and it doesn't see `makeAttached`'s queue.
- *Alternative: a bounded `Toolkit.PreliminaryBuffer`.* That would block the handler, and handler speed isn't the problem. The problem is the consumer being slow.

### 6. The example

The `tanstack` example gains a server tool, for example `search-docs`, that reports `{ done, of }` progress with a short delay per item and returns its hits. The page renders `role: "activity"` messages whose `activityType` matches the tool as a progress card, and greys the card out once the result for the `metadata["effect-agent-harness:toolCallId"]` arrives.

## Risks / Trade-offs

- [A preliminary value that fails to encode is a defect, as a final one is today] → Preliminary values are typed by `Tool.Success`, so a mismatch takes a cast. The docs say so.
- [Tools that already call `ctx.preliminary` start streaming snapshots] → The change is additive on the wire, and clients that don't know activity ignore it. It's called out in the proposal's Impact.
- [`Agent.Event` and `AgUi.Event` gain members, which breaks exhaustive `switch`es in callers] → Callers will see compile errors, not wrong behaviour at runtime. The README changelog section notes it.
- [Emitting from inside a workflow activity] → The workflow checkpoint runs the memoised effect in-process, so `emit` reaches the run's queue as it does for the other checkpoints. A test under `Checkpoint.layerWorkflow` confirms it.
- [`effect/ai` later maps preliminary results to AG-UI differently] → The exact `effect` pin protects the repo. The convention (`activityType` = tool name, `metadata["effect-agent-harness:toolCallId"]`) is small enough to propose upstream or change later.
- [A widget left at "3/10" after cancellation or failure] → The client knows the call ended from `TOOL_CALL_RESULT` or the run's end, and finds the widget by `metadata["effect-agent-harness:toolCallId"]`. The library doesn't make up a final state, because it doesn't know the content's shape.

## Migration Plan

This is additive and needs no data migration. Rolling back removes the events. Logs already written may then hold `ACTIVITY_SNAPSHOT` events that the older `AgUi.Event` schema doesn't know, so an event log decoded with a strict schema would have to drop them.
