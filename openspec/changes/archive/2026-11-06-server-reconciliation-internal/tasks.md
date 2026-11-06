## 1. Internal module

- [x] 1.1 Create `src/internal/conversions.ts` and move into it, bodies and doc comments unchanged: `delta`, `ingest`, `IngestOptions`, `resume`, `decision`, `malformedAnswers`, `answers`, `Answers`, `resultEntry`, `resultOf`, `fromHistory`, `FromHistory`, `parseObject`, `shown`, `ShownMessage`, `Restored`, the pure `restore`, `pendingApprovals`, `pendingFrontendCalls`, `textOf`, `TextPart`/`isTextPart` and `decodeApprovalResponse`
- [x] 1.2 Move the four error classes (`HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt`, `UnansweredToolCall`) into `src/internal/conversions.ts`, with tags unchanged
- [x] 1.3 Add a module comment to `src/internal/conversions.ts` saying it is the private half of `Messages`: the conversions the two histories run, not exported from the package
- [x] 1.4 Shorten the pure `restore`'s doc comment to point at `History.restore`, and replace `{@link}`s to now-internal names in comments that stay public

## 2. Public modules

- [x] 2.1 Reduce `src/Messages.ts` to `Entry`, `project` and `INCOMPLETE_TOOL_CALL_RESULT`, drop its unused imports, and rewrite its module comment to describe only entries and the prompt
- [x] 2.2 Point `src/internal/history.ts` at `internal/conversions.ts` for the conversions, `AttemptError` and `AttemptOptions` (keep `Messages` for `Entry`)
- [x] 2.3 Re-export the four error classes from `src/History.ts`, and `Restored` and `ShownMessage` as types
- [x] 2.4 Add `History.restore(threadId): Effect<Restored, ThreadError, Thread>`, which loads through `Thread.Thread` and applies the internal `restore`, with the user-facing doc comment moved from `Messages.restore`
- [x] 2.5 Rewrite `layerClient`'s doc comment to state the client history's conversion rules without referring to `fromHistory`
- [x] 2.6 Type `Runner.Options.clientSystem` as `"allow" | "drop" | undefined` and move `IngestOptions`' explanation of the values onto it
- [x] 2.7 Update the doc comment in `src/AgUi.ts` that links `Messages.restore` to `History.restore`

## 3. Tests

- [x] 3.1 Move the `delta`, `restore`, `ingest`, `resume`, `answers`, "frontend calls across a run", `malformedAnswers` and `fromHistory` suites from `test/Messages.test.ts` to `test/internal/conversions.test.ts`, importing `../../src/internal/conversions.ts`, with assertions unchanged
- [x] 3.2 Keep the `Entry` and `project` suites in `test/Messages.test.ts` and drop its now-unused imports and helpers (move shared helpers with the suites that use them)
- [x] 3.3 Add `test/History.test.ts`: `History.restore` over `Thread.layerMemory` returns the internal `restore` of the committed entries, and an unknown thread returns no messages, no interrupts and no pending calls
- [x] 3.4 Replace `Effect.map(loadThread, Messages.restore)` in `test/Runner.test.ts` with `History.restore`

## 4. Example

- [x] 4.1 Change the tanstack hydrate route (`packages/examples/tanstack/src/server/chat.server.ts`) to `yield* History.restore(threadId)` and drop its now-unused `thread` binding if nothing else uses it
- [x] 4.2 Update `packages/examples/tanstack/AGENTS.md` where it names `Messages.restore`

## 5. Docs

- [x] 5.1 README: the client-history section states the conversion rules instead of naming `Messages.fromHistory`
- [x] 5.2 README: "Reloading a thread" uses `History.restore(threadId)`
- [x] 5.3 README: the module reference lists `Messages` as `Entry`, `project` and `INCOMPLETE_TOOL_CALL_RESULT`, and `History` with the errors, `restore`, `Restored` and `ShownMessage`. Fix any section that says the errors come from `Messages`
- [x] 5.4 `packages/effentic/AGENTS.md`: rewrite the `Messages` note, move the conversion details under `History` / `internal/conversions.ts`, and update the `Thread` note and the invariant that name `Messages.answers`, `delta` and `restore`
- [x] 5.5 Grep the repo for each moved name with a `Messages.` prefix and fix what remains, outside archived changes

## 6. Verify

- [x] 6.1 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` from the root and fix every finding
- [x] 6.2 Confirm `src/index.ts` exposes none of the moved conversions: no `Messages.delta`, `Messages.fromHistory` and so on through `effentic`
