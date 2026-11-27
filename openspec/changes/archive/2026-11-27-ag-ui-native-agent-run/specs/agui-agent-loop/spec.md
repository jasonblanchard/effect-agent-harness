## ADDED Requirements

### Requirement: Failed tool results are marked
Every `TOOL_CALL_RESULT` for a failed result SHALL carry `metadata["effect/ai"]` `{ "isFailure": true }`, the marker `effect/ai`'s own AG-UI agent puts on failed results and its prompt conversion reads. A successful result SHALL NOT carry it. The marker SHALL reach a client and the event log unchanged, next to any other metadata the event carries. Wherever the package reads a client's `tool` message (the client history, and answers to pending frontend calls), it SHALL treat the message as a failed result when it has `error` set or carries that marker. With `error` set, the result SHALL be the error text. With only the marker, the result SHALL be the message's content, decoded as for any result.

#### Scenario: Failed result on the stream
- **WHEN** the weather handler fails with "Unknown location"
- **THEN** the call's `TOOL_CALL_RESULT` carries `metadata["effect/ai"]` `{ "isFailure": true }`, and the sequence passes the AG-UI client's checks

#### Scenario: Successful result
- **WHEN** the weather handler returns `{"temp":21}`
- **THEN** the call's `TOOL_CALL_RESULT` carries no `effect/ai` metadata

#### Scenario: Round trip under the client history
- **WHEN** an `HttpAgent` receives a failed `TOOL_CALL_RESULT` and sends its messages back in the next run under the client history
- **THEN** the model receives that call's result as a failure

#### Scenario: Frontend answer marked as failed
- **WHEN** under the server history a client answers a pending frontend call with a `tool` message whose metadata carries the marker and no `error`
- **THEN** the stored result is failed and holds the message's content

## MODIFIED Requirements

### Requirement: Run lifecycle
The agent SHALL emit `RUN_STARTED` as the first event of every run and SHALL end every run with exactly one terminal event: `RUN_FINISHED` on success, interruption or cancellation, or `RUN_ERROR` on failure. It SHALL NOT emit any event after the terminal event. `RUN_STARTED` and `RUN_FINISHED` SHALL carry the `threadId` and `runId` from the run input. `RUN_STARTED` SHALL declare the AG-UI `protocolVersion`, and `RUN_FINISHED` SHALL carry the success outcome, the interrupt outcome or the cancelled outcome. A cancelled `RUN_FINISHED` SHALL carry no `result`, and every message, reasoning span, tool call, step and subagent the run opened SHALL be closed before it. `RUN_ERROR` SHALL carry a `code` naming the kind of failure when one is known.

The terminal event SHALL carry `usage`: one entry summing the input, output, total, reasoning, cached-input and cache-write token counts the model reported for every model step of the run, its children's steps included. A step served from the checkpoint store SHALL count the usage its checkpoint recorded, so a run executed again after an interruption reports the same totals as one that was not interrupted. A count no step reported SHALL be left out. `usage` SHALL be left out when no step reported any count.

#### Scenario: Successful run
- **WHEN** a run is started with `threadId` "t1" and `runId` "r1" and the model replies with text only
- **THEN** the first event is `RUN_STARTED` with `threadId` "t1" and `runId` "r1"
- **AND** the last event is `RUN_FINISHED` with `threadId` "t1" and `runId` "r1" and outcome type `success`

#### Scenario: Model failure
- **WHEN** the model request fails partway through a run
- **THEN** the run ends with a single `RUN_ERROR` event carrying a message
- **AND** no events follow it

#### Scenario: Failure before the model is called
- **WHEN** a run uses the server history and loading the thread fails
- **THEN** the run emits `RUN_STARTED` followed by `RUN_ERROR` whose `code` is `ThreadError`

#### Scenario: Cancelled run
- **WHEN** a run is cancelled while the model streams text and a reasoning block is open
- **THEN** the stream closes the reasoning block and the text message, emits `STEP_FINISHED`, and ends with `RUN_FINISHED` with outcome type `cancelled` and no `result`, and the sequence passes the AG-UI client's checks

#### Scenario: Usage over two steps
- **WHEN** a run takes two model steps, which report 10 then 20 input tokens and 5 then 7 output tokens
- **THEN** `RUN_FINISHED` carries `usage` with one entry: `inputTokens` 30, `outputTokens` 12 and `totalTokens` 42

#### Scenario: Usage includes a subagent
- **WHEN** the parent's step reports 10 input tokens and the child it calls reports 4
- **THEN** the run's `usage` entry has `inputTokens` 14

#### Scenario: Usage survives a resume
- **WHEN** a run with a durable checkpoint store is interrupted during step 2 and executed again
- **THEN** its terminal event reports the same `usage` as the same run executed without the interruption

#### Scenario: Usage survives a failed end
- **WHEN** a run under the server history makes a model step that reports usage, and the store then fails to record the run's end
- **THEN** the `RUN_ERROR` with code `ThreadError` that replaces the run's terminal event carries the run's `usage`

#### Scenario: No usage reported
- **WHEN** the model reports no token counts
- **THEN** the terminal event has no `usage`

### Requirement: Tool progress streams as activity snapshots
For each preliminary result a tool handler reports while it executes, the agent SHALL emit an `ACTIVITY_SNAPSHOT` with `activityType` set to the tool name, `metadata` holding the call's id under the key `effect-agent-harness:toolCallId`, and `content` set to the encoded preliminary value when that value is a JSON object, or to `{ "value": <encoded value> }` otherwise. Every snapshot for one tool call SHALL carry the same `messageId`, and that `messageId` SHALL NOT be used by any other message. Snapshots SHALL NOT set `replace` to `false`. A call's snapshots SHALL come after its `TOOL_CALL_END` and before its `TOOL_CALL_RESULT`. Activity SHALL NOT be committed to the thread, so a thread read back holds no activity messages. Snapshots SHALL be part of the run's event stream like any other event, so a run's event log holds them and a client following the log receives them.

#### Scenario: Progress snapshot
- **WHEN** the `search` tool, called with id "call_1", reports the preliminary value `{"done":1,"of":3}`
- **THEN** the agent emits `ACTIVITY_SNAPSHOT` with `activityType` "search", `content` `{"done":1,"of":3}` and `metadata` `{"effect-agent-harness:toolCallId":"call_1"}`, after the call's `TOOL_CALL_END` and before its `TOOL_CALL_RESULT`

#### Scenario: Snapshots of one call share an id
- **WHEN** a tool call reports three preliminary values
- **THEN** the three `ACTIVITY_SNAPSHOT` events carry the same `messageId`

#### Scenario: Value that is not an object
- **WHEN** a tool whose success schema is a number reports the preliminary value `42`
- **THEN** the snapshot's `content` is `{"value":42}`

#### Scenario: Not in the thread
- **WHEN** a run under the server history completes a tool call that reported progress, and the thread is then read back
- **THEN** the read returns the call and its result, and no activity message

#### Scenario: Detached run's log
- **WHEN** a detached run's tool reports progress and a client follows the run's log from the start
- **THEN** the client receives the `ACTIVITY_SNAPSHOT` events in the same position as a client attached to the run

### Requirement: Run info from the AG-UI input and the caller
The agent SHALL run each AG-UI run with its AG-UI input as the current run, unchanged: its `runId` and `threadId`, its `forwardedProps` as the run's properties, and every other field as the client sent it. The trusted context the caller provides for the run SHALL reach the agent only as its declared run contexts' services and the services built from them. Nothing in the AG-UI input, including its `forwardedProps`, its `state` and its own `context` field, SHALL become one of those services. An input without `forwardedProps` SHALL run with no properties.

#### Scenario: Forwarded properties reach the system prompt
- **WHEN** an agent's system prompt reads the properties of the current run and a run arrives with `forwardedProps: { locale: "fr" }`
- **THEN** the system prompt is computed with properties `{ locale: "fr" }` and with that input's run id and thread id

#### Scenario: No forwarded properties
- **WHEN** a run arrives without `forwardedProps`
- **THEN** the system prompt is computed with no properties

#### Scenario: Caller's context reaches tools
- **WHEN** a caller provides the "app/Auth" service `{ userId: "u1" }` to a run on a runner whose layer builds `CurrentUser` from "app/Auth", and the model calls a tool that requires `CurrentUser`
- **THEN** the handler sees the `CurrentUser` for `userId: "u1"`

#### Scenario: The client cannot set the context
- **WHEN** a caller provides the "app/Auth" service `{ userId: "u1" }` and the input's `forwardedProps` is `{ "app/Auth": { userId: "u2" }, userId: "u2" }` and its `state` is `{ userId: "u2" }`
- **THEN** the tool sees the `CurrentUser` for `userId: "u1"`, and the client's values appear only in the run's AG-UI input
