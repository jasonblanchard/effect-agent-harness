import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import * as AgUi from "./AgUi.ts";

/** An AG-UI event as stored in the log, with the cursor the log assigned to it. */
export interface Stored {
  /** Opaque and strictly increasing within a run. Sent to clients as the SSE `id`. */
  readonly cursor: string;
  readonly event: AgUi.Event;
}

export class EventLogError extends Schema.TaggedError<EventLogError, { readonly brand: unique symbol }>()(
  "EventLogError",
  {
    cause: Schema.Defect(),
  },
) {}

/** A cursor the run's log never issued, such as a malformed or made-up `Last-Event-ID`. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor, { readonly brand: unique symbol }>()(
  "InvalidCursor",
  { cursor: Schema.String },
) {
  override get message(): string {
    return `The run's event log never issued the cursor ${JSON.stringify(this.cursor)}`;
  }
}

/**
 * The AG-UI events of each run, so a client can observe a run that outlives
 * its request and reconnect where it left off. Runs are keyed by thread id and
 * run id, because the client picks the run id: authorising the thread
 * authorises its runs.
 */
export class EventLog extends Context.Service<
  EventLog,
  {
    /** Stores the event and assigns it a cursor greater than every earlier one of the run. */
    readonly append: (threadId: string, runId: string, event: AgUi.Event) => Effect.Effect<Stored, EventLogError>;
    /**
     * The run's events after `after` (all of them when omitted), in order;
     * empty for an unknown run. Fails with {@link InvalidCursor} if `after`
     * is not a cursor this run's log issued.
     */
    readonly read: (
      threadId: string,
      runId: string,
      after?: string,
    ) => Effect.Effect<ReadonlyArray<Stored>, InvalidCursor | EventLogError>;
    /**
     * The run's events after `after`, then every later event as it is
     * appended, each once. Completes after yielding a terminal event
     * (`RUN_FINISHED` or `RUN_ERROR`), or at once when `after` is at or past
     * the run's terminal event; waits while the run has no events.
     *
     * The cursor is checked before the stream is returned: an `after` this
     * run's log never issued fails with {@link InvalidCursor}, so a route can
     * reject it before it starts a response.
     */
    readonly subscribe: (
      threadId: string,
      runId: string,
      after?: string,
    ) => Effect.Effect<Stream.Stream<Stored, EventLogError>, InvalidCursor | EventLogError>;
  }
>()("effect-agent-harness/EventLog") {}

interface RunLog {
  readonly events: Array<Stored>;
  readonly pubsub: PubSub.PubSub<Stored>;
}

/**
 * Keeps every run's events in memory for the lifetime of the process. The
 * cursor is the event's zero-based index, written in decimal. For tests,
 * local development and examples.
 */
export const layerMemory: Layer.Layer<EventLog> = Layer.sync(EventLog, () => {
  const runs = new Map<string, RunLog>();
  // JSON, so no choice of ids can make two keys collide.
  const key = (threadId: string, runId: string) => JSON.stringify([threadId, runId]);

  const runLog = (runKey: string): Effect.Effect<RunLog> =>
    Effect.suspend(() => {
      const existing = runs.get(runKey);
      if (existing !== undefined) {
        return Effect.succeed(existing);
      }
      return Effect.map(PubSub.unbounded<Stored>(), (pubsub) => {
        // Another fiber may have created the log while the PubSub was made.
        const raced = runs.get(runKey);
        if (raced !== undefined) {
          return raced;
        }
        const created = { events: [], pubsub };
        runs.set(runKey, created);
        return created;
      });
    });

  // The index after `cursor`, or `InvalidCursor` if no event of the run has that cursor.
  const start = (events: ReadonlyArray<Stored>, cursor: string | undefined) => {
    if (cursor === undefined) {
      return Effect.succeed(0);
    }
    const index = /^(0|[1-9][0-9]*)$/.test(cursor) ? Number(cursor) : -1;
    return index >= 0 && index < events.length ? Effect.succeed(index + 1) : Effect.fail(new InvalidCursor({ cursor }));
  };

  return EventLog.of({
    append: (threadId, runId, event) =>
      Effect.flatMap(runLog(key(threadId, runId)), (log) => {
        const stored = { cursor: String(log.events.length), event };
        log.events.push(stored);
        return Effect.as(PubSub.publish(log.pubsub, stored), stored);
      }),
    read: (threadId, runId, cursor) =>
      Effect.suspend(() => {
        const events = runs.get(key(threadId, runId))?.events ?? [];
        return Effect.map(start(events, cursor), (index) => events.slice(index));
      }),
    subscribe: (threadId, runId, cursor) =>
      Effect.gen(function* () {
        const log = yield* runLog(key(threadId, runId));
        // Checked now; cursors only grow, so it stays valid.
        const from = yield* start(log.events, cursor);
        return Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before taking the snapshot, so no event falls between the two.
            const subscription = yield* PubSub.subscribe(log.pubsub);
            const ended = log.events.findIndex((stored) => AgUi.isTerminal(stored.event));
            const history = log.events.slice(from);
            if (ended !== -1) {
              // Nothing is appended after the terminal event.
              return Stream.fromIterable(history);
            }
            const last = from + history.length - 1;
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((stored) => Number(stored.cursor) > last),
            );
            return Stream.concat(Stream.fromIterable(history), live).pipe(
              Stream.takeUntil((stored) => AgUi.isTerminal(stored.event)),
            );
          }),
        );
      }),
  });
});
