import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as AgUi from "../src/AgUi.ts";

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
        tools: [{ name: "x", description: "y" }],
        context: [],
        forwardedProps: {},
        messages: [
          { id: "m1", role: "activity", activityType: "x", content: {} },
          {
            id: "m2",
            role: "assistant",
            toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
        ],
      });
      expect(Object.keys(input).sort()).toEqual(["messages", "runId", "threadId"]);
      expect(input.messages.map((m) => m.role)).toEqual(["activity", "assistant"]);
    }),
  );

  it.effect("fails when runId is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(AgUi.decodeRunAgentInput({ threadId: "t1", messages: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
