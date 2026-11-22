import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { expectTypeOf } from "vitest";
import { Prompt, Tool, Toolkit } from "effect/ai";
import type { LanguageModel } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import {
  ApprovalToolkit,
  counterIds,
  countingApprovalLayer,
  countingWeatherLayer,
  evalLayers,
  finish,
  PickFile,
  ProgressToolkit,
  progressLayer,
  scriptedModel,
  type Step,
  text,
  toolCall,
  WeatherToolkit,
} from "./fixtures.ts";

const weatherAgent = Agent.define({ toolkit: WeatherToolkit });

const userPrompt = Prompt.make([{ role: "user", content: "What is the weather in Paris?" }]);

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
    const events = yield* Agent.run(agent, { runId: "r1", threadId: "t1", prompt: options?.prompt ?? userPrompt }).pipe(
      Stream.runCollect,
      Effect.provide([model.layer, weather.layer, evalLayers]),
    );
    return { events: Array.from(events), prompts: model.prompts, calls: weather.calls };
  });

const tags = (events: ReadonlyArray<Agent.Event>) => events.map((event) => event._tag);

const byTag = <T extends Agent.Event["_tag"]>(events: ReadonlyArray<Agent.Event>, tag: T) =>
  events.filter((event): event is Extract<Agent.Event, { _tag: T }> => event._tag === tag);

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
          yield* Agent.run(weatherAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, checkpoint, counterIds()]),
          );
          return model.prompts;
        });
      const none = yield* runWith(Checkpoint.layerNone);
      const ledger = yield* runWith(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)));
      expect(ledger).toEqual(none);
    }),
  );
});

describe("Agent.run", () => {
  it.effect("emits a text-only step", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([[...text("0", "Hel", "lo"), finish("stop")]]);
      expect(tags(events)).toEqual([
        "StepStarted",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "ModelPart",
        "StepFinished",
        "Finished",
      ]);
      expect(events[0]).toEqual({ _tag: "StepStarted", step: 1, messageId: "id-1", replayed: false });
      expect(events.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
      const [finished] = byTag(events, "StepFinished");
      expect(finished!.entries).toEqual([
        {
          id: "id-1",
          message: Prompt.makeMessage("assistant", { content: [Prompt.makePart("text", { text: "Hello" })] }),
        },
      ]);
    }),
  );

  it.effect("emits model parts while the model is still streaming", () =>
    Effect.gen(function* () {
      const model = scriptedModel([
        Stream.fromIterable(text("0", "first").slice(0, 2)).pipe(Stream.concat(Stream.never)),
      ]);
      const events = yield* Agent.run(weatherAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
      );
      expect(tags(events)).toEqual(["StepStarted", "ModelPart", "ModelPart"]);
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
      const events = yield* Agent.run(weatherAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, handlers, evalLayers]),
      );
      expect(log).toEqual(["model-end", "handler"]);
      const results = byTag(Array.from(events), "ToolResult");
      expect(results).toEqual([
        {
          _tag: "ToolResult",
          step: 1,
          messageId: "id-2",
          toolCallId: "c1",
          toolName: "get-weather",
          encodedResult: { temperature: 18 },
          isFailure: false,
          replayed: false,
        },
      ]);
      expect(tags(Array.from(events)).indexOf("ToolResult")).toBeLessThan(
        tags(Array.from(events)).indexOf("StepFinished"),
      );
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
      expect(byTag(events, "ToolResult").map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    }),
  );

  it.effect("returns tool failures to the model", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Nowhere" }), finish("tool-calls")],
        [...text("0", "I couldn't find that place."), finish("stop")],
      ]);
      const [result] = byTag(events, "ToolResult");
      expect(result).toMatchObject({ isFailure: true, encodedResult: { message: "Location 'Nowhere' not found" } });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.content[2]).toMatchObject({ content: [{ type: "tool-result", id: "c1", isFailure: true }] });
    }),
  );

  it.effect("does not run tools when the response finished incomplete", () =>
    Effect.gen(function* () {
      const { events, calls, prompts } = yield* runCore([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("length")],
      ]);
      expect(calls).toEqual([]);
      expect(prompts).toHaveLength(1);
      const [result] = byTag(events, "ToolResult");
      expect(result).toMatchObject({ isFailure: true, encodedResult: { type: "execution-interrupted" } });
      expect((result!.encodedResult as { reason: string }).reason).toContain('"length"');
      expect(events.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
    }),
  );

  it.effect("carries the assistant and tool entries of a step", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [...text("0", "Let me check."), ...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      const [step1, step2] = byTag(events, "StepFinished");
      expect(step1!.entries.map((e) => [e.id, e.message.role])).toEqual([
        ["id-1", "assistant"],
        ["id-2", "tool"],
      ]);
      expect(step2!.entries.map((e) => [e.id, e.message.role])).toEqual([["id-3", "assistant"]]);
      expect(byTag(events, "StepStarted").map((e) => [e.step, e.messageId])).toEqual([
        [1, "id-1"],
        [2, "id-3"],
      ]);
    }),
  );

  it.effect("fails with StepLimitExceeded after the last allowed step", () =>
    Effect.gen(function* () {
      const loopingStep = [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")];
      const { events, prompts } = yield* runCore(
        [loopingStep, loopingStep.map((p) => ("id" in p ? { ...p, id: "c2" } : p)), loopingStep],
        { maxSteps: 2 },
      );
      expect(prompts).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ _tag: "Failed", code: "StepLimitExceeded" });
      expect(Agent.errorMessage((events.at(-1) as { error: unknown }).error)).toContain("Step limit exceeded");
    }),
  );

  it.effect("fails with ModelStreamError on an error part and emits nothing after", () =>
    Effect.gen(function* () {
      const { events } = yield* runCore([
        [...text("0", "par").slice(0, 2), { type: "error", error: { message: "overloaded" } }],
      ]);
      expect(tags(events)).toEqual(["StepStarted", "ModelPart", "ModelPart", "Failed"]);
      expect(events.at(-1)).toMatchObject({ _tag: "Failed", code: "ModelStreamError" });
      expect(Agent.errorMessage((events.at(-1) as { error: unknown }).error)).toBe("overloaded");
    }),
  );
});

describe("Agent.run approvals", () => {
  const approvalAgent = Agent.define({ toolkit: ApprovalToolkit });

  const runApproval = (steps: ReadonlyArray<Step>, prompt: Prompt.Prompt = userPrompt) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = countingApprovalLayer();
      const events = yield* Agent.run(approvalAgent, { runId: "r1", threadId: "t1", prompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      return { events: Array.from(events), prompts: model.prompts, ...handlers };
    });

  it.effect("interrupts for approval while other tools of the step still run", () =>
    Effect.gen(function* () {
      const { events, prompts, weatherCalls, emails } = yield* runApproval([
        [...emailCall, ...toolCall("c_weather", "get-weather", { location: "Paris" }), finish("tool-calls")],
      ]);
      expect(weatherCalls).toEqual(["Paris"]);
      expect(emails).toEqual([]);
      expect(prompts).toHaveLength(1);
      const [requested] = byTag(events, "ApprovalRequested");
      expect(requested).toMatchObject({
        step: 1,
        approvalId: Agent.approvalIdFor("c_email"),
        toolCallId: "c_email",
        toolName: "send-email",
        replayed: false,
      });
      expect(events.at(-1)).toEqual({
        _tag: "Finished",
        outcome: {
          _tag: "Interrupted",
          approvals: [{ approvalId: requested!.approvalId, toolCallId: "c_email", toolName: "send-email" }],
          pendingToolCalls: [],
        },
      });
      const [finished] = byTag(events, "StepFinished");
      const assistant = finished!.entries[0]!.message;
      expect(assistant.role).toBe("assistant");
      expect(partTypes(Prompt.fromMessages([assistant]))).toEqual(["tool-call", "tool-call", "tool-approval-request"]);
    }),
  );

  it.effect("gives the same call the same approval id on every thread", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.forEach(["t1", "t2"], (threadId) =>
        Effect.gen(function* () {
          const model = scriptedModel([[...emailCall, finish("tool-calls")]]);
          const events = yield* Agent.run(approvalAgent, { runId: "r1", threadId, prompt: userPrompt }).pipe(
            Stream.runCollect,
            Effect.provide([model.layer, countingApprovalLayer().layer, evalLayers]),
          );
          return byTag(Array.from(events), "ApprovalRequested").map((event) => event.approvalId);
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
      const events = yield* Agent.run(Agent.define({ toolkit }), {
        runId: "r1",
        threadId: "t1",
        prompt: userPrompt,
      }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, toolkit.toLayer({ risky: () => Effect.sync(() => (ran++, true)) }), evalLayers]),
      );
      expect(ran).toBe(1);
      expect(byTag(Array.from(events), "ApprovalRequested")).toEqual([]);
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

  it.effect("executes an approved call as step 0 before calling the model", () =>
    Effect.gen(function* () {
      const { events, prompts, emails } = yield* runApproval([[...text("0", "Sent."), finish("stop")]], answered(true));
      expect(emails).toEqual(["ada@example.com"]);
      expect(tags(events).slice(0, 3)).toEqual(["ToolResult", "StepFinished", "StepStarted"]);
      expect(events[0]).toMatchObject({
        step: 0,
        toolCallId: "c_email",
        encodedResult: { sent: true },
        isFailure: false,
      });
      expect(events[1]).toMatchObject({ _tag: "StepFinished", step: 0 });
      expect(
        (events[1] as { entries: ReadonlyArray<{ message: Prompt.Message }> }).entries.map((e) => e.message.role),
      ).toEqual(["tool"]);
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
      expect(events[0]).toMatchObject({
        _tag: "ToolResult",
        step: 0,
        isFailure: true,
        encodedResult: { type: "execution-denied", reason: "no" },
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
      const events = yield* Agent.run(Agent.define({ toolkit: ApprovalToolkit, maxSteps: 1 }), {
        runId: "r1",
        threadId: "t1",
        prompt: answered(true),
      }).pipe(Stream.runCollect, Effect.provide([model.layer, countingApprovalLayer().layer, evalLayers]));
      expect(Array.from(events).at(-1)).toEqual({
        _tag: "Finished",
        outcome: { _tag: "Success", pendingToolCalls: [] },
      });
    }),
  );
});

describe("Agent.run frontend tools", () => {
  const approvalAgent = Agent.define({ toolkit: ApprovalToolkit });
  const pickCall = toolCall("c_pick", "pick-file", { accept: "text/plain" });

  const runFrontend = (
    steps: ReadonlyArray<Step>,
    options?: {
      readonly frontendTools?: ReadonlyArray<Agent.FrontendTool>;
      readonly prompt?: Prompt.Prompt;
    },
  ) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = countingApprovalLayer();
      const events = yield* Agent.run(approvalAgent, {
        runId: "r1",
        threadId: "t1",
        prompt: options?.prompt ?? userPrompt,
        frontendTools: options?.frontendTools ?? [PickFile],
      }).pipe(Stream.runCollect, Effect.provide([model.layer, handlers.layer, evalLayers]));
      return { events: Array.from(events), prompts: model.prompts, tools: model.tools, ...handlers };
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

  it.effect("offers the agent's tool when a frontend tool has its name", () =>
    Effect.gen(function* () {
      const { tools, weatherCalls, events } = yield* runFrontend(
        [
          [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
          [...text("0", "18°C"), finish("stop")],
        ],
        { frontendTools: [{ name: "get-weather", description: "The client's", parameters: { type: "object" } }] },
      );
      const offered = tools[0]!.filter((tool) => tool.name === "get-weather");
      expect(offered.map((tool) => tool.description)).toEqual(["Get current weather for a location"]);
      expect(weatherCalls).toEqual(["Paris"]);
      expect(events.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
    }),
  );

  it.effect("leaves a frontend call pending and marks it on the step's entry", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runFrontend([[...pickCall, finish("tool-calls")]]);
      expect(prompts).toHaveLength(1);
      expect(byTag(events, "ToolResult")).toEqual([]);
      const [finished] = byTag(events, "StepFinished");
      expect(finished!.entries).toHaveLength(1);
      const [call] = toolCallsOf(Prompt.fromMessages([finished!.entries[0]!.message]));
      expect(call).toMatchObject({ id: "c_pick", name: "pick-file" });
      expect(Agent.isFrontendCall(call!)).toBe(true);
      expect(events.at(-1)).toEqual({
        _tag: "Finished",
        outcome: { _tag: "Success", pendingToolCalls: [{ toolCallId: "c_pick", toolName: "pick-file" }] },
      });
    }),
  );

  it.effect("runs the server calls of a step that also calls a frontend tool, then stops", () =>
    Effect.gen(function* () {
      const { events, prompts, weatherCalls } = yield* runFrontend([
        [...pickCall, ...toolCall("c_weather", "get-weather", { location: "Paris" }), finish("tool-calls")],
      ]);
      expect(weatherCalls).toEqual(["Paris"]);
      expect(prompts).toHaveLength(1);
      expect(byTag(events, "ToolResult").map((event) => event.toolCallId)).toEqual(["c_weather"]);
      const [finished] = byTag(events, "StepFinished");
      const [pick, weather] = toolCallsOf(Prompt.fromMessages([finished!.entries[0]!.message]));
      expect([Agent.isFrontendCall(pick!), Agent.isFrontendCall(weather!)]).toEqual([true, false]);
      expect(events.at(-1)).toEqual({
        _tag: "Finished",
        outcome: { _tag: "Success", pendingToolCalls: [{ toolCallId: "c_pick", toolName: "pick-file" }] },
      });
    }),
  );

  it.effect("answers a frontend call with a failed result when the response finished incomplete", () =>
    Effect.gen(function* () {
      const { events } = yield* runFrontend([[...pickCall, finish("length")]]);
      const [result] = byTag(events, "ToolResult");
      expect(result).toMatchObject({
        toolCallId: "c_pick",
        isFailure: true,
        encodedResult: { type: "execution-interrupted" },
      });
      expect(events.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
    }),
  );

  it.effect("lists a pending frontend call on the interrupted outcome", () =>
    Effect.gen(function* () {
      const { events, emails } = yield* runFrontend([[...pickCall, ...emailCall, finish("tool-calls")]]);
      expect(emails).toEqual([]);
      const [requested] = byTag(events, "ApprovalRequested");
      expect(events.at(-1)).toEqual({
        _tag: "Finished",
        outcome: {
          _tag: "Interrupted",
          approvals: [{ approvalId: requested!.approvalId, toolCallId: "c_email", toolName: "send-email" }],
          pendingToolCalls: [{ toolCallId: "c_pick", toolName: "pick-file" }],
        },
      });
    }),
  );

  it.effect("never sends the frontend mark to the model", () =>
    Effect.gen(function* () {
      const first = yield* runFrontend([[...pickCall, finish("tool-calls")]]);
      const [finished] = byTag(first.events, "StepFinished");
      const prompt = Prompt.fromMessages([
        ...userPrompt.content,
        finished!.entries[0]!.message,
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
          const events = yield* Agent.run(weatherAgent, {
            runId: "r1",
            threadId: "t1",
            prompt: userPrompt,
            frontendTools: [PickFile],
          }).pipe(Stream.runCollect, Effect.provide([model.layer, countingWeatherLayer().layer]));
          return { events: Array.from(events), prompts: model.prompts };
        });
      const first = yield* attempt([[...toolCall("c_pick", "pick-file", {}), finish("tool-calls")]]);
      const second = yield* attempt([]);
      expect(second.prompts).toEqual([]);
      const replayedSteps = byTag(second.events, "StepFinished");
      expect(replayedSteps.every((event) => event.replayed)).toBe(true);
      expect(replayedSteps[0]!.entries).toEqual(byTag(first.events, "StepFinished")[0]!.entries);
      expect(second.events.at(-1)).toEqual(first.events.at(-1));
      expect(first.events.at(-1)).toEqual({
        _tag: "Finished",
        outcome: { _tag: "Success", pendingToolCalls: [{ toolCallId: "c_pick", toolName: "pick-file" }] },
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)), counterIds()),
      ),
    ),
  );

  it.effect("replays completed steps of a run executed again", () =>
    Effect.gen(function* () {
      const weather = countingWeatherLayer();
      const step1: Step = [
        ...text("0", "Checking."),
        ...toolCall("c1", "get-weather", { location: "Paris" }),
        finish("tool-calls"),
      ];
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: Agent.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = Agent.run(weatherAgent, { runId: "r1", threadId: "t1", prompt: userPrompt });
          const collected = yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runCollect,
            Effect.provide([model.layer, weather.layer]),
          );
          return { events: Array.from(collected), prompts: model.prompts };
        });

      // Attempt 1 stops (as if the process crashed) while step 2 is streaming.
      const first = yield* attempt(
        [step1, Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event._tag === "ModelPart" && event.step === 2,
      );
      // Attempt 2 is served step 1 from the ledger; its model is only called for step 2.
      const second = yield* attempt([[...text("0", "18°C"), finish("stop")]]);

      expect(weather.calls).toEqual(["Paris"]);
      expect(second.prompts).toHaveLength(1);
      expect(second.prompts[0]!.content.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

      const step1Of = (events: ReadonlyArray<Agent.Event>) =>
        events.filter((e) => "step" in e && e.step === 1 && e._tag !== "ModelPart");
      const original = step1Of(first.events);
      const replayed = step1Of(second.events);
      expect(replayed.map((e) => e._tag)).toEqual(["StepStarted", "ToolResult", "StepFinished"]);
      expect(replayed.every((e) => "replayed" in e && e.replayed)).toBe(true);
      expect(replayed.map((e) => ({ ...e, replayed: false }))).toEqual(original);
      expect(second.events.filter((e) => e._tag === "ModelPart" && e.step === 1)).toEqual([]);
      expect(second.events.at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)), counterIds()),
      ),
    ),
  );
});

// -----------------------------------------------------------------------------
// Tool progress
// -----------------------------------------------------------------------------

describe("Agent.run tool progress", () => {
  const progressAgent = Agent.define({ toolkit: ProgressToolkit });
  const searchCall = (query: string, sources = 2) => toolCall("c_search", "search", { query, sources });
  const ledger = Layer.mergeAll(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)), counterIds());

  const runProgress = (steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const handlers = progressLayer();
      const events = yield* Agent.run(progressAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, handlers.layer, evalLayers]),
      );
      return { events: Array.from(events), prompts: model.prompts, calls: handlers.calls };
    });

  it.effect("emits each preliminary result as progress, in order, before the call's result", () =>
    Effect.gen(function* () {
      const { events } = yield* runProgress([
        [...searchCall("docs"), finish("tool-calls")],
        [...text("0", "Found 3."), finish("stop")],
      ]);
      const stepMessageId = byTag(events, "StepStarted")[0]!.messageId;
      expect(byTag(events, "ToolProgress")).toEqual([
        {
          _tag: "ToolProgress",
          step: 1,
          messageId: stepMessageId,
          toolCallId: "c_search",
          toolName: "search",
          encodedValue: { done: 1, of: 2 },
          replayed: false,
        },
        {
          _tag: "ToolProgress",
          step: 1,
          messageId: stepMessageId,
          toolCallId: "c_search",
          toolName: "search",
          encodedValue: { done: 2, of: 2 },
          replayed: false,
        },
      ]);
      const step1 = tags(events.filter((e) => "step" in e && e.step === 1 && e._tag !== "ModelPart"));
      expect(step1).toEqual(["StepStarted", "ToolProgress", "ToolProgress", "ToolResult", "StepFinished"]);
      expect(byTag(events, "ToolResult")[0]).toMatchObject({
        encodedResult: { done: 2, of: 2, hits: 3 },
        isFailure: false,
      });
    }),
  );

  it.effect("keeps progress out of the step's entries and the next prompt", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runProgress([
        [...searchCall("docs"), finish("tool-calls")],
        [...text("0", "Found 3."), finish("stop")],
      ]);
      const results = byTag(events, "StepFinished")[0]!.entries.flatMap((entry) =>
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
      expect(byTag(events, "ToolProgress")).toHaveLength(2);
      expect(byTag(events, "ToolResult")[0]).toMatchObject({
        encodedResult: { message: "search failed" },
        isFailure: true,
      });
    }),
  );

  it.effect("reports progress that isn't an object as it is encoded", () =>
    Effect.gen(function* () {
      const { events } = yield* runProgress([
        [...toolCall("c_count", "count", { to: 3 }), finish("tool-calls")],
        [finish("stop")],
      ]);
      expect(byTag(events, "ToolProgress").map((e) => e.encodedValue)).toEqual([1, 2]);
      expect(byTag(events, "ToolResult")[0]!.encodedResult).toBe(3);
    }),
  );

  it.effect("emits no progress for a call served from the checkpoint store", () =>
    Effect.gen(function* () {
      const handlers = progressLayer();
      const attempt = (steps: ReadonlyArray<Step>) =>
        Agent.run(progressAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
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
      expect(byTag(first, "ToolProgress")).toHaveLength(2);
      expect(byTag(second, "ToolProgress")).toEqual([]);
      expect(byTag(second, "ToolResult")[0]).toMatchObject({ replayed: true, encodedResult: { hits: 3 } });
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("reports progress again, under the same step message id, when a crash makes the call run again", () =>
    Effect.gen(function* () {
      const step1: Step = [...searchCall("docs"), finish("tool-calls")];
      // Attempt 1 crashes after the call's first progress, while the handler is still running.
      const stuck = progressLayer({ between: Effect.never });
      const first = yield* Agent.run(progressAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.takeUntil((event) => event._tag === "ToolProgress"),
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
        Effect.provide([scriptedModel([step1]).layer, stuck.layer]),
      );
      // Attempt 2 is served the model step from the ledger and runs the handler again.
      const handlers = progressLayer();
      const second = yield* Agent.run(progressAgent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
        Effect.provide([scriptedModel([[...text("0", "Found 3."), finish("stop")]]).layer, handlers.layer]),
      );
      expect(stuck.calls).toEqual(["docs"]);
      expect(handlers.calls).toEqual(["docs"]);
      const before = byTag(first, "ToolProgress");
      const after = byTag(second, "ToolProgress");
      expect(before).toHaveLength(1);
      expect(after.map((e) => e.encodedValue)).toEqual([
        { done: 1, of: 2 },
        { done: 2, of: 2 },
      ]);
      expect(after.every((e) => e.messageId === before[0]!.messageId)).toBe(true);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("reports an approved call's progress in step 0 with no step message id", () =>
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
      const events = yield* Agent.run(Agent.define({ toolkit }), { runId: "r1", threadId: "t1", prompt }).pipe(
        Stream.runCollect,
        Effect.provide([
          scriptedModel([[finish("stop")]]).layer,
          toolkit.toLayer({
            "approved-search": (_, ctx) => Effect.as(ctx.preliminary({ done: 0 }), { done: 1 }),
          }),
          evalLayers,
        ]),
      );
      expect(byTag(Array.from(events), "ToolProgress")).toEqual([
        {
          _tag: "ToolProgress",
          step: 0,
          messageId: undefined,
          toolCallId: "c_approved",
          toolName: "approved-search",
          encodedValue: { done: 0 },
          replayed: false,
        },
      ]);
    }),
  );
});

// -----------------------------------------------------------------------------
// Run info and the system prompt
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
  dependencies: [Agent.CurrentRun],
});
const ConfirmedWhoAmI = Tool.make("confirmed-who-am-i", {
  parameters: Schema.Struct({}),
  success: Schema.Boolean,
  needsApproval: true,
  dependencies: [Agent.CurrentRun],
});
const RunInfoToolkit = Toolkit.make(WhoAmI, ConfirmedWhoAmI);

/** Handlers recording the run info each call sees. */
const runInfoLayer = () => {
  const seen: Array<Agent.RunInfo> = [];
  const record = () =>
    Effect.gen(function* () {
      seen.push(yield* Agent.CurrentRun);
      return true;
    });
  return { layer: RunInfoToolkit.toLayer({ "who-am-i": record, "confirmed-who-am-i": record }), seen };
};

const systemOf = (prompt: Prompt.Prompt) => {
  const first = prompt.content[0];
  return first?.role === "system" ? first.content : undefined;
};

describe("Agent.CurrentRun", () => {
  it.effect("gives tool handlers the run info, with nothing extra to provide", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...toolCall("c1", "who-am-i", {}), finish("tool-calls")], [finish("stop")]]);
      const handlers = runInfoLayer();
      yield* Agent.run(Agent.define({ toolkit: RunInfoToolkit }), {
        runId: "r1",
        threadId: "t1",
        props: { locale: "fr" },
        prompt: userPrompt,
      }).pipe(Stream.runDrain, Effect.provide([model.layer, handlers.layer, evalLayers]));
      expect(handlers.seen).toEqual([{ runId: "r1", threadId: "t1", props: { locale: "fr" } }]);
      expect(handlers.seen[0]).not.toHaveProperty("context");
    }),
  );

  it.effect("gives a call approved in step 0 the run info", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Done."), finish("stop")]]);
      const handlers = runInfoLayer();
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
      yield* Agent.run(Agent.define({ toolkit: RunInfoToolkit }), {
        runId: "r1",
        threadId: "t1",
        props: { locale: "fr" },
        prompt,
      }).pipe(Stream.runDrain, Effect.provide([model.layer, handlers.layer, evalLayers]));
      expect(handlers.seen).toEqual([{ runId: "r1", threadId: "t1", props: { locale: "fr" } }]);
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
    const run = Agent.run(agent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
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
      const events = yield* Agent.run(Agent.define({ toolkit: UserToolkit }), {
        runId: "r1",
        threadId: "t1",
        prompt: userPrompt,
      }).pipe(
        Stream.runCollect,
        Effect.provide([model.layer, userToolkitLayer, evalLayers, Layer.succeed(CurrentUser)({ userId: "u1" })]),
      );
      expect(byTag(Array.from(events), "ToolResult").map((event) => event.encodedResult)).toEqual(["u1"]);
    }),
  );
});

describe("Agent system prompt", () => {
  it("adds what the system effect needs to the requirements, except CurrentRun", () => {
    type RequirementsOf<A> = A extends Agent.Agent<infer Tools, infer R> ? Agent.Requirements<Tools, R> : never;
    const fixed = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });
    const computed = Agent.define({
      toolkit: WeatherToolkit,
      system: Effect.gen(function* () {
        const run = yield* Agent.CurrentRun;
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
      yield* Agent.run(Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." }), {
        runId: "r1",
        threadId: "t1",
        prompt: userPrompt,
      }).pipe(Stream.runDrain, Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]));
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
          yield* Agent.run(agent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
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

  it.effect("lets the system effect read the run's props", () =>
    Effect.gen(function* () {
      const model = scriptedModel([[...text("0", "Bonjour"), finish("stop")]]);
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: Effect.gen(function* () {
          const run = yield* Agent.CurrentRun;
          // Props come from the client: pick between known prompts, never interpolate them.
          return Schema.is(Schema.Struct({ locale: Schema.Literals(["fr"]) }))(run.props)
            ? "Réponds en français."
            : "Reply in English.";
        }),
      });
      yield* Agent.run(agent, { runId: "r1", threadId: "t1", props: { locale: "fr" }, prompt: userPrompt }).pipe(
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
      yield* Agent.run(Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." }), {
        runId: "r1",
        threadId: "t1",
        prompt,
      }).pipe(Stream.runDrain, Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]));
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
      const events = yield* Agent.run(
        Agent.define({ toolkit: ApprovalToolkit, system: Effect.die("directory down") }),
        {
          runId: "r1",
          threadId: "t1",
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
        },
      ).pipe(Stream.runCollect, Effect.provide([model.layer, handlers.layer, evalLayers]));
      expect(tags(Array.from(events))).toEqual(["Failed"]);
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
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: Agent.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = Agent.run(agent, { runId: "r1", threadId: "t1", prompt: userPrompt });
          yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, clock]),
          );
          return model.prompts;
        });

      // Attempt 1 stops (as if the process crashed) while step 1 is streaming.
      const first = yield* attempt(
        [Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event._tag === "ModelPart" && event.step === 1,
      );
      now = "10:00";
      const second = yield* attempt([
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);

      expect(first.map(systemOf)).toEqual(["It is 09:00."]);
      expect(second.map(systemOf)).toEqual(["It is 09:00.", "It is 09:00."]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)), counterIds()),
      ),
    ),
  );
});
