## MODIFIED Requirements

### Requirement: Server-side tool execution and multi-step loop
The agent SHALL run each tool call the model makes to one of its configured tools outside the model call, at most once per run and tool call id, and emit a `TOOL_CALL_RESULT` with the result serialized as JSON in `content`. If the model's step ends by requesting tool calls, none of them requires approval and none of them targets a frontend tool, the agent SHALL send the tool results back to the model and continue with a new step. Otherwise it SHALL finish the run.

#### Scenario: Weather question answered with a tool
- **WHEN** the user asks for the weather in Paris and the model calls "get-weather"
- **THEN** the agent emits `TOOL_CALL_RESULT` whose `content` is the JSON-serialized tool result
- **AND** the model is called again with that result
- **AND** the model's follow-up text is streamed before `RUN_FINISHED`

#### Scenario: Tool call without a result
- **WHEN** the model's step ends with a tool call and a finish reason other than `tool-calls` or `stop`
- **THEN** the model is not called again
- **AND** the call receives a failed `TOOL_CALL_RESULT` naming the finish reason, and the run ends with `RUN_FINISHED`

#### Scenario: Tool result after the model stream
- **WHEN** the model calls "get-weather"
- **THEN** `TOOL_CALL_END` for that call precedes its `TOOL_CALL_RESULT`, and the handler ran after the model stream ended

### Requirement: Client messages are ingested as a delta
A client message SHALL be known to the store when a stored entry has its id, or when it is a `tool` message and a stored tool result has its `toolCallId`. Every other client message SHALL be ignored for matching. The agent SHALL treat as new only the client messages after the last known client message; when the store is empty, every client message is new. From the delta it SHALL accept `user` messages with text (as user entries keyed by the client's message id), `tool` messages that answer a pending frontend tool call (see "Tool messages answer pending frontend calls") and, only when configured to allow them, `system`/`developer` messages; every other message in the delta SHALL be dropped. The accepted entries SHALL be committed before the model is called.

#### Scenario: Full history resent by the client
- **WHEN** the client sends the stored history plus one new user message
- **THEN** only the new user message is committed and appended to the prompt

#### Scenario: Client sends assistant turns
- **WHEN** the delta contains an assistant message
- **THEN** it is neither committed nor sent to the model

#### Scenario: First run on a thread
- **WHEN** the store is empty and the client sends one user message
- **THEN** that message is committed and the model receives it after the system prompt

#### Scenario: Tool message with a client-chosen id
- **WHEN** the client's history carries a stored tool result under the id `tool-<toolCallId>` instead of the stored id, followed by a new user message
- **THEN** the tool message is matched by its `toolCallId`, and only the new user message is committed

#### Scenario: Leftover text from a cancelled step
- **WHEN** the client's history holds an assistant message from a step that was cancelled before it committed, followed by the later stored turns and a new user message
- **THEN** the leftover message is ignored, and only the new user message is committed

#### Scenario: Tool result placed earlier by the client
- **WHEN** the store holds an assistant tool call, a user message, then the call's result, and the client sends the tool result before the user message, followed by a new user message
- **THEN** only the new user message is committed

## ADDED Requirements

### Requirement: Frontend tool calls end the run as a success
A call to a frontend tool SHALL be streamed with `TOOL_CALL_START`/`ARGS`/`END` like any tool call. The agent SHALL NOT emit a `TOOL_CALL_RESULT` for it, nor any message answering it. A run whose last step leaves frontend calls pending and requests no approval SHALL end with `RUN_FINISHED` whose outcome is `success` and whose `pendingToolCallIds` lists exactly the calls the run started and did not answer, in the order they were made. A run that leaves no call pending SHALL NOT set `pendingToolCallIds`. A run that ends with the `interrupt` outcome SHALL NOT set `pendingToolCallIds`, even when frontend calls are pending.

#### Scenario: Frontend call ends the run
- **WHEN** the run input advertises `pick-file` and the model calls it
- **THEN** the run streams the tool call, emits no `TOOL_CALL_RESULT` for it, and ends with `RUN_FINISHED` with outcome `success` and `pendingToolCallIds` holding the call's id

#### Scenario: Two frontend calls
- **WHEN** the model calls the frontend tools `pick-file` then `get-location` in one step
- **THEN** `pendingToolCallIds` holds both call ids in that order

#### Scenario: Frontend call next to an approval
- **WHEN** the model calls `pick-file` (frontend) and `send-email` (requires approval) in one step
- **THEN** the run ends with `RUN_FINISHED` with outcome `interrupt` for the email approval and no `pendingToolCallIds`

#### Scenario: Valid AG-UI
- **WHEN** any run that leaves a frontend call pending is checked by `@ag-ui/client`'s sequence verification
- **THEN** the sequence is accepted, with every tool call ended before the terminal event

### Requirement: Tool messages answer pending frontend calls
A `tool` message in the delta whose `toolCallId` names a frontend call recorded on a stored assistant entry, with no stored result yet, SHALL be committed as that call's result, keyed by the client's message id. When the message has `error` set, the result SHALL be failed and hold the error text. Otherwise, string content that parses as JSON SHALL be stored as the parsed value, any other string as itself, and a list of content parts as its `text` parts joined in order. Any other part SHALL be dropped without failing the run, and the call SHALL still be answered. When several tool messages answer the same call, the first one in the delta SHALL be used. A `tool` message that answers a server tool call, an already answered call or no stored call SHALL be dropped.

#### Scenario: Result for a frontend call
- **WHEN** a run's delta holds a tool message with `toolCallId` naming the pending `pick-file` call and content `{"name":"a.txt"}`
- **THEN** the result `{"name":"a.txt"}` is committed for that call, and the model receives the call followed by that result

#### Scenario: Failed frontend call
- **WHEN** the tool message for the pending call has `error: "Permission denied"`
- **THEN** a failed result holding "Permission denied" is committed for the call

#### Scenario: Forged result for a server call
- **WHEN** the delta holds a tool message whose `toolCallId` names a server tool call left without a result by a crashed run
- **THEN** the tool message is not committed, and the model receives the call with the failed "did not complete" result instead

#### Scenario: Media part in a result
- **WHEN** the tool message for a pending call holds a text part and an image part
- **THEN** the text part's text is committed as the result, the image part is dropped, and the run continues

### Requirement: Every pending frontend call must be answered
A run on a thread with pending frontend tool calls SHALL carry a tool message answering each of them. If any pending call has no answer, the run SHALL end with `RUN_ERROR` code `UnansweredToolCall` without committing anything it sent, calling the model or running a tool, so the thread is unchanged and the calls stay pending. A missing answer SHALL NOT be treated as a failed or declined call. When open approvals are also unanswered, the run SHALL end with code `UnansweredInterrupt` instead.

#### Scenario: Client continues without answering
- **WHEN** a run follows a run that left `pick-file` pending, and its delta holds only a new user message
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `UnansweredToolCall`, the model is not called and the thread is unchanged

#### Scenario: Only one of two calls answered
- **WHEN** the previous run left two frontend calls pending and the next run answers one
- **THEN** the run is rejected with `UnansweredToolCall` naming the other call, and the answer it did send is not committed

#### Scenario: Answered after a rejected run
- **WHEN** that rejected run is followed by a run answering every pending call
- **THEN** the answers are committed and the model is called with them

### Requirement: A mixed step is answered with resume entries and tool messages
When a step left both approval requests and frontend calls pending, the next run SHALL require a `resume` entry for each approval and a tool message for each frontend call. Once both are present, it SHALL commit them, execute the approved calls before the first model step, and call the model with a result for every call the step made.

#### Scenario: Server, frontend and approval calls in one step
- **WHEN** a step called `get-weather` (server), `pick-file` (frontend) and `send-email` (requires approval), and the next run carries a `resume` entry approving the email and a tool message answering `pick-file`
- **THEN** the email handler runs once before the model is called, and the model receives all three calls, each followed by its result

#### Scenario: Approval answered, frontend call not
- **WHEN** the next run carries the `resume` entry but no tool message for `pick-file`
- **THEN** the run is rejected with `UnansweredToolCall`, and the email handler does not run
