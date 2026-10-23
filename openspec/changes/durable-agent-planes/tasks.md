# Tasks

Conventions for every task: run from the repo root; `pnpm --filter effentic test` for the library tests; before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`.

## 1. AG-UI schemas and constructors

- [ ] 1.1 In `AgUi.ts` add `ResumeEntry = Schema.Struct({ interruptId: Schema.String, status: Schema.Literals(["resolved", "cancelled"]), payload: Schema.optional(Schema.Unknown) })` and `resume: Schema.optional(Schema.Array(ResumeEntry))` on `RunAgentInput`; verify with a new `AgUi.test.ts` case that decoding an input with a resume entry keeps it and decoding without `resume` still succeeds.
- [ ] 1.2 Extend the `Event` union with `StepStartedEvent | StepFinishedEvent` and add constructors `stepStarted(stepName)`, `stepFinished(stepName)`, `runInterrupted(input, interrupts)` producing `RUN_FINISHED` with `outcome: { type: "interrupt", interrupts }`; verify by a test that a sequence `RUN_STARTED, STEP_STARTED, STEP_FINISHED, runInterrupted(...)` passes `verify`.

## 2. Conversation store (design 3)

- [ ] 2.1 Create `src/Conversation.ts` with `Entry` (Schema.Struct of `id` and `Prompt.Message`), `RunOutcome`, `ConversationError` (TaggedError with brand), and the `Conversation` service class (`load`, `commit`, `runEnded`) using the `Context.Service` pattern with id `"effentic/Conversation"`; verify `pnpm tsc` passes and `Entry` round-trips an assistant message with a tool call through `Schema.encode`/`decode` in a new `test/Conversation.test.ts`.
- [ ] 2.2 Implement `Conversation.layerMemory` (Map<threadId, Array<Entry>>; `commit` appends entries whose id is not yet present, in order; `runEnded` records nothing but must not fail); verify tests: unknown thread loads empty, repeated commit stores once, partial overlap A,B then B,C loads A,B,C.

## 3. Checkpoint store (design 3)

- [ ] 3.1 Create `src/Checkpoint.ts` with `Memoized`, `MemoOptions`, the `Checkpoint` service (`memo`), `Ledger` service (`get`, `set`, id `"effentic/Checkpoint/Ledger"`), `LedgerError`, and `layerNone` (runs the effect, `replayed: false`); verify a test in `test/Checkpoint.test.ts` that `layerNone` executes the same key twice.
- [ ] 3.2 Implement `layerLedger`: encode the completed `Exit` with `Schema.Exit({ success, error, defect: Schema.Defect })`, store under `(runId, name)`, replay stored success as `{ value, replayed: true }`, re-fail stored failures, store nothing on interruption, `Effect.orDie` ledger errors; plus `layerMemoryLedger` (Map keyed by `${runId}\u0000${name}`); verify tests: counter effect runs once across two memos, stored typed failure is replayed without execution, different run ids do not share, an interrupted attempt (use `Effect.never` raced with interruption via a `Deferred`) executes again, a `Prompt.Prompt` value round-trips.
- [ ] 3.3 Implement `layerWorkflow`: capture `WorkflowEngine | WorkflowInstance` context at layer build, implement `memo` as `Activity.make({ name, success, error, execute })` with a `ran` flag to compute `replayed`; verify a test that defines a `Workflow.make("test", { payload: { id: Schema.String }, idempotencyKey: p => p.id })`, registers it with `toLayer` providing `Checkpoint.layerWorkflow`, executes it under `WorkflowEngine.layerMemory`, and observes a memoised counter effect running once.

## 4. Event log and SSE ids (design 3, 11)

- [ ] 4.1 Create `src/EventLog.ts` with `Stored`, `EventLogError`, the `EventLog` service (`append`, `read`, `subscribe`) and `layerMemory` (per run: `Array<Stored>` + `PubSub.unbounded<Stored>()`; cursor = index as string; `subscribe` opens the subscription first, snapshots history, drops live events with cursor ≤ last history cursor, ends inclusively after a terminal event); verify tests in `test/EventLog.test.ts`: increasing cursors, read after cursor, reconnect mid-run receives each later event once and completes on `RUN_FINISHED`, subscribing to a completed run completes, subscribing before any append receives later appends (use `Effect.fork` + `Deferred`), two subscribers see identical sequences.
- [ ] 4.2 In `Sse.ts` add the optional `id` argument to `encodeEvent` and add `encodeStored(stream: Stream<EventLog.Stored>)` mapping cursor → SSE `id`; verify a `Sse.test.ts` case that frames for cursors "0","1","2" contain matching `id:` lines and still parse back with `effect/encoding/Sse`.

## 5. Test fixtures (design 13)

- [ ] 5.1 In `test/fixtures.ts` add `countingWeatherLayer()` returning `{ layer, calls }` (pushes the location on every handler call), `SendEmail = Tool.make("send-email", { parameters: { to, body }, success: { sent: Schema.Boolean }, failure: { message }, failureMode: "return", needsApproval: true })`, `ApprovalToolkit = Toolkit.make(GetWeather, SendEmail)` with a counting layer, and `evalLayers = Layer.mergeAll(Checkpoint.layerNone, counterIds())`; verify `pnpm tsc` passes and the fixtures are importable from a test.

## 6. Core loop (design 1, 2, 4, 5, 10)

- [ ] 6.1 In `Agent.ts` add `Agent`, `define` (moves `maxSteps` validation out of `run`), `RunInput`, `Event`, `Outcome`, and the new `Requirements` including `Checkpoint`; remove `AgentOptions.clientSystem`; verify `pnpm tsc` and a test that `define({ maxSteps: 0 })` throws `RangeError`.
- [ ] 6.2 Implement the model checkpoint `model:${k}`: mint `messageId`, `streamText({ prompt: modelPrompt, toolkit, disableToolCallResolution: true })`, emit `ModelPart` live through a `Queue` drained by the step stream, return `{ messageId, assistant, toolCalls, finishReason }` with the schema in design 4; verify a core test (`Agent.run` + `scriptedModel` + `evalLayers`) that a text-only script yields `StepStarted, ModelPart…, StepFinished, Finished(Success)` and that `ModelPart` events arrive before `StepFinished`.
- [ ] 6.3 Implement `stripApprovals(prompt)` (remove `tool-approval-request`/`tool-approval-response` parts, drop empty messages) and apply it to every model call; verify a test that a prompt containing resolved approval parts reaches the scripted model without them.
- [ ] 6.4 Implement the tool checkpoint `tool:${id}` per design 4 step 2 (needsApproval evaluation, denial result, `toolkit.handle` with last non-preliminary result, `execution-interrupted` result for incomplete finish reasons, unbounded concurrency); verify tests: `get-weather` handler runs after the model stream ended and once; two calls in one step both resolved; a failing weather location yields `isFailure: true` and the model is called again; finish reason `length` with a tool call yields a failed `execution-interrupted` result and `Finished(Success)` without running the handler.
- [ ] 6.5 Implement step entries (assistant entry id = step `messageId` with appended `tool-approval-request` parts; one tool entry per result with the result's `messageId`), `StepFinished`, and the continuation rule including `StepLimitExceeded` and `Failed` mapping (reuse `errorMessage`/`errorCode`); verify tests: entries of a tool step have the expected ids and roles; step limit 2 with tool calls on both steps yields `Failed{code:"StepLimitExceeded"}` after two model calls; a model error part yields `Failed{code:"ModelStreamError"}` and nothing after.
- [ ] 6.6 Implement approval gating: `ApprovalRequested` event, request part on the assistant entry, `Finished(Interrupted)` listing approvals while other tools in the step still run; verify tests with `ApprovalToolkit`: `send-email` + `get-weather` in one step → weather handler ran, email handler did not, outcome lists the email call; an approval predicate that throws is treated as no approval needed.
- [ ] 6.7 Implement step 0 (design 5): resolve approved/denied responses already in the prompt before step 1, emit `ToolResult` with `step: 0` and one `StepFinished{step:0}`, append results to the prompt, no `StepStarted`, not counted toward `maxSteps`; verify tests: approved response → email handler runs once and the model prompt contains the tool result; denied response with reason "no" → no handler run and failed result naming "no".
- [ ] 6.8 Implement replay marking: `Memoized.replayed` propagates to `StepStarted`, `ToolResult`, `ApprovalRequested`, `StepFinished`; a replayed model step emits no `ModelPart`; verify a test with `Checkpoint.layerLedger` + one `layerMemoryLedger` shared across two `Agent.run` invocations of the same `runId` where run 1's script fails in step 2 and run 2's succeeds: weather handler called once in total, run 2's step-1 events are marked replayed, carry the same ids as run 1, and contain no `ModelPart`.
- [ ] 6.9 Update `packages/effentic/AGENTS.md` for `Agent.ts` (behaviour as value, step events, checkpoints, never-failing stream) ; verify the file describes `define`/`run` and the replay rule.

## 7. AG-UI fold (design 9)

- [ ] 7.1 Move `handlePart`, `StepState` and the error helpers into `AgUi.ts` as `fold(input)(events)`, mapping per the table in design 9 (drop replayed events, `STEP_STARTED`/`STEP_FINISHED`, `TOOL_CALL_RESULT` from `ToolResult`, interrupt outcome, closers before `RUN_ERROR`); verify tests in `AgUi.test.ts` that run `Agent.run` output through `fold` for: text-only, tool step, approval interrupt, model failure mid-text (closer before `RUN_ERROR`), two-step run with step events; every sequence passes `verify`.
- [ ] 7.2 Port the remaining span tests from the old `Agent.test.ts` (text never ended, failure during tool args, provider that emits only complete `tool-call` parts, one message id per step) onto `fold`; verify they pass through `verify` and `pnpm --filter effentic test` is green.

## 8. Message ingestion (design 6)

- [ ] 8.1 Rewrite `Messages.ts` into `delta`, `ingest`, `resume`, `project`, `HistoryMismatch` (TaggedError with brand) reusing `textOf`, `parseJson` and the unanswered-call repair with the approval exception; remove `toPrompt`; verify `Messages.test.ts` cases: delta with empty store is the whole list; delta after the last matching id; no match with non-empty store → `HistoryMismatch`; `ingest` keeps user text, drops assistant/tool, keeps system only with `clientSystem: "allow"`; `resume` approves only `resolved` + `payload.approved === true`, denies `cancelled` with reason "cancelled", denies unanswered pending requests with "not answered", ignores unknown interrupt ids; `project` repairs a stored unanswered tool call but skips one with an approval request.
- [ ] 8.2 Update `packages/effentic/AGENTS.md` for `Messages.ts`; verify it describes the delta rule and the approval exception.

## 9. Request-scoped runner (design 8)

- [ ] 9.1 Create `src/Runner.ts` with `Options`, the shared `pipeline` (load → delta/ingest/resume → commit → memo `"prompt"` → `Agent.run` with commit-on-`StepFinished` and `runEnded` on terminal → `AgUi.fold`; pre-core failures become `RUN_STARTED` + `RUN_ERROR{code: tag}`), and `run` / `make`; add the `runAgUi(agent, inputs)` fixture that drives several inputs through `Runner.run` over one `Conversation.layerMemory`; verify a two-run test: run 2's model prompt contains run 1's user, assistant (with tool call), tool result and the new user message, in order.
- [ ] 9.2 Verify ingestion and errors end to end in `test/Runner.test.ts`: full history resent → only the new user message committed; assistant message in the delta not committed; unrelated history → `RUN_STARTED` then `RUN_ERROR{code:"HistoryMismatch"}` and the model not called; a `Conversation.load` failure → `RUN_ERROR{code:"ConversationError"}`; all sequences pass `verify`.
- [ ] 9.3 Verify per-step commit and notifications with a spy `Conversation` layer wrapping `layerMemory`: a two-step run commits delta, then step 1 entries, then step 2 entry; a failure in step 2 leaves no step-2 entries; `runEnded` is called once after the last commit with the right outcome for success, interrupted and failed runs.
- [ ] 9.4 Verify the approval round trip over AG-UI: run 1 with `ApprovalToolkit` ends with `RUN_FINISHED` outcome `interrupt` (one interrupt, `toolCallId` matches, `reason: "tool-approval"`), no `TOOL_CALL_RESULT` for the email call; run 2 with `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]` emits `TOOL_CALL_RESULT` for the email call before any text, the email handler ran once, the model prompt contains the tool result and no approval parts; run 2 with `status: "cancelled"` emits a failed result naming "cancelled"; run 2 with `resolved` and no payload denies; run 2 without `resume` denies with "not answered"; all sequences pass `verify` and the `@ag-ui/client` interrupt bookkeeping (feed run 1 then run 2 through `verify`).
- [ ] 9.5 Verify the prompt memo: with `Checkpoint.layerLedger`, re-running a `runId` after rewriting the in-memory thread still sends the original projection to the model for the remaining steps.

## 10. Detached runner (design 7, 8)

- [ ] 10.1 Implement `makeDetached` (needs `Scope`): `start` reads the log, returns immediately if the last event is terminal, otherwise computes open spans from the history with the fold's bookkeeping, appends closers, then `Effect.forkIn(scope)` of `pipeline(...).pipe(Stream.runForEach(append))`; verify tests in `test/Runner.test.ts` with `EventLog.layerMemory`: start then subscribe yields a complete valid sequence; a subscriber that stops after three events does not stop the run (log still receives `RUN_FINISHED`); reconnect after cursor c yields every later event once.
- [ ] 10.2 Verify re-execution: with `layerLedger` and a run whose attempt 1 script fails after `TEXT_MESSAGE_START` + content in step 2 (seed the log by running attempt 1 detached), starting again appends `TEXT_MESSAGE_END` for the open message, no step-1 events, then step 2 under a new message id; the full log passes `verify`; starting a run whose log ends in `RUN_FINISHED` appends nothing and calls no model.
- [ ] 10.3 Update `packages/effentic/AGENTS.md` with the runner choice (request-scoped cancels on disconnect, detached does not) and the resume rules; verify the invariants section still states the stream never fails and sequences are valid AG-UI.

## 11. Workflow runner (design 8)

- [ ] 11.1 Implement `Runner.workflow(agent, options)` returning `{ workflow, layer }` with `Workflow.make("effentic/Run", { payload: AgUi.RunAgentInput, idempotencyKey: input => input.runId })` and `toLayer` running the detached body under `Checkpoint.layerWorkflow`; verify a smoke test under `WorkflowEngine.layerMemory` + `EventLog.layerMemory` + `Conversation.layerMemory`: `workflow.execute(input, { discard: true })` then subscribing yields the same valid sequence as `Runner.run` for a tool step, and the weather handler ran once; executing the same input twice does not duplicate handler calls or events.

## 12. Public API, docs and example

- [ ] 12.1 Export `Conversation`, `Checkpoint`, `EventLog`, `Runner` from `src/index.ts`; verify `pnpm tsc` passes for both packages.
- [ ] 12.2 Update `packages/examples/ag-ui/src/server.ts`: define the agent with `Agent.define`, serve `POST /agent` with `Runner.make` over `Conversation.layerMemory` + `Checkpoint.layerNone`, and add `POST /runs` (detached start via `makeDetached` with `EventLog.layerMemory`) and `GET /runs/:runId/events` (reads `Last-Event-ID`, responds with `Sse.encodeStored(EventLog.subscribe(runId, lastEventId))`); verify `pnpm --filter ag-ui dev` holds a two-turn conversation where the second turn references the first (manual check, documented in the example's `AGENTS.md`).
- [ ] 12.3 Add a `send-email` example tool with `needsApproval: true` and make `src/index.ts` answer an interrupt outcome by prompting "approve? (y/n)" and calling `agent.runAgent({ resume: [{ interruptId, status, payload: { approved } }] })`; verify manually that approving runs the tool and denying returns a failed result (document the steps in the example's `AGENTS.md`).
- [ ] 12.4 Update `packages/examples/ag-ui/AGENTS.md` and the root `AGENTS.md` module list for the new modules; verify the docs name every exported module.

## 13. Final verification

- [ ] 13.1 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` from the repo root and fix every finding without silencing rules; verify all four commands exit 0.
- [ ] 13.2 Walk every scenario in `openspec/changes/durable-agent-planes/specs/**/spec.md` and confirm each is covered by a named test or the documented manual example check; verify by listing scenario → test mappings in the PR description.

## Workflow follow-up

- Archive the change with `openspec archive durable-agent-planes` once review passes; the archive syncs the two modified capabilities and creates the four new ones under `openspec/specs/`.
- Fill in the `## Purpose` of the four new main specs if the archive leaves a placeholder.
