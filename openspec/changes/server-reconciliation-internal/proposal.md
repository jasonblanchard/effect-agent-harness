## Why

After `history-ownership`, `Messages` is meant to be the vocabulary (`Entry`) and the conversions between AG-UI messages, entries and the model prompt. But half of its public surface exists only for `History.layerServer`:

- the reconciliation steps: `delta`, `ingest`, `resume`, `answers`, `malformedAnswers`, and the `IngestOptions` and `Answers` types;
- the server history's rejections: `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt` and `UnansweredToolCall`.

They are public because the module predates `History`. Under the client history none of them runs. So a reader of `Messages` meets server-only rules, such as "the client only contributes a delta", next to functions both histories use, and the module's purpose is blurred. This is the second of two clean-ups that came out of naming the three modules: the first moved `Thread.Entry` to `Messages.Entry`. It was deferred because it changes the public surface and the error classes callers match on.

## What Changes

- **BREAKING: the server reconciliation becomes internal.**
  - `delta`, `ingest`, `resume`, `answers` and `malformedAnswers`, with `IngestOptions` and `Answers`, move out of `Messages` into an internal module next to the server history's implementation (`src/internal/`).
  - The package no longer exports them. Nothing outside the server history calls them: neither the examples nor the specs use them.
- **BREAKING: the server history's errors move to `History`.**
  - `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt` and `UnansweredToolCall` are exported from `History`, the module whose layer raises them, instead of from `Messages`.
  - Their tags, and so their `RUN_ERROR` codes, are unchanged. A client matching on `code` sees no difference; only code that imports the classes changes.
- **`Runner.Options.clientSystem`** is typed without reference to `Messages.IngestOptions`, since that type becomes internal.
- **`Messages` keeps:**
  - `Entry`;
  - `project` (both histories);
  - `restore` and `Restored` (a public helper for routes that read a stored thread back);
  - `fromHistory` and `FromHistory` (the client history's conversion; see Open questions);
  - `INCOMPLETE_TOOL_CALL_RESULT`.

  Its module comment then describes only conversions.
- **Behaviour is unchanged.** No requirement changes: this is a change to module boundaries and exports only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. No spec names these functions or the modules the errors come from. The specs refer to errors by their `RUN_ERROR` code, which doesn't change. This change sets `skip_specs: true`.

## Impact

- `packages/effentic/src/Messages.ts`: loses the reconciliation functions, their types and the four error classes. The private helpers they share with `restore` (`pendingApprovals`, `pendingFrontendCalls`, `shown`, `resultOf`, `textOf`) need a home both sides can import. `delta` and `restore` must keep sharing the visibility rule (`shown`).
- `packages/effentic/src/internal/`: a new module for the reconciliation; `internal/history.ts` imports it instead of `Messages`.
- `packages/effentic/src/History.ts`: exports the four error classes. They must be defined where `internal/history.ts` can import them without a cycle through `History.ts`, for example in the internal module, re-exported by `History`.
- `packages/effentic/src/Runner.ts`: `Options.clientSystem`'s type; doc comments listing the errors.
- `packages/effentic/test`: the reconciliation unit tests import the internal module directly. Tests that name the error classes import them from `History`.
- Docs: `packages/effentic/AGENTS.md` (the `Messages` and `History` notes), the README's module reference and the sections listing the errors, and the doc comments that link to them.
- No new dependencies. The examples use none of the moved names.
- **Depends on `history-ownership`**, which creates `History`, `internal/history.ts` and `Messages.Entry`. Land it first.

## Open questions

- **Does `fromHistory` stay public?** Like the reconciliation, only one history uses it. It is a self-contained, documented conversion, though, and is useful on its own, for example to build an eval prompt from a client transcript. The proposal keeps it public; making it internal too would leave `Messages` with `Entry`, `project` and `restore` only.
- **Does `restore` belong in `Messages` or `History`?** It reads what the server history stores, but it is a pure conversion of entries that a route calls with its own `Thread`. The proposal keeps it in `Messages`.
