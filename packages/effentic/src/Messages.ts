import type { AssistantMessage, Interrupt, ToolMessage, UserMessage } from "./AgUiSchema.ts";
import { Option, Result, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "./Agent.ts";
import * as AgUi from "./AgUi.ts";

// -----------------------------------------------------------------------------
// The toolbox both histories use (see `History`). Under the client history,
// the run's entries are the client's messages (`fromHistory`). Under the
// server history, the server owns the thread: a run takes from the client
// only what is new (`delta`, `ingest`), its answers to the previous run's
// interrupts (`resume`) and its results for the frontend calls it was left
// (`answers`), and a client that lost its state reads the thread back
// (`restore`). Either way the model prompt is built from the entries
// (`project`).
// -----------------------------------------------------------------------------

/**
 * One message of a conversation, as a run holds it: the history it starts
 * from, and what each step adds. The id is the AG-UI message id the client
 * sees (the client's own id, or the id the server minted for an assistant step
 * or tool result). Under the server history, `Thread` stores entries and
 * records `runId`, the run whose commit appended the entry, so entries passed
 * to `commit` need not carry it.
 */
export const Entry = Schema.Struct({
  id: Schema.String,
  message: Prompt.Message,
  runId: Schema.optional(Schema.String),
});
export type Entry = typeof Entry.Type;

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
 * (`HistoryDiverged`). Entries committed by `runId` itself don't count: a run
 * executed again after a crash meets the steps its earlier attempt committed,
 * which its input could not hold.
 */
export const delta = (
  stored: ReadonlyArray<Entry>,
  client: ReadonlyArray<AgUi.Message>,
  runId?: string,
): Result.Result<ReadonlyArray<AgUi.Message>, HistoryMismatch | HistoryDiverged> => {
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
    (message) =>
      byId.get(message.id) ??
      (message.role === "tool" && message.toolCallId !== undefined ? byCall.get(message.toolCallId) : undefined),
  );
  const last = positions.findLastIndex((position) => position !== undefined);
  if (last === -1) {
    return Result.fail(new HistoryMismatch());
  }
  const anchor = positions[last]!;
  const matched = new Set(positions);
  const missing = stored.some(
    (entry, index) =>
      index > anchor &&
      !matched.has(index) &&
      (runId === undefined || entry.runId !== runId) &&
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
export const ingest = (messages: ReadonlyArray<AgUi.Message>, options?: IngestOptions): ReadonlyArray<Entry> =>
  messages.flatMap((message): Array<Entry> => {
    // A message with only media parts has no text to send, and providers
    // reject empty text blocks.
    const text = textOf(message.content);
    if (text.length === 0) {
      return [];
    }
    switch (message.role) {
      case "user":
        return [
          { id: message.id, message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }) },
        ];
      case "system":
      case "developer":
        return options?.clientSystem === "allow"
          ? [{ id: message.id, message: Prompt.makeMessage("system", { content: text }) }]
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
export const malformedAnswers = (entries: ReadonlyArray<AgUi.ResumeEntry>): ReadonlyArray<string> =>
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
  entries: ReadonlyArray<AgUi.ResumeEntry>,
): Result.Result<ReadonlyArray<Entry>, UnansweredInterrupt> => {
  const answers = new Map(entries.map((entry) => [entry.interruptId, entry]));
  const pending = pendingApprovals(stored).map((request) => request.approvalId);
  const unanswered = pending.filter((approvalId) => !answers.has(approvalId));
  if (unanswered.length > 0) {
    return Result.fail(new UnansweredInterrupt({ interruptIds: unanswered }));
  }
  return Result.succeed(pending.map((approvalId) => decision(answers.get(approvalId)!)));
};

/** The approval response entry a resume entry gives the request it answers (see {@link resume}). */
const decision = (answer: AgUi.ResumeEntry): Entry => {
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
  delta: ReadonlyArray<AgUi.Message>,
): Result.Result<Answers, UnansweredToolCall> => {
  const pending = pendingFrontendCalls(stored);
  const sent = new Map<string, AgUi.Message>();
  for (const message of delta) {
    if (message.role === "tool" && message.toolCallId !== undefined && !sent.has(message.toolCallId)) {
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
  message: AgUi.Message,
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
const resultOf = (content: unknown): { readonly result: unknown; readonly dropped: boolean } => {
  if (typeof content === "string") {
    try {
      return { result: JSON.parse(content), dropped: false };
    } catch {
      return { result: content, dropped: false };
    }
  }
  if (Array.isArray(content)) {
    return { result: textOf(content), dropped: content.some((part) => !isTextPart(part)) };
  }
  return { result: content ?? "", dropped: false };
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
 * answer is left to {@link project}, which gives it a failed result.
 */
export const fromHistory = (
  messages: ReadonlyArray<AgUi.Message>,
  resume: ReadonlyArray<AgUi.ResumeEntry>,
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
  // Each converted assistant entry, with the calls it holds, so approval requests can be added to it.
  const assistants: Array<{
    readonly index: number;
    readonly callIds: ReadonlyArray<string>;
    readonly content: ReadonlyArray<Prompt.AssistantMessagePart>;
  }> = [];
  const entries: Array<Entry> = [];
  for (const message of messages) {
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
        entries.push({ id: message.id, message: Prompt.makeMessage("assistant", { content }) });
        break;
      }
      case "tool": {
        const toolCallId = message.toolCallId;
        if (toolCallId !== undefined && dropped.has(toolCallId)) {
          break;
        }
        const call = toolCallId === undefined ? undefined : calls.get(toolCallId);
        if (toolCallId === undefined || call === undefined) {
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
        entries.push(result.entry);
        break;
      }
      default: {
        entries.push(...ingest([message], options));
      }
    }
  }

  const answers = new Map(resume.map((entry) => [entry.interruptId, entry]));
  const responses: Array<Entry> = [];
  for (const { index, callIds, content } of assistants) {
    const requests = callIds.flatMap((toolCallId) => {
      const approvalId = Agent.approvalIdFor(toolCallId);
      const answer = answers.get(approvalId);
      if (answered.has(toolCallId) || answer === undefined) {
        return [];
      }
      answered.add(toolCallId);
      responses.push(decision(answer));
      return [Prompt.toolApprovalRequestPart({ approvalId, toolCallId })];
    });
    if (requests.length > 0) {
      const { id } = entries[index]!;
      entries[index] = { id, message: Prompt.makeMessage("assistant", { content: [...content, ...requests] }) };
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

/** A message {@link restore} returns. User and tool content is always a string. */
export type ShownMessage =
  | (UserMessage & { readonly content: string })
  | AssistantMessage
  | (ToolMessage & { readonly content: string });

/** A thread as a client restores it. See {@link restore}. */
export interface Restored {
  /** The messages the thread's runs showed, as their events showed them. */
  readonly messages: ReadonlyArray<ShownMessage>;
  /**
   * The approval requests still waiting for an answer, as the `RUN_FINISHED`
   * that raised them carried them, and the run that raised them (`undefined`
   * if the store did not record it). `undefined` when none are open.
   */
  readonly interrupts: { readonly runId: string | undefined; readonly pending: ReadonlyArray<Interrupt> } | undefined;
  /**
   * The frontend calls still waiting for the client's result, in call order,
   * and the run that left them (`undefined` if the store did not record it).
   * The calls are in `messages`, with no tool message after them. `undefined`
   * when none are pending.
   */
  readonly pendingToolCalls:
    | { readonly runId: string | undefined; readonly toolCallIds: ReadonlyArray<string> }
    | undefined;
}

/**
 * The message a client was shown for an entry, with the id and content the
 * run's events gave it, or `undefined` if the events showed none: system
 * entries, approval responses, and assistant entries with neither text nor
 * tool calls. Reasoning is dropped, as the events drop it.
 */
const shown = (entry: Entry): ShownMessage | undefined => {
  const { id, message } = entry;
  switch (message.role) {
    case "user": {
      return { id, role: "user", content: textOf(message.content) };
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
      // Encoded as `TOOL_CALL_RESULT` encodes it.
      return result === undefined
        ? undefined
        : { id, role: "tool", toolCallId: result.id, content: JSON.stringify(result.result ?? null) };
    }
    case "system": {
      return undefined;
    }
  }
};

/**
 * The thread as its runs' events showed it, with its open interrupts and
 * pending frontend calls, for a client that has lost its state (a reload, another device) to restore.
 * It reads the server history's store: under the client history nothing is
 * stored, and the client keeps its own state. Serve it from a route of your
 * own, e.g. `Effect.map(thread.load(threadId), Messages.restore)`, authorised
 * like the run route. A client that sends the messages back, with new user
 * messages after them, is matched against the store as if it had streamed
 * them.
 *
 * Messages are in commit order, with each tool result moved directly after
 * the assistant message holding its call. Ids and content are the events':
 * an assistant message's text is its segments joined, and a tool result is
 * its `TOOL_CALL_RESULT` content. Tool call arguments are re-encoded, so their
 * formatting may differ from the streamed deltas.
 */
export const restore = (entries: ReadonlyArray<Entry>): Restored => {
  const messages = entries.flatMap((entry) => {
    const message = shown(entry);
    return message === undefined ? [] : [message];
  });
  // Each tool result goes after the assistant message holding its call.
  const caller = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        caller.set(call.id, message.id);
      }
    }
  }
  const results = new Map<string, Array<ShownMessage>>();
  const rest: Array<ShownMessage> = [];
  for (const message of messages) {
    const owner = message.role === "tool" ? caller.get(message.toolCallId) : undefined;
    if (owner === undefined) {
      // Includes a result whose call is not loaded (compacted away): it stays where it is.
      rest.push(message);
    } else {
      results.set(owner, [...(results.get(owner) ?? []), message]);
    }
  }
  const ordered = rest.flatMap((message) => [message, ...(results.get(message.id) ?? [])]);

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
  };
};

/** Result sent to the model for a tool call the history never answered. */
export const INCOMPLETE_TOOL_CALL_RESULT = "Tool call did not complete";

/**
 * The model prompt for a run's entries, under either history: the entries'
 * messages as given. The agent's system prompt is not included; `Agent.run`
 * adds it. Nothing is dropped or summarised here: compaction is the store's
 * concern under the server history, and the client's under the client
 * history.
 *
 * Tool results are moved next to their calls (see `Agent.orderToolResults`).
 * Providers reject a tool call that has no result, and a run that fails or is
 * aborted mid-step can leave exactly that in the store; such calls are
 * answered with a failed result, so one broken run does not break the thread.
 * Calls waiting for approval are left alone: the run resolves them first.
 * Under the server history, a frontend call is answered before the thread is
 * projected (see {@link answers}), so it never gets this failed result in a
 * run that reached the projection. Under the client history, an unanswered
 * call of any kind gets it.
 */
export const project = (entries: ReadonlyArray<Entry>): Prompt.Prompt => {
  const ordered = Agent.orderToolResults(Prompt.fromMessages(entries.map((entry) => entry.message)));
  const awaiting = new Set<string>();
  for (const message of ordered.content) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          awaiting.add(part.toolCallId);
        }
      }
    }
  }

  const messages: Array<Prompt.Message> = [];
  // Calls made by the latest assistant message that have no result yet.
  const pending = new Map<string, string>();
  const flush = () => {
    for (const [id, name] of pending) {
      messages.push(
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id,
              name,
              isFailure: true,
              result: INCOMPLETE_TOOL_CALL_RESULT,
              providerExecuted: false,
            }),
          ],
        }),
      );
    }
    pending.clear();
  };
  for (const message of ordered.content) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          pending.delete(part.id);
        }
      }
      messages.push(message);
      continue;
    }
    flush();
    messages.push(message);
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && !part.providerExecuted && !awaiting.has(part.id)) {
          pending.set(part.id, part.name);
        }
      }
    }
  }
  flush();
  return Prompt.fromMessages(messages);
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
