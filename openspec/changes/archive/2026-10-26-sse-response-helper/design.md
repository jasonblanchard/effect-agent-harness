## Context

See proposal.md for why. The current state:

- **`Sse.ts` only does encoding.** It imports `effect` and `effect/encoding/Sse`. It has no HTTP types and no dependency on a transport.
- **The same helper is written four times.** The ag-ui example, the TanStack example, the README quick start and `Sse.test.ts` each define:
  ```ts
  const sse = <R>(frames: Stream.Stream<string, unknown, R>) =>
    Effect.map(Effect.context<R>(), (context) =>
      HttpServerResponse.stream(frames.pipe(Stream.provideContext(context), Stream.encodeText), {
        contentType: Sse.contentType,
        headers: { "cache-control": "no-cache" },
      }),
    );
  ```
- **The response type requires nothing.** `HttpServerResponse.stream` takes a stream with no requirements, because the server reads the body after the handler has returned. Its options (`HttpServerResponse.Options`) are `status`, `statusText`, `headers` (`Headers.Input`) and `contentType`.
- **Requirements end up on the app layer.** The handler's own requirements become per-request requirements of its route (`router.add`). The web handler satisfies them from the app layer's outputs (typed-run-context, design 9).

## Goals / Non-Goals

**Goals:**

- One call turns a stream of frames into an `effect/http` SSE response, whatever the frames still need.

**Non-Goals:**

- Helpers for transports other than `effect/http`.
- Encoding inside the helper (decision 2).
- Making a forgotten per-request service fail to compile at the route (decision 4).
- Changing `Runner.run` or any other runner.

## Decisions

### 1. `Sse.response(frames, options?)` in the `Sse` module

```ts
export const response = <R>(
  frames: Stream.Stream<string, unknown, R>,
  options?: Omit<HttpServerResponse.Options, "contentType">,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>
```

The body is the helper above. It reads `Effect.context<R>()`, provides that context to the frames and pipes them through `Stream.encodeText`. Then it calls `HttpServerResponse.stream` with `contentType: contentType` and the caller's `status` and `statusText`. Headers are merged with `cache-control: no-cache` first and the caller's headers second, so the caller can override it.

This lives in `Sse`, next to `contentType` and the encoders, because it's the last step of the same pipeline. Callers on another transport keep using `encode`, `encodeStored` and `contentType`. `Sse.ts` now imports `effect/http`. That's a module inside the `effect` package the library already depends on, so nothing is added to `package.json`.

`contentType` is left out of the options. A response with any other content type isn't SSE, and a caller who wants one can use `HttpServerResponse.stream` directly.

Alternatives:
- **A new `Http` module.** That would be one export in a module of its own, away from the SSE pieces it completes.
- **Leaving it to the caller.** This was typed-run-context's decision 9. It's reversed here because every `effect/http` caller writes the same code, and the reason for it is subtle (proposal.md).

### 2. Takes frames, not events

The helper takes `Stream<string>`: the output of `Sse.encode` or `Sse.encodeStored`. A route then reads `Sse.response(Sse.encode(runAgent(input)))` or `Sse.response(Sse.encodeStored(events))`, and the choice of id-carrying frames stays visible at the call site.

Alternative: take events and encode them inside the helper. That would need a second function, or a flag, for stored events.

### 3. The whole context is captured at runtime

`Effect.context<R>()` is typed as `R`, but at runtime it returns the handler's whole context, which includes the request's `Scope` and `HttpServerRequest`. That's harmless, for the reasons typed-run-context's design 9 gives: the run reads only what it requires, and the per-run layer's scope is the attempt stream's own. The doc comment says only that the body carries the services of the context the response was built in.

### 4. Where a forgotten service is reported

Say a route forgets `Stream.provideService(AuthContext, principal)`. `Sse.response` accepts the stream anyway, the handler requires `AuthContext`, and the compiler reports it where the web handler is built or called, not at the route. With `HttpRouter.toWebHandler` the error was `Expected 2 arguments, but got 1` at `handler(request)`. The same happens when the app layer uses `Layer.provide` instead of `Layer.provideMerge`.

The doc comment states this, and so does the README paragraph on the helper.

Alternative: a variant that takes the per-request services explicitly and requires the frames to need nothing else, so a missing service fails to compile at the route. It's left out because the signature is clumsier and the services the route already holds would have to be listed again. It can be added later without changing `response`.

## Risks / Trade-offs

- **[`Sse` is no longer transport-free.]** Only `response` touches `effect/http`, and the encoders still work without it. The library already runs on `effect/http` in its tests, and `effect/http` ships inside `effect`.
- **[A caller overrides `cache-control`.]** This is allowed on purpose (decision 1). The doc comment says why the default is `no-cache`.
