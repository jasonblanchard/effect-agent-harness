/**
 * The private half of `Telemetry`: OpenTelemetry GenAI attribute names, and
 * the conversion of prompts and responses into the conventions' JSON message
 * formats. Every attribute name the library writes is here, so a change in
 * the conventions, which are still in development, is a change to this file.
 */
import { Prompt, Tool } from "effect/ai";
import type { Response } from "effect/ai";
import type { Tracer } from "effect";

export const Attr = {
  operationName: "gen_ai.operation.name",
  agentName: "gen_ai.agent.name",
  agentDescription: "gen_ai.agent.description",
  conversationId: "gen_ai.conversation.id",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  toolDescription: "gen_ai.tool.description",
  toolCallArguments: "gen_ai.tool.call.arguments",
  toolCallResult: "gen_ai.tool.call.result",
  systemInstructions: "gen_ai.system_instructions",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  toolDefinitions: "gen_ai.tool.definitions",
  errorType: "error.type",
  runId: "effect_agent_harness.run.id",
} as const;

/** The name of a run's root span. */
export const agentSpanName = (name: string | undefined): string =>
  name === undefined ? "invoke_agent" : `invoke_agent ${name}`;

/** The name of a tool call's span. */
export const toolSpanName = (name: string): string => `execute_tool ${name}`;

/** `error.type` on a tool span whose handler returned a failure. */
export const toolFailure = "tool_error";

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

type Part = Readonly<Record<string, unknown>>;

interface Message {
  readonly role: string;
  readonly parts: ReadonlyArray<Part>;
}

/** The conventions' modality for a media type: `image`, `video`, `audio`, or `document` for anything else. */
export const modality = (mediaType: string): string => {
  const kind = mediaType.split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : "document";
};

const toPart = (part: Prompt.Message["content"][number]): Part | undefined => {
  if (typeof part === "string") {
    return { type: "text", content: part };
  }
  switch (part.type) {
    case "text":
      return { type: "text", content: part.text };
    case "reasoning":
      return part.text.length === 0 ? undefined : { type: "reasoning", content: part.text };
    case "tool-call":
      return { type: "tool_call", id: part.id, name: part.name, arguments: part.params };
    case "tool-result":
      return { type: "tool_call_response", id: part.id, response: part.result };
    case "file":
      // The data stays out of telemetry: it can be large, and it is content a backend need not hold.
      return { type: "blob", mime_type: part.mediaType, modality: modality(part.mediaType) };
    default:
      // Approval requests and responses have no counterpart in the conventions.
      return undefined;
  }
};

const toMessage = (message: Prompt.Message): Message | undefined => {
  const content: ReadonlyArray<Prompt.Message["content"][number]> =
    typeof message.content === "string" ? [message.content] : message.content;
  const parts = content.flatMap((part) => {
    const converted = toPart(part);
    return converted === undefined ? [] : [converted];
  });
  return parts.length === 0 ? undefined : { role: message.role, parts };
};

const toMessages = (messages: ReadonlyArray<Prompt.Message>): Array<Message> =>
  messages.flatMap((message) => {
    const converted = toMessage(message);
    return converted === undefined ? [] : [converted];
  });

/** How many system messages open the prompt: the system prompt, sent ahead of the conversation. */
const leadingSystemCount = (prompt: Prompt.Prompt): number => {
  const index = prompt.content.findIndex((message) => message.role !== "system");
  return index === -1 ? prompt.content.length : index;
};

/** The system messages that open the prompt, as `gen_ai.system_instructions` text parts. */
export const systemInstructions = (prompt: Prompt.Prompt): Array<Part> =>
  prompt.content
    .slice(0, leadingSystemCount(prompt))
    .flatMap((message) => (message.role === "system" ? [{ type: "text", content: message.content }] : []));

/**
 * The rest of the prompt, as `gen_ai.input.messages`. A system message later in the conversation stays
 * where it is, as a `system` message, so the trace keeps the order the prompt was built in.
 */
export const inputMessages = (prompt: Prompt.Prompt): Array<Message> =>
  toMessages(prompt.content.slice(leadingSystemCount(prompt)));

/**
 * A model call's response, as `gen_ai.output.messages`. No `finish_reason`: the conventions deprecate it on
 * messages in favour of the span's `gen_ai.response.finish_reasons`, which the provider writes.
 */
export const outputMessages = (parts: ReadonlyArray<Response.AnyPart>): Array<Message> =>
  toMessages(Prompt.fromResponseParts(parts).content);

/** The tools offered to a model call, as `gen_ai.tool.definitions`. */
export const toolDefinitions = (tools: ReadonlyArray<Tool.Any>): Array<Part> =>
  tools.map((tool) => {
    let parameters: unknown;
    try {
      parameters = Tool.getJsonSchema(tool);
    } catch {
      // The provider has already converted it for the request; a definition without it is still useful.
      parameters = undefined;
    }
    return { type: "function", name: tool.name, description: tool.description, parameters };
  });

// -----------------------------------------------------------------------------
// Span helpers
// -----------------------------------------------------------------------------

/** Sets every attribute on the span, skipping `undefined` values. */
export const setAttributes = (span: Tracer.Span, attributes: Readonly<Record<string, unknown>>): void => {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      span.attribute(key, value);
    }
  }
};

/**
 * The value as a JSON text attribute, or no attribute when it can't be serialised. The conventions want
 * structured values for content, but Effect's OTLP exporter can only send them as text.
 */
export const jsonAttribute = (key: string, value: unknown): Record<string, string> => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? {} : { [key]: text };
  } catch {
    return {};
  }
};

/**
 * The caller's `Telemetry.SpanAttributes`, without keys in the `gen_ai.` namespace: those are the
 * library's, and a caller's value would differ between spans of the same run.
 */
export const callerAttributes = (attributes: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith("gen_ai.")));
