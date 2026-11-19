## Context

See proposal.md for why. The constraint that shapes everything here is that the library already gives fiber interruption a meaning. For `makeDetached` and `makeWorkflow`, an interrupted attempt is a crash. It keeps its thread claim, leaves its log open, and is completed by the next `start` (`detached` in `Runner.ts` closes the open spans with `AgUi.closeOpen`). For `makeAttached`, interruption means the consumer left, and the internal `abandonAttempt` releases the claim without telling the store anything. Neither path emits a terminal event or keeps what the step produced.

`Checkpoint` stores only completed exits, so an interrupted step leaves no checkpoint and its ids are unused. AG-UI 1.0 (pinned in `schema/ag-ui-1.0.json`) has `RunFinishedCancelledOutcome` but no cancelled subagent outcome.

## Goals / Non-Goals

**Goals:**
- One cancellation path, shared by every runner, from `Agent.run` up. The runners differ only in where the signal comes from.
- Cancellation is in-band. The run emits its own terminal event, so `fold`'s closers, `attempt.end` and the "streams never fail" invariant all apply unchanged.
- Each runner's cancel is exactly as durable as its runs. A detached cancel is in-process, like the run. A workflow cancel is held by the engine, like the run.
- No new public service or layer requirement.

**Non-Goals:**
- Lease or heartbeat detection of orphaned runs (see Risks).
- Cancelling a run that is waiting on an approval or a frontend tool. Such a run has already ended with `RUN_FINISHED`, and the client gives up by answering the interrupt with `cancelled`, which is already supported.
- A cancel endpoint in the library. Routes are the application's, as with `start`.

## Decisions

### 1. The signal is an `Effect<void>` on `Agent.RunInput`, not a service

`RunInput` gains `cancelled?: Effect<void>`, an effect that completes when cancellation is requested. `Agent` stays independent of runners and stores. An eval or test passes a `Deferred.await`. The detached runner passes its registry entry's `Deferred.await`, and the workflow runner passes the run's `DurableDeferred` (decision 5). The signal is not part of `RunInfo`, because tool handlers have no business reading it: they see cancellation as interruption.

*Alternative*: a `CancelSignal` service in the run's context. Rejected, because it would leak into `Requirements` typing and invite tools to poll it.

### 2. The step races the signal, and the run reports the outcome

Each step's work (model stream, then tool handlers, then subagent calls) runs in a fiber that is raced against the signal. When the signal wins, that fiber is interrupted, which respects `Effect.uninterruptible` regions in handlers. This is the only per-tool control (Option A from exploration; no annotation). The loop then builds the cancelled step's entries and emits `StepFinished` followed by `Finished { outcome: { _tag: "Cancelled" } }`. Before each step, the loop also checks whether the signal has already completed, which covers "cancelled before start" and "cancelled while crashed" with no runner-specific code. Replayed steps still replay first, because a replay runs no handlers and publishes nothing.

The race sits **outside** each checkpoint (`model:<step>`, `tool:<toolCallId>`), never inside its body. The spike (task 1.1) found that a workflow activity whose body ends interrupted is retried by the engine (`Activity`'s `retryOnInterrupt`, up to 10 attempts, then a defect), so a body must never interrupt itself. Interrupting the fiber that awaits the checkpoint, from outside, does interrupt the activity's handler, and stores nothing, on every `Checkpoint` layer. A checkpoint's body also checks the signal when it starts: if the signal has fired, the body blocks instead of running, and the outer race interrupts it. A step stored by an earlier attempt therefore still replays with its real result, while one that isn't stored never starts its handler.

An uninterruptible region in a handler runs to completion before the run ends, so its side effect is never torn. The call keeps its real result only if the whole tool execution finished. The toolkit's own steps after the handler are interruptible, so a handler that wraps only its side effect in `Effect.uninterruptible` gets the failed "cancelled" result. That was verified in the spike, and a per-tool annotation that would change it is a non-goal.

Subagents get the same signal. A child that is cancelled ends `Cancelled`, and `callSubagent` maps that to the call's failed "cancelled" result. That result is not memoised: the parent is ending, and memoising it would turn a later replay into a fake result.

### 3. Partial entries come from a step accumulator

The loop already collects a step's response parts to build the assistant entry when the step finishes. That buffer becomes something the cancel path can read: the parts seen so far, the tool calls whose `tool-call` part arrived (input complete), and the results that completed. The cancelled entry reuses the step's assistant message id (minted in the `model:<step>` checkpoint's attempt), so the client's copy of the partial message is known on the next run. Complete calls with no result get the same failed-result shape that `Messages.project` gives unanswered calls, with text naming "cancelled".

The commit happens outside any checkpoint. That's safe because a cancelled run is terminal and never replays. A run killed between committing the partial step and writing its terminal is the one gap. A restart then sees the request and ends cancelled. The partial entries are already stored, and the commit is idempotent by id, so nothing is duplicated.

### 4. No cancellation service: each runner uses the durability it already has

An earlier draft added a pluggable, durable `Cancellation` store that both runners required. It was dropped, because it gave the detached runner a durability its runs don't have and duplicated what the workflow engine already provides.

- `makeDetached` forks runs into a scope in this process, and supervising them is already the caller's concern. Its cancel lives in the same place.
- `makeWorkflow` exists for runs that outlive a process, and `effect/workflow` already has a durable, externally completable signal, `DurableDeferred`.

*Alternative kept for later*: if multi-host detached runs are ever wanted, a store can come back as an option of `makeDetached`, without changing `Agent` or `fold`.

### 5. Runner API

Both runners take `cancel: ({ threadId, runId }) => Effect<void>`, by ids rather than the input, because a cancel route only has ids.

- **`makeDetached`** keeps a private registry, `Map<key, Deferred<void>>`, keyed by `JSON.stringify([threadId, runId])`, like the workflow idempotency key. Only `start` adds entries, so the ids a caller passes to `cancel` can't grow it (review finding: the cancel route takes ids from the client).
  - `start` takes the existing entry, or creates one, before its first read of the log, so a cancel that arrives while it reads still reaches the run, and passes its `await` as the signal. If the read fails, it removes only an entry it created. A cancel made while an attempt was down therefore pre-fires the signal of the restart through the same runner.
  - When an attempt ends with a terminal event or fails, it removes its entry (`onExit`). An attempt interrupted without a terminal keeps its entry, so a later restart sees a cancel made in between.
  - `cancel` completes the run's entry if there is one, and does nothing otherwise, without reading the log. A cancel for a run this runner hasn't started is therefore not kept: "cancel before start" is a workflow-only guarantee. A cancel that lands after the terminal event but before the entry is removed completes a signal nobody reads.
- **`makeWorkflow`** defines one `DurableDeferred` (for example `${name}/cancel`, `Schema.Void`).
  - `cancel` computes the execution id from the ids alone. The engine hashes the workflow name and the idempotency key, which is built only from `[threadId, runId]`, so the dependencies aren't needed, unlike `executionId(input)`. `Workflow.executionId` validates the whole payload, including the dependencies, so `cancel` asks a second workflow value for the id: same name and idempotency key, payload `{ input }` only, never registered. It then calls `DurableDeferred.succeed` with `tokenFromExecutionId`.
  - The body first reads the deferred without waiting (`WorkflowEngine.deferredResult`). If it is done, the run gets an already-fired signal. Otherwise the run's signal is an in-memory `Deferred`, completed two ways. `cancel` records the durable result and then completes the signal of the run this runner value is executing, if any, through a private `Map` keyed like the detached registry, so a cancel through the same runner is immediate. A fiber raced beside the run polls `deferredResult` every `WorkflowOptions.cancelPollInterval` (1 second by default), so a cancel made through another runner value, such as on another host, reaches the run within that interval.
  - The run never awaits the deferred durably. Completing a `DurableDeferred` that a running execution awaits makes the engine interrupt and replay it (documented on `DurableDeferred.into`). The interrupted step is then lost as a crash's is, and the replay takes the already-fired path, so a cancel during streaming dropped the partial turn. (The first version raced `DurableDeferred.into(run, ${name}/ended)` against `DurableDeferred.await(cancel)` and hit exactly this; a bare `await` in a forked fiber also suspends the instance at its next activity, per the spike.) Reading without awaiting registers nothing, so a completion only queues a wake, which the engine drops once the run is `Complete`.
  - A resumed execution sees a cancel made while it was down through the first read, on every replay.
  - The engine keeps a `DurableDeferred` completed before its execution exists (in-memory engine: results are keyed by execution id and name), so a cancel before start is honoured.
  - It does not use `workflow.interrupt`: engine interrupt can't be told apart from a shutdown inside the body in time to write a terminal event, and it would skip the history's `end`. Engine-level `interrupt` stays available through `workflow` for callers who want a hard stop.

### 6. An attached run is cancelled by its consumer stopping, and drains in the finalizer, within a time limit

`makeAttached` forks the run's event stream into a fiber it owns and hands the consumer a stream reading from it through a queue. When the consumer stops before the terminal event, the finalizer completes the run's own `Deferred` signal and joins the fiber, discarding its events. The run therefore goes through the same `attempt.end` path, committing the partial step, calling `runEnded(Cancelled)` and releasing the claim. The finalizer waits for the run for at most `AttachedOptions.cancelTimeout` (30 seconds by default). The signal reaches only model and tool checkpoints, not the store's claim, load, commits, `runEnded` or `release`, nor an uninterruptible handler region. So a run still going after the limit is interrupted without waiting for it, and the internal `History`'s `abandonAttempt` releases its claim without a run-ended notification, as before this change. The run is forked detached (`acquireRelease` + `forkDetach`), not into the stream's scope, because the scope's own finalizer would wait for the fiber, and so would a plain `Fiber.interrupt`: an uninterruptible region still running finishes on its own, and the run commits nothing after it. A hung store therefore can't hold a disconnected request, or a shutdown, for ever (review finding). The events go through an unbounded queue: the finalizer waits for the run without reading, so a bounded queue would block the run's next write.

*Alternative*: keep interruption and finalize from outside the run. Rejected, because the finalizer would have to rebuild the partial step from AG-UI events, duplicating decision 3.

### 7. Projection

`Agent.Outcome` gains `{ _tag: "Cancelled" }`. `fold` maps it to `RUN_FINISHED` with `outcome: { type: "cancelled" }` and no `result`. It emits the closers before it, using the same span bookkeeping it already uses before `RUN_ERROR`. A child `Finished { Cancelled }` maps to `SUBAGENT_ERROR` with `code: "Cancelled"` and a message saying it was cancelled. `isTerminal` needs no change. `Thread.runEnded`'s outcome kind gains `Cancelled`. `traced` ends the root span with a success exit for it.

## Risks / Trade-offs

- **[A detached cancel is lost if the process dies, or if it lands on another host]** → This is documented on `makeDetached`'s `cancel`, with the advice to use `makeWorkflow` when runs must be cancellable across hosts or restarts. The TanStack and `ag-ui` examples are single-process.
- **[A crashed detached run that nobody restarts stays busy]** → This is unchanged from today. The existing rule that "supervising runs is the caller's concern" applies, and leases are a follow-up.
- **[Awaiting a `DurableDeferred` inside a running execution suspends or preempts it]** → Spike (task 1.1): a bare await in a forked fiber suspends the run at its next activity, and completing an awaited deferred interrupts and replays the run, which loses the step in progress. The run therefore only reads the deferred (decision 5): at once through the same runner value, and within `cancelPollInterval` from another one. The poll costs one engine read per interval per running execution.
- **[`DurableDeferred.succeed` for an execution that doesn't exist yet]** → Spike: the in-memory engine keeps it, so cancel before start works.
- **[An uninterruptible handler delays the terminal event, and for attached runs also the consumer's close]** → This is intended: it's the price of not tearing side effects. It is documented next to the `failureMode: "return"` advice, together with the fact that the call's result is kept only if the whole tool execution finished (decision 2).
- **[Interrupting a tool handler inside a workflow activity]** → Spike: interrupting from outside the activity works and stores nothing. Interrupting from inside the activity's body makes the engine retry it, so the race is outside every checkpoint (decision 2).
- **[TanStack AI's `cancelUrl` version]** → Spike (task 1.3): `cancelUrl` first ships in `@tanstack/ai-client` 1.1.0, which `@tanstack/ai-react` 1.0.2 uses. The example moves to the latest (`@tanstack/ai-react` 1.1.0, `@tanstack/ai` 1.7.0). Those were published inside pnpm's release-age quarantine, so they are listed in `minimumReleaseAgeExclude`: the example works against the latest TanStack AI on purpose. The library doesn't depend on it.
- **[TanStack's own server ends a stopped run with `RUN_ERROR`]** → We follow AG-UI with a cancelled `RUN_FINISHED`. Spike: the client special-cases only the `interrupt` outcome, so `cancelled` ends the turn like a finish, not an error. The example task checks this in the browser.

## Migration Plan

These are breaking API changes, released together:
- Handle `Cancelled` in any exhaustive switch on `Agent.Outcome` or on `Thread`'s `runEnded` outcome.
- Custom `Thread` implementations must accept the new outcome kind.
- A workflow run started before this change has no cancel deferred to await, but awaiting a deferred that is never completed is harmless, so in-flight executions resume normally.
