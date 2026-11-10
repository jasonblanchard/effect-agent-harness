## Context

See proposal.md for motivation. The facts that shape the approach:

- The server history claims a thread before loading it and releases it before the terminal event. `makeAttached` releases when its stream stops early. Detached and workflow runs keep the claim until they end or are resumed.
- Only detached and workflow runs write to the `EventLog`. `subscribe` waits forever on a run with no events, and on a partial log that never reaches a terminal event.
- `History.restore` is `thread.load` followed by a pure conversion. Entries carry the `runId` of the commit that appended them.
- TanStack AI (`@tanstack/ai-client` 1.0.0) hydrates with `GET url?threadId=…`, then joins with `GET url?offset=-1&runId=…`. The join URL has no thread id. It replays the run from the start and drops only the last hydrated assistant message.
- `Sse.encodeStored` tags frames with `id:`, which makes TanStack treat the stream as durable. It then reconnects a dropped stream by re-issuing the same request with `Last-Event-ID`, including the `POST`.
- A spike against TanStack's real `StreamProcessor` showed that hydrating two committed steps and replaying them duplicates the first step's text. Hydrating without the active run's output rendered correctly.

## Goals / Non-Goals

**Goals:**

- A route on a detached or workflow runner can hydrate a thread and join its active run with each message shown once.
- A route on `makeAttached` cannot be led into joining a log that is never written.

**Non-Goals:**

- Cancelling a detached run.
- Telling a crashed run from a slow one. The claim's expiry and the join route's idle timeout bound the damage.
- Moving the `ag-ui` example, which has no hydrate route.

## Decisions

### `activeRun` and the output filter are opt-in with `{ rejoin: true }`

`History.restore(threadId, { rejoin: true })` returns `activeRun` and filters. Without the option the read is unchanged and `activeRun` is `undefined`.

Why: filtering is only correct if the caller really serves a replay of the log. Under `makeAttached` it would hide committed steps from a second tab and offer a run with no log. Making it opt-in means the route that knows its runner states it.

Alternatives considered:

- Always report `activeRun` and always filter. This regresses attached routes.
- Always report `activeRun` with full messages, plus a list of ids to drop. This puts the filter in every route, and forgetting it brings back the duplicate text.

### The filter runs in the pure conversion and removes only what the log replays

A new internal helper takes the loaded entries and the active run id. It drops that run's assistant entries and the tool results answering calls those entries hold. Everything else stays, including that run's user messages and its answers to earlier runs' calls. The existing `restore` conversion then runs on the remainder, so interrupts and pending calls follow without new logic.

Alternative considered: dropping every entry of the active run. That would lose the user's message, which the log never shows, and would reopen interrupts the run has already answered.

### Read the claim, then load

If the run ends between the reads, its output is filtered out and the client joins a finished log, which replays all of it. The other order can return stale messages with no active run, and the page would miss the final step.

### `Thread.activeRun` is required

`activeRun: (threadId) => Effect<string | undefined, ThreadError>`. An optional member would let a custom store silently never report a run. A claim is already a stored value, so the read is cheap to add.

### The TanStack example

- The page passes `/api/chat?threadId=…` as the connection URL, so the join request carries the thread id that `EventLog` needs. Hydrate overwrites the same parameter with the same value, and `POST` ignores it.
- `POST /api/chat` calls `detached.start(input)` and then returns `Sse.encodeStored` over `log.subscribe`. When the request has `Last-Event-ID` it skips `start` and subscribes after that cursor, because a second `start` during an in-flight run would fork a second attempt of it.
- `GET /api/chat` with `runId` present is a join. `offset=-1` means no cursor, and `Last-Event-ID` wins when present. An unissued cursor is a 400. Without `runId` it is the hydrate, using `{ rejoin: true }`.
- The run's `threadId` comes from the query and is the thread the route authorises, as with hydrate. This example has no authentication, and the comment should say that a real route authorises it.
- Both streams end after an idle timeout of about two minutes without an event. TanStack reconnects once with `Last-Event-ID`, and a pass with no progress surfaces `DurableStreamIncompleteError`, so the client ends with a visible error rather than hanging.
- The Stop button is removed. Send is disabled while `isLoading`, so a message can't hit `ThreadBusy` from the same tab.

## Risks / Trade-offs

- [A crashed detached run keeps its claim, so joins replay a partial log until the idle timeout] → The timeout ends the stream with a visible error. Durable stores should expire claims, as `Thread` already documents.
- [A failed join leaves a page showing less than a plain read would, because the run's output was filtered] → Reloading after the run ends shows everything. Accepted, since joins fail rarely and only in the pre-attach window.
- [On a continuation run with no new user message, TanStack's "drop the last assistant" removes the earlier run's assistant message, and the replay doesn't rebuild it] → Confirmed against the running app: the message is missing until the next reload after the run ends. This is client behaviour the library can't change, so the example's `AGENTS.md` documents it.
- [A step-0 result for an approved call is both kept and replayed] → Replay applies to a tool call the client already has. Against the running app it rendered once, as a completed call with its result.
- [Adding a required member breaks custom stores] → A compile error points directly at the missing member. Noted in the proposal.
