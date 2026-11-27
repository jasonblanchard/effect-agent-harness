## 1. Library

- [x] 1.1 Move `packages/effect-agent-harness/src/EventLog.ts` to `src/RunLog.ts` (`jj` tracks the move). Rename the service class to `RunLog` with key `"effect-agent-harness/RunLog"`, `EventLogError` to `RunLogError` (class and tag), the private `interface RunLog` to `RunState`, and the `runLog` helper to `runState`.
- [x] 1.2 Change `src/index.ts` to `export * as RunLog from "./RunLog.ts"`
- [x] 1.3 Update `src/Runner.ts` (import, `RunLog.RunLog` requirements, `RunLog.RunLogError` in error unions, doc-comment `{@link}`s) and the `EventLog` mention in the `src/History.ts` doc comment

## 2. Tests

- [x] 2.1 Move `test/EventLog.test.ts` to `test/RunLog.test.ts` and update its references
- [x] 2.2 Update the references in `Runner`, `Cancellation`, `Subagents`, `Http`, `Baseline` and `Telemetry` tests

## 3. Examples

- [x] 3.1 Update `packages/examples/ag-ui/src/server.ts` (import, `RunLog.layerMemory`, `RunLog.InvalidCursor`, `yield* RunLog.RunLog`, `catchTag("RunLogError", …)`)
- [x] 3.2 Update `packages/examples/tanstack/src/server/chat.server.ts` the same way

## 4. Related change

- [x] 4.1 Update the `EventLog` references in `openspec/changes/interrupt-metadata/` (`proposal.md`, `design.md`, `tasks.md`) to `RunLog`

## 5. Verify

- [x] 5.1 `grep -rn EventLog packages/` returns nothing
- [x] 5.2 `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` pass

## 6. Docs and steering files

- [x] 6.1 `docs/robodocs.md`: rename the module section and every identifier reference. Keep "event log" in prose.
- [x] 6.2 `docs/architecture.md`: rename the module in the map, the run timeline, the type catalog and the workflow matrix. Keep Mermaid labels quoted.
- [x] 6.3 `docs/core-effect-comparison-audit.md`: rename the `EventLog` section and table rows to `RunLog`, keep the `effect/eventlog` comparison and note the rename, and update the date
- [x] 6.4 `README.md`: rename the `EventLog` core primitive to `RunLog` and remove its rename TODO
- [x] 6.5 `AGENTS.md` files: the root module list, `packages/effect-agent-harness/AGENTS.md` (the module list, the `EventLog.ts` entry, and the `History` and `Runner` entries), `packages/examples/ag-ui/AGENTS.md` and `packages/examples/tanstack/AGENTS.md`
