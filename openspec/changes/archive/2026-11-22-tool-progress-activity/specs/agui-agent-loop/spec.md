## ADDED Requirements

### Requirement: Tool progress streams as activity snapshots
For each tool-progress event, the agent SHALL emit an `ACTIVITY_SNAPSHOT` with `activityType` set to the tool name, `metadata` holding the call's id under the key `effect-agent-harness:toolCallId`, and `content` set to the encoded preliminary value when that value is a JSON object, or to `{ "value": <encoded value> }` otherwise. Every snapshot for one tool call SHALL carry the same `messageId`, and that `messageId` SHALL NOT be used by any other message. Snapshots SHALL NOT set `replace` to `false`. A call's snapshots SHALL come after its `TOOL_CALL_END` and before its `TOOL_CALL_RESULT`. Activity SHALL NOT be committed to the thread, so a thread read back holds no activity messages. Snapshots SHALL be part of the run's event stream like any other event, so a run's event log holds them and a client following the log receives them.

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

### Requirement: Superseded activity snapshots may be dropped
When a consumer reads the run's events more slowly than they are produced, the agent SHALL be allowed to drop an `ACTIVITY_SNAPSHOT` only if a later `ACTIVITY_SNAPSHOT` with the same `messageId` is already waiting behind it. The last snapshot for a tool call before that call's `TOOL_CALL_RESULT` SHALL always be delivered. No other event SHALL be dropped or reordered.

#### Scenario: Slow consumer
- **WHEN** a tool reports ten preliminary values while the consumer is blocked, and the consumer then resumes
- **THEN** the consumer receives at least the tenth snapshot, before the call's `TOOL_CALL_RESULT`, and every other event of the run in order

#### Scenario: Fast consumer
- **WHEN** the consumer reads each event as soon as it is produced
- **THEN** it receives one snapshot per preliminary value

## MODIFIED Requirements

### Requirement: Provider-independent message identifiers
The agent SHALL assign its own AG-UI message IDs and SHALL NOT reuse the model provider's text-part or reasoning-part IDs. Each model step SHALL get one new assistant `messageId`, shared by all of that step's text. Each reasoning block SHALL get its own `messageId`, different from the step's assistant `messageId`, and that id SHALL be the same every time the block is read. Each `TOOL_CALL_RESULT` SHALL get a new `messageId`. Each tool call that reports progress SHALL get one activity `messageId`, derived from the assistant `messageId` of the step that made the call and the call's tool call ID, or, for an approved call executed in step 0 (whose call an earlier run made), from its approval id, so a re-executed call's snapshots carry the same `messageId` as the earlier attempt's. Message IDs SHALL be unique across steps and across runs, except that the activity `messageId` of an approved call executed in step 0, like its approval id, is unique only if tool call ids are unique within the thread.

#### Scenario: Provider reuses part IDs across steps
- **WHEN** the provider labels the text of step 1 and the text of step 2 both with part ID "0"
- **THEN** the two steps' `TEXT_MESSAGE_START` events have different `messageId`s

#### Scenario: Multiple text blocks in one step
- **WHEN** the model emits two separate text blocks within one step
- **THEN** both are emitted with the same `messageId`

#### Scenario: Multiple reasoning blocks in one step
- **WHEN** the model emits two separate reasoning blocks within one step
- **THEN** they are emitted with two different `messageId`s, neither equal to the step's assistant `messageId`

#### Scenario: Deterministic IDs in tests
- **WHEN** the agent is run with a deterministic ID generator
- **THEN** the emitted `messageId`s are exactly the ones that generator produced, or derived only from them and, for activity, the tool call ID

#### Scenario: Provider reuses a tool call ID across steps
- **WHEN** the provider gives a tool call in step 1 and a tool call in step 3 the same ID, and both report progress
- **THEN** the two calls' `ACTIVITY_SNAPSHOT` events have different `messageId`s

#### Scenario: Approved call reports progress in step 0
- **WHEN** a call approved in an earlier run reports progress while it executes in step 0
- **THEN** its snapshots share one `messageId`, derived from the call's approval id and equal to no other message's

#### Scenario: Parallel calls report progress
- **WHEN** two tool calls in one step both report progress
- **THEN** their snapshots carry two different `messageId`s, neither equal to the step's assistant `messageId`
