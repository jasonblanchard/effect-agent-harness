import { Effect, Stream } from "effect";
import * as EffectSse from "effect/encoding/Sse";
import { Headers, HttpServerResponse } from "effect/http";
import type * as AgUi from "./AgUi.ts";
import type * as EventLog from "./EventLog.ts";

/** Content type for an AG-UI event stream encoded as Server-Sent Events. */
export const contentType = "text/event-stream";

/**
 * Encodes one AG-UI event as an SSE `data:` frame containing its JSON. With an
 * `id`, the frame carries it as the SSE `id`, which a reconnecting client sends
 * back as `Last-Event-ID`.
 */
export const encodeEvent = (event: AgUi.Event, id?: string): string =>
  EffectSse.encoder.write({ _tag: "Event", event: "message", id, data: JSON.stringify(event) });

/**
 * Encodes a stream of AG-UI events as SSE frames, one frame per event, in
 * order and as each event is produced. This is the wire format `@ag-ui/client`'s
 * `HttpAgent` expects; pipe through `Stream.encodeText` for a byte stream.
 */
export const encode = <E, R>(events: Stream.Stream<AgUi.Event, E, R>): Stream.Stream<string, E, R> =>
  Stream.map(events, (event) => encodeEvent(event));

/** Encodes events read from the {@link EventLog.EventLog}, with each event's cursor as its SSE `id`. */
export const encodeStored = <E, R>(stored: Stream.Stream<EventLog.Stored, E, R>): Stream.Stream<string, E, R> =>
  Stream.map(stored, ({ cursor, event }) => encodeEvent(event, cursor));

/**
 * An `effect/http` response streaming SSE frames (from {@link encode} or
 * {@link encodeStored}), with content type `text/event-stream` and
 * `cache-control: no-cache`, so proxies pass each frame on instead of
 * buffering the stream. `headers` are merged over these and may override
 * `cache-control`.
 *
 * The server reads the body after the handler has returned, so the response
 * carries the services of the context it is built in: build it inside the
 * handler, and whatever the frames still need becomes a requirement of the
 * handler. With `effect/http`, keep those services in the app layer's output
 * (`Layer.provideMerge`), which the web handler provides to every request.
 * A per-request service the route forgets to provide, such as the verified
 * principal, is therefore not reported at the route but where the web handler
 * is built or called (with `HttpRouter.toWebHandler`, as a context argument
 * the handler then expects).
 */
export const response = <R>(
  frames: Stream.Stream<string, unknown, R>,
  options?: Omit<HttpServerResponse.Options, "contentType">,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  Effect.map(Effect.context<R>(), (context) =>
    HttpServerResponse.stream(frames.pipe(Stream.provideContext(context), Stream.encodeText), {
      ...options,
      contentType,
      headers: Headers.merge(Headers.fromInput({ "cache-control": "no-cache" }), Headers.fromInput(options?.headers)),
    }),
  );
