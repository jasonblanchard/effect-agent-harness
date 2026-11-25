import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import { expectTypeOf } from "vitest";
import { AgUiServer, Prompt, Tool, Toolkit } from "effect/ai";
import type { AgUiSchema, LanguageModel } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as Events from "../src/internal/events.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import { OnStepFinished } from "../src/internal/hooks.ts";
import * as Thread from "../src/Thread.ts";
import {
  agentInput,
  agentRun,
  ApprovalToolkit,
  collect,
  counterIds,
  countingApprovalLayer,
  countingWeatherLayer,
  evalLayers,
  finish,
  ofType,
  outcomeOf,
  PickFile,
  ProgressToolkit,
  progressLayer,
  resultsOf,
  scriptedModel,
  type Step,
  terminalOf,
  text,
  toolCall,
  types,
  verify,
  WeatherToolkit,
} from "./fixtures.ts";

const weatherAgent = Agent.define({ toolkit: WeatherToolkit });

const userPrompt = Prompt.make([{ role: "user", content: "What is the weather in Paris?" }]);

const ledger = Layer.mergeAll(
  Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)),
  counterIds(),
);

/** Runs `weatherAgent` (or `agent`) on a scripted model, counting weather handler calls. */
const runCore = (
  steps: ReadonlyArray<Step>,
  options?: { readonly maxSteps?: number; readonly prompt?: Prompt.Prompt },
) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const weather = countingWeatherLayer();
    const agent =
      options?.maxSteps === undefined ? weatherAgent : Agent.define({ toolkit: WeatherToolkit, ...options });
    const collected = yield* collect(agentRun(agent, { prompt: options?.prompt ?? userPrompt })).pipe(
      Effect.provide([model.layer, weather.layer, evalLayers]),
    );
    yield* Effect.promise(() => verify(collected.events));
    return { ...collected, prompts: model.prompts, calls: weather.calls };
  });

const partTypes = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content.map((part: { type: string }) => part.type),
  );

const emailCall = toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" });

describe("Agent.define", () => {
  it("rejects a step limit that is not a positive integer", () => {
    for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
      expect(() => Agent.define({ toolkit: WeatherToolkit, maxSteps })).toThrow(RangeError);
    }
  });

  it.effect("sends identical prompts with passthrough and ledger checkpoints", () =>
    Effect.gen(function* () {
      const script = (): ReadonlyArray<Step> => [
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ];
      const runWith = (checkpoint: Layer.Layer<Checkpoint.Checkpoint>) =>
        Effect.gen(function* () {
          const model = scriptedModel(script());
          yield* agentRun(weatherAgent, { prompt: userPrompt }).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, checkpoint, counterIds()]),
          );
          return model.prompts;
        });
      const none = yield* runWith(Checkpoint.layerNone);
      const ledgerPrompts = yield* runWith(
        Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)),
      );
      expect(ledgerPrompts).toEqual(none);
    }),
  );
});

describe("Agent.run", () => {
  it.effect("emits a text-only step as AG-UI, with the run's own lifecycle", () =>
    Effect.gen(function* () {
      const { events, steps } = yield* runCore([[...text("0", "Hel", "lo"), finish("stop")]]);
      expect(events).toEqual([
        Events.runStarted({ threadId: "t1", runId: "r1" }),
        Events.stepStarted("step-1"),
        Events.textMessageStart("id-1"),
        Events.textMessageContent("id-1", "Hel"),
        Events.textMessageContent("id-1", "lo"),
        Events.textMessageEnd("id-1"),
        Events.stepFinished("step-1"),
        Events.runFinished({ threadId: "t1", runId: "r1" }, { type: "success" }),
      ]);
      expect(steps).toEqual([
        [
          {
            id: "id-1",
            message: Prompt.makeMessage("assistant", { content: [Prompt.makePart("text", { text: "Hello" })] }),
          },
        ],
      ]);
    }),
  );

  it.effect("emits text while the model is still streaming", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        Stream.fromIterable(text("0", "first").slice(0, 2)).pipe(Stream.concat(Stream.never)),
      ]);
      const events = yield* agentRun(weatherAgent, { prompt: userPrompt }).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(types(Array.from(events))).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
      ]);
    }),
  );

  it.effect("never sends approval parts to the model", () =>
    Effect.gen(function* () {
      const prompt = Prompt.make([
        { role: "user", content: "Email Ada" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "send-email", params: { to: "ada@example.com", body: "Hi" } },
            { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-approval-response", approvalId: "a1", approved: true },
            { type: "tool-result", id: "c1", name: "send-email", isFailure: false, result: { sent: true } },
          ],
        },
      ]);
      const { prompts } = yield* runCore([[...text("0", "Sent."), finish("stop")]], { prompt });
      expect(prompts[0]!.content.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(partTypes(prompts[0]!)).toEqual(["text", "tool-call", "tool-result"]);
    }),
  );

  it.effect("runs a tool call after the model stream has ended, once", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const model = scriptedModel([
        Stream.fromIterable([...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")]).pipe(
          Stream.ensuring(Effect.sync(() => log.push("model-end"))),
        ),
        [...text("0", "18°C"), finish("stop")],
      ]);
      const handlers = WeatherToolkit.toLayer({
        "get-weather": () => Effect.sync(() => (log.push("handler"), { temperature: 18 })),
      });
      const { events } = yield* collect(agentRun(weatherAgent, { prompt: userPrompt })).pipe(
        Effect.provide([model.layer, handlers, evalLayers]),
      );
      expect(log).toEqual(["model-end", "handler"]);
      expect(resultsOf(events)).toEqual([
        { toolCallId: "c1", messageId: "id-2", value: { temperature: 18 }, isFailure: false, replayed: false },
      ]);
      expect(types(events).indexOf("TOOL_CALL_RESULT")).toBeLessThan(types(events).indexOf("STEP_FINISHED"));
      expect(model.prompts[1]!.content.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    }),
  );

  it.effect("resolves two tool calls of one step", () =>
    Effect.gen(function* () {
      const { events, calls } = yield* runCore([
        [
          ...toolCall("c1", "get-weather", { location: "Paris" }),
          ...toolCall("c2", "get-weather", { location: "Rome" }),
          finish("tool-calls"),
        ],
        [...text("0", "Both 18°C"), finish("stop")],
      ]);
      expect([...calls].sort()).toEqual(["Paris", "Rome"]);
      expect(resultsOf(events).map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    }),
  );

  it.effect("returns tool failures to the model, marking the result as effect/ai does", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Nowhere" }), finish("tool-calls")],
        [...text("0", "I couldn't find that place."), finish("stop")],
      ]);
      const [result] = ofType(events, "TOOL_CALL_RESULT");
      expect(result!.metadata).toEqual({ "effect/ai": { isFailure: true } });
      expect(resultsOf(events)[0]).toMatchObject({
        isFailure: true,
        value: { message: "Location 'Nowhere' not found" },
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.content[2]).toMatchObject({ content: [{ type: "tool-result", id: "c1", isFailure: true }] });
    }),
  );

  it.effect("puts no failure marker on a successful result", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      expect(ofType(events, "TOOL_CALL_RESULT")[0]).not.toHaveProperty("metadata");
    }),
  );

  it.effect("does not run tools when the response finished incomplete", () =>
    Effect.gen(function* () {
      const { events, calls, prompts } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("length")],
      ]);
      expect(calls).toEqual([]);
      expect(prompts).toHaveLength(1);
      const [result] = resultsOf(events);
      expect(result).toMatchObject({ isFailure: true, value: { type: "execution-interrupted" } });
      expect((result!.value as { reason: string }).reason).toContain('"length"');
      expect(outcomeOf(events)).toEqual({ type: "success" });
    }),
  );

  it.effect("hands each step's assistant and tool entries to its runner", () =>
    Effect.gen(function* () {
      const { events, steps } = yield* runCore([
        [...text("0", "Let me check."), ...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      expect(steps.map((entries) => entries.map((e) => [e.id, e.message.role]))).toEqual([
        [
          ["id-1", "assistant"],
          ["id-2", "tool"],
        ],
        [["id-3", "assistant"]],
      ]);
      expect(ofType(events, "STEP_STARTED").map((e) => e.stepName)).toEqual(["step-1", "step-2"]);
      expect(ofType(events, "TEXT_MESSAGE_START").map((e) => e.messageId)).toEqual(["id-1", "id-3"]);
    }),
  );

  it.effect("ends with RUN_ERROR StepLimitExceeded after the last allowed step", () =>
    Effect.gen(function* () {
      const loopingStep = [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")];
      const { events, prompts } = yield* runCore(
        [loopingStep, loopingStep.map((p) => ("id" in p ? { ...p, id: "c2" } : p)), loopingStep],
        { maxSteps: 2 },
      );
      expect(prompts).toHaveLength(2);
      expect(terminalOf(events)).toMatchObject({ type: "RUN_ERROR", code: "StepLimitExceeded" });
      expect(terminalOf(events)).toHaveProperty("message", expect.stringContaining("Step limit exceeded"));
    }),
  );

  it.effect("ends with RUN_ERROR ModelStreamError on an error part, closing what the step opened", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [...text("0", "par").slice(0, 2), { type: "error", error: { message: "overloaded" } }],
      ]);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_ERROR",
      ]);
      expect(terminalOf(events)).toEqual({ type: "RUN_ERROR", message: "overloaded", code: "ModelStreamError" });
    }),
  );
});

describe("Agent.run step entries", () => {
  it.effect("hands a step's entries to its runner before the step's STEP_FINISHED", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const committing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const model = scriptedModel([[...toolCall("c1", "get-weather", { location: "Paris" }), finish("stop")]]);
      // The commit holds the run until it is released, so nothing after it can have been emitted.
      const fiber = yield* agentRun(weatherAgent, { prompt: userPrompt }).pipe(
        Stream.tap((event) => Effect.sync(() => seen.push(event.type))),
        Stream.provideService(OnStepFinished, () =>
          Effect.andThen(Deferred.succeed(committing, undefined), Deferred.await(release)),
        ),
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
        Effect.forkChild,
      );
      yield* Deferred.await(committing);
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      expect(seen).toContain("TOOL_CALL_RESULT");
      expect(seen).not.toContain("STEP_FINISHED");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(seen.slice(-2)).toEqual(["STEP_FINISHED", "RUN_FINISHED"]);
    }),
  );

  it.effect("ends the run with RUN_ERROR when a commit fails, and calls the model no further", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      const events = yield* agentRun(weatherAgent, { prompt: userPrompt }).pipe(
        Stream.provideService(OnStepFinished, () => Effect.fail(new Thread.ThreadError({ cause: "store down" }))),
        Stream.runCollect,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(model.prompts).toHaveLength(1);
      expect(terminalOf(Array.from(events))).toMatchObject({ type: "RUN_ERROR", code: "ThreadError" });
      yield* Effect.promise(() => verify(Array.from(events)));
    }),
  );

  it.effect("emits the same events whether or not anything receives the entries", () =>
    Effect.gen(function* () {
      const script = (): ReadonlyArray<Step> => [
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ];
      const plain = yield* agentRun(weatherAgent, { prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([scriptedModel(script()).layer, countingWeatherLayer().layer, evalLayers]),
      );
      const recorded = yield* collect(agentRun(weatherAgent, { prompt: userPrompt })).pipe(
        Effect.provide([scriptedModel(script()).layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(Array.from(plain)).toEqual(recorded.events);
    }),
  );
});

describe("Agent.run usage", () => {
  it.effect("reports the usage of every step on RUN_FINISHED", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [
          ...toolCall("c1", "get-weather", { location: "Paris" }),
          finish("tool-calls", { input: 10, output: 5, cached: 4 }),
        ],
        [...text("0", "18°C"), finish("stop", { input: 20, output: 7, reasoning: 2 })],
      ]);
      expect(terminalOf(events).usage).toEqual([
        { inputTokens: 30, outputTokens: 12, reasoningTokens: 2, cachedInputTokens: 4, totalTokens: 42 },
      ]);
    }),
  );

  it.effect("reports no usage when the model reports no count", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([[...text("0", "Hi"), finish("stop")]]);
      expect(terminalOf(events)).not.toHaveProperty("usage");
    }),
  );

  it.effect("reports the usage counted so far on RUN_ERROR", () =>
    Effect.gen(function* () {
      const loopingStep = [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls", { input: 3 })];
      const { events } = yield* runCore([loopingStep], { maxSteps: 1 });
      expect(terminalOf(events)).toMatchObject({ type: "RUN_ERROR", usage: [{ inputTokens: 3, totalTokens: 3 }] });
    }),
  );

  it.effect("counts a replayed step's usage, so a resumed run reports the same totals", () =>
    Effect.gen(function* () {
      const step1: Step = [
        ...toolCall("c1", "get-weather", { location: "Paris" }),
        finish("tool-calls", { input: 10 }),
      ];
      const attempt = (steps: ReadonlyArray<Step>, stopAt?: (event: AgUiSchema.Event) => boolean) =>
        Effect.gen(function* () {
          const events = agentRun(weatherAgent, { prompt: userPrompt });
          return Array.from(
            yield* (stopAt === undefined ? events : Stream.takeUntil(events, stopAt)).pipe(
              Stream.runCollect,
              Effect.provide([scriptedModel(steps).layer, countingWeatherLayer().layer]),
            ),
          );
        });
      yield* attempt(
        [step1, Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event.type === "TEXT_MESSAGE_CONTENT",
      );
      const resumed = yield* attempt([[...text("0", "18°C"), finish("stop", { input: 20 })]]);
      expect(terminalOf(resumed).usage).toEqual([{ inputTokens: 30, totalTokens: 30 }]);
    }).pipe(Effect.provide(ledger)),
  );
});

describe("Agent.run usage of subagents and older checkpoints", () => {
  it.effect("adds a subagent's usage to its parent's", () =>
    Effect.gen(function* () {
      const researcher = Agent.define({ name: "researcher", toolkit: WeatherToolkit });
      const parent = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [researcher] } });
      const { events } = yield* collect(agentRun(parent, { prompt: userPrompt })).pipe(
        Effect.provide([
          scriptedModel([
            [...toolCall("c1", "researcher", { prompt: "Paris?" }), finish("tool-calls", { input: 10 })],
            [...text("0", "18°C"), finish("stop", { input: 4 })],
            [...text("0", "It's 18°C."), finish("stop", { input: 1 })],
          ]).layer,
          countingWeatherLayer().layer,
          evalLayers,
        ]),
      );
      expect(terminalOf(events).usage).toEqual([{ inputTokens: 15, totalTokens: 15 }]);
    }),
  );

  it.effect("counts nothing for a step replayed from a checkpoint written before usage was recorded", () =>
    Effect.gen(function* () {
      const store = yield* Layer.build(Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)));
      const stored = Context.get(store, Checkpoint.Checkpoint);
      // Stores model steps without their usage, as a checkpoint written before it was recorded holds them.
      const older = Layer.succeed(Checkpoint.Checkpoint)({
        memo: (options, effect) =>
          stored.memo(
            options,
            options.name.startsWith("model:")
              ? Effect.map(effect, (value) => {
                  const { usage: _, ...rest } = value as { usage?: unknown };
                  return rest as typeof value;
                })
              : effect,
          ),
      });
      const run = (steps: ReadonlyArray<Step>, checkpoint: Layer.Layer<Checkpoint.Checkpoint>) =>
        agentRun(weatherAgent, { prompt: userPrompt }).pipe(
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
          Effect.provide([scriptedModel(steps).layer, countingWeatherLayer().layer, checkpoint, counterIds()]),
        );
      yield* run(
        [
          [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls", { input: 10 })],
          [...text("0", "18°C"), finish("stop", { input: 20 })],
        ],
        older,
      );
      const replayed = yield* run([], Layer.succeedContext(store));
      expect(types(replayed)).toEqual(["RUN_STARTED", "TOOL_CALL_RESULT", "RUN_FINISHED"]);
      expect(terminalOf(replayed)).not.toHaveProperty("usage");
    }).pipe(Effect.scoped),
  );
});

describe("Agent.run approvals", () => {
  const approvalAgent = Agent.define({ toolkit: ApprovalToolkit });

  const runApproval = (steps: ReadonlyArray<Step>, prompt: Prompt.Prompt = userPrompt) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = countingApprovalLayer();
      const collected = yield* collect(agentRun(approvalAgent, { prompt })).pipe(
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      yield* Effect.promise(() => verify(collected.events));
      return { ...collected, prompts: model.prompts, ...handlers };
    });

  it.effect("interrupts for approval while other tools of the step still run", () =>
    Effect.gen(function* () {
      const { events, steps, prompts, weatherCalls, emails } = yield* runApproval([
        [...emailCall, ...toolCall("c_weather", "get-weather", { location: "Paris" }), finish("tool-calls")],
      ]);
      expect(weatherCalls).toEqual(["Paris"]);
      expect(emails).toEqual([]);
      expect(prompts).toHaveLength(1);
      expect(resultsOf(events).map((result) => result.toolCallId)).toEqual(["c_weather"]);
      expect(outcomeOf(events)).toEqual({
        type: "interrupt",
        interrupts: [
          Events.approvalInterrupt({
            approvalId: Agent.approvalIdFor("c_email"),
            toolCallId: "c_email",
            toolName: "send-email",
          }),
        ],
      });
      const assistant = steps[0]![0]!.message;
      expect(assistant.role).toBe("assistant");
      expect(partTypes(Prompt.fromMessages([assistant]))).toEqual(["tool-call", "tool-call", "tool-approval-request"]);
    }),
  );

  it.effect("gives the same call the same approval id on every thread", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.forEach(["t1", "t2"], (threadId) =>
        Effect.gen(function* () {
          const model = scriptedModel([[...emailCall, finish("tool-calls")]]);
          const events = yield* agentRun(approvalAgent, { input: { threadId }, prompt: userPrompt }).pipe(
            Stream.runCollect,
            Effect.provide([model.layer, countingApprovalLayer().layer, evalLayers]),
          );
          const outcome = outcomeOf(Array.from(events));
          return outcome?.type === "interrupt" ? outcome.interrupts.map((interrupt) => interrupt.id) : [];
        }),
      );
      expect(ids).toEqual([["approval:c_email"], ["approval:c_email"]]);
    }),
  );

  it.effect("treats a throwing approval predicate as not needing approval", () =>
    Effect.gen(function* () {
      const Risky = Tool.make("risky", {
        parameters: Schema.Struct({}),
        success: Schema.Boolean,
        needsApproval: () => {
          throw new Error("predicate failed");
        },
      });
      const toolkit = Toolkit.make(Risky);
      let ran = 0;
      const model = scriptedModel([[...toolCall("c1", "risky", {}), finish("tool-calls")], [finish("stop")]]);
      const events = yield* agentRun(Agent.define({ toolkit }), { prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, toolkit.toLayer({ risky: () => Effect.sync(() => (ran++, true)) }), evalLayers]),
      );
      expect(ran).toBe(1);
      expect(outcomeOf(Array.from(events))).toEqual({ type: "success" });
    }),
  );

  const answered = (approved: boolean, reason?: string) =>
    Prompt.make([
      { role: "user", content: "Email Ada" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "c_email", name: "send-email", params: { to: "ada@example.com", body: "Hi" } },
          { type: "tool-approval-request", approvalId: "a1", toolCallId: "c_email" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "a1", approved, ...(reason ? { reason } : {}) }],
      },
    ]);

  it.effect("executes an approved call as step 0, outside any step, before calling the model", () =>
    Effect.gen(function* () {
      const { events, steps, prompts, emails } = yield* runApproval(
        [[...text("0", "Sent."), finish("stop")]],
        answered(true),
      );
      expect(emails).toEqual(["ada@example.com"]);
      expect(types(events).slice(0, 3)).toEqual(["RUN_STARTED", "TOOL_CALL_RESULT", "STEP_STARTED"]);
      expect(resultsOf(events)[0]).toMatchObject({ toolCallId: "c_email", value: { sent: true }, isFailure: false });
      expect(steps[0]!.map((e) => e.message.role)).toEqual(["tool"]);
      expect(partTypes(prompts[0]!)).toEqual(["text", "tool-call", "tool-result"]);
    }),
  );

  it.effect("answers a denied call with a failed result naming the reason", () =>
    Effect.gen(function* () {
      const { events, prompts, emails } = yield* runApproval(
        [[...text("0", "OK."), finish("stop")]],
        answered(false, "no"),
      );
      expect(emails).toEqual([]);
      expect(resultsOf(events)[0]).toMatchObject({
        isFailure: true,
        value: { type: "execution-denied", reason: "no" },
      });
      expect(prompts[0]!.content.at(-1)).toMatchObject({
        role: "tool",
        content: [{ type: "tool-result", id: "c_email", isFailure: true, result: { reason: "no" } }],
      });
    }),
  );

  it.effect("does not count step 0 against the step limit", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Sent."), finish("stop")]]);
      const events = yield* agentRun(Agent.define({ toolkit: ApprovalToolkit, maxSteps: 1 }), {
        prompt: answered(true),
      }).pipe(Stream.runCollect, Effect.provide([model.layer, countingApprovalLayer().layer, evalLayers]));
      expect(outcomeOf(Array.from(events))).toEqual({ type: "success" });
    }),
  );
});

describe("Agent.run frontend tools", () => {
  const approvalAgent = Agent.define({ toolkit: ApprovalToolkit });
  const pickCall = toolCall("c_pick", "pick-file", { accept: "text/plain" });

  const runFrontend = (
    steps: ReadonlyArray<Step>,
    options?: {
      readonly tools?: ReadonlyArray<AgUiSchema.Tool>;
      readonly prompt?: Prompt.Prompt;
    },
  ) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = countingApprovalLayer();
      const collected = yield* collect(
        agentRun(approvalAgent, {
          prompt: options?.prompt ?? userPrompt,
          input: { tools: [...(options?.tools ?? [PickFile])] },
        }),
      ).pipe(Effect.provide([model.layer, handlers.layer, evalLayers]));
      yield* Effect.promise(() => verify(collected.events));
      return { ...collected, prompts: model.prompts, tools: model.tools, ...handlers };
    });

  const toolCallsOf = (prompt: Prompt.Prompt) =>
    prompt.content.flatMap((message) =>
      message.role === "assistant" ? message.content.filter((part) => part.type === "tool-call") : [],
    );

  it.effect("offers the advertised tools next to the agent's", () =>
    Effect.gen(function* () {
      const { tools } = yield* runFrontend([[...text("0", "Hi"), finish("stop")]]);
      expect(tools[0]!.map((tool) => tool.name)).toEqual(["get-weather", "send-email", "pick-file"]);
      const pickFile = tools[0]!.find((tool) => tool.name === "pick-file")!;
      expect(pickFile.description).toBe(PickFile.description);
      expect(Tool.getJsonSchema(pickFile)).toEqual(PickFile.parameters);
    }),
  );

  it.effect("offers a frontend tool without parameters as taking no arguments", () =>
    Effect.gen(function* () {
      const { tools } = yield* runFrontend([[...text("0", "Hi"), finish("stop")]], {
        tools: [{ name: "ping", description: "Ping the page" }],
      });
      expect(Tool.getJsonSchema(tools[0]!.find((tool) => tool.name === "ping")!)).toEqual({
        type: "object",
        properties: {},
      });
    }),
  );

  it.effect("ends with RUN_ERROR FrontendToolConflict when a frontend tool has one of the agent's names", () =>
    Effect.gen(function* () {
      const { events, prompts, weatherCalls } = yield* runFrontend([[...text("0", "Hi"), finish("stop")]], {
        tools: [{ name: "get-weather", description: "The client's", parameters: { type: "object" } }],
      });
      expect(prompts).toEqual([]);
      expect(weatherCalls).toEqual([]);
      expect(types(events)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
      expect(terminalOf(events)).toMatchObject({ code: "FrontendToolConflict" });
      expect(terminalOf(events)).toHaveProperty("message", expect.stringContaining('"get-weather"'));
    }),
  );

  it.effect("leaves a frontend call pending and marks it on the step's entry", () =>
    Effect.gen(function* () {
      const { events, steps, prompts } = yield* runFrontend([[...pickCall, finish("tool-calls")]]);
      expect(prompts).toHaveLength(1);
      expect(resultsOf(events)).toEqual([]);
      expect(steps[0]).toHaveLength(1);
      const [call] = toolCallsOf(Prompt.fromMessages([steps[0]![0]!.message]));
      expect(call).toMatchObject({ id: "c_pick", name: "pick-file" });
      expect(Agent.isFrontendCall(call!)).toBe(true);
      expect(outcomeOf(events)).toEqual({ type: "success", pendingToolCallIds: ["c_pick"] });
    }),
  );

  it.effect("runs the server calls of a step that also calls a frontend tool, then stops", () =>
    Effect.gen(function* () {
      const { events, steps, prompts, weatherCalls } = yield* runFrontend([
        [...pickCall, ...toolCall("c_weather", "get-weather", { location: "Paris" }), finish("tool-calls")],
      ]);
      expect(weatherCalls).toEqual(["Paris"]);
      expect(prompts).toHaveLength(1);
      expect(resultsOf(events).map((result) => result.toolCallId)).toEqual(["c_weather"]);
      const [pick, weather] = toolCallsOf(Prompt.fromMessages([steps[0]![0]!.message]));
      expect([Agent.isFrontendCall(pick!), Agent.isFrontendCall(weather!)]).toEqual([true, false]);
      expect(outcomeOf(events)).toEqual({ type: "success", pendingToolCallIds: ["c_pick"] });
    }),
  );

  it.effect("answers a frontend call with a failed result when the response finished incomplete", () =>
    Effect.gen(function* () {
      const { events } = yield* runFrontend([[...pickCall, finish("length")]]);
      expect(resultsOf(events)[0]).toMatchObject({
        toolCallId: "c_pick",
        isFailure: true,
        value: { type: "execution-interrupted" },
      });
      expect(outcomeOf(events)).toEqual({ type: "success" });
    }),
  );

  it.effect("ends with the approval interrupt alone when a frontend call is pending too", () =>
    Effect.gen(function* () {
      const { events, emails } = yield* runFrontend([[...pickCall, ...emailCall, finish("tool-calls")]]);
      expect(emails).toEqual([]);
      expect(resultsOf(events)).toEqual([]);
      expect(outcomeOf(events)).toEqual({
        type: "interrupt",
        interrupts: [
          Events.approvalInterrupt({ approvalId: "approval:c_email", toolCallId: "c_email", toolName: "send-email" }),
        ],
      });
    }),
  );

  it.effect("never sends the frontend mark to the model", () =>
    Effect.gen(function* () {
      const first = yield* runFrontend([[...pickCall, finish("tool-calls")]]);
      const prompt = Prompt.fromMessages([
        ...userPrompt.content,
        first.steps[0]![0]!.message,
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id: "c_pick",
              name: "pick-file",
              result: { name: "a.txt" },
              isFailure: false,
              providerExecuted: false,
            }),
          ],
        }),
      ]);
      const { prompts } = yield* runFrontend([[...text("0", "You picked a.txt"), finish("stop")]], { prompt });
      const [call] = toolCallsOf(prompts[0]!);
      expect(call).toMatchObject({ id: "c_pick", name: "pick-file" });
      expect(call!.options).toEqual({});
      expect(partTypes(prompts[0]!)).toEqual(["text", "tool-call", "tool-result"]);
    }),
  );
});

describe("Agent.run replay", () => {
  it.effect("leaves the same frontend call pending when a finished run is executed again", () =>
    Effect.gen(function* () {
      const attempt = (steps: ReadonlyArray<Step>) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const collected = yield* collect(
            agentRun(weatherAgent, { prompt: userPrompt, input: { tools: [PickFile] } }),
          ).pipe(Effect.provide([model.layer, countingWeatherLayer().layer]));
          return { ...collected, prompts: model.prompts };
        });
      const first = yield* attempt([[...toolCall("c_pick", "pick-file", {}), finish("tool-calls")]]);
      const second = yield* attempt([]);
      expect(second.prompts).toEqual([]);
      // The replayed step publishes nothing, and is committed again with the same entries.
      expect(types(second.events)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
      expect(second.steps).toEqual(first.steps);
      expect(terminalOf(second.events)).toEqual(terminalOf(first.events));
      expect(outcomeOf(first.events)).toEqual({ type: "success", pendingToolCallIds: ["c_pick"] });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("replays completed steps of a run executed again, publishing only their marked results", () =>
    Effect.gen(function* () {
      const weather = countingWeatherLayer();
      const step1: Step = [
        ...text("0", "Checking."),
        ...toolCall("c1", "get-weather", { location: "Paris" }),
        finish("tool-calls"),
      ];
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: AgUiSchema.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = agentRun(weatherAgent, { prompt: userPrompt });
          const collected = yield* collect(stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Effect.provide([model.layer, weather.layer]),
          );
          return { ...collected, prompts: model.prompts };
        });

      // Attempt 1 stops (as if the process crashed) while step 2 is streaming.
      const first = yield* attempt(
        [step1, Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event.type === "TEXT_MESSAGE_CONTENT" && event.messageId === "id-3",
      );
      // Attempt 2 is served step 1 from the ledger; its model is only called for step 2.
      const second = yield* attempt([[...text("0", "18°C"), finish("stop")]]);

      expect(weather.calls).toEqual(["Paris"]);
      expect(second.prompts).toHaveLength(1);
      expect(second.prompts[0]!.content.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

      // Step 1 publishes only its result, marked, which the runner publishes if an earlier attempt didn't.
      expect(types(second.events)).toEqual([
        "RUN_STARTED",
        "TOOL_CALL_RESULT",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      const [original] = ofType(first.events, "TOOL_CALL_RESULT");
      const [replayed] = ofType(second.events, "TOOL_CALL_RESULT");
      expect(replayed).toEqual({ ...original, metadata: { "effect-agent-harness": { replayed: true } } });
      expect(second.steps[0]).toEqual(first.steps[0]);
      expect(ofType(second.events, "STEP_STARTED")).toEqual([Events.stepStarted("step-2")]);
      expect(outcomeOf(second.events)).toEqual({ type: "success" });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("marks nothing in a run that executes every step", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      expect(events.some((event) => event.metadata?.["effect-agent-harness"] !== undefined)).toBe(false);
    }),
  );
});

// -----------------------------------------------------------------------------
// Tool progress
// -----------------------------------------------------------------------------

describe("Agent.run tool progress", () => {
  const progressAgent = Agent.define({ toolkit: ProgressToolkit });
  const searchCall = (query: string, sources = 2) => toolCall("c_search", "search", { query, sources });

  const runProgress = (steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = progressLayer();
      const collected = yield* collect(agentRun(progressAgent, { prompt: userPrompt })).pipe(
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      yield* Effect.promise(() => verify(collected.events));
      return { ...collected, prompts: model.prompts, calls: handlers.calls };
    });

  it.effect("emits each preliminary result as an activity snapshot, in order, before the call's result", () =>
    Effect.gen(function* () {
      const { events } = yield* runProgress([
        [...searchCall("docs"), finish("tool-calls")],
        [...text("0", "Found 3."), finish("stop")],
      ]);
      const stepMessageId = ofType(events, "TOOL_CALL_START")[0]!.parentMessageId!;
      expect(ofType(events, "ACTIVITY_SNAPSHOT")).toEqual([
        Events.activitySnapshot(`${stepMessageId}:activity:c_search`, "search", "c_search", { done: 1, of: 2 }),
        Events.activitySnapshot(`${stepMessageId}:activity:c_search`, "search", "c_search", { done: 2, of: 2 }),
      ]);
      const step1 = types(events).slice(types(events).indexOf("TOOL_CALL_END"), types(events).indexOf("STEP_FINISHED"));
      expect(step1).toEqual(["TOOL_CALL_END", "ACTIVITY_SNAPSHOT", "ACTIVITY_SNAPSHOT", "TOOL_CALL_RESULT"]);
      expect(resultsOf(events)[0]).toMatchObject({ value: { done: 2, of: 2, hits: 3 }, isFailure: false });
    }),
  );

  it.effect("keeps progress out of the step's entries and the next prompt", () =>
    Effect.gen(function* () {
      const { steps, prompts } = yield* runProgress([
        [...searchCall("docs"), finish("tool-calls")],
        [...text("0", "Found 3."), finish("stop")],
      ]);
      const results = steps[0]!.flatMap((entry) =>
        typeof entry.message.content === "string"
          ? []
          : entry.message.content.flatMap((part) => (part.type === "tool-result" ? [part.result] : [])),
      );
      expect(results).toEqual([{ done: 2, of: 2, hits: 3 }]);
      const sent = prompts[1]!.content.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.result] : []))
          : [],
      );
      expect(sent).toEqual([{ done: 2, of: 2, hits: 3 }]);
    }),
  );

  it.effect("returns a failure after progress as it would without it", () =>
    Effect.gen(function* () {
      const { events } = yield* runProgress([
        [...searchCall("fail"), finish("tool-calls")],
        [...text("0", "It failed."), finish("stop")],
      ]);
      expect(ofType(events, "ACTIVITY_SNAPSHOT")).toHaveLength(2);
      expect(resultsOf(events)[0]).toMatchObject({ value: { message: "search failed" }, isFailure: true });
    }),
  );

  it.effect("reports progress that isn't an object as it is encoded", () =>
    Effect.gen(function* () {
      const { events } = yield* runProgress([
        [...toolCall("c_count", "count", { to: 3 }), finish("tool-calls")],
        [finish("stop")],
      ]);
      expect(ofType(events, "ACTIVITY_SNAPSHOT").map((e) => e.content)).toEqual([{ value: 1 }, { value: 2 }]);
      expect(resultsOf(events)[0]!.value).toBe(3);
    }),
  );

  it.effect("emits no progress for a call served from the checkpoint store", () =>
    Effect.gen(function* () {
      const handlers = progressLayer();
      const attempt = (steps: ReadonlyArray<Step>) =>
        agentRun(progressAgent, { prompt: userPrompt }).pipe(
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
          Effect.provide([scriptedModel(steps).layer, handlers.layer]),
        );
      const first = yield* attempt([
        [...searchCall("docs"), finish("tool-calls")],
        [...text("0", "Found 3."), finish("stop")],
      ]);
      const second = yield* attempt([]);
      expect(handlers.calls).toEqual(["docs"]);
      expect(ofType(first, "ACTIVITY_SNAPSHOT")).toHaveLength(2);
      expect(ofType(second, "ACTIVITY_SNAPSHOT")).toEqual([]);
      expect(resultsOf(second)[0]).toMatchObject({ replayed: true, value: { hits: 3 } });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("reports progress again, under the same message id, when a crash makes the call run again", () =>
    Effect.gen(function* () {
      const step1: Step = [...searchCall("docs"), finish("tool-calls")];
      // Attempt 1 crashes after the call's first progress, while the handler is still running.
      const stuck = progressLayer({ between: Effect.never });
      const first = yield* agentRun(progressAgent, { prompt: userPrompt }).pipe(
        Stream.takeUntil((event) => event.type === "ACTIVITY_SNAPSHOT"),
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
        Effect.provide([scriptedModel([step1]).layer, stuck.layer]),
      );
      // Attempt 2 is served the model step from the ledger and runs the handler again.
      const handlers = progressLayer();
      const second = yield* agentRun(progressAgent, { prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
        Effect.provide([scriptedModel([[...text("0", "Found 3."), finish("stop")]]).layer, handlers.layer]),
      );
      expect(stuck.calls).toEqual(["docs"]);
      expect(handlers.calls).toEqual(["docs"]);
      const before = ofType(first, "ACTIVITY_SNAPSHOT");
      const after = ofType(second, "ACTIVITY_SNAPSHOT");
      expect(before).toHaveLength(1);
      expect(after.map((e) => e.content)).toEqual([
        { done: 1, of: 2 },
        { done: 2, of: 2 },
      ]);
      expect(after.every((e) => e.messageId === before[0]!.messageId)).toBe(true);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("reports an approved call's progress in step 0 under an id derived from its approval", () =>
    Effect.gen(function* () {
      const ApprovedSearch = Tool.make("approved-search", {
        parameters: Schema.Struct({}),
        success: Schema.Struct({ done: Schema.Finite }),
        needsApproval: true,
      });
      const toolkit = Toolkit.make(ApprovedSearch);
      const prompt = Prompt.make([
        { role: "user", content: "Search" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "c_approved", name: "approved-search", params: {} },
            { type: "tool-approval-request", approvalId: "a1", toolCallId: "c_approved" },
          ],
        },
        { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] },
      ]);
      const events = yield* agentRun(Agent.define({ toolkit }), { prompt }).pipe(
        Stream.runCollect,
        Effect.provide([
          scriptedModel([[finish("stop")]]).layer,
          toolkit.toLayer({
            "approved-search": (_, ctx) => Effect.as(ctx.preliminary({ done: 0 }), { done: 1 }),
          }),
          evalLayers,
        ]),
      );
      expect(ofType(Array.from(events), "ACTIVITY_SNAPSHOT")).toEqual([
        Events.activitySnapshot("approval:c_approved:activity", "approved-search", "c_approved", { done: 0 }),
      ]);
    }),
  );
});

// -----------------------------------------------------------------------------
// The run's input and the system prompt
// -----------------------------------------------------------------------------

class UserDirectory extends Context.Service<UserDirectory, { readonly name: Effect.Effect<string> }>()(
  "test/UserDirectory",
) {}

/** A directory answering `name`, counting lookups in `lookups`. */
const directory = (name: string) => {
  const lookups = { count: 0 };
  const layer = Layer.succeed(UserDirectory)({ name: Effect.sync(() => (lookups.count++, name)) });
  return { layer, lookups };
};

const greeting = Effect.gen(function* () {
  const name = yield* (yield* UserDirectory).name;
  return `You are helping ${name}.`;
});

const WhoAmI = Tool.make("who-am-i", {
  parameters: Schema.Struct({}),
  success: Schema.Boolean,
  dependencies: [AgUiServer.RunInput],
});
const ConfirmedWhoAmI = Tool.make("confirmed-who-am-i", {
  parameters: Schema.Struct({}),
  success: Schema.Boolean,
  needsApproval: true,
  dependencies: [AgUiServer.RunInput],
});
const RunInputToolkit = Toolkit.make(WhoAmI, ConfirmedWhoAmI);

/** Handlers recording the AG-UI input each call sees. */
const runInputLayer = () => {
  const seen: Array<AgUiSchema.RunAgentInput> = [];
  const record = () =>
    Effect.gen(function* () {
      seen.push(yield* AgUiServer.RunInput);
      return true;
    });
  return { layer: RunInputToolkit.toLayer({ "who-am-i": record, "confirmed-who-am-i": record }), seen };
};

const systemOf = (prompt: Prompt.Prompt) => {
  const first = prompt.content[0];
  return first?.role === "system" ? first.content : undefined;
};

describe("Agent.run input", () => {
  const input = agentInput({ forwardedProps: { locale: "fr" }, state: { cart: 2 } });

  it.effect("gives tool handlers the run's AG-UI input, with nothing extra to provide", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...toolCall("c1", "who-am-i", {}), finish("tool-calls")], [finish("stop")]]);
      const handlers = runInputLayer();
      yield* Agent.run(Agent.define({ toolkit: RunInputToolkit }), { input, prompt: userPrompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      expect(handlers.seen).toEqual([input]);
    }),
  );

  it.effect("gives a call approved in step 0 the run's input", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Done."), finish("stop")]]);
      const handlers = runInputLayer();
      const prompt = Prompt.make([
        { role: "user", content: "Who am I?" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "c1", name: "confirmed-who-am-i", params: {} },
            { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
          ],
        },
        { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] },
      ]);
      yield* Agent.run(Agent.define({ toolkit: RunInputToolkit }), { input, prompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      expect(handlers.seen).toEqual([input]);
    }),
  );

  it.effect("gives an approval predicate the run's input", () =>
    Effect.gen(function* () {
      const Guarded = Tool.make("guarded", {
        parameters: Schema.Struct({}),
        success: Schema.Boolean,
        // The run provides its input while a predicate runs, but Tool's `needsApproval` type admits no services.
        needsApproval: () =>
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the run provides RunInput here; see above.
          Effect.gen(function* () {
            const run = yield* AgUiServer.RunInput;
            return (run.state as { cart?: number } | undefined)?.cart === 2;
          }) as Effect.Effect<boolean>,
      });
      const toolkit = Toolkit.make(Guarded);
      const model = scriptedModel([[...toolCall("c1", "guarded", {}), finish("tool-calls")]]);
      const events = yield* Agent.run(Agent.define({ toolkit }), { input, prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, toolkit.toLayer({ guarded: () => Effect.succeed(true) }), evalLayers]),
      );
      expect(outcomeOf(Array.from(events))).toMatchObject({ type: "interrupt" });
    }),
  );
});

class CurrentUser extends Context.Service<CurrentUser, { readonly userId: string }>()("test/CurrentUser") {}

const WhoIsUser = Tool.make("who-is-user", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  dependencies: [CurrentUser],
});
const UserToolkit = Toolkit.make(WhoIsUser);
const userToolkitLayer = UserToolkit.toLayer({
  "who-is-user": () =>
    Effect.gen(function* () {
      return (yield* CurrentUser).userId;
    }),
});

describe("Agent per-run services", () => {
  it("requires a tool's dependency as an ordinary service", () => {
    type RequirementsOf<A> = A extends Agent.Agent<infer Tools, infer R> ? Agent.Requirements<Tools, R> : never;
    const agent = Agent.define({ toolkit: UserToolkit });
    expectTypeOf<CurrentUser>().toExtend<RequirementsOf<typeof agent>>();
    // The handler layer builds without the dependency: handlers read it per call.
    expectTypeOf(userToolkitLayer).toEqualTypeOf<Layer.Layer<Tool.HandlersFor<typeof UserToolkit.tools>>>();
    const run = agentRun(agent, { prompt: userPrompt }).pipe(
      Stream.runDrain,
      Effect.provide([userToolkitLayer, evalLayers]),
    );
    // Still required once the handlers are provided: nothing provides it but the caller.
    expectTypeOf<Effect.Services<typeof run>>().toEqualTypeOf<LanguageModel.LanguageModel | CurrentUser>();
  });

  it.effect("gives the handler the CurrentUser provided around Agent.run", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        [...toolCall("c1", "who-is-user", {}), finish("tool-calls")],
        [...text("0", "You are u1."), finish("stop")],
      ]);
      const events = yield* agentRun(Agent.define({ toolkit: UserToolkit }), { prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, userToolkitLayer, evalLayers, Layer.succeed(CurrentUser)({ userId: "u1" })]),
      );
      expect(resultsOf(Array.from(events)).map((result) => result.value)).toEqual(["u1"]);
    }),
  );
});

describe("Agent system prompt", () => {
  it("adds what the system effect needs to the requirements, except the run's input", () => {
    type RequirementsOf<A> = A extends Agent.Agent<infer Tools, infer R> ? Agent.Requirements<Tools, R> : never;
    const fixed = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });
    const computed = Agent.define({
      toolkit: WeatherToolkit,
      system: Effect.gen(function* () {
        const run = yield* AgUiServer.RunInput;
        return `${yield* greeting} Run ${run.runId}.`;
      }),
    });
    expectTypeOf<RequirementsOf<typeof fixed>>().toEqualTypeOf<RequirementsOf<typeof weatherAgent>>();
    expectTypeOf<RequirementsOf<typeof computed>>().toEqualTypeOf<
      RequirementsOf<typeof weatherAgent> | UserDirectory
    >();
  });

  it.effect("starts every model call with a fixed system prompt", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      yield* agentRun(Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." }), { prompt: userPrompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(model.prompts.map(systemOf)).toEqual(["Be helpful.", "Be helpful."]);
      expect(model.prompts[0]!.content.map((m) => m.role)).toEqual(["system", "user"]);
    }),
  );

  it.effect("sends the prompt unchanged when the agent has no system prompt", () =>
    Effect.gen(function* () {
      const { prompts } = yield* runCore([[...text("0", "Hi"), finish("stop")]]);
      expect(prompts[0]!.content.map((m) => m.role)).toEqual(["user"]);
    }),
  );

  it.effect("resolves the same definition differently under different services, once per run", () =>
    Effect.gen(function* () {
      const agent = Agent.define({ toolkit: WeatherToolkit, system: greeting });
      const runAs = (name: string) =>
        Effect.gen(function* () {
          const users = directory(name);
          const model = scriptedModel([
            [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
            [...text("0", "18°C"), finish("stop")],
          ]);
          yield* agentRun(agent, { prompt: userPrompt }).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, users.layer, evalLayers]),
          );
          return { systems: model.prompts.map(systemOf), lookups: users.lookups.count };
        });
      expect(yield* runAs("Ada")).toEqual({ systems: ["You are helping Ada.", "You are helping Ada."], lookups: 1 });
      expect(yield* runAs("Grace")).toEqual({
        systems: ["You are helping Grace.", "You are helping Grace."],
        lookups: 1,
      });
    }),
  );

  it.effect("lets the system effect read the run's forwarded props", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Bonjour"), finish("stop")]]);
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: Effect.gen(function* () {
          const run = yield* AgUiServer.RunInput;
          // Props come from the client: pick between known prompts, never interpolate them.
          return Schema.is(Schema.Struct({ locale: Schema.Literals(["fr"]) }))(run.forwardedProps)
            ? "Réponds en français."
            : "Reply in English.";
        }),
      });
      yield* agentRun(agent, { input: { forwardedProps: { locale: "fr" } }, prompt: userPrompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(systemOf(model.prompts[0]!)).toBe("Réponds en français.");
    }),
  );

  it.effect("puts the agent's system prompt before a summary at the start of the prompt", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Hi"), finish("stop")]]);
      const prompt = Prompt.make([
        { role: "system", content: "Summary: they asked about Paris." },
        { role: "user", content: "And now?" },
      ]);
      yield* agentRun(Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." }), { prompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(model.prompts[0]!.content.map((m) => (m.role === "system" ? m.content : m.role))).toEqual([
        "Be helpful.",
        "Summary: they asked about Paris.",
        "user",
      ]);
    }),
  );

  it.effect("fails the run before any tool or model call when the system effect dies", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Sent."), finish("stop")]]);
      const handlers = countingApprovalLayer();
      const events = yield* agentRun(Agent.define({ toolkit: ApprovalToolkit, system: Effect.die("directory down") }), {
        prompt: Prompt.make([
          { role: "user", content: "Email Ada" },
          {
            role: "assistant",
            content: [
              { type: "tool-call", id: "c_email", name: "send-email", params: { to: "ada@example.com", body: "Hi" } },
              { type: "tool-approval-request", approvalId: "a1", toolCallId: "c_email" },
            ],
          },
          { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] },
        ]),
      }).pipe(Stream.runCollect, Effect.provide([model.layer, handlers.layer, evalLayers]));
      expect(types(Array.from(events))).toEqual(["RUN_STARTED", "RUN_ERROR"]);
      expect(model.prompts).toEqual([]);
      expect(handlers.emails).toEqual([]);
    }),
  );

  it.effect("reuses the resolved system prompt when the run is executed again", () =>
    Effect.gen(function* () {
      class WallClock extends Context.Service<WallClock, { readonly now: Effect.Effect<string> }>()("test/WallClock") {}
      let now = "09:00";
      const clock = Layer.succeed(WallClock)({ now: Effect.sync(() => now) });
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: Effect.gen(function* () {
          return `It is ${yield* (yield* WallClock).now}.`;
        }),
      });
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: AgUiSchema.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = agentRun(agent, { prompt: userPrompt });
          yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, clock]),
          );
          return model.prompts;
        });

      // Attempt 1 stops (as if the process crashed) while step 1 is streaming.
      const first = yield* attempt(
        [Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event.type === "TEXT_MESSAGE_CONTENT",
      );
      now = "10:00";
      const second = yield* attempt([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);

      expect(first.map(systemOf)).toEqual(["It is 09:00."]);
      expect(second.map(systemOf)).toEqual(["It is 09:00.", "It is 09:00."]);
    }).pipe(Effect.provide(ledger)),
  );
});
