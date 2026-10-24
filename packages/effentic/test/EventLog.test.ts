import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import * as AgUi from "../src/AgUi.ts";
import * as EventLog from "../src/EventLog.ts";

const input = { threadId: "t1", runId: "r1" };

const append = (...events: ReadonlyArray<AgUi.Event>) =>
  Effect.flatMap(EventLog.EventLog, (log) => Effect.forEach(events, (event) => log.append("t1", "r1", event)));

const subscribe = (after?: string) =>
  Effect.flatMap(EventLog.EventLog, (log) => Stream.runCollect(log.subscribe("t1", "r1", after)));

describe("EventLog.layerMemory", () => {
  it.effect("assigns increasing cursors and reads in append order", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const events = [AgUi.runStarted(input), AgUi.textMessageStart("m1"), AgUi.textMessageEnd("m1")];
      yield* append(...events);
      const stored = yield* log.read("t1", "r1");
      expect(stored.map((s) => s.event)).toEqual(events);
      const cursors = stored.map((s) => Number(s.cursor));
      expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
      expect(new Set(cursors).size).toBe(3);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("reads only the events after a cursor, and nothing for an unknown run", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const [, second, third] = yield* append(
        AgUi.runStarted(input),
        AgUi.textMessageStart("m1"),
        AgUi.textMessageEnd("m1"),
      );
      expect(yield* log.read("t1", "r1", second!.cursor)).toEqual([third]);
      expect(yield* log.read("t1", "unknown")).toEqual([]);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("keeps runs with the same run id on different threads apart", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      yield* append(AgUi.runStarted(input), AgUi.runFinished(input));
      expect(yield* log.read("t2", "r1")).toEqual([]);
      yield* log.append("t2", "r1", AgUi.runStarted({ threadId: "t2", runId: "r1" }));
      expect((yield* log.read("t2", "r1")).map((s) => s.cursor)).toEqual(["0"]);
      expect(yield* log.read("t1", "r1")).toHaveLength(2);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("delivers history then each live event once when reconnecting mid-run", () =>
    Effect.gen(function* () {
      const [, c2] = yield* append(
        AgUi.runStarted(input),
        AgUi.textMessageStart("m1"),
        AgUi.textMessageContent("m1", "a"),
      );
      const fiber = yield* subscribe(c2!.cursor).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* append(AgUi.textMessageEnd("m1"), AgUi.runFinished(input));
      const received = yield* Fiber.join(fiber);
      expect(received.map((s) => s.event.type)).toEqual(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
      expect(received.map((s) => s.cursor)).toEqual(["2", "3", "4"]);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("completes when subscribing to a completed run", () =>
    Effect.gen(function* () {
      yield* append(AgUi.runStarted(input), AgUi.runError("boom"));
      const received = yield* subscribe();
      expect(received.map((s) => s.event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("waits for events when subscribing before the run starts", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const first = yield* Deferred.make<void>();
      const fiber = yield* log.subscribe("t1", "r1").pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* append(AgUi.runStarted(input));
      yield* Deferred.await(first);
      yield* append(AgUi.runFinished(input));
      const received = yield* Fiber.join(fiber);
      expect(received.map((s) => s.event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );

  it.effect("gives two subscribers the same sequence", () =>
    Effect.gen(function* () {
      const a = yield* subscribe().pipe(Effect.forkChild);
      const b = yield* subscribe().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* append(AgUi.runStarted(input), AgUi.textMessageStart("m1"), AgUi.textMessageEnd("m1"));
      yield* append(AgUi.runFinished(input));
      const [first, second] = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(first).toHaveLength(4);
      expect(second).toEqual(first);
    }).pipe(Effect.provide(EventLog.layerMemory)),
  );
});
