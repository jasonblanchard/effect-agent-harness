import { PROTOCOL_VERSION } from "./AgUiSchema.ts";
import type {
  Interrupt,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunStartedEvent,
  StepFinishedEvent,
  StepStartedEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./AgUiSchema.ts";
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
  /** The subagent that produced the message; absent for the agent's own. */
  subagentRunId: Schema.optional(Schema.String),
});
export type Message = typeof Message.Type;

/**
 * The payload of a `resolved` answer to a tool approval. Every approval
 * interrupt carries its JSON Schema as `responseSchema`, so a generic client
 * can tell what to send.
 */
export const ApprovalResponse = Schema.Struct({
  approved: Schema.Boolean,
  /** Passed to the model as the denial reason. */
  reason: Schema.optionalKey(Schema.String),
});
export type ApprovalResponse = typeof ApprovalResponse.Type;

const approvalResponseSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...Schema.toJsonSchemaDocument(ApprovalResponse).schema,
};

/**
 * The interrupt for a tool call waiting for approval, as `RUN_FINISHED` carries
 * it and as `History.restore` returns it for an open request. A subagent's
 * call carries the subagent's `subagentRunId`.
 */
export const approvalInterrupt = (approval: {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly subagentRunId?: string | undefined;
}): Interrupt => ({
  id: approval.approvalId,
  reason: "tool-approval",
  toolCallId: approval.toolCallId,
  message: `Approve call to ${approval.toolName}?`,
  responseSchema: approvalResponseSchema,
  ...(approval.subagentRunId === undefined ? {} : { subagentRunId: approval.subagentRunId }),
});

/**
 * An answer to an interrupt of the previous run. For a tool approval, the call
 * is approved only when `status` is `"resolved"` and `payload` is an
 * {@link ApprovalResponse} with `approved: true`; anything else denies it.
 */
export const ResumeEntry = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optional(Schema.Unknown),
});
export type ResumeEntry = typeof ResumeEntry.Type;

/**
 * A frontend tool the client advertises: the model may call it, and the
 * client runs it and answers in the next run's `messages`. Set by the client,
 * so untrusted: its description and schema reach the model as sent.
 */
export const FrontendTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** A JSON Schema for the call's arguments, passed through unchecked. */
  parameters: Schema.Unknown,
});
export type FrontendTool = typeof FrontendTool.Type;

export const RunAgentInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  messages: Schema.Array(Message),
  resume: Schema.optional(Schema.Array(ResumeEntry)),
  tools: Schema.optional(Schema.Array(FrontendTool)),
  /** Passed through unchecked as the run's `props`. Set by the client, so untrusted. */
  forwardedProps: Schema.optional(Schema.Unknown),
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
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentErrorEvent;

/** Whether the event ends a run (`RUN_FINISHED` or `RUN_ERROR`). */
export const isTerminal = (event: Event): boolean => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

export const runStarted = (input: { readonly threadId: string; readonly runId: string }): RunStartedEvent => ({
  type: "RUN_STARTED",
  threadId: input.threadId,
  runId: input.runId,
  protocolVersion: PROTOCOL_VERSION,
});

export const runFinished = (
  input: { readonly threadId: string; readonly runId: string },
  outcome: RunFinishedOutcome = { type: "success" },
): RunFinishedEvent => ({
  type: "RUN_FINISHED",
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
  code === undefined ? { type: "RUN_ERROR", message } : { type: "RUN_ERROR", message, code };

export const stepStarted = (stepName: string): StepStartedEvent => ({
  type: "STEP_STARTED",
  stepName,
});

export const stepFinished = (stepName: string): StepFinishedEvent => ({
  type: "STEP_FINISHED",
  stepName,
});

export const textMessageStart = (messageId: string): TextMessageStartEvent => ({
  type: "TEXT_MESSAGE_START",
  messageId,
  role: "assistant",
});

export const textMessageContent = (messageId: string, delta: string): TextMessageContentEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId,
  delta,
});

export const textMessageEnd = (messageId: string): TextMessageEndEvent => ({
  type: "TEXT_MESSAGE_END",
  messageId,
});

export const reasoningStart = (messageId: string): ReasoningStartEvent => ({
  type: "REASONING_START",
  messageId,
});

export const reasoningMessageStart = (messageId: string): ReasoningMessageStartEvent => ({
  type: "REASONING_MESSAGE_START",
  messageId,
  role: "reasoning",
});

export const reasoningMessageContent = (messageId: string, delta: string): ReasoningMessageContentEvent => ({
  type: "REASONING_MESSAGE_CONTENT",
  messageId,
  delta,
});

export const reasoningMessageEnd = (messageId: string): ReasoningMessageEndEvent => ({
  type: "REASONING_MESSAGE_END",
  messageId,
});

export const reasoningEnd = (messageId: string): ReasoningEndEvent => ({
  type: "REASONING_END",
  messageId,
});

export const toolCallStart = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
): ToolCallStartEvent => ({
  type: "TOOL_CALL_START",
  toolCallId,
  toolCallName,
  parentMessageId,
});

export const toolCallArgs = (toolCallId: string, delta: string): ToolCallArgsEvent => ({
  type: "TOOL_CALL_ARGS",
  toolCallId,
  delta,
});

export const toolCallEnd = (toolCallId: string): ToolCallEndEvent => ({
  type: "TOOL_CALL_END",
  toolCallId,
});

export const toolCallResult = (messageId: string, toolCallId: string, content: string): ToolCallResultEvent => ({
  type: "TOOL_CALL_RESULT",
  messageId,
  toolCallId,
  content,
  role: "tool",
});

// -----------------------------------------------------------------------------
// Projection of a run's `Agent.Event`s to AG-UI
// -----------------------------------------------------------------------------

/**
 * The message id of a step's `n`th reasoning block, counted from 0 among the
 * step's blocks, with or without text. Derived rather than minted, so `fold`
 * and `History.restore` agree with nothing stored for it. Treat the format as
 * opaque.
 *
 * @internal
 */
export const reasoningMessageId = (stepMessageId: string, n: number): string => `${stepMessageId}:reasoning:${n}`;

/**
 * Projects a run's `Agent.Event`s onto AG-UI: `RUN_STARTED`, then reasoning,
 * text messages, tool calls and results inside `STEP_STARTED` /
 * `STEP_FINISHED`, ending with `RUN_FINISHED` (success, with
 * `pendingToolCallIds` naming the frontend calls left to the client, or the
 * approval interrupt) or `RUN_ERROR`. A frontend call gets no
 * `TOOL_CALL_RESULT`. Spans still open when a step ends or the run fails are
 * closed, so the sequence is always valid AG-UI.
 *
 * Each reasoning block with text is one `REASONING_START` span holding one
 * reasoning message, both under {@link reasoningMessageId}. Only its text is
 * sent: provider metadata such as a signature stays on the stored part.
 *
 * A subagent's events are tagged with its `subagentRunId`, between
 * `SUBAGENT_STARTED` (on its first event) and `SUBAGENT_ERROR` or
 * `SUBAGENT_FINISHED` (`suspended`, naming the interrupts it owns, or
 * `success`, with the result its parent receives, just before that
 * `TOOL_CALL_RESULT`). Each subagent's spans and steps are tracked apart, so
 * concurrent ones never close each other's. Its own run lifecycle is not
 * emitted.
 *
 * Replayed events are dropped: they were already published by the attempt
 * that executed them. `resumed` is the log of an earlier attempt this one
 * completes: a subagent it left open is continued without a second
 * `SUBAGENT_STARTED`, and one it closed is not closed again.
 *
 * `RUN_ERROR.message` carries the underlying error's message, which may include
 * provider details; callers serving untrusted clients can rewrite it by mapping
 * the stream. `RUN_ERROR.code` is the error's tag.
 */
export const fold =
  (
    input: { readonly threadId: string; readonly runId: string },
    options?: { readonly resumed?: ReadonlyArray<Event> | undefined },
  ) =>
  <E, R>(events: Stream.Stream<Agent.Event, E, R>): Stream.Stream<Event, E, R> =>
    Stream.suspend(() => {
      // The step state of the agent (no key) and of each subagent.
      const levels = new Map<string | undefined, { current: StepState | undefined; readonly started: Set<number> }>();
      const level = (owner: string | undefined) => {
        let found = levels.get(owner);
        if (found === undefined) {
          found = { current: undefined, started: new Set() };
          levels.set(owner, found);
        }
        return found;
      };
      const { open, closed } = subagentsIn(options?.resumed ?? []);
      // The calls whose results an earlier attempt published, when its log is known.
      const published =
        options?.resumed === undefined
          ? undefined
          : new Set(options.resumed.flatMap((e) => (e.type === "TOOL_CALL_RESULT" ? [e.toolCallId] : [])));
      // Subagents whose events an earlier attempt published.
      const replayed = new Set<string>();
      // Finished subagents waiting for their parent's result, by the call that spawned them.
      const awaitingResult = new Map<string, string>();

      // Closes the spans and steps of `owner`, as the end of a subagent or of the run requires.
      const closeLevel = (owner: string | undefined): Array<Event> => {
        const state = level(owner);
        const events = state.current?.close() ?? [];
        state.current = undefined;
        for (const step of state.started) {
          events.push(stepFinished(stepName(step)));
        }
        state.started.clear();
        return events.map((event) => attribute(event, owner));
      };

      const project = (event: Agent.Event, owner: string | undefined): ReadonlyArray<Event> => {
        if (event._tag === "Subagent") {
          return projectSubagent(event, owner);
        }
        if (event._tag === "ToolResult" && event.replayed) {
          // A step's results go out only once all its calls have finished, so an attempt can stop after a result
          // was checkpointed and before it was published. Such a result goes out now: one the earlier attempt's
          // log lacks, or one a subagent the earlier attempt left open is waiting for (it can't have been
          // published, as it follows the subagent's end).
          const finished = awaitingResult.get(event.toolCallId);
          const unpublished = published !== undefined && !published.has(event.toolCallId);
          if (finished === undefined && !unpublished) {
            return [];
          }
          const events: Array<Event> = [];
          if (finished !== undefined) {
            awaitingResult.delete(event.toolCallId);
            open.delete(finished);
            closed.add(finished);
            events.push(subagentFinished(finished, event.encodedResult));
          }
          published?.add(event.toolCallId);
          events.push(
            attribute(
              toolCallResult(event.messageId, event.toolCallId, JSON.stringify(event.encodedResult ?? null)),
              owner,
            ),
          );
          return events;
        }
        if ("replayed" in event && event.replayed) {
          return [];
        }
        const state = level(owner);
        const own = (events: ReadonlyArray<Event>) => events.map((e) => attribute(e, owner));
        switch (event._tag) {
          case "StepStarted": {
            state.current = new StepState(event.messageId);
            state.started.add(event.step);
            return own([stepStarted(stepName(event.step))]);
          }
          case "ModelPart": {
            return state.current === undefined ? [] : own(handlePart(state.current, event.part));
          }
          case "ToolResult": {
            const events: Array<Event> = [];
            if (state.current?.openTools.delete(event.toolCallId) === true) {
              events.push(attribute(toolCallEnd(event.toolCallId), owner));
            }
            const finished = awaitingResult.get(event.toolCallId);
            if (finished !== undefined) {
              awaitingResult.delete(event.toolCallId);
              open.delete(finished);
              closed.add(finished);
              events.push(subagentFinished(finished, event.encodedResult));
            }
            events.push(
              attribute(
                toolCallResult(event.messageId, event.toolCallId, JSON.stringify(event.encodedResult ?? null)),
                owner,
              ),
            );
            return events;
          }
          case "ApprovalRequested": {
            // Carried by the interrupt outcome.
            return [];
          }
          case "StepFinished": {
            const events = state.current?.close() ?? [];
            state.current = undefined;
            if (state.started.delete(event.step)) {
              events.push(stepFinished(stepName(event.step)));
            }
            return own(events);
          }
          case "Finished": {
            // Every subagent closes before the run does; one still open never got its parent's result.
            const unclosed = [...open].map((id) => subagentFinished(id, undefined));
            open.clear();
            if (event.outcome._tag === "Interrupted") {
              // AG-UI's interrupt outcome carries no pending calls: the client finds them in the stream.
              return [...unclosed, runInterrupted(input, event.outcome.approvals.map(approvalInterrupt))];
            }
            const pendingToolCallIds = event.outcome.pendingToolCalls.map((call) => call.toolCallId);
            return [
              ...unclosed,
              runFinished(
                input,
                pendingToolCallIds.length === 0 ? { type: "success" } : { type: "success", pendingToolCallIds },
              ),
            ];
          }
          case "Failed": {
            // A subagent left open is the expected shape of a failed run; spans are not.
            const events = [...levels.keys()].filter((key) => key !== undefined).flatMap(closeLevel);
            const state = level(undefined);
            events.push(...(state.current?.close() ?? []));
            state.current = undefined;
            events.push(runError(Agent.errorMessage(event.error), event.code));
            return events;
          }
        }
      };

      const projectSubagent = (
        wrapped: Extract<Agent.Event, { _tag: "Subagent" }>,
        enclosing: string | undefined,
      ): ReadonlyArray<Event> => {
        const id = wrapped.subagentRunId;
        const event = wrapped.event;
        const start = (): Array<Event> => {
          if (open.has(id) || closed.has(id)) {
            return [];
          }
          open.add(id);
          return [
            {
              type: "SUBAGENT_STARTED",
              subagentRunId: id,
              name: wrapped.name,
              ...(wrapped.description === undefined ? {} : { description: wrapped.description }),
              ...(enclosing === undefined ? {} : { parentSubagentRunId: enclosing }),
              parentToolCallId: wrapped.parentToolCallId,
              parentMessageId: wrapped.parentMessageId,
            },
          ];
        };
        if (event._tag === "Finished" || event._tag === "Failed") {
          if (!open.has(id) && (closed.has(id) || replayed.has(id))) {
            // An earlier attempt published this subagent.
            return [];
          }
          const opening = start();
          const closers = closeLevel(id);
          if (event._tag === "Failed") {
            open.delete(id);
            closed.add(id);
            return [
              ...opening,
              ...closers,
              {
                type: "SUBAGENT_ERROR",
                subagentRunId: id,
                message: Agent.errorMessage(event.error),
                ...(event.code === undefined ? {} : { code: event.code }),
              },
            ];
          }
          if (event.outcome._tag === "Interrupted") {
            open.delete(id);
            closed.add(id);
            // Only the interrupts it owns directly; a descendant's are its own.
            const interruptIds = event.outcome.approvals
              .filter((approval) => approval.subagentRunId === undefined)
              .map((approval) => approval.approvalId);
            return [
              ...opening,
              ...closers,
              {
                type: "SUBAGENT_FINISHED",
                subagentRunId: id,
                outcome: interruptIds.length === 0 ? { type: "suspended" } : { type: "suspended", interruptIds },
              },
            ];
          }
          // Finished when its parent receives the result, which carries it.
          awaitingResult.set(wrapped.parentToolCallId, id);
          return [...opening, ...closers];
        }
        if ("replayed" in event && event.replayed) {
          replayed.add(id);
          if (event._tag !== "ToolResult") {
            return [];
          }
        }
        const projected = project(event, id);
        return projected.length === 0 ? projected : [...start(), ...projected];
      };

      return Stream.make(runStarted(input)).pipe(
        Stream.concat(Stream.flattenIterable(Stream.map(events, (event) => project(event, undefined)))),
      );
    });

const stepName = (step: number) => `step-${step}`;

/** The event, attributed to `subagentRunId` when there is one. */
const attribute = (event: Event, subagentRunId: string | undefined): Event =>
  subagentRunId === undefined ? event : ({ ...event, subagentRunId } as Event);

const subagentFinished = (subagentRunId: string, result: unknown): SubagentFinishedEvent => ({
  type: "SUBAGENT_FINISHED",
  subagentRunId,
  // AG-UI's `result` is any JSON value except null.
  ...(result === undefined || result === null ? {} : { result: result as Schema.Json }),
  outcome: { type: "success" },
});

/** The subagents a log started and has not closed, and those it closed. */
const subagentsIn = (history: ReadonlyArray<Event>): { open: Set<string>; closed: Set<string> } => {
  const open = new Set<string>();
  const closed = new Set<string>();
  for (const event of history) {
    if (event.type === "SUBAGENT_STARTED") {
      open.add(event.subagentRunId);
    } else if (event.type === "SUBAGENT_FINISHED" || event.type === "SUBAGENT_ERROR") {
      open.delete(event.subagentRunId);
      closed.add(event.subagentRunId);
    }
  }
  return { open, closed };
};

/** The subagent an event is attributed to, if any. */
const ownerOf = (event: Event): string | undefined =>
  "subagentRunId" in event &&
  event.type !== "SUBAGENT_STARTED" &&
  event.type !== "SUBAGENT_FINISHED" &&
  event.type !== "SUBAGENT_ERROR"
    ? event.subagentRunId
    : undefined;

/**
 * Events that close every text message, reasoning message, reasoning span,
 * tool call and step left open in `history`, e.g. by an attempt of the run that
 * crashed, each attributed to the subagent that opened it. Empty when nothing
 * is open. Subagents are left open: the attempt that completes the run
 * continues them (see `fold`'s `resumed`).
 */
export const closeOpen = (history: ReadonlyArray<Event>): Array<Event> => {
  // Each open span's owner, by its id.
  const text = new Map<string, string | undefined>();
  // Tracked apart, because a log can stop between a block's two starts.
  const reasoningMessages = new Set<string>();
  const reasoningSpans = new Map<string, string | undefined>();
  const tools = new Map<string, string | undefined>();
  // Steps are scoped to their owner.
  const steps = new Map<string, { readonly stepName: string; readonly owner: string | undefined }>();
  const stepKey = (stepName: string, owner: string | undefined) => JSON.stringify([owner ?? null, stepName]);
  for (const event of history) {
    const owner = ownerOf(event);
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        text.set(event.messageId, owner);
        break;
      case "TEXT_MESSAGE_END":
        text.delete(event.messageId);
        break;
      case "REASONING_START":
        reasoningSpans.set(event.messageId, owner);
        break;
      case "REASONING_END":
        reasoningSpans.delete(event.messageId);
        break;
      case "REASONING_MESSAGE_START":
        reasoningMessages.add(event.messageId);
        break;
      case "REASONING_MESSAGE_END":
        reasoningMessages.delete(event.messageId);
        break;
      case "TOOL_CALL_START":
        tools.set(event.toolCallId, owner);
        break;
      case "TOOL_CALL_END":
        tools.delete(event.toolCallId);
        break;
      case "STEP_STARTED":
        steps.set(stepKey(event.stepName, owner), { stepName: event.stepName, owner });
        break;
      case "STEP_FINISHED":
        steps.delete(stepKey(event.stepName, owner));
        break;
    }
  }
  return [
    ...[...text].map(([id, owner]) => attribute(textMessageEnd(id), owner)),
    ...[...reasoningSpans].flatMap(([id, owner]) =>
      (reasoningMessages.has(id) ? closeReasoning(id) : [reasoningEnd(id)]).map((event) => attribute(event, owner)),
    ),
    ...[...tools].map(([id, owner]) => attribute(toolCallEnd(id), owner)),
    ...[...steps.values()].map(({ stepName, owner }) => attribute(stepFinished(stepName), owner)),
  ];
};

const openReasoning = (messageId: string): Array<Event> => [
  reasoningStart(messageId),
  reasoningMessageStart(messageId),
];

const closeReasoning = (messageId: string): Array<Event> => [reasoningMessageEnd(messageId), reasoningEnd(messageId)];

/** A reasoning block that has started and not ended. */
interface ReasoningBlock {
  readonly messageId: string;
  /** Whether its span was emitted, which waits for its first text. */
  opened: boolean;
}

// Provider part ids are only meaningful inside one model stream (Anthropic, for
// example, uses the content block index), so they are used purely to track
// which spans are open. Every AG-UI message id is the step's message id, or
// derived from it.
class StepState {
  readonly openText = new Set<string>();
  readonly openBlocks = new Map<string, ReasoningBlock>();
  readonly openTools = new Set<string>();
  readonly seenTools = new Set<string>();
  readonly messageId: string;
  private reasoningBlocks = 0;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /**
   * The id of the step's next reasoning block. A block with no text takes one
   * too, because `History.restore` counts it among the stored parts.
   */
  nextReasoningId(): string {
    return reasoningMessageId(this.messageId, this.reasoningBlocks++);
  }

  /** Closes every span still open, e.g. at step end or when the run fails. */
  close(): Array<Event> {
    const events: Array<Event> = [];
    if (this.openText.size > 0) {
      this.openText.clear();
      events.push(textMessageEnd(this.messageId));
    }
    for (const block of this.openBlocks.values()) {
      if (block.opened) {
        events.push(...closeReasoning(block.messageId));
      }
    }
    this.openBlocks.clear();
    for (const id of this.openTools) {
      events.push(toolCallEnd(id));
    }
    this.openTools.clear();
    return events;
  }
}

const handlePart = (state: StepState, anyPart: Response.AnyPart): ReadonlyArray<Event> => {
  // `AnyPart` is the union of every part type, encoded and decoded. A whole
  // `reasoning` part isn't a stream part, but `ModelPart` may carry one.
  const part = anyPart as Response.StreamPart<Record<string, Tool.Any>> | Response.ReasoningPart;
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
    case "reasoning-start": {
      // A provider that reuses an open part id replaces the block, as the store does.
      const replaced = state.openBlocks.get(part.id);
      state.openBlocks.set(part.id, { messageId: state.nextReasoningId(), opened: false });
      return replaced?.opened === true ? closeReasoning(replaced.messageId) : [];
    }
    case "reasoning-delta": {
      // The store ignores a delta with no start, so showing it would show what `restore` can't return.
      const block = state.openBlocks.get(part.id);
      if (block === undefined || part.delta.length === 0) {
        return [];
      }
      const events = block.opened ? [] : openReasoning(block.messageId);
      block.opened = true;
      events.push(reasoningMessageContent(block.messageId, part.delta));
      return events;
    }
    case "reasoning-end": {
      const block = state.openBlocks.get(part.id);
      state.openBlocks.delete(part.id);
      return block?.opened === true ? closeReasoning(block.messageId) : [];
    }
    case "reasoning": {
      const messageId = state.nextReasoningId();
      return part.text.length === 0
        ? []
        : [...openReasoning(messageId), reasoningMessageContent(messageId, part.text), ...closeReasoning(messageId)];
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
