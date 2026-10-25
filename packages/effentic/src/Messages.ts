import type { AssistantMessage, Interrupt, ToolMessage, UserMessage } from "@ag-ui/core";
import { Option, Result, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "./Agent.ts";
import * as AgUi from "./AgUi.ts";
import type * as Thread from "./Thread.ts";

// -----------------------------------------------------------------------------
// The server owns the thread. A run takes from the client only what is
// new (`delta`, `ingest`) and its answers to the previous run's interrupts
// (`resume`), and builds the model prompt from the store (`project`). A
// client that lost its state reads the thread back (`history`).
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
 * If a stored entry after the last known one would be shown by {@link history}
 * and no client message matches it, the client is missing part of the thread
 * (`HistoryDiverged`). Entries committed by `runId` itself don't count: a run
 * executed again after a crash meets the steps its earlier attempt committed,
 * which its input could not hold.
 */
export const delta = (
  stored: ReadonlyArray<Thread.Entry>,
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
 * so a client cannot fabricate them.
 */
export const ingest = (messages: ReadonlyArray<AgUi.Message>, options?: IngestOptions): ReadonlyArray<Thread.Entry> =>
  messages.flatMap((message): Array<Thread.Entry> => {
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
  stored: ReadonlyArray<Thread.Entry>,
  entries: ReadonlyArray<AgUi.ResumeEntry>,
): Result.Result<ReadonlyArray<Thread.Entry>, UnansweredInterrupt> => {
  const answers = new Map(entries.map((entry) => [entry.interruptId, entry]));
  const pending = pendingApprovals(stored).map((request) => request.approvalId);
  const unanswered = pending.filter((approvalId) => !answers.has(approvalId));
  if (unanswered.length > 0) {
    return Result.fail(new UnansweredInterrupt({ interruptIds: unanswered }));
  }
  return Result.succeed(
    pending.map((approvalId) => {
      const answer = answers.get(approvalId)!;
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
    }),
  );
};

interface PendingApproval {
  readonly approvalId: string;
  readonly toolCallId: string;
  /** The assistant entry holding the request. */
  readonly entry: Thread.Entry;
}

/** The approval requests in `stored` that have no response yet, in commit order. */
const pendingApprovals = (stored: ReadonlyArray<Thread.Entry>): ReadonlyArray<PendingApproval> => {
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
// Reading a thread back
// -----------------------------------------------------------------------------

/** A message {@link history} returns. User and tool content is always a string. */
export type ShownMessage =
  | (UserMessage & { readonly content: string })
  | AssistantMessage
  | (ToolMessage & { readonly content: string });

/** A thread as a client restores it. See {@link history}. */
export interface History {
  /** The messages the thread's runs showed, as their events showed them. */
  readonly messages: ReadonlyArray<ShownMessage>;
  /**
   * The approval requests still waiting for an answer, as the `RUN_FINISHED`
   * that raised them carried them, and the run that raised them (`undefined`
   * if the store did not record it). `undefined` when none are open.
   */
  readonly interrupts: { readonly runId: string | undefined; readonly pending: ReadonlyArray<Interrupt> } | undefined;
}

/**
 * The message a client was shown for an entry, with the id and content the
 * run's events gave it, or `undefined` if the events showed none: system
 * entries, approval responses, and assistant entries with neither text nor
 * tool calls. Reasoning is dropped, as the events drop it.
 */
const shown = (entry: Thread.Entry): ShownMessage | undefined => {
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
 * The thread as its runs' events showed it, for a client that has lost its
 * state (a reload, another device) to restore. Serve it from a route of your
 * own, e.g. `Effect.map(thread.load(threadId), Messages.history)`, authorised
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
export const history = (entries: ReadonlyArray<Thread.Entry>): History => {
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
  };
};

/** Result sent to the model for a tool call the history never answered. */
export const INCOMPLETE_TOOL_CALL_RESULT = "Tool call did not complete";

/**
 * The model prompt for a thread: the entries' messages as given. The agent's
 * system prompt is not included; `Agent.run` adds it. Compaction is the
 * store's concern; nothing is dropped or summarised here.
 *
 * Tool results are moved next to their calls (see `Agent.orderToolResults`).
 * Providers reject a tool call that has no result, and a run that fails or is
 * aborted mid-step can leave exactly that in the store; such calls are
 * answered with a failed result, so one broken run does not break the thread.
 * Calls waiting for approval are left alone: the run resolves them first.
 */
export const project = (entries: ReadonlyArray<Thread.Entry>): Prompt.Prompt => {
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
