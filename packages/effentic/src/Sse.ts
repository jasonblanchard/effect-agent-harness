import { Stream } from "effect";
import * as EffectSse from "effect/encoding/Sse";
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
