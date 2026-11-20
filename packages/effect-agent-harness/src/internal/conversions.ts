import type { AgUiSchema } from "effect/ai";
import { Option, Result, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "../Agent.ts";
import * as AgUi from "../AgUi.ts";
import type { Entry } from "../Messages.ts";

// -----------------------------------------------------------------------------
// The private half of `Messages`: the conversions the two histories run. Not
// exported from the package. Under the client history, the run's entries are
// the client's messages (`fromHistory`). Under the server history, the server
// owns the thread: a run takes from the client only what is new (`delta`,
// `ingest`), its answers to the previous run's interrupts (`resume`) and its
// results for the frontend calls it was left (`answers`), and a client that
// lost its state reads the thread back (`restore`, public as
// `History.restore`). The errors are public through `History`.
// -----------------------------------------------------------------------------

/** The client's history shares no message with the stored thread. */
export class HistoryMismatch extends Schema.TaggedError<HistoryMismatch, { readonly brand: unique symbol }>()(
  "HistoryMismatch",
  {},
) {
  override get message(): string {
    return "The client's messages do not match the stored thread";
  }
}

/**
 * The client's history leaves the stored thread before its end: it lacks a
 * stored message it could have seen, e.g. because it edited or regenerated a
 * turn, or missed a step. Appending its new messages would put them after
 * history the client does not have.
 */
export class HistoryDiverged extends Schema.TaggedError<HistoryDiverged, { readonly brand: unique symbol }>()(
  "HistoryDiverged",
  {},
) {
  override get message(): string {
    return "The client's messages leave the stored thread before its end";
  }
}

/**
 * The client messages that are new to the store.
 *
 * A client message is known if a stored entry has its id, or if it is a `tool`
 * message and a stored tool result has its `toolCallId` (clients such as
 * TanStack AI send tool results under ids of their own). Other client
 * messages, such as the text of a step that was cancelled before it committed,
 * are ignored. The new messages are those after the last known one.
 *
 * With an empty store, every client message is new. With a non-empty store and
 * no known message, the client is on a different history (`HistoryMismatch`).
 * If a stored entry after the last known one would be shown by {@link restore}
 * and no client message matches it, the client is missing part of the thread
 * (`HistoryDiverged`). Reasoning plays no part: a client may keep or drop its
 * rows, whose ids match no entry, and an entry holding only reasoning need not
 * be matched. Entries committed by `runId` itself don't count: a run
 * executed again after a crash meets the steps its earlier attempt committed,
 * which its input could not hold.
 */
export const delta = (
  stored: ReadonlyArray<Entry>,
  client: ReadonlyArray<AgUiSchema.Message>,
  runId?: string,
): Result.Result<ReadonlyArray<AgUiSchema.Message>, HistoryMismatch | HistoryDiverged> => {
  if (stored.length === 0) {
    return Result.succeed(client);
  }
  const byId = new Map(stored.map((entry, index) => [entry.id, index]));
  const byCall = new Map<string, number>();
  for (const [index, { message }] of stored.entries()) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          byCall.set(part.id, index);
        }
      }
    }
  }
  const positions = client.map(
    (message) => byId.get(message.id) ?? (message.role === "tool" ? byCall.get(message.toolCallId) : undefined),
  );
  const last = positions.findLastIndex((position) => position !== undefined);
  if (last === -1) {
    return Result.fail(new HistoryMismatch());
  }
  const anchor = positions[last]!;
  const matched = new Set(positions);
  // A client may hold a subagent's messages or not: only the agent's own are required.
  const missing = stored.some(
    (entry, index) =>
      index > anchor &&
      !matched.has(index) &&
      (runId === undefined || entry.runId !== runId) &&
      entry.subagentRunId === undefined &&
      shown(entry) !== undefined,
  );
  return missing ? Result.fail(new HistoryDiverged()) : Result.succeed(client.slice(last + 1));
};

export interface IngestOptions {
  /**
   * What to do with `system` and `developer` messages sent by the client.
   * `"drop"` (the default) ignores them, so only the server's system prompt
   * instructs the model; `"allow"` turns them into system entries.
   */
  readonly clientSystem?: "allow" | "drop" | undefined;
}

/**
 * The entries to commit for a client delta: user messages with text, keyed by
 * the client's message id, and (only if allowed) system instructions. Every
 * other role is dropped: the server writes assistant and tool turns itself,
 * so a client cannot fabricate them. The one exception, a tool message
 * answering a frontend call, is taken by {@link answers}.
 */
export const ingest = (messages: ReadonlyArray<AgUiSchema.Message>, options?: IngestOptions): ReadonlyArray<Entry> =>
  messages.flatMap((message): Array<Entry> => {
    // A message with only media parts has no text to send, and providers
    // reject empty text blocks.
    switch (message.role) {
      case "user": {
        const text = textOf(message.content);
        return text.length === 0
          ? []
          : [{ id: message.id, message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }) }];
      }
      case "system":
      case "developer":
        return options?.clientSystem === "allow" && message.content.length > 0
          ? [{ id: message.id, message: Prompt.makeMessage("system", { content: message.content }) }]
          : [];
      default:
        return [];
    }
  });

const decodeApprovalResponse = Schema.decodeUnknownOption(AgUi.ApprovalResponse);

/**
 * The interrupt ids of the `resolved` answers whose payload is not an
 * {@link AgUi.ApprovalResponse}. {@link resume} denies such an answer, which is
 * safe but easy to miss, so the runner logs a warning naming them.
 */
export const malformedAnswers = (entries: ReadonlyArray<AgUiSchema.ResumeEntry>): ReadonlyArray<string> =>
  entries.flatMap((entry) =>
    entry.status === "resolved" && Option.isNone(decodeApprovalResponse(entry.payload)) ? [entry.interruptId] : [],
  );

/**
 * The run leaves open an interrupt of the previous run. AG-UI does not let a
 * producer read an omitted answer as a decision, so the run is rejected
 * instead; to give up on an interrupt, the client answers it `cancelled`.
 */
export class UnansweredInterrupt extends Schema.TaggedError<UnansweredInterrupt, { readonly brand: unique symbol }>()(
  "UnansweredInterrupt",
  { interruptIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The run does not answer the open interrupts: ${this.interruptIds.join(", ")}`;
  }
}

/**
 * Approval responses for every approval request in `stored` that has none
 * yet. A request is approved only when its resume entry is `resolved` with
 * an {@link AgUi.ApprovalResponse} payload whose `approved` is `true`;
 * otherwise it is denied with the payload's `reason`, or "cancelled" /
 * "denied". A payload that is not an `ApprovalResponse` denies the request. If any pending request has no resume entry, the
 * result is `UnansweredInterrupt` naming each of them. Resume entries that
 * match no pending request are ignored.
 */
export const resume = (
  stored: ReadonlyArray<Entry>,
  entries: ReadonlyArray<AgUiSchema.ResumeEntry>,
): Result.Result<ReadonlyArray<Entry>, UnansweredInterrupt> => {
  const answers = new Map(entries.map((entry) => [entry.interruptId, entry]));
  const pending = pendingApprovals(stored);
  const unanswered = pending.filter((request) => !answers.has(request.approvalId));
  if (unanswered.length > 0) {
    return Result.fail(new UnansweredInterrupt({ interruptIds: unanswered.map((request) => request.approvalId) }));
  }
  return Result.succeed(
    pending.map((request) => decision(answers.get(request.approvalId)!, request.entry.subagentRunId)),
  );
};

/**
 * The approval response entry a resume entry gives the request it answers
 * (see {@link resume}), owned by the subagent that owns the request, if any.
 */
const decision = (answer: AgUiSchema.ResumeEntry, owner: string | undefined): Entry => {
  const approvalId = answer.interruptId;
  const payload = Option.getOrUndefined(decodeApprovalResponse(answer.payload));
  const approved = answer.status === "resolved" && payload?.approved === true;
  const reason = payload?.reason ?? (answer.status === "cancelled" ? "cancelled" : "denied");
  return {
    id: `${approvalId}:response`,
    message: Prompt.makeMessage("tool", {
      content: [
        Prompt.toolApprovalResponsePart(approved ? { approvalId, approved } : { approvalId, approved, reason }),
      ],
    }),
    ...(owner === undefined ? {} : { subagentRunId: owner }),
  };
};

interface PendingApproval {
  readonly approvalId: string;
  readonly toolCallId: string;
  /** The assistant entry holding the request. */
  readonly entry: Entry;
}

/** The approval requests in `stored` that have no response yet, in commit order. */
const pendingApprovals = (stored: ReadonlyArray<Entry>): ReadonlyArray<PendingApproval> => {
  const requested: Array<PendingApproval> = [];
  const responded = new Set<string>();
  for (const entry of stored) {
    const { message } = entry;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          requested.push({ approvalId: part.approvalId, toolCallId: part.toolCallId, entry });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-approval-response") {
          responded.add(part.approvalId);
        }
      }
    }
  }
  return requested.filter((request) => !responded.has(request.approvalId));
};

// -----------------------------------------------------------------------------
// Frontend calls
// -----------------------------------------------------------------------------

/**
 * The run leaves a frontend call of the previous run unanswered. AG-UI
 * requires a thread that continues to answer every such call first, so the
 * run is rejected; a client that declines a call answers it saying so.
 */
export class UnansweredToolCall extends Schema.TaggedError<UnansweredToolCall, { readonly brand: unique symbol }>()(
  "UnansweredToolCall",
  { toolCallIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The run does not answer the pending frontend tool calls: ${this.toolCallIds.join(", ")}`;
  }
}

/** What {@link answers} commits. */
export interface Answers {
  /** One tool-result entry per pending frontend call, keyed by the client's message id. */
  readonly entries: ReadonlyArray<Entry>;
  /** The calls whose answer held content parts other than text, which were dropped. */
  readonly droppedParts: ReadonlyArray<string>;
}

/**
 * The results the client sent for the frontend calls in `stored` that have
 * none yet: for each, the first `tool` message in `delta` with its
 * `toolCallId`. A message with `error` is a failed result holding the error.
 * Otherwise string content that parses as JSON is the parsed value, any other
 * string is itself, and a list of content parts is its text parts joined; other
 * parts are dropped (`droppedParts`), and the call is still answered. If any
 * pending call has no answer, the result is `UnansweredToolCall` naming each
 * of them. Tool messages for anything else are left to {@link ingest}, which
 * drops them, so a client can only answer the calls the run left to it.
 */
export const answers = (
  stored: ReadonlyArray<Entry>,
  delta: ReadonlyArray<AgUiSchema.Message>,
): Result.Result<Answers, UnansweredToolCall> => {
  const pending = pendingFrontendCalls(stored);
  const sent = new Map<string, AgUiSchema.ToolMessage>();
  for (const message of delta) {
    if (message.role === "tool" && !sent.has(message.toolCallId)) {
      sent.set(message.toolCallId, message);
    }
  }
  const unanswered = pending.filter((call) => !sent.has(call.toolCallId));
  if (unanswered.length > 0) {
    return Result.fail(new UnansweredToolCall({ toolCallIds: unanswered.map((call) => call.toolCallId) }));
  }
  const droppedParts: Array<string> = [];
  const entries = pending.map(({ toolCallId, toolName }) => {
    const { entry, dropped } = resultEntry(sent.get(toolCallId)!, toolCallId, toolName);
    if (dropped) {
      droppedParts.push(toolCallId);
    }
    return entry;
  });
  return Result.succeed({ entries, droppedParts });
};

/**
 * A client `tool` message as the result entry for its call, keyed by the
 * message's id, decoded as {@link answers} describes, and whether parts other
 * than text were dropped.
 */
const resultEntry = (
  message: AgUiSchema.ToolMessage,
  toolCallId: string,
  toolName: string,
): { readonly entry: Entry; readonly dropped: boolean } => {
  const decoded = message.error === undefined ? resultOf(message.content) : { result: message.error, dropped: false };
  return {
    entry: {
      id: message.id,
      message: Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: toolCallId,
            name: toolName,
            result: decoded.result,
            isFailure: message.error !== undefined,
            providerExecuted: false,
          }),
        ],
      }),
    },
    dropped: decoded.dropped,
  };
};

/** A tool message's content as a stored result, and whether parts other than text were dropped. */
const resultOf = (content: Content): { readonly result: unknown; readonly dropped: boolean } => {
  if (typeof content === "string") {
    try {
      return { result: JSON.parse(content), dropped: false };
    } catch {
      return { result: content, dropped: false };
    }
  }
  return { result: textOf(content), dropped: content.some((part) => part.type !== "text") };
};

interface PendingFrontendCall {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The assistant entry holding the call. */
  readonly entry: Entry;
}

/** The frontend calls in `stored` that have no result yet, in commit order. */
const pendingFrontendCalls = (stored: ReadonlyArray<Entry>): ReadonlyArray<PendingFrontendCall> => {
  const calls: Array<PendingFrontendCall> = [];
  const answered = new Set<string>();
  for (const entry of stored) {
    const { message } = entry;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && Agent.isFrontendCall(part)) {
          calls.push({ toolCallId: part.id, toolName: part.name, entry });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    }
  }
  return calls.filter((call) => !answered.has(call.toolCallId));
};

// -----------------------------------------------------------------------------
// The client's history
// -----------------------------------------------------------------------------

/** What {@link fromHistory} produced, and what it dropped. */
export interface FromHistory {
  /**
   * One entry per kept message, keyed by the client's message id, then one
   * approval response per answered approval (`<approvalId>:response`).
   */
  readonly entries: ReadonlyArray<Entry>;
  /** Tool calls dropped because their arguments are not a JSON object, with any results for them. */
  readonly droppedCalls: ReadonlyArray<string>;
  /** Ids of tool messages dropped because no assistant message in the history makes their call. */
  readonly orphanResults: ReadonlyArray<string>;
  /** Calls whose result held content parts other than text, which were dropped. */
  readonly droppedParts: ReadonlyArray<string>;
}

/**
 * The client's history as entries to project, for a run whose history is the
 * client's own: nothing is reconciled against a store, so client assistant
 * and tool messages are kept, and an edited or regenerated history is taken
 * as sent.
 *
 * - `user`, `system` and `developer` messages are converted as {@link ingest}
 *   converts them.
 * - An `assistant` message keeps its text and its tool calls, with their
 *   arguments parsed. A call whose arguments are not a JSON object, such as
 *   one cut off by a cancelled run, is dropped together with its results
 *   (`droppedCalls`). A message left with neither is dropped.
 * - A `tool` message is the result of its call, decoded as {@link answers}
 *   decodes it; the first per call wins. One whose call is not in the history
 *   is dropped (`orphanResults`), because providers reject a result with no
 *   call.
 * - Other roles are dropped.
 *
 * A `resume` entry answers a call that has no result when its `interruptId`
 * is the call's {@link Agent.approvalIdFor}: the call's assistant entry gets
 * the approval request and the response is appended, decided as
 * {@link resume} decides it, so the run executes the decision as step 0.
 * Entries that answer nothing are ignored. A call with no result and no
 * answer is left to `Messages.project`, which gives it a failed result.
 */
export const fromHistory = (
  messages: ReadonlyArray<AgUiSchema.Message>,
  resume: ReadonlyArray<AgUiSchema.ResumeEntry>,
  options?: IngestOptions,
): FromHistory => {
  const droppedCalls: Array<string> = [];
  const orphanResults: Array<string> = [];
  const droppedParts: Array<string> = [];
  // The calls the history makes, by id, with parsed arguments.
  const calls = new Map<string, { readonly name: string; readonly params: unknown }>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const params = parseObject(call.function.arguments);
        if (params === undefined) {
          droppedCalls.push(call.id);
        } else if (!calls.has(call.id)) {
          calls.set(call.id, { name: call.function.name, params });
        }
      }
    }
  }
  const dropped = new Set(droppedCalls);
  const answered = new Set<string>();
  // The subagents whose messages the client sent back.
  const owners = new Set(
    messages.flatMap((message) => (message.subagentRunId === undefined ? [] : [message.subagentRunId])),
  );
  // Each converted assistant entry, with the calls it holds, so approval requests and marks can be added to it.
  const assistants: Array<{
    readonly index: number;
    readonly callIds: ReadonlyArray<string>;
    readonly content: ReadonlyArray<Prompt.AssistantMessagePart>;
  }> = [];
  const entries: Array<Entry> = [];
  for (const message of messages) {
    // A subagent's message stays its own: `Messages.project` keeps it out of the agent's prompt.
    const owned = (entry: Entry): Entry =>
      message.subagentRunId === undefined ? entry : { ...entry, subagentRunId: message.subagentRunId };
    switch (message.role) {
      case "assistant": {
        const text = textOf(message.content);
        const callIds = (message.toolCalls ?? []).flatMap((call) => (calls.has(call.id) ? [call.id] : []));
        if (text.length === 0 && callIds.length === 0) {
          break;
        }
        const content = [
          ...(text.length > 0 ? [Prompt.makePart("text", { text })] : []),
          ...callIds.map((id) => {
            const call = calls.get(id)!;
            return Prompt.makePart("tool-call", { id, name: call.name, params: call.params, providerExecuted: false });
          }),
        ];
        assistants.push({ index: entries.length, callIds, content });
        entries.push(owned({ id: message.id, message: Prompt.makeMessage("assistant", { content }) }));
        break;
      }
      case "tool": {
        const toolCallId = message.toolCallId;
        if (dropped.has(toolCallId)) {
          break;
        }
        const call = calls.get(toolCallId);
        if (call === undefined) {
          orphanResults.push(message.id);
          break;
        }
        if (answered.has(toolCallId)) {
          break;
        }
        answered.add(toolCallId);
        const result = resultEntry(message, toolCallId, call.name);
        if (result.dropped) {
          droppedParts.push(toolCallId);
        }
        entries.push(owned(result.entry));
        break;
      }
      default: {
        entries.push(...ingest([message], options).map(owned));
      }
    }
  }

  const answers = new Map(resume.map((entry) => [entry.interruptId, entry]));
  const responses: Array<Entry> = [];
  for (const { index, callIds, content } of assistants) {
    const { id, subagentRunId: owner } = entries[index]!;
    let changed = false;
    const marked = content.map((part) => {
      // A call whose child's messages are here, with no result: the child is suspended, and the run resumes it.
      if (part.type === "tool-call" && !answered.has(part.id) && owners.has(Agent.subagentIdFor(part.id))) {
        changed = true;
        return Agent.markSuspendedSubagent(part, id);
      }
      return part;
    });
    const requests = callIds.flatMap((toolCallId) => {
      const approvalId = Agent.approvalIdFor(toolCallId);
      const answer = answers.get(approvalId);
      if (answered.has(toolCallId) || answer === undefined) {
        return [];
      }
      answered.add(toolCallId);
      responses.push(decision(answer, owner));
      return [Prompt.toolApprovalRequestPart({ approvalId, toolCallId })];
    });
    if (changed || requests.length > 0) {
      entries[index] = {
        ...entries[index]!,
        message: Prompt.makeMessage("assistant", { content: [...marked, ...requests] }),
      };
    }
  }
  return { entries: [...entries, ...responses], droppedCalls, orphanResults, droppedParts };
};

/** `text` parsed as JSON, if it is an object; otherwise `undefined`. */
const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

// -----------------------------------------------------------------------------
// Reading a thread back
// -----------------------------------------------------------------------------

/** A thread as a client restores it. See `History.restore`. */
export interface Restored {
  /** The messages the thread's runs showed, as their events showed them. */
  readonly messages: ReadonlyArray<AgUiSchema.Message>;
  /**
   * The approval requests still waiting for an answer, as the `RUN_FINISHED`
   * that raised them carried them, and the run that raised them (`undefined`
   * if the store did not record it). `undefined` when none are open.
   */
  readonly interrupts:
    | { readonly runId: string | undefined; readonly pending: ReadonlyArray<AgUiSchema.Interrupt> }
    | undefined;
  /**
   * The frontend calls still waiting for the client's result, in call order,
   * and the run that left them (`undefined` if the store did not record it).
   * The calls are in `messages`, with no tool message after them. `undefined`
   * when none are pending.
   */
  readonly pendingToolCalls:
    | { readonly runId: string | undefined; readonly toolCallIds: ReadonlyArray<string> }
    | undefined;
  /**
   * The run holding the thread, for a client to join. Only a rejoining read
   * reports one; `undefined` otherwise, and when the thread has no active run.
   */
  readonly activeRun: { readonly runId: string } | undefined;
}

/**
 * The message a client was shown for an entry, with the id and content the
 * run's events gave it, or `undefined` if the events showed none: system
 * entries, approval responses, and assistant entries with neither text nor
 * tool calls.
 *
 * This is also {@link delta}'s rule for what a client must hold, so reasoning
 * stays outside it, in {@link reasoningOf}. An entry holding only reasoning
 * would otherwise have to be matched, and a client can't match it: its rows
 * carry their blocks' ids, not the entry's.
 */
const shown = (entry: Entry): AgUiSchema.Message | undefined => {
  const { id, message } = entry;
  switch (message.role) {
    case "user": {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      return { id, role: "user", content: text };
    }
    case "assistant": {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      const toolCalls = message.content.flatMap((part) =>
        part.type === "tool-call"
          ? [
              {
                id: part.id,
                type: "function" as const,
                function: { name: part.name, arguments: JSON.stringify(part.params ?? {}) },
              },
            ]
          : [],
      );
      if (text.length === 0 && toolCalls.length === 0) {
        return undefined;
      }
      return {
        id,
        role: "assistant",
        ...(text.length > 0 ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    }
    case "tool": {
      const result = message.content.find((part) => part.type === "tool-result");
      if (result === undefined) {
        return undefined;
      }
      // Encoded as `TOOL_CALL_RESULT` encodes it. A failed result also carries its error, which is how a
      // client's history marks one (see `answers`).
      return {
        id,
        role: "tool",
        toolCallId: result.id,
        content: JSON.stringify(result.result ?? null),
        ...(result.isFailure
          ? { error: typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? null) }
          : {}),
      };
    }
    case "system": {
      return undefined;
    }
  }
};

/**
 * The `reasoning` messages of an entry, with the id and text its events gave
 * them. A block with no text showed nothing, but still counts towards the ids
 * of the blocks after it. Provider options are never read.
 */
const reasoningOf = ({ id, message }: Entry): ReadonlyArray<AgUiSchema.ReasoningMessage> =>
  message.role === "assistant"
    ? message.content
        .filter((part) => part.type === "reasoning")
        .flatMap((part, n) =>
          part.text.length === 0
            ? []
            : [{ id: AgUi.reasoningMessageId(id, n), role: "reasoning" as const, content: part.text }],
        )
    : [];

/**
 * Every AG-UI message an entry's events showed: its reasoning, then the
 * message {@link shown} gives it. The assistant message has one `content`, so
 * its text can't be split around a block, and the reasoning goes first.
 */
const toAgUi = (entry: Entry): ReadonlyArray<AgUiSchema.Message> => {
  const message = shown(entry);
  return message === undefined ? reasoningOf(entry) : [...reasoningOf(entry), message];
};

/**
 * The thread's loaded entries as its runs' events showed them, with its open
 * interrupts and pending frontend calls. Public as `History.restore`, which
 * loads the thread first and documents what callers rely on.
 *
 * Messages are in commit order, with each tool result moved directly after
 * the assistant message holding its call, and an entry's reasoning directly
 * before its assistant message: that message has one `content`, so its text
 * can't be split around a block. Ids and content are the events': an assistant
 * message's text is its segments joined, a reasoning message's is its deltas
 * joined, and a tool result is its `TOOL_CALL_RESULT` content. Tool call
 * arguments are re-encoded, so their formatting may differ from the streamed
 * deltas.
 *
 * A subagent's messages carry its `subagentRunId` and come directly after the
 * assistant message holding the call that spawned it, before that call's
 * result, nested the same way at any depth.
 */
export const restore = (stored: ReadonlyArray<Entry>, activeRunId?: string): Restored => {
  const entries = activeRunId === undefined ? stored : withoutReplayed(stored, activeRunId);
  const messages = entries.flatMap((entry): ReadonlyArray<AgUiSchema.Message> => {
    const all = toAgUi(entry);
    const owner = entry.subagentRunId;
    return owner === undefined ? all : all.map((m) => ({ ...m, subagentRunId: owner }));
  });
  // Each tool result goes after the assistant message holding its call, and so do the messages of the
  // subagent the call spawned, before the result.
  const caller = new Map<string, string>();
  const spawner = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        caller.set(call.id, message.id);
        spawner.set(Agent.subagentIdFor(call.id), message.id);
      }
    }
  }
  const results = new Map<string, Array<AgUiSchema.Message>>();
  const nested = new Map<string, Array<AgUiSchema.Message>>();
  const rest: Array<AgUiSchema.Message> = [];
  const push = (map: Map<string, Array<AgUiSchema.Message>>, key: string, message: AgUiSchema.Message) =>
    map.set(key, [...(map.get(key) ?? []), message]);
  for (const message of messages) {
    const resultOf = message.role === "tool" ? caller.get(message.toolCallId) : undefined;
    const host = message.subagentRunId === undefined ? undefined : spawner.get(message.subagentRunId);
    if (resultOf !== undefined) {
      push(results, resultOf, message);
    } else if (host !== undefined) {
      push(nested, host, message);
    } else {
      // Includes a result whose call is not loaded (compacted away): it stays where it is.
      rest.push(message);
    }
  }
  const place = (message: AgUiSchema.Message): Array<AgUiSchema.Message> => [
    message,
    ...(nested.get(message.id) ?? []).flatMap(place),
    ...(results.get(message.id) ?? []),
  ];
  const ordered = rest.flatMap(place);

  const pending = pendingApprovals(entries);
  const frontend = pendingFrontendCalls(entries);
  const toolNames = new Map<string, string>();
  for (const { message } of entries) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call") {
          toolNames.set(part.id, part.name);
        }
      }
    }
  }
  return {
    messages: ordered,
    interrupts:
      pending.length === 0
        ? undefined
        : {
            // One active run per thread, so every open request is the last interrupted run's.
            runId: pending.at(-1)!.entry.runId,
            pending: pending.map((request) =>
              AgUi.approvalInterrupt({
                approvalId: request.approvalId,
                toolCallId: request.toolCallId,
                toolName: toolNames.get(request.toolCallId) ?? "",
                subagentRunId: request.entry.subagentRunId,
              }),
            ),
          },
    pendingToolCalls:
      frontend.length === 0
        ? undefined
        : {
            // One active run per thread, so every pending call is the last run's.
            runId: frontend.at(-1)!.entry.runId,
            toolCallIds: frontend.map((call) => call.toolCallId),
          },
    activeRun: activeRunId === undefined ? undefined : { runId: activeRunId },
  };
};

/**
 * The entries without what `runId`'s event log replays: the assistant entries
 * it committed and the results of the calls they hold. Its user messages stay,
 * and so do its results and approval responses for earlier runs' calls: the
 * log does not show what came from the client, and those answers keep
 * {@link restore} from reporting an answered call as open.
 */
const withoutReplayed = (entries: ReadonlyArray<Entry>, runId: string): ReadonlyArray<Entry> => {
  const calls = new Set(
    entries.flatMap(({ runId: committedBy, message }) =>
      committedBy === runId && message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : []))
        : [],
    ),
  );
  return entries.filter(({ runId: committedBy, message }) => {
    if (committedBy !== runId) {
      return true;
    }
    switch (message.role) {
      case "assistant": {
        return false;
      }
      case "tool": {
        return !message.content.every((part) => part.type === "tool-result" && calls.has(part.id));
      }
      default: {
        return true;
      }
    }
  });
};

/** The content of a user or tool message. */
type Content = string | ReadonlyArray<AgUiSchema.ContentPart>;

/** The text of a message's content: a string as is, or its text parts joined; none is "". */
const textOf = (content: Content | undefined): string =>
  content === undefined
    ? ""
    : typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
