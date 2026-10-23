# Proposal

## Why

Today an effentic agent is stateless and request-bound: the client sends the whole history on every run, a run lives exactly as long as the HTTP response that streams it, and a crash or disconnect loses the run. That rules out production use where the server must own the conversation, a run must survive a deploy or crash without re-executing side-effecting tools, and a client must be able to reconnect to a run in progress. At the same time the agent's *behaviour* (system prompt, tools, step limit) must stay usable without any of that, for example in an eval harness or a unit test.

## What Changes

- **Agent behaviour becomes a plain value** that never names a durability mechanism. The same definition runs in production with every durability plane and in an eval with none, by swapping layers only.
- **The core loop takes a `Prompt` and emits step events**, not AG-UI events. AG-UI events and committed thread entries become two folds over that stream. **BREAKING**: `Agent.run` / `Agent.make` change signature; the AG-UI runner moves to a new module.
- **Plane 1, thread durability.** A `Thread` service loads the committed history for a thread, accepts per-step commits of new messages (idempotent by message id), and is told when a run ends. The server owns the history; the client's `messages` are reconciled as a delta (messages after the last stored id). The library knows nothing about compaction: whatever the caller returns from `load` is what the model sees after the agent's system prompt. **BREAKING**: a `Thread` layer is required to run over AG-UI; an in-memory layer is provided.
- **Plane 2, compute durability.** A `Checkpoint` service memoises named steps of a run. Each model call and each tool call is a separate checkpoint, so tool handlers run at most once per run even across a crash and resume. Implementations: passthrough (none), an arbitrary caller-supplied ledger, and `effect/workflow` activities.
- **Tool approvals via AG-UI interrupts.** A tool marked `needsApproval` ends the run with an `interrupt` outcome; the next run on the thread carries `resume` entries, the approved tool executes as a checkpointed step of that run, and the model continues.
- **Plane 3, stream durability.** An `EventLog` service stores the AG-UI events of a run with cursors and serves history plus live tail, so a client can reconnect. SSE frames carry the cursor as the SSE `id`.
- **Two runners at the transport edge.** The request-scoped runner keeps today's semantics (dropping the stream cancels the run). A detached runner starts the run in an engine- or caller-owned scope, returns immediately, and makes the run observable through the event log. Whether a disconnect cancels is therefore a choice of runner. **BREAKING** for the existing cancellation requirement, which now applies to the request-scoped runner only.
- Step boundaries are surfaced as AG-UI `STEP_STARTED` / `STEP_FINISHED` events.

## Capabilities

### New Capabilities

- `agent-run`: Running an agent's behaviour from a `Prompt` to a stream of step events, independent of AG-UI and of any durability plane: model steps, checkpointed tool execution, approval gating, step limit, replay marking.
- `thread-store`: Server-owned committed history per thread: loading history entries, idempotent per-step commits, run-ended notification, and the in-memory implementation.
- `run-checkpoint`: Memoising named steps of a run so they are executed at most once and replayed on resume, with passthrough, caller-ledger and `effect/workflow` implementations.
- `run-event-log`: Durable, cursor-addressed storage of a run's AG-UI events with history-plus-live subscription, and the in-memory implementation.

### Modified Capabilities

- `agui-agent-loop`: "Conversation history from the client" is renamed to "Thread history from the server store" and replaced by server-owned history with a client delta and history-mismatch rejection; tool approvals end the run with an interrupt outcome and are answered by `resume` entries; step events are emitted; tool calls execute through checkpoints.
- `agui-transport-edge`: "Cancellation when the consumer stops" is scoped to the request-scoped runner; a detached runner is added, including resume behaviour (no re-publishing of replayed steps, closing of spans left open by a crashed attempt); SSE encoding carries the event cursor as the SSE `id`; the run input decoder accepts `resume`.

## Impact

- `packages/effentic/src`: `Agent.ts` (core loop rewritten around step events and checkpoints), `AgUi.ts` (input `resume`, step and interrupt events, the AG-UI fold moved here from `Agent.ts`), `Messages.ts` (delta ingestion, resume entries, approval-aware repair), `Sse.ts` (SSE `id`), new `Thread.ts`, `Checkpoint.ts`, `EventLog.ts`, `Runner.ts`, and `index.ts` exports.
- `packages/effentic/test`: fixtures gain a tool-handler call counter and an approval tool; `Agent.test.ts` is split between core and AG-UI fold tests; new test files per new module.
- `packages/examples/ag-ui`: the route uses the new runner with the in-memory thread layer; a second route serves the event log for reconnects.
- Dependencies: no new packages. Uses `effect/workflow`, `effect/ai` (`disableToolCallResolution`, `needsApproval`, approval prompt parts) and `PubSub`, all already in `effect@4.0.5`. `@ag-ui/core@1.0.3` already defines `RunFinishedInterruptOutcome`, `ResumeEntry` and the step events.
- Public API: version `0.0.1`, breaking changes accepted. Both `openspec/specs` capabilities are modified.
