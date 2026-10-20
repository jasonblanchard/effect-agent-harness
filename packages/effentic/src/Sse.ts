import { Stream } from "effect";
import * as EffectSse from "effect/encoding/Sse";
import type * as AgUi from "./AgUi.ts";

/** Content type for an AG-UI event stream encoded as Server-Sent Events. */
export const contentType = "text/event-stream";

/** Encodes one AG-UI event as an SSE `data:` frame containing its JSON. */
export const encodeEvent = (event: AgUi.Event): string =>
  EffectSse.encoder.write({ _tag: "Event", event: "message", id: undefined, data: JSON.stringify(event) });

/**
 * Encodes a stream of AG-UI events as SSE frames, one frame per event, in
 * order and as each event is produced. This is the wire format `@ag-ui/client`'s
 * `HttpAgent` expects; pipe through `Stream.encodeText` for a byte stream.
 */
export const encode = <E, R>(events: Stream.Stream<AgUi.Event, E, R>): Stream.Stream<string, E, R> =>
  Stream.map(events, encodeEvent);
