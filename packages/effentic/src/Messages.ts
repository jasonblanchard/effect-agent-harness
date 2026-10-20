import { Prompt } from "effect/ai";
import type * as AgUi from "./AgUi.ts";

export interface ToPromptOptions {
  /** System prompt placed before the converted history. */
  readonly system?: string | undefined;
}

/**
 * Converts the AG-UI conversation sent by the client into an Effect `Prompt`.
 *
 * The server keeps no state between runs, so this is called on every run with
 * the full history. Unsupported roles (e.g. `activity`, `reasoning`) are
 * dropped, as are tool results whose call cannot be found.
 */
export const toPrompt = (messages: ReadonlyArray<AgUi.Message>, options?: ToPromptOptions): Prompt.Prompt => {
  // AG-UI tool messages carry no tool name, so it is recovered from the
  // assistant tool call with the same id.
  const toolNames = new Map<string, string>();
  const encoded: Array<Prompt.MessageEncoded> = [];

  if (options?.system !== undefined && options.system.length > 0) {
    encoded.push({ role: "system", content: options.system });
  }

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        encoded.push({ role: "system", content: textOf(message.content) });
        break;
      }
      case "user": {
        encoded.push({ role: "user", content: textOf(message.content) });
        break;
      }
      case "assistant": {
        const content: Array<Prompt.AssistantMessagePartEncoded> = [];
        const text = textOf(message.content);
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        for (const toolCall of message.toolCalls ?? []) {
          toolNames.set(toolCall.id, toolCall.function.name);
          content.push({
            type: "tool-call",
            id: toolCall.id,
            name: toolCall.function.name,
            params: parseJson(toolCall.function.arguments.length > 0 ? toolCall.function.arguments : "{}"),
          });
        }
        if (content.length > 0) {
          encoded.push({ role: "assistant", content });
        }
        break;
      }
      case "tool": {
        const name = message.toolCallId === undefined ? undefined : toolNames.get(message.toolCallId);
        if (message.toolCallId === undefined || name === undefined) {
          break;
        }
        encoded.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: message.toolCallId,
              name,
              isFailure: false,
              result: parseJson(textOf(message.content)),
            },
          ],
        });
        break;
      }
    }
  }

  return Prompt.make(encoded);
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
