import { describe, expect, it } from "@effect/vitest";
import type * as AgUi from "../src/AgUi.ts";
import * as Messages from "../src/Messages.ts";

const simplify = (messages: ReadonlyArray<AgUi.Message>, system?: string) =>
  Messages.toPrompt(messages, { system }).content.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "tool-call":
                return { type: "tool-call", id: part.id, name: part.name, params: part.params };
              case "tool-result":
                return { type: "tool-result", id: part.id, name: part.name, result: part.result };
              default:
                return { type: part.type };
            }
          }),
  }));

describe("Messages.toPrompt", () => {
  it("converts a multi-turn conversation with a tool call", () => {
    const result = simplify([
      { id: "u1", role: "user", content: "Weather in Paris?" },
      {
        id: "a1",
        role: "assistant",
        content: "Let me check.",
        toolCalls: [{ id: "toolu_1", function: { name: "get-weather", arguments: '{"location":"Paris"}' } }],
      },
      { id: "t1", role: "tool", toolCallId: "toolu_1", content: '{"temperature":18}' },
      { id: "a2", role: "assistant", content: "It is 18°C." },
      { id: "u2", role: "user", content: "And tomorrow?" },
    ]);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "Weather in Paris?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool-call", id: "toolu_1", name: "get-weather", params: { location: "Paris" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", id: "toolu_1", name: "get-weather", result: { temperature: 18 } }],
      },
      { role: "assistant", content: [{ type: "text", text: "It is 18°C." }] },
      { role: "user", content: [{ type: "text", text: "And tomorrow?" }] },
    ]);
  });

  it("prepends the system prompt and maps system/developer messages", () => {
    const result = simplify(
      [
        { id: "d1", role: "developer", content: "Be brief." },
        { id: "u1", role: "user", content: "hi" },
      ],
      "You are helpful.",
    );
    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("drops unsupported roles and orphan tool results", () => {
    const result = simplify([
      { id: "x1", role: "activity", content: { anything: true } },
      { id: "x2", role: "reasoning", content: "thinking" },
      { id: "t1", role: "tool", toolCallId: "missing", content: "{}" },
      { id: "u1", role: "user", content: "hi" },
    ]);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("extracts text from content parts and keeps non-JSON tool content as a string", () => {
    const result = simplify([
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      },
      { id: "a1", role: "assistant", toolCalls: [{ id: "c1", function: { name: "f", arguments: "" } }] },
      { id: "t1", role: "tool", toolCallId: "c1", content: "not json" },
    ]);
    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "ab" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "f", params: {} }] },
      { role: "tool", content: [{ type: "tool-result", id: "c1", name: "f", result: "not json" }] },
    ]);
  });
});
