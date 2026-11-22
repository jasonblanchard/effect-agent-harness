## 1. Progress in the agent run

- [x] 1.1 Add the `ToolProgress` variant to `Agent.Event` (design decision 2), with a doc comment saying it is never replayed, committed or sent to the model
- [x] 1.2 Pass the step number and the step's assistant message id through `executeTool` to `handleTool`
- [x] 1.3 Replace `runLast` in `handleTool` with a fold that emits `ToolProgress` for each preliminary result and keeps the final one, leaving the span, failure handling and `memoTool` boundary as they are
- [x] 1.4 Add a tool to `test/fixtures.ts` that reports preliminary values (object and number successes), with a hook to block it between values
- [x] 1.5 Test the `Preliminary tool results are emitted as progress` scenarios in `Agent.test.ts`: order and fields, entries and the next prompt contain no progress, failure after progress
- [x] 1.6 Test replay: no progress for a call served from a ledger checkpoint, and progress again under the same step message id when a crash during the call makes it run again
- [x] 1.7 Confirm progress is emitted from inside a call under `Checkpoint.layerWorkflow`

## 2. Activity snapshots on the AG-UI stream

- [x] 2.1 Add `ActivitySnapshotEvent` to `AgUi.Event`, with a builder and a private function that derives the activity id (design decision 3)
- [x] 2.2 Project `ToolProgress` in `fold`: object content passes through, other values are wrapped as `{ value }`, `metadata["effect-agent-harness:toolCallId"]` is set, the event is attributed for subagents, and `replace` is left unset
- [x] 2.3 Make sure `closeOpen`, `subagentsIn` and the `resumed` handling ignore activity snapshots
- [x] 2.4 Update `fold`'s doc comment
- [x] 2.5 Test the `Tool progress streams as activity snapshots` scenarios in `AgUi.test.ts`, each sequence through `verify`: position between `TOOL_CALL_END` and `TOOL_CALL_RESULT`, a shared id per call, wrapping a number, parallel calls, and a tool call id reused across steps
- [x] 2.6 Test `Not in the thread`: under the server history, `History.restore` after a call that reported progress returns no activity message
- [x] 2.7 Test `Child tool progress` in `Subagents.test.ts`

## 3. Conflating superseded snapshots

- [x] 3.1 Add the internal chunk-level operator (design decision 5) that drops a snapshot when a later one with the same `messageId` follows it in the same chunk
- [x] 3.2 Apply it after `Stream.fromQueue` in `makeAttached` (to `ACTIVITY_SNAPSHOT`s), and, for every runner, to `Agent.run`'s output in `agUiRun` (to `ToolProgress`), ahead of the commits
- [x] 3.3 Unit-test the operator: the last snapshot per id survives, other events keep their order, snapshots for different ids are untouched
- [x] 3.4 Test `Slow consumer` and `Fast consumer` in `Runner.test.ts` with the blocking fixture tool, for an attached and a detached run
- [x] 3.5 Test `Detached run's log`: a client following the log from the start gets the snapshots in the same position as an attached client, once conflation is accounted for

## 4. TanStack example

- [x] 4.1 Add a slow server tool (for example `search-docs`) that reports `{ done, of }` progress through `ctx.preliminary` and returns its hits, and add it to the toolkit in `chat.server.ts`
- [x] 4.2 Render `role: "activity"` messages for that tool as a progress card in `routes/index.tsx`, greyed out once the result for `metadata["effect-agent-harness:toolCallId"]` arrives
- [x] 4.3 Run the example: confirm the card updates live, survives a reconnect during the call through the event log, and that after a reload only the tool result remains with no history error on the next turn

## 5. Docs and checks

- [x] 5.1 README: how a tool reports progress with `ctx.preliminary`, the wire shape (`activityType`, `content` wrapping, `metadata["effect-agent-harness:toolCallId"]`), the union convention for progress that differs from the result, that progress is live-only, and the new members of `Agent.Event` and `AgUi.Event`
- [x] 5.2 Update `packages/effect-agent-harness/AGENTS.md` and the `tanstack` example's `AGENTS.md` where they describe events or tools
- [x] 5.3 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
