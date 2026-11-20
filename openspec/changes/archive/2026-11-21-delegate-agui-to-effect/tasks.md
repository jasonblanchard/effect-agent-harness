## 1. Preconditions and baseline

- [x] 1.1 Confirm `run-cancellation` is archived (`openspec list` doesn't show it). Otherwise stop: both changes touch `AgUi.ts`, `Runner.ts` and the tests.
- [x] 1.2 Record a baseline. Using a script in the scratchpad (outside the repo, so jj doesn't track it), run the scripted-model fixtures through `Runner.makeAttached` and save each run's AG-UI events as JSON lines. Cover a text + reasoning run, a server tool call, a frontend call (`pendingToolCallIds`), an approval interrupt and its resume, a subagent run, a cancelled run, a failed run (`RUN_ERROR`), and a server-history run followed by `History.restore`.

## 2. Upgrade Effect to 4.1

- [x] 2.1 Set the `effect` catalog entry to the latest exact 4.1.x. Move `@effect/ai-anthropic`, and any other `@effect/*` package pinned to the same release, to the matching version. Set the library's peer range to `^4.1.0`. Run `pnpm install`, and check that the lockfile resolves a single `effect`.
- [x] 2.2 Change `src/Sse.ts` to import `Sse` from `effect/encoding` (it's deleted in group 5, but the suite must be green first).
- [x] 2.3 Fix any other 4.0 → 4.1 compile or lint breakage in the library and both examples. If a fix would change emitted events, prompts, checkpoints or stored entries, stop and report.
- [x] 2.4 `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` is green.

## 3. Protocol schema from Effect

- [x] 3.1 In `src/AgUi.ts`, take every event type, `Interrupt` and `RunFinishedOutcome` from `effect/ai`'s `AgUiSchema`, and use `protocolVersion` in `runStarted`. Keep `AgUi.Event` as the same 20-member union.
- [x] 3.2 Make `runInterrupted` take a non-empty array of interrupts. Fix any `exactOptionalPropertyTypes` errors from Effect's `optionalKey` fields by leaving the key out instead of setting it to `undefined`.
- [x] 3.3 In `test/fixtures.ts`, decode events with `effect/ai`'s `AgUiSchema.Event` in `verify`, still rejecting undeclared fields.
- [x] 3.4 Delete `src/AgUiSchema.ts`, `scripts/generate-schema.ts` and `schema/ag-ui-1.0.json`. Remove the `generate:schema` script, any dev dependencies only the generator used, and the `AgUiSchema` export from `src/index.ts`.
- [x] 3.5 `pnpm tsc && pnpm lint && pnpm test` is green.

## 4. Run input from Effect

- [x] 4.1 Delete `ToolCall`, `Message`, `ResumeEntry`, `FrontendTool`, `RunAgentInput` and `decodeRunAgentInput` from `src/AgUi.ts`. Keep `ApprovalResponse` and `approvalInterrupt`.
- [x] 4.2 Retype `src/internal/conversions.ts` (`delta`, `ingest`, `fromHistory`, `answers`, `resume`, `malformedAnswers`, `textOf` and their helpers) on `AgUiSchema.Message` / `AgUiSchema.ResumeEntry`, switching on the discriminated `role`. Delete the branch for roles no spec defines. Keep the dropped `activity` / `reasoning` behavior unchanged.
- [x] 4.3 Retype `src/internal/history.ts` and every `Runner.ts` signature on `AgUiSchema.RunAgentInput`, including the workflow payload schemas (`run` and `ids`) and `WorkflowPayloadFields`.
- [x] 4.4 Fingerprint the input with `Schema.toCodecJson(AgUiSchema.RunAgentInput)` in the `input` checkpoint.
- [x] 4.5 Map `input.tools` to `Agent.FrontendTool`s in the runner, giving a tool with no `parameters` the empty object schema `{ type: "object", properties: {} }`.
- [x] 4.6 Update every hand-written input in the tests to match Effect's input type: `tools` / `context` where needed, `type: "function"` on tool calls, and content of the right shape.
- [x] 4.7 Replace the old decoder tests with the scenarios of "Run input is the AG-UI input as Effect decodes it": extra fields, missing runId, tool without a description, resume entries, forwarded properties of any shape, no tools, and an unknown message role.
- [x] 4.8 Add the "A field the run ignores differs" scenario (`RunInputMismatch` on a different `state`) to the runner tests.
- [x] 4.9 `pnpm tsc && pnpm lint && pnpm test` is green. Re-run the 1.2 script: every run's events are identical to the baseline.

## 5. HTTP edge through Effect

- [x] 5.1 Spike in the ag-ui example: one `HttpApi` with `AgUiServer.endpoint("run", "/agent")` served by `AgUiServer.handler`, and authentication as `HttpApi` middleware providing `AuthContext` (401 on failure). Confirm that the principal reaches tool handlers, and that a disconnect cancels the run. If either fails, stop and report.
- [x] 5.2 Rewrite `test/Sse.test.ts` as an `HttpApi` test (for example `test/Http.test.ts`), covering the scenarios of "Serving runs through Effect's AG-UI binding": `HttpAgent` multi-turn with tools, `HttpAgent` tool approval, one run lifecycle on the wire, disconnect cancels the run (with the claim released under the server history), invalid input rejected before the stream, and replay carrying cursors as ids. Keep the `Runner.makeAttached` tests that don't depend on HTTP (consumer stops → run stops) in the runner tests.
- [x] 5.3 Finish the ag-ui example: the detached start (202), cancel (202) and event replay endpoints. Replay uses `StreamSse({ events })` with the cursor as `id`, the `Last-Event-ID` header, `cache-control: no-cache`, and a 400 for `InvalidCursor`. Serve the whole `HttpApi` through the example's existing web handler.
- [ ] 5.4 Move the TanStack example's chat routes to `HttpApi` endpoints of its own (not `AgUiServer.endpoint`, see design.md): `POST /api/chat` and the `GET /api/chat` join stream with cursors as SSE ids, `GET /api/chat` also answering the hydrate JSON, and cancel answering 204. Keep the idle timeout on the event stream. Run a chat end to end in the browser, with a frontend tool and a server tool call. If TanStack's requests fail Effect's input validation, stop and report before working around it.
- [x] 5.5 Delete `src/Sse.ts` and its export. Confirm that `grep -r "effect/http" packages/effect-agent-harness/src` finds nothing.

## 6. Docs and verification

- [x] 6.1 Update the library's `AGENTS.md`: remove the `AgUiSchema.ts` and `Sse.ts` bullets and those namespaces, describe the input as `effect/ai`'s `AgUiSchema.RunAgentInput`, replace the `makeAttached` route advice with the `AgUiServer.handler` pattern, and update the test notes (`verify`, the HTTP tests). Update the root `AGENTS.md` module list. Update both examples' `AGENTS.md` for the `HttpApi` routes.
- [x] 6.2 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and confirm it passes.
- [ ] 6.3 Write the breaking changes into the commit message: no `AgUiSchema` or `Sse` exports, no `AgUi` input schemas, input validated against the AG-UI spec, and the memoised input covering every field.
- [x] 6.4 After archiving, edit the `agui-transport-edge` spec's Purpose: the package no longer supplies an input decoder or an SSE encoding.
