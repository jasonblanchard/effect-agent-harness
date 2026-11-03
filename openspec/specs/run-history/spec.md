# run-history Specification

## Purpose

Decides which history is canonical for a run. By default it is the client's `RunAgentInput.messages`, as AG-UI describes. A caller can opt into a server history kept in the thread store instead, and can make that choice per runner or per request.

## Requirements

### Requirement: Choosing the run's history
A run SHALL use the history provided in its context. When none is provided, the run SHALL use the client history. The package SHALL provide two histories:
- **The client history:** the run's history is the input's `messages`, as sent.
- **The server history:** the run's history is the thread store's, and every requirement of the agent loop that names the server history applies.

Only the server history SHALL require a thread store. Because the history is read from the run's context, a caller SHALL be able to choose it per request:
- for a request-scoped run, by providing it to that run's stream;
- for a detached run, by providing it around the run's start, which SHALL take precedence over one provided when the runner was built.

A workflow-backed run SHALL use the history provided where its workflow layer is built.

#### Scenario: Default needs no store
- **WHEN** a request-scoped run is made with no history and no thread store provided, and the model replies with text
- **THEN** the run ends with `RUN_FINISHED` with outcome `success`

#### Scenario: Server history opted into
- **WHEN** a run is provided the server history and an in-memory thread store, and a second run on the same thread sends only a new user message
- **THEN** the second run's model prompt holds the first run's turns, taken from the store

#### Scenario: Per request
- **WHEN** one runner serves run "r1" on thread "t1" with the server history provided, and run "r2" on thread "t2" with none
- **THEN** the store holds entries for "t1" only

#### Scenario: Client history chosen explicitly
- **WHEN** the server history is provided to a route's whole context, and one run's stream is provided the client history
- **THEN** that run takes its history from its input and the store receives nothing for it

#### Scenario: Detached start overrides the runner's history
- **WHEN** a detached runner is built in a context with the server history, and a run is started with the client history provided around the start
- **THEN** that run takes its history from its input and the store receives nothing for it

### Requirement: The client history is the input's messages
Under the client history, the model prompt SHALL be the agent's system prompt followed by the input's `messages`, converted in order, with every tool result placed directly after the assistant message holding its tool call. The conversion SHALL be:
- **`user` message with text:** a user message with that text.
- **`assistant` message:** an assistant message with its text and its tool calls, each call's arguments decoded from JSON.
- **`tool` message:** the result of the tool call named by its `toolCallId`. When the message has `error` set, the result SHALL be failed and hold the error text. Otherwise, string content that parses as JSON SHALL be the parsed value, any other string SHALL be itself, and a list of content parts SHALL be its `text` parts joined in order. When several tool messages answer the same call, the first SHALL be used.
- **`system`/`developer` message:** a system message only when the runner is configured to allow client system messages, and dropped otherwise.
- **Any other message,** including a `user` message without text: dropped.

The run SHALL NOT reject the history for differing from what an earlier run produced or stored.

#### Scenario: Multi-turn from the client
- **WHEN** a run's input holds a user message, an assistant message with a `get-weather` call, its tool message and a new user message
- **THEN** the model receives the system prompt, then those four messages in that order

#### Scenario: Edited earlier turn
- **WHEN** a run's input holds m1, then an edited user message m2' in place of the m2 an earlier run answered, with no later messages
- **THEN** the model receives m1 then m2', and the run is not rejected

#### Scenario: Regenerate
- **WHEN** a run's input resends a history without the last assistant reply an earlier run produced
- **THEN** the model receives the history as sent, ending with the user message, and the run is not rejected

#### Scenario: Client system messages dropped by default
- **WHEN** the runner is not configured to allow client system messages and the input holds a `system` message
- **THEN** the model does not receive it, and still receives the agent's system prompt

#### Scenario: Client system messages allowed
- **WHEN** the runner is configured to allow client system messages and the input holds a `system` message
- **THEN** the model receives it in its place in the history, after the agent's system prompt

#### Scenario: Unsupported message role
- **WHEN** the input holds an `activity` message
- **THEN** the run proceeds and the model does not receive the activity message

#### Scenario: Media part in a result
- **WHEN** a tool message holds a text part and an image part
- **THEN** the model receives the text part's text as the call's result, and the run continues

### Requirement: Unusable client messages are dropped with a warning
Under the client history, the run SHALL drop, rather than reject:
- a tool call whose arguments are not a JSON object, together with every tool message answering it;
- a tool message whose `toolCallId` names no tool call in the history;
- an assistant message left with neither text nor tool calls.

It SHALL log a warning naming the dropped calls and messages, and the run SHALL proceed.

#### Scenario: Partial arguments from a stopped run
- **WHEN** the input's last assistant message holds a tool call whose arguments are `{"city":"Par`, followed by a new user message
- **THEN** a warning names the call, the model receives the history without that call, and the run proceeds

#### Scenario: Orphan tool message
- **WHEN** the input holds a tool message whose `toolCallId` matches no call in the history
- **THEN** a warning names the message, the model does not receive it, and the run proceeds

### Requirement: Unanswered calls in the client history get a failed result
Under the client history, a tool call in the history with no tool message answering it and no resume entry approving or denying it SHALL be sent to the model followed by a failed result saying the call did not complete. This SHALL include frontend calls and calls that need approval. The run SHALL NOT end with `UnansweredInterrupt` or `UnansweredToolCall`, and SHALL NOT run the call's handler.

#### Scenario: Approval ignored by the client
- **WHEN** the input holds a "send-email" call that needs approval, no tool message for it, no `resume` entries and a new user message
- **THEN** the email handler does not run, and the model receives the call, a failed "did not complete" result, then the new user message

#### Scenario: Frontend call not answered
- **WHEN** the input holds a `pick-file` call with no tool message for it, followed by a new user message
- **THEN** the run proceeds, and the model receives the call followed by a failed result

### Requirement: Resume entries answer approvals in the client history
Under the client history, a `resume` entry SHALL answer the approval of a tool call in the history when the entry's `interruptId` is the interrupt id that call's approval was given, and the history holds no tool message answering that call. Such a call SHALL be:
- **approved** only when `status` is `resolved` and `payload.approved` is `true`;
- **denied** otherwise, with `payload.reason`, "cancelled" or "denied" as the reason.

Approved calls SHALL execute before the first model step and emit `TOOL_CALL_RESULT`. Denied calls SHALL emit a failed `TOOL_CALL_RESULT` naming the reason. The model SHALL then be called with those results in the prompt. A `resume` entry that matches no such call SHALL be ignored. The answer SHALL be trusted as sent: the run SHALL NOT check that an earlier run raised the interrupt.

#### Scenario: Approved
- **WHEN** a run interrupted for a "send-email" approval, and the next run's input resends the history and carries `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]` with the interrupt's id
- **THEN** the email handler runs once, `TOOL_CALL_RESULT` for the call is emitted before any text, and the model is called with the result

#### Scenario: Cancelled
- **WHEN** the next run carries `resume: [{ interruptId, status: "cancelled" }]` for that interrupt
- **THEN** the email handler does not run, and a failed `TOOL_CALL_RESULT` with content naming "cancelled" is emitted

#### Scenario: Already answered in the history
- **WHEN** the input holds the "send-email" call followed by a tool message answering it, and carries an approving `resume` entry for its interrupt
- **THEN** the email handler does not run, and the model receives the call with the client's result

#### Scenario: Unknown interrupt id
- **WHEN** a `resume` entry names an interrupt id that matches no call in the history
- **THEN** it is ignored and the run proceeds

### Requirement: The client history uses no thread store
Under the client history, a run SHALL NOT load, commit to, claim or release a thread, and SHALL NOT notify a store that it ended. Two runs on the same thread SHALL be able to run at the same time.

#### Scenario: Store untouched
- **WHEN** a run with the client history is served in a context that also holds a thread store, but no server history
- **THEN** the store receives no load, commit, claim, release or run-ended call

#### Scenario: Concurrent runs on one thread
- **WHEN** run "r2" is started on thread "t1" while run "r1" on "t1" is streaming
- **THEN** both runs finish normally
