import { Option, Result, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "./Agent.ts";
import type * as AgUi from "./AgUi.ts";
import type * as Thread from "./Thread.ts";

// -----------------------------------------------------------------------------
// The server owns the thread. A run takes from the client only what is
// new (`delta`, `ingest`) and its answers to the previous run's interrupts
// (`resume`), and builds the model prompt from the store (`project`).
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
 * The client messages that are new to the store: everything after the last
 * client message whose id is a stored entry id. With an empty store, every
 * client message is new. With a non-empty store and no shared id, the client
 * is on a different history and the run must not proceed.
 */
export const delta = (
  stored: ReadonlyArray<Thread.Entry>,
  client: ReadonlyArray<AgUi.Message>,
): Result.Result<ReadonlyArray<AgUi.Message>, HistoryMismatch> => {
  if (stored.length === 0) {
    return Result.succeed(client);
  }
  const ids = new Set(stored.map((entry) => entry.id));
  const last = client.findLastIndex((message) => ids.has(message.id));
  return last === -1 ? Result.fail(new HistoryMismatch()) : Result.succeed(client.slice(last + 1));
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

const ApprovalPayload = Schema.Struct({
  approved: Schema.optional(Schema.Unknown),
  reason: Schema.optional(Schema.String),
});
const decodeApprovalPayload = Schema.decodeUnknownOption(ApprovalPayload);

/**
 * Approval responses for every approval request in `stored` that has none
 * yet. A request answered by a resume entry is approved only when the entry is
 * `resolved` with `payload.approved === true`; otherwise it is denied with
 * `payload.reason`, or "cancelled" / "denied". A request with no resume entry
 * is denied as "not answered", so an ignored interrupt does not block the
 * thread. Resume entries that match no pending request are ignored.
 */
export const resume = (
  stored: ReadonlyArray<Thread.Entry>,
  entries: ReadonlyArray<AgUi.ResumeEntry>,
): ReadonlyArray<Thread.Entry> => {
  const requested: Array<string> = [];
  const responded = new Set<string>();
  for (const { message } of stored) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          requested.push(part.approvalId);
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
  const answers = new Map(entries.map((entry) => [entry.interruptId, entry]));
  return requested
    .filter((approvalId) => !responded.has(approvalId))
    .map((approvalId) => {
      const answer = answers.get(approvalId);
      const payload = Option.getOrUndefined(decodeApprovalPayload(answer?.payload));
      const approved = answer?.status === "resolved" && payload?.approved === true;
      const reason =
        answer === undefined
          ? "not answered"
          : (payload?.reason ?? (answer.status === "cancelled" ? "cancelled" : "denied"));
      return {
        id: `${approvalId}:response`,
        message: Prompt.makeMessage("tool", {
          content: [
            Prompt.toolApprovalResponsePart(approved ? { approvalId, approved } : { approvalId, approved, reason }),
          ],
        }),
      };
    });
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
