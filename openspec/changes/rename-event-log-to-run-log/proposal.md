## Why

The library's `EventLog` module has the same name as Effect's `effect/eventlog` `EventLog`, which is a different thing: a replicated, typed event-sourcing journal with handlers and compaction. Ours is a per-run buffer of AG-UI events with cursors, so clients can reconnect to a run. Because the names match, the two can't both be imported by their bare names, and anyone who knows Effect, human or model, expects event-sourcing semantics that our module doesn't have. The README already lists this rename as a TODO, and the core Effect audit has to warn readers that the two are unrelated "despite the shared name".

## What Changes

- **BREAKING** Rename the `EventLog` module and namespace to `RunLog`. The new name is scoped to a run like `Runner`, and matches what the file already calls each run's record internally. The module file becomes `src/RunLog.ts` and the export becomes `export * as RunLog`.
- **BREAKING** Rename the service class `EventLog.EventLog` to `RunLog.RunLog`, with service key `"effect-agent-harness/RunLog"`.
- **BREAKING** Rename the error `EventLogError` to `RunLogError`, including its `_tag`. Callers using `catchTag("EventLogError", …)` must switch to `"RunLogError"`.
- `Stored`, `InvalidCursor`, `layerMemory` and the `append` / `read` / `subscribe` signatures and behaviour are unchanged. The only change is that they now live under `RunLog`.
- There is no deprecation alias. `EventLog` is removed outright.
- Prose keeps "event log" wherever it describes what the module stores ("the run's event log"). Only identifiers and references to the module by name change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The `run-event-log` spec describes behaviour in prose and never names the service, and none of its behaviour changes. The capability keeps its name. The change sets `skip_specs: true`.

## Impact

- **Library:** `src/EventLog.ts` becomes `src/RunLog.ts`. `src/index.ts`, `src/Runner.ts` and the doc comment in `src/History.ts` are also updated.
- **Tests:** `test/EventLog.test.ts` becomes `test/RunLog.test.ts`, plus references in the Runner, Cancellation, Subagents, Http, Baseline and Telemetry tests.
- **Examples:** `packages/examples/ag-ui/src/server.ts` and `packages/examples/tanstack/src/server/chat.server.ts`. Both depend on the `EventLog.InvalidCursor` route error and on `catchTag("EventLogError")`.
- **Docs and steering files:** `docs/robodocs.md`, `docs/architecture.md`, `docs/core-effect-comparison-audit.md`, `README.md` (including removing its rename TODO), the root `AGENTS.md`, and the library and example `AGENTS.md` files.
- **Active change `interrupt-metadata`:** its proposal, design and tasks refer to the `EventLog` and need to say `RunLog`.
- **Downstream users:** this is a source-breaking rename with no alias. Migrating is a mechanical find-and-replace.
