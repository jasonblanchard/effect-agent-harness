## Why

The server owns each thread's history, and a run takes only the client's delta. Two client flows break under this model (review finding #7):

- **Reload:** a reloaded page, a new device or a fresh `HttpAgent` has no history to send. The run fails with `HistoryMismatch`, and the client has no way to get the thread back. It also loses its open interrupts, so after `run-context` its next run is rejected with `UnansweredInterrupt`, and it cannot see which interrupts it has to answer.
- **Edit or regenerate:** with `[m1..m5]` stored, a client that edits turn 2 sends `[m1, m2']`. `Messages.delta` finds `m1` as the last id it knows and appends `m2'` after `m5`. The model sees both histories, and nothing errors.

AG-UI 1.0 says a producer must treat `messages` as the complete history. Server-owned history was a deliberate decision, so this change keeps it and closes the two gaps instead.

## What Changes

- **Read path for a thread.** The library gains a function that turns a thread's stored entries into AG-UI messages, with assistant tool calls and tool results, and also returns the thread's open interrupts. The library does not serve the HTTP route. A caller exposes it as its own `GET` route, the same way it owns authentication, like TanStack AI's chat-persistence load endpoint. The README documents the reload story, and the example adds the route.
- **Divergent client history is rejected.** If a client's history leaves the stored thread before its end, the run ends with `RUN_ERROR` code `HistoryDiverged`, before the thread is claimed or committed to and before the model is called. It is no longer appended. Supporting edits and branches stays out of scope.
- **Prerequisite: message ids line up.** The ids of stored assistant and tool entries must be the ids the client sees in the event stream. Otherwise, a client that sends back the history it loaded, or the one it built from events, would not match. This hasn't been checked yet. The change verifies it first and fixes the ids if they differ.
- **Compaction must not look like divergence.** A store that replaces entries with a summary must not cause `HistoryDiverged` for a client whose history ends on a message that was compacted away. The design settles the exact rule.
- **Alternative to weigh in design.** AG-UI's own mechanism is to emit `MESSAGES_SNAPSHOT` at run start, or on `HistoryMismatch`. The design compares it with the GET route, and may choose to offer both. A snapshot alone does not help a client that has nothing to send yet.

## Capabilities

### New Capabilities
- `thread-history-read`: projecting a stored thread into AG-UI messages and open interrupts so a client can restore its state. This covers id stability between the event stream and the stored entries.

### Modified Capabilities
- `agui-agent-loop`: "Thread history from the server store" gains the divergence rule and the `HistoryDiverged` rejection.

## Impact

- **`packages/effentic`:**
  - `Messages`: the new projection to AG-UI messages, and the divergence check in or next to `delta`.
  - `Runner`: maps the new error to `RUN_ERROR`.
  - Possibly `Agent` or `AgUi`: if the ids don't match, the id assignment for assistant and tool entries changes.
  - Possibly `AgUi`: adds `MESSAGES_SNAPSHOT` to the event union.
- **Example (`packages/examples/ag-ui`):** a `GET /threads/:threadId` route, and a client that restores `messages` and `pendingInterrupts` from it.
- **Docs:** the README and `AGENTS.md` sections on threads and reload, and the error list.
- **Ordering:** builds on `run-context` (`UnansweredInterrupt`, the claim, the thread-store capability). Archive it after `run-context`.
- **Behaviour change:** clients that relied on a divergent history being appended now get `HistoryDiverged`.
