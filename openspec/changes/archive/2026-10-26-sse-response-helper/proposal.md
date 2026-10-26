## Why

Since `Runner.make` was removed (typed-run-context, design decision 9), every `effect/http` route that streams a run has to build the response body the same way. It reads the handler's context with `Effect.context`, attaches it to the stream with `Stream.provideContext`, encodes the text, and sets the SSE content type and `cache-control: no-cache`.

Both examples, the README quick start and `Sse.test.ts` each carry an identical copy of that helper. Writing it correctly means understanding why the body must close over the handler's context, and a copy that drops `no-cache` streams through proxies that may buffer it. The library already owns the SSE framing and the content type, so the response belongs next to them.

## What Changes

- Add `Sse.response(frames, options?)`. It returns `Effect<HttpServerResponse, never, R>`, where `R` is whatever the frames still need.
  - It captures the caller's context, provides it to the frames, encodes them as text, and sets `contentType: text/event-stream` and `cache-control: no-cache`.
  - Optional `status` and `headers` are merged over the defaults.
- `Sse.encode`, `Sse.encodeStored`, `Sse.encodeEvent` and `Sse.contentType` stay as they are, for transports other than `effect/http`.
- `Sse.ts` imports `effect/http`. It ships inside the `effect` package the library already depends on, so no dependency is added.
- The ag-ui example (`POST /agent` and the events route) and the TanStack example (`POST /api/chat`) use `Sse.response` and drop their local `sse` helpers.
- The README quick start, the auth snippet and the event-log snippet use `Sse.response`. The "Running over AG-UI" paragraph explains what the helper captures and that the app layer must keep the services in its output (`Layer.provideMerge`).
- `Sse.response`'s doc comment explains where an error lands. A per-request service the route forgets to provide doesn't fail to compile at the route: it becomes a requirement of the handler, and the compiler reports it where the web handler is built or called.
- This reverses the sentence in typed-run-context's design decision 9 that the library ships no such helper. The rest of that decision stands: `Runner.run` captures nothing, and the route provides its per-request services.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agui-transport-edge`: the "SSE encoding" requirement adds an `effect/http` response that carries the handler's services, with the SSE content type and `no-cache`.

## Impact

- `packages/effentic/src/Sse.ts`: new `response` export.
- `packages/effentic/test/Sse.test.ts`: the local `sse` helper is replaced by `Sse.response`; tests for headers, overrides and the captured context.
- `packages/examples/ag-ui/src/server.ts`, `packages/examples/tanstack/src/server/chat.server.ts`: local helpers removed.
- `packages/effentic/README.md`, `packages/effentic/AGENTS.md`, both example `AGENTS.md` files.
- Not breaking: this only adds an export.
