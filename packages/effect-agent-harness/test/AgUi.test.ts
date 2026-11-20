import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Stream } from "effect";
import { AgUiSchema, AiError, Prompt } from "effect/ai";
import type { Response } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as AgUi from "../src/AgUi.ts";
import {
  ApprovalToolkit,
  countingApprovalLayer,
  evalLayers,
  finish,
  GetLocation,
  PickFile,
  reasoning,
  scriptedModel,
  signature,
  type Step,
  text,
  toolCall,
  verify,
  wholeReasoning,
} from "./fixtures.ts";

// The run input is `effect/ai`'s schema. These pin the parts of it the runners rely on.
describe("AgUiSchema.RunAgentInput", () => {
  const decode = Schema.decodeUnknownEffect(AgUiSchema.RunAgentInput);
  const minimal = { threadId: "t1", runId: "r1", messages: [] };

  it.effect("decodes a valid input", () =>
    Effect.gen(function* () {
      const input = yield* decode({ ...minimal, messages: [{ id: "m1", role: "user", content: "hi" }] });
      expect(input.threadId).toBe("t1");
      expect(input.runId).toBe("r1");
      expect(input.messages).toEqual([{ id: "m1", role: "user", content: "hi" }]);
    }),
  );

  it.effect("accepts the fields the run ignores", () =>
    Effect.gen(function* () {
      const input = yield* decode({
        ...minimal,
        protocolVersion: "1.0",
        parentRunId: "r0",
        state: { step: 1 },
        context: [{ description: "Locale", value: "fr" }],
        messages: [{ id: "m1", role: "user", content: "hi" }],
      });
      expect(input).toMatchObject({ protocolVersion: "1.0", parentRunId: "r0", state: { step: 1 } });
      expect(input.context).toEqual([{ description: "Locale", value: "fr" }]);
    }),
  );

  it.effect("keeps forwarded properties of any shape unchanged", () =>
    Effect.gen(function* () {
      for (const forwardedProps of ["fr", [1, "two"], { user: { prefs: { locale: "fr" } } }]) {
        const input = yield* decode({ ...minimal, forwardedProps });
        expect(input.forwardedProps).toEqual(forwardedProps);
      }
      const without = yield* decode(minimal);
      expect("forwardedProps" in without).toBe(false);
    }),
  );

  it.effect("fails on a tool without a name or without a description", () =>
    Effect.gen(function* () {
      for (const tool of [
        { description: "Pick", parameters: {} },
        { name: "pick-file", parameters: {} },
      ]) {
        const exit = yield* Effect.exit(decode({ ...minimal, tools: [tool] }));
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("decodes no tools and an empty tools list as no frontend tools", () =>
    Effect.gen(function* () {
      expect((yield* decode(minimal)).tools).toEqual([]);
      expect((yield* decode({ ...minimal, tools: [] })).tools).toEqual([]);
    }),
  );

  it.effect("decodes resume entries", () =>
    Effect.gen(function* () {
      const input = yield* decode({
        ...minimal,
        resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }],
      });
      expect(input.resume).toEqual([{ interruptId: "a1", status: "resolved", payload: { approved: true } }]);
      expect((yield* decode(minimal)).resume).toBeUndefined();
    }),
  );

  it.effect("drops a message whose role the protocol doesn't define", () =>
    Effect.gen(function* () {
      const input = yield* decode({
        ...minimal,
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "x1", role: "narrator", content: "meanwhile" },
          { id: "u2", role: "user", content: "again" },
        ],
      });
      expect(input.messages.map((message) => message.id)).toEqual(["u1", "u2"]);
    }),
  );

  it.effect("fails when runId is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decode({ threadId: "t1", messages: [] }));
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
const foldRun = (steps: ReadonlyArray<Step>, frontendTools?: ReadonlyArray<Agent.FrontendTool>) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const events = yield* Agent.run(agent, { runId: "r1", threadId: "t1", prompt, frontendTools }).pipe(
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
  it("rejects an event the AG-UI schema does not declare", async () => {
    await expect(
      verify([{ ...AgUi.runStarted({ threadId: "t1", runId: "r1" }), extra: true } as AgUi.Event]),
    ).rejects.toThrow(/extra/);
  });

  it("rejects sequences the AG-UI client would reject", async () => {
    await expect(
      verify([
        { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
      ]),
    ).rejects.toThrow(/text messages are still active/);
  });
});

describe("AgUi.fold", () => {
  it.effect("projects a text-only reply", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "Hel", "lo"), finish("stop")]]);
      expect(events).toEqual([
        { type: "RUN_STARTED", threadId: "t1", runId: "r1", protocolVersion: "1.0" },
        { type: "STEP_STARTED", stepName: "step-1" },
        { type: "TEXT_MESSAGE_START", messageId: "id-1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "id-1", delta: "Hel" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "id-1", delta: "lo" },
        { type: "TEXT_MESSAGE_END", messageId: "id-1" },
        { type: "STEP_FINISHED", stepName: "step-1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: { type: "success" } },
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
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "STEP_FINISHED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events.filter((e) => e.type === "STEP_STARTED" || e.type === "STEP_FINISHED")).toEqual([
        AgUi.stepStarted("step-1"),
        AgUi.stepFinished("step-1"),
        AgUi.stepStarted("step-2"),
        AgUi.stepFinished("step-2"),
      ]);
      const toolStart = events.find((e) => e.type === "TOOL_CALL_START");
      expect(toolStart).toEqual({
        type: "TOOL_CALL_START",
        toolCallId: "toolu_1",
        toolCallName: "get-weather",
        parentMessageId: "id-1",
      });
      const result = events.find((e) => e.type === "TOOL_CALL_RESULT");
      expect(result).toEqual({
        type: "TOOL_CALL_RESULT",
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
        "RUN_STARTED",
        "STEP_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events.at(-1)).toEqual({
        type: "RUN_FINISHED",
        threadId: "t1",
        runId: "r1",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: Agent.approvalIdFor("c_email"),
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
        "RUN_STARTED",
        "STEP_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
      expect(events.at(-1)).toEqual({
        type: "RUN_FINISHED",
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
      expect(mixed.filter((e) => e.type === "TOOL_CALL_RESULT")).toEqual([]);
    }),
  );

  it.effect("closes an open text message before RUN_ERROR when the model fails", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        Stream.fromIterable(text("0", "partial").slice(0, 2)).pipe(Stream.concat(Stream.fail(modelFailure))),
      ]);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_ERROR",
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
        "RUN_STARTED",
        "STEP_STARTED",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "RUN_ERROR",
      ]);
      expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "overloaded", code: "ModelStreamError" });
    }),
  );

  it.effect("answers a tool call of an incomplete response with a failed result and finishes", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...toolCall("c1", "get-weather", { location: "Paris" }), finish("length")]]);
      const result = events.find((e) => e.type === "TOOL_CALL_RESULT");
      expect(result).toMatchObject({ toolCallId: "c1" });
      expect(JSON.parse((result as { content: string }).content)).toMatchObject({ type: "execution-interrupted" });
      expect((result as { content: string }).content).toContain("length");
      expect(types(events).indexOf("TOOL_CALL_END")).toBeLessThan(types(events).indexOf("TOOL_CALL_RESULT"));
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
    }),
  );

  it.effect("closes a text message the model never ended", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "hi").slice(0, 2), finish("stop")]]);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
    }),
  );

  it.effect("uses one message id for every text block in a step", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...text("0", "a"), ...text("1", "b"), finish("stop")]]);
      const starts = events.filter((e) => e.type === "TEXT_MESSAGE_START");
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
        { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "get-weather", parentMessageId: "id-1" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: '{"location":"Paris"}' },
        { type: "TOOL_CALL_END", toolCallId: "call_1" },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "id-2",
          toolCallId: "call_1",
          content: '{"temperature":18}',
          role: "tool",
        },
      ]);
    }),
  );
});

describe("AgUi.fold reasoning", () => {
  const block = (messageId: string, ...deltas: ReadonlyArray<string>): ReadonlyArray<AgUi.Event> => [
    AgUi.reasoningStart(messageId),
    AgUi.reasoningMessageStart(messageId),
    ...deltas.map((delta) => AgUi.reasoningMessageContent(messageId, delta)),
    AgUi.reasoningMessageEnd(messageId),
    AgUi.reasoningEnd(messageId),
  ];
  const first = AgUi.reasoningMessageId("id-1", 0);
  const second = AgUi.reasoningMessageId("id-1", 1);

  /** The events of one step's parts, without the run and step events around them. */
  const stepEvents = (events: ReadonlyArray<AgUi.Event>) => events.slice(2, -2);

  it.effect("streams a reasoning block before the reply, span and message sharing an id", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...reasoning("0", ["Let", " me think"]), ...text("1", "Hi"), finish("stop")]]);
      expect(stepEvents(events)).toEqual([
        { type: "REASONING_START", messageId: first },
        { type: "REASONING_MESSAGE_START", messageId: first, role: "reasoning" },
        { type: "REASONING_MESSAGE_CONTENT", messageId: first, delta: "Let" },
        { type: "REASONING_MESSAGE_CONTENT", messageId: first, delta: " me think" },
        { type: "REASONING_MESSAGE_END", messageId: first },
        { type: "REASONING_END", messageId: first },
        AgUi.textMessageStart("id-1"),
        AgUi.textMessageContent("id-1", "Hi"),
        AgUi.textMessageEnd("id-1"),
      ]);
    }),
  );

  it.effect("emits a block delivered whole with one content event", () =>
    Effect.gen(function* () {
      const part = (part: Response.AnyPart): Agent.Event => ({
        _tag: "ModelPart",
        step: 1,
        messageId: "m1",
        part,
        replayed: false,
      });
      const input = { threadId: "t1", runId: "r1" };
      const events = Array.from(
        yield* Stream.fromIterable<Agent.Event>([
          { _tag: "StepStarted", step: 1, messageId: "m1", replayed: false },
          // No text, so nothing shows, but it takes its place among the step's blocks.
          part(wholeReasoning("")),
          part(wholeReasoning("Done thinking")),
          { _tag: "StepFinished", step: 1, entries: [], replayed: false },
          { _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } },
        ]).pipe(AgUi.fold(input), Stream.runCollect),
      );
      yield* Effect.promise(() => verify(events));
      expect(stepEvents(events)).toEqual(block(AgUi.reasoningMessageId("m1", 1), "Done thinking"));
    }),
  );

  it.effect("emits nothing for a block with no text, and never a signature", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [
          ...reasoning("0", [], signature("sig-redacted")),
          ...reasoning("1", ["", "Thinking"], signature("sig-signed")),
          ...text("2", "Hi"),
          finish("stop"),
        ],
      ]);
      expect(stepEvents(events).slice(0, 5)).toEqual(block(second, "Thinking"));
      expect(JSON.stringify(events)).not.toContain("sig-");
    }),
  );

  it.effect("ignores a delta for a block that never started, as the store does", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[{ type: "reasoning-delta", id: "9", delta: "stray" }, finish("stop")]]);
      expect(types(events).filter((type) => type.startsWith("REASONING"))).toEqual([]);
    }),
  );

  it.effect("gives each block its own id, with text between them", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [...reasoning("0", ["a"]), ...text("1", "Hi"), ...reasoning("2", ["b"]), finish("stop")],
      ]);
      expect(stepEvents(events)).toEqual([
        ...block(first, "a"),
        AgUi.textMessageStart("id-1"),
        AgUi.textMessageContent("id-1", "Hi"),
        AgUi.textMessageEnd("id-1"),
        ...block(second, "b"),
      ]);
      expect(first).not.toBe(second);
      expect([first, second]).not.toContain("id-1");
    }),
  );

  it.effect("numbers blocks from 0 in each step", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [...reasoning("0", ["a"]), ...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...reasoning("0", ["b"]), ...text("1", "18°C"), finish("stop")],
      ]);
      expect(events.flatMap((e) => (e.type === "REASONING_START" ? [e.messageId] : []))).toEqual([
        first,
        AgUi.reasoningMessageId("id-3", 0),
      ]);
    }),
  );

  it.effect("keeps blocks that overlap apart", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [
          { type: "reasoning-start", id: "0" },
          { type: "reasoning-start", id: "1" },
          { type: "reasoning-delta", id: "0", delta: "a" },
          { type: "reasoning-delta", id: "1", delta: "b" },
          { type: "reasoning-end", id: "0" },
          { type: "reasoning-end", id: "1" },
          finish("stop"),
        ],
      ]);
      expect(events.flatMap((e) => (e.type === "REASONING_MESSAGE_CONTENT" ? [[e.messageId, e.delta]] : []))).toEqual([
        [first, "a"],
        [second, "b"],
      ]);
    }),
  );

  it.effect("closes a block whose part id is started again", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...reasoning("0", ["a"]).slice(0, 2), ...reasoning("0", ["b"]), finish("stop")]]);
      expect(stepEvents(events)).toEqual([...block(first, "a"), ...block(second, "b")]);
    }),
  );

  it.effect("closes open reasoning before RUN_ERROR when the model fails", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        Stream.fromIterable(reasoning("0", ["partial"]).slice(0, 2)).pipe(Stream.concat(Stream.fail(modelFailure))),
      ]);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "RUN_ERROR",
      ]);
    }),
  );

  it.effect("closes reasoning the model never ended before STEP_FINISHED", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([[...reasoning("0", ["hmm"]).slice(0, 2), finish("stop")]]);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
    }),
  );

  it.effect("closes open text, then reasoning, then tool calls", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [
          ...text("0", "partial").slice(0, 2),
          ...reasoning("1", ["hmm"]).slice(0, 2),
          { type: "tool-params-start", id: "toolu_1", name: "get-weather" },
          { type: "error", error: { message: "overloaded" } },
        ],
      ]);
      expect(types(events).slice(-5)).toEqual([
        "TEXT_MESSAGE_END",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TOOL_CALL_END",
        "RUN_ERROR",
      ]);
    }),
  );

  it.effect("emits no reasoning for a model that produces none", () =>
    Effect.gen(function* () {
      const events = yield* foldRun([
        [...text("0", "Let me check."), ...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ]);
      expect(types(events).filter((type) => type.startsWith("REASONING"))).toEqual([]);
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

  it("closes a reasoning message and its span, after text and before tool calls", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUi.Event> = [
      AgUi.runStarted(input),
      AgUi.stepStarted("step-1"),
      AgUi.textMessageStart("m1"),
      AgUi.reasoningStart("b1"),
      AgUi.reasoningMessageStart("b1"),
      AgUi.reasoningMessageContent("b1", "a"),
      AgUi.toolCallStart("c1", "get-weather", "m1"),
    ];
    const closers = AgUi.closeOpen(history);
    expect(closers).toEqual([
      AgUi.textMessageEnd("m1"),
      AgUi.reasoningMessageEnd("b1"),
      AgUi.reasoningEnd("b1"),
      AgUi.toolCallEnd("c1"),
      AgUi.stepFinished("step-1"),
    ]);
    await verify([...history, ...closers, AgUi.runFinished(input)]);
    expect(AgUi.closeOpen([...history, ...closers])).toEqual([]);
  });

  it("closes only the span of a log that stops between a block's two starts", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUi.Event> = [AgUi.runStarted(input), AgUi.stepStarted("step-1"), AgUi.reasoningStart("b1")];
    const closers = AgUi.closeOpen(history);
    expect(closers).toEqual([AgUi.reasoningEnd("b1"), AgUi.stepFinished("step-1")]);
    await verify([...history, ...closers, AgUi.runFinished(input)]);
  });

  it("closes only the span of a log that stops between a block's two ends", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUi.Event> = [
      AgUi.runStarted(input),
      AgUi.stepStarted("step-1"),
      AgUi.reasoningStart("b1"),
      AgUi.reasoningMessageStart("b1"),
      AgUi.reasoningMessageContent("b1", "a"),
      AgUi.reasoningMessageEnd("b1"),
    ];
    const closers = AgUi.closeOpen(history);
    expect(closers).toEqual([AgUi.reasoningEnd("b1"), AgUi.stepFinished("step-1")]);
    await verify([...history, ...closers, AgUi.runFinished(input)]);
  });
});
