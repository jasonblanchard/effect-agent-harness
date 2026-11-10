import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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

  describe("with rejoin", () => {
    const step = (id: string, callId: string): ReadonlyArray<Messages.Entry> => [
      { ...approvalCall(id, callId, `ap-${callId}`), runId: "r1" },
    ];

    it.effect("names the active run and leaves out its output", () =>
      Effect.gen(function* () {
        const thread = yield* Thread.Thread;
        yield* thread.commit("t1", "r0", [user("u0", "Hello")]);
        yield* thread.claim("t1", "r1");
        yield* thread.commit("t1", "r1", [user("u1", "Email Ada"), ...step("m1", "c1")]);

        const restored = yield* History.restore("t1", { rejoin: true });
        expect(restored.activeRun).toEqual({ runId: "r1" });
        expect(restored.messages.map((message) => message.id)).toEqual(["u0", "u1"]);
        expect(restored.interrupts).toBeUndefined();
      }).pipe(Effect.provide(Thread.layerMemory)),
    );

    it.effect("matches a plain read when no run is active", () =>
      Effect.gen(function* () {
        const thread = yield* Thread.Thread;
        yield* thread.commit("t1", "r1", [user("u1", "Email Ada"), ...step("m1", "c1")]);
        expect(yield* History.restore("t1", { rejoin: true })).toEqual(yield* History.restore("t1"));
      }).pipe(Effect.provide(Thread.layerMemory)),
    );

    it.effect("is ignored unless asked for", () =>
      Effect.gen(function* () {
        const thread = yield* Thread.Thread;
        yield* thread.claim("t1", "r1");
        yield* thread.commit("t1", "r1", [user("u1", "Email Ada"), ...step("m1", "c1")]);
        const restored = yield* History.restore("t1");
        expect(restored.activeRun).toBeUndefined();
        expect(restored.messages.map((message) => message.id)).toEqual(["u1", "m1"]);
      }).pipe(Effect.provide(Thread.layerMemory)),
    );

    it.effect("reads the claim before the thread, so a run ending between them is still joined", () => {
      const reads: Array<string> = [];
      const racing = Layer.succeed(Thread.Thread)({
        activeRun: () =>
          Effect.sync(() => {
            reads.push("activeRun");
            return "r1";
          }),
        load: () =>
          Effect.sync(() => {
            reads.push("load");
            return [{ ...user("u1", "Email Ada"), runId: "r1" }, ...step("m1", "c1")];
          }),
        claim: () => Effect.void,
        release: () => Effect.void,
        commit: () => Effect.void,
        runEnded: () => Effect.void,
      });
      return Effect.gen(function* () {
        const restored = yield* History.restore("t1", { rejoin: true });
        expect(reads).toEqual(["activeRun", "load"]);
        expect(restored.activeRun).toEqual({ runId: "r1" });
        expect(restored.messages.map((message) => message.id)).toEqual(["u1"]);
      }).pipe(Effect.provide(racing));
    });
  });

  it.effect("reads an unknown thread as empty", () =>
    Effect.gen(function* () {
      expect(yield* History.restore("nope")).toEqual({
        messages: [],
        interrupts: undefined,
        pendingToolCalls: undefined,
        activeRun: undefined,
      });
    }).pipe(Effect.provide(Thread.layerMemory)),
  );
});
