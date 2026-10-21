import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { AiError } from "effect/ai";
import type * as AgUi from "../src/AgUi.ts";
import * as Agent from "../src/Agent.ts";
import {
  counterIds,
  finish,
  scriptedModel,
  type Step,
  text,
  toolCall,
  verify,
  WeatherToolkit,
  WeatherToolkitLayer,
} from "./fixtures.ts";

const input: AgUi.RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "What is the weather in Paris?" }],
};

const runScripted = (
  steps: ReadonlyArray<Step>,
  options?: { readonly maxSteps?: number; readonly system?: string },
  runInput: AgUi.RunAgentInput = input,
) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const events = yield* Agent.run({ toolkit: WeatherToolkit, ...options })(runInput).pipe(
      Stream.runCollect,
      Effect.provide([model.layer, WeatherToolkitLayer, counterIds()]),
    );
    // Every emitted stream must pass the AG-UI client's own sequence checks.
    yield* Effect.promise(() => verify(events));
    return { events: Array.from(events), prompts: model.prompts };
  });

const types = (events: ReadonlyArray<AgUi.Event>) => events.map((event) => event.type);

const modelFailure = AiError.make({
  module: "Test",
  method: "streamText",
  reason: new AiError.UnknownError({ description: "boom" }),
});

describe("verify", () => {
  it("rejects sequences the AG-UI client would reject", async () => {
    await expect(
      verify([
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as AgUi.Event,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as AgUi.Event,
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as AgUi.Event,
      ]),
    ).rejects.toThrow(/text messages are still active/);
  });
});

describe("Agent.run", () => {
  it.effect("streams a text-only reply inside the run lifecycle", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([[...text("0", "Hel", "lo"), finish("stop")]]);
      expect(events).toEqual([
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", protocolVersion: "1.0" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "id-1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "Hel" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "lo" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "id-1" },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", outcome: { type: "success" } },
      ]);
    }),
  );

  it.effect("resolves tool calls and continues with a new step", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runScripted([
        [
          ...text("0", "Let me check."),
          ...toolCall("toolu_1", "get-weather", { location: "Paris" }, ['{"location":', '"Paris"}']),
          finish("tool-calls"),
        ],
        [...text("0", "It is 18°C."), finish("stop")],
      ]);

      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);

      const [, step1Start, , , toolStart, args1, args2, , result, step2Start] = events;
      expect(toolStart).toEqual({
        type: EventType.TOOL_CALL_START,
        toolCallId: "toolu_1",
        toolCallName: "get-weather",
        parentMessageId: (step1Start as { messageId: string }).messageId,
      });
      expect([args1, args2].map((e) => (e as { delta: string }).delta)).toEqual(['{"location":', '"Paris"}']);
      expect(result).toMatchObject({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "toolu_1",
        content: '{"temperature":18}',
      });

      // Anthropic-style part id "0" on both steps must not leak into AG-UI ids.
      const messageIds = [step1Start, result, step2Start].map((e) => (e as { messageId: string }).messageId);
      expect(new Set(messageIds).size).toBe(3);
      expect(messageIds).not.toContain("0");

      // The second model call sees the tool call and its result.
      expect(prompts).toHaveLength(2);
      const second = prompts[1]!.content;
      expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(second[2]).toMatchObject({
        content: [{ type: "tool-result", id: "toolu_1", name: "get-weather", result: { temperature: 18 } }],
      });
    }),
  );

  it.effect("returns tool failures to the model", () =>
    Effect.gen(function* () {
      const { events, prompts } = yield* runScripted([
        [...toolCall("toolu_1", "get-weather", { location: "Nowhere" }), finish("tool-calls")],
        [...text("0", "I couldn't find that place."), finish("stop")],
      ]);
      const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(result).toMatchObject({ content: '{"message":"Location \'Nowhere\' not found"}' });
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(prompts).toHaveLength(2);
    }),
  );

  it.effect("ends with RUN_ERROR when the step limit is exceeded", () =>
    Effect.gen(function* () {
      const loopingStep = [...toolCall("toolu_x", "get-weather", { location: "Paris" }), finish("tool-calls")];
      const { events, prompts } = yield* runScripted(
        [loopingStep, loopingStep.map((p) => ("id" in p ? { ...p, id: "toolu_y" } : p)), loopingStep],
        { maxSteps: 2 },
      );
      expect(prompts).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
      expect(events.at(-1)).toMatchObject({ code: "StepLimitExceeded" });
      expect((events.at(-1) as { message: string }).message).toContain("Step limit exceeded");
    }),
  );

  it.effect("closes an open text message before RUN_ERROR when the model fails", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([
        Stream.fromIterable(text("0", "partial").slice(0, 2)).pipe(Stream.concat(Stream.fail(modelFailure))),
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toMatchObject({ code: "UnknownError" });
    }),
  );

  it.effect("closes an open tool call before RUN_ERROR on an error part", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([
        [
          { type: "tool-params-start", id: "toolu_1", name: "get-weather" },
          { type: "tool-params-delta", id: "toolu_1", delta: '{"loc' },
          { type: "error", error: { message: "overloaded" } },
        ],
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toMatchObject({ message: "overloaded" });
    }),
  );

  it.effect("closes a text message the model never ended", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([[...text("0", "hi").slice(0, 2), finish("stop")]]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_FINISHED,
      ]);
    }),
  );

  it.effect("uses one message id for every text block in a step", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([[...text("0", "a"), ...text("1", "b"), finish("stop")]]);
      const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
      expect(starts).toHaveLength(2);
      expect(new Set(starts.map((e) => (e as { messageId: string }).messageId))).toEqual(new Set(["id-1"]));
    }),
  );

  it.effect("emits complete tool calls from providers that do not stream parameters", () =>
    Effect.gen(function* () {
      const { events } = yield* runScripted([
        [{ type: "tool-call", id: "call_1", name: "get-weather", params: { location: "Paris" } }, finish("tool-calls")],
        [finish("stop")],
      ]);
      expect(events.slice(1, 4)).toEqual([
        { type: EventType.TOOL_CALL_START, toolCallId: "call_1", toolCallName: "get-weather", parentMessageId: "id-1" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: '{"location":"Paris"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "call_1" },
      ]);
    }),
  );

  it.effect("sends the system prompt before the client history", () =>
    Effect.gen(function* () {
      const { prompts } = yield* runScripted([[finish("stop")]], { system: "Be helpful." });
      expect(prompts[0]!.content.map((m) => m.role)).toEqual(["system", "user"]);
    }),
  );

  it.effect("finishes with the unanswered calls as pending instead of calling the model again", () =>
    Effect.gen(function* () {
      // The provider ran this call, so the toolkit does not and no result arrives.
      const { events, prompts } = yield* runScripted([
        [
          {
            type: "tool-call",
            id: "srv_1",
            name: "get-weather",
            params: { location: "Paris" },
            providerExecuted: true,
          },
          finish("tool-calls"),
        ],
      ]);
      expect(prompts).toHaveLength(1);
      expect(events.at(-1)).toEqual({
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
        outcome: { type: "success", pendingToolCallIds: ["srv_1"] },
      });
    }),
  );

  it.effect("recovers a thread whose previous run stopped before the tool result", () =>
    Effect.gen(function* () {
      const { prompts } = yield* runScripted([[...text("0", "Sorry."), finish("stop")]], undefined, {
        ...input,
        messages: [
          { id: "u1", role: "user", content: "Weather in Paris?" },
          {
            id: "a1",
            role: "assistant",
            toolCalls: [{ id: "toolu_1", function: { name: "get-weather", arguments: '{"location":"Paris"}' } }],
          },
          { id: "u2", role: "user", content: "Hello?" },
        ],
      });
      expect(prompts[0]!.content.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
      expect(prompts[0]!.content[2]).toMatchObject({ content: [{ type: "tool-result", isFailure: true }] });
    }),
  );

  it("rejects a step limit that is not a positive integer", () => {
    for (const maxSteps of [0, -1, 1.5, Number.NaN]) {
      expect(() => Agent.run({ toolkit: WeatherToolkit, maxSteps })).toThrow(RangeError);
    }
  });
});
