## 1. Thread store

- [x] 1.1 Add the required `activeRun(threadId)` member to `Thread`, with its doc comment, and implement it in `layerMemory`
- [x] 1.2 Add `activeRun` to the `Thread.of` stubs in `test/Runner.test.ts`
- [x] 1.3 Test the `thread-store` scenarios: claimed, released, unknown and independent threads, and that the read leaves the claim unchanged

## 2. Rejoining read

- [x] 2.1 Add the internal helper to `internal/conversions.ts` that removes the active run's assistant entries and the tool results for their calls
- [x] 2.2 Add `activeRun` to `Restored`, returning `undefined` from the plain read
- [x] 2.3 Add the `{ rejoin: true }` option to `History.restore`, reading the claim before `load`, and document that it is only for routes serving joins from the `EventLog`, naming `makeDetached` and `makeWorkflow`
- [x] 2.4 Test the helper against the `thread-history-read` scenarios: multi-step run, continuation of an interrupted run, frontend result from the active run, entries with no run id
- [x] 2.5 Test `History.restore`: the read without `rejoin` during a run, no run in flight, and a stubbed store whose run ends between the two reads
- [x] 2.6 Test with a detached run that the message ids of a rejoining read and the ids in the run's log don't overlap, except for results the run keeps for earlier runs' calls, passing the log through `verify`

## 3. TanStack example

- [x] 3.1 Build a `Runner.makeDetached` runner and read `EventLog` in the routes in `chat.server.ts`
- [x] 3.2 Change `POST /api/chat` to start the run and follow its log, skipping `start` when `Last-Event-ID` is present
- [x] 3.3 Add the join branch to `GET /api/chat`, mapping `offset=-1` to no cursor, honouring `Last-Event-ID` and answering an unissued cursor with 400
- [x] 3.4 Hydrate with `{ rejoin: true }` and return the real `activeRun`
- [x] 3.5 Apply the idle timeout to both event streams
- [x] 3.6 Pass the thread id in the connection URL in `index.tsx`, remove the Stop button and disable Send while loading
- [x] 3.7 Update the comments in `chat.server.ts` that describe request-scoped runs

## 4. Docs and verification

- [x] 4.1 Update `packages/effect-agent-harness/AGENTS.md` (`Thread.ts`, `History.ts`, `internal/conversions.ts`), `packages/examples/tanstack/AGENTS.md`, and the README if it covers `Thread` or `restore`
- [x] 4.2 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
- [x] 4.3 Against the running app with TanStack's `ChatClient`, reload during a multi-step run and confirm the run continues with no duplicated text, then repeat from a second tab
- [x] 4.4 Against the running app with TanStack's `ChatClient`, reload during a continuation after an approval and record how the earlier assistant message and the step-0 result render, then document or fix what is found
