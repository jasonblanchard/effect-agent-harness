## Why

A user can't stop a run. A request-scoped run stops when its client disconnects, but it ends with no terminal event and no record in the thread. A detached or workflow run can't be stopped at all, short of closing the scope every run lives in. The TanStack example says so in two comments and offers no Stop button. AG-UI 1.0 now defines how a stopped run ends (`RUN_FINISHED` with the `cancelled` outcome, everything closed first), and TanStack AI's `stop()` can post to a cancel endpoint. So both ends of the wire are ready, and the library is the missing piece.

Interruption can't serve as cancellation here, because the library already uses it to mean "crashed, resume me later". A detached run that is interrupted keeps its thread claim and leaves its log open so that `start` can complete it. Cancellation has to be a separate signal that ends the run.

## What Changes

- **`Agent.run` can be cancelled.** `RunInput` gets an optional cancel signal. When the signal fires, the run stops its current model stream or tool calls and commits what it has so far. That means the step's partial assistant text, the real results of calls that completed, and a failed "cancelled" result for every other complete call. The run then ends with a new finished outcome, `Cancelled`. The signal is also checked before every step, so a run cancelled before it starts, or while crashed, ends at its next live step without calling the model. A tool handler protects a critical section with `Effect.uninterruptible`, and the run waits for that section to finish. **BREAKING**: `Agent.Outcome` gains a member.
- **Children are cancelled with their parent.** A running subagent ends `Cancelled` and commits its partial entries. Its spawning call gets the failed "cancelled" result, and AG-UI shows `SUBAGENT_ERROR` with code `Cancelled`, because AG-UI has no cancelled subagent outcome.
- **AG-UI projection.** A cancelled run closes every open message, tool call, reasoning span and step, then emits `RUN_FINISHED` with `outcome: { type: "cancelled" }` and no `result`.
- **The history records the cancel.** Under the server history, a cancelled run commits its partial step, tells the store `runEnded` with a new `Cancelled` outcome kind, and releases the thread. The next run on the thread is an ordinary new run. **BREAKING** for `Thread` implementations: the `runEnded` outcome gains a member.
- **The detached and workflow runners get `cancel({ threadId, runId })`.** Each delivers the request with the durability the runner already has, and no new service is added.
  - `makeDetached` returns `{ start, cancel }`. Its `cancel` signals a run it started in this process, live or crashed (a crashed run is cancelled when it is next started through the same runner). A cancel for a run it never started does nothing, so callers' ids can't grow its memory.
  - `makeWorkflow` adds a `cancel` that completes a durable deferred owned by the run's execution. It reaches the run on any host, including a run that has not started yet or is resumed after a crash.
- **Disconnecting an attached run cancels it.** When the consumer stops, `makeAttached` raises the run's cancel signal and drains the run to its terminal event in the stream's finalizer, for at most `cancelTimeout` (30 seconds by default), after which it interrupts the run and releases its claim. The thread therefore records the partial turn and a `Cancelled` end, where previously the attempt was abandoned without a record. The internal `abandonAttempt` remains only for that time-limit path.
- **Telemetry.** A cancelled run's root span is not an error.
- **Examples.** The TanStack example moves to a TanStack AI release that has `cancelUrl`. It adds `POST /api/chat/cancel` and a Stop button. The `ag-ui` example adds a cancel route next to `POST /runs`.

## Non-goals

- Cancelling detached runs across processes or across a process restart. A detached run already lives and dies with the process that runs it. `makeWorkflow` is the runner for runs that must outlive a process, and its cancel does.
- Detecting orphaned runs. A crashed detached run that nobody restarts stays non-terminal. Leases and heartbeats are a separate change.
- A per-tool cancel annotation. `Effect.uninterruptible` inside the handler covers this case.
- Showing "stopped" in restored history. The partial text is restored like any other assistant text.

## Capabilities

### New Capabilities

- `run-cancellation`: The detached and workflow runners' `cancel`, and how a cancel reaches a live, not-yet-started or resumed run on each.

### Modified Capabilities

- `agent-run`: Runs gain the `Cancelled` outcome, the cancel signal, and committing the partial step when a run is cancelled.
- `agui-agent-loop`: The run lifecycle allows the cancelled `RUN_FINISHED`. The run-ended notification and the claim release cover cancelled runs on every runner. A cancelled turn's partial message is known to the next run.
- `agui-subagent-events`: A child cancelled with its parent closes with `SUBAGENT_ERROR` code `Cancelled`.
- `agui-transport-edge`: An attached consumer stopping now cancels the run and records it. The detached and workflow runners gain `cancel`, and a re-executed run honours a pending request.
- `thread-store`: The store is told when a run is cancelled. This reverses the current "no notification" rule for a cancelled request-scoped run.
- `agent-tracing`: A cancelled run's root span does not have error status.

## Impact

- `packages/effect-agent-harness/src`:
  - `Agent.ts`: the cancel signal, the `Cancelled` outcome, and partial-step entries.
  - `AgUi.ts`: `fold` emits the cancelled outcome and the subagent error code.
  - `Runner.ts`: `cancel` (an in-process registry for detached runs, a `DurableDeferred` for workflow runs) and attached drain-on-stop.
  - `internal/history.ts`: the `Cancelled` end, with `abandonAttempt` removed.
  - `Thread.ts`: the outcome kind.
  - The module and package `AGENTS.md` docs.
- Public API breaks: `Agent.Outcome` and `Thread` `runEnded`'s outcome. `makeDetached`'s and `makeWorkflow`'s results gain `cancel`, which is additive.
- `packages/examples/tanstack`: bump `@tanstack/ai` and `@tanstack/ai-react` from 1.0.0 to the latest (1.7.0 and 1.1.0; `cancelUrl` first shipped in `@tanstack/ai-client` 1.1.0), excluded from pnpm's release-age quarantine, and add the cancel route and a Stop button.
- `packages/examples/ag-ui`: add a cancel route.
