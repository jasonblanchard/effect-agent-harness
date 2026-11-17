import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as Conversions from "../src/internal/conversions.ts";
import * as Messages from "../src/Messages.ts";

const user = (id: string, text: string): Messages.Entry => ({
  id,
  message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
});

const assistantCall = (id: string, callId: string, approvalId?: string): Messages.Entry => ({
  id,
  message: Prompt.makeMessage("assistant", {
    content: [
      Prompt.makePart("tool-call", {
        id: callId,
        name: "get-weather",
        params: { location: "Paris" },
        providerExecuted: false,
      }),
      ...(approvalId === undefined ? [] : [Prompt.toolApprovalRequestPart({ approvalId, toolCallId: callId })]),
    ],
  }),
});

const toolResult = (id: string, callId: string, result: unknown): Messages.Entry => ({
  id,
  message: Prompt.makeMessage("tool", {
    content: [
      Prompt.makePart("tool-result", {
        id: callId,
        name: "get-weather",
        isFailure: false,
        result,
        providerExecuted: false,
      }),
    ],
  }),
});

/** Messages as `{ role, parts }`, dropping Effect's internal fields. */
const simplify = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => ({
    role: message.role,
    parts:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "tool-call":
                return { type: "tool-call", id: part.id };
              case "tool-result":
                return { type: "tool-result", id: part.id, result: part.result, isFailure: part.isFailure };
              default:
                return { type: part.type };
            }
          }),
  }));

describe("Messages.Entry", () => {
  it.effect("round-trips an assistant message with a tool call", () =>
    Effect.gen(function* () {
      const entry: Messages.Entry = {
        id: "m1",
        message: Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("text", { text: "Let me check." }),
            Prompt.makePart("tool-call", {
              id: "c1",
              name: "get-weather",
              params: { location: "Paris" },
              providerExecuted: false,
            }),
          ],
        }),
      };
      const encoded = yield* Schema.encodeEffect(Messages.Entry)(entry);
      const decoded = yield* Schema.decodeUnknownEffect(Messages.Entry)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(entry);
    }),
  );

  it.effect("round-trips the run id", () =>
    Effect.gen(function* () {
      const entry: Messages.Entry = { ...user("m1", "Hi"), runId: "r1" };
      const encoded = yield* Schema.encodeEffect(Messages.Entry)(entry);
      const decoded = yield* Schema.decodeUnknownEffect(Messages.Entry)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(entry);
    }),
  );
});

describe("Messages.project", () => {
  it("keeps the entries verbatim and adds no system prompt", () => {
    const summary: Messages.Entry = { id: "s", message: Prompt.makeMessage("system", { content: "Summary: ..." }) };
    expect(simplify(Messages.project([summary, user("u9", "next")]))).toEqual([
      { role: "system", parts: "Summary: ..." },
      { role: "user", parts: [{ type: "text", text: "next" }] },
    ]);
  });

  it("answers a stored tool call that never got a result with a failure", () => {
    const prompt = Messages.project([user("u1", "Weather?"), assistantCall("m1", "c1"), user("u2", "Hello?")]);
    expect(simplify(prompt)).toEqual([
      { role: "user", parts: [{ type: "text", text: "Weather?" }] },
      { role: "assistant", parts: [{ type: "tool-call", id: "c1" }] },
      {
        role: "tool",
        parts: [{ type: "tool-result", id: "c1", result: Messages.INCOMPLETE_TOOL_CALL_RESULT, isFailure: true }],
      },
      { role: "user", parts: [{ type: "text", text: "Hello?" }] },
    ]);
  });

  it("leaves a call awaiting approval to the run", () => {
    const prompt = Messages.project([user("u1", "Email Ada"), assistantCall("m1", "c1", "a1")]);
    expect(simplify(prompt).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("moves a result committed after later messages next to its call", () => {
    const prompt = Messages.project([
      assistantCall("m1", "c1", "a1"),
      user("u2", "Hello?"),
      ...Result.getOrThrow(
        Conversions.resume([assistantCall("m1", "c1", "a1")], [{ interruptId: "a1", status: "cancelled" }]),
      ),
      toolResult("t1", "c1", { type: "execution-denied", reason: "cancelled" }),
    ]);
    expect(simplify(prompt)).toEqual([
      { role: "assistant", parts: [{ type: "tool-call", id: "c1" }, { type: "tool-approval-request" }] },
      {
        role: "tool",
        parts: [
          { type: "tool-approval-response" },
          {
            type: "tool-result",
            id: "c1",
            result: { type: "execution-denied", reason: "cancelled" },
            isFailure: false,
          },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "Hello?" }] },
    ]);
  });

  describe("with subagents", () => {
    const child = Agent.subagentIdFor("c1");
    const owned = (entry: Messages.Entry): Messages.Entry => ({ ...entry, subagentRunId: child });
    const thread: ReadonlyArray<Messages.Entry> = [
      user("u1", "Research Paris"),
      assistantCall("m1", "c1"),
      owned(user("b1", "Find the weather in Paris")),
      owned(assistantCall("m2", "c2")),
      owned(toolResult("t2", "c2", { temp: 21 })),
      toolResult("t1", "c1", "21 degrees"),
    ];

    it("builds the agent's prompt from its own entries only", () => {
      expect(simplify(Messages.project(thread))).toEqual([
        { role: "user", parts: [{ type: "text", text: "Research Paris" }] },
        { role: "assistant", parts: [{ type: "tool-call", id: "c1" }] },
        { role: "tool", parts: [{ type: "tool-result", id: "c1", result: "21 degrees", isFailure: false }] },
      ]);
    });

    it("builds a subagent's prompt from the entries it owns", () => {
      expect(simplify(Messages.project(thread, child))).toEqual([
        { role: "user", parts: [{ type: "text", text: "Find the weather in Paris" }] },
        { role: "assistant", parts: [{ type: "tool-call", id: "c2" }] },
        { role: "tool", parts: [{ type: "tool-result", id: "c2", result: { temp: 21 }, isFailure: false }] },
      ]);
    });

    it("leaves a suspended subagent call to the run", () => {
      const call = assistantCall("m1", "c1");
      const suspended: Messages.Entry = {
        id: call.id,
        message: Prompt.makeMessage("assistant", {
          content: (call.message as Prompt.AssistantMessage).content.map((part) =>
            part.type === "tool-call" ? Agent.markSuspendedSubagent(part, "m1") : part,
          ),
        }),
      };
      const prompt = Messages.project([user("u1", "Research Paris"), suspended]);
      expect(simplify(prompt).map((m) => m.role)).toEqual(["user", "assistant"]);
      // The model never sees the mark.
      const [, assistant] = Agent.forModel(prompt).content;
      expect(assistant?.role === "assistant" && assistant.content[0]?.options).toEqual({});
    });
  });

  it.effect("round-trips the owning subagent", () =>
    Effect.gen(function* () {
      const entry: Messages.Entry = { ...user("m1", "Hi"), subagentRunId: Agent.subagentIdFor("c1") };
      const encoded = yield* Schema.encodeEffect(Messages.Entry)(entry);
      const decoded = yield* Schema.decodeUnknownEffect(Messages.Entry)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(entry);
    }),
  );
});
