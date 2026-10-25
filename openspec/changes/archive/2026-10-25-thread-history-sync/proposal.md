## Why

The server owns each thread's history, and a run takes only the client's delta. Two client flows break under this model (review finding #7):

- **Reload:** a reloaded page, a new device or a fresh `HttpAgent` has no history to send. The run fails with `HistoryMismatch`, and the client has no way to get the thread back. It also loses its open interrupts, so its next run is rejected with `UnansweredInterrupt`, and it cannot see which interrupts it has to answer.
- **Edit or regenerate:** with `[m1..m5]` stored, a client that edits turn 2 sends `[m1, m2']`. `Messages.delta` finds `m1` as the last id it knows and appends `m2'` after `m5`. The model sees both histories, and nothing errors.

AG-UI 1.0 says a producer must treat `messages` as the complete history. Server-owned history was a deliberate decision, so this change keeps it and closes the two gaps instead.

## What Changes

- **Read path for a thread.** The library gains a function that turns a thread's stored entries into AG-UI messages, with assistant tool calls and tool results, and also returns the thread's open interrupts and the id of the run that raised them. The messages are the ones the event stream showed, with the same ids and content. The library does not serve the HTTP route. A caller exposes it as its own `GET` route, the same way it owns authentication. The README documents the reload story, and the `tanstack` example serves TanStack AI's server hydrate from it.
- **Divergent client history is rejected.** If a client's history leaves the stored thread before its end, so that it lacks a stored message it could have seen, the run ends with `RUN_ERROR` code `HistoryDiverged`. Like `HistoryMismatch`, this happens before anything is committed and before the model is called. A divergent delta is no longer appended. Supporting edits and branches stays out of scope.
- **Tool messages match by tool call id.** The server's stored ids already equal the ids in the event stream, and `@ag-ui/client` keeps them. TanStack AI does not: it sends tool results back as `tool-<toolCallId>`. A client tool message therefore matches a stored tool result by its `toolCallId`, which every client keeps. Assistant and user messages still match by id.
- **Messages only the client has are tolerated.** A step that is cancelled or fails leaves streamed text on the client that the store never committed. Such messages, and other rows the store does not know, do not count as divergence.
- **Stored entries record their run.** Loading a thread returns, for each entry, the id of the run that committed it, so the read path can name the run that raised the open interrupts. TanStack AI needs that run id to restore them.
- **Compaction must not look like divergence.** Only messages the read path would show count, so a summary written as a `system` entry never causes `HistoryDiverged`. The store contract says where a compacted thread may put any other entry it writes.
- **Not in this change:** `MESSAGES_SNAPSHOT` (no client here needs it to reload), rejoining a run still in flight after a reload, and the double-run of an approved call answered from two tabs (review #3). design.md gives the reasons.

## Capabilities

### New Capabilities
- `thread-history-read`: projecting a stored thread into the AG-UI messages the client saw and its open interrupts, so a client can restore its state.

### Modified Capabilities
- `agui-agent-loop`: "Client messages are ingested as a delta" gains tool-call matching and tolerates unknown messages; a new requirement adds the `HistoryDiverged` rejection.
- `thread-store`: loaded entries carry the committing run's id, and "The store owns compaction" says where a compacted thread may place entries it writes.

## Impact

- **`packages/effentic`:**
  - `Thread`: `load` returns each entry's run id. The in-memory store records it on commit. Custom stores must do the same (breaking for store implementers).
  - `Messages`: the read function, the matching and divergence rule in `delta`, and `HistoryDiverged`.
  - `AgUi`: the approval interrupt is built in one place, shared by the event stream and the read path.
  - `Runner`: reports `HistoryDiverged` like `HistoryMismatch`.
- **Example (`packages/examples/tanstack`):** serves TanStack AI's server hydrate, a `GET /api/chat?threadId=…` answering `{ messages, interrupts }`, from the library's read function, converting the AG-UI messages to `UIMessage`s. The page switches to `persistence: true` with a stable `threadId` taken from the URL, so a reload restores the conversation and its open approvals instead of starting a new thread. Its `AGENTS.md` and manual checks are updated: the "fresh page" check becomes a reload that keeps the history. The `ag-ui` example is unchanged.
- **Docs:** the README and `AGENTS.md` sections on threads, reload and writing a store, and the error list.
- **Overlap:** the open `interrupt-metadata` change adds metadata to approval interrupts. The read path must return the same interrupts as the stream, so whichever change lands second passes the hook through the shared builder.
- **Behaviour change:** clients that relied on a divergent history being appended now get `HistoryDiverged`.
