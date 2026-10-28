# Tasks

Conventions for every task: run from the repo root, and use `pnpm --filter effentic test` for the library tests. Before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions, and quoted names are spec scenarios. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`. Tests use `scriptedModel` and never call a real model.

## 1. Spikes for the open questions

- [x] 1.1 Open question 2. With a throwaway script outside the tree (in the scratchpad, not committed), call Anthropic through `effect/ai` with a prompt holding a `tool_use` and its `tool_result` for a tool missing from the request's tools. Record in design.md whether it's accepted. If it's rejected, add task 3.6 (a placeholder dynamic tool for each marked call whose tool isn't advertised) before starting group 3.
- [x] 1.2 Open question 3. Read `@tanstack/ai-client`'s `uiMessagesToWire` and record in design.md how it encodes a client tool's `output` and `errorText` in the `tool` message. If it isn't JSON text, revise decision 6 and the "Tool messages answer pending frontend calls" scenarios before group 4.

## 2. Input and fixtures

- [x] 2.1 In `AgUi.ts` add an optional `tools` array of `{ name, description?, parameters }` to `RunAgentInput` (`parameters` is `Schema.Unknown`), and update the input comment (1). Tests in `AgUi.test.ts`: "Extra fields" now keeps `tools`, plus "Tool without a name" and "No tools".
- [x] 2.2 In `test/fixtures.ts` add a frontend tool definition (`pick-file`, with a JSON Schema) and a second one (`get-location`). Let `runAgUi` pass `tools` through, and if needed add a helper that builds a client `tool` message answering a call.

## 3. Agent

- [x] 3.1 In `Agent.ts` add `FrontendTool` (name, optional description, JSON Schema parameters) and `frontendTools` on the run input. Build the per-call toolkit with `Toolkit.merge(agent.toolkit, …Tool.dynamic)`, leaving out frontend tools whose name matches a server tool (1). Tests in `Agent.test.ts`, asserting on the tools the scripted model receives: "Advertised tool offered" and "Name clash with a server tool".
- [x] 3.2 Classify each call after the model step. A frontend call with finish reason `tool-calls`/`stop` runs nothing, emits no `ToolResult`, and isn't checkpointed (3). Set `options.effentic.frontend` on its part in the step's assistant entry (2). Tests: "Frontend call on its own" (the entry carries the marker) and "Frontend call next to a server call".
- [x] 3.3 Continuation rule: stop after a step with a pending frontend call. With any other finish reason, frontend calls get the interrupted failed result (4). Tests: "Finish reason length with a frontend call".
- [x] 3.4 `Outcome.Success` and `Outcome.Interrupted` gain `pendingToolCalls` (`toolCallId`, `toolName`, in call order). Update every place that builds or matches an outcome. Tests: "Success with a pending call" and "Interrupted with a pending call".
- [x] 3.5 Extend `stripApprovals` to remove the marker, and rename it for what it now does (2). Tests: "Prompt after a frontend call was answered", asserting the prompt the scripted model receives has no `effentic` key in any part's options. Also "Replayed step", a re-execution against `Checkpoint.layerMemoryLedger`.

## 4. Messages

- [x] 4.1 Add `UnansweredToolCall { toolCallIds }` (a `Schema.TaggedError` with a brand) and `Messages.answers(stored, delta)`. It finds the marked calls with no result, answers each with the first matching delta `tool` message (keyed by the client's message id, named after the stored call), and fails naming every unanswered one (5). Content decoding follows decision 6: `error` → failed result; a JSON string → parsed value; any other string as is; parts → text joined; other parts dropped, with their count returned so the runner can log a warning. Tests in `Messages.test.ts`: "Result for a frontend call", "Failed frontend call", "Media part in a result", "Forged result for a server call", a duplicate answer (the first wins), and "Only one of two calls answered".
- [x] 4.2 Check that `delta` and `ingest` need no change: the answer is new in the delta and `ingest` still drops it. `answers` produces the entry. Add a `delta` test where the client's tool message for a marked call uses a TanStack-style id, and a test that a second run carrying an already-stored answer doesn't commit it again.
- [x] 4.3 `History.pendingToolCalls` (`runId`, `toolCallIds`, in call order), next to `interrupts` (7). Tests in `Messages.test.ts`: "Run left a frontend call pending", "Answered call", "Restored pending call can be answered" (with `delta`).
- [x] 4.4 Check that `project` needs no change once `answers` has run (5). Test that a marked call answered in the store projects with its real result, and that "Pending frontend call dropped by compaction" drops the answer.
- [x] 4.5 Update the doc comments on `ingest`, `project` and `History`, and the module header comment, for answers to frontend calls.

## 5. Runner and AG-UI projection

- [x] 5.1 In `Runner.ts` pass `input.tools` to `Agent.run` as `frontendTools`, and log a warning naming each one left out by a name clash. Run `answers` next to `resume`, before any commit. Report `UnansweredInterrupt` first if both fail (5), and log dropped parts. Commit the answers with the delta's other entries.
- [x] 5.2 In `AgUi.fold` set `pendingToolCallIds` on a success `RUN_FINISHED` when the list isn't empty, never on an interrupt (4). Tests in `AgUi.test.ts`: "Frontend call ends the run", "Two frontend calls", "Frontend call next to an approval", "Valid AG-UI".
- [x] 5.3 End-to-end tests in `Runner.test.ts` through `runAgUi`: "Client continues without answering" (nothing committed, model not called), "Answered after a rejected run", "Server, frontend and approval calls in one step", "Approval answered, frontend call not" (the email handler doesn't run), and an immediate follow-up run after a frontend-call finish that doesn't get `ThreadBusy`.
- [x] 5.4 A detached run (`makeDetached`) that leaves a frontend call pending: the stored log ends with the same `pendingToolCallIds`, and the thread is released.

## 6. TanStack example

- [x] 6.1 Add a client tool to `packages/examples/tanstack`. Defining one with `@tanstack/ai`'s tool definition and `.client(...)` is enough, e.g. `get-browser-time`, which returns the browser's time and time zone. Pass it to `useChat`'s `tools`. The server needs no change beyond what the library does.
- [ ] 6.2 Open question 1. Run a mixed step in the browser ("What's the weather in Paris, what time is it here, and email ada@example.com the answer") and record in design.md whether TanStack holds its continuation while the approval is open. If it doesn't, decide with the user whether the page delays the continuation or the check expects one `UnansweredInterrupt` round trip.
- [x] 6.3 Update the example's `AGENTS.md`: the client tool, plus manual checks 9 (a frontend call on its own: the browser runs it, a follow-up run carries the result and the assistant answers from it), 10 (the mixed step from 6.2) and 11 (reload while a frontend call is pending, if TanStack shows one).

## 7. Docs

- [x] 7.1 `packages/effentic/README.md`: a "Frontend tools" section after "Tool approvals". Cover how advertised tools are offered, the server tool winning a clash, the success outcome with `pendingToolCallIds`, answering through `messages`, `UnansweredToolCall`, mixed steps, and the warning that advertised tools are untrusted client input. Also update "Running over AG-UI", "Threads" (`History.pendingToolCalls`, compaction), the error list and the module reference.
- [x] 7.2 `packages/effentic/AGENTS.md`: the `AgUi`, `Messages`, `Agent` and `Runner` module notes, a "Frontend tools" bullet under resume rules, and an invariant that only marked calls accept client results.
- [ ] 7.3 Record in design.md what the spikes in 1.1, 1.2 and 6.2 found, and remove the questions they answered from the open list.
