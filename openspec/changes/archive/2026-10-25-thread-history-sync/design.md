## Context

See proposal.md for why. The current state that shapes the approach:

- **Ids already line up on the server.** A step's assistant entry is keyed by the step's `messageId` (`Agent.ts`). The event stream uses that same id for `TEXT_MESSAGE_*` and as `parentMessageId` on `TOOL_CALL_START` (`AgUi.ts`, `StepState`). A tool entry is keyed by the `messageId` of its `TOOL_CALL_RESULT`. Every text segment of a step goes out under the step's one id.
- **Clients don't all keep them.** `@ag-ui/client` keeps every id, and inserts a tool message directly after the assistant message holding its call. TanStack AI 1.0 keeps assistant and user ids, but drops `TOOL_CALL_RESULT.messageId`: when it posts, a tool row's id is `tool-<toolCallId>`. While an approved call has no result yet, it also adds a placeholder tool row with that id.
- **Clients keep messages the store never committed.** A step that is cancelled or fails mid-stream commits nothing (per-step commit), but the client keeps the text it already streamed, under the step's id.
- **The run is resolved after the claim.** `Runner` claims the thread, loads it, then runs `Messages.delta` and `Messages.resume`. `HistoryMismatch` is raised there, so the store hears about it through `runEnded`.
- **The store records nothing per run.** `Thread.commit(threadId, runId, entries)` receives the run id, but `Entry` is `{ id, message }`, so `load` can't say which run wrote what.
- **TanStack AI 1.0's server hydrate.** With `persistence: true` and no `history.pageSize`, `useChat` does a `GET <chat url>?threadId=…` on mount. It expects `{ messages: UIMessage[], interrupts?: { runId, pending: Interrupt[] }, activeRun?: { runId } }`, and drops `interrupts` without a string `runId`. It still posts the full history on every run. With `history.pageSize` set, it posts only the messages the server has not sent it, which a delta-based server reads as `HistoryMismatch`. Given `activeRun`, it rejoins with `GET ?runId=…&offset=-1` and reconnects with `Last-Event-ID`.

## Goals / Non-Goals

**Goals:**

- A client restores the conversation and its open approvals from one read, and its next run is accepted.
- The read returns what the event stream showed, so a client that loaded it and a client that streamed it are matched against the store the same way.
- A history that edits or drops a turn is rejected instead of being appended.
- Both `@ag-ui/client` and TanStack AI pass the check on normal use, including after a cancelled step.

**Non-Goals:**

- Edits, regenerate and branches.
- History paging (`limit` / `before`, TanStack's `history.pageSize`).
- Rejoining a run in flight, `MESSAGES_SNAPSHOT`, and the review #3 double-run (decision 8).
- Authorising the read route. As with the run route, that is the caller's job.

## Decisions

### 1. A pure read function in `Messages`

```ts
export interface History {
  readonly messages: ReadonlyArray<AgUiCore.Message>; // user, assistant, tool
  readonly interrupts: { readonly runId: string | undefined; readonly pending: ReadonlyArray<AgUiCore.Interrupt> } | undefined;
}
export const history: (entries: ReadonlyArray<Thread.Entry>) => History;
```

A caller writes `Effect.map(thread.load(threadId), Messages.history)` in its route. It sits next to `delta`, `resume` and `project`, all pure over loaded entries. It is not a `Thread` method, which would make every store implement it. It is not a runner method either, because a read needs no agent.

What it shows, entry by entry, in commit order, with each tool result moved directly after the assistant message holding its call (as `@ag-ui/client` orders them):

- **user** → `{ id, role: "user", content }`, the entry's text.
- **assistant** → `{ id, role: "assistant", content?, toolCalls? }`. `content` is the text parts joined; the stream sends those as one message's deltas. `toolCalls` lists every tool-call part, because the stream announces provider-executed calls too, with `arguments: JSON.stringify(params)`. An assistant entry with neither text nor tool calls is left out, because the stream emitted no message for it. Reasoning parts are dropped, as the stream drops them.
- **tool** with a tool result → `{ id, role: "tool", toolCallId, content: JSON.stringify(result ?? null) }`, the exact `TOOL_CALL_RESULT` content.
- **system** entries (client system messages, compaction summaries) and approval-response entries are left out. The stream never showed them as messages.

`toolCalls[].arguments` can differ in formatting from the raw deltas the client streamed, which is harmless because matching is by id. Call this set of messages the thread's *visible* messages. Decision 2 is defined on it.

`interrupts` lists the approval requests that have no response yet, which is the same pending set `resume` computes. Each interrupt is built by the shared builder (decision 5). `runId` is the run id of the assistant entry holding the request (decision 4). It is `undefined` when there are no open interrupts.

*Alternative rejected:* returning `Prompt.Message`s and letting callers map them. Every caller would have to reproduce the stream's ids and content exactly, and that is the part that has to be right.

### 2. Divergence: the client must hold every visible message after its anchor

`delta(stored, client)` keeps its signature and gains a second error:

1. A client message is *known* if a stored entry has its id, or if it is a `tool` message and a stored tool result has its `toolCallId`. Every other client message is *unknown* and ignored for matching: uncommitted partial text, TanStack's placeholder rows, reasoning rows, and so on.
2. With a non-empty store and no known client message, the result is `HistoryMismatch`, as today.
3. The *anchor* is the client's last known message. Its stored position is the index of the entry it matched.
4. If any visible stored message after the anchor's position is not matched by some client message, the result is `HistoryDiverged`. A client message can match it anywhere in the client's history, not only after the anchor, so tool results that a client moves up still count. Entries committed by the run being reconciled are skipped. A detached or workflow run executed again after a crash reconciles its original input against a thread its earlier attempt already extended, and those steps can't be in its input. This uses the entry run ids from decision 4, so `delta` takes the run id.
5. Otherwise the delta is the client messages after the anchor, as today, and `ingest` still keeps only user (and allowed system) messages from it.

This catches the cases that matter. Edit `[m1, m2']` against `[m1..m5]`: the anchor is `m1`, and `a1..m5` are missing. Regenerate, a resend without the last assistant: the anchor is the last user message, and the assistant after it is missing. A client that is simply behind the store fails the same way, and the remedy is to read the thread again.

What it lets through:

- client-only messages, wherever they appear (decision 6);
- `@ag-ui/client`'s reordering of tool results;
- TanStack's tool ids;
- approval-response and system entries the client never had, because they aren't visible.

*Alternatives rejected:*

- Comparing the client's history to the store position by position. A cancelled step's leftover text, or a reordered tool result, would read as divergence.
- Requiring the anchor to be the last stored entry. A thread whose last entry is a tool result or an approval response would always fail for TanStack.

### 3. Tool messages match by `toolCallId`, not by fixing ids

The server's ids are already right, and nothing the server does can make TanStack send `TOOL_CALL_RESULT.messageId` back. Tool call ids come from the provider, every client keeps them, and a thread has exactly one result per call. A stored tool entry whose result has the same `toolCallId` is therefore an unambiguous match.

*Alternative rejected:* minting tool entry ids as `tool-<toolCallId>` to match TanStack. That couples the library to one client's convention, and it changes ids that `@ag-ui/client` already matches.

### 4. The store records each entry's run

`Entry` gains `runId: Schema.optional(Schema.String)`. `commit(threadId, runId, entries)` stores each newly appended entry with that `runId`. An entry that was already present keeps its first run, because commits stay idempotent. `load` returns it. Entries a store writes itself, such as a compaction summary, may have none. The in-memory store stamps it on commit.

`history` takes the open interrupts' `runId` from the assistant entry holding them. One thread has one active run, and every request still open was raised by the run that ended last. If requests from different runs are somehow open together, the latest entry's run is used.

*Alternatives rejected:*

- The agent stamping its own entries. User and approval-response entries are built in `Runner`, and the commit already has the run id.
- A separate `Thread.interruptedRun(threadId)`: more store surface for one value the store can record anyway.
- Putting the run id inside the approval request part. It would leak into the model prompt's provider options.

### 5. One builder for the approval interrupt

`AgUi` exports `approvalInterrupt({ approvalId, toolCallId, toolName })`. That's the object `fold` builds today: `id`, `reason: "tool-approval"`, `toolCallId`, `message`, `responseSchema`. `fold` and `history` both use it. `history` takes `toolName` from the stored tool-call part. The `interrupt-metadata` change then passes its hook through this one function. Whichever change lands second wires it into both callers.

### 6. Compaction rule

Only visible messages can cause `HistoryDiverged`, and summaries are `system` entries, so the usual compaction never causes it: replace a prefix with a `system` summary and keep the latest entries. The store contract adds one rule. A compacted thread must not introduce a non-system entry after the latest entry the client has seen. Such an entry would be visible but unknown to the client, so the client's next run would fail with `HistoryDiverged`.

This needs no new store API. "Keep the latest entries the client has seen" (existing) and "write summaries as system entries, or before those entries" (new) cover it. A thread compacted so hard that none of the client's ids are left still fails with `HistoryMismatch`, as specified today.

*Alternative rejected:* `load` reporting the ids it compacted away, so the check could skip them. More store surface, and it covers only stores that break the existing rule.

### 7. The TanStack example serves the hydrate

- The same Effect router gains `GET /api/chat`. It reads `threadId` from the query, loads the thread, calls `Messages.history`, and answers `{ messages, interrupts, activeRun: null }`. The messages are converted to `UIMessage`s with `@tanstack/ai`'s exported `modelMessagesToUIMessages`, whose `ModelMessage` input has the same `toolCalls` / `toolCallId` shape as AG-UI. `interrupts` is `null` when nothing is open. The Start server route forwards `GET` as well as `POST`.
- The page takes `threadId` from a `?thread=` search param. When it's missing, the page generates one and replaces the URL, so a reload keeps the thread and a new tab starts fresh. `useChat` gets `persistence: true` and no `history` option (see Context for why paging is off).
- Restored approvals arrive in `interrupts` as `unbound`, like streamed ones, so the existing Approve/Deny card answers them unchanged.

### 8. What stays out, and why

- **`MESSAGES_SNAPSHOT`.** Neither client needs it to reload. TanStack reloads through the hydrate. An `@ag-ui/client` page has nothing to send, so it can't start the run that would carry a snapshot. TanStack's own server emits a snapshot before an interrupt's `RUN_FINISHED`, but only to carry client-tool and UI-resource state that effentic doesn't have. A later change can emit `history(...).messages` as a snapshot without changing this one.
- **Rejoining a run in flight.** The example runs are request-scoped. A reload cancels the run and releases the thread, so there's nothing to rejoin, and the hydrate answers `activeRun: null`. Rejoining would mean detached runs in the example, a store read for the active run, and a cancel path for detached runs. TanStack's `stop()` only drops the connection, so a detached run would keep running and holding its claim, and the next send would get `ThreadBusy`. That cancel path is a design problem of its own, and it would roughly double this change. Proposed as a follow-up.
- **Review #3 double-run.** Two tabs that both load an open interrupt can both answer it. The fix (the answering run owns step 0, and `commit` reports what it appended) touches step 0 and the store contract, not the read or the divergence check. It stays deferred.

## Risks / Trade-offs

- [A client that missed a committed step's events, for example after a network drop, now gets `HistoryDiverged`, where before its delta was appended] → This is the intended rejection. The README tells clients to read the thread again on `HistoryDiverged`, and the TanStack page can just reload.
- [Custom stores that don't return `runId` give interrupts without a `runId`, which TanStack ignores. Worse, a run executed again after a crash fails with `HistoryDiverged`, because its own earlier steps look missing] → `runId` is optional, so nothing breaks at the type level. The store contract and the "writing your own stores" section require it, and the in-memory store's tests cover it.
- [TanStack changes how it sends history (ids, placeholder rows, paging)] → Matching relies only on user and assistant ids and on tool call ids. The example's manual checks cover reload, a follow-up after reload, and an approval after reload.
- [`modelMessagesToUIMessages` mishandles an AG-UI message] → The example maps the messages by hand instead. That's a few lines, and the library's output doesn't change.
- [`history` shows assistant `arguments` re-serialised] → Matching never compares content. A client showing restored arguments sees the same JSON, possibly with different spacing.

## Migration Plan

- Store implementers return `runId` from `load` for the entries they committed. Data stored before the change has none, so interrupts already open in it reload without a `runId` until they are answered.
- Clients that sent edited histories get `HistoryDiverged` instead of a silently merged thread. There's no flag to restore the old behaviour.

## Open Questions

None left. `modelMessagesToUIMessages` takes the read's messages as they are, once `content` defaults to `null`. It merges each tool result into its call's `output` and keeps the stored tool id. So after a hydrate, TanStack sends tool rows under the server's ids, and before one it sends them under `tool-<toolCallId>`. Matching by `toolCallId` handles both.
