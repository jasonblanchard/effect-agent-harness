## 1. Approval ids

- [x] 1.1 Add `Agent.approvalIdFor(toolCallId)` (`approval:<toolCallId>`), and use it in `executeTool` instead of `ids.generateId()`, inside the existing `tool:<callId>` memo
- [x] 1.2 Extend the approval tests: the interrupt `id` equals `approvalIdFor(toolCallId)`, two threads with the same call id get the same interrupt id, and the existing approve/deny/cancel tests stay green

## 2. Client history conversion

- [x] 2.1 Extract `Messages.resume`'s per-entry decision into a non-exported `decision(entry)` helper, with no change in behaviour (the existing resume tests stay green)
- [x] 2.2 Add `Messages.fromHistory(messages, resume, options?)` returning `FromHistory`. It converts by role as design §4 describes: user text, assistant text and tool calls (arguments parsed), tool results via `resultOf` (first message per call wins), `system`/`developer` per `clientSystem`, other roles dropped
- [x] 2.3 In `fromHistory`, drop calls whose arguments are not a JSON object (with their results), orphan tool messages and empty assistant messages, and report them in `droppedCalls`, `orphanResults` and `droppedParts`
- [x] 2.4 In `fromHistory`, resolve `resume`: for each unanswered call whose `approvalIdFor(call.id)` matches an entry, add the `tool-approval-request` part to its assistant entry and append the `<approvalId>:response` entry built with `decision`. Ignore entries that match nothing
- [x] 2.5 Unit-test `fromHistory` in `test/Messages.test.ts`:
  - each role;
  - edited and regenerated histories;
  - partial arguments;
  - an orphan result;
  - text-only extraction of results with media parts;
  - `clientSystem` drop and allow;
  - approve, deny and cancel through `resume`;
  - an unmatched interrupt id;
  - a call that already has a result plus an approving entry, which yields no response;
  - `Messages.project` over the output giving an unanswered call the failed result

## 3. The `History` service

- [x] 3.1 Create `src/History.ts`:
  - the `History` service tag with an opaque, inline service shape;
  - the internal `Service` (`beginAttempt`), `AttemptOptions` and `Attempt` (`stored`, `added`, `commit`, `end`) interfaces, with `abandonAttempt` on the service, not exported from the package;
  - module documentation carrying the security model
- [x] 3.2 Implement the client history and `History.layerClient`. `beginAttempt` calls `fromHistory` and logs a warning for each non-empty `dropped*`/`orphanResults` list. `stored` is `[]`. `commit`, `end` (returning the event) and `abandonAttempt` do nothing
- [x] 3.3 Implement the server history and `History.layerServer: Layer<History, never, Thread.Thread>` by moving today's code out of `Runner.ts`:
  - `beginAttempt`: claim, load, `delta`, `resume`, `answers`, `ingest`, commit, and the existing warnings;
  - `end`: `endRun`, with `runEnded` then `release` and the same error mapping;
  - `abandonAttempt`: `run`'s release-on-cancel with its error logging
- [x] 3.4 Export `History` from `src/index.ts`

## 4. Runner

- [x] 4.1 In `pipeline`, read `Effect.serviceOption(History)` and fall back to the client implementation. Replace the inline thread code with `beginAttempt`, project `[...stored, ...added]` under the unchanged `prompt` memo, tap `Agent.run` with `attempt.commit`, and map terminal events through `attempt.end` after `failInBand`
- [x] 4.2 In `run`, call the history's `abandonAttempt` from `Stream.ensuring` when the stream ends without a terminal event, instead of calling `Thread` directly
- [x] 4.3 Remove `Thread.Thread` from `Requirements`, and update `workflow`'s `layer` type and the doc comments on `pipeline`, `run`, `makeDetached` and `workflow`:
  - where the history comes from;
  - the workflow runner takes its history from its `layer`'s context;
  - `makeDetached` lets a `History` provided around `start` win
- [x] 4.4 Check that `makeDetached` picks up a `History` provided around `start` (its per-run context is merged over the captured one). Fix the merge if it doesn't

## 5. Existing tests on the server history

- [x] 5.1 Add a server-stores layer to `test/fixtures.ts`: `History.layerServer` with `Thread.layerMemory`, keeping `Thread` in the output so tests can still read the store. Update `runAgUi`'s documentation
- [x] 5.2 Switch every test that provides `Thread.layerMemory` to a runner (`Runner.test.ts`, `Agent.test.ts`, and any others) to the server-stores layer, with no change to its assertions
- [x] 5.3 Move the "failure before the model is called (loading the thread fails)" and store-failure tests to provide `History.layerServer` over their failing `Thread` stubs

## 6. New tests

- [x] 6.1 Default run with no `History` and no `Thread` provided: a text reply finishes with `success`. Add a type-level check that `Runner.run(agent)`'s stream requires neither `Thread` nor `History`
- [x] 6.2 Client history end to end, using `runAgUi` with no history provided:
  - a multi-turn history reaches the model as sent;
  - an edited earlier turn and a regenerated last turn are not rejected;
  - a client assistant message reaches the model;
  - an `activity` message is dropped
- [x] 6.3 Client-history approvals:
  - an interrupted run followed by a run that resends the history with an approving `resume` runs the handler once, before any text;
  - `cancelled` emits a failed result naming "cancelled";
  - with no `resume`, the handler doesn't run and the model gets the failed "did not complete" result;
  - an unknown interrupt id is ignored;
  - an approving entry for a call already answered in the history doesn't run the handler
- [x] 6.4 Client-history frontend calls and repairs:
  - a `pick-file` result is accepted;
  - an `error` result is failed;
  - an unanswered frontend call gets a failed result with no `UnansweredToolCall`;
  - partial arguments and orphan tool messages are dropped, logged, and the run proceeds
- [x] 6.5 Store isolation: with a recording `Thread` stub in context but no `History`, the store receives no calls. Two concurrent client-history runs on one thread both finish
- [x] 6.6 Choosing the history per request:
  - one runner serves one run with `History.layerServer` and one without, and only the first touches the store;
  - `History.layerClient` provided inside a context holding `layerServer` wins;
  - a detached run started with `layerClient` around `start` overrides the server history captured at build
- [x] 6.7 Workflow runner with `History.layerServer` provided to its `layer`: two runs on one thread share the stored history
- [x] 6.8 Pass every event sequence the new tests produce through `verify`

## 7. Examples

- [x] 7.1 `packages/examples/ag-ui`: remove `Thread.layerMemory` from its stores layer and rely on the default client history. Update its comments and `AGENTS.md`
- [x] 7.2 `packages/examples/tanstack`: provide `History.layerServer` (over `Thread.layerMemory`) in the app layer, and keep the hydrate route reading `Thread`. Update its comments and `AGENTS.md`
- [ ] 7.3 Run the ag-ui example's client against its server, checking a multi-turn conversation with a tool call. Run the TanStack example in Chrome, checking that a reload restores the thread and that an approval still resumes

## 8. Docs and checks

- [x] 8.1 Update `packages/effentic/AGENTS.md`:
  - the `History` module note;
  - the resume rules for both histories;
  - the server-only invariants ("one active run per thread", "a client writes only the results of its own calls");
  - `Thread` as the server history's store;
  - `Messages.fromHistory`
- [x] 8.2 Update the root `AGENTS.md` package line to list `History`
- [x] 8.3 Update `packages/effentic/README.md`:
  - both setups;
  - choosing a history per request;
  - the workflow note;
  - the security model (handlers and per-run dependencies are the authorization boundary, `needsApproval` protects the user, the history decides who owns the transcript)
- [x] 8.4 Update the doc comments of `Thread`, `Messages` (module comment and `restore`) and `Messages.project` to scope reconciliation and compaction to the server history
- [x] 8.5 Check the deferred approval double-run fix against the new layout: it lives in the server history's `beginAttempt`. Update `deferred-approval-double-run` in memory if the location it names changed
- [x] 8.6 Rename `Messages.history` to `Messages.restore` and its `Messages.History` result to `Messages.Restored`, in the library, tests, the TanStack example and the docs
- [x] 8.7 Move `Thread.Entry` to `Messages.Entry`, with its round-trip tests, in the library, tests and docs
- [x] 8.8 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
