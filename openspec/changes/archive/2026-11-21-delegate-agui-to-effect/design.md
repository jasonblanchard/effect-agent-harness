## Context

See proposal.md for motivation and scope. The specs in this change define the new transport contract.

Facts that shape the approach:

- **The generated schema matters at runtime in one place only.** `AgUi.ts` reads `PROTOCOL_VERSION`. Everything else the library imports from it is type-only. Only `test/fixtures.ts`'s `verify` decodes with it. Every type name we use exists under the same name in `effect/ai`'s `AgUiSchema`.
- **Our input schema is stored.** `Runner.ts` memoises the JSON of the encoded input as the `input` checkpoint (the `RunInputMismatch` check). `makeWorkflow` uses the input schema in its payload. The workflow idempotency key is only `(threadId, runId)`, so execution ids don't depend on the schema.
- **`Sse.ts` is the library's only `effect/http` import.** Both examples route with `HttpRouter.add`. The attached route closes over the handler's context, because the body is read after the handler returns.
- **Effect's `AgUiServer.handler(run)`** captures the handler's context and provides it to the stream. It wraps the stream in `withRunLifecycle`, round-trips each event through JSON, and responds with `StreamSse({ data: Event, keepAlive: "15 seconds" })` plus `cache-control: no-cache`. Its endpoint declares only `BadRequest`.
- **`HttpApiSchema.StreamSse({ events })`** takes an events schema whose values carry `id`, `event` and `data`. So the replay route can send cursors as SSE ids.

## Goals / Non-Goals

**Goals:**

- The library holds only the durable-run machinery. The protocol schemas, input decoding and HTTP/SSE encoding come from Effect.
- Every AG-UI sequence the library emits is unchanged event for event. Only the transport around it changes.
- Both examples work end to end on `HttpApi`: `HttpAgent`, TanStack chat, detached start, cancel and replay.

**Non-Goals:**

- Replacing `fold`, `closeOpen`, the history conversions, `Agent.run` or the runners with Effect's `fromStreamParts`, `withRunLifecycle`, `toPrompt` or `AgUiServer.agent`.
- Supporting user media parts in the history.
- Keeping compatibility aliases for anything removed. There are no consumers.

## Decisions

### 1. No `AgUiSchema` export

`src/AgUiSchema.ts`, the generator and the pinned spec are deleted, and `index.ts` stops exporting `AgUiSchema`. Library code, tests and consumers import it from `effect/ai`. Library types such as `AgUi.Event` are built from Effect's types.

- *Alternative: re-export Effect's module.* Rejected. It would give the same module two import paths, and it would make us answer for an experimental module we don't own.

### 2. `AgUi.Event` stays the narrow union `fold` emits

It keeps its 20 members, now typed from Effect's event types, so the type still documents exactly what the library emits. The builders keep their current output. Where Effect's types are tighter, only the types change: `runInterrupted` takes a non-empty array of interrupts, and optional fields are left out instead of being set to `undefined`.

### 3. Effect's `RunAgentInput` everywhere, with typed conversions

`AgUi.RunAgentInput`, `Message`, `ToolCall`, `ResumeEntry`, `FrontendTool` and `decodeRunAgentInput` are deleted. Runner signatures, `internal/history.ts` and `internal/conversions.ts` take `AgUiSchema.RunAgentInput`, `AgUiSchema.Message` and `AgUiSchema.ResumeEntry`. The conversions switch on Effect's discriminated `role`:

- Each role's content is typed: string for assistant, system, developer and reasoning; string or content parts for user and tool. So `textOf` takes `string | ReadonlyArray<ContentPart>`, not `unknown`.
- `activity` and `reasoning` messages fall into the existing "dropped" branches. The branch for roles no spec defines is deleted, because the schema now drops those while decoding.
- The visible results don't change: the same entries, ids, drops and results. The `run-history` and `thread-history-read` scenarios hold as they are.

`AgUi.ApprovalResponse` and `approvalInterrupt` stay. They are our contract for the approval interrupt's payload, not part of the protocol.

### 4. Frontend tools keep `Agent.FrontendTool`

`Agent` stays independent of AG-UI. The runner maps each `AgUiSchema.Tool` to an `Agent.FrontendTool`. A tool without `parameters` gets `{ type: "object", properties: {} }`, as Effect's `AgUiServer.agent` gives it, because `Agent.run` passes the schema to `Tool.dynamic` as given.

### 5. Fingerprint the whole encoded input

The `input` checkpoint stores `JSON.stringify` of the input encoded with `Schema.toCodecJson(AgUiSchema.RunAgentInput)`, the same mechanism as today with a different schema. It covers fields the run ignores, as the modified `agui-agent-loop` requirement states. Encoding is deterministic: `tools` and `context` encode as the arrays they decoded to, and filtering unknown members only happens on decode.

- *Alternative: fingerprint only the fields the run reads.* Rejected. That would rebuild a projection schema of our own, which this change exists to remove. A retry that changes `state` under the same run id is a different input.

### 6. No HTTP code in the library

`Sse.ts` is deleted, and the library imports nothing from `effect/http` or `effect/http-api`. The routes belong to the applications, built from Effect's pieces:

```
HttpApi "agent"
├── AgUiServer.endpoint("run", "/agent")          → AgUiServer.handler(runAttached)
├── POST /runs              (payload RunAgentInput, 202)    → detached.start
├── POST /threads/:t/runs/:r/cancel  (202)                   → detached.cancel
└── GET  /threads/:t/runs/:r/events  (StreamSse({ events }), header Last-Event-ID,
                                      error 400 InvalidCursor) → EventLog.subscribe
middleware: Authentication → provides AuthContext (401 on failure)
```

- **Attached runs.** `AgUiServer.handler` provides the handler's context to the stream, including what the authentication middleware provides. That replaces the examples' `sse` helper. It reads the run's services from the request context, so the app layer must still keep them in its output (`Layer.provideMerge`), as the old routes did: with `Layer.provide`, they become unmet per-request requirements, and the web handler demands a context argument. Its `withRunLifecycle` wrapper only swaps in an identical `RUN_STARTED`: our terminal event ends the run, and `fold` already closes everything before `RUN_ERROR`.
- **Replay route.** It declares `StreamSse({ events })`, with an events schema whose `id` is the cursor, whose `event` is `"message"` and whose `data` is the JSON AG-UI event, plus `cache-control: no-cache` through `HttpApiSchema.WithHeaders`, as `AgUiServer.endpoint` does. Its `keepAlive` is left unset. The TanStack example sets its own idle timeout on the event stream.
- **TanStack chat.** It doesn't use `AgUiServer.endpoint`. `POST /api/chat` is a detached run that the response follows through the event log, so its frames must carry cursors as SSE ids for `Last-Event-ID` reconnects, which the AG-UI endpoint doesn't send. And TanStack AI's `GET /api/chat` returns the hydrate JSON or the SSE join of a run, depending on the query. Both are `HttpApi` endpoints of the example's own. `POST /api/chat` takes `RunAgentInput` as payload and declares the replay route's `StreamSse({ events })`. `GET /api/chat` declares a JSON success and that same stream success: `HttpApi` sends a handler's `Stream` result as SSE and encodes anything else as JSON. Cancel answers 204.
- **Tests.** The library's tests that need HTTP, such as the `HttpAgent` scenarios that replace `test/Sse.test.ts`, build a test `HttpApi` and drive it through `HttpRouter.toWebHandler`. `effect` is already a dev dependency, so this adds no dependency.

- *Alternative: keep a tiny `Sse.encodeStored` helper for replay.* Rejected. The events schema is a few lines in the application, and keeping the helper would keep an `effect/http` surface in the library.

### 7. Version pinning

The `effect` catalog moves to an exact `4.1.x`: 4.1.4, the latest that pnpm's minimum-release-age policy accepts. 4.1.5, published on the day of implementation, has the same `effect/ai` AG-UI sources. `@effect/ai-anthropic` and `@effect/vitest` move to the matching version. The lockfile must resolve one `effect`. The library's peer range becomes `^4.1.0`.

## Risks / Trade-offs

- **The TanStack AI client may send input Effect's schema rejects** (no tool `description`, no `type: "function"` on tool calls) → Exercise the TanStack chat end to end early, with frontend tools and a tool-call turn. If its requests fail validation, stop and decide, for example by normalising in that example's route. Don't loosen anything in the library.
- **Disconnects might not cancel attached runs under `HttpApi`** → The "Disconnect cancels the run" scenario is tested through the endpoint over a real web handler. Under the server history it also checks that the claim is released.
- **Per-request services under `HttpApiBuilder.layer` + `toWebHandler`** behave differently from `HttpRouter.add` → Spike this in the ag-ui example first: the middleware-provided `AuthContext` must reach tool handlers in attached and detached runs.
- **Effect's AG-UI modules are `@stability experimental`** → The exact catalog pin protects the repo. Breaking changes upstream become upgrade work, which is the trade we're choosing.
- **Other 4.0 → 4.1 breaking changes** (`effect/ai`, `effect/workflow`, lint diagnostics) → Upgrade first, alone, and get the suite green before deleting anything.
- **`verify` gets slightly weaker:** Effect types `Metadata` as `Unknown`, not JSON → Our events carry no `metadata`.
- **The endpoint's `RUN_ERROR` for an event that can't be encoded is generic** → Only reachable if an event fails Effect's schema, which `verify` would already catch in tests.

## Migration Plan

1. Wait until `run-cancellation` is archived.
2. Upgrade Effect alone and get the suite green.
3. Swap the protocol schema and input types, and remove the generator.
4. Move the HTTP edge to `HttpApi`: tests first, then the ag-ui example, then the TanStack example. Delete `Sse.ts`.
5. Update the docs, and the `agui-transport-edge` spec's Purpose after archiving.

There are no consumers and no stored state to migrate. Rollback is a revert.
