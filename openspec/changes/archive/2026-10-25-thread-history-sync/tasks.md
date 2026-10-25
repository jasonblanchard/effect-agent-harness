# Tasks

Conventions for every task: run from the repo root; `pnpm --filter effentic test` for the library tests; before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`.

## 1. Run ids on stored entries

- [x] 1.1 In `Thread.ts` add `runId: Schema.optional(Schema.String)` to `Entry`. Make `layerMemory`'s `commit` store each newly appended entry with the commit's `runId`, leaving an already-present entry untouched (4). Update the `Thread` doc comment: `load` returns the committing run's id, and summaries a store writes may have none. Verify in `Thread.test.ts`: an entry with a run id round-trips through `Entry`'s JSON codec; "r1" commits A and B, then "r2" commits C, and the load returns A and B with "r1" and C with "r2"; "r2" recommitting A leaves it with "r1".
- [x] 1.2 Check that every place comparing or snapshotting loaded entries (tests, `Messages.project` fixtures, the `prompt` checkpoint) still passes now that loaded entries carry `runId`. The prompt is built from `message` only, so the checkpointed prompt must not change. Verify `pnpm test` passes unchanged apart from expected-entry fixtures.

## 2. Shared approval interrupt

- [x] 2.1 In `AgUi.ts` extract `approvalInterrupt({ approvalId, toolCallId, toolName })` returning the interrupt `fold` builds today, export it, and use it in `fold` (5). Verify `AgUi.test.ts` and `Runner.test.ts` pass unchanged, plus a unit test showing the builder's output for a `send-email` call.

## 3. Reading a thread

- [x] 3.1 In `Messages.ts` add `History` and `history(entries)` (1): user, assistant (joined text as `content`, every tool-call part as `toolCalls` with `JSON.stringify(params)` arguments, left out with neither), and tool-result messages, with results moved directly after their calls. System, approval-response and reasoning content is left out. Use `@ag-ui/core`'s message types for the output. Verify in `Messages.test.ts`: each scenario of "Reading a thread as AG-UI messages", including the result committed after a later user message and the server-only entries that stay hidden.
- [x] 3.2 Add `interrupts` to `history`: the approval requests with no response, built with `AgUi.approvalInterrupt` (tool name from the stored call), and `runId` from the assistant entry holding them (the latest such entry if several). `undefined` when none are open (1, 4). Verify in `Messages.test.ts`: one open request gives one interrupt with the entry's run id; an answered request gives none; an entry without a run id gives interrupts with `runId: undefined`.
- [x] 3.3 Verify against real runs in `Runner.test.ts`, through `Thread.layerMemory`: after a run that streams two text segments and a tool result, `history` gives the ids and `content` the events carried (assistant message id = `TEXT_MESSAGE_START.messageId`, tool message id and `content` = `TOOL_CALL_RESULT`'s); after a run that ends with an approval interrupt, `history(...).interrupts.pending` deep-equals the `RUN_FINISHED` outcome's interrupts and `runId` is the run's id.
- [x] 3.4 Export `History` and `history` through `Messages` in `index.ts` (already re-exported as a namespace; check nothing else is needed).

## 4. Matching and divergence

- [x] 4.1 In `Messages.ts` add `HistoryDiverged` (`Schema.TaggedError` with a brand, no fields, a message saying the client's history leaves the stored thread before its end).
- [x] 4.2 Rework `delta` (2, 3): known = stored id, or a `tool` message whose `toolCallId` has a stored tool result. Keep `HistoryMismatch` for a non-empty store with no known message. Find the anchor's stored position and fail with `HistoryDiverged` when a visible stored entry after it (the same visibility as `history`) is matched by no client message. Entries committed by the run being reconciled are skipped, so a run executed again after a crash passes (`delta` takes the run id; found while implementing, see design 2). The delta is the client messages after the anchor. Share the visibility rule with `history` rather than restating it. Verify in `Messages.test.ts`: every scenario of "Client messages are ingested as a delta" and "Divergent history is rejected" at the function level, including the TanStack `tool-<toolCallId>` id, leftover cancelled-step text, a reordered tool result, an approval response after the anchor, a summary before the kept entries, edit and regenerate.
- [x] 4.3 Verify in `Runner.test.ts`: an edited history ends with `RUN_STARTED` then `RUN_ERROR` code `HistoryDiverged`, commits nothing (the store's entries are unchanged), never calls the model, and calls `runEnded` once with the failed outcome and that code. Also verify that a client sending `history(...).messages` plus a new user message after a completed run and after an approved interrupt (with a `resume` entry) is accepted, and only the new message is committed ("A read history is accepted as the client's history").
- [x] 4.4 Verify in `Runner.test.ts`, for "The store owns compaction": a store whose `load` appends an unseen assistant summary after the client's latest entry makes the next run fail with `HistoryDiverged`; one that puts a system summary first does not.

## 5. Library docs

- [x] 5.1 README "Threads": the read path (`Effect.map(thread.load(id), Messages.history)` behind the caller's own authorised `GET`), what it shows and hides, the reload story for `@ag-ui/client` (restore `messages`, answer `interrupts` via `resume`) and TanStack AI (server hydrate, no `history.pageSize`), tool matching by `toolCallId`, and `HistoryDiverged` with its remedy (read the thread again). Add `HistoryDiverged` to the error list under "Running over AG-UI".
- [x] 5.2 README "Writing your own stores": `load` returns each committed entry's `runId`; compaction summaries are system entries or come before the client's latest seen entry (6).
- [x] 5.3 `packages/effentic/AGENTS.md`: the `Messages` note (known/anchor/divergence, `history`), the `Thread` note (run ids, compaction rule), and the `AgUi` note (`approvalInterrupt`). Update the `Messages` row in the README module reference.

## 6. TanStack example

- [x] 6.1 In `src/server/chat.server.ts` add `GET /api/chat`: decode `threadId` from the query (400 if missing), `Thread.load`, `Messages.history`, convert the messages with `@tanstack/ai`'s `modelMessagesToUIMessages`, and answer JSON `{ messages, interrupts: { runId, pending } | null, activeRun: null }` (7). If the converter mishandles a message, map by hand instead and note why. In `src/routes/api/chat.ts` forward `GET` as well as `POST`.
- [x] 6.2 In `src/routes/index.tsx` take `threadId` from a `?thread=` search param (validated by the route), generating one and replacing the URL when absent. Pass `persistence: true` to `useChat`, with no `history` option. Keep the Approve/Deny card as is and check it handles restored interrupts. Update comments that say each page load needs a fresh thread.
- [x] 6.3 Update `packages/examples/tanstack/AGENTS.md`: the hydrate route, the stable thread id, why paging is off, and that a reload during a run cancels it (no rejoin). Replace manual check 5 with a reload that keeps the history, then add: a follow-up question after reload uses the earlier turns; reload while an approval card is open restores the card, and approving it sends the email; a new tab without `?thread=` starts an empty thread.
- [x] 6.4 Run the example in a browser and go through every manual check, the new ones included. Record anything TanStack sends that the design didn't expect (extra rows, ids) in design.md before fixing it.
  - Server side (2026-10-25), scripted with TanStack's own `uiMessagesToWire` against the dev server. A turn with a tool call, then hydrate, convert back and ask a follow-up: accepted, answers "Paris". An approval after hydrate: the hydrated interrupt equals `RUN_FINISHED`'s, with run id; approving it sends the email, and the next run is accepted. An edited history gets `HistoryDiverged`.
  - Browser (2026-10-25), checks 1–8 in the example's `AGENTS.md`, all on one thread: all pass. Every `GET`/`POST /api/chat` answered 200, with no console errors. Nothing unexpected from TanStack. The one visible difference is the one design.md's risks already name: restored tool arguments show as compact JSON.

## 7. Wrap-up

- [x] 7.1 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding. Run `openspec validate thread-history-sync --strict`.
