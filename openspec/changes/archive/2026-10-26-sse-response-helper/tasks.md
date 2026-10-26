# Tasks

Conventions: run from the repo root. Before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings. Numbers in parentheses point at design.md decisions.

## 1. Library

- [x] 1.1 In `packages/effentic/src/Sse.ts`, add `response(frames, options?)` as design 1 gives it:
  - capture `Effect.context<R>()` and provide it to the frames, then `Stream.encodeText`;
  - `HttpServerResponse.stream` with `contentType`, the caller's `status` and `statusText`, and headers merged as `cache-control: no-cache` then the caller's.
- [x] 1.2 Write its doc comment:
  - the body is read after the handler has returned, so it carries the services of the context the response was built in;
  - with `effect/http`, keep those services in the app layer's output (`Layer.provideMerge`);
  - a per-request service the route forgets is reported where the web handler is built or called, not at the route (4);
  - why the default is `no-cache`.

## 2. Tests

- [x] 2.1 In `packages/effentic/test/Sse.test.ts`, replace the local `sse` helper with `Sse.response`, and keep the existing route and `HttpAgent` tests passing ("HttpAgent consumes the encoding", "Body carries the handler's services").
- [x] 2.2 Add a test that a response built with no options has status 200, content type `text/event-stream` and `cache-control: no-cache` ("Response headers").
- [x] 2.3 Add a test that `headers: { "x-run": "r1" }` keeps both defaults, and that `status` and an overriding `cache-control` are honoured ("Caller's status and headers").
- [x] 2.4 Add a type test: the effect `Sse.response` returns requires exactly the services the frames still need, and a frames stream that needs nothing gives a response that needs nothing ("Missing service fails to typecheck").

## 3. Examples

- [x] 3.1 In `packages/examples/ag-ui/src/server.ts`, remove the local `sse`. `POST /agent` returns `yield* Sse.response(Sse.encode(...))`, and the events route returns `yield* Sse.response(Sse.encodeStored(events))`. Update the route notes in the example's `AGENTS.md`.
- [x] 3.2 Do the same in `packages/examples/tanstack/src/server/chat.server.ts` and its `AGENTS.md`.

## 4. Docs

- [x] 4.1 README:
  - The quick start uses `Sse.response` and drops its `sse` helper.
  - The "Running over AG-UI" paragraph names `Sse.response` as how a route closes over the handler's context, keeps the `Layer.provideMerge` note, and adds where a forgotten per-request service is reported.
  - Update the auth snippet's comment and the event-log snippet.
  - The module reference row for `Sse` lists `response`.
- [x] 4.2 In `packages/effentic/AGENTS.md`, the `Sse.ts` note mentions `response`, its context capture and its headers.

## 5. Wrap-up

- [x] 5.1 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and `openspec validate sse-response-helper --strict`, and fix every finding.
