import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import type { AgUiSchema } from "effect/ai";
import * as Events from "../src/internal/events.ts";
import * as RunLog from "../src/RunLog.ts";

const input = { threadId: "t1", runId: "r1" };

const append = (...events: ReadonlyArray<AgUiSchema.Event>) =>
  Effect.flatMap(RunLog.RunLog, (log) => Effect.forEach(events, (event) => log.append("t1", "r1", event)));

const subscribe = (after?: string) =>
  Effect.flatMap(RunLog.RunLog, (log) => Stream.runCollect(Stream.unwrap(log.subscribe("t1", "r1", after))));

describe("RunLog.layerMemory", () => {
  it.effect("assigns increasing cursors and reads in append order", () =>
    Effect.gen(function* () {
      const log = yield* RunLog.RunLog;
      const events = [Events.runStarted(input), Events.textMessageStart("m1"), Events.textMessageEnd("m1")];
      yield* append(...events);
      const stored = yield* log.read("t1", "r1");
      expect(stored.map((s) => s.event)).toEqual(events);
      const cursors = stored.map((s) => Number(s.cursor));
      expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
      expect(new Set(cursors).size).toBe(3);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("reads only the events after a cursor, and nothing for an unknown run", () =>
    Effect.gen(function* () {
      const log = yield* RunLog.RunLog;
      const [, second, third] = yield* append(
        Events.runStarted(input),
        Events.textMessageStart("m1"),
        Events.textMessageEnd("m1"),
      );
      expect(yield* log.read("t1", "r1", second!.cursor)).toEqual([third]);
      expect(yield* log.read("t1", "unknown")).toEqual([]);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("keeps runs with the same run id on different threads apart", () =>
    Effect.gen(function* () {
      const log = yield* RunLog.RunLog;
      yield* append(Events.runStarted(input), Events.runFinished(input));
      expect(yield* log.read("t2", "r1")).toEqual([]);
      yield* log.append("t2", "r1", Events.runStarted({ threadId: "t2", runId: "r1" }));
      expect((yield* log.read("t2", "r1")).map((s) => s.cursor)).toEqual(["0"]);
      expect(yield* log.read("t1", "r1")).toHaveLength(2);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("delivers history then each live event once when reconnecting mid-run", () =>
    Effect.gen(function* () {
      const [, c2] = yield* append(
        Events.runStarted(input),
        Events.textMessageStart("m1"),
        Events.textMessageContent("m1", "a"),
      );
      const fiber = yield* subscribe(c2!.cursor).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* append(Events.textMessageEnd("m1"), Events.runFinished(input));
      const received = yield* Fiber.join(fiber);
      expect(received.map((s) => s.event.type)).toEqual(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
      expect(received.map((s) => s.cursor)).toEqual(["2", "3", "4"]);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("completes when subscribing to a completed run", () =>
    Effect.gen(function* () {
      yield* append(Events.runStarted(input), Events.runError("boom"));
      const received = yield* subscribe();
      expect(received.map((s) => s.event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("completes at once when reconnecting after the terminal event", () =>
    Effect.gen(function* () {
      const [, finished] = yield* append(Events.runStarted(input), Events.runFinished(input));
      expect(yield* subscribe(finished!.cursor)).toEqual([]);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("rejects a cursor the run's log never issued, before streaming anything", () =>
    Effect.gen(function* () {
      const log = yield* RunLog.RunLog;
      yield* append(Events.runStarted(input), Events.textMessageStart("m1"));
      for (const cursor of ["abc", "", "-1", "01", "1.0", "2"]) {
        expect(yield* Effect.flip(log.subscribe("t1", "r1", cursor))).toEqual(new RunLog.InvalidCursor({ cursor }));
        expect(yield* Effect.flip(log.read("t1", "r1", cursor))).toEqual(new RunLog.InvalidCursor({ cursor }));
      }
      expect(yield* Effect.flip(log.subscribe("t1", "unknown", "0"))).toEqual(
        new RunLog.InvalidCursor({ cursor: "0" }),
      );
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("waits for events when subscribing before the run starts", () =>
    Effect.gen(function* () {
      const log = yield* RunLog.RunLog;
      const first = yield* Deferred.make<void>();
      const fiber = yield* Stream.unwrap(log.subscribe("t1", "r1")).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* append(Events.runStarted(input));
      yield* Deferred.await(first);
      yield* append(Events.runFinished(input));
      const received = yield* Fiber.join(fiber);
      expect(received.map((s) => s.event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );

  it.effect("gives two subscribers the same sequence", () =>
    Effect.gen(function* () {
      const a = yield* subscribe().pipe(Effect.forkChild);
      const b = yield* subscribe().pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* append(Events.runStarted(input), Events.textMessageStart("m1"), Events.textMessageEnd("m1"));
      yield* append(Events.runFinished(input));
      const [first, second] = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(first).toHaveLength(4);
      expect(second).toEqual(first);
    }).pipe(Effect.provide(RunLog.layerMemory)),
  );
});
