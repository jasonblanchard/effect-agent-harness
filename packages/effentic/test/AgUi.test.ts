import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { AiError, Prompt } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as AgUi from "../src/AgUi.ts";
import {
  ApprovalToolkit,
  countingApprovalLayer,
  evalLayers,
  finish,
  GetLocation,
  PickFile,
  scriptedModel,
  type Step,
  text,
  toolCall,
  verify,
} from "./fixtures.ts";

describe("AgUi.RunAgentInput", () => {
  it.effect("decodes a valid input", () =>
    Effect.gen(function* () {
      const input = yield* AgUi.decodeRunAgentInput({
        threadId: "t1",
        runId: "r1",
        messages: [{ id: "m1", role: "user", content: "hi" }],
      });
      expect(input.threadId).toBe("t1");
      expect(input.runId).toBe("r1");
      expect(input.messages).toEqual([{ id: "m1", role: "user", content: "hi" }]);
    }),
  );

  it.effect("accepts and ignores extra fields", () =>
    Effect.gen(function* () {
      const input = yield* AgUi.decodeRunAgentInput({
        threadId: "t1",
        runId: "r1",
        protocolVersion: "1.0",
        state: {},
        tools: [{ name: "x", description: "y", parameters: { type: "object" }, extra: true }],
        context: [],
        forwardedProps: { locale: "fr" },
        messages: [
          { id: "m1", role: "activity", activityType: "x", content: {} },
          {
            id: "m2",
            role: "assistant",
            toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
        ],
      });
      expect(Object.keys(input).sort()).toEqual(["forwardedProps", "messages", "runId", "threadId", "tools"]);
      expect(input.forwardedProps).toEqual({ locale: "fr" });
      expect(input.tools).toEqual([{ name: "x", description: "y", parameters: { type: "object" } }]);
      expect(input.messages.map((m) => m.role)).toEqual(["activity", "assistant"]);
    }),
  );

  it.effect("keeps forwarded properties of any shape unchanged", () =>
    Effect.gen(function* () {
      for (const forwardedProps of ["fr", [1, "two"], { user: { prefs: { locale: "fr" } } }]) {
        const input = yield* AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [], forwardedProps });
        expect(input.forwardedProps).toEqual(forwardedProps);
      }
      const without = yield* AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [] });
      expect("forwardedProps" in without).toBe(false);
    }),
  );

  it.effect("fails on a tool without a name", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [], tools: [{ parameters: {} }] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("decodes no tools and an empty tools list", () =>
    Effect.gen(function* () {
      const without = yield* AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [] });
      expect(without.tools).toBeUndefined();
      const empty = yield* AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [], tools: [] });
      expect(empty.tools).toEqual([]);
    }),
  );

  it.effect("decodes resume entries", () =>
    Effect.gen(function* () {
      const input = yield* AgUi.decodeRunAgentInput({
        threadId: "t1",
        runId: "r1",
        messages: [],
        resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }],
      });
      expect(input.resume).toEqual([{ interruptId: "a1", status: "resolved", payload: { approved: true } }]);
      const without = yield* AgUi.decodeRunAgentInput({ threadId: "t1", runId: "r1", messages: [] });
      expect(without.resume).toBeUndefined();
    }),
  );

  it.effect("fails when runId is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(AgUi.decodeRunAgentInput({ threadId: "t1", messages: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("AgUi events", () => {
  it("builds step events and an interrupt outcome the client accepts", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const events: Array<AgUi.Event> = [
      AgUi.runStarted(input),
      AgUi.stepStarted("step-1"),
      AgUi.stepFinished("step-1"),
      AgUi.runInterrupted(input, [{ id: "a1", reason: "tool-approval", toolCallId: "c1" }]),
    ];
    await verify(events);
    expect(events.at(-1)).toEqual({
      type: "RUN_FINISHED",
      threadId: "t1",
      runId: "r1",
      outcome: { type: "interrupt", interrupts: [{ id: "a1", reason: "tool-approval", toolCallId: "c1" }] },
    });
  });

  it("builds the approval interrupt for a tool call", () => {
    expect(AgUi.approvalInterrupt({ approvalId: "a1", toolCallId: "c1", toolName: "send-email" })).toEqual({
      id: "a1",
      reason: "tool-approval",
      toolCallId: "c1",
      message: "Approve call to send-email?",
      responseSchema: expect.objectContaining({ required: ["approved"] }),
    });
  });
});

// -----------------------------------------------------------------------------
// fold
// -----------------------------------------------------------------------------

const agent = Agent.define({ toolkit: ApprovalToolkit });
const prompt = Prompt.make([{ role: "user", content: "What is the weather in Paris?" }]);

/** Runs the core on a scripted model and projects it onto AG-UI; every sequence is verified. */
const foldRun = (steps: ReadonlyArray<Step>, frontendTools?: ReadonlyArray<AgUi.FrontendTool>) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const events = yield* Agent.run(agent)({ runId: "r1", threadId: "t1", prompt, frontendTools }).pipe(
      AgUi.fold({ threadId: "t1", runId: "r1" }),
      Stream.runCollect,
      Effect.provide([model.layer, countingApprovalLayer().layer, evalLayers]),
    );
    yield* Effect.promise(() => verify(events));
    return Array.from(events);
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

describe("AgUi.fold", () => {
  it.effect("projects a text-only reply", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "Hel", "lo"), finish("stop")]]);
      expect(events).toEqual([
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", protocolVersion: "1.0" },
        { type: EventType.STEP_STARTED, stepName: "step-1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "id-1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "Hel" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "lo" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "id-1" },
        { type: EventType.STEP_FINISHED, stepName: "step-1" },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1", outcome: { type: "success" } },
      ]);
    }),
  );

  it.effect("projects a tool step and the step after it", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [
          ...text("0", "Let me check."),
          ...toolCall("toolu_1", "get-weather", { location: "Paris" }, ['{"location":', '"Paris"}']),
          finish("tool-calls"),
        ],
        [...text("0", "It is 18°C."), finish("stop")],
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.STEP_FINISHED,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
      expect(events.filter((e) => e.type === EventType.STEP_STARTED || e.type === EventType.STEP_FINISHED)).toEqual([
        AgUi.stepStarted("step-1"),
        AgUi.stepFinished("step-1"),
        AgUi.stepStarted("step-2"),
        AgUi.stepFinished("step-2"),
      ]);
      const toolStart = events.find((e) => e.type === EventType.TOOL_CALL_START);
      expect(toolStart).toEqual({
        type: EventType.TOOL_CALL_START,
        toolCallId: "toolu_1",
        toolCallName: "get-weather",
        parentMessageId: "id-1",
      });
      const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(result).toEqual({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "id-2",
        toolCallId: "toolu_1",
        content: '{"temperature":18}',
        role: "tool",
      });
      // Anthropic-style part id "0" on both steps must not leak into AG-UI ids.
      const messageIds = events.flatMap((e) => ("messageId" in e ? [e.messageId] : []));
      expect(new Set(messageIds)).toEqual(new Set(["id-1", "id-2", "id-3"]));
    }),
  );

  it.effect("ends with an interrupt outcome when a tool needs approval", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }), finish("tool-calls")],
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
      expect(events.at(-1)).toEqual({
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "id-2",
              reason: "tool-approval",
              toolCallId: "c_email",
              message: "Approve call to send-email?",
              // The approval contract, so a generic client knows what to send.
              responseSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { approved: { type: "boolean" }, reason: { type: "string" } },
                required: ["approved"],
                additionalProperties: true,
              },
            },
          ],
        },
      });
    }),
  );

  it.effect("ends a frontend call with a success outcome naming it, and gives it no result", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...toolCall("c_pick", "pick-file", {}), finish("tool-calls")]], [PickFile]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
      expect(events.at(-1)).toEqual({
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
        outcome: { type: "success", pendingToolCallIds: ["c_pick"] },
      });
    }),
  );

  it.effect("names two frontend calls in the order they were made", () =>
    Effect.gen(function* () {
      const events = yield* foldRun(
        [[...toolCall("c_pick", "pick-file", {}), ...toolCall("c_loc", "get-location", {}), finish("tool-calls")]],
        [PickFile, GetLocation],
      );
      expect(events.at(-1)).toMatchObject({ outcome: { type: "success", pendingToolCallIds: ["c_pick", "c_loc"] } });
    }),
  );

  it.effect("leaves pendingToolCallIds off a success with nothing pending and off an interrupt", () =>
    Effect.gen(function* () {
      const plain = yield* foldRun([[...text("0", "Hi"), finish("stop")]], [PickFile]);
      expect(plain.at(-1)).toMatchObject({ outcome: { type: "success" } });
      expect("pendingToolCallIds" in (plain.at(-1) as { outcome: object }).outcome).toBe(false);

      const mixed = yield* foldRun(
        [
          [
            ...toolCall("c_pick", "pick-file", {}),
            ...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }),
            finish("tool-calls"),
          ],
        ],
        [PickFile],
      );
      const outcome = (mixed.at(-1) as { outcome: { type: string } }).outcome;
      expect(outcome.type).toBe("interrupt");
      expect("pendingToolCallIds" in outcome).toBe(false);
      expect(mixed.filter((e) => e.type === EventType.TOOL_CALL_RESULT)).toEqual([]);
    }),
  );

  it.effect("closes an open text message before RUN_ERROR when the model fails", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        Stream.fromIterable(text("0", "partial").slice(0, 2)).pipe(Stream.concat(Stream.fail(modelFailure))),
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
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
      const events = yield* foldRun([
        [
          { type: "tool-params-start", id: "toolu_1", name: "get-weather" },
          { type: "tool-params-delta", id: "toolu_1", delta: '{"loc' },
          { type: "error", error: { message: "overloaded" } },
        ],
      ]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RUN_ERROR,
      ]);
      expect(events.at(-1)).toEqual({ type: EventType.RUN_ERROR, message: "overloaded", code: "ModelStreamError" });
    }),
  );

  it.effect("answers a tool call of an incomplete response with a failed result and finishes", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...toolCall("c1", "get-weather", { location: "Paris" }), finish("length")]]);
      const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(result).toMatchObject({ toolCallId: "c1" });
      expect(JSON.parse((result as { content: string }).content)).toMatchObject({ type: "execution-interrupted" });
      expect((result as { content: string }).content).toContain("length");
      expect(types(events).indexOf(EventType.TOOL_CALL_END)).toBeLessThan(
        types(events).indexOf(EventType.TOOL_CALL_RESULT),
      );
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "success" } });
    }),
  );

  it.effect("closes a text message the model never ended", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "hi").slice(0, 2), finish("stop")]]);
      expect(types(events)).toEqual([
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
    }),
  );

  it.effect("uses one message id for every text block in a step", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "a"), ...text("1", "b"), finish("stop")]]);
      const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
      expect(starts).toHaveLength(2);
      expect(new Set(starts.map((e) => (e as { messageId: string }).messageId))).toEqual(new Set(["id-1"]));
    }),
  );

  it.effect("emits complete tool calls from providers that do not stream parameters", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [{ type: "tool-call", id: "call_1", name: "get-weather", params: { location: "Paris" } }, finish("tool-calls")],
        [finish("stop")],
      ]);
      expect(events.slice(2, 6)).toEqual([
        { type: EventType.TOOL_CALL_START, toolCallId: "call_1", toolCallName: "get-weather", parentMessageId: "id-1" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: '{"location":"Paris"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "call_1" },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "id-2",
          toolCallId: "call_1",
          content: '{"temperature":18}',
          role: "tool",
        },
      ]);
    }),
  );
});

describe("AgUi.closeOpen", () => {
  it("closes the spans an aborted attempt left open", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUi.Event> = [
      AgUi.runStarted(input),
      AgUi.stepStarted("step-1"),
      AgUi.textMessageStart("m1"),
      AgUi.textMessageContent("m1", "a"),
      AgUi.toolCallStart("c1", "get-weather", "m1"),
    ];
    const closers = AgUi.closeOpen(history);
    expect(closers).toEqual([AgUi.textMessageEnd("m1"), AgUi.toolCallEnd("c1"), AgUi.stepFinished("step-1")]);
    await verify([...history, ...closers, AgUi.runFinished(input)]);
    expect(AgUi.closeOpen([...history, ...closers])).toEqual([]);
  });
});
