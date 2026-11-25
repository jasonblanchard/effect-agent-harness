import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import type { AgUiSchema } from "effect/ai";
import * as Events from "../../src/internal/events.ts";
import { closeOpen, conflateActivity } from "../../src/internal/publish.ts";
import { verify } from "../fixtures.ts";

describe("closeOpen", () => {
  it("closes the spans an aborted attempt left open", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUiSchema.Event> = [
      Events.runStarted(input),
      Events.stepStarted("step-1"),
      Events.textMessageStart("m1"),
      Events.textMessageContent("m1", "a"),
      Events.toolCallStart("c1", "get-weather", "m1"),
    ];
    const closers = closeOpen(history);
    expect(closers).toEqual([Events.textMessageEnd("m1"), Events.toolCallEnd("c1"), Events.stepFinished("step-1")]);
    await verify([...history, ...closers, Events.runFinished(input)]);
    expect(closeOpen([...history, ...closers])).toEqual([]);
  });

  it("closes a reasoning message and its span, after text and before tool calls", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUiSchema.Event> = [
      Events.runStarted(input),
      Events.stepStarted("step-1"),
      Events.textMessageStart("m1"),
      Events.reasoningStart("b1"),
      Events.reasoningMessageStart("b1"),
      Events.reasoningMessageContent("b1", "a"),
      Events.toolCallStart("c1", "get-weather", "m1"),
    ];
    const closers = closeOpen(history);
    expect(closers).toEqual([
      Events.textMessageEnd("m1"),
      Events.reasoningMessageEnd("b1"),
      Events.reasoningEnd("b1"),
      Events.toolCallEnd("c1"),
      Events.stepFinished("step-1"),
    ]);
    await verify([...history, ...closers, Events.runFinished(input)]);
    expect(closeOpen([...history, ...closers])).toEqual([]);
  });

  it("closes only the span of a log that stops between a block's two starts", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUiSchema.Event> = [
      Events.runStarted(input),
      Events.stepStarted("step-1"),
      Events.reasoningStart("b1"),
    ];
    const closers = closeOpen(history);
    expect(closers).toEqual([Events.reasoningEnd("b1"), Events.stepFinished("step-1")]);
    await verify([...history, ...closers, Events.runFinished(input)]);
  });

  it("closes only the span of a log that stops between a block's two ends", async () => {
    const input = { threadId: "t1", runId: "r1" };
    const history: Array<AgUiSchema.Event> = [
      Events.runStarted(input),
      Events.stepStarted("step-1"),
      Events.reasoningStart("b1"),
      Events.reasoningMessageStart("b1"),
      Events.reasoningMessageContent("b1", "a"),
      Events.reasoningMessageEnd("b1"),
    ];
    const closers = closeOpen(history);
    expect(closers).toEqual([Events.reasoningEnd("b1"), Events.stepFinished("step-1")]);
    await verify([...history, ...closers, Events.runFinished(input)]);
  });
});

describe("conflateActivity", () => {
  const snapshot = (messageId: string, done: number) => Events.activitySnapshot(messageId, "search", "c1", { done });
  const result = Events.toolCallResult("m9", "c1", "{}");

  it.effect("keeps only the last snapshot of each activity in a chunk, in its place", () =>
    Effect.gen(function* () {
      const chunk = [snapshot("a", 1), Events.stepStarted("step-2"), snapshot("a", 2), snapshot("b", 1), result];
      const out = Array.from(yield* Stream.make(...chunk).pipe(conflateActivity, Stream.runCollect));
      expect(out).toEqual([Events.stepStarted("step-2"), snapshot("a", 2), snapshot("b", 1), result]);
    }),
  );

  it.effect("drops nothing across chunks", () =>
    Effect.gen(function* () {
      const stream = Stream.make(snapshot("a", 1)).pipe(Stream.concat(Stream.make(snapshot("a", 2))));
      const out = Array.from(yield* stream.pipe(conflateActivity, Stream.runCollect));
      expect(out).toEqual([snapshot("a", 1), snapshot("a", 2)]);
    }),
  );
});
