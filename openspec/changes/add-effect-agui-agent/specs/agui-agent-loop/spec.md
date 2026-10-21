## Purpose

Runs a language-model agent with server-side tools for one AG-UI run. It turns the run input into an AG-UI event stream that a strict AG-UI client accepts, and it works the same way whichever model provider is configured.

## ADDED Requirements

### Requirement: Run lifecycle
The agent SHALL emit `RUN_STARTED` as the first event of every run and SHALL end every run with exactly one terminal event: `RUN_FINISHED` on success or `RUN_ERROR` on failure. It SHALL NOT emit any event after the terminal event. `RUN_STARTED` and `RUN_FINISHED` SHALL carry the `threadId` and `runId` from the run input. `RUN_STARTED` SHALL declare the AG-UI `protocolVersion`, and `RUN_FINISHED` SHALL carry the success outcome. `RUN_ERROR` SHALL carry a `code` naming the kind of failure when one is known.

#### Scenario: Successful run
- **WHEN** a run is started with `threadId` "t1" and `runId` "r1" and the model replies with text only
- **THEN** the first event is `RUN_STARTED` with `threadId` "t1" and `runId` "r1"
- **AND** the last event is `RUN_FINISHED` with `threadId` "t1" and `runId` "r1"

#### Scenario: Model failure
- **WHEN** the model request fails partway through a run
- **THEN** the run ends with a single `RUN_ERROR` event carrying a message
- **AND** no events follow it

### Requirement: Well-formed spans
Every `TEXT_MESSAGE_CONTENT` SHALL fall between a `TEXT_MESSAGE_START` and a `TEXT_MESSAGE_END` with the same `messageId`. Every `TOOL_CALL_ARGS` SHALL fall between a `TOOL_CALL_START` and a `TOOL_CALL_END` with the same `toolCallId`. No text message or tool call SHALL be left open when the terminal event is emitted, including when the model stream ends abruptly or the run fails.

#### Scenario: Model stream ends mid-message
- **WHEN** the model stream stops after a text delta without signalling the end of the text
- **THEN** the agent emits `TEXT_MESSAGE_END` for that message before the terminal event

#### Scenario: Failure during tool-call arguments
- **WHEN** the model fails while streaming a tool call's arguments
- **THEN** the agent emits `TOOL_CALL_END` for that tool call before `RUN_ERROR`

### Requirement: Streamed assistant text
The agent SHALL stream assistant text as it is produced, using `TEXT_MESSAGE_START` with role `assistant`, one `TEXT_MESSAGE_CONTENT` per text delta in the order produced, and `TEXT_MESSAGE_END`.

#### Scenario: Text reply
- **WHEN** the model produces the deltas "Hel", "lo"
- **THEN** the agent emits `TEXT_MESSAGE_START` (role `assistant`), `TEXT_MESSAGE_CONTENT` "Hel", `TEXT_MESSAGE_CONTENT` "lo", `TEXT_MESSAGE_END`, all with the same `messageId`

### Requirement: Streamed tool calls
For every tool call the model makes, the agent SHALL emit `TOOL_CALL_START` with the tool name, `TOOL_CALL_ARGS` for each argument fragment in order, and `TOOL_CALL_END`. `TOOL_CALL_START` SHALL set `parentMessageId` to the assistant message ID of the model step that made the call.

#### Scenario: Tool call with streamed arguments
- **WHEN** the model calls tool "get-weather" with argument fragments `{"location":` and `"Paris"}`
- **THEN** the agent emits `TOOL_CALL_START` (toolCallName "get-weather"), two `TOOL_CALL_ARGS` with those fragments, and `TOOL_CALL_END`, all with the same `toolCallId`

#### Scenario: Text and tool call in the same step
- **WHEN** the model writes text and then calls a tool within one step
- **THEN** the tool call's `parentMessageId` equals that step's text `messageId`

### Requirement: Server-side tool execution and multi-step loop
The agent SHALL run each tool call against its configured tools and emit a `TOOL_CALL_RESULT` with the result serialized as JSON in `content`. If the model's step ends by requesting tool calls and every call in that step has a result, the agent SHALL send the tool results back to the model and continue with a new step. Otherwise it SHALL finish the run, listing any tool calls the step made without a result in the outcome's `pendingToolCallIds`.

#### Scenario: Weather question answered with a tool
- **WHEN** the user asks for the weather in Paris and the model calls "get-weather"
- **THEN** the agent emits `TOOL_CALL_RESULT` whose `content` is the JSON-serialized tool result
- **AND** the model is called again with that result
- **AND** the model's follow-up text is streamed before `RUN_FINISHED`

#### Scenario: Tool call without a result
- **WHEN** the model's step ends by requesting a tool call that no configured tool answers
- **THEN** the model is not called again
- **AND** the run ends with `RUN_FINISHED` whose outcome lists that call in `pendingToolCallIds`

### Requirement: Tool failures are returned to the model
When a tool handler fails, the agent SHALL report the failure to the model as that tool call's result and emit it as `TOOL_CALL_RESULT`. It SHALL NOT end the run because of the failure.

#### Scenario: Unknown location
- **WHEN** the weather tool fails because the location cannot be found
- **THEN** a `TOOL_CALL_RESULT` describing the failure is emitted
- **AND** the model is called again and the run can still end with `RUN_FINISHED`

### Requirement: Step limit
The agent SHALL enforce a configurable maximum number of model steps per run, defaulting to 10. When the limit is reached and the model still requests tool calls, the run SHALL end with `RUN_ERROR` stating that the step limit was exceeded.

#### Scenario: Model keeps calling tools
- **WHEN** the step limit is 2 and the model requests tool calls on both steps
- **THEN** the run ends with `RUN_ERROR` saying the step limit was exceeded, and no third model call is made

### Requirement: Provider-independent message identifiers
The agent SHALL assign its own AG-UI message IDs and SHALL NOT reuse the model provider's text-part IDs. Each model step SHALL get one new assistant `messageId`, shared by all of that step's text. Each `TOOL_CALL_RESULT` SHALL get a new `messageId`. Message IDs SHALL be unique across steps and across runs.

#### Scenario: Provider reuses part IDs across steps
- **WHEN** the provider labels the text of step 1 and the text of step 2 both with part ID "0"
- **THEN** the two steps' `TEXT_MESSAGE_START` events have different `messageId`s

#### Scenario: Multiple text blocks in one step
- **WHEN** the model emits two separate text blocks within one step
- **THEN** both are emitted with the same `messageId`

#### Scenario: Deterministic IDs in tests
- **WHEN** the agent is run with a deterministic ID generator
- **THEN** the emitted `messageId`s are exactly the ones that generator produced

### Requirement: Tool call identifiers pass through unchanged
The `toolCallId` on `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` and `TOOL_CALL_RESULT` SHALL be the tool call ID reported by the model layer, unchanged.

#### Scenario: Provider tool ID
- **WHEN** the model layer reports a tool call with ID "toolu_abc"
- **THEN** all events for that tool call carry `toolCallId` "toolu_abc"

### Requirement: Conversation history from the client
The agent SHALL rebuild the model conversation from the run input's `messages` on every run and SHALL NOT keep conversation state between runs. It SHALL convert:
- system and developer messages into system instructions, only when configured to allow them (they SHALL be dropped by default)
- user messages with text into user turns
- assistant messages into assistant turns containing their text and tool calls
- tool messages into tool results, with the tool name taken from the matching earlier assistant tool call, marked as failed when the message carries an `error`

It SHALL ignore message roles it does not support. A configured system prompt SHALL come before the converted history. Every tool call sent to the model SHALL have a result: a tool call with no tool message before the next user, system or assistant message, or before the end of the history, SHALL be sent with a failed result.

#### Scenario: Follow-up question uses earlier context
- **WHEN** a second run's `messages` contain the first run's user message, the assistant message with its tool call, the tool message, and a new user message
- **THEN** the model receives all of them as conversation history, with the tool result linked to its tool call by ID

#### Scenario: Earlier run stopped before a tool result
- **WHEN** `messages` contain an assistant tool call followed by a user message, with no tool message for that call
- **THEN** the model receives the tool call followed by a failed result for it, and the run proceeds

#### Scenario: Client system messages dropped by default
- **WHEN** the agent is not configured to allow client system messages and `messages` include a `system` message
- **THEN** that message is not sent to the model and the configured system prompt still is

#### Scenario: Unsupported message role
- **WHEN** `messages` include an `activity` message
- **THEN** the run proceeds and the activity message is not sent to the model

### Requirement: Provider independence
The agent SHALL work with any configured language model and SHALL NOT depend on a specific model provider.

#### Scenario: Scripted model
- **WHEN** the agent runs against a scripted test model that emits text and tool-call parts
- **THEN** it produces the same kind of well-formed AG-UI event stream as with a real provider
