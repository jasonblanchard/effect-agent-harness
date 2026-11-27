## 1. Baseline

- [x] 1.1 Record the current AG-UI output (`fold` over `Agent.run`, after `verify`) for the representative scenarios in `AgUi.test.ts`, `Subagents.test.ts` and `Cancellation.test.ts`: text, reasoning, tool calls, progress, approvals, frontend calls, nested and concurrent subagents, cancellation, failure, and a detached crash-and-resume. Save them as fixtures the new loop's output must match, apart from `usage`.

## 2. Emission building blocks

- [x] 2.1 Create `src/internal/events.ts` holding the per-step emitter, built from `StepState`/`handlePart`: text, reasoning (with derived `reasoningMessageId`) and tool-call spans, plus a `close()` used at step end, on failure and by `cancelStep`. Unit-test it against the baseline span sequences.
- [x] 2.2 Add the internal `OnStepFinished` reference in `src/internal/`: a `Context.Reference` whose default does nothing, not exported from `src/index.ts`.
- [x] 2.3 Add an optional `usage` to the `ModelStep` checkpoint (not to the `Result`/`Suspended` subagent outcomes in `ToolStep`: the child replays its own steps, so its usage would count twice; see design decision 6). Add a usage accumulator that matches `AgUiServer`'s summing (including `totalTokens`). Check that checkpoints without the field still decode.

## 3. The loop emits AG-UI

- [x] 3.1 Change `Agent.run`'s input to `{ input: RunAgentInput, prompt, subagentPrompts?, cancelled? }`. Derive the ids, props and frontend tools from `input` (moving the runner's `frontendTool` mapping in), provide `AgUiServer.RunInput` wherever `CurrentRun` was provided, and exclude it from `Requirements`. Pass subagents the parent's input with no frontend tools.
- [x] 3.2 Change `Agent.run`'s element type to `AgUiSchema.Event`. Emit `RUN_STARTED`, then `STEP_STARTED`/`STEP_FINISHED` for model steps (none for step 0), and drive the step emitter from each live model part.
- [x] 3.3 Emit `TOOL_CALL_RESULT` from the tool-result sites, and `ACTIVITY_SNAPSHOT` from `handleTool` through the step emitter, closing an open `TOOL_CALL_START` first. Keep progress `messageId`s derived exactly as `activityMessageId` derives them today.
- [x] 3.4 Call `OnStepFinished` with the step's entries before `STEP_FINISHED`, including for replayed steps and in `cancelStep`. Place the call outside every checkpoint and outside `guard`, and turn a failure into the run's failure.
- [x] 3.5 Build the terminal event in the loop: `RUN_FINISHED` (success with `pendingToolCallIds`, interrupt via `approvalInterrupt`, cancelled with no `result`) or `RUN_ERROR` (message, `errorCode`), each with `usage`. Close open spans first.
- [x] 3.6 On failure, hand the cause to the internal `OnRunFailed` hook before emitting `RUN_ERROR` (by default, it logs the cause).
- [x] 3.7 Check frontend tools against the toolkit's names and the subagent names before step 0, ending with `RUN_STARTED` then `RUN_ERROR` code `FrontendToolConflict`. Remove the warn-and-drop path.
- [x] 3.8 Emit nothing for replayed work except replayed `TOOL_CALL_RESULT`s, each marked with `metadata["effect-agent-harness"] = { replayed: true }`.
- [x] 3.9 Add `isFailure` to `toolCallResult`, emitting `metadata["effect/ai"] = { isFailure: true }` on failed results, including step 0, cancelled-call and subagent results.
- [x] 3.10 Make `conflateActivity` usable on `Agent.run`'s output, and remove `conflateProgress`.

## 4. Subagents

- [x] 4.1 In `callSubagent`, run the child with an `OnStepFinished` that collects into the parent step's child-entry buffer, tagged with `subagentIdFor(toolCallId)` unless a deeper owner already tagged the entry. Remove the `StepFinished.entries` collection.
- [x] 4.2 Forward the child's events with attribution: `subagentRunId` on events that lack it, and `parentSubagentRunId` on `SUBAGENT_*` events that lack it. Drop the child's `RUN_STARTED`, and emit `SUBAGENT_STARTED` before its first forwarded event.
- [x] 4.3 Map the child's terminal event: `SUBAGENT_ERROR` (code `Cancelled` when it was cancelled with its parent) and `SUBAGENT_FINISHED suspended` (with only its own `interruptIds`) emitted at once; `SUBAGENT_FINISHED success`, with its result, emitted right before the spawning call's `TOOL_CALL_RESULT`. Add the child's `usage` to the parent's total and to the memoised outcome.
- [x] 4.4 For a child whose run produced no live event, or whose call is served from the `tool:<id>` memo, emit only its closing event and the call's result, both marked as replayed.

## 5. Runners

- [x] 5.1 Add a private `publish(resumed)` operator in `Runner.ts`, as design decision 5 describes: held marked starts, marked results and closings kept by the log's state, open subagents closed before `RUN_FINISHED`, every marked event dropped when there is no log, and the `effect-agent-harness` key removed from every event that passes.
- [x] 5.2 Rewire `agUiRun`: install `OnStepFinished` from `attempt.commit`, remove the `StepFinished` tap, run `attempt.end` on the AG-UI terminal event, and replace `AgUi.fold` with `publish`. Keep `closeOpen(resumed)` on the detached path.
- [x] 5.3 Change `internal/history.ts`'s `end` to take and return the AG-UI terminal event: read the outcome from `RUN_FINISHED.outcome.type` or `RUN_ERROR.code`, and keep the `ThreadError` replacement.
- [x] 5.4 Change `traced` to end the root span from the terminal event: error status and `error.type` from `RUN_ERROR.code`, or `Error` when there is no code.
- [x] 5.5 Pass the decoded input to `Agent.run` from `agUiRun` in every runner, removing the runner-side `frontendTools`/`props` mapping.
- [x] 5.6 Add the adapter `Runner.toAgUiServerAgent(agent, options?)` (taking `makeAttached`'s options) returning an `AgUiServer.Agent`, with a doc comment stating that it is not a runner and that `agentHandler` captures its services when the route is built, which rejects a frontend tool clash with `HttpApiError.BadRequest` before delegating to `makeAttached`.
- [x] 5.7 If `interrupt-metadata` has landed, move its hook from `fold` into `publish`, on the `RUN_FINISHED` interrupt outcome.

## 6. Failure marker in the conversions

- [x] 6.1 Add a private `isFailedToolMessage` (`error` set, or the `effect/ai` marker) in `internal/conversions.ts`, and use it in `fromHistory` and `answers`. With only the marker, the result is the decoded content.
- [x] 6.2 Make `restore` put the marker on a failed tool message next to `error`.

## 7. Remove the old vocabulary

- [x] 7.1 Remove `Agent.CurrentRun`, `Agent.RunInfo`, `Agent.FrontendTool`, `Agent.Event`, the `Outcome`/`Approval`/`PendingToolCall` types that were only event payloads (keep any the loop still uses internally, unexported), `AgUi.fold`, `AgUi.conflateProgress` and the `AgUi.Event` alias if nothing public needs it. Check `src/index.ts` exports only the intended surface.

## 8. Tests

- [x] 8.1 Port `Agent.test.ts`, `Subagents.test.ts`, `Cancellation.test.ts`, `VolatileSystem.test.ts`, `Telemetry.test.ts` and `AgUi.test.ts` to read AG-UI events from `Agent.run`, passing every sequence through `verify` and comparing against the baseline fixtures from 1.1.
- [x] 8.2 Add tests for the internal `OnStepFinished`: entries before `STEP_FINISHED`, replayed steps committing again, a commit failure ending the run, child entries reaching the parent's commit only, and a run without a runner emitting the same events.
- [x] 8.3 Add `usage` tests: two steps, a subagent, a resumed run reporting the same totals, no counts reported, and a checkpoint without `usage`.
- [x] 8.4 Add replay-marker tests: the marker appears only on re-execution, `publish` strips it, a held result is published once, an already-published result isn't repeated, and the event log never contains the key.
- [x] 8.5 Add tests for `FrontendToolConflict` (`Agent.run` and attached runners in-band), `toAgUiServerAgent` through `AgUiServer.layerHttp` with `HttpAgent` (including the 400 case), and `AgUiServer.RunInput` reaching a tool, a subagent's tool, the system prompt and an approval predicate. Also add a test that, under the server history, `input.messages` holds only the client's delta while the model receives the whole thread.
- [x] 8.6 Add failure-marker tests: on a failed result and not on a successful one; an `HttpAgent` round trip under the client history keeps the failure; a marker-only frontend answer is stored as failed; and `restore` matches the live tool message's metadata.
- [x] 8.7 Add tracing tests: the root span ends with the original error for a loop failure (no hand-added exception event), succeeds for success or cancellation, and has `error.type` from `RUN_ERROR.code`.

## 9. Examples

- [x] 9.1 Update `packages/examples/ag-ui` and `packages/examples/tanstack` for the API changes, including moving every tool that declares `Agent.CurrentRun` to `AgUiServer.RunInput`. Where it fits, show `toAgUiServerAgent` with `AgUiServer.layerHttp`, keeping `endpoint` + `handler` where per-request services are needed.

## 10. Docs, specs and checks

- [x] 10.1 Reword the Purpose lines of `openspec/specs/agent-run/spec.md` (no longer "independent of AG-UI"; it now emits AG-UI events) and `openspec/specs/agui-subagent-events/spec.md` (the run emits subagent events; nothing projects them).
- [x] 10.2 Update every doc and steering file the change affects, as listed in the root AGENTS.md "Documentation" section:
  - `docs/robodocs.md`: "Testing and evals", with an old-event to AG-UI migration table; tool progress; cancellation; tracing; serving through `AgUiServer` with `toAgUiServerAgent` and the `agentHandler` context caveat; `usage`; `FrontendToolConflict`; `AgUiServer.RunInput` in place of `CurrentRun` (with the note that `messages` isn't the conversation).
  - `docs/architecture.md`: the map and the run timeline without `fold`, the commit hook, `publish`, and the type catalog.
  - `docs/core-effect-comparison-audit.md`: the comparison with `AgUiServer.agent`, and its date.
  - `README.md`: core primitives, if `Agent.run`'s description changes there.
  - The root and library `AGENTS.md`: the `Agent`, `AgUi` and `Runner` module notes, invariants such as "The event streams never fail" and the `Agent.Event` wording, and test conventions.
- [x] 10.3 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding.

## 11. Review fixes

- [x] 11.1 Add the internal `OnRunFailed` hook. The loop, `failInBand` and `history.end` report the cause to it. `traced` logs it and ends the root span with `Exit.failCause(cause)`, so an exporter records the original error once. Remove `recordFailure` and `RunFailed`.
- [x] 11.2 End a failed subagent's `invoke_agent` span with the child's own cause, without logging it.
- [x] 11.3 Keep `usage` on the `RUN_ERROR ThreadError` that `history.end` puts in place of the terminal event.
- [x] 11.4 Check for a frontend tool name clash in the runner before the per-run layer and the input memo, through one helper (`internal/tools.ts`) shared with the loop and `toAgUiServerAgent`.
- [x] 11.5 Tests: the root and subagent spans' exits, one error log for a failed top-level run and none for a handled subagent failure, usage on a failed end, and a retry of a refused run id.
- [x] 11.6 Bring the specs, design and docs in line with the replay marker rules, the subagent outcome's missing `usage`, and the failure reporting.
- [x] 11.7 Slim `AgUi` to the client contract (`Event`, `isTerminal`, `ApprovalResponse`): stop exporting the event builders (`approvalInterrupt` included) and `reasoningMessageId`, and move `closeOpen`, `conflateActivity` and `publish` to `internal/publish.ts`, with their tests in `test/internal/publish.test.ts`.
- [x] 11.8 Remove the `AgUi` module: type the run's events as `effect/ai`'s `AgUiSchema.Event` (no narrower union), move `ApprovalResponse` and `isTerminal` to `Agent`, and rename `test/AgUi.test.ts` to `test/Events.test.ts`.
