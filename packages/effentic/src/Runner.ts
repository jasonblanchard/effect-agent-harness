import { Cause, Context, Effect, Layer, Schema, Scope, Stream } from "effect";
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

/**
 * A declared slice of a run's trusted context: a service whose value is the
 * decoded type of `schema`. Built with {@link RunContext}.
 */
export interface RunContextClass<Self, Key extends string, S extends Schema.Top> extends Context.ServiceClass<
  Self,
  Key,
  S["Type"]
> {
  readonly schema: S;
}

export type AnyRunContext = RunContextClass<any, string, any>;

/** Any service key, as {@link DetachedOptions.dependencies} takes them. */
export type AnyService = Context.Key<any, any>;

/**
 * Declares a per-run dependency a {@link workflow} can persist, such as the
 * verified principal: a service key plus the schema of its value.
 *
 * ```ts
 * class AuthContext extends Runner.RunContext<AuthContext>()("app/Auth", {
 *   schema: Schema.Struct({ userId: Schema.String }),
 * }) {}
 * ```
 *
 * A workflow's {@link DetachedOptions.dependencies} must be run contexts,
 * because the engine persists each one in the run's payload, encoded with its
 * schema. The detached runner takes any service, so a plain `Context.Service`
 * is enough there; a run context works too. A request-scoped {@link run}
 * declares nothing: the agent requires the service, and the route provides it.
 */
export const RunContext =
  <Self>() =>
  <const Key extends string, S extends Schema.Top>(
    key: Key,
    options: { readonly schema: S },
  ): RunContextClass<Self, Key, S> =>
    class extends Context.Service<Self, S["Type"]>()(key) {
      static readonly schema = options.schema;
    };

/** The services a runner's {@link DetachedOptions.dependencies} name. */
export type DependencyServices<Dependencies extends ReadonlyArray<AnyService>> = Dependencies[number]["Identifier"];

/** Options of every runner. {@link run} takes exactly these. */
export interface Options<ROut = never, E = never, RIn = never> {
  /** What to do with client-sent `system`/`developer` messages. See {@link Messages.IngestOptions}. */
  readonly clientSystem?: Messages.IngestOptions["clientSystem"];
  /**
   * Builds per-run services, such as the current user, typically from a
   * service the caller provides per run, like the verified principal. It is
   * built for every run attempt, before the input check and the claim, and
   * lives until the attempt ends. It is not memoised: a run executed again
   * builds it again. A failure to build it ends the run with `RUN_ERROR`.
   *
   * With {@link run} you can instead provide the layer on the run's stream
   * (`Stream.provide`), but then a failure to build it fails the stream
   * instead of ending the run with `RUN_ERROR`. A detached run needs `layer`,
   * so its services live as long as the run rather than the call to `start`,
   * and so does a {@link workflow}, which rebuilds its services from the
   * persisted dependencies on every replay.
   */
  readonly layer?: Layer.Layer<ROut, E, RIn>;
}

/**
 * Options of the runners that capture their services when they're built
 * ({@link makeDetached}, {@link workflow}), which therefore name the services
 * to leave out of the capture.
 */
export interface DetachedOptions<
  Dependencies extends ReadonlyArray<AnyService> = readonly [],
  ROut = never,
  E = never,
  RIn = never,
> extends Options<ROut, E, RIn> {
  /**
   * Services each run requires from whoever starts it, such as the verified
   * principal, instead of capturing them when the runner is built, as a tool's
   * `dependencies` are required per call. Provide them around each `start`
   * (`Effect.provideService`). Any service key, except for a {@link workflow},
   * which takes {@link RunContext}s.
   */
  readonly dependencies?: Dependencies;
}

/**
 * What a runner needs from outside: the agent's requirements, less the per-run
 * services and the per-run dependencies, plus what the per-run layer needs,
 * less the per-run dependencies. The thread store and the checkpoint store are
 * always required from outside, because the run uses them before its per-run
 * services exist. A detached or workflow runner captures this when it's built;
 * {@link run} has no dependencies and leaves it on each stream.
 */
export type Requirements<
  Tools extends Record<string, Tool.Any>,
  R,
  Dependencies extends ReadonlyArray<AnyService>,
  ROut,
  RIn,
> =
  | Exclude<Agent.Requirements<Tools, R>, ROut | DependencyServices<Dependencies>>
  | Exclude<RIn, DependencyServices<Dependencies>>
  | Thread.Thread
  | Checkpoint.Checkpoint;

/**
 * The run id was already used on this thread with a different input. A run id
 * names one input: executing a run again replays its stored steps, which were
 * produced from the first input.
 */
export class RunInputMismatch extends Schema.TaggedError<RunInputMismatch, { readonly brand: unique symbol }>()(
  "RunInputMismatch",
  {},
) {
  override get message(): string {
    return "The run id was already used on this thread with a different input";
  }
}

const InputJson = Schema.toCodecJson(AgUi.RunAgentInput);

const failed = (cause: Cause.Cause<unknown>): Agent.Event => {
  const error = Cause.squash(cause);
  return { _tag: "Failed", error, code: Agent.errorCode(error) };
};

/** Ends the stream with a `Failed` event instead of failing it. Interruption passes through. */
const failInBand = <R>(stream: Stream.Stream<Agent.Event, unknown, R>): Stream.Stream<Agent.Event, never, R> =>
  Stream.catchCause(stream, (cause) =>
    Cause.hasInterruptsOnly(cause)
      ? // An interrupt-only cause has no failures, so its error type is irrelevant.
        Stream.failCause(cause as Cause.Cause<never>)
      : Stream.make(failed(cause)),
  );

/**
 * For a terminal event, calls `runEnded` and then releases the thread, even if
 * `runEnded` failed. If either fails, a successful or interrupted run ends as
 * failed instead; a run that already failed keeps its own error.
 */
const endRun = (
  threadId: string,
  runId: string,
  event: Extract<Agent.Event, { readonly _tag: "Finished" | "Failed" }>,
): Effect.Effect<Agent.Event, never, Thread.Thread> =>
  Effect.flatMap(Thread.Thread, (thread) =>
    thread
      .runEnded(
        threadId,
        runId,
        event._tag === "Finished" ? { _tag: event.outcome._tag } : { _tag: "Failed", code: event.code },
      )
      .pipe(
        Effect.exit,
        Effect.flatMap((ended) => Effect.andThen(thread.release(threadId, runId), ended)),
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
 * Builds the per-run layer, which reads the per-run dependencies from the
 * context it runs in. The built services live in the scope this is given.
 */
const resolveServices = <ROut, E, RIn>(
  options: Options<ROut, E, RIn> | undefined,
): Effect.Effect<Context.Context<ROut>, E, RIn | Scope.Scope> =>
  options?.layer === undefined
    ? // Without a layer there are no per-run services.
      Effect.succeed(Context.empty() as Context.Context<ROut>)
    : Layer.build(options.layer);

/**
 * One AG-UI run over the server-owned thread:
 *
 * 1. build the per-run layer from the dependencies the run was provided, for
 *    this attempt only;
 * 2. check that the input is the one the run id was first used with
 *    (memoised as the `input` checkpoint; the dependencies are not part of
 *    it), and claim the thread, so it has one active run;
 * 3. load the thread, take the client's delta and its `resume` answers, and
 *    commit them;
 * 4. project the thread, memoised as the `prompt` checkpoint so a resumed run
 *    uses the projection the crashed attempt used;
 * 5. run the agent with the run's info (the input's ids and `forwardedProps`)
 *    and the per-run services, committing each step's entries as it finishes;
 * 6. tell the store the run ended, however it ended, and release the thread
 *    before the terminal event is emitted, so the client's next run finds it
 *    free;
 * 7. project the events onto AG-UI.
 *
 * Every checkpoint is scoped by the thread id as well as the run id, so a run
 * id the client reuses on another thread replays nothing.
 *
 * Failures, including those before the model is called (the per-run layer's
 * errors, `ThreadError`, `HistoryMismatch`, `UnansweredInterrupt`,
 * `RunInputMismatch`, `ThreadBusy`), end the stream with `RUN_ERROR`, so it
 * never fails. A run that never claimed the thread is not reported to the
 * store. Nor is an interrupted run (e.g. a cancelled request), since it has
 * not ended: it keeps its claim, and running it again finishes it. The
 * request-scoped runner releases a cancelled run's claim itself.
 */
const pipeline =
  <Tools extends Record<string, Tool.Any>, R, Dependencies extends ReadonlyArray<AnyService>, ROut, E, RIn>(
    agent: Agent.Agent<Tools, R>,
    options?: Options<ROut, E, RIn>,
  ) =>
  (
    input: AgUi.RunAgentInput,
  ): Stream.Stream<
    AgUi.Event,
    never,
    Requirements<Tools, R, Dependencies, ROut, RIn> | DependencyServices<Dependencies>
  > => {
    const { threadId, runId } = input;
    // Runs while the run holds the thread.
    const claimed = (thread: Thread.Thread["Service"], checkpoint: Checkpoint.Checkpoint["Service"]) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stored = yield* thread.load(threadId);
          const delta = yield* Effect.fromResult(Messages.delta(stored, input.messages, runId));
          const responses = yield* Effect.fromResult(Messages.resume(stored, input.resume ?? []));
          const malformed = Messages.malformedAnswers(input.resume ?? []);
          if (malformed.length > 0) {
            yield* Effect.logWarning(
              "effentic: resolved answers that are not approval responses were denied",
              malformed,
            );
          }
          // Answers to the previous run come before anything new the client says.
          const added = [...responses, ...Messages.ingest(delta, { clientSystem: options?.clientSystem })];
          yield* thread.commit(threadId, runId, added);
          const prompt = yield* checkpoint.memo(
            { threadId, runId, name: "prompt", success: Prompt.Prompt, error: Schema.Never },
            Effect.sync(() => Messages.project([...stored, ...added])),
          );

          return Agent.run(agent)({
            runId,
            threadId,
            props: input.forwardedProps,
            prompt: prompt.value,
          }).pipe(
            Stream.tap((event) =>
              event._tag === "StepFinished" ? thread.commit(threadId, runId, event.entries) : Effect.void,
            ),
          );
        }),
      ).pipe(
        failInBand,
        // After the catch, so a run that failed anywhere above is reported too.
        Stream.mapEffect((event) =>
          event._tag === "Finished" || event._tag === "Failed" ? endRun(threadId, runId, event) : Effect.succeed(event),
        ),
      );

    // The per-run layer's scope is this stream's: it closes when the attempt ends.
    const events = Stream.unwrap(
      Effect.gen(function* () {
        const services = yield* resolveServices(options);
        const thread = yield* Thread.Thread;
        const checkpoint = yield* Checkpoint.Checkpoint;
        const fingerprint = JSON.stringify(yield* Effect.orDie(Schema.encodeEffect(InputJson)(input)));
        const first = yield* checkpoint.memo(
          { threadId, runId, name: "input", success: Schema.String, error: Schema.Never },
          Effect.succeed(fingerprint),
        );
        if (first.value !== fingerprint) {
          return yield* new RunInputMismatch();
        }
        yield* thread.claim(threadId, runId);
        return claimed(thread, checkpoint).pipe(Stream.provideContext(services));
      }),
    ).pipe(failInBand);
    return AgUi.fold(input)(events).pipe(Stream.withSpan("effentic/Runner.run", { attributes: { threadId, runId } }));
  };

/**
 * Runs an agent for one AG-UI `RunAgentInput`, scoped to the stream: when the
 * consumer stops reading (a client disconnects, `abortRun()`), the run is
 * cancelled, including any model request or tool call in progress.
 *
 * Nothing is captured: the function is plain, and each stream requires the
 * agent's services (a per-run service such as the verified principal among
 * them), the stores, and whatever the per-run `layer` needs. At a transport
 * edge, call it inside the request handler, provide the per-request services
 * (`Stream.provideService(AuthContext, principal)`) and close over the
 * handler's context (`Stream.provideContext(yield* Effect.context())`) before
 * handing the stream to the response, so it needs nothing more once the
 * handler has returned. The rest is then a requirement of the handler: with
 * `effect/http`, keep those services in the app layer's output
 * (`Layer.provideMerge`), which the web handler provides to every request.
 */
export const run = <Tools extends Record<string, Tool.Any>, R, ROut = never, E = never, RIn = never>(
  agent: Agent.Agent<Tools, R>,
  options?: Options<ROut, E, RIn>,
) => {
  const runWith = pipeline<Tools, R, readonly [], ROut, E, RIn>(agent, options);
  return (
    input: AgUi.RunAgentInput,
  ): Stream.Stream<AgUi.Event, never, Requirements<Tools, R, readonly [], ROut, RIn>> =>
    Stream.suspend(() => {
      // A run that ended has released its thread. Nothing resumes a cancelled
      // request-scoped run, so a stream that stops before the end frees it.
      let ended = false;
      return runWith(input).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            ended ||= AgUi.isTerminal(event);
          }),
        ),
        Stream.ensuring(
          Effect.suspend(() =>
            ended
              ? Effect.void
              : Effect.flatMap(Thread.Thread, (thread) => thread.release(input.threadId, input.runId)).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("effentic: releasing a cancelled run's thread failed", cause),
                  ),
                ),
          ),
        ),
      );
    });
};

/**
 * Runs the pipeline into the event log. If the log already holds an earlier
 * attempt of the run, that attempt is completed instead of started over: a
 * finished run is left alone, spans the attempt left open are closed, and its
 * `RUN_STARTED` is not repeated. Steps the earlier attempt completed are
 * replayed from the checkpoint store and publish nothing.
 */
const detached =
  <Tools extends Record<string, Tool.Any>, R, Dependencies extends ReadonlyArray<AnyService>, ROut, E, RIn>(
    agent: Agent.Agent<Tools, R>,
    options?: DetachedOptions<Dependencies, ROut, E, RIn>,
  ) =>
  (
    input: AgUi.RunAgentInput,
  ): Effect.Effect<
    void,
    EventLog.EventLogError,
    Requirements<Tools, R, Dependencies, ROut, RIn> | DependencyServices<Dependencies> | EventLog.EventLog
  > => {
    const runWith = pipeline<Tools, R, Dependencies, ROut, E, RIn>(agent, options);
    return Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const append = (event: AgUi.Event) => log.append(input.threadId, input.runId, event);
      // Without a cursor, the read cannot fail with `InvalidCursor`.
      const history = (yield* log
        .read(input.threadId, input.runId)
        .pipe(Effect.catchTag("InvalidCursor", Effect.die))).map((stored) => stored.event);
      const last = history.at(-1);
      if (last !== undefined && AgUi.isTerminal(last)) {
        return;
      }
      yield* Effect.forEach(AgUi.closeOpen(history), append, { discard: true });
      const events = history.length === 0 ? runWith(input) : Stream.drop(runWith(input), 1);
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
 * `start` requires the runner's per-run dependencies and reads them when it's
 * called, so provide them around it
 * (`Effect.provideService(AuthContext, principal)`). It does nothing for a run
 * whose log already ends with a terminal event. Calling it again with the same
 * input and dependencies after a crash completes the run, building its per-run
 * services again; the dependencies are not stored, so provide the ones the first call had. With a durable
 * `Checkpoint` (e.g. `Checkpoint.layerLedger`) completed steps are replayed
 * rather than executed again. Do not start the same run twice concurrently:
 * supervising runs is the caller's concern here, or use {@link workflow}.
 */
export const makeDetached = <
  Tools extends Record<string, Tool.Any>,
  R,
  const Dependencies extends ReadonlyArray<AnyService> = readonly [],
  ROut = never,
  E = never,
  RIn = never,
>(
  agent: Agent.Agent<Tools, R>,
  options?: DetachedOptions<Dependencies, ROut, E, RIn>,
): Effect.Effect<
  { readonly start: (input: AgUi.RunAgentInput) => Effect.Effect<void, never, DependencyServices<Dependencies>> },
  never,
  Requirements<Tools, R, Dependencies, ROut, RIn> | EventLog.EventLog | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements<Tools, R, Dependencies, ROut, RIn> | EventLog.EventLog>();
    const scope = yield* Scope.Scope;
    const log = yield* EventLog.EventLog;
    const body = detached(agent, options);
    return {
      start: (input) =>
        Effect.gen(function* () {
          const last = (yield* Effect.orDie(log.read(input.threadId, input.runId))).at(-1);
          if (last !== undefined && AgUi.isTerminal(last.event)) {
            return;
          }
          // Read now, so the forked run has the dependencies its caller provided.
          const perRun = yield* Effect.context<DependencyServices<Dependencies>>();
          yield* body(input).pipe(
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("effentic: detached run failed", cause),
            ),
            Effect.provideContext(Context.merge(context, perRun)),
            Effect.forkIn(scope),
          );
        }),
    };
  });

export interface WorkflowOptions<
  Dependencies extends ReadonlyArray<AnyRunContext> = readonly [],
  ROut = never,
  E = never,
  RIn = never,
> extends DetachedOptions<Dependencies, ROut, E, RIn> {
  /**
   * The workflow's name. The engine registers the workflow under it, derives
   * execution ids from it and persists it with every execution, so it must be
   * unique per engine (one per agent) and must not change while executions
   * under it are in flight.
   */
  readonly name: string;
}

/**
 * The fields of what {@link workflow} persists per run: the AG-UI input and,
 * when the runner has dependencies, their values keyed by each run context's
 * key, encoded with their schemas.
 */
export type WorkflowPayloadFields<Dependencies extends ReadonlyArray<AnyRunContext>> = Dependencies extends readonly []
  ? { readonly input: typeof AgUi.RunAgentInput }
  : {
      readonly input: typeof AgUi.RunAgentInput;
      readonly context: Schema.Struct<{ readonly [C in Dependencies[number] as C["key"]]: C["schema"] }>;
    };

/** A workflow payload, read through the shape every payload has. */
interface PayloadParts {
  readonly input: AgUi.RunAgentInput;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * The run as an `effect/workflow` workflow, keyed by thread id and run id, with workflow
 * activities as checkpoints, so a durable engine (e.g. `ClusterWorkflowEngine`)
 * persists the run and replays it after a crash or deploy. Give it a `name`
 * unique to this agent ({@link WorkflowOptions}), register `layer` with the
 * engine, and start a run with `start(input)`, providing its dependencies
 * around it; observe it through the {@link EventLog.EventLog}. The
 * dependencies must be {@link RunContext}s, so they can be persisted.
 *
 * `start` reads the dependencies' services, persists them in the payload
 * (encoded with their schemas, so a value the schema rejects makes `start`
 * die before any execution exists) and executes the run without waiting for
 * it. A resumed execution sees the original dependencies and builds its
 * per-run services again from them. Starting the same run on the same thread
 * again joins the existing execution; the same run id on another thread is a
 * different execution. `executionId(input)`, with the same dependencies
 * provided, gives a run's execution id for the engine-level controls on
 * `workflow` (`resume`, `poll`, `interrupt`): the engine derives it from the
 * encoded payload.
 */
export const workflow = <
  Tools extends Record<string, Tool.Any>,
  R,
  const Dependencies extends ReadonlyArray<AnyRunContext> = readonly [],
  ROut = never,
  E = never,
  RIn = never,
>(
  agent: Agent.Agent<Tools, R>,
  options: WorkflowOptions<Dependencies, ROut, E, RIn>,
) => {
  const dependencies: ReadonlyArray<AnyRunContext> = options.dependencies ?? [];
  const fields =
    dependencies.length === 0
      ? { input: AgUi.RunAgentInput }
      : {
          input: AgUi.RunAgentInput,
          context: Schema.Struct(Object.fromEntries(dependencies.map((tag) => [tag.key, tag.schema]))),
        };
  const run = Workflow.make(options.name, {
    // Built from `dependencies` exactly as the type describes; TypeScript can't follow the mapping.
    payload: fields as unknown as WorkflowPayloadFields<Dependencies>,
    // JSON, so no choice of ids can make two keys collide.
    idempotencyKey: (payload) => {
      const { input } = payload as PayloadParts;
      return JSON.stringify([input.threadId, input.runId]);
    },
  });
  // What a payload holds for `input`, with the dependencies' values when there are any.
  const payloadOf = (input: AgUi.RunAgentInput, perRun: Context.Context<DependencyServices<Dependencies>>) => {
    const parts: PayloadParts =
      dependencies.length === 0
        ? { input }
        : {
            input,
            context: Object.fromEntries(dependencies.map((tag) => [tag.key, Context.get(perRun, tag)])),
          };
    // The payload's type depends on `Dependencies`; its shape is the one `fields` declares.
    return parts as unknown as typeof run.payloadSchema.Type;
  };
  const body = detached(agent, options);
  const layer: Layer.Layer<
    never,
    never,
    | Exclude<Requirements<Tools, R, Dependencies, ROut, RIn>, Checkpoint.Checkpoint>
    | EventLog.EventLog
    | WorkflowEngine.WorkflowEngine
  > = run.toLayer((payload) => {
    const { input, context } = payload as PayloadParts;
    let perRun = Context.empty() as Context.Context<any>;
    for (const tag of dependencies) {
      perRun = Context.add(perRun, tag, context?.[tag.key]);
    }
    return body(input).pipe(
      Effect.orDie,
      // One service per dependency was added above, which TypeScript can't follow through the loop.
      Effect.provideContext(perRun as Context.Context<DependencyServices<Dependencies>>),
      Effect.provide(Checkpoint.layerWorkflow),
    );
  });
  return {
    workflow: run,
    layer,
    start: (
      input: AgUi.RunAgentInput,
    ): Effect.Effect<void, never, DependencyServices<Dependencies> | WorkflowEngine.WorkflowEngine> =>
      Effect.flatMap(Effect.context<DependencyServices<Dependencies>>(), (perRun) =>
        Effect.asVoid(run.execute(payloadOf(input, perRun), { discard: true })),
      ),
    // The engine derives the id from the encoded payload, so it needs the dependencies too.
    executionId: (input: AgUi.RunAgentInput): Effect.Effect<string, never, DependencyServices<Dependencies>> =>
      Effect.flatMap(Effect.context<DependencyServices<Dependencies>>(), (perRun) =>
        run.executionId(payloadOf(input, perRun)),
      ),
  };
};
