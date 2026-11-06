## Why

After `history-ownership`, `Messages` is meant to be the vocabulary (`Entry`) and the conversions between AG-UI messages, entries and the model prompt. But most of its public surface exists only for one history or the other:

- the server history's reconciliation steps: `delta`, `ingest`, `resume`, `answers` and `malformedAnswers`, and the `IngestOptions` and `Answers` types;
- the server history's rejections: `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt` and `UnansweredToolCall`;
- the client history's conversion, `fromHistory` and `FromHistory`;
- `restore`, which reads back what the server history stored, and which every caller pairs with `thread.load`.

They are public because the module predates `History`. A reader of `Messages` meets server-only rules, such as "the client only contributes a delta", next to functions every run uses, and the module's purpose is blurred. This is the second of two clean-ups that came out of naming the three modules: the first moved `Thread.Entry` to `Messages.Entry`. It was deferred because it changes the public surface and the error classes callers match on.

The boundaries this change draws:

- `Thread` stores entries.
- `History` decides who owns a run's transcript: the two layers, the errors the server layer raises, and reading a stored thread back.
- `Messages` defines an entry and how entries become a model prompt.

## What Changes

- **BREAKING: the histories' conversions become internal.**
  - `delta`, `ingest`, `resume`, `answers`, `malformedAnswers` and `fromHistory` move out of `Messages`, with `IngestOptions`, `Answers` and `FromHistory`, into a new internal module, `src/internal/conversions.ts`. Their private helpers move with them.
  - The package no longer exports them. Nothing outside the histories calls them: neither the examples nor the specs use them.
  - `fromHistory` can become public again if a caller needs it.
- **BREAKING: the server history's errors move to `History`.**
  - `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt` and `UnansweredToolCall` are exported from `History`, the module whose layer raises them, instead of from `Messages`.
  - Their tags, and so their `RUN_ERROR` codes, are unchanged. A client matching on `code` sees no difference. Only code that imports the classes changes.
- **BREAKING: `restore` moves to `History` and loads the thread itself.**
  - `Messages.restore(entries)` becomes `History.restore(threadId)`, an `Effect<Restored, ThreadError, Thread>`. It loads the thread from `Thread` and converts it.
  - It does not go through the `History` service and makes no claim, so a route calls it with only its thread store provided.
  - `Restored` and `ShownMessage` move with it.
  - The pure conversion stays internal, next to `delta`, which shares its visibility rule.
- **`Runner.Options.clientSystem`** is typed as `"allow" | "drop" | undefined`, without reference to `Messages.IngestOptions`.
- **`layerClient` documents the client history's conversion.** `fromHistory`'s doc comment is currently the only statement of what the client history keeps and drops. Once it is private, the user-facing rules belong on `layerClient` and in the README.
- **`Messages` keeps** `Entry`, `project` and `INCOMPLETE_TOOL_CALL_RESULT`. Its module comment then describes only entries and the prompt.
- **Behaviour is unchanged.** No requirement changes. `restore` reads the same thread and returns the same result; only its signature and module change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The specs name no function or module. `thread-history-read` requires "a read of a thread's loaded entries" that needs no run, agent or claim, which `History.restore` still is. The specs refer to errors by their `RUN_ERROR` code, which doesn't change. This change sets `skip_specs: true`.

## Impact

- `packages/effentic/src/Messages.ts`: keeps `Entry`, `project` and `INCOMPLETE_TOOL_CALL_RESULT`. Everything else moves out.
- `packages/effentic/src/internal/conversions.ts` (new): the conversions, their private helpers and the four error classes.
- `packages/effentic/src/internal/history.ts`: imports `internal/conversions.ts` instead of `Messages` for the conversions.
- `packages/effentic/src/History.ts`: re-exports the four error classes. Adds `restore`, `Restored` and `ShownMessage`. `layerClient`'s doc comment states the client history's conversion rules.
- `packages/effentic/src/Runner.ts`: `Options.clientSystem`'s type.
- `packages/effentic/src/AgUi.ts`: a doc comment that links `Messages.restore`.
- `packages/effentic/test`: the conversion tests move to a test of the internal module. A `History` test covers `restore` over `Thread.layerMemory`. `Runner.test.ts` reads threads back with `History.restore`.
- `packages/examples/tanstack`: the hydrate route calls `History.restore(threadId)`. Its `AGENTS.md` follows.
- Docs: `packages/effentic/README.md` (the client-history section, "Reloading a thread" and the module reference) and `packages/effentic/AGENTS.md` (the `Messages`, `History` and `Thread` notes, and the invariant that names `Messages.answers`).
- No new dependencies.
- **Builds on `history-ownership`** (landed), which created `History`, `internal/history.ts` and `Messages.Entry`.

## Non-goals

- **Where `Entry` and `project` live.** Once this change lands, they are all `Messages` holds. Whether they move, for example to `Agent` next to `orderToolResults`, and whether `Messages` remains, is left for a later decision.
