import { Option, Schema } from "effect";
import { Prompt } from "effect/ai";
import type * as AgUi from "./AgUi.ts";

export interface ToPromptOptions {
  /** System prompt placed before the converted history. */
  readonly system?: string | undefined;
  /**
   * What to do with `system` and `developer` messages sent by the client.
   * `"drop"` (the default) ignores them, so only the server's `system` prompt
   * instructs the model; `"allow"` turns them into system instructions.
   *
   * Dropping these does not make the history trusted: the client sends all of
   * it, so it can still fabricate assistant turns and tool results.
   */
  readonly clientSystem?: "allow" | "drop" | undefined;
}

/** Result sent to the model for a tool call the history never answered. */
export const INCOMPLETE_TOOL_CALL_RESULT = "Tool call did not complete";

/**
 * Converts the AG-UI conversation sent by the client into an Effect `Prompt`.
 *
 * The server keeps no state between runs, so this is called on every run with
 * the full history. Unsupported roles (e.g. `activity`, `reasoning`) are
 * dropped, as are tool results whose call cannot be found.
 *
 * Providers reject a tool call that has no result, and a run that fails or is
 * aborted between `TOOL_CALL_END` and `TOOL_CALL_RESULT` leaves exactly that in
 * the client's history. Such calls are answered with a failed result, so one
 * broken run does not break every later run on the thread.
 */
export const toPrompt = (messages: ReadonlyArray<AgUi.Message>, options?: ToPromptOptions): Prompt.Prompt => {
  // AG-UI tool messages carry no tool name, so it is recovered from the
  // assistant tool call with the same id.
  const toolNames = new Map<string, string>();
  // Calls made by the latest assistant message that have no result yet.
  const pending = new Map<string, string>();
  const encoded: Array<Prompt.MessageEncoded> = [];

  const toolResult = (id: string, name: string, isFailure: boolean, result: unknown) => {
    encoded.push({ role: "tool", content: [{ type: "tool-result", id, name, isFailure, result }] });
  };

  const push = (message: Prompt.MessageEncoded) => {
    for (const [id, name] of pending) {
      toolResult(id, name, true, INCOMPLETE_TOOL_CALL_RESULT);
    }
    pending.clear();
    encoded.push(message);
  };

  if (options?.system !== undefined && options.system.length > 0) {
    push({ role: "system", content: options.system });
  }

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = textOf(message.content);
        if (options?.clientSystem === "allow" && text.length > 0) {
          push({ role: "system", content: text });
        }
        break;
      }
      case "user": {
        // A user message with only media parts has no text to send, and
        // providers reject empty text blocks.
        const text = textOf(message.content);
        if (text.length > 0) {
          push({ role: "user", content: text });
        }
        break;
      }
      case "assistant": {
        const content: Array<Prompt.AssistantMessagePartEncoded> = [];
        const calls: Array<[string, string]> = [];
        const text = textOf(message.content);
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        for (const toolCall of message.toolCalls ?? []) {
          if (toolNames.has(toolCall.id)) {
            continue;
          }
          toolNames.set(toolCall.id, toolCall.function.name);
          calls.push([toolCall.id, toolCall.function.name]);
          content.push({
            type: "tool-call",
            id: toolCall.id,
            name: toolCall.function.name,
            params: parseJson(toolCall.function.arguments.length > 0 ? toolCall.function.arguments : "{}"),
          });
        }
        if (content.length > 0) {
          push({ role: "assistant", content });
          for (const [id, name] of calls) {
            pending.set(id, name);
          }
        }
        break;
      }
      case "tool": {
        // Only results that directly follow their call count; anything else
        // was already answered (or never asked for).
        const id = message.toolCallId;
        const name = id === undefined ? undefined : pending.get(id);
        if (id === undefined || name === undefined) {
          break;
        }
        pending.delete(id);
        toolResult(id, name, message.error !== undefined, parseJson(textOf(message.content)));
        break;
      }
    }
  }

  for (const [id, name] of pending) {
    toolResult(id, name, true, INCOMPLETE_TOOL_CALL_RESULT);
  }

  return Prompt.make(encoded);
};

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const isTextPart = Schema.is(TextPart);

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(isTextPart)
      .map((part) => part.text)
      .join("");
  }
  return "";
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const parseJson = (value: string): unknown => Option.getOrElse(decodeJson(value), () => value);
