import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Prompt } from "effect/ai";
import type { Response } from "effect/ai";
import { WorkflowEngine } from "effect/workflow";
import * as Agent from "../src/Agent.ts";
import * as AgUi from "../src/AgUi.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as EventLog from "../src/EventLog.ts";
import * as History from "../src/History.ts";
import type * as Messages from "../src/Messages.ts";
import * as Runner from "../src/Runner.ts";
import * as Thread from "../src/Thread.ts";
import {
  counterIds,
  evalLayers,
  finish,
  PickFile,
  reasoning,
  recordingTracer,
  scriptedModel,
  serverStores,
  type Step,
  text,
  toolCall,
  verify,
  WeatherToolkit,
} from "./fixtures.ts";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const weatherAgent = Agent.define({ toolkit: WeatherToolkit });

const researcher = Agent.define({ name: "researcher", description: "Looks things up", toolkit: WeatherToolkit });
const parent = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [researcher] } });

const userPrompt = Prompt.make([{ role: "user", content: "What is the weather in Paris?" }]);

/** A model step that streams `parts` and then never ends, as a model still generating does. */
const stalled = (parts: ReadonlyArray<Response.StreamPartEncoded>): Step =>
  Stream.concat(Stream.fromIterable(parts), Stream.never);

/** Text that has started streaming and not ended. */
const partialText = (id: string, delta: string): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id },
  { type: "text-delta", id, delta },
];

/**
 * The weather handlers, where "Slow" waits forever once started (recording an interruption), and
 * "Send" runs its side effect uninterruptibly until `release` completes.
 */
const blockingWeather = (gates: {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}) => {
  const calls: Array<string> = [];
  const interrupted: Array<string> = [];
  const sent: Array<string> = [];
  const layer = WeatherToolkit.toLayer({
    "get-weather": ({ location }) =>
      Effect.suspend(() => {
        calls.push(location);
        if (location === "Slow") {
          return Deferred.succeed(gates.started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.push(location))),
          );
        }
        if (location === "Send") {
          return Effect.uninterruptible(
            Deferred.succeed(gates.started, undefined).pipe(
              Effect.andThen(Deferred.await(gates.release)),
              Effect.andThen(Effect.sync(() => sent.push(location))),
              Effect.as({ temperature: 18 }),
            ),
          );
        }
        return Effect.succeed({ temperature: 18 });
      }),
  });
  return { layer, calls, interrupted, sent };
};

/**
 * Runs `agent` with a cancel signal that fires on the first event `when` accepts, or once `trigger`
 * completes. Returns the events, the prompts the model received, and the handlers' records.
 */
const runCancelled = (
  agent: Agent.Any,
  steps: ReadonlyArray<Step>,
  options: {
    readonly when?: (event: Agent.Event) => boolean;
    /** Runs alongside the run, given the handlers' gates and a way to fire the signal. */
    readonly trigger?: (
      gates: { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> },
      fire: Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly input?: Partial<Agent.RunInput>;
    readonly checkpoint?: Layer.Layer<Checkpoint.Checkpoint>;
    /** Runs on every event, before the signal check. */
    readonly tap?: (event: Agent.Event) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const cancel = yield* Deferred.make<void>();
    const gates = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    const model = scriptedModel(steps);
    const weather = blockingWeather(gates);
    // How many side effects had happened when the run ended.
    let sentAtEnd: number | undefined;
    if (options.trigger !== undefined) {
      yield* Effect.forkChild(options.trigger(gates, Effect.asVoid(Deferred.succeed(cancel, undefined))));
    }
    const events = yield* Agent.run(agent as typeof parent, {
      runId: "r1",
      threadId: "t1",
      prompt: userPrompt,
      cancelled: Deferred.await(cancel),
      ...options.input,
    }).pipe(
      Stream.tap((event) =>
        Effect.gen(function* () {
          if (event._tag === "Finished") {
            sentAtEnd = weather.sent.length;
          }
          yield* options.tap?.(event) ?? Effect.void;
          if (options.when?.(event) === true) {
            yield* Deferred.succeed(cancel, undefined);
          }
        }),
      ),
      Stream.runCollect,
      Effect.provide([
        model.layer,
        weather.layer,
        options.checkpoint === undefined ? evalLayers : Layer.mergeAll(options.checkpoint, counterIds()),
      ]),
    );
    return { events: Array.from(events), prompts: model.prompts, sentAtEnd, ...weather };
  });

/** Runs every step (no replay), completing `done` once the step `name` has completed. */
const signalling = (name: string, done: Deferred.Deferred<void>): Layer.Layer<Checkpoint.Checkpoint> =>
  Layer.succeed(Checkpoint.Checkpoint)({
    memo: (options, effect) =>
      Effect.map(
        options.name === name ? Effect.tap(effect, () => Deferred.succeed(done, undefined)) : effect,
        (value) => ({ value, replayed: false }),
      ),
  });

const tags = (events: ReadonlyArray<Agent.Event>) => events.map((event) => event._tag);

const byTag = <T extends Agent.Event["_tag"]>(events: ReadonlyArray<Agent.Event>, tag: T) =>
  events.filter((event): event is Extract<Agent.Event, { _tag: T }> => event._tag === tag);

const isPart = (type: string, delta?: string) => (event: Agent.Event) =>
  event._tag === "ModelPart" &&
  event.part.type === type &&
  (delta === undefined || ("delta" in event.part && event.part.delta === delta));

/** A step's entries as roles and their parts, for comparison. */
const shape = (entries: ReadonlyArray<Messages.Entry>) =>
  entries.map((entry) => ({
    id: entry.id,
    role: entry.message.role,
    ...(entry.subagentRunId === undefined ? {} : { subagentRunId: entry.subagentRunId }),
    parts:
      typeof entry.message.content === "string"
        ? [entry.message.content]
        : entry.message.content.map((part: Prompt.Part) =>
            part.type === "text"
              ? part.text
              : part.type === "tool-call"
                ? `call:${part.id}`
                : part.type === "tool-result"
                  ? `result:${part.id}:${part.isFailure ? "failed" : "ok"}:${JSON.stringify(part.result)}`
                  : part.type,
          ),
  }));

const cancelledResult = JSON.stringify(Agent.CANCELLED_TOOL_CALL_RESULT);

// -----------------------------------------------------------------------------
// Agent.run
// -----------------------------------------------------------------------------

describe("Agent.run cancellation", () => {
  it.effect("stops the model stream and keeps the partial text under the step's message id", () =>
    Effect.gen(function* () {
      const { events } = yield* runCancelled(weatherAgent, [stalled(partialText("0", "Hel"))], {
        when: isPart("text-delta", "Hel"),
      });
      expect(tags(events)).toEqual(["StepStarted", "ModelPart", "ModelPart", "StepFinished", "Finished"]);
      expect(byTag(events, "Finished")[0]?.outcome).toEqual({ _tag: "Cancelled" });
      const [started] = byTag(events, "StepStarted");
      const [finished] = byTag(events, "StepFinished");
      expect(finished?.step).toBe(1);
      expect(shape(finished?.entries ?? [])).toEqual([{ id: started?.messageId, role: "assistant", parts: ["Hel"] }]);
    }),
  );

  it.effect("interrupts a running tool handler and makes no further model call", () =>
    Effect.gen(function* () {
      const { events, prompts, interrupted } = yield* runCancelled(
        weatherAgent,
        [[...toolCall("c1", "get-weather", { location: "Slow" }), finish("tool-calls")]],
        { trigger: ({ started }, fire) => Effect.andThen(Deferred.await(started), fire) },
      );
      expect(interrupted).toEqual(["Slow"]);
      expect(prompts).toHaveLength(1);
      expect(byTag(events, "Finished")[0]?.outcome).toEqual({ _tag: "Cancelled" });
      expect(byTag(events, "ToolResult").map((e) => [e.toolCallId, e.isFailure, e.encodedResult])).toEqual([
        ["c1", true, Agent.CANCELLED_TOOL_CALL_RESULT],
      ]);
      expect(tags(events).slice(-3)).toEqual(["ToolResult", "StepFinished", "Finished"]);
    }),
  );

  it.effect("ends the interrupted handler's tool span as interrupted", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      yield* runCancelled(
        weatherAgent,
        [[...toolCall("c1", "get-weather", { location: "Slow" }), finish("tool-calls")]],
        {
          trigger: ({ started }, fire) => Effect.andThen(Deferred.await(started), fire),
        },
      ).pipe(Effect.provide(tracer.layer));
      const tool = tracer.one("execute_tool get-weather");
      expect(
        tool.status._tag === "Ended" &&
          Exit.isFailure(tool.status.exit) &&
          Cause.hasInterruptsOnly(tool.status.exit.cause),
      ).toBe(true);
    }),
  );

  it("drops a provider-executed call whose result never arrived from a cancelled step", () => {
    const call = (id: string) =>
      Prompt.makePart("tool-call", { id, name: "web_search", params: { query: "x" }, providerExecuted: true });
    const message = Prompt.makeMessage("assistant", {
      content: [
        Prompt.makePart("text", { text: "Searching." }),
        call("s1"),
        Prompt.makePart("tool-result", {
          id: "s1",
          name: "web_search",
          result: [],
          isFailure: false,
          providerExecuted: true,
        }),
        call("s2"),
      ],
    });
    const kept = Agent.withoutUnansweredProviderCalls(message);
    expect(kept?.content.map((part) => `${part.type}${"id" in part ? `:${part.id}` : ""}`)).toEqual([
      "text",
      "tool-call:s1",
      "tool-result:s1",
    ]);
    expect(
      Agent.withoutUnansweredProviderCalls(Prompt.makeMessage("assistant", { content: [call("s3")] })),
    ).toBeUndefined();
  });

  it.effect("keeps a completed call's real result and cancels the call still running", () =>
    Effect.gen(function* () {
      // Fires once the first call's checkpoint has completed and the second handler is running.
      const firstDone = yield* Deferred.make<void>();
      const { events } = yield* runCancelled(
        weatherAgent,
        [
          [
            ...toolCall("c1", "get-weather", { location: "Paris" }),
            ...toolCall("c2", "get-weather", { location: "Slow" }),
            finish("tool-calls"),
          ],
        ],
        {
          checkpoint: signalling("tool:c1", firstDone),
          trigger: ({ started }, fire) =>
            Deferred.await(started).pipe(
              Effect.andThen(Deferred.await(firstDone)),
              // Signalled from inside the checkpoint: let the call's fiber finish returning its value.
              Effect.andThen(Effect.all([Effect.yieldNow, Effect.yieldNow, Effect.yieldNow])),
              Effect.andThen(fire),
            ),
        },
      );
      const [step] = byTag(events, "StepFinished");
      expect(shape(step?.entries ?? [])).toEqual([
        { id: "id-1", role: "assistant", parts: ["call:c1", "call:c2"] },
        { id: "id-2", role: "tool", parts: ['result:c1:ok:{"temperature":18}'] },
        { id: "cancelled:c2", role: "tool", parts: [`result:c2:failed:${cancelledResult}`] },
      ]);
    }),
  );

  it.effect("drops a call whose arguments were still streaming", () =>
    Effect.gen(function* () {
      const { events } = yield* runCancelled(
        weatherAgent,
        [
          stalled([
            ...text("0", "Checking."),
            { type: "tool-params-start", id: "c1", name: "get-weather" },
            { type: "tool-params-delta", id: "c1", delta: '{"loc' },
          ]),
        ],
        { when: isPart("tool-params-delta") },
      );
      const [step] = byTag(events, "StepFinished");
      expect(shape(step?.entries ?? [])).toEqual([{ id: "id-1", role: "assistant", parts: ["Checking."] }]);
      expect(byTag(events, "ToolResult")).toEqual([]);
    }),
  );

  it.effect("lets an uninterruptible region finish before the run ends", () =>
    Effect.gen(function* () {
      const { events, sent, sentAtEnd } = yield* runCancelled(
        weatherAgent,
        [[...toolCall("c1", "get-weather", { location: "Send" }), finish("tool-calls")]],
        {
          trigger: ({ started, release }, fire) =>
            // The side effect finishes only after the signal has fired.
            Effect.gen(function* () {
              yield* Deferred.await(started);
              yield* fire;
              yield* Effect.yieldNow;
              yield* Deferred.succeed(release, undefined);
            }),
        },
      );
      expect(sent).toEqual(["Send"]);
      expect(sentAtEnd).toBe(1);
      // The toolkit's steps after the handler were interrupted, so the call has no real result.
      expect(byTag(events, "ToolResult").map((e) => e.encodedResult)).toEqual([Agent.CANCELLED_TOOL_CALL_RESULT]);
      expect(byTag(events, "Finished")[0]?.outcome).toEqual({ _tag: "Cancelled" });
    }),
  );

  it.effect("ends at once without calling the model when the signal has already fired", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runCancelled(weatherAgent, [[...text("0", "Hi"), finish("stop")]], {
        input: { cancelled: Effect.void },
      });
      expect(prompts).toEqual([]);
      expect(events).toEqual([{ _tag: "Finished", outcome: { _tag: "Cancelled" } }]);
    }),
  );

  it.effect("reports no pending frontend call and answers it with the cancelled result", () =>
    Effect.gen(function* () {
      const { events } = yield* runCancelled(weatherAgent, [stalled(toolCall("f1", "pick-file", { accept: "pdf" }))], {
        when: isPart("tool-call"),
        input: { frontendTools: [PickFile] },
      });
      expect(byTag(events, "Finished")[0]?.outcome).toEqual({ _tag: "Cancelled" });
      const [step] = byTag(events, "StepFinished");
      expect(shape(step?.entries ?? [])).toEqual([
        { id: "id-1", role: "assistant", parts: ["call:f1"] },
        { id: "cancelled:f1", role: "tool", parts: [`result:f1:failed:${cancelledResult}`] },
      ]);
      // The call is not marked as the client's, so no later run waits for its answer.
      const call = step?.entries[0]?.message.content[0];
      expect(
        call !== undefined && typeof call !== "string" && call.type === "tool-call" && Agent.isFrontendCall(call),
      ).toBe(false);
    }),
  );

  it.effect("cancels a running subagent with its parent", () =>
    Effect.gen(function* () {
      const { events } = yield* runCancelled(
        parent,
        [
          [...toolCall("c1", "researcher", { prompt: "Find the weather" }), finish("tool-calls")],
          stalled(partialText("0", "Look")),
        ],
        { when: (event) => event._tag === "Subagent" && isPart("text-delta", "Look")(event.event) },
      );
      const child = Agent.subagentIdFor("c1");
      const childEvents = events.flatMap((event) => (event._tag === "Subagent" ? [event.event] : []));
      expect(childEvents.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Cancelled" } });
      const top = events.filter((event) => event._tag !== "Subagent");
      expect(tags(top)).toEqual([
        "StepStarted",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "ToolResult",
        "StepFinished",
        "Finished",
      ]);
      expect(byTag(top, "Finished")[0]?.outcome).toEqual({ _tag: "Cancelled" });
      const [step] = byTag(top, "StepFinished");
      expect(shape(step?.entries ?? [])).toEqual([
        { id: "id-1", role: "assistant", parts: ["call:c1"] },
        { id: "id-2", role: "assistant", subagentRunId: child, parts: ["Look"] },
        { id: "cancelled:c1", role: "tool", parts: [`result:c1:failed:${cancelledResult}`] },
      ]);
    }),
  );

  it.effect("replays the steps an earlier attempt completed, then ends without calling the model", () =>
    Effect.gen(function* () {
      const ledger = Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger));
      const checkpoint = yield* Layer.build(ledger);
      const shared = Layer.succeedContext(checkpoint);
      const script: ReadonlyArray<Step> = [
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        stalled(partialText("0", "It is")),
      ];
      // The first attempt crashes in step 2.
      const reached = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        runCancelled(weatherAgent, script, {
          checkpoint: shared,
          tap: (event) => (isPart("text-delta", "It is")(event) ? Deferred.succeed(reached, undefined) : Effect.void),
        }),
      );
      yield* Deferred.await(reached);
      yield* Fiber.interrupt(first);
      const { events, prompts, calls } = yield* runCancelled(weatherAgent, script, {
        checkpoint: shared,
        input: { cancelled: Effect.void },
      });
      expect(prompts).toEqual([]);
      expect(calls).toEqual([]);
      expect(events.map((event) => [event._tag, "replayed" in event ? event.replayed : undefined])).toEqual([
        ["StepStarted", true],
        ["ToolResult", true],
        ["StepFinished", true],
        ["Finished", undefined],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("behaves as before without a signal", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Hi"), finish("stop")]]);
      const events = yield* Agent.run(weatherAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([
          model.layer,
          blockingWeather({ started: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() }).layer,
          evalLayers,
        ]),
      );
      expect(byTag(Array.from(events), "Finished")[0]?.outcome).toEqual({ _tag: "Success", pendingToolCalls: [] });
    }),
  );
});

// -----------------------------------------------------------------------------
// AG-UI projection
// -----------------------------------------------------------------------------

/** The AG-UI events of `Agent.run` cancelled as `runCancelled` cancels it. */
const foldCancelled = (...args: Parameters<typeof runCancelled>) =>
  Effect.gen(function* () {
    const { events } = yield* runCancelled(...args);
    const folded = Array.from(
      yield* Stream.runCollect(AgUi.fold({ threadId: "t1", runId: "r1" })(Stream.fromIterable(events))),
    );
    yield* Effect.promise(() => verify(folded));
    return folded;
  });

const types = (events: ReadonlyArray<AgUi.Event>) => events.map((event) => event.type);

describe("AgUi.fold cancellation", () => {
  it.effect("closes the open reasoning and text, ends the step, then finishes cancelled with no result", () =>
    Effect.gen(function* () {
      const events = yield* foldCancelled(
        weatherAgent,
        [stalled([...reasoning("r", ["Thinking"]).slice(0, 2), ...partialText("0", "Hel")])],
        { when: isPart("text-delta", "Hel") },
      );
      expect(types(events).slice(-5)).toEqual([
        "TEXT_MESSAGE_END",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events.at(-1)).toEqual({
        type: "RUN_FINISHED",
        threadId: "t1",
        runId: "r1",
        outcome: { type: "cancelled" },
      });
    }),
  );

  it.effect("closes a child cancelled with its parent with SUBAGENT_ERROR code Cancelled", () =>
    Effect.gen(function* () {
      const events = yield* foldCancelled(
        parent,
        [
          [...toolCall("c1", "researcher", { prompt: "Find the weather" }), finish("tool-calls")],
          stalled(partialText("0", "Look")),
        ],
        { when: (event) => event._tag === "Subagent" && isPart("text-delta", "Look")(event.event) },
      );
      const child = Agent.subagentIdFor("c1");
      expect(events.slice(-6)).toEqual([
        { type: "TEXT_MESSAGE_END", messageId: "id-2", subagentRunId: child },
        { type: "STEP_FINISHED", stepName: "step-1", subagentRunId: child },
        {
          type: "SUBAGENT_ERROR",
          subagentRunId: child,
          message: "The subagent was cancelled with its parent run",
          code: "Cancelled",
        },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "cancelled:c1",
          toolCallId: "c1",
          content: cancelledResult,
          role: "tool",
        },
        { type: "STEP_FINISHED", stepName: "step-1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: { type: "cancelled" } },
      ]);
    }),
  );
});

// -----------------------------------------------------------------------------
// Runners
// -----------------------------------------------------------------------------

const userMessage = (id: string, content: string): AgUi.Message => ({ id, role: "user", content });
const run1: AgUi.RunAgentInput = { threadId: "t1", runId: "r1", messages: [userMessage("u1", "Hi")] };

/** The run's log once it has ended. */
const logOf = (threadId: string, runId: string) =>
  Effect.flatMap(EventLog.EventLog, (log) =>
    Effect.map(Stream.runCollect(Stream.unwrap(log.subscribe(threadId, runId))), (stored) =>
      Array.from(stored, (s) => s.event),
    ),
  );

/** Waits until the run's log holds an event `when` accepts. */
const awaitLogged = (threadId: string, runId: string, when: (event: AgUi.Event) => boolean) =>
  Effect.flatMap(EventLog.EventLog, (log) =>
    Stream.unwrap(log.subscribe(threadId, runId)).pipe(
      Stream.filter((stored) => when(stored.event)),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

const isContent = (event: AgUi.Event) => event.type === "TEXT_MESSAGE_CONTENT";
const runEnded = (events: ReadonlyArray<AgUi.Event>) => events.at(-1);
const cancelledEnd = { type: "RUN_FINISHED", outcome: { type: "cancelled" } };

const ledger = Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger));

describe("Runner.makeAttached cancellation", () => {
  it.effect("matches the client's copy of a cancelled turn as known on the next run", () =>
    Effect.gen(function* () {
      const model = scriptedModel([stalled(partialText("0", "Hel")), [...text("0", "Hello!"), finish("stop")]]);
      const attached = (input: AgUi.RunAgentInput) =>
        Runner.makeAttached(weatherAgent)(input).pipe(Stream.provide(model.layer));
      const first = Array.from(yield* attached(run1).pipe(Stream.takeUntil(isContent), Stream.runCollect));
      const started = first.find((event) => event.type === "TEXT_MESSAGE_START");
      const messageId = started?.type === "TEXT_MESSAGE_START" ? started.messageId : "";
      const second = Array.from(
        yield* attached({
          threadId: "t1",
          runId: "r2",
          messages: [
            userMessage("u1", "Hi"),
            { id: messageId, role: "assistant", content: "Hel" },
            userMessage("u2", "Go on"),
          ],
        }).pipe(Stream.runCollect),
      );
      yield* Effect.promise(() => verify(second));
      expect(runEnded(second)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      expect(model.prompts[1]?.content.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      const thread = yield* Effect.flatMap(Thread.Thread, (t) => t.load("t1"));
      expect(thread.map((entry) => [entry.id, entry.runId])).toEqual([
        ["u1", "r1"],
        [messageId, "r1"],
        ["u2", "r2"],
        ["id-2", "r2"],
      ]);
    }).pipe(
      Effect.provide([
        evalLayers,
        serverStores,
        WeatherToolkit.toLayer({ "get-weather": () => Effect.succeed({ temperature: 18 }) }),
      ]),
    ),
  );

  it.effect("interrupts a cancelled run that doesn't end in time and releases the thread", () =>
    Effect.gen(function* () {
      const released: Array<string> = [];
      const hanging = Layer.effect(
        Thread.Thread,
        Effect.gen(function* () {
          const inner = yield* Thread.Thread;
          return Thread.Thread.of({
            ...inner,
            // The partial step's commit hangs, as a stuck database would.
            commit: (threadId, runId, entries) =>
              entries.some((entry) => entry.message.role === "assistant")
                ? Effect.never
                : inner.commit(threadId, runId, entries),
            release: (threadId, runId) =>
              Effect.andThen(
                Effect.sync(() => released.push(runId)),
                inner.release(threadId, runId),
              ),
          });
        }),
      ).pipe(Layer.provide(Thread.layerMemory));
      const model = scriptedModel([stalled(partialText("0", "Hel"))]);
      const consumer = yield* Effect.forkChild(
        Runner.makeAttached(weatherAgent, { cancelTimeout: "5 seconds" })(run1).pipe(
          Stream.takeUntil(isContent),
          Stream.runDrain,
          Effect.provide([
            model.layer,
            evalLayers,
            History.layerServer.pipe(Layer.provide(hanging)),
            WeatherToolkit.toLayer({ "get-weather": () => Effect.succeed({ temperature: 18 }) }),
          ]),
        ),
      );
      // The stream is held open by the cancelled run, until its time is up. Let the finalizer start waiting.
      for (let i = 0; i < 20; i++) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("4 seconds");
      expect(consumer.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(consumer);
      expect(released).toEqual(["r1"]);
    }),
  );

  it.effect("does not wait past the limit for an uninterruptible region", () =>
    Effect.gen(function* () {
      const gates = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const model = scriptedModel([[...toolCall("c1", "get-weather", { location: "Send" }), finish("tool-calls")]]);
      const consumer = yield* Effect.forkChild(
        Runner.makeAttached(weatherAgent, { cancelTimeout: "5 seconds" })(run1).pipe(
          // Stops once the handler is inside its uninterruptible region, which never finishes.
          Stream.tap((event) => (event.type === "TOOL_CALL_END" ? Deferred.await(gates.started) : Effect.void)),
          Stream.takeUntil((event) => event.type === "TOOL_CALL_END"),
          Stream.runDrain,
          Effect.provide([model.layer, evalLayers, blockingWeather(gates).layer]),
        ),
      );
      for (let i = 0; i < 20; i++) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(consumer);
      expect(yield* Effect.flatMap(Thread.Thread, (thread) => thread.activeRun("t1"))).toBeUndefined();
    }).pipe(Effect.provide(serverStores)),
  );

  it.effect("ends the root span of a cancelled run without error status", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      const model = scriptedModel([stalled(partialText("0", "Hel"))]);
      yield* Runner.makeAttached(weatherAgent)(run1).pipe(
        Stream.takeUntil(isContent),
        Stream.runDrain,
        Effect.provide([
          model.layer,
          evalLayers,
          tracer.layer,
          WeatherToolkit.toLayer({ "get-weather": () => Effect.succeed({ temperature: 18 }) }),
        ]),
      );
      const root = tracer.one("invoke_agent");
      expect(root.attributes.has("error.type")).toBe(false);
      expect(root.status._tag === "Ended" && Exit.isSuccess(root.status.exit)).toBe(true);
    }),
  );
});

describe("Runner.makeDetached cancellation", () => {
  /** A detached runner over a scripted model, built in `scope`. */
  const detachedRunner = (scope: Scope.Scope, steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const runner = yield* Runner.makeDetached(weatherAgent).pipe(
        Effect.provide([
          model.layer,
          WeatherToolkit.toLayer({ "get-weather": () => Effect.succeed({ temperature: 18 }) }),
        ]),
        Effect.provideService(Scope.Scope, scope),
      );
      return { ...runner, prompts: model.prompts };
    });

  const shared = () => Layer.mergeAll(ledger, counterIds(), serverStores, EventLog.layerMemory);

  it.effect("ends a streaming run cancelled, and its subscriber sees the end", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runner = yield* detachedRunner(scope, [stalled(partialText("0", "Hel"))]);
      yield* runner.start(run1);
      yield* awaitLogged("t1", "r1", isContent);
      const subscriber = yield* Effect.forkChild(logOf("t1", "r1"));
      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      const events = yield* Fiber.join(subscriber);
      yield* Effect.promise(() => verify(events));
      expect(types(events).slice(-3)).toEqual(["TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"]);
      expect(runEnded(events)).toMatchObject(cancelledEnd);
      // The thread is free, and the partial text is stored.
      const thread = yield* Thread.Thread;
      expect(yield* thread.activeRun("t1")).toBeUndefined();
      expect((yield* thread.load("t1")).map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("changes nothing when the run has finished, and once when cancelled twice", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runner = yield* detachedRunner(scope, [
        [...text("0", "Hi"), finish("stop")],
        stalled(partialText("0", "Hel")),
      ]);
      yield* runner.start(run1);
      const finished = yield* logOf("t1", "r1");
      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      expect(yield* logOf("t1", "r1")).toEqual(finished);

      const run2 = { ...run1, runId: "r2", messages: [...run1.messages, userMessage("u2", "More")] };
      yield* runner.start({
        ...run2,
        messages: [
          userMessage("u1", "Hi"),
          { id: "id-1", role: "assistant", content: "Hi" },
          userMessage("u2", "More"),
        ],
      });
      yield* awaitLogged("t1", "r2", isContent);
      yield* runner.cancel({ threadId: "t1", runId: "r2" });
      yield* runner.cancel({ threadId: "t1", runId: "r2" });
      const events = yield* logOf("t1", "r2");
      expect(events.filter(AgUi.isTerminal)).toHaveLength(1);
      expect(runEnded(events)).toMatchObject(cancelledEnd);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("cancels only the run on the thread named", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const gate = yield* Deferred.make<void>();
      const runner = yield* detachedRunner(scope, [
        stalled(partialText("0", "Hel")),
        Stream.concat(Stream.fromIterable(partialText("0", "Fine")), Stream.fromEffectDrain(Deferred.await(gate))).pipe(
          Stream.concat(
            Stream.make<ReadonlyArray<Response.StreamPartEncoded>>({ type: "text-end", id: "0" }, finish("stop")),
          ),
        ),
      ]);
      yield* runner.start(run1);
      yield* awaitLogged("t1", "r1", isContent);
      yield* runner.start({ ...run1, threadId: "t2" });
      yield* awaitLogged("t2", "r1", isContent);
      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      expect(runEnded(yield* logOf("t1", "r1"))).toMatchObject(cancelledEnd);
      yield* Deferred.succeed(gate, undefined);
      expect(runEnded(yield* logOf("t2", "r1"))).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
    }).pipe(Effect.provide(shared())),
  );

  it.effect("ignores a cancel for a run it has not started", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runner = yield* detachedRunner(scope, [[...text("0", "Hi"), finish("stop")]]);
      // Ids the runner has never seen: nothing is kept for them.
      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      yield* runner.start(run1);
      expect(runEnded(yield* logOf("t1", "r1"))).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      expect(runner.prompts).toHaveLength(1);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("honours a cancel that arrives while start is reading the log", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      // The runner's first read of the log (in `start`) waits until the cancel has been made.
      let reads = 0;
      const slowLog = Layer.effect(
        EventLog.EventLog,
        Effect.gen(function* () {
          const inner = yield* EventLog.EventLog;
          return EventLog.EventLog.of({
            ...inner,
            read: (threadId, runId, after) =>
              reads++ === 0
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.andThen(inner.read(threadId, runId, after)),
                  )
                : inner.read(threadId, runId, after),
          });
        }),
      ).pipe(Layer.provideMerge(EventLog.layerMemory));
      yield* Effect.gen(function* () {
        const scope = yield* Scope.make();
        const runner = yield* detachedRunner(scope, [[...text("0", "Hi"), finish("stop")]]);
        const starting = yield* Effect.forkChild(runner.start(run1));
        yield* Deferred.await(reading);
        yield* runner.cancel({ threadId: "t1", runId: "r1" });
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.join(starting);
        const events = yield* logOf("t1", "r1");
        expect(types(events)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
        expect(runEnded(events)).toMatchObject(cancelledEnd);
        expect(runner.prompts).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(ledger, counterIds(), serverStores, slowLog)));
    }),
  );

  // An attempt that stops without a terminal event, as a crash does, in a runner that lives on.
  const crashing: Step = Stream.concat(
    Stream.fromIterable(partialText("0", "Hel")),
    Stream.fromEffectDrain(Effect.interrupt),
  );

  it.effect("honours a cancel made while an attempt was down when the same runner restarts it", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runner = yield* detachedRunner(scope, [crashing, [...text("0", "Hi"), finish("stop")]]);
      yield* runner.start(run1);
      yield* awaitLogged("t1", "r1", isContent);
      // The attempt has stopped: it never wrote a terminal event.
      yield* Effect.yieldNow;
      const log = yield* EventLog.EventLog;
      expect((yield* log.read("t1", "r1")).map((s) => s.event).some(AgUi.isTerminal)).toBe(false);

      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      yield* runner.start(run1);
      const events = yield* logOf("t1", "r1");
      yield* Effect.promise(() => verify(events));
      expect(types(events).slice(-3)).toEqual(["TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"]);
      expect(runEnded(events)).toMatchObject(cancelledEnd);
      expect(runner.prompts).toHaveLength(1);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("does not carry a cancel to another runner", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const one = yield* detachedRunner(scope, []);
      const other = yield* detachedRunner(scope, [[...text("0", "Hi"), finish("stop")]]);
      yield* one.cancel({ threadId: "t1", runId: "r1" });
      yield* other.start(run1);
      expect(runEnded(yield* logOf("t1", "r1"))).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
    }).pipe(Effect.provide(shared())),
  );
});

describe("Runner.makeWorkflow cancellation", () => {
  /** A workflow runner over a scripted model and the blocking weather handlers. */
  const workflowRunner = (steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const gates = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const model = scriptedModel(steps);
      const weather = blockingWeather(gates);
      const runner = Runner.makeWorkflow(weatherAgent, { name: "weather" });
      const layer = runner.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            model.layer,
            weather.layer,
            counterIds(),
            serverStores,
            EventLog.layerMemory,
            WorkflowEngine.layerMemory,
          ),
        ),
      );
      return { runner, layer, model, prompts: model.prompts, gates, weather };
    });

  it.effect("interrupts a running tool handler and ends the log cancelled", () =>
    Effect.gen(function* () {
      const { runner, layer, gates, weather, prompts } = yield* workflowRunner([
        [...toolCall("c1", "get-weather", { location: "Slow" }), finish("tool-calls")],
      ]);
      yield* Effect.gen(function* () {
        yield* runner.start(run1);
        yield* Deferred.await(gates.started);
        yield* runner.cancel({ threadId: "t1", runId: "r1" });
        const events = yield* logOf("t1", "r1");
        yield* Effect.promise(() => verify(events));
        expect(runEnded(events)).toMatchObject(cancelledEnd);
      }).pipe(Effect.provide(layer));
      expect(weather.interrupted).toEqual(["Slow"]);
      expect(weather.calls).toEqual(["Slow"]);
      expect(prompts).toHaveLength(1);
    }),
  );

  it.effect("ends a streaming run cancelled in-band, keeping the partial text", () =>
    Effect.gen(function* () {
      const { runner, layer, prompts } = yield* workflowRunner([stalled(partialText("0", "Hel"))]);
      yield* Effect.gen(function* () {
        yield* runner.start(run1);
        yield* awaitLogged("t1", "r1", isContent);
        yield* runner.cancel({ threadId: "t1", runId: "r1" });
        const events = yield* logOf("t1", "r1");
        yield* Effect.promise(() => verify(events));
        expect(types(events).slice(-3)).toEqual(["TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"]);
        expect(runEnded(events)).toMatchObject(cancelledEnd);
        const thread = yield* Thread.Thread;
        expect(yield* thread.activeRun("t1")).toBeUndefined();
        const stored = yield* thread.load("t1");
        expect(stored.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
        expect(shape(stored.slice(1))[0]?.parts).toEqual(["Hel"]);
      }).pipe(Effect.provide(layer));
      expect(prompts).toHaveLength(1);
    }),
  );

  it.effect("reaches a running run from another host by polling the engine", () =>
    Effect.gen(function* () {
      const { runner, layer, prompts } = yield* workflowRunner([stalled(partialText("0", "Hel"))]);
      // Another runner value with the same name stands in for another host: it shares only the engine.
      const elsewhere = Runner.makeWorkflow(weatherAgent, { name: "weather" });
      yield* Effect.gen(function* () {
        yield* runner.start(run1);
        yield* awaitLogged("t1", "r1", isContent);
        yield* elsewhere.cancel({ threadId: "t1", runId: "r1" });
        yield* TestClock.adjust("1 second");
        const events = yield* logOf("t1", "r1");
        yield* Effect.promise(() => verify(events));
        expect(types(events).slice(-3)).toEqual(["TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"]);
        expect(runEnded(events)).toMatchObject(cancelledEnd);
        const stored = yield* (yield* Thread.Thread).load("t1");
        expect(shape(stored.slice(1))[0]?.parts).toEqual(["Hel"]);
      }).pipe(Effect.provide(layer));
      expect(prompts).toHaveLength(1);
    }),
  );

  it.effect("honours a cancel made before the run starts", () =>
    Effect.gen(function* () {
      const { runner, layer, prompts } = yield* workflowRunner([[...text("0", "Hi"), finish("stop")]]);
      yield* Effect.gen(function* () {
        yield* runner.cancel({ threadId: "t1", runId: "r1" });
        yield* runner.start(run1);
        const events = yield* logOf("t1", "r1");
        expect(types(events)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
        expect(runEnded(events)).toMatchObject(cancelledEnd);
      }).pipe(Effect.provide(layer));
      expect(prompts).toEqual([]);
    }),
  );

  it.effect("ends a crashed run cancelled when the cancel resumes it, without running anything again", () =>
    Effect.gen(function* () {
      const { runner, model, gates, weather, prompts } = yield* workflowRunner([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "Checking again."), ...toolCall("c2", "get-weather", { location: "Slow" }), finish("tool-calls")],
      ]);
      // The engine and stores outlive the workflow's registration, whose scope holds the execution's fiber:
      // closing it interrupts the execution mid-step 2, as a crash would.
      const services = yield* Layer.build(
        Layer.mergeAll(
          model.layer,
          weather.layer,
          counterIds(),
          serverStores,
          EventLog.layerMemory,
          WorkflowEngine.layerMemory,
        ),
      );
      const first = yield* Scope.make();
      yield* Effect.gen(function* () {
        yield* Layer.buildWithScope(runner.layer, first);
        yield* runner.start(run1);
        yield* Deferred.await(gates.started);
        yield* Scope.close(first, Exit.void);
        const log = yield* EventLog.EventLog;
        expect((yield* log.read("t1", "r1")).map((s) => s.event).some(AgUi.isTerminal)).toBe(false);

        // Registered again, as a restarted host does; the cancel resumes the execution.
        yield* Layer.buildWithScope(runner.layer, yield* Effect.scope);
        yield* runner.cancel({ threadId: "t1", runId: "r1" });
        const events = yield* logOf("t1", "r1");
        yield* Effect.promise(() => verify(events));
        expect(runEnded(events)).toMatchObject(cancelledEnd);
        expect(types(events).slice(-3)).toEqual(["STEP_FINISHED", "TOOL_CALL_RESULT", "RUN_FINISHED"]);
      }).pipe(Effect.provideContext(services));
      expect(prompts).toHaveLength(2);
      expect(weather.calls).toEqual(["Paris", "Slow"]);
    }).pipe(Effect.scoped),
  );
});
