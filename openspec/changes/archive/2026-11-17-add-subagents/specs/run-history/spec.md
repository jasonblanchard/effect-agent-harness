## MODIFIED Requirements

### Requirement: The client history is the input's messages
Under the client history, the model prompt SHALL be the agent's system prompt followed by the input's `messages` that carry no `subagentRunId`, converted in order, with every tool result placed directly after the assistant message holding its tool call. Messages carrying a `subagentRunId` SHALL be converted the same way and kept as the named subagent's entries, which SHALL NOT be sent to the agent's model. The conversion SHALL be:
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

#### Scenario: Child messages sent back
- **WHEN** the input holds a `researcher` call, the child's assistant and tool messages tagged with its `subagentRunId`, the call's tool message and a new user message
- **THEN** the model receives the call, its result and the new user message, and none of the child's messages

### Requirement: Unanswered calls in the client history get a failed result
Under the client history, a tool call in the history with no tool message answering it and no resume entry approving or denying it SHALL be sent to the model followed by a failed result saying the call did not complete. This SHALL include frontend calls, calls that need approval, and subagent calls whose child left no messages in the history. A subagent call with no tool message whose child's messages are in the history SHALL instead be treated as a suspended subagent call and resumed before the first model step. The run SHALL NOT end with `UnansweredInterrupt` or `UnansweredToolCall`, and SHALL NOT run the call's handler.

#### Scenario: Approval ignored by the client
- **WHEN** the input holds a "send-email" call that needs approval, no tool message for it, no `resume` entries and a new user message
- **THEN** the email handler does not run, and the model receives the call, a failed "did not complete" result, then the new user message

#### Scenario: Frontend call not answered
- **WHEN** the input holds a `pick-file` call with no tool message for it, followed by a new user message
- **THEN** the run proceeds, and the model receives the call followed by a failed result

#### Scenario: Suspended child sent back
- **WHEN** the input holds a `researcher` call with no tool message, followed by the child's messages tagged with its `subagentRunId`
- **THEN** the child is re-entered before the first model step with those messages as its history

#### Scenario: Child messages dropped by the client
- **WHEN** the input holds a `researcher` call with no tool message and no messages tagged with its child's id
- **THEN** the model receives the call followed by a failed "did not complete" result, and the child is not re-entered

### Requirement: Resume entries answer approvals in the client history
Under the client history, a `resume` entry SHALL answer the approval of a tool call in the history when the entry's `interruptId` is the interrupt id that call's approval was given, and the history holds no tool message answering that call. This SHALL include calls in a subagent's messages, whose answer SHALL be that subagent's. Such a call SHALL be:
- **approved** only when `status` is `resolved` and `payload.approved` is `true`;
- **denied** otherwise, with `payload.reason`, "cancelled" or "denied" as the reason.

Approved calls SHALL execute before the first model step of the agent that made them and emit `TOOL_CALL_RESULT`. Denied calls SHALL emit a failed `TOOL_CALL_RESULT` naming the reason. That agent's model SHALL then be called with those results in the prompt. A `resume` entry that matches no such call SHALL be ignored. The answer SHALL be trusted as sent: the run SHALL NOT check that an earlier run raised the interrupt.

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

#### Scenario: Child's approval
- **WHEN** a child was suspended for a "send-email" approval, and the next run's input resends the history with the child's messages and approves the interrupt
- **THEN** the email handler runs once inside the re-entered child, under the child's `subagentRunId`, and the parent's model receives the child's reply as the spawning call's result
