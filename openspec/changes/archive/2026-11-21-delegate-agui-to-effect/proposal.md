## Why

Effect 4.1 ships AG-UI support in `effect/ai`: the protocol schemas (`AgUiSchema`), conversions (`AgUi`), and an HTTP binding with SSE encoding (`AgUiServer`, on `HttpApi`). This library currently owns its own copy of each of those pieces: a generated 3,131-line protocol schema with its own generator, a lenient input schema, and an SSE module. None of them is what the library is for. The library's job is the durable agent run: the agent loop, checkpoints, histories, the projection onto AG-UI events, and the runners. This change keeps only that and hands the rest to Effect. Nothing depends on the library yet, so stricter input validation and wire-level differences are acceptable.

## What Changes

- Upgrade `effect` (and the `@effect/*` packages pinned to its release) from 4.0.5 to 4.1.x. Raise the peer range to `^4.1.0`.
- **BREAKING:** Delete the generated protocol schema and its generator. The package no longer exports `AgUiSchema`. The library, its tests and consumers use `effect/ai`'s `AgUiSchema` instead (`PROTOCOL_VERSION` becomes `protocolVersion`, and the exports only the generated module had are gone).
- **BREAKING:** Delete our run input schemas (`AgUi.RunAgentInput`, `Message`, `ToolCall`, `ResumeEntry`, `FrontendTool`, `decodeRunAgentInput`). Runners take `effect/ai`'s `AgUiSchema.RunAgentInput`. Input is validated against the AG-UI spec: for example, a tool needs a `description` and a tool call needs `type: "function"`. Fields the run ignores (`context`, `state`, message `metadata`, …) are kept, not stripped. The memoised input, and therefore the `RunInputMismatch` check, covers them.
- **BREAKING:** Delete the `Sse` module. The package contains no HTTP code. Applications serve the request-scoped runner through `AgUiServer.endpoint` and `AgUiServer.handler`, and the event-log replay route through `HttpApiSchema.StreamSse` with each event's cursor as its SSE `id`.
- Rewrite both examples' routes on `HttpApi`: the AG-UI endpoint for the ag-ui example's `POST /agent`, and endpoints of their own for detached start, cancel and replay, including the TanStack chat routes, which follow detached runs, and authentication as `HttpApi` middleware.
- Unchanged: `AgUi.fold` / `closeOpen` and the event builders, the history conversions, `Agent`, `Checkpoint`, `Thread`, `History`, `EventLog`, `Runner`, `Telemetry`. Effect's `fromStreamParts`, `withRunLifecycle`, `toPrompt` and `AgUiServer.agent` don't provide stable ids across replay, resuming a detached run, approvals or subagents, so they don't replace any of these.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agui-transport-edge`: the package no longer provides an input decoder or an SSE encoding. Runners take the AG-UI input as Effect's schema decodes it, and their streams can be served through Effect's AG-UI endpoint and SSE streaming.
- `agui-agent-loop`: the memoised run input is the complete decoded AG-UI input, including fields the run ignores.

## Impact

- **Dependencies:** `effect` and `@effect/ai-anthropic` move to 4.1.x. The library still needs only `effect`. `@effect/tsgo`, TypeScript and Oxlint stay pinned (the tsgo support table doesn't cover Effect's version).
- **Library code:** delete `src/AgUiSchema.ts`, `src/Sse.ts`, `scripts/generate-schema.ts` and `schema/ag-ui-1.0.json`. Change `src/AgUi.ts` (input schemas removed), `src/internal/conversions.ts` and `src/internal/history.ts` (typed messages), `src/Runner.ts` (input type, workflow payload), `src/index.ts`, and `package.json`.
- **Tests:** every hand-written input literal, the SSE tests (rewritten against `HttpApi`), and `verify` (decodes with Effect's `Event`).
- **Examples:** both routes move from `HttpRouter.add` to `HttpApi`.
- **Wire differences:** stricter 400s with `HttpApiError.BadRequest` bodies, and `: keepalive` comments every 15 seconds on the AG-UI endpoint.
- **Docs:** root and library `AGENTS.md`.
- **Sequencing:** land after `run-cancellation` is archived.
