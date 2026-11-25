import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Activity } from "effect/workflow";
import type { WorkflowEngine } from "effect/workflow";

/** The result of a memoised step, and whether it came from the store instead of running. */
export interface Memoized<A> {
  readonly value: A;
  readonly replayed: boolean;
}

export interface MemoOptions<A, I, E, EI> {
  /**
   * With `runId`, the run the step belongs to. Steps are scoped by thread as
   * well as run because the client picks the run id: a run id reused on
   * another thread must not reach this run's steps.
   */
  readonly threadId: string;
  readonly runId: string;
  /** Unique within the run, e.g. `model:2` or `tool:<toolCallId>`. */
  readonly name: string;
  readonly success: Schema.Codec<A, I>;
  readonly error: Schema.Codec<E, EI>;
}

/**
 * Memoises the named steps of a run. The first execution of `(threadId, runId, name)`
 * runs the effect and stores its completed exit, success or failure; later
 * executions replay it without running the effect. An interrupted attempt
 * stores nothing, so a resumed run executes that step again.
 */
export class Checkpoint extends Context.Service<
  Checkpoint,
  {
    readonly memo: <A, I, E, EI, R>(
      options: MemoOptions<A, I, E, EI>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Memoized<A>, E, R>;
  }
>()("effect-agent-harness/Checkpoint") {}

/** Always runs the effect and never replays. For tests and evals. */
export const layerNone: Layer.Layer<Checkpoint> = Layer.succeed(Checkpoint)({
  memo: (_options, effect) => Effect.map(effect, (value) => ({ value, replayed: false })),
});

// -----------------------------------------------------------------------------
// Key-value store
// -----------------------------------------------------------------------------

/**
 * The prefix of every key {@link layerKeyValueStore} writes, so a store shared
 * with other data stays apart from it.
 */
export const keyPrefix = "effect-agent-harness/checkpoint/";

/**
 * Memoises steps in the `KeyValueStore` in context (`effect/persistence`), so
 * any of its backends can hold them: `KeyValueStore.layerMemory` for tests and
 * local development, or a file system, SQL or Web Storage layer. Each step's
 * completed `Exit` is stored as JSON under {@link keyPrefix} followed by the
 * JSON array `[threadId, runId, name]`. All three are in the key because the
 * client picks the run id, so it is only unique within a thread.
 *
 * Store and codec errors are defects: the run cannot meaningfully continue
 * without its store.
 */
export const layerKeyValueStore: Layer.Layer<Checkpoint, never, KeyValueStore.KeyValueStore> = Layer.effect(
  Checkpoint,
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, keyPrefix);
    return Checkpoint.of({
      memo: <A, I, E, EI, R>(options: MemoOptions<A, I, E, EI>, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const exits = KeyValueStore.toSchemaStore(
            store,
            Schema.Exit(options.success, options.error, Schema.Defect()),
          );
          // JSON, so no choice of ids can make two keys collide.
          const key = JSON.stringify([options.threadId, options.runId, options.name]);
          const stored = yield* Effect.orDie(exits.get(key));
          if (Option.isSome(stored)) {
            const value = yield* stored.value;
            return { value, replayed: true };
          }
          const exit = yield* Effect.exit(effect);
          if (Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)) {
            yield* Effect.orDie(exits.set(key, exit));
          }
          const value = yield* exit;
          return { value, replayed: false };
        }),
    });
  }),
);

// -----------------------------------------------------------------------------
// Workflow
// -----------------------------------------------------------------------------

/**
 * Runs each step as an `effect/workflow` activity named after the step, so the
 * workflow engine stores and replays it. The thread and run ids are not used:
 * the workflow execution, keyed by both, already scopes activity names. Build this layer inside a workflow
 * execution, e.g. by providing it in `Workflow.toLayer`'s body.
 */
export const layerWorkflow: Layer.Layer<
  Checkpoint,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> = Layer.effect(
  Checkpoint,
  Effect.gen(function* () {
    const context = yield* Effect.context<WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>();
    return Checkpoint.of({
      memo: <A, I, E, EI, R>(options: MemoOptions<A, I, E, EI>, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          let ran = false;
          const activity = Activity.make({
            name: options.name,
            success: options.success,
            error: options.error,
            execute: Effect.tap(effect, () =>
              Effect.sync(() => {
                ran = true;
              }),
            ),
          });
          return activity.pipe(
            Effect.map((value): Memoized<A> => ({ value, replayed: !ran })),
            Effect.provideContext(context),
          );
        }),
    });
  }),
);
