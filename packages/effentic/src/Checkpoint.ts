import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { Activity } from "effect/workflow";
import type { WorkflowEngine } from "effect/workflow";

/** The result of a memoised step, and whether it came from the store instead of running. */
export interface Memoized<A> {
  readonly value: A;
  readonly replayed: boolean;
}

export interface MemoOptions<A, I, E, EI> {
  readonly runId: string;
  /** Unique within the run, e.g. `model:2` or `tool:<toolCallId>`. */
  readonly name: string;
  readonly success: Schema.Codec<A, I>;
  readonly error: Schema.Codec<E, EI>;
}

/**
 * Memoises the named steps of a run. The first execution of `(runId, name)`
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
>()("effentic/Checkpoint") {}

/** Always runs the effect and never replays. For tests and evals. */
export const layerNone: Layer.Layer<Checkpoint> = Layer.succeed(Checkpoint)({
  memo: (_options, effect) => Effect.map(effect, (value) => ({ value, replayed: false })),
});

// -----------------------------------------------------------------------------
// Ledger
// -----------------------------------------------------------------------------

export class LedgerError extends Schema.TaggedError<LedgerError, { readonly brand: unique symbol }>()("LedgerError", {
  cause: Schema.Defect(),
}) {}

/**
 * A store for completed step exits, keyed by run id and step name. The value
 * is the step's `Exit` encoded as JSON, so any key-value store can hold it.
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly get: (runId: string, name: string) => Effect.Effect<Option.Option<unknown>, LedgerError>;
    readonly set: (runId: string, name: string, exit: unknown) => Effect.Effect<void, LedgerError>;
  }
>()("effentic/Checkpoint/Ledger") {}

/**
 * Memoises steps in the {@link Ledger} in context. Ledger and codec errors are
 * defects: the run cannot meaningfully continue without its store.
 */
export const layerLedger: Layer.Layer<Checkpoint, never, Ledger> = Layer.effect(
  Checkpoint,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    return Checkpoint.of({
      memo: <A, I, E, EI, R>(options: MemoOptions<A, I, E, EI>, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const codec = Schema.toCodecJson(Schema.Exit(options.success, options.error, Schema.Defect()));
          const stored = yield* Effect.orDie(ledger.get(options.runId, options.name));
          if (Option.isSome(stored)) {
            const exit = yield* Effect.orDie(Schema.decodeUnknownEffect(codec)(stored.value));
            const value = yield* exit;
            return { value, replayed: true };
          }
          const exit = yield* Effect.exit(effect);
          if (Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)) {
            const encoded = yield* Effect.orDie(Schema.encodeEffect(codec)(exit));
            yield* Effect.orDie(ledger.set(options.runId, options.name, encoded));
          }
          const value = yield* exit;
          return { value, replayed: false };
        }),
    });
  }),
);

/** A {@link Ledger} over an in-process map. For tests and local development. */
export const layerMemoryLedger: Layer.Layer<Ledger> = Layer.sync(Ledger, () => {
  const entries = new Map<string, unknown>();
  const key = (runId: string, name: string) => `${runId}\u0000${name}`;
  return Ledger.of({
    get: (runId, name) => Effect.sync(() => Option.fromUndefinedOr(entries.get(key(runId, name)))),
    set: (runId, name, exit) =>
      Effect.sync(() => {
        entries.set(key(runId, name), exit);
      }),
  });
});

// -----------------------------------------------------------------------------
// Workflow
// -----------------------------------------------------------------------------

/**
 * Runs each step as an `effect/workflow` activity named after the step, so the
 * workflow engine stores and replays it. The run id is not used: the workflow
 * execution already scopes activity names. Build this layer inside a workflow
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
