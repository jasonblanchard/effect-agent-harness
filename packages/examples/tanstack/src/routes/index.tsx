import { createFileRoute } from "@tanstack/react-router";
import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/")({
  component: Chat,
});

function Chat() {
  // The server owns the thread's history, so a fresh page needs a fresh thread:
  // reusing an id the server already holds, without its history, is rejected.
  const [threadId] = useState(() => crypto.randomUUID());
  const { messages, sendMessage, isLoading, error, stop, interrupts, resumeInterruptsUnsafe } = useChat({
    connection: fetchServerSentEvents("/api/chat"),
    threadId,
  });
  const [input, setInput] = useState("");

  // effentic's approval interrupts are plain AG-UI interrupts, without TanStack's
  // own binding metadata, so TanStack lists them as `unbound` and offers no
  // `resolveInterrupt`. Answer them with AG-UI `resume` entries instead: the
  // payload is effentic's `AgUi.ApprovalResponse`.
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
        <h1>effentic × TanStack AI</h1>
        <p>Ask about the weather anywhere, or ask it to send an email (it asks you first).</p>
      </header>
      <ol className="messages">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
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
        {isLoading ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </main>
  );
}

function Message({ message }: { readonly message: UIMessage }) {
  // The client adds an empty assistant message when a run starts.
  if (message.parts.length === 0) return null;
  return (
    <li className={`message ${message.role}`}>
      {message.parts.map((part, index) => {
        switch (part.type) {
          case "text":
            return <p key={index}>{part.content}</p>;
          case "tool-call":
            return (
              <details key={part.id} className="tool">
                <summary>
                  🔧 {part.name} {part.arguments}
                </summary>
                {part.output !== undefined && <pre>{JSON.stringify(part.output, null, 2)}</pre>}
              </details>
            );
          default:
            return null;
        }
      })}
    </li>
  );
}
