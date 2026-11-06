import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Prompt } from "effect/ai";
import * as History from "../src/History.ts";
import * as Conversions from "../src/internal/conversions.ts";
import type * as Messages from "../src/Messages.ts";
import * as Thread from "../src/Thread.ts";

const user = (id: string, text: string): Messages.Entry => ({
  id,
  message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
});

const approvalCall = (id: string, callId: string, approvalId: string): Messages.Entry => ({
  id,
  message: Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id: callId,
        name: "send-email",
        params: { to: "ada@example.com" },
        providerExecuted: false,
      }),
      Prompt.toolApprovalRequestPart({ approvalId, toolCallId: callId }),
    ],
  }),
});

describe("History.restore", () => {
  it.effect("reads a committed thread back as its entries restore", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      yield* thread.commit("t1", "r1", [user("u1", "Email Ada"), approvalCall("m1", "c1", "ap1")]);
      const restored = yield* History.restore("t1");
      expect(restored).toEqual(Conversions.restore(yield* thread.load("t1")));
      expect(restored.messages.map((message) => message.id)).toEqual(["u1", "m1"]);
      expect(restored.interrupts?.runId).toBe("r1");
    }).pipe(Effect.provide(Thread.layerMemory)),
  );

  it.effect("reads an unknown thread as empty", () =>
    Effect.gen(function* () {
      expect(yield* History.restore("nope")).toEqual({
        messages: [],
        interrupts: undefined,
        pendingToolCalls: undefined,
      });
    }).pipe(Effect.provide(Thread.layerMemory)),
  );
});
