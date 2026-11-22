import { createFileRoute } from "@tanstack/react-router";
import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { Schema } from "effect";
import { useEffect, useId, useState, type FormEvent } from "react";
import { getBrowserTime } from "../tools/browser-time.tool.ts";

export const Route = createFileRoute("/")({
  // The thread id lives in the URL (`/?thread=…`), so a reload continues the thread.
  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ thread: Schema.optional(Schema.String) })),
  component: Chat,
});

function Chat() {
  const { thread } = Route.useSearch();
  const navigate = Route.useNavigate();
  // A page without a thread id starts a new thread.
  useEffect(() => {
    if (thread === undefined) {
      void navigate({ search: { thread: crypto.randomUUID() }, replace: true });
    }
  }, [thread, navigate]);
  return thread === undefined ? null : <ChatThread key={thread} threadId={thread} />;
}

function ChatThread({ threadId }: { readonly threadId: string }) {
  // The server owns the thread's history. With `persistence: true`, the client
  // loads it on mount (`GET /api/chat?threadId=…`), open approvals included,
  // rejoins a run still going, and still sends its whole history on every run.
  // The URL carries the thread id because the join request doesn't add it, and
  // the server's event log is keyed by thread. Don't set `history`:
  // paging makes the client send only new messages, which the server rejects.
  // `tools` are frontend tools: the browser runs them and answers in the next run.
  // With `cancelUrl`, `stop()` also posts the run's ids there, which cancels the
  // detached run on the server; aborting the stream alone wouldn't reach it.
  const { messages, sendMessage, stop, isLoading, error, interrupts, resumeInterruptsUnsafe } = useChat({
    connection: fetchServerSentEvents(`/api/chat?threadId=${encodeURIComponent(threadId)}`, {
      cancelUrl: "/api/chat/cancel",
    }),
    threadId,
    persistence: true,
    tools: [getBrowserTime],
  });
  const [input, setInput] = useState("");

  // effect-agent-harness's approval interrupts are plain AG-UI interrupts, without TanStack's
  // own binding metadata, so TanStack lists them as `unbound` and offers no
  // `resolveInterrupt`. Answer them with AG-UI `resume` entries instead: the
  // payload is effect-agent-harness's `AgUi.ApprovalResponse`.
  const approvals = interrupts.filter((interrupt) => interrupt.reason === "tool-approval");
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const decide = (interruptId: string, approved: boolean) => {
    const next = { ...decisions, [interruptId]: approved };
    // The server rejects a run that leaves an approval unanswered, so resume
    // only once every pending approval has a decision.
    if (approvals.every((approval) => approval.id in next)) {
      setDecisions({});
      void resumeInterruptsUnsafe(
        approvals.map((approval) => ({
          interruptId: approval.id,
          status: "resolved" as const,
          payload: { approved: next[approval.id] === true },
        })),
      );
    } else {
      setDecisions(next);
    }
  };

  // A progress card is done once its call has a result. A run that ends without one (it
  // failed mid-call) leaves its card stopped: the library doesn't finalise activity.
  const answered = answeredCalls(messages);
  const progressOf = (toolCallId: string | undefined): Progress =>
    toolCallId !== undefined && answered.has(toolCallId) ? "done" : isLoading ? "running" : "stopped";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    void sendMessage(text);
  };

  return (
    <main className="chat">
      <header>
        <h1>effect-agent-harness × TanStack AI</h1>
        <p>
          Ask about the weather anywhere, what time it is where you are (your browser answers), or ask it to send an
          email (it asks you first). For a report on several places, it asks its weather desk, a subagent. Ask it to
          search the docs to watch a slow tool report its progress.
        </p>
      </header>
      <ol className="messages">
        {messages.map((message) => (
          <Message key={message.id} message={message} progressOf={progressOf} />
        ))}
        {isLoading && <li className="thinking">…</li>}
      </ol>
      {!isLoading &&
        approvals.map((approval) => (
          <div key={approval.id} className="approval">
            <span>{approval.message}</span>
            {approval.id in decisions ? (
              <span>{decisions[approval.id] ? "Approved" : "Denied"}</span>
            ) : (
              <>
                <button type="button" onClick={() => decide(approval.id, true)}>
                  Approve
                </button>
                <button type="button" className="secondary" onClick={() => decide(approval.id, false)}>
                  Deny
                </button>
              </>
            )}
          </div>
        ))}
      {error && <p className="error">{error.message}</p>}
      <form onSubmit={submit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={approvals.length > 0 ? "Answer the approval first" : "What's the weather in Paris?"}
          disabled={approvals.length > 0}
          aria-label="Message"
          autoFocus
        />
        {/* The thread is busy until the run ends, so a streaming run offers Stop instead of Send. */}
        {isLoading ? (
          <button type="button" className="secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </main>
  );
}

const SUBAGENT_STATUS = {
  running: "working…",
  finished: "done",
  error: "failed",
  suspended: "waiting for approval",
} as const;

/** The ids of the tool calls in `messages` that have a result, subagents' included. */
const answeredCalls = (messages: ReadonlyArray<UIMessage>): ReadonlySet<string> =>
  new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type === "tool-call") return part.output === undefined ? [] : [part.id];
        if (part.type === "subagent") return [...answeredCalls(part.subagent.messages)];
        return [];
      }),
    ),
  );

/** The call an activity reports on: effect-agent-harness puts its id in the activity's metadata. */
const toolCallOf = (message: UIMessage): string | undefined => {
  const metadata = message.metadata as Readonly<Record<string, unknown>> | undefined;
  const toolCallId = metadata?.["effect-agent-harness:toolCallId"];
  return typeof toolCallId === "string" ? toolCallId : undefined;
};

/** Where a progress card's call stands: still running, answered, or cut off by the run's end. */
type Progress = "running" | "done" | "stopped";

/** What `search-docs` reports as it runs (its success type, as JSON). */
interface SearchProgress {
  readonly done: number;
  readonly of: number;
  readonly hits: ReadonlyArray<{ readonly source: string; readonly excerpt: string }>;
}

/**
 * A tool's progress, from the `ACTIVITY_SNAPSHOT`s effect-agent-harness sends for
 * `ctx.preliminary`. `activityType` is the tool's name. Live only: after a
 * reload, the tool call's result is all that remains.
 */
function ActivityCard({
  activityType,
  content,
  progress,
}: {
  readonly activityType: string;
  readonly content: Record<string, unknown>;
  readonly progress: Progress;
}) {
  const statusId = useId();
  if (activityType !== "search-docs") {
    return <pre className="tool">{JSON.stringify(content, null, 2)}</pre>;
  }
  const { done, of, hits } = content as unknown as SearchProgress;
  return (
    <div className={`tool activity-card${progress === "running" ? "" : " finished"}`}>
      <div id={statusId} role="status">
        🔎 search-docs ·{" "}
        {progress === "done"
          ? "done"
          : progress === "stopped"
            ? `stopped at ${done} of ${of} sources`
            : `reading ${done} of ${of} sources`}
      </div>
      <progress value={done} max={of} aria-labelledby={statusId} />
      <ul>
        {hits.map((hit) => (
          <li key={hit.source}>
            <strong>{hit.source}:</strong> {hit.excerpt}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Message({
  message,
  progressOf,
}: {
  readonly message: UIMessage;
  readonly progressOf: (toolCallId: string | undefined) => Progress;
}) {
  // The client adds an empty assistant message when a run starts.
  if (message.parts.length === 0) return null;
  return (
    <li className={`message ${message.role}`}>
      {message.parts.map((part, index) => {
        switch (part.type) {
          case "text":
            return <p key={index}>{part.content}</p>;
          case "thinking":
            return (
              <details key={index} className="tool">
                <summary>💭 Reasoning</summary>
                <p>{part.content}</p>
              </details>
            );
          case "tool-call":
            return (
              <details key={part.id} className="tool">
                <summary>
                  🔧 {part.name} {part.arguments}
                </summary>
                {part.output !== undefined && <pre>{JSON.stringify(part.output, null, 2)}</pre>}
              </details>
            );
          case "activity": {
            return (
              <ActivityCard
                key={index}
                activityType={part.activityType}
                content={part.content}
                progress={progressOf(toolCallOf(message))}
              />
            );
          }
          case "subagent":
            // A subagent's work, as TanStack builds it from the `SUBAGENT_*` events (and the server's
            // hydrate rebuilds it after a reload): its own messages, rendered like the assistant's.
            return (
              <details key={part.subagent.id} className="tool subagent" open={part.subagent.status !== "finished"}>
                <summary>
                  🤖 {part.subagent.name} · {SUBAGENT_STATUS[part.subagent.status]}
                </summary>
                {part.subagent.error && <p className="error">{part.subagent.error.message}</p>}
                <ol className="messages">
                  {part.subagent.messages.map((child) => (
                    <Message key={child.id} message={child} progressOf={progressOf} />
                  ))}
                </ol>
              </details>
            );
          default:
            return null;
        }
      })}
    </li>
  );
}
