import { Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Agent from "./Agent.ts";

// -----------------------------------------------------------------------------
// What a run holds and how it becomes a model prompt. Both histories produce
// entries (see `History`), `Agent.run` emits them per step, and the server
// history stores them in `Thread`; `project` turns a run's entries into the
// prompt the agent is called with.
// -----------------------------------------------------------------------------

/**
 * One message of a conversation, as a run holds it: the history it starts
 * from, and what each step adds. The id is the AG-UI message id the client
 * sees (the client's own id, or the id the server minted for an assistant step
 * or tool result). Under the server history, `Thread` stores entries and
 * records `runId`, the run whose commit appended the entry, so entries passed
 * to `commit` need not carry it. `subagentRunId` names the subagent that owns
 * the entry (see `Agent.subagentIdFor`); an entry without one is the agent's
 * own. Each agent's prompt is built from its own entries only.
 */
export const Entry = Schema.Struct({
  id: Schema.String,
  message: Prompt.Message,
  runId: Schema.optional(Schema.String),
  subagentRunId: Schema.optional(Schema.String),
});
export type Entry = typeof Entry.Type;

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
 * Calls waiting for approval are left alone: the run resolves them first. So
 * are suspended subagent calls (see `Agent.isSuspendedSubagentCall`), which
 * the run resumes.
 * Under the server history, a frontend call is answered before the thread is
 * projected (the run fails with `UnansweredToolCall` otherwise), so it never
 * gets this failed result in a run that reached the projection. Under the client history, an unanswered
 * call of any kind gets it.
 *
 * Only the entries owned by `owner` are used: by default the agent's own
 * (entries with no `subagentRunId`), so a subagent's transcript never reaches
 * its parent's model.
 */
export const project = (entries: ReadonlyArray<Entry>, owner?: string): Prompt.Prompt => {
  const ordered = Agent.orderToolResults(
    Prompt.fromMessages(entries.filter((entry) => entry.subagentRunId === owner).map((entry) => entry.message)),
  );
  const awaiting = new Set<string>();
  for (const message of ordered.content) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          awaiting.add(part.toolCallId);
        } else if (part.type === "tool-call" && Agent.isSuspendedSubagentCall(part)) {
          awaiting.add(part.id);
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

/**
 * The prompts of the suspended subagents in `entries`, at any depth, by
 * `subagentRunId`: one {@link project}ion per suspended subagent call that
 * has no result yet. `Agent.run` resumes each such call from its prompt here.
 */
export const projectSuspended = (entries: ReadonlyArray<Entry>): Record<string, Prompt.Prompt> => {
  const answered = new Set<string>();
  const suspended: Array<string> = [];
  for (const { message } of entries) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && Agent.isSuspendedSubagentCall(part)) {
          suspended.push(part.id);
        }
      }
    }
  }
  return Object.fromEntries(
    suspended
      .filter((id) => !answered.has(id))
      .map((id) => {
        const owner = Agent.subagentIdFor(id);
        return [owner, project(entries, owner)];
      }),
  );
};
