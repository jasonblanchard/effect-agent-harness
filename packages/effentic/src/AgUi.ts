import { EventType } from "@ag-ui/core";
import type {
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { Schema } from "effect";

// -----------------------------------------------------------------------------
// Input
//
// Only the subset of `RunAgentInput` the agent reads is decoded. Unknown fields
// are stripped and unknown message roles pass through as plain strings so the
// converter can ignore them.
// -----------------------------------------------------------------------------

export const ToolCall = Schema.Struct({
  id: Schema.String,
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});
export type ToolCall = typeof ToolCall.Type;

export const Message = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  toolCalls: Schema.optional(Schema.Array(ToolCall)),
  toolCallId: Schema.optional(Schema.String),
});
export type Message = typeof Message.Type;

export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  messages: Schema.Array(Message),
});
export type RunAgentInput = typeof RunAgentInput.Type;

export const decodeRunAgentInput = Schema.decodeUnknownEffect(RunAgentInput);

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

export type Event =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent;

export const runStarted = (input: { readonly threadId: string; readonly runId: string }): RunStartedEvent => ({
  type: EventType.RUN_STARTED,
  threadId: input.threadId,
  runId: input.runId,
});

export const runFinished = (input: { readonly threadId: string; readonly runId: string }): RunFinishedEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId,
});

export const runError = (message: string): RunErrorEvent => ({
  type: EventType.RUN_ERROR,
  message,
});

export const textMessageStart = (messageId: string): TextMessageStartEvent => ({
  type: EventType.TEXT_MESSAGE_START,
  messageId,
  role: "assistant",
});

export const textMessageContent = (messageId: string, delta: string): TextMessageContentEvent => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
});

export const textMessageEnd = (messageId: string): TextMessageEndEvent => ({
  type: EventType.TEXT_MESSAGE_END,
  messageId,
});

export const toolCallStart = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
): ToolCallStartEvent => ({
  type: EventType.TOOL_CALL_START,
  toolCallId,
  toolCallName,
  parentMessageId,
});

export const toolCallArgs = (toolCallId: string, delta: string): ToolCallArgsEvent => ({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId,
  delta,
});

export const toolCallEnd = (toolCallId: string): ToolCallEndEvent => ({
  type: EventType.TOOL_CALL_END,
  toolCallId,
});

export const toolCallResult = (messageId: string, toolCallId: string, content: string): ToolCallResultEvent => ({
  type: EventType.TOOL_CALL_RESULT,
  messageId,
  toolCallId,
  content,
  role: "tool",
});
