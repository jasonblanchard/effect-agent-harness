# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Unanswered approvals are denied`
- TO: `### Requirement: Every open approval must be answered`

## MODIFIED Requirements

### Requirement: Every open approval must be answered
A run on a thread with pending approval requests SHALL carry a resume entry for each of them. If any pending request has no resume entry, the run SHALL end with `RUN_ERROR` code `UnansweredInterrupt` without committing anything it sent, calling the model or running a tool, so the thread is unchanged and the requests stay open. A missing answer SHALL NOT be treated as a denial: AG-UI 1.0 forbids a producer to read an omission as abandonment. A client gives up on a request by answering it `cancelled`. Resume entries that match no pending request SHALL be ignored.

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

### Requirement: Thread history from the server store
The agent SHALL keep the history of each `threadId` in the thread store and SHALL rebuild the model prompt on every run from the store, not from the client's full history. The prompt SHALL be: the agent's system prompt as resolved for this run, then the stored entries' messages in order, then the approval responses recorded for this run, then the ingested client delta, with every tool result placed directly after the assistant message holding its tool call. Every tool call sent to the model SHALL have a result: a stored tool call with no result and no approval request SHALL be sent with a failed result.

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

### Requirement: Projected prompt is stable across a resumed run
The projection of the thread taken at the start of a run SHALL be memoised under the thread id and run id, so a run executed again after an interruption uses the same projection even if the store changed in between. The projection SHALL NOT include the agent's system prompt, which the agent run memoises separately.

#### Scenario: Store compacted between attempts
- **WHEN** a run is re-executed with a ledger-backed checkpoint store after the thread was rewritten
- **THEN** the model prompt for the remaining steps is built from the original projection

### Requirement: Run-ended notification
The agent SHALL notify the thread store once when a run that claimed its thread ends, after its last commit, with the outcome kind: success, interrupted or failed. Failures anywhere in the run after the claim SHALL be notified, including failures before the model is called and a failing commit. A run that fails before claiming the thread (`RunInputMismatch`, `ThreadBusy`, a failing claim) SHALL NOT be notified. If the notification itself fails, a run that succeeded or was interrupted SHALL end with `RUN_ERROR` whose `code` is `ThreadError`, and a run that already failed SHALL keep its own error code.

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

## ADDED Requirements

### Requirement: Run info from the AG-UI input and the caller
The agent SHALL run each AG-UI run with run info taken from its input and from the caller: the input's `runId` and `threadId`, the input's `forwardedProps` as the run's properties, unchanged, and as its context the value the caller passed when starting the run, unchanged. Nothing in the AG-UI input SHALL become the run's context. An input without `forwardedProps` SHALL run with no properties, and a run started without a context SHALL run with no context.

#### Scenario: Forwarded properties reach the system prompt
- **WHEN** an agent's system prompt reads the properties of the current run and a run arrives with `forwardedProps: { locale: "fr" }`
- **THEN** the system prompt is computed with properties `{ locale: "fr" }` and with that input's run id and thread id

#### Scenario: No forwarded properties
- **WHEN** a run arrives without `forwardedProps`
- **THEN** the system prompt is computed with no properties

#### Scenario: Caller's context reaches tools
- **WHEN** a caller starts a run with the context `{ userId: "u1" }` and the model calls a tool that reads the current run
- **THEN** the handler sees the context `{ userId: "u1" }`

#### Scenario: The client cannot set the context
- **WHEN** a caller starts a run with the context `{ userId: "u1" }` and the input's `forwardedProps` is `{ context: { userId: "u2" }, userId: "u2" }`
- **THEN** the run's context is `{ userId: "u1" }`, and the client's values appear only in the run's properties

### Requirement: A run id names one input on its thread
Everything the runner stores for a run SHALL be scoped by the input's thread id as well as its run id, because the client chooses both and the caller authorises only the thread. Before loading or committing anything, the runner SHALL memoise the input under the thread id and run id. If a run is executed again on the same thread with the same run id and a different input, it SHALL end with `RUN_ERROR` code `RunInputMismatch` without committing anything, calling the model or running a tool.

#### Scenario: Run id reused on another thread
- **WHEN** run "r1" on thread "t1" calls `get-weather`, and then a run with run id "r1" and a different message is started on thread "t2" with the same ledger-backed checkpoint store
- **THEN** the second run calls the model with only thread "t2"'s history, the weather handler does not run again, and thread "t2" holds only its own user message and reply

#### Scenario: Run id reused on the same thread with a different input
- **WHEN** run "r1" on thread "t1" finished, and a run with run id "r1" on thread "t1" is started with an added user message
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `RunInputMismatch`, the model is not called, and the added message is not committed

#### Scenario: Same input executed again
- **WHEN** a run is interrupted and executed again on the same thread with the same input
- **THEN** it continues from its stored steps

### Requirement: One active run per thread
Every runner SHALL claim the input's thread after checking the input against its run id and before loading the thread, and SHALL release the claim after the run-ended notification and before emitting the terminal event, so a client's next run after `RUN_FINISHED` or `RUN_ERROR` finds the thread free. A run whose claim fails SHALL end with `RUN_ERROR` carrying the claim's error code (`ThreadBusy` when another run is active) without loading or committing anything. A request-scoped run that is cancelled before its terminal event SHALL release its claim. A detached or workflow run that is interrupted SHALL keep its claim, so the thread stays busy until the run is resumed and ends.

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

