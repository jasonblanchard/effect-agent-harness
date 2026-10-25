# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Conversation history from the client`
- TO: `### Requirement: Thread history from the server store`

## MODIFIED Requirements

### Requirement: Run lifecycle
The agent SHALL emit `RUN_STARTED` as the first event of every run and SHALL end every run with exactly one terminal event: `RUN_FINISHED` on success or interruption, or `RUN_ERROR` on failure. It SHALL NOT emit any event after the terminal event. `RUN_STARTED` and `RUN_FINISHED` SHALL carry the `threadId` and `runId` from the run input. `RUN_STARTED` SHALL declare the AG-UI `protocolVersion`, and `RUN_FINISHED` SHALL carry the success outcome or the interrupt outcome. `RUN_ERROR` SHALL carry a `code` naming the kind of failure when one is known.

#### Scenario: Successful run
- **WHEN** a run is started with `threadId` "t1" and `runId` "r1" and the model replies with text only
- **THEN** the first event is `RUN_STARTED` with `threadId` "t1" and `runId` "r1"
- **AND** the last event is `RUN_FINISHED` with `threadId` "t1" and `runId` "r1" and outcome type `success`

#### Scenario: Model failure
- **WHEN** the model request fails partway through a run
- **THEN** the run ends with a single `RUN_ERROR` event carrying a message
- **AND** no events follow it

#### Scenario: Failure before the model is called
- **WHEN** loading the thread fails
- **THEN** the run emits `RUN_STARTED` followed by `RUN_ERROR` whose `code` is `ThreadError`

### Requirement: Server-side tool execution and multi-step loop
The agent SHALL run each tool call the model makes against its configured tools, outside the model call and at most once per run and tool call id, and emit a `TOOL_CALL_RESULT` with the result serialized as JSON in `content`. If the model's step ends by requesting tool calls and none of them requires approval, the agent SHALL send the tool results back to the model and continue with a new step. Otherwise it SHALL finish the run.

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

### Requirement: Thread history from the server store
The agent SHALL keep the history of each `threadId` in the thread store and SHALL rebuild the model prompt on every run from the store, not from the client's full history. The prompt SHALL be: the configured system prompt, then the stored entries' messages in order, then the approval responses recorded for this run, then the ingested client delta, with every tool result placed directly after the assistant message holding its tool call. Every tool call sent to the model SHALL have a result: a stored tool call with no result and no approval request SHALL be sent with a failed result.

#### Scenario: Follow-up question uses earlier context
- **WHEN** a second run on the same thread arrives after a first run that made a tool call
- **THEN** the model receives the first run's user message, assistant message with its tool call, tool result, and the new user message, in that order, all taken from the store

#### Scenario: Earlier run stopped before a tool result
- **WHEN** the store holds an assistant tool call with no tool result and no approval request for it
- **THEN** the model receives the tool call followed by a failed result for it, and the run proceeds

#### Scenario: Client system messages dropped by default
- **WHEN** the agent is not configured to allow client system messages and the client delta includes a `system` message
- **THEN** that message is neither committed nor sent to the model, and the configured system prompt still is

#### Scenario: Unsupported message role
- **WHEN** the client delta includes an `activity` message
- **THEN** the run proceeds and the activity message is neither committed nor sent to the model

#### Scenario: Compacted store
- **WHEN** the store returns a summary system entry and the latest user entry
- **THEN** the model receives the configured system prompt, the summary and the user message only

## ADDED Requirements

### Requirement: Client messages are ingested as a delta
The agent SHALL treat as new only the client messages after the last client message whose id matches a stored entry; when the store is empty, every client message is new. From the delta it SHALL accept `user` messages with text (as user entries keyed by the client's message id) and, only when configured to allow them, `system`/`developer` messages; every other role in the delta SHALL be dropped. The accepted entries SHALL be committed before the model is called.

#### Scenario: Full history resent by the client
- **WHEN** the client sends the stored history plus one new user message
- **THEN** only the new user message is committed and appended to the prompt

#### Scenario: Client sends assistant turns
- **WHEN** the delta contains an assistant message
- **THEN** it is neither committed nor sent to the model

#### Scenario: First run on a thread
- **WHEN** the store is empty and the client sends one user message
- **THEN** that message is committed and the model receives it after the system prompt

### Requirement: History mismatch is rejected
When the store is not empty and no client message id matches a stored entry, the agent SHALL NOT call the model and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryMismatch`.

#### Scenario: Unrelated client history
- **WHEN** the store holds entries for the thread and the client's messages share no id with them
- **THEN** the run emits `RUN_STARTED` then `RUN_ERROR` with code `HistoryMismatch`, and the model is not called

### Requirement: Per-step commit
After each model step completes, the agent SHALL commit that step's assistant entry and tool entries to the store before continuing. A run that stops mid-step SHALL leave no partial entries for that step.

#### Scenario: Two-step run
- **WHEN** a run makes a tool call in step 1 and replies with text in step 2
- **THEN** the store receives two commits after the delta: step 1's assistant and tool entries, then step 2's assistant entry

#### Scenario: Failure during step 2
- **WHEN** the model fails during step 2
- **THEN** the store holds step 1's entries and nothing from step 2

### Requirement: Run-ended notification
The agent SHALL notify the thread store once when a run ends, after its last commit, with the outcome kind: success, interrupted or failed. Failures anywhere in the run SHALL be notified, including failures before the model is called and a failing commit. If the notification itself fails, a run that succeeded or was interrupted SHALL end with `RUN_ERROR` whose `code` is `ThreadError`, and a run that already failed SHALL keep its own error code.

#### Scenario: Interrupted run
- **WHEN** a run ends with an approval interrupt
- **THEN** the store is notified with the interrupted outcome after the step's entries were committed

#### Scenario: Commit fails mid-run
- **WHEN** committing step 1's entries fails
- **THEN** the run ends with `RUN_ERROR` whose `code` is `ThreadError`, and the store is notified once with the failed outcome and that code

#### Scenario: Notification fails after success
- **WHEN** a run finishes successfully and the run-ended notification fails
- **THEN** the run ends with `RUN_ERROR` whose `code` is `ThreadError` instead of `RUN_FINISHED`

### Requirement: Tool approval interrupts the run
When the model calls a tool that requires approval, the agent SHALL NOT run it. It SHALL record an approval request on the assistant entry and end the run with `RUN_FINISHED` whose outcome is `interrupt`, listing one interrupt per pending approval with `id` set to the approval id, `reason` `tool-approval` and `toolCallId` set to the tool call. The tool call's `TOOL_CALL_START`/`ARGS`/`END` events SHALL still be streamed.

#### Scenario: Email needs approval
- **WHEN** the model calls "send-email", which requires approval
- **THEN** the run streams the tool call, emits no `TOOL_CALL_RESULT` for it, and ends with `RUN_FINISHED` whose outcome is `interrupt` with one interrupt whose `toolCallId` is the call's id

### Requirement: Resume entries answer approvals
A run input MAY carry `resume` entries. For each pending approval request whose approval id equals an entry's `interruptId`, the agent SHALL record an approval response: approved only when `status` is `resolved` and `payload.approved` is `true`, otherwise denied with `payload.reason` or a default reason. Entries matching no pending request SHALL be ignored.

#### Scenario: Resolved with approval
- **WHEN** the next run carries `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]` for the pending email approval
- **THEN** an approving response is recorded for that approval id

#### Scenario: Resolved without an explicit approval
- **WHEN** the next run carries `status: "resolved"` with no `payload.approved`
- **THEN** the call is denied

#### Scenario: Unknown interrupt id
- **WHEN** a resume entry names an interrupt id with no pending request
- **THEN** it is ignored and the run proceeds

### Requirement: Approval decisions execute before the first model step
Approved calls SHALL execute before the first model step of the run and emit `TOOL_CALL_RESULT`; denied calls SHALL emit a failed `TOOL_CALL_RESULT` naming the reason. The model SHALL then be called with those results in the prompt.

#### Scenario: Approved
- **WHEN** the next run carries an approving resume entry for the pending email approval
- **THEN** the email handler runs once, `TOOL_CALL_RESULT` for the email call is emitted before any text, and the model is called with the result

#### Scenario: Cancelled
- **WHEN** the next run carries `resume: [{ interruptId, status: "cancelled" }]`
- **THEN** the email handler does not run and a failed `TOOL_CALL_RESULT` with content naming "cancelled" is emitted

### Requirement: Unanswered approvals are denied
A pending approval request that the next run on the thread does not answer SHALL be denied with the reason "not answered", so the thread can continue.

#### Scenario: Client ignores the interrupt
- **WHEN** a run follows an interrupted run with no `resume` entries
- **THEN** the pending call receives a failed result with reason "not answered" and the run proceeds

#### Scenario: Interrupt ignored with a new user message
- **WHEN** a run follows an interrupted run with no `resume` entries and its delta holds a new user message
- **THEN** the model receives the pending tool call, directly followed by its failed "not answered" result, then the new user message

### Requirement: Step events
The agent SHALL emit `STEP_STARTED` before the first content event of each model step and `STEP_FINISHED` after its last, with `stepName` `step-<n>` where `<n>` is the 1-based step number. Results of approvals resolved before the first model step SHALL be emitted without step events.

#### Scenario: Two steps
- **WHEN** a run makes a tool call in step 1 and replies in step 2
- **THEN** the events contain `STEP_STARTED step-1` … `STEP_FINISHED step-1`, then `STEP_STARTED step-2` … `STEP_FINISHED step-2`, and the sequence passes the AG-UI client's checks

### Requirement: Projected prompt is stable across a resumed run
The prompt projected at the start of a run SHALL be memoised under the run id, so a run executed again after an interruption uses the same prompt even if the store changed in between.

#### Scenario: Store compacted between attempts
- **WHEN** a run is re-executed with a ledger-backed checkpoint store after the thread was rewritten
- **THEN** the model prompt for the remaining steps is built from the original projection
