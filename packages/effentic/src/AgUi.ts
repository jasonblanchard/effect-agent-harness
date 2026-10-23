import { EventType, PROTOCOL_VERSION } from "@ag-ui/core";
import type {
  Interrupt,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunStartedEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { Schema, Stream } from "effect";
import type { Response, Tool } from "effect/ai";
import * as Agent from "./Agent.ts";

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
  /** Set on a `tool` message whose tool call failed. */
  error: Schema.optional(Schema.String),
});
export type Message = typeof Message.Type;

/**
 * An answer to an interrupt of the previous run. For a tool approval, the call
 * is approved only when `status` is `"resolved"` and `payload.approved` is
 * `true`; anything else denies it. `payload.reason` is passed to the model as
 * the denial reason.
 */
export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optional(Schema.Unknown),
});
export type ResumeEntry = typeof ResumeEntry.Type;

export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  messages: Schema.Array(Message),
  resume: Schema.optional(Schema.Array(ResumeEntry)),
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
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent;

/** Whether the event ends a run (`RUN_FINISHED` or `RUN_ERROR`). */
export const isTerminal = (event: Event): boolean =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

export const runStarted = (input: { readonly threadId: string; readonly runId: string }): RunStartedEvent => ({
  type: EventType.RUN_STARTED,
  threadId: input.threadId,
  runId: input.runId,
  protocolVersion: PROTOCOL_VERSION,
});

export const runFinished = (
  input: { readonly threadId: string; readonly runId: string },
  outcome: RunFinishedOutcome = { type: "success" },
): RunFinishedEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: input.threadId,
  runId: input.runId,
  outcome,
});

/** `RUN_FINISHED` with the `interrupt` outcome: the run waits for the client to answer `interrupts`. */
export const runInterrupted = (
  input: { readonly threadId: string; readonly runId: string },
  interrupts: ReadonlyArray<Interrupt>,
): RunFinishedEvent => runFinished(input, { type: "interrupt", interrupts: [...interrupts] });

export const runError = (message: string, code?: string): RunErrorEvent =>
  code === undefined ? { type: EventType.RUN_ERROR, message } : { type: EventType.RUN_ERROR, message, code };

export const stepStarted = (stepName: string): StepStartedEvent => ({
  type: EventType.STEP_STARTED,
  stepName,
});

export const stepFinished = (stepName: string): StepFinishedEvent => ({
  type: EventType.STEP_FINISHED,
  stepName,
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

// -----------------------------------------------------------------------------
// Projection of a run's `Agent.Event`s to AG-UI
// -----------------------------------------------------------------------------

/**
 * Projects a run's `Agent.Event`s onto AG-UI: `RUN_STARTED`, then text
 * messages, tool calls and results inside `STEP_STARTED` / `STEP_FINISHED`,
 * ending with `RUN_FINISHED` (success or the approval interrupt) or
 * `RUN_ERROR`. Spans still open when a step ends or the run fails are closed,
 * so the sequence is always valid AG-UI.
 *
 * Replayed events are dropped: they were already published by the attempt
 * that executed them.
 *
 * `RUN_ERROR.message` carries the underlying error's message, which may include
 * provider details; callers serving untrusted clients can rewrite it by mapping
 * the stream. `RUN_ERROR.code` is the error's tag.
 */
export const fold =
  (input: { readonly threadId: string; readonly runId: string }) =>
  <E, R>(events: Stream.Stream<Agent.Event, E, R>): Stream.Stream<Event, E, R> =>
    Stream.suspend(() => {
      let current: StepState | undefined;
      const started = new Set<number>();

      const project = (event: Agent.Event): ReadonlyArray<Event> => {
        if ("replayed" in event && event.replayed) {
          return [];
        }
        switch (event._tag) {
          case "StepStarted": {
            current = new StepState(event.messageId);
            started.add(event.step);
            return [stepStarted(stepName(event.step))];
          }
          case "ModelPart": {
            return current === undefined ? [] : handlePart(current, event.part);
          }
          case "ToolResult": {
            const events: Array<Event> = [];
            if (current?.openTools.delete(event.toolCallId) === true) {
              events.push(toolCallEnd(event.toolCallId));
            }
            events.push(toolCallResult(event.messageId, event.toolCallId, JSON.stringify(event.encodedResult ?? null)));
            return events;
          }
          case "ApprovalRequested": {
            // Carried by the interrupt outcome.
            return [];
          }
          case "StepFinished": {
            const events = current?.close() ?? [];
            current = undefined;
            if (started.delete(event.step)) {
              events.push(stepFinished(stepName(event.step)));
            }
            return events;
          }
          case "Finished": {
            return event.outcome._tag === "Success"
              ? [runFinished(input)]
              : [
                  runInterrupted(
                    input,
                    event.outcome.approvals.map((approval) => ({
                      id: approval.approvalId,
                      reason: "tool-approval",
                      toolCallId: approval.toolCallId,
                      message: `Approve call to ${approval.toolName}?`,
                    })),
                  ),
                ];
          }
          case "Failed": {
            const events = current?.close() ?? [];
            current = undefined;
            events.push(runError(Agent.errorMessage(event.error), event.code));
            return events;
          }
        }
      };

      return Stream.make(runStarted(input)).pipe(Stream.concat(Stream.flattenIterable(Stream.map(events, project))));
    });

const stepName = (step: number) => `step-${step}`;

/**
 * Events that close every text message, tool call and step left open in
 * `history`, e.g. by an attempt of the run that crashed. Empty when nothing is
 * open.
 */
export const closeOpen = (history: ReadonlyArray<Event>): Array<Event> => {
  const text = new Set<string>();
  const tools = new Set<string>();
  const steps = new Set<string>();
  for (const event of history) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        text.add(event.messageId);
        break;
      case EventType.TEXT_MESSAGE_END:
        text.delete(event.messageId);
        break;
      case EventType.TOOL_CALL_START:
        tools.add(event.toolCallId);
        break;
      case EventType.TOOL_CALL_END:
        tools.delete(event.toolCallId);
        break;
      case EventType.STEP_STARTED:
        steps.add(event.stepName);
        break;
      case EventType.STEP_FINISHED:
        steps.delete(event.stepName);
        break;
    }
  }
  return [...[...text].map(textMessageEnd), ...[...tools].map(toolCallEnd), ...[...steps].map(stepFinished)];
};

// Provider part ids are only meaningful inside one model stream (Anthropic, for
// example, uses the content block index), so they are used purely to track
// which spans are open. Every AG-UI message id is the step's message id.
class StepState {
  readonly openText = new Set<string>();
  readonly openTools = new Set<string>();
  readonly seenTools = new Set<string>();
  readonly messageId: string;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** Closes every span still open, e.g. at step end or when the run fails. */
  close(): Array<Event> {
    const events: Array<Event> = [];
    if (this.openText.size > 0) {
      this.openText.clear();
      events.push(textMessageEnd(this.messageId));
    }
    for (const id of this.openTools) {
      events.push(toolCallEnd(id));
    }
    this.openTools.clear();
    return events;
  }
}

const handlePart = (state: StepState, anyPart: Response.AnyPart): ReadonlyArray<Event> => {
  // `AnyPart` is the union of every part type, encoded and decoded.
  const part = anyPart as Response.StreamPart<Record<string, Tool.Any>>;
  switch (part.type) {
    case "text-start": {
      const events = state.openText.size === 0 ? [textMessageStart(state.messageId)] : [];
      state.openText.add(part.id);
      return events;
    }
    case "text-delta": {
      const events: Array<Event> = [];
      if (state.openText.size === 0) {
        state.openText.add(part.id);
        events.push(textMessageStart(state.messageId));
      }
      if (part.delta.length > 0) {
        events.push(textMessageContent(state.messageId, part.delta));
      }
      return events;
    }
    case "text-end": {
      const closed = state.openText.delete(part.id) && state.openText.size === 0;
      return closed ? [textMessageEnd(state.messageId)] : [];
    }
    case "tool-params-start": {
      state.seenTools.add(part.id);
      state.openTools.add(part.id);
      return [toolCallStart(part.id, part.name, state.messageId)];
    }
    case "tool-params-delta": {
      return state.openTools.has(part.id) ? [toolCallArgs(part.id, part.delta)] : [];
    }
    case "tool-params-end": {
      return state.openTools.delete(part.id) ? [toolCallEnd(part.id)] : [];
    }
    case "tool-call": {
      // Providers that do not stream parameters only emit the complete call.
      if (state.seenTools.has(part.id)) {
        return [];
      }
      state.seenTools.add(part.id);
      return [
        toolCallStart(part.id, part.name, state.messageId),
        toolCallArgs(part.id, JSON.stringify(part.params ?? {})),
        toolCallEnd(part.id),
      ];
    }
    default: {
      return [];
    }
  }
};
