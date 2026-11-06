## Context

See proposal.md for why. Today:

- `src/Messages.ts` (~790 lines) holds `Entry`, `project`, `INCOMPLETE_TOOL_CALL_RESULT` and everything this change moves.
- The moving functions share private helpers:
  - `shown` (`delta` and `restore`);
  - `pendingApprovals` and `pendingFrontendCalls` (`resume`, `answers` and `restore`);
  - `decision` (`resume` and `fromHistory`);
  - `resultEntry` and `resultOf` (`answers` and `fromHistory`);
  - `ingest` (the server history, and `fromHistory` for non-assistant roles);
  - `textOf` and `isTextPart` (almost all of them).

  `project` uses none of them.
- `src/internal/history.ts` imports `Messages` for both the conversions and `Entry`. `History.ts` imports `internal/history.ts`, so whatever `internal/history.ts` needs can't be defined in `History.ts` without a cycle.
- Its only cross-module uses are `Runner.Options.clientSystem` (`Messages.IngestOptions["clientSystem"]`) and the tanstack hydrate route (`Messages.restore(yield* thread.load(threadId))`).
- Tests match the errors by `RUN_ERROR` code, never by class, outside `Messages.test.ts`.

## Goals / Non-Goals

**Goals:**

- Every name that serves only one history is either private or exported from `History`.
- Moving a function changes no behaviour. A moved function keeps its body and doc comment, and the moved tests pass unchanged apart from their imports.
- No private helper is shared across a public module boundary.

**Non-Goals:**

- Splitting or refactoring the moved conversions. They move as one unit.
- Deciding where `Entry` and `project` live (see proposal.md, Non-goals).
- A `restore` that understands compaction, pagination or the client history.

## Decisions

### One internal module, `src/internal/conversions.ts`

Everything leaving `Messages` except the public face of `restore` goes into one file: the conversions, their option and result types, the helpers listed above, and the four error classes. It sits next to `internal/history.ts`, which imports it as `Conversions`. The file is named the same as the import. It is not called `messages.ts`: importing it as `Messages` would clash in `internal/history.ts`, which also imports the public `Messages` for `Entry`.

```
History.ts ──▶ internal/history.ts ──▶ internal/conversions.ts ──▶ Agent, AgUi, Messages (Entry)
    │   └──────────────────────────────────────▲   (re-exports errors and types; wraps restore)
    └──▶ Thread.ts ──type──▶ Messages
Runner.ts ──▶ Messages (project), internal/history.ts
```

_Alternatives:_
- Split by history (`internal/server.ts`, `internal/client.ts`, plus a shared `internal/entries.ts`). The helpers are shared across both histories and `restore`, so the shared file would hold most of the code, and the split would add files without making any of them simpler to read.
- Folding the conversions into `internal/history.ts`. That would mix pure conversions with the effectful `Service` implementations. It would also make the conversion tests import the module that holds the layers.

### The errors are defined internally and re-exported by `History`

`internal/conversions.ts` defines `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt` and `UnansweredToolCall`, because the functions that return them live there. `History.ts` re-exports them by name (`export { HistoryMismatch, … } from "./internal/conversions.ts"`). The class is the same object either way, so `instanceof` and `Schema.is` behave as before. The tags don't change, so `Agent.errorCode` gives the same codes.

`internal/history.ts`'s `AttemptError` names them through `internal/conversions.ts`, not `History`.

_Alternatives:_
- Defining them in `History.ts`. `internal/history.ts` would then import `History.ts`, which imports it back.
- A separate `internal/errors.ts`. That adds a module for four classes that only `internal/conversions.ts` raises.

### `History.restore(threadId)` loads, then converts

```ts
export const restore = (threadId: string): Effect.Effect<Restored, Thread.ThreadError, Thread.Thread> =>
  Effect.map(
    Effect.flatMap(Thread.Thread, (thread) => thread.load(threadId)),
    internal.restore,
  );
```

The pure `restore(entries)` moves unchanged to `internal/conversions.ts`, next to `delta`, which must keep using the same visibility rule (`shown`). `Restored` and `ShownMessage` are defined there, because the pure function returns them, and `History` re-exports them as types. `restore`'s doc comment moves to `History.restore`. It says that `restore` reads the server history's store, makes no claim, needs no run and is authorised by the caller's route. The internal function keeps a short comment that points to it.

_Alternatives:_
- Keeping the pure `(entries) => Restored` signature, now in `History`. Every caller pairs it with `thread.load`, and a route should not need to know that reading a thread back is a load followed by a conversion.
- Going through the `History` service, so the client history could answer "nothing stored". The service is opaque and per-run, a hydrate route has no run context, and under the client history there is nothing to restore. Requiring `Thread` says exactly what the read needs.
- Taking the `Thread` service as a parameter. That doesn't match the rest of the library, where services come from context.

### `clientSystem` is a literal union at the public edge

`Runner.Options.clientSystem` is typed `"allow" | "drop" | undefined`. `IngestOptions`' doc comment, which explains the two values, moves onto that field. Internally, `IngestOptions` keeps its name and shape, and `internal/history.ts`'s `AttemptOptions` refers to it. The two types are compatible by structure, so `Runner` passes the option through unchanged.

_Alternative:_ a public `History.ClientSystem` type alias. It adds a name for a two-member literal that only one option field uses.

### `layerClient` states the client history's rules

`fromHistory`'s doc comment stays on the internal function, for maintainers. `layerClient`'s doc comment replaces "converted as `Messages.fromHistory` describes" with the parts a caller relies on:

- user text, and `system`/`developer` messages per `clientSystem`;
- assistant text and tool calls;
- a call whose arguments aren't a JSON object is dropped with its results;
- a result with no call is dropped, and only the first result per call is kept;
- a `resume` entry answers the unanswered call whose `Agent.approvalIdFor` it names, and other entries are ignored;
- an unanswered call is sent to the model with a failed result.

The README's client-history section says the same in prose.

### Tests follow the code

- `test/Messages.test.ts` keeps the `Messages.Entry` and `Messages.project` suites.
- The other suites (`delta`, `restore`, `ingest`, `resume`, `answers`, "frontend calls across a run", `malformedAnswers`, `fromHistory`) move to `test/internal/conversions.test.ts`. They import `../../src/internal/conversions.ts` and lose the `Messages.` prefix in their `describe` names. Their assertions don't change.
- A new `test/History.test.ts` covers `History.restore` over `Thread.layerMemory`: a committed thread reads back as the pure `restore` of its entries, and an unknown thread reads back empty. The wrapper is covered there, and the conversion rules stay covered by the internal suite.
- `Runner.test.ts` reads threads back with `History.restore` instead of `Effect.map(loadThread, Messages.restore)`.

Vitest's default include and the package tsconfig (no `include`) already pick up `test/internal/`.

## Risks / Trade-offs

- [Callers importing moved names break with no deprecation period] → The library is pre-1.0 and its examples are the known callers. The migration table below goes into the change's summary. No aliases are kept, because an alias would leave the names this change makes private reachable through `Messages`.
- [Doc links from public comments into the internal module (`{@link fromHistory}`, `{@link answers}`) point at nothing a user can open] → Public comments describe the rule in words, or name the public entry point (`layerClient`, `layerServer`, `History.restore`). Internal comments may keep linking each other.
- [The re-exported errors' JSDoc lives in an internal file] → Editors show the original declaration's comment through a re-export, so users still see it. Comments say what the error means to a caller, not which internal function raises it.
- [`History.restore` makes a route that unit-tested `restore` on literal entries need a `Thread` layer] → `Thread.layerMemory` plus a `commit` covers that. Only the tanstack example and this repo's tests call `restore`.
- [`internal/conversions.ts` is large (~700 lines)] → It's the same code as before in a smaller public surface. Splitting it is a non-goal, and the one-file decision can be revisited later without touching the public API.

## Migration Plan

| Before                                      | After                                                   |
| ------------------------------------------- | ------------------------------------------------------- |
| `Messages.HistoryMismatch` (and the other three errors) | `History.HistoryMismatch` (same tag and `RUN_ERROR` code) |
| `Effect.map(thread.load(id), Messages.restore)` | `History.restore(id)` (requires `Thread`)            |
| `Messages.Restored`, `Messages.ShownMessage` | `History.Restored`, `History.ShownMessage`             |
| `Messages.IngestOptions["clientSystem"]`    | `"allow" \| "drop" \| undefined`                        |
| `delta`, `ingest`, `resume`, `answers`, `malformedAnswers`, `fromHistory` and their types | no public replacement; use the histories |

There is no data migration, and stored threads are read the same way. To roll back, revert the change.
