## Why

A page that reloads, or a second tab, cannot follow a run that is still streaming: `Thread` can claim and release a run but cannot say which run holds the claim, so `History.restore` has no active run to report and TanStack AI has nothing to rejoin. A hydrated page shows only finished steps and never catches up.

## What Changes

- **BREAKING** `Thread` gains a required `activeRun(threadId)` read, so custom stores must implement it. `Thread.layerMemory` implements it.
- `History.restore` gains an opt-in `{ rejoin: true }` mode for routes that serve joins from the `EventLog`. In that mode it reports `activeRun: { runId } | undefined` and leaves out what that run's log will replay, so hydrated messages plus a from-the-start replay give the thread exactly once. Calls without the option behave exactly as they do today.
- The claim is read before the thread is loaded, so a run ending between the two reads leads to a harmless join of a finished log rather than stale messages with no active run.
- The docs say a claim only means a joinable stream under `makeDetached` or `makeWorkflow`, because `makeAttached` claims the thread but never writes to the `EventLog`.
- The TanStack example moves from `makeAttached` to `makeDetached`: `POST /api/chat` starts the run and follows its log, hydrate returns the real `activeRun`, and `GET /api/chat` serves TanStack's join request.
- The TanStack example removes its Stop button, because a detached run ignores disconnects and the library has no way to cancel one. The composer waits for the run to end.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `thread-store`: the store can report which run holds a thread's claim.
- `thread-history-read`: the read can report the active run and leave out the output its event log will replay.

## Impact

- `packages/effect-agent-harness`: `src/Thread.ts`, `src/History.ts`, `src/internal/conversions.ts`, tests, `AGENTS.md`, README if it documents `Thread` or `restore`.
- Any custom `Thread` store and any test stub built with `Thread.of` must add `activeRun`.
- `packages/examples/tanstack`: `src/server/chat.server.ts`, `src/routes/index.tsx`, `AGENTS.md`.
- No new dependencies. Cancelling a detached run stays out of scope.
