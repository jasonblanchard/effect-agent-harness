import { Schema } from "effect";
import { AgUiSchema } from "effect/ai";
import type { Response, Tool } from "effect/ai";

// -----------------------------------------------------------------------------
// The AG-UI events a run emits, and what builds them. Shared by the loop
// (`Agent.run`), the runners and `History.restore`, so what a run streams and
// what a read of its thread returns come from one place. `Agent` re-exports the
// public part (`ApprovalResponse`, `isTerminal`).
// -----------------------------------------------------------------------------

/** A run's terminal event. */
export type Terminal = AgUiSchema.RunFinishedEvent | AgUiSchema.RunErrorEvent;

/** Whether the event ends a run (`RUN_FINISHED` or `RUN_ERROR`). */
export const isTerminal = (event: AgUiSchema.Event): event is Terminal =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";

// -----------------------------------------------------------------------------
// Approvals
// -----------------------------------------------------------------------------

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
 * The id of the approval request for a tool call, and of the AG-UI interrupt
 * carrying it. Derived from the call, so a client's history alone links an
 * interrupt to its call. Treat it as opaque.
 */
export const approvalIdFor = (toolCallId: string): string => `approval:${toolCallId}`;

/** A tool call waiting for the user's approval, its own or a subagent's. */
export interface Approval {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** The subagent whose call waits for approval; absent for the agent's own calls. */
  readonly subagentRunId?: string | undefined;
}

/**
 * The interrupt for a tool call waiting for approval, as `RUN_FINISHED` carries
 * it and as `History.restore` returns it for an open request. A subagent's
 * call carries the subagent's `subagentRunId`.
 */
export const approvalInterrupt = (approval: Approval): AgUiSchema.Interrupt => ({
  id: approval.approvalId,
  reason: "tool-approval",
  toolCallId: approval.toolCallId,
  message: `Approve call to ${approval.toolName}?`,
  responseSchema: approvalResponseSchema,
  ...(approval.subagentRunId === undefined ? {} : { subagentRunId: approval.subagentRunId }),
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

export const runStarted = (input: {
  readonly threadId: string;
  readonly runId: string;
}): AgUiSchema.RunStartedEvent => ({
  type: "RUN_STARTED",
  threadId: input.threadId,
  runId: input.runId,
  protocolVersion: AgUiSchema.protocolVersion,
});

export const runFinished = (
  input: { readonly threadId: string; readonly runId: string },
  outcome: AgUiSchema.RunFinishedOutcome = { type: "success" },
): AgUiSchema.RunFinishedEvent => ({
  type: "RUN_FINISHED",
  threadId: input.threadId,
  runId: input.runId,
  outcome,
});

/** `RUN_FINISHED` with the `interrupt` outcome: the run waits for the client to answer `interrupts`. */
export const runInterrupted = (
  input: { readonly threadId: string; readonly runId: string },
  interrupts: readonly [AgUiSchema.Interrupt, ...Array<AgUiSchema.Interrupt>],
): AgUiSchema.RunFinishedEvent => runFinished(input, { type: "interrupt", interrupts: [...interrupts] });

export const runError = (message: string, code?: string): AgUiSchema.RunErrorEvent =>
  code === undefined ? { type: "RUN_ERROR", message } : { type: "RUN_ERROR", message, code };

export const stepStarted = (stepName: string): AgUiSchema.StepStartedEvent => ({
  type: "STEP_STARTED",
  stepName,
});

export const stepFinished = (stepName: string): AgUiSchema.StepFinishedEvent => ({
  type: "STEP_FINISHED",
  stepName,
});

/** The AG-UI name of a model step. */
export const stepName = (step: number): string => `step-${step}`;

export const textMessageStart = (messageId: string): AgUiSchema.TextMessageStartEvent => ({
  type: "TEXT_MESSAGE_START",
  messageId,
  role: "assistant",
});

export const textMessageContent = (messageId: string, delta: string): AgUiSchema.TextMessageContentEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId,
  delta,
});

export const textMessageEnd = (messageId: string): AgUiSchema.TextMessageEndEvent => ({
  type: "TEXT_MESSAGE_END",
  messageId,
});

export const reasoningStart = (messageId: string): AgUiSchema.ReasoningStartEvent => ({
  type: "REASONING_START",
  messageId,
});

export const reasoningMessageStart = (messageId: string): AgUiSchema.ReasoningMessageStartEvent => ({
  type: "REASONING_MESSAGE_START",
  messageId,
  role: "reasoning",
});

export const reasoningMessageContent = (messageId: string, delta: string): AgUiSchema.ReasoningMessageContentEvent => ({
  type: "REASONING_MESSAGE_CONTENT",
  messageId,
  delta,
});

export const reasoningMessageEnd = (messageId: string): AgUiSchema.ReasoningMessageEndEvent => ({
  type: "REASONING_MESSAGE_END",
  messageId,
});

export const reasoningEnd = (messageId: string): AgUiSchema.ReasoningEndEvent => ({
  type: "REASONING_END",
  messageId,
});

export const toolCallStart = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
): AgUiSchema.ToolCallStartEvent => ({
  type: "TOOL_CALL_START",
  toolCallId,
  toolCallName,
  parentMessageId,
});

export const toolCallArgs = (toolCallId: string, delta: string): AgUiSchema.ToolCallArgsEvent => ({
  type: "TOOL_CALL_ARGS",
  toolCallId,
  delta,
});

export const toolCallEnd = (toolCallId: string): AgUiSchema.ToolCallEndEvent => ({
  type: "TOOL_CALL_END",
  toolCallId,
});

/** The metadata `effect/ai` puts on a failed result, and reads back from a client's tool message. */
export const FAILURE_KEY = "effect/ai";

/**
 * A tool call's result. A failed one carries `effect/ai`'s failure marker,
 * `metadata["effect/ai"]` `{ isFailure: true }`, which `effect/ai`'s own agent
 * emits and its `AgUi.toPrompt` reads, and which an AG-UI client copies onto
 * the tool message it builds.
 */
export const toolCallResult = (
  messageId: string,
  toolCallId: string,
  content: string,
  isFailure = false,
): AgUiSchema.ToolCallResultEvent => ({
  type: "TOOL_CALL_RESULT",
  messageId,
  toolCallId,
  content,
  role: "tool",
  ...(isFailure ? { metadata: { [FAILURE_KEY]: { isFailure: true } } } : {}),
});

/** A tool call's result as `TOOL_CALL_RESULT` carries it: its encoded value as JSON. */
export const resultContent = (encodedResult: unknown): string => JSON.stringify(encodedResult ?? null);

/**
 * A tool's progress as AG-UI activity: `content` is the encoded value when it
 * is a JSON object and `{ value }` otherwise (AG-UI requires an object), and
 * `metadata["effect-agent-harness:toolCallId"]` links the activity to its call
 * (prefixed, as AG-UI asks of keys a producer invents, so it can't collide).
 */
export const activitySnapshot = (
  messageId: string,
  toolName: string,
  toolCallId: string,
  encodedValue: unknown,
): AgUiSchema.ActivitySnapshotEvent => ({
  type: "ACTIVITY_SNAPSHOT",
  messageId,
  activityType: toolName,
  content: isJsonObject(encodedValue) ? encodedValue : { value: encodedValue },
  metadata: { "effect-agent-harness:toolCallId": toolCallId },
});

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const subagentFinished = (subagentRunId: string, result: unknown): AgUiSchema.SubagentFinishedEvent => ({
  type: "SUBAGENT_FINISHED",
  subagentRunId,
  // AG-UI's `result` is any JSON value except null.
  ...(result === undefined || result === null ? {} : { result: result as Schema.Json }),
  outcome: { type: "success" },
});

// -----------------------------------------------------------------------------
// Derived ids
// -----------------------------------------------------------------------------

/**
 * The message id of a tool call's activity: derived from the assistant message
 * id of the step that made the call, and the call's id, so a call executed
 * again reports under the same id and the ids of calls in different steps
 * never collide, even when a provider reuses call ids. An approved call run in
 * step 0 has no such step in its run, so its id is derived from its approval
 * id instead, which, like the approval id, assumes call ids are unique within
 * the thread. Treat the format as opaque.
 */
export const activityMessageId = (stepMessageId: string | undefined, toolCallId: string): string =>
  stepMessageId === undefined ? `${approvalIdFor(toolCallId)}:activity` : `${stepMessageId}:activity:${toolCallId}`;

/**
 * The message id of a step's `n`th reasoning block, counted from 0 among the
 * step's blocks, with or without text. Derived rather than minted, so the run
 * and `History.restore` agree with nothing stored for it. Treat the format as
 * opaque.
 */
export const reasoningMessageId = (stepMessageId: string, n: number): string => `${stepMessageId}:reasoning:${n}`;

// -----------------------------------------------------------------------------
// Attribution and markers
// -----------------------------------------------------------------------------

/** The event, attributed to `subagentRunId` when there is one. Replaces any attribution it had. */
export const attribute = (event: AgUiSchema.Event, subagentRunId: string | undefined): AgUiSchema.Event =>
  subagentRunId === undefined ? event : ({ ...event, subagentRunId } as AgUiSchema.Event);

/**
 * A child's event as its parent forwards it: attributed to the child unless a
 * deeper subagent already owns it. A subagent lifecycle event names the child
 * as the enclosing subagent unless it already names one.
 */
export const attributeToChild = (event: AgUiSchema.Event, subagentRunId: string): AgUiSchema.Event => {
  switch (event.type) {
    case "SUBAGENT_STARTED": {
      if (event.parentSubagentRunId !== undefined) {
        return event;
      }
      // Rebuilt so the enclosing subagent comes where a run naming it from the start puts it.
      const { type, subagentRunId: id, name, description, ...rest } = event;
      return {
        type,
        subagentRunId: id,
        name,
        ...(description === undefined ? {} : { description }),
        parentSubagentRunId: subagentRunId,
        ...rest,
      };
    }
    case "SUBAGENT_FINISHED":
    case "SUBAGENT_ERROR":
      return event;
    default:
      return "subagentRunId" in event && event.subagentRunId !== undefined
        ? event
        : ({ ...event, subagentRunId } as AgUiSchema.Event);
  }
};

/** The metadata key of the library's own markers on events. Runners remove it before an event leaves them. */
export const MARKER_KEY = "effect-agent-harness";

/**
 * The event, marked as replayed: work an earlier attempt checkpointed and may
 * not have published. Only a tool call's result and a subagent's lifecycle
 * events carry it; the runner decides whether to publish them.
 */
export const markReplayed = <A extends AgUiSchema.Event>(event: A): A => ({
  ...event,
  metadata: { ...event.metadata, [MARKER_KEY]: { replayed: true } },
});

/** Whether the event carries the replay marker. */
export const isReplayed = (event: AgUiSchema.Event): boolean => {
  const marker = event.metadata?.[MARKER_KEY];
  return typeof marker === "object" && marker !== null && (marker as { replayed?: unknown }).replayed === true;
};

/** The event without the library's markers, and without `metadata` if nothing else is left in it. */
export const unmarked = (event: AgUiSchema.Event): AgUiSchema.Event => {
  if (event.metadata === undefined || !(MARKER_KEY in event.metadata)) {
    return event;
  }
  const { [MARKER_KEY]: _, ...rest } = event.metadata;
  const { metadata: __, ...withoutMetadata } = event;
  return (
    Object.keys(rest).length === 0 ? withoutMetadata : { ...withoutMetadata, metadata: rest }
  ) as AgUiSchema.Event;
};

// -----------------------------------------------------------------------------
// A model step's spans
// -----------------------------------------------------------------------------

const openReasoning = (messageId: string): Array<AgUiSchema.Event> => [
  reasoningStart(messageId),
  reasoningMessageStart(messageId),
];

export const closeReasoning = (messageId: string): Array<AgUiSchema.Event> => [
  reasoningMessageEnd(messageId),
  reasoningEnd(messageId),
];

/** A reasoning block that has started and not ended. */
interface ReasoningBlock {
  readonly messageId: string;
  /** Whether its span was emitted, which waits for its first text. */
  opened: boolean;
}

/**
 * The AG-UI events of one executed model step, built from its streamed parts.
 * Provider part ids are only meaningful inside one model stream (Anthropic,
 * for example, uses the content block index), so they are used purely to
 * track which spans are open. Every AG-UI message id is the step's message id,
 * or derived from it. A block opens lazily on its first text and only its text
 * is shown, and a delta with no start is ignored, because `Prompt.fromResponseParts`
 * does the same: what the stream shows must be what `History.restore` can return.
 */
export class StepEmitter {
  private readonly openText = new Set<string>();
  private readonly openBlocks = new Map<string, ReasoningBlock>();
  private readonly openTools = new Set<string>();
  private readonly seenTools = new Set<string>();
  private reasoningBlocks = 0;
  readonly messageId: string;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /**
   * The id of the step's next reasoning block. A block with no text takes one
   * too, because `History.restore` counts it among the stored parts.
   */
  private nextReasoningId(): string {
    return reasoningMessageId(this.messageId, this.reasoningBlocks++);
  }

  /** `TOOL_CALL_END` for the call if the model left it open, as its result or progress closes it. */
  closeTool(toolCallId: string): Array<AgUiSchema.Event> {
    return this.openTools.delete(toolCallId) ? [toolCallEnd(toolCallId)] : [];
  }

  /** Closes every span still open, e.g. at step end or when the run fails. */
  close(): Array<AgUiSchema.Event> {
    const events: Array<AgUiSchema.Event> = [];
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

  /** The events a streamed part adds. */
  part(anyPart: Response.AnyPart): Array<AgUiSchema.Event> {
    // `AnyPart` is the union of every part type, encoded and decoded. A whole `reasoning` part isn't a stream
    // part, but a provider may deliver one.
    const part = anyPart as Response.StreamPart<Record<string, Tool.Any>> | Response.ReasoningPart;
    switch (part.type) {
      case "text-start": {
        const events = this.openText.size === 0 ? [textMessageStart(this.messageId)] : [];
        this.openText.add(part.id);
        return events;
      }
      case "text-delta": {
        const events: Array<AgUiSchema.Event> = [];
        if (this.openText.size === 0) {
          this.openText.add(part.id);
          events.push(textMessageStart(this.messageId));
        }
        if (part.delta.length > 0) {
          events.push(textMessageContent(this.messageId, part.delta));
        }
        return events;
      }
      case "text-end": {
        const closed = this.openText.delete(part.id) && this.openText.size === 0;
        return closed ? [textMessageEnd(this.messageId)] : [];
      }
      case "reasoning-start": {
        // A provider that reuses an open part id replaces the block, as the store does.
        const replaced = this.openBlocks.get(part.id);
        this.openBlocks.set(part.id, { messageId: this.nextReasoningId(), opened: false });
        return replaced?.opened === true ? closeReasoning(replaced.messageId) : [];
      }
      case "reasoning-delta": {
        // The store ignores a delta with no start, so showing it would show what `restore` can't return.
        const block = this.openBlocks.get(part.id);
        if (block === undefined || part.delta.length === 0) {
          return [];
        }
        const events = block.opened ? [] : openReasoning(block.messageId);
        block.opened = true;
        events.push(reasoningMessageContent(block.messageId, part.delta));
        return events;
      }
      case "reasoning-end": {
        const block = this.openBlocks.get(part.id);
        this.openBlocks.delete(part.id);
        return block?.opened === true ? closeReasoning(block.messageId) : [];
      }
      case "reasoning": {
        const messageId = this.nextReasoningId();
        return part.text.length === 0
          ? []
          : [...openReasoning(messageId), reasoningMessageContent(messageId, part.text), ...closeReasoning(messageId)];
      }
      case "tool-params-start": {
        this.seenTools.add(part.id);
        this.openTools.add(part.id);
        return [toolCallStart(part.id, part.name, this.messageId)];
      }
      case "tool-params-delta": {
        return this.openTools.has(part.id) ? [toolCallArgs(part.id, part.delta)] : [];
      }
      case "tool-params-end": {
        return this.openTools.delete(part.id) ? [toolCallEnd(part.id)] : [];
      }
      case "tool-call": {
        // Providers that do not stream parameters only emit the complete call.
        if (this.seenTools.has(part.id)) {
          return [];
        }
        this.seenTools.add(part.id);
        return [
          toolCallStart(part.id, part.name, this.messageId),
          toolCallArgs(part.id, JSON.stringify(part.params ?? {})),
          toolCallEnd(part.id),
        ];
      }
      default: {
        return [];
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------------

/** What a model step's checkpoint records of the step's token usage. */
export const StepUsage = AgUiSchema.TokenUsage;
export type StepUsage = AgUiSchema.TokenUsage;

type Counts = { -readonly [K in keyof AgUiSchema.TokenUsage as K extends `${string}Tokens` ? K : never]?: number };

/** A model step's usage as AG-UI counts it, or `undefined` if the step reported no count. */
export const usageOf = (usage: Response.Usage): StepUsage | undefined => {
  const counts: Counts = {};
  const set = (key: keyof Counts, value: number | undefined) => {
    if (value !== undefined) {
      counts[key] = value;
    }
  };
  set("inputTokens", usage.inputTokens.total);
  set("outputTokens", usage.outputTokens.total);
  set("reasoningTokens", usage.outputTokens.reasoning);
  set("cachedInputTokens", usage.inputTokens.cacheRead);
  set("cacheWriteInputTokens", usage.inputTokens.cacheWrite);
  if (usage.inputTokens.total !== undefined || usage.outputTokens.total !== undefined) {
    set("totalTokens", (usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0));
  }
  return Object.keys(counts).length === 0 ? undefined : counts;
};

/** Sums the token counts of a run's model steps, its children's included, as `AgUiServer.agent` does. */
export class UsageTotal {
  private readonly counts: Counts = {};

  add(usage: StepUsage | undefined): void {
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (key.endsWith("Tokens") && typeof value === "number") {
        const k = key as keyof Counts;
        this.counts[k] = (this.counts[k] ?? 0) + value;
      }
    }
  }

  /** The terminal event's `usage`: one entry, or nothing if no step reported a count. */
  get usage(): { readonly usage?: Array<AgUiSchema.TokenUsage> } {
    return Object.keys(this.counts).length === 0 ? {} : { usage: [{ ...this.counts }] };
  }
}
