## 1. Spikes

- [x] 1.1 Workflow spike with the in-memory engine. Check three things: (a) whether a step can be raced against awaiting a `DurableDeferred` without suspending the execution; (b) whether `DurableDeferred.succeed` before the execution exists is kept for it; (c) whether the body can interrupt a tool handler inside an activity. Update the `run-cancellation` workflow scenarios and design decision 5 if any answer is no.
- [x] 1.2 Check that the execution id computed from `[threadId, runId]` alone matches `executionId(input)` for a runner with dependencies
- [x] 1.3 Find the first `@tanstack/ai-client` release with `cancelUrl` and check how it renders `RUN_FINISHED` with outcome `cancelled`

## 2. (Removed: the cancellation store was dropped; see design decision 4)

## 3. Agent

- [x] 3.1 Add `cancelled?: Effect<void>` to `RunInput` and `{ _tag: "Cancelled" }` to `Agent.Outcome`
- [x] 3.2 Check the signal before each live step (after replays) and end `Cancelled` without calling the model
- [x] 3.3 Race each step's work against the signal; on cancel, interrupt it and end with `StepFinished` then `Finished { Cancelled }`
- [x] 3.4 Keep a step accumulator, and build the cancelled step's entries from it: partial text and reasoning under the step's message id, complete calls, real results for completed handlers, a failed "cancelled" result for the rest; drop incomplete calls
- [x] 3.5 Pass the signal to subagent runs; map a child's `Cancelled` to the call's failed "cancelled" result without memoising it; tag the child's partial entries
- [x] 3.6 Agent tests for every `agent-run` scenario, including an `Effect.uninterruptible` handler region

## 4. AG-UI projection and history

- [x] 4.1 `fold`: closers then `RUN_FINISHED` with outcome `cancelled` and no `result`; a child's `Cancelled` becomes `SUBAGENT_ERROR` with code `Cancelled`
- [x] 4.2 Add `Cancelled` to `Thread`'s `runEnded` outcome and pass it through the server history's `end`
- [x] 4.3 Tests through `verify` for the cancelled lifecycle, the child cancelled with its parent, and the cancelled notification and commit under the server history
- [x] 4.4 Test that the next run's client history, including the partial message, is matched as known

## 5. Runners

- [x] 5.1 `makeAttached`: fork the run, feed the consumer through a queue, and on early stop complete the run's signal and join it in the finalizer; remove `abandonAttempt` from the internal history
- [x] 5.2 `makeDetached`: add the private registry of `Deferred`s keyed by `[threadId, runId]`, pass its `await` as each attempt's signal, remove the entry on a terminal event, and return `{ start, cancel }` (`cancel` is a no-op for a terminal log)
- [x] 5.3 `makeWorkflow`: define the cancel `DurableDeferred`, race the body's steps against it on every replay, and add `cancel({ threadId, runId })` via `tokenFromExecutionId` and `succeed`
- [x] 5.4 `traced`: end the root span as a success for the cancelled outcome
- [x] 5.5 Detached runner tests: cancel while streaming, subscriber sees the end, cancel a finished run, same run id on another thread, cancelling twice, cancel before start, and an interrupted attempt cancelled then restarted by the same runner (and not by another runner)
- [x] 5.6 Workflow runner tests: cancel during a tool handler, cancel before start, and cancelled while suspended then resumed
- [x] 5.7 Tests for the attached disconnect recording the partial turn (`agui-transport-edge`, `thread-store`) and for the root span not being an error (`agent-tracing`)

## 6. Examples

- [x] 6.1 TanStack: bump `@tanstack/ai` and `@tanstack/ai-react` to the version found in 1.3, add `POST /api/chat/cancel` (`{ runId, threadId }` → `detached.cancel`, 204), set `cancelUrl` and add a Stop button, and remove the "can't be cancelled" comments
- [x] 6.2 `ag-ui`: add `POST /threads/:threadId/runs/:runId/cancel`, authenticated like `POST /runs`
- [ ] 6.3 Run the TanStack example and check that Stop ends the turn, the partial text survives a reload, and the next message runs normally

## 7. Docs and checks

- [x] 7.1 Update `packages/effect-agent-harness/AGENTS.md` (modules, resume rules, invariants: interruption vs cancellation, the `Effect.uninterruptible` advice next to `failureMode: "return"`) and the examples' `AGENTS.md`
- [x] 7.2 `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` pass
