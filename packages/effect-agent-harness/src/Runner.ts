import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream,
  Tracer,
} from "effect";
import { AgUiSchema, AgUiServer, Prompt } from "effect/ai";
import { HttpApiError } from "effect/http-api";
import type { Tool } from "effect/ai";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import * as Agent from "./Agent.ts";
import * as Checkpoint from "./Checkpoint.ts";
import * as EventLog from "./EventLog.ts";
import * as History from "./History.ts";
import * as Events from "./internal/events.ts";
import * as internal from "./internal/history.ts";
import { OnRunFailed, OnStepFinished, reportFailure } from "./internal/hooks.ts";
import { closeOpen, conflateActivity, publish } from "./internal/publish.ts";
import { conflictingTool } from "./internal/tools.ts";
import * as internalTelemetry from "./internal/telemetry.ts";
import * as Messages from "./Messages.ts";
import * as Telemetry from "./Telemetry.ts";

const { Attr } = internalTelemetry;

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
 * Declares a per-run dependency a {@link makeWorkflow} can persist, such as the
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
 * is enough there; a run context works too. A request-scoped {@link makeAttached}
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

/** Options of every runner. {@link makeAttached} takes exactly these. */
export interface Options<ROut = never, E = never, RIn = never> {
  /**
   * What to do with `system` and `developer` messages sent by the client.
   * `"drop"` (the default) ignores them, so only the server's system prompt
   * instructs the model; `"allow"` turns them into system entries.
   */
  readonly clientSystem?: "allow" | "drop" | undefined;
  /**
   * Builds per-run services, such as the current user, typically from a
   * service the caller provides per run, like the verified principal. It is
   * built for every run attempt, before the input check and the claim, and
   * lives until the attempt ends. It is not memoised: a run executed again
   * builds it again. A failure to build it ends the run with `RUN_ERROR`.
   *
   * With {@link makeAttached} you can instead provide the layer on the run's stream
   * (`Stream.provide`), but then a failure to build it fails the stream
   * instead of ending the run with `RUN_ERROR`. A detached run needs `layer`,
   * so its services live as long as the run rather than the call to `start`,
   * and so does a {@link makeWorkflow}, which rebuilds its services from the
   * persisted dependencies on every replay.
   */
  readonly layer?: Layer.Layer<ROut, E, RIn>;
}

/** How long a cancelled request-scoped run is given to end by default. */
const DEFAULT_CANCEL_TIMEOUT: Duration.Input = "30 seconds";

/** Options of {@link makeAttached}. */
export interface AttachedOptions<ROut = never, E = never, RIn = never> extends Options<ROut, E, RIn> {
  /**
   * How long a run whose consumer stopped early is given to end as cancelled
   * (default 30 seconds): to finish an uninterruptible handler region, commit
   * its partial step, report and release. A run still going then is
   * interrupted, its claim is released without a run-ended notification, and
   * its partial step may not be committed.
   */
  readonly cancelTimeout?: Duration.Input | undefined;
}

/**
 * Options of the runners that capture their services when they're built
 * ({@link makeDetached}, {@link makeWorkflow}), which therefore name the services
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
   * (`Effect.provideService`). Any service key, except for a {@link makeWorkflow},
   * which takes {@link RunContext}s.
   */
  readonly dependencies?: Dependencies;
}

/**
 * What a runner needs from outside: the agent's requirements, less the per-run
 * services and the per-run dependencies, plus what the per-run layer needs,
 * less the per-run dependencies. The checkpoint store is always required from
 * outside, because the run uses it before its per-run services exist. No
 * thread store: the run's {@link History.History} is optional, and
 * `History.layerServer` brings its own. A detached or workflow runner captures
 * this when it's built; {@link makeAttached} has no dependencies and leaves it on each
 * stream.
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

const InputJson = Schema.toCodecJson(AgUiSchema.RunAgentInput);

/** What names a run to cancel: a cancel route has only the ids, not the input. */
export interface RunIds {
  readonly threadId: string;
  readonly runId: string;
}

/** A run's key. JSON, so no choice of ids can make two keys collide. */
const runKey = (run: RunIds): string => JSON.stringify([run.threadId, run.runId]);

/**
 * Ends the stream with `RUN_ERROR` instead of failing it, reporting the cause to `OnRunFailed` as the agent's run
 * reports its own. Interruption passes through.
 */
const failInBand = <R>(
  stream: Stream.Stream<AgUiSchema.Event, unknown, R>,
): Stream.Stream<AgUiSchema.Event, never, R> =>
  Stream.catchCause(stream, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) {
      // An interrupt-only cause has no failures, so its error type is irrelevant.
      return Stream.failCause(cause as Cause.Cause<never>);
    }
    return Stream.fromEffect(Effect.as(reportFailure(cause), internal.failed(cause)));
  });

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

/** The run's history: the one in its context, or the client history. */
const currentHistory: Effect.Effect<internal.Service> = Effect.map(
  Effect.serviceOption(History.History),
  // Every `History` value is one of the internal implementations; the public type only hides their members.
  Option.match({ onNone: () => internal.client, onSome: (service) => service as internal.Service }),
);

/**
 * One AG-UI run:
 *
 * 1. build the per-run layer from the dependencies the run was provided, for
 *    this attempt only;
 * 2. check that the input is the one the run id was first used with
 *    (memoised as the `input` checkpoint; the dependencies are not part of
 *    it);
 * 3. open the run's {@link History.History} (the client history if its
 *    context has none), which decides the entries the run starts from: the
 *    client's messages as sent, or, under `History.layerServer`, the claimed
 *    and loaded thread plus what the client may add to it;
 * 4. project those entries, memoised as the `prompt` checkpoint so a resumed
 *    run uses the projection the crashed attempt used;
 * 5. run the agent on the input and the per-run services, which hands each
 *    step's entries to the history as it finishes, before the step's
 *    `STEP_FINISHED`;
 * 6. hand the terminal event to the history, however the run ended, before
 *    it is emitted (the server history reports the end and releases the
 *    thread there, so the client's next run finds it free);
 * 7. publish the events: replayed work an earlier attempt already published
 *    is dropped, and the library's markers are removed.
 *
 * Every checkpoint is scoped by the thread id as well as the run id, so a run
 * id the client reuses on another thread replays nothing.
 *
 * Failures, including those before the model is called (the per-run layer's
 * errors, `RunInputMismatch`, and the server history's `ThreadError`,
 * `ThreadBusy`, `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt`,
 * `UnansweredToolCall`), end the stream with `RUN_ERROR`, so it never fails.
 * An interrupted run (e.g. a cancelled request) is not handed to the history
 * as ended: under the server history it keeps its claim, and running it again
 * finishes it. A cancelled run (`how.cancelled`) ends like any other.
 */
const agUiRun =
  <Tools extends Record<string, Tool.Any>, R, Dependencies extends ReadonlyArray<AnyService>, ROut, E, RIn>(
    agent: Agent.Agent<Tools, R>,
    options?: Options<ROut, E, RIn>,
  ) =>
  (
    input: AgUiSchema.RunAgentInput,
    how?: {
      /** The log of an earlier attempt this one completes. */
      readonly resumed?: ReadonlyArray<AgUiSchema.Event> | undefined;
      /** The run's cancel signal (`Agent.RunInput.cancelled`). */
      readonly cancelled?: Effect.Effect<void> | undefined;
    },
  ): Stream.Stream<
    AgUiSchema.Event,
    never,
    Requirements<Tools, R, Dependencies, ROut, RIn> | DependencyServices<Dependencies>
  > => {
    const { threadId, runId } = input;
    // Runs once the history has opened the run.
    const opened = (attempt: internal.Attempt, checkpoint: Checkpoint.Checkpoint["Service"]) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const prompt = yield* checkpoint.memo(
            { threadId, runId, name: "prompt", success: Prompt.Prompt, error: Schema.Never },
            Effect.sync(() => Messages.project([...attempt.stored, ...attempt.added])),
          );
          // Memoised like the prompt, so a resumed subagent sees the same history on every attempt.
          const subagentPrompts = yield* checkpoint.memo(
            {
              threadId,
              runId,
              name: "subagent-prompts",
              success: Schema.Record(Schema.String, Prompt.Prompt),
              error: Schema.Never,
            },
            Effect.sync(() => Messages.projectSuspended([...attempt.stored, ...attempt.added])),
          );

          return Agent.run(agent, {
            input,
            prompt: prompt.value,
            subagentPrompts: subagentPrompts.value,
            cancelled: how?.cancelled,
          }).pipe(
            // The attempt's own `RUN_STARTED` goes out first, before anything that can fail.
            Stream.filter((event) => event.type !== "RUN_STARTED"),
            // The run commits each step itself, before the step's `STEP_FINISHED`.
            Stream.provideService(OnStepFinished, attempt.commit),
            // The run's events queue up here while a slow consumer (an event log append) holds the pipeline, so
            // this is where superseded progress is dropped.
            conflateActivity,
          );
        }),
      ).pipe(
        failInBand,
        // After the catch, so a run that failed anywhere above is reported too.
        Stream.mapEffect((event): Effect.Effect<AgUiSchema.Event> =>
          Events.isTerminal(event) ? attempt.end(event) : Effect.succeed(event),
        ),
      );

    // The per-run layer's scope is this stream's: it closes when the attempt ends.
    const events = Stream.unwrap(
      Effect.gen(function* () {
        // Refused before anything is stored, so the client can retry the same run id with its tools renamed.
        const conflict = conflictingTool(agent, input.tools);
        if (conflict !== undefined) {
          return yield* new Agent.FrontendToolConflict({ toolName: conflict });
        }
        const services = yield* resolveServices(options);
        const checkpoint = yield* Checkpoint.Checkpoint;
        const fingerprint = JSON.stringify(yield* Effect.orDie(Schema.encodeEffect(InputJson)(input)));
        const first = yield* checkpoint.memo(
          { threadId, runId, name: "input", success: Schema.String, error: Schema.Never },
          Effect.succeed(fingerprint),
        );

        if (first.value !== fingerprint) {
          return yield* new RunInputMismatch();
        }

        // Span attributes the per-run layer provides win over the caller's.
        const layerSpanAttributes = Context.getOption(services as Context.Context<never>, Telemetry.SpanAttributes);
        if (Option.isSome(layerSpanAttributes)) {
          yield* Effect.annotateCurrentSpan(internalTelemetry.callerAttributes(layerSpanAttributes.value));
        }

        const history = yield* currentHistory;
        const attempt = yield* history.beginAttempt(input, { clientSystem: options?.clientSystem });
        return opened(attempt, checkpoint).pipe(Stream.provideContext(services));
      }),
    ).pipe(failInBand);
    return traced(agent, input, (onFailed) =>
      publish(how?.resumed)(Stream.prepend(Stream.tap(events, onFailed), [Events.runStarted(input)])),
    );
  };

/**
 * Runs an attempt under its root span: `invoke_agent {name}`, in a new trace
 * linked to the caller's span, so a backend sees the run as its own GenAI
 * trace. The event stream never fails, so the span's outcome is set from the
 * `RUN_ERROR` event (`error.type` from its code) and the cause reported to
 * `OnRunFailed` (the exit the span ends with), rather than from the stream's
 * exit. The exporter records that cause as the span's one `exception` event.
 */
const traced = <R>(
  agent: Agent.Agent<any, any>,
  input: AgUiSchema.RunAgentInput,
  run: (onFailed: (event: AgUiSchema.Event) => Effect.Effect<void>) => Stream.Stream<AgUiSchema.Event, never, R>,
): Stream.Stream<AgUiSchema.Event, never, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const caller = yield* Effect.option(Effect.currentParentSpan);
      const span = yield* Effect.makeSpan(internalTelemetry.agentSpanName(agent.name), {
        kind: "internal",
        root: true,
        links: Option.isSome(caller) ? [{ span: caller.value, attributes: {} }] : [],
        attributes: {
          // The caller's attributes. The per-run layer isn't built yet, so its attributes are added
          // once it is (`layerSpanAttributes` above). Set here too so a run that fails first keeps them.
          ...internalTelemetry.callerAttributes(yield* Telemetry.SpanAttributes),
          [Attr.operationName]: "invoke_agent",
          ...(agent.name === undefined ? {} : { [Attr.agentName]: agent.name }),
          ...(agent.description === undefined ? {} : { [Attr.agentDescription]: agent.description }),
          [Attr.conversationId]: input.threadId,
          [Attr.runId]: input.runId,
        },
      });
      let failed: AgUiSchema.RunErrorEvent | undefined;
      let failure: Cause.Cause<unknown> | undefined;
      const onFailed = (event: AgUiSchema.Event) =>
        Effect.sync(() => {
          if (event.type === "RUN_ERROR") {
            failed = event;
          }
        });

      return run(onFailed).pipe(
        // Every failure that ends the run in `RUN_ERROR` is reported here first, with its original cause.
        Stream.provideService(OnRunFailed, (cause) =>
          Effect.andThen(
            Effect.sync(() => {
              failure = cause;
            }),
            Effect.logError("effect-agent-harness: the run failed", cause),
          ),
        ),
        Stream.provideService(Tracer.ParentSpan, span),
        Stream.onExit((exit) =>
          Effect.map(Clock.currentTimeNanos, (now) => {
            if (failed !== undefined && failure !== undefined && Exit.isSuccess(exit)) {
              span.attribute(Attr.errorType, failed.code ?? "Error");
              span.end(now, Exit.failCause(failure));
            } else {
              span.end(now, exit);
            }
          }),
        ),
      );
    }),
  );

/**
 * A runner whose runs are attached to their consumer. It gives a function from
 * an AG-UI `RunAgentInput` to the run's event stream, and the run is scoped to
 * that stream: when the consumer stops reading (a client disconnects,
 * `abortRun()`), the run is cancelled, including any model request or tool call
 * in progress.
 *
 * Nothing is captured: the function is plain, and each stream requires the
 * agent's services (a per-run service such as the verified principal among
 * them), the checkpoint store, and whatever the per-run `layer` needs. The
 * run's history is read from the stream's context too: provide
 * `History.layerServer` (with its `Thread`) to the stream, or around the
 * handler, for the server history, or nothing for the client history. That
 * can differ per request. Over HTTP, serve it with `effect/ai`'s
 * `AgUiServer.endpoint` and `AgUiServer.handler((input) => run(input))`: the
 * handler provides its context to the stream, including what middleware such
 * as authentication provides, so the stream needs nothing more once the
 * handler has returned. The rest is a requirement of the handler: keep those
 * services in the app layer's output (`Layer.provideMerge`), which the web
 * handler provides to every request. On another transport, close over the
 * handler's context yourself (`Stream.provideContext(yield* Effect.context())`).
 */
export const makeAttached = <Tools extends Record<string, Tool.Any>, R, ROut = never, E = never, RIn = never>(
  agent: Agent.Agent<Tools, R>,
  options?: AttachedOptions<ROut, E, RIn>,
) => {
  const cancelTimeout = options?.cancelTimeout ?? DEFAULT_CANCEL_TIMEOUT;
  const runWith = agUiRun<Tools, R, readonly [], ROut, E, RIn>(agent, options);
  return (
    input: AgUiSchema.RunAgentInput,
  ): Stream.Stream<AgUiSchema.Event, never, Requirements<Tools, R, readonly [], ROut, RIn>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // The run is forked and read through a queue, so a consumer that stops early cancels it instead of
        // interrupting it: the run then ends as cancelled (committing its partial step, and reporting and
        // releasing under the server history) before the stream finishes closing. Its remaining events are
        // discarded. Unbounded, so a run with no reader never blocks. Detached rather than in the stream's
        // scope, whose own finalizer would wait for the fiber however long it took: the finalizer below
        // owns its lifetime.
        const cancel = yield* Deferred.make<void>();
        const queue = yield* Queue.unbounded<AgUiSchema.Event, Cause.Done>();
        // A run that doesn't end in time (a hung store, a long uninterruptible handler) is interrupted
        // without waiting for it, and the history releases what it holds without reporting an end, so a
        // disconnect can't hold the request, or a shutdown, for longer than `cancelTimeout`. An
        // uninterruptible region still running then finishes on its own; the run commits nothing after it.
        // `acquireRelease`, so the fork and its finalizer can't be separated by an interruption.
        yield* Effect.acquireRelease(
          runWith(input, { cancelled: Deferred.await(cancel) }).pipe(Stream.runIntoQueue(queue), Effect.forkDetach),
          (fiber) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(cancel, undefined);
              const ended = yield* Effect.timeoutOption(Fiber.await(fiber), cancelTimeout);
              if (Option.isNone(ended)) {
                yield* Effect.logWarning(
                  "effect-agent-harness: a cancelled run did not end in time and was interrupted",
                  input.runId,
                );
                yield* Effect.forkDetach(Fiber.interrupt(fiber));
                yield* Effect.flatMap(currentHistory, (history) => history.abandonAttempt(input));
              }
            }),
        );
        // The run drains into the queue at once, so a slow consumer's backlog is here.
        return conflateActivity(Stream.fromQueue(queue));
      }),
    );
};

/**
 * Adapts an agent to `effect/ai`'s `AgUiServer.Agent`, so it can be served
 * wherever `effect/ai`'s own `AgUiServer.agent(...)` is:
 * `AgUiServer.layerHttp({ path, agent })` or `AgUiServer.agentHandler(agent)`.
 *
 * Not a runner of its own: every run is a {@link makeAttached} run with these
 * `options`, cancelled when its client disconnects. What it adds is the check
 * `effect/ai`'s agent makes before the event stream opens: an input whose
 * frontend tools reuse the name of one of the agent's tools or subagents is
 * rejected with `HttpApiError.BadRequest`, which the endpoint answers with
 * status 400 (a run started any other way ends with `RUN_ERROR` code
 * `FrontendToolConflict` instead).
 *
 * `AgUiServer.agentHandler` captures its services once, when the route is
 * built, so a run served this way sees only those, never what middleware
 * provides per request, such as an authenticated principal. For per-request
 * services, serve {@link makeAttached} through `AgUiServer.endpoint` and
 * `AgUiServer.handler((input) => run(input))`.
 */
export const toAgUiServerAgent = <Tools extends Record<string, Tool.Any>, R, ROut = never, E = never, RIn = never>(
  agent: Agent.Agent<Tools, R>,
  options?: AttachedOptions<ROut, E, RIn>,
): AgUiServer.Agent<Requirements<Tools, R, readonly [], ROut, RIn>> => {
  const run = makeAttached(agent, options);
  return {
    run: (input) =>
      conflictingTool(agent, input.tools) !== undefined
        ? Effect.fail(new HttpApiError.BadRequest({}))
        : Effect.succeed(run(input)),
  };
};

/**
 * Runs {@link agUiRun} into the event log. If the log already holds an earlier
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
    input: AgUiSchema.RunAgentInput,
    // The run's cancel signal.
    cancelled: Effect.Effect<void>,
  ): Effect.Effect<
    void,
    EventLog.EventLogError,
    Requirements<Tools, R, Dependencies, ROut, RIn> | DependencyServices<Dependencies> | EventLog.EventLog
  > => {
    const runWith = agUiRun<Tools, R, Dependencies, ROut, E, RIn>(agent, options);
    return Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const append = (event: AgUiSchema.Event) => log.append(input.threadId, input.runId, event);
      // Without a cursor, the read cannot fail with `InvalidCursor`.
      const history = (yield* log
        .read(input.threadId, input.runId)
        .pipe(Effect.catchTag("InvalidCursor", Effect.die))).map((stored) => stored.event);
      const last = history.at(-1);
      if (last !== undefined && Events.isTerminal(last)) {
        return;
      }
      yield* Effect.forEach(closeOpen(history), append, { discard: true });
      const events =
        history.length === 0
          ? runWith(input, { cancelled })
          : Stream.drop(runWith(input, { resumed: history, cancelled }), 1);
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
 * `Checkpoint` (e.g. `Checkpoint.layerKeyValueStore`) completed steps are replayed
 * rather than executed again. Do not start the same run twice concurrently:
 * supervising runs is the caller's concern here, or use {@link makeWorkflow}.
 *
 * The run's {@link History.History} is the one in the context the runner was
 * built in, unless one is provided around `start`, which wins: the context
 * `start` is called in is merged over the captured one.
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
  {
    readonly start: (input: AgUiSchema.RunAgentInput) => Effect.Effect<void, never, DependencyServices<Dependencies>>;
    readonly cancel: (run: RunIds) => Effect.Effect<void>;
  },
  never,
  Requirements<Tools, R, Dependencies, ROut, RIn> | EventLog.EventLog | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Requirements<Tools, R, Dependencies, ROut, RIn> | EventLog.EventLog>();
    const scope = yield* Scope.Scope;
    const log = yield* EventLog.EventLog;
    const body = detached(agent, options);
    // The cancel signal of each run this runner started that has not ended: one in progress, or one whose
    // attempt was interrupted (a crash), which the next `start` reuses. Only `start` adds entries, so the ids
    // a caller passes to `cancel` can never grow it.
    const signals = new Map<string, Deferred.Deferred<void>>();
    return {
      start: (input) =>
        Effect.gen(function* () {
          const key = runKey(input);
          // Registered before anything is read, so a cancel that arrives while `start` reads the log still
          // reaches the run. A cancel made while an earlier attempt was down has fired it already.
          const earlier = signals.get(key);
          const own = earlier ?? Deferred.makeUnsafe<void>();
          signals.set(key, own);
          const forget = Effect.sync(() => {
            if (signals.get(key) === own) {
              signals.delete(key);
            }
          });
          // A `start` that fails before forking drops only the entry it created: an earlier crashed
          // attempt's entry may hold a cancel for the next start.
          const last = yield* Effect.orDie(log.read(input.threadId, input.runId)).pipe(
            Effect.map((stored) => stored.at(-1)),
            Effect.onError(() => (earlier === undefined ? forget : Effect.void)),
          );
          if (last !== undefined && Events.isTerminal(last.event)) {
            return yield* forget;
          }
          // Read now, so the forked run has the dependencies its caller provided.
          const perRun = yield* Effect.context<DependencyServices<Dependencies>>();
          yield* body(input, Deferred.await(own)).pipe(
            // An attempt that was interrupted keeps its signal, so a restart sees a cancel made in between.
            // One that ended otherwise (its terminal event, or a failure) drops it.
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : forget,
            ),
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("effect-agent-harness: detached run failed", cause),
            ),
            Effect.provideContext(Context.merge(context, perRun)),
            Effect.forkIn(scope),
          );
        }),
      // Does nothing for a run this runner has not started, or that has ended.
      cancel: (run) =>
        Effect.suspend(() => {
          const signal = signals.get(runKey(run));
          return signal === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(signal, undefined));
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
  /**
   * How often a running execution checks the engine for a cancel made through
   * another runner value, such as on another host (default 1 second). A cancel
   * made through the runner value executing the run reaches it at once.
   */
  readonly cancelPollInterval?: Duration.Input | undefined;
}

/** How often a running workflow execution checks the engine for a cancel by default. */
const DEFAULT_CANCEL_POLL_INTERVAL: Duration.Input = "1 second";

/**
 * The fields of what {@link makeWorkflow} persists per run: the AG-UI input and,
 * when the runner has dependencies, their values keyed by each run context's
 * key, encoded with their schemas.
 */
export type WorkflowPayloadFields<Dependencies extends ReadonlyArray<AnyRunContext>> = Dependencies extends readonly []
  ? { readonly input: typeof AgUiSchema.RunAgentInput }
  : {
      readonly input: typeof AgUiSchema.RunAgentInput;
      readonly context: Schema.Struct<{ readonly [C in Dependencies[number] as C["key"]]: C["schema"] }>;
    };

/** A workflow payload, read through the shape every payload has. */
interface PayloadParts {
  readonly input: AgUiSchema.RunAgentInput;
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
 *
 * The run's {@link History.History} is the one in the context `layer` is built
 * in (provide `History.layerServer` to it for the server history). A replayed
 * execution has only its persisted payload, which can't hold a service, so the
 * history can't vary per run: register a second workflow for the other one.
 */
export const makeWorkflow = <
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
      ? { input: AgUiSchema.RunAgentInput }
      : {
          input: AgUiSchema.RunAgentInput,
          context: Schema.Struct(Object.fromEntries(dependencies.map((tag) => [tag.key, tag.schema]))),
        };
  // Built only from the ids, so `cancel` can derive the execution id without the dependencies.
  const idempotencyKey = (payload: unknown) => runKey((payload as PayloadParts).input);
  const run = Workflow.make(options.name, {
    // Built from `dependencies` exactly as the type describes; TypeScript can't follow the mapping.
    payload: fields as unknown as WorkflowPayloadFields<Dependencies>,
    idempotencyKey,
  });
  // Never registered or executed: only its execution ids are used. Same name and idempotency key as `run`, so
  // the same ids, but a payload that needs no dependency values (`run.executionId` validates them all).
  const ids = Workflow.make(options.name, { payload: { input: AgUiSchema.RunAgentInput }, idempotencyKey });
  // Completed by `cancel`; held by the engine, so it reaches the run on any host, before it starts or while it
  // is down. The run never awaits it durably: completing a deferred a run awaits makes the engine interrupt and
  // replay the run, and an interrupted step is lost as a crash's is, instead of ending cancelled with its partial
  // turn.
  const cancelRequest = DurableDeferred.make(`${options.name}/cancel`);
  const pollInterval = options.cancelPollInterval ?? DEFAULT_CANCEL_POLL_INTERVAL;
  // The signals of the runs this runner value is executing, so its own `cancel` reaches them without a poll.
  const executing = new Map<string, Deferred.Deferred<void>>();
  // What a payload holds for `input`, with the dependencies' values when there are any.
  const payloadOf = (input: AgUiSchema.RunAgentInput, perRun: Context.Context<DependencyServices<Dependencies>>) => {
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
    const execute = (cancelled: Effect.Effect<void>) =>
      body(input, cancelled).pipe(
        Effect.orDie,
        // One service per dependency was added above, which TypeScript can't follow through the loop.
        Effect.provideContext(perRun as Context.Context<DependencyServices<Dependencies>>),
        Effect.provide(Checkpoint.layerWorkflow),
      );
    return Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      // Read without waiting: a cancel made before this attempt (before start, or while the run was down).
      if (Option.isSome(yield* engine.deferredResult(cancelRequest))) {
        return yield* execute(Effect.void);
      }
      const key = runKey(input);
      const signal = yield* Deferred.make<void>();
      executing.set(key, signal);
      // A cancel made through another runner value: the engine has it, and only a read finds it.
      const polled = engine
        .deferredResult(cancelRequest)
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced(pollInterval), until: Option.isSome }),
          Effect.andThen(Deferred.succeed(signal, undefined)),
          Effect.andThen(Effect.never),
        );
      return yield* Effect.race(execute(Deferred.await(signal)), polled).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (executing.get(key) === signal) {
              executing.delete(key);
            }
          }),
        ),
      );
    });
  });
  return {
    workflow: run,
    layer,
    start: (
      input: AgUiSchema.RunAgentInput,
    ): Effect.Effect<void, never, DependencyServices<Dependencies> | WorkflowEngine.WorkflowEngine> =>
      Effect.flatMap(Effect.context<DependencyServices<Dependencies>>(), (perRun) =>
        Effect.asVoid(run.execute(payloadOf(input, perRun), { discard: true })),
      ),
    // The engine derives the id from the encoded payload, so it needs the dependencies too.
    executionId: (input: AgUiSchema.RunAgentInput): Effect.Effect<string, never, DependencyServices<Dependencies>> =>
      Effect.flatMap(Effect.context<DependencyServices<Dependencies>>(), (perRun) =>
        run.executionId(payloadOf(input, perRun)),
      ),
    cancel: ({ threadId, runId }: RunIds): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> =>
      Effect.flatMap(
        ids.executionId({ input: { threadId, runId, messages: [], tools: [], context: [] } }),
        (executionId) =>
          DurableDeferred.succeed(cancelRequest, {
            token: DurableDeferred.tokenFromExecutionId(cancelRequest, { workflow: run, executionId }),
            value: undefined,
          }).pipe(
            // Recorded first, so an attempt that starts or replays from here on sees it; then the run this runner
            // value is executing, if any, at once.
            Effect.andThen(
              Effect.suspend(() => {
                const signal = executing.get(runKey({ threadId, runId }));
                return signal === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(signal, undefined));
              }),
            ),
          ),
      ),
  };
};
