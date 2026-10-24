import { Cause, Effect, Schema, Scope, Stream } from "effect";
import type { Layer } from "effect";
import { Prompt } from "effect/ai";
import type { Tool } from "effect/ai";
import { Workflow } from "effect/workflow";
import type { WorkflowEngine } from "effect/workflow";
import * as Agent from "./Agent.ts";
import * as AgUi from "./AgUi.ts";
import * as Checkpoint from "./Checkpoint.ts";
import * as EventLog from "./EventLog.ts";
import * as Messages from "./Messages.ts";
import * as Thread from "./Thread.ts";

export interface Options {
  /** What to do with client-sent `system`/`developer` messages. See {@link Messages.IngestOptions}. */
  readonly clientSystem?: Messages.IngestOptions["clientSystem"];
}

/** Per-run options, set by whoever starts the run. */
export interface RunOptions {
  /**
   * The run's {@link Agent.RunInfo} `context`: trusted data such as the
   * verified principal (never the raw token). Nothing in the AG-UI input can
   * set it. Must be JSON-encodable for {@link workflow}.
   */
  readonly context?: unknown;
}

const failed = (cause: Cause.Cause<unknown>): Agent.Event => {
  const error = Cause.squash(cause);
  return { _tag: "Failed", error, code: Agent.errorCode(error) };
};

/**
 * Calls `runEnded` for a terminal event. If the store fails, a successful or
 * interrupted run ends as failed instead; a run that already failed keeps its
 * own error.
 */
const reportEnd = (
  threadId: string,
  runId: string,
  event: Extract<Agent.Event, { readonly _tag: "Finished" | "Failed" }>,
): Effect.Effect<Agent.Event, never, Thread.Thread> =>
  Effect.flatMap(Thread.Thread, (thread) =>
    thread.runEnded(
      threadId,
      runId,
      event._tag === "Finished" ? { _tag: event.outcome._tag } : { _tag: "Failed", code: event.code },
    ),
  ).pipe(
    Effect.as<Agent.Event>(event),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? // An interrupt-only cause has no failures, so its error type is irrelevant.
          Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed(event._tag === "Failed" ? event : failed(cause)),
    ),
  );

/**
 * One AG-UI run over the server-owned thread:
 *
 * 1. load the thread, take the client's delta and its `resume` answers, and
 *    commit them;
 * 2. project the thread, memoised as the `prompt` checkpoint so a resumed run
 *    uses the projection the crashed attempt used;
 * 3. run the agent with the run's info (the input's ids and `forwardedProps`,
 *    and the caller's context), committing each step's entries as it finishes;
 * 4. tell the store the run ended, however it ended;
 * 5. project the events onto AG-UI.
 *
 * Failures, including those before the model is called (`ThreadError`,
 * `HistoryMismatch`), end the stream with `RUN_ERROR`, so it never fails.
 * Only an interrupted run (e.g. a cancelled request) is not reported to the
 * store, since it has not ended: running it again finishes it.
 */
const pipeline =
  <Tools extends Record<string, Tool.Any>, R>(agent: Agent.Agent<Tools, R>, options?: Options) =>
  (
    input: AgUi.RunAgentInput,
    runOptions?: RunOptions,
  ): Stream.Stream<AgUi.Event, never, Agent.Requirements<Tools, R> | Thread.Thread> => {
    const { threadId, runId } = input;
    const events = Stream.unwrap(
      Effect.gen(function* () {
        const thread = yield* Thread.Thread;
        const checkpoint = yield* Checkpoint.Checkpoint;
        const stored = yield* thread.load(threadId);
        const delta = yield* Effect.fromResult(Messages.delta(stored, input.messages));
        // Answers to the previous run come before anything new the client says.
        const added = [
          ...Messages.resume(stored, input.resume ?? []),
          ...Messages.ingest(delta, { clientSystem: options?.clientSystem }),
        ];
        yield* thread.commit(threadId, runId, added);
        const prompt = yield* checkpoint.memo(
          { runId, name: "prompt", success: Prompt.Prompt, error: Schema.Never },
          Effect.sync(() => Messages.project([...stored, ...added])),
        );

        return Agent.run(agent)({
          runId,
          threadId,
          props: input.forwardedProps,
          context: runOptions?.context,
          prompt: prompt.value,
        }).pipe(
          Stream.tap((event) =>
            event._tag === "StepFinished" ? thread.commit(threadId, runId, event.entries) : Effect.void,
          ),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? // An interrupt-only cause has no failures, so its error type is irrelevant.
            Stream.failCause(cause as Cause.Cause<never>)
          : Stream.make(failed(cause)),
      ),
      // After the catch, so a run that failed anywhere above is reported too.
      Stream.mapEffect((event) =>
        event._tag === "Finished" || event._tag === "Failed"
          ? reportEnd(threadId, runId, event)
          : Effect.succeed(event),
      ),
    );
    return AgUi.fold(input)(events).pipe(Stream.withSpan("effentic/Runner.run", { attributes: { threadId, runId } }));
  };

/**
 * Runs an agent for one AG-UI `RunAgentInput`, scoped to the stream: when the
 * consumer stops reading (a client disconnects, `abortRun()`), the run is
 * cancelled, including any model request or tool call in progress.
 */
export const run = <Tools extends Record<string, Tool.Any>, R>(agent: Agent.Agent<Tools, R>, options?: Options) =>
  pipeline(agent, options);

/**
 * Captures the services once and returns a request-scoped runner whose
 * streams have no requirements. Use this at a transport edge (HTTP response,
 * WebSocket, ...) where the stream is consumed after the surrounding effect has
 * returned.
 */
export const make = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  options?: Options,
): Effect.Effect<
  (input: AgUi.RunAgentInput, runOptions?: RunOptions) => Stream.Stream<AgUi.Event>,
  never,
  Agent.Requirements<Tools, R> | Thread.Thread
> =>
  Effect.map(Effect.context<Agent.Requirements<Tools, R> | Thread.Thread>(), (context) => {
    const runWith = pipeline(agent, options);
    return (input, runOptions) => runWith(input, runOptions).pipe(Stream.provideContext(context));
  });

/**
 * Runs the pipeline into the event log. If the log already holds an earlier
 * attempt of the run, that attempt is completed instead of started over: a
 * finished run is left alone, spans the attempt left open are closed, and its
 * `RUN_STARTED` is not repeated. Steps the earlier attempt completed are
 * replayed from the checkpoint store and publish nothing.
 */
const detached =
  <Tools extends Record<string, Tool.Any>, R>(agent: Agent.Agent<Tools, R>, options?: Options) =>
  (
    input: AgUi.RunAgentInput,
    runOptions?: RunOptions,
  ): Effect.Effect<void, EventLog.EventLogError, Agent.Requirements<Tools, R> | Thread.Thread | EventLog.EventLog> => {
    const runWith = pipeline(agent, options);
    return Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const append = (event: AgUi.Event) => log.append(input.runId, event);
      const history = (yield* log.read(input.runId)).map((stored) => stored.event);
      const last = history.at(-1);
      if (last !== undefined && AgUi.isTerminal(last)) {
        return;
      }
      yield* Effect.forEach(AgUi.closeOpen(history), append, { discard: true });
      const events = history.length === 0 ? runWith(input, runOptions) : Stream.drop(runWith(input, runOptions), 1);
      yield* Stream.runForEach(events, append);
    });
  };

/**
 * A runner whose runs outlive the request that starts them. `start` forks the
 * run into the scope this effect was given and returns at once; the run's
 * AG-UI events go to the {@link EventLog.EventLog}, where clients subscribe
 * and reconnect. A client disconnecting does not affect the run; closing the
 * scope interrupts it.
 *
 * `start` does nothing for a run whose log already ends with a terminal event.
 * Calling it again with the same input and context after a crash completes
 * the run; the context is not stored, so pass the one the first call had.
 * With a durable `Checkpoint` (e.g. `Checkpoint.layerLedger`) completed steps
 * are replayed rather than executed again. Do not start the same run twice
 * concurrently: supervising runs is the caller's concern here, or use
 * {@link workflow}.
 */
export const makeDetached = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  options?: Options,
): Effect.Effect<
  { readonly start: (input: AgUi.RunAgentInput, runOptions?: RunOptions) => Effect.Effect<void> },
  never,
  Agent.Requirements<Tools, R> | Thread.Thread | EventLog.EventLog | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Agent.Requirements<Tools, R> | Thread.Thread | EventLog.EventLog>();
    const scope = yield* Scope.Scope;
    const log = yield* EventLog.EventLog;
    const body = detached(agent, options);
    return {
      start: (input, runOptions) =>
        Effect.gen(function* () {
          const last = (yield* Effect.orDie(log.read(input.runId))).at(-1);
          if (last !== undefined && AgUi.isTerminal(last.event)) {
            return;
          }
          yield* body(input, runOptions).pipe(
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("effentic: detached run failed", cause),
            ),
            Effect.provideContext(context),
            Effect.forkIn(scope),
          );
        }),
    };
  });

/** What {@link workflow} persists per run: the AG-UI input and the caller's context. */
export const WorkflowPayload = Schema.Struct({
  input: AgUi.RunAgentInput,
  context: Schema.optional(Schema.Unknown),
});

/**
 * The run as an `effect/workflow` workflow, keyed by run id, with workflow
 * activities as checkpoints, so a durable engine (e.g. `ClusterWorkflowEngine`)
 * persists the run and replays it after a crash or deploy. Register `layer`
 * with the engine and start a run with
 * `workflow.execute({ input, context }, { discard: true })`; observe it
 * through the {@link EventLog.EventLog}. The payload, context included, is what
 * the engine persists, so a resumed execution sees the original context.
 * Executing the same run id again joins the existing execution. Resuming an
 * execution the engine has suspended is the engine's concern
 * (`workflow.resume(yield* workflow.executionId(payload))`).
 */
export const workflow = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  options?: Options,
) => {
  const run = Workflow.make("effentic/Run", {
    payload: WorkflowPayload,
    idempotencyKey: (payload) => payload.input.runId,
  });
  const body = detached(agent, options);
  const layer: Layer.Layer<
    never,
    never,
    | Exclude<Agent.Requirements<Tools, R>, Checkpoint.Checkpoint>
    | Thread.Thread
    | EventLog.EventLog
    | WorkflowEngine.WorkflowEngine
  > = run.toLayer((payload) =>
    body(payload.input, { context: payload.context }).pipe(Effect.orDie, Effect.provide(Checkpoint.layerWorkflow)),
  );
  return { workflow: run, layer };
};
