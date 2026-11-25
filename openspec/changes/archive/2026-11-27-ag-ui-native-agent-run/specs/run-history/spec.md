## MODIFIED Requirements

### Requirement: The client history is the input's messages
Under the client history, the model prompt SHALL be the agent's system prompt followed by the input's `messages` that carry no `subagentRunId`, converted in order, with every tool result placed directly after the assistant message holding its tool call. Messages carrying a `subagentRunId` SHALL be converted the same way and kept as the named subagent's entries, which SHALL NOT be sent to the agent's model. The conversion SHALL be:
- **`user` message with text:** a user message with that text.
- **`assistant` message:** an assistant message with its text and its tool calls, each call's arguments decoded from JSON.
- **`tool` message:** the result of the tool call named by its `toolCallId`. When the message has `error` set, the result SHALL be failed and hold the error text. Otherwise, string content that parses as JSON SHALL be the parsed value, any other string SHALL be itself, and a list of content parts SHALL be its `text` parts joined in order; that result SHALL be failed when the message's metadata carries `effect/ai`'s failure marker (see the agui-agent-loop requirement "Failed tool results are marked"). When several tool messages answer the same call, the first SHALL be used.
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

#### Scenario: Failure marker without an error
- **WHEN** the input holds a `get-weather` call and a tool message for it with content `"Unknown location"` and `metadata["effect/ai"]` `{ "isFailure": true }`, and no `error`
- **THEN** the model receives the call followed by a failed result holding "Unknown location"
