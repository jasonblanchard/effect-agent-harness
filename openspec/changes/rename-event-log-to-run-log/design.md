## Context

See proposal.md, "Why". This is a mechanical rename, but it touches the public API, two examples, every doc and steering file, and another active change. The design records the naming choices so that whoever implements it doesn't have to make them again.

## Goals / Non-Goals

**Goals:**

- No identifier, file name, service key or error tag in the library, its tests or its examples still says `EventLog`.
- The docs describe the module as `RunLog`, while still saying "event log" in prose about what it stores.

**Non-Goals:**

- Any behaviour change to `append`, `read`, `subscribe` or `layerMemory`.
- Renaming the `run-event-log` spec capability.
- Editing archived changes under `openspec/changes/archive/`. They are a historical record.
- A compatibility alias.

## Decisions

- **`RunLog` over the alternatives.** It is scoped to a run like `Runner`, has no clash in Effect's source, and says what the thing is: an append-only, ordered log with cursors. Rejected names:
  - `RunEvents`: a plural service name, and `RunEvents.RunEvents` reads awkwardly.
  - `EventStream`: names the transport, and is easy to confuse with `Stream` and SSE.
  - `RunJournal` / `EventJournal`: `EventJournal` is a type in `effect/eventlog`, so this would only move the clash.
  - `ReplayLog` / `EventBuffer`: they don't say the log belongs to a run, and "buffer" suggests it is bounded.
- **The error becomes `RunLogError`, tag string included.** Keeping the old `"EventLogError"` tag under a new class name would leave the old name in every `catchTag`, which defeats the rename.
- **`InvalidCursor` and `Stored` keep their names.** They don't carry the colliding name, and `RunLog.InvalidCursor` / `RunLog.Stored` read well.
- **The private per-run record in `layerMemory` becomes `RunState`.** Its current name, `interface RunLog`, would shadow the new service name inside the module. `RunState` describes what it holds: the run's stored events and its `PubSub`. The module also has local variables named `log` and `runLog(...)`. `log` can stay. Rename `runLog` to `runState` to match.
- **Prose stays "event log".** "The run's event log" is still an accurate description, and changing every sentence would add churn without making anything clearer. A sentence changes only where it refers to the module or service by name, for example "the `EventLog`". `InvalidCursor`'s message ("The run's event log never issued …") stays.
- **The core Effect audit keeps its comparison.** Its `EventLog` vs `effect/eventlog` section becomes a `RunLog` section. It still names `effect/eventlog` as the nearest counterpart, and notes that the module was renamed to avoid the clash. The audit's date is updated.

## Risks / Trade-offs

- [Downstream code breaks at compile time] → Intended, because there is no alias. The proposal lists every renamed identifier, so migrating is a find-and-replace. Changing the error tag is the one break `tsc` may not catch, because `catchTag` string literals are only checked against the error union. The examples and tests are the guard: after the rename, `grep -r EventLog` over `packages/` must come back empty.
- [The active `interrupt-metadata` change drifts] → This change updates its artifacts too, so whichever of the two lands second doesn't reintroduce the old name.
