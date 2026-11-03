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
- **WHEN** a run uses the server history and loading the thread fails
- **THEN** the run emits `RUN_STARTED` followed by `RUN_ERROR` whose `code` is `ThreadError`

### Requirement: Thread history from the server store
Under the server history, the agent SHALL keep the history of each `threadId` in the thread store and SHALL rebuild the model prompt on every run from the store, not from the client's full history. The prompt SHALL be:
1. the agent's system prompt as resolved for this run;
2. the stored entries' messages, in order;
3. the approval responses recorded for this run;
4. the ingested client delta.

Every tool result SHALL be placed directly after the assistant message holding its tool call. Every tool call sent to the model SHALL have a result: a stored tool call with no result and no approval request SHALL be sent with a failed result.

#### Scenario: Follow-up question uses earlier context
- **WHEN** a second run on the same thread arrives after a first run that made a tool call
- **THEN** the model receives the first run's user message, assistant message with its tool call, tool result, and the new user message, in that order, all taken from the store

#### Scenario: Earlier run stopped before a tool result
- **WHEN** the store holds an assistant tool call with no tool result and no approval request for it
- **THEN** the model receives the tool call followed by a failed result for it, and the run proceeds

#### Scenario: Client system messages dropped by default
- **WHEN** the agent is not configured to allow client system messages and the client delta includes a `system` message
- **THEN** that message is neither committed nor sent to the model, and the agent's system prompt still is

#### Scenario: Unsupported message role
- **WHEN** the client delta includes an `activity` message
- **THEN** the run proceeds and the activity message is neither committed nor sent to the model

#### Scenario: Compacted store
- **WHEN** the store returns a summary system entry and the latest user entry
- **THEN** the model receives the agent's system prompt, the summary and the user message only

#### Scenario: System prompt is not stored
- **WHEN** a run on a new thread finishes
- **THEN** the thread's stored entries do not include the agent's system prompt

### Requirement: Client messages are ingested as a delta
Under the server history, a client message SHALL be known to the store when a stored entry has its id, or when it is a `tool` message and a stored tool result has its `toolCallId`. Every other client message SHALL be ignored for matching. The agent SHALL treat as new only the client messages after the last known client message; when the store is empty, every client message is new. From the delta it SHALL accept:
- `user` messages with text, as user entries keyed by the client's message id;
- `tool` messages that answer a pending frontend tool call (see "Tool messages answer pending frontend calls");
- `system`/`developer` messages, only when configured to allow them.

Every other message in the delta SHALL be dropped. The accepted entries SHALL be committed before the model is called.

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

### Requirement: History mismatch is rejected
Under the server history, when the store is not empty and no client message id matches a stored entry, the agent SHALL NOT call the model and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryMismatch`.

#### Scenario: Unrelated client history
- **WHEN** the store holds entries for the thread and the client's messages share no id with them
- **THEN** the run emits `RUN_STARTED` then `RUN_ERROR` with code `HistoryMismatch`, and the model is not called

### Requirement: Divergent history is rejected
Under the server history, when the client's history has a known message, the agent SHALL find the stored entry matched by the last known client message. It SHALL then check every stored entry after it that a read of the thread would show as a message: a user message, an assistant message with text or tool calls, or a tool result. Entries committed by the run itself SHALL NOT be checked, because a run executed again after a crash meets the steps its earlier attempt committed. If any checked entry is not matched by some client message, the agent SHALL NOT commit anything, SHALL NOT call the model, and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryDiverged`. The store SHALL be told the run ended, as for any failure after the claim.

#### Scenario: Edited earlier turn
- **WHEN** the store holds five messages m1 to m5 and the client sends m1 followed by a new user message m2' in place of m2
- **THEN** the run emits `RUN_STARTED` then `RUN_ERROR` with code `HistoryDiverged`, nothing is committed and the model is not called

#### Scenario: Regenerate
- **WHEN** the store ends with a user message and the assistant reply to it, and the client resends the history without that reply
- **THEN** the run ends with `RUN_ERROR` with code `HistoryDiverged`

#### Scenario: Server-only entries after the anchor
- **WHEN** the store ends with an assistant approval request followed by its approval response, and the client's history ends with that assistant message
- **THEN** the run is not rejected for divergence

#### Scenario: Compaction summary
- **WHEN** the store returns a summary system entry the client has never seen followed by the latest entries the client has seen, and the client resends its full history with a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Run executed again after a crash
- **WHEN** an attempt of run "r1" commits its first step and crashes, and "r1" is executed again with the same input
- **THEN** the run is not rejected for divergence, and completes without repeating the committed step

#### Scenario: Run-ended notification
- **WHEN** a run fails with `HistoryDiverged`
- **THEN** the store receives one run-ended notification with the failed outcome and code `HistoryDiverged`

### Requirement: Per-step commit
Under the server history, after each model step completes, the agent SHALL commit that step's assistant entry and tool entries to the store before continuing. A run that stops mid-step SHALL leave no partial entries for that step.

#### Scenario: Two-step run
- **WHEN** a run makes a tool call in step 1 and replies with text in step 2
- **THEN** the store receives two commits after the delta: step 1's assistant and tool entries, then step 2's assistant entry

#### Scenario: Failure during step 2
- **WHEN** the model fails during step 2
- **THEN** the store holds step 1's entries and nothing from step 2

### Requirement: Run-ended notification
Under the server history, the agent SHALL notify the thread store once when a run that claimed its thread ends, after its last commit, with the outcome kind: success, interrupted or failed.
- Failures anywhere in the run after the claim SHALL be notified, including failures before the model is called and a failing commit.
- A run that fails before claiming the thread (`RunInputMismatch`, `ThreadBusy`, a failing claim) SHALL NOT be notified.
- If the notification itself fails, a run that succeeded or was interrupted SHALL end with `RUN_ERROR` whose `code` is `ThreadError`, and a run that already failed SHALL keep its own error code.

#### Scenario: Interrupted run
- **WHEN** a run ends with an approval interrupt
- **THEN** the store is notified with the interrupted outcome after the step's entries were committed

#### Scenario: Commit fails mid-run
- **WHEN** committing step 1's entries fails
- **THEN** the run ends with `RUN_ERROR` whose `code` is `ThreadError`, and the store is notified once with the failed outcome and that code

#### Scenario: Notification fails after success
- **WHEN** a run finishes successfully and the run-ended notification fails
- **THEN** the run ends with `RUN_ERROR` whose `code` is `ThreadError` instead of `RUN_FINISHED`

#### Scenario: Claim fails
- **WHEN** claiming the thread fails with `ThreadError`
- **THEN** the run ends with `RUN_ERROR` whose `code` is `ThreadError` and the store is not notified

### Requirement: Tool approval interrupts the run
When the model calls a tool that requires approval, the agent SHALL NOT run it. Under the server history, it SHALL record an approval request on the assistant entry. Under either history, it SHALL end the run with `RUN_FINISHED` whose outcome is `interrupt`, listing one interrupt per pending approval with:
- `id` set to the approval id;
- `reason` `tool-approval`;
- `toolCallId` set to the tool call.

The approval id SHALL be determined by the tool call's id alone, so that a later run can match it to the call from the client's history. The tool call's `TOOL_CALL_START`/`ARGS`/`END` events SHALL still be streamed.

#### Scenario: Email needs approval
- **WHEN** the model calls "send-email", which requires approval
- **THEN** the run streams the tool call, emits no `TOOL_CALL_RESULT` for it, and ends with `RUN_FINISHED` whose outcome is `interrupt` with one interrupt whose `toolCallId` is the call's id

#### Scenario: Same call, same id
- **WHEN** two runs on different threads each interrupt for a "send-email" call with the same tool call id
- **THEN** both interrupts carry the same `id`, and interrupts for calls with different ids carry different `id`s

### Requirement: Resume entries answer approvals
A run input MAY carry `resume` entries. Under the server history, for each pending approval request whose approval id equals an entry's `interruptId`, the agent SHALL record an approval response. The response SHALL be approved only when `status` is `resolved` and `payload.approved` is `true`; otherwise it SHALL be denied with `payload.reason` or a default reason. Entries matching no pending request SHALL be ignored. Under the client history, resume entries SHALL be matched against the calls in the client's history instead (see the run-history capability).

#### Scenario: Resolved with approval
- **WHEN** the next run carries `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]` for the pending email approval
- **THEN** an approving response is recorded for that approval id

#### Scenario: Resolved without an explicit approval
- **WHEN** the next run carries `status: "resolved"` with no `payload.approved`
- **THEN** the call is denied

#### Scenario: Unknown interrupt id
- **WHEN** a resume entry names an interrupt id with no pending request
- **THEN** it is ignored and the run proceeds

### Requirement: Every open approval must be answered
Under the server history, a run on a thread with pending approval requests SHALL carry a resume entry for each of them. If any pending request has no resume entry, the run SHALL end with `RUN_ERROR` code `UnansweredInterrupt` without committing anything it sent, calling the model or running a tool, so the thread is unchanged and the requests stay open. A missing answer SHALL NOT be treated as a denial: AG-UI 1.0 forbids a producer to read an omission as abandonment. A client gives up on a request by answering it `cancelled`. Resume entries that match no pending request SHALL be ignored.

#### Scenario: Client ignores the interrupt
- **WHEN** a run follows an interrupted run with no `resume` entries
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `UnansweredInterrupt`, the email handler does not run, the model is not called and the thread is unchanged

#### Scenario: Interrupt ignored with a new user message
- **WHEN** a run follows an interrupted run with no `resume` entries and its delta holds a new user message
- **THEN** the run is rejected the same way and the new user message is not committed

#### Scenario: Answered after a rejected run
- **WHEN** that rejected run is followed by a run that approves the pending email approval
- **THEN** the email handler runs once and the run finishes with outcome `success`

#### Scenario: Cancelled with a new user message
- **WHEN** a run follows an interrupted run with `resume: [{ interruptId, status: "cancelled" }]` and its delta holds a new user message
- **THEN** the model receives the pending tool call, directly followed by its failed "cancelled" result, then the new user message

#### Scenario: Only some interrupts answered
- **WHEN** the previous run ended with two approval interrupts and the next run answers only one
- **THEN** the run is rejected with `UnansweredInterrupt` naming the other one, and neither answer is committed

### Requirement: One active run per thread
Under the server history, every runner SHALL claim the input's thread after checking the input against its run id and before loading the thread. It SHALL release the claim after the run-ended notification and before emitting the terminal event, so a client's next run after `RUN_FINISHED` or `RUN_ERROR` finds the thread free.
- A run whose claim fails SHALL end with `RUN_ERROR` carrying the claim's error code (`ThreadBusy` when another run is active), without loading or committing anything.
- A request-scoped run that is cancelled before its terminal event SHALL release its claim.
- A detached or workflow run that is interrupted SHALL keep its claim, so the thread stays busy until the run is resumed and ends.

#### Scenario: Second run while one is streaming
- **WHEN** run "r1" on thread "t1" is streaming and run "r2" is started on "t1"
- **THEN** "r2" ends with `RUN_STARTED` then `RUN_ERROR` with code `ThreadBusy`, commits nothing and is not reported to the store, and "r1" finishes normally

#### Scenario: Free when the client sees the end
- **WHEN** a client observes `RUN_FINISHED` for "r1"
- **THEN** another run can claim "t1" at that moment

#### Scenario: Cancelled request
- **WHEN** a request-scoped run is cancelled because its consumer stopped
- **THEN** its claim is released

#### Scenario: Crashed detached run
- **WHEN** a detached run's scope is closed mid-step and another run is started on its thread
- **THEN** the other run ends with `ThreadBusy`, and after the detached run is started again and finishes, the thread is free

#### Scenario: Different threads
- **WHEN** a run holds thread "t1"
- **THEN** a run on thread "t2" runs normally

### Requirement: Tool messages answer pending frontend calls
Under the server history, a `tool` message in the delta SHALL be committed as a call's result, keyed by the client's message id, when its `toolCallId` names a frontend call that is recorded on a stored assistant entry and has no stored result yet.
- When the message has `error` set, the result SHALL be failed and hold the error text.
- Otherwise, string content that parses as JSON SHALL be stored as the parsed value, any other string as itself, and a list of content parts as its `text` parts joined in order. Any other part SHALL be dropped without failing the run, and the call SHALL still be answered.
- When several tool messages answer the same call, the first one in the delta SHALL be used.
- A `tool` message that answers a server tool call, an already answered call or no stored call SHALL be dropped.

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
Under the server history, a run on a thread with pending frontend tool calls SHALL carry a tool message answering each of them. If any pending call has no answer, the run SHALL end with `RUN_ERROR` code `UnansweredToolCall` without committing anything it sent, calling the model or running a tool, so the thread is unchanged and the calls stay pending. A missing answer SHALL NOT be treated as a failed or declined call. When open approvals are also unanswered, the run SHALL end with code `UnansweredInterrupt` instead.

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
When a step left both approval requests and frontend calls pending, the next run SHALL resolve the approvals from its `resume` entries and the frontend calls from its tool messages. Once both are present, it SHALL execute the approved calls before the first model step, and call the model with a result for every call the step made. Under the server history, it SHALL require a `resume` entry for each approval and a tool message for each frontend call, and SHALL commit them.

#### Scenario: Server, frontend and approval calls in one step
- **WHEN** a step called `get-weather` (server), `pick-file` (frontend) and `send-email` (requires approval), and the next run carries a `resume` entry approving the email and a tool message answering `pick-file`
- **THEN** the email handler runs once before the model is called, and the model receives all three calls, each followed by its result

#### Scenario: Approval answered, frontend call not
- **WHEN** a run uses the server history, and the next run carries the `resume` entry but no tool message for `pick-file`
- **THEN** the run is rejected with `UnansweredToolCall`, and the email handler does not run
