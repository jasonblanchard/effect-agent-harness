import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { Prompt } from "effect/ai";
import { Workflow, WorkflowEngine } from "effect/workflow";
import * as Checkpoint from "../src/Checkpoint.ts";

class Boom extends Schema.TaggedError<Boom, { readonly brand: unique symbol }>()("Boom", {
  detail: Schema.String,
}) {}

const counter = () => {
  let count = 0;
  return {
    next: Effect.sync(() => ++count),
    get count() {
      return count;
    },
  };
};

const memo = <A, I>(runId: string, name: string, success: Schema.Codec<A, I>, effect: Effect.Effect<A>) =>
  Effect.flatMap(Checkpoint.Checkpoint, (checkpoint) =>
    checkpoint.memo({ threadId: "t1", runId, name, success, error: Schema.Never }, effect),
  );

const ledger = Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger));

describe("Checkpoint.layerNone", () => {
  it.effect("runs the same key every time", () =>
    Effect.gen(function* () {
      const c = counter();
      const first = yield* memo("r1", "step", Schema.Finite, c.next);
      const second = yield* memo("r1", "step", Schema.Finite, c.next);
      expect(c.count).toBe(2);
      expect([first, second]).toEqual([
        { value: 1, replayed: false },
        { value: 2, replayed: false },
      ]);
    }).pipe(Effect.provide(Checkpoint.layerNone)),
  );
});

describe("Checkpoint.layerLedger", () => {
  it.effect("serves the second call from the store", () =>
    Effect.gen(function* () {
      const c = counter();
      const first = yield* memo("r1", "step", Schema.Finite, c.next);
      const second = yield* memo("r1", "step", Schema.Finite, c.next);
      expect(c.count).toBe(1);
      expect([first, second]).toEqual([
        { value: 1, replayed: false },
        { value: 1, replayed: true },
      ]);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("replays a stored typed failure without executing", () =>
    Effect.gen(function* () {
      const checkpoint = yield* Checkpoint.Checkpoint;
      const c = counter();
      const failing = Effect.flatMap(c.next, () => Effect.fail(new Boom({ detail: "x" })));
      const options = { threadId: "t1", runId: "r1", name: "step", success: Schema.Finite, error: Boom };
      const first = yield* Effect.exit(checkpoint.memo(options, failing));
      const second = yield* Effect.exit(checkpoint.memo(options, failing));
      expect(c.count).toBe(1);
      expect(first).toEqual(Exit.fail(new Boom({ detail: "x" })));
      expect(second).toEqual(first);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("does not share steps between runs", () =>
    Effect.gen(function* () {
      const c = counter();
      yield* memo("r1", "step", Schema.Finite, c.next);
      yield* memo("r2", "step", Schema.Finite, c.next);
      expect(c.count).toBe(2);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("does not share a run id between threads", () =>
    Effect.gen(function* () {
      const checkpoint = yield* Checkpoint.Checkpoint;
      const c = counter();
      const on = (threadId: string) =>
        checkpoint.memo({ threadId, runId: "r1", name: "step", success: Schema.Finite, error: Schema.Never }, c.next);
      const first = yield* on("t1");
      const second = yield* on("t2");
      expect(c.count).toBe(2);
      expect(second).toEqual({ value: 2, replayed: false });
      expect(yield* on("t1")).toEqual({ ...first, replayed: true });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("stores nothing for an interrupted attempt", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* memo(
        "r1",
        "step",
        Schema.Finite,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      const c = counter();
      const retried = yield* memo("r1", "step", Schema.Finite, c.next);
      expect(c.count).toBe(1);
      expect(retried).toEqual({ value: 1, replayed: false });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("round-trips a prompt", () =>
    Effect.gen(function* () {
      const prompt = Prompt.make([
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Weather in Paris?" },
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "get-weather", params: { location: "Paris" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "c1", name: "get-weather", isFailure: false, result: 18 }],
        },
      ]);
      yield* memo("r1", "prompt", Prompt.Prompt, Effect.succeed(prompt));
      const replayed = yield* memo("r1", "prompt", Prompt.Prompt, Effect.die("not replayed"));
      expect(replayed.replayed).toBe(true);
      expect(replayed.value).toEqual(prompt);
    }).pipe(Effect.provide(ledger)),
  );
});

describe("Checkpoint.layerWorkflow", () => {
  it.effect("runs a memoised step once inside a workflow execution", () => {
    const c = counter();
    const TestWorkflow = Workflow.make("test", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.Boolean),
      idempotencyKey: (payload) => payload.id,
    });
    const WorkflowLayer = TestWorkflow.toLayer(() =>
      Effect.gen(function* () {
        const first = yield* memo("ignored", "count", Schema.Finite, c.next);
        const second = yield* memo("ignored", "count", Schema.Finite, c.next);
        return [first.replayed, second.replayed];
      }).pipe(Effect.provide(Checkpoint.layerWorkflow)),
    );
    return Effect.gen(function* () {
      const replayed = yield* TestWorkflow.execute({ id: "w1" });
      expect(c.count).toBe(1);
      expect(replayed).toEqual([false, true]);
    }).pipe(Effect.provide(WorkflowLayer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory))));
  });
});
