# agui-agent-loop Specification

## Purpose

Runs a language-model agent with server-side tools for one AG-UI run. It turns the run input into an AG-UI event stream that a strict AG-UI client accepts, and it works the same way whichever model provider is configured.
## Requirements
### Requirement: Run lifecycle
The agent SHALL emit `RUN_STARTED` as the first event of every run and SHALL end every run with exactly one terminal event: `RUN_FINISHED` on success, interruption or cancellation, or `RUN_ERROR` on failure. It SHALL NOT emit any event after the terminal event. `RUN_STARTED` and `RUN_FINISHED` SHALL carry the `threadId` and `runId` from the run input. `RUN_STARTED` SHALL declare the AG-UI `protocolVersion`, and `RUN_FINISHED` SHALL carry the success outcome, the interrupt outcome or the cancelled outcome. A cancelled `RUN_FINISHED` SHALL carry no `result`, and every message, reasoning span, tool call, step and subagent the run opened SHALL be closed before it. `RUN_ERROR` SHALL carry a `code` naming the kind of failure when one is known.

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

### Requirement: Well-formed spans
Every `TEXT_MESSAGE_CONTENT` SHALL fall between a `TEXT_MESSAGE_START` and a `TEXT_MESSAGE_END` with the same `messageId`. Every `TOOL_CALL_ARGS` SHALL fall between a `TOOL_CALL_START` and a `TOOL_CALL_END` with the same `toolCallId`. Every `REASONING_MESSAGE_CONTENT` SHALL fall between a `REASONING_MESSAGE_START` and a `REASONING_MESSAGE_END` with the same `messageId`, inside a `REASONING_START` and `REASONING_END` with that `messageId`. No text message, reasoning message, reasoning span or tool call SHALL be left open when the terminal event is emitted, including when the model stream ends abruptly or the run fails.

#### Scenario: Model stream ends mid-message
- **WHEN** the model stream stops after a text delta without signalling the end of the text
- **THEN** the agent emits `TEXT_MESSAGE_END` for that message before the terminal event

#### Scenario: Failure during tool-call arguments
- **WHEN** the model fails while streaming a tool call's arguments
- **THEN** the agent emits `TOOL_CALL_END` for that tool call before `RUN_ERROR`

#### Scenario: Failure during reasoning
- **WHEN** the model fails after a reasoning delta, before the block ends
- **THEN** the agent emits `REASONING_MESSAGE_END` and `REASONING_END` for that block before `RUN_ERROR`

#### Scenario: Step ends with reasoning open
- **WHEN** a model step finishes after a reasoning delta without signalling the end of the block
- **THEN** the agent emits `REASONING_MESSAGE_END` and `REASONING_END` before `STEP_FINISHED`

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
The agent SHALL assign its own AG-UI message IDs and SHALL NOT reuse the model provider's text-part or reasoning-part IDs. Each model step SHALL get one new assistant `messageId`, shared by all of that step's text. Each reasoning block SHALL get its own `messageId`, different from the step's assistant `messageId`, and that id SHALL be the same every time the block is read. Each `TOOL_CALL_RESULT` SHALL get a new `messageId`. Message IDs SHALL be unique across steps and across runs.

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
- **THEN** the emitted `messageId`s are exactly the ones that generator produced, or derived only from them

### Requirement: Tool call identifiers pass through unchanged
The `toolCallId` on `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` and `TOOL_CALL_RESULT` SHALL be the tool call ID reported by the model layer, unchanged.

#### Scenario: Provider tool ID
- **WHEN** the model layer reports a tool call with ID "toolu_abc"
- **THEN** all events for that tool call carry `toolCallId` "toolu_abc"

### Requirement: Provider independence
The agent SHALL work with any configured language model and SHALL NOT depend on a specific model provider.

#### Scenario: Scripted model
- **WHEN** the agent runs against a scripted test model that emits text and tool-call parts
- **THEN** it produces the same kind of well-formed AG-UI event stream as with a real provider

### Requirement: Thread history from the server store
Under the server history, the agent SHALL keep the history of each `threadId` in the thread store and SHALL rebuild the model prompt on every run from the store, not from the client's full history. The prompt SHALL be:
1. the agent's system prompt as resolved for this run;
2. the stored entries' messages, in order, leaving out entries owned by a subagent;
3. the approval responses recorded for this run that answer the agent's own requests;
4. the ingested client delta.

Every tool result SHALL be placed directly after the assistant message holding its tool call. Every tool call sent to the model SHALL have a result: a stored tool call with no result, no approval request and no record of a suspended subagent call SHALL be sent with a failed result.

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

#### Scenario: Child entries are not in the parent prompt
- **WHEN** a thread holds a `researcher` call, the child's entries and the call's result, and a new user message arrives
- **THEN** the model receives the call, its result and the new user message, and none of the child's messages

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
Under the server history, when the client's history has a known message, the agent SHALL find the stored entry matched by the last known client message. It SHALL then check every stored entry after it that holds a user message, an assistant message with text or tool calls, or a tool result. An assistant entry holding only reasoning SHALL NOT be checked, and reasoning messages SHALL NOT count as known or as missing. Entries owned by a subagent SHALL NOT be checked. Entries committed by the run itself SHALL NOT be checked, because a run executed again after a crash meets the steps its earlier attempt committed. If any checked entry is not matched by some client message, the agent SHALL NOT commit anything, SHALL NOT call the model, and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryDiverged`. The store SHALL be told the run ended, as for any failure after the claim.

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

#### Scenario: Client dropped reasoning
- **WHEN** the store holds an assistant entry with reasoning and text, and the client resends that assistant message without its reasoning rows, plus a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Entry holding only reasoning
- **WHEN** the store ends with an assistant entry holding only reasoning, and the client's history ends before it
- **THEN** the run is not rejected for divergence

#### Scenario: Client dropped child messages
- **WHEN** the store holds a `researcher` call, the child's entries and the call's result, and the client resends the call and its result without the child's messages, plus a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Client kept child messages
- **WHEN** the client resends the child's messages, tagged with their `subagentRunId`, as well
- **THEN** the run is not rejected, and only the new user message is committed

### Requirement: Per-step commit
Under the server history, after each model step completes, the agent SHALL commit that step's assistant entry and tool entries to the store before continuing. A run that stops mid-step SHALL leave no partial entries for that step.

#### Scenario: Two-step run
- **WHEN** a run makes a tool call in step 1 and replies with text in step 2
- **THEN** the store receives two commits after the delta: step 1's assistant and tool entries, then step 2's assistant entry

#### Scenario: Failure during step 2
- **WHEN** the model fails during step 2
- **THEN** the store holds step 1's entries and nothing from step 2

### Requirement: Run-ended notification
Under the server history, the agent SHALL notify the thread store once when a run that claimed its thread ends, after its last commit, with the outcome kind: success, interrupted, cancelled or failed.
- Failures anywhere in the run after the claim SHALL be notified, including failures before the model is called and a failing commit.
- A run that fails before claiming the thread (`RunInputMismatch`, `ThreadBusy`, a failing claim) SHALL NOT be notified.
- A cancelled run SHALL commit its cancelled step's entries before it is notified.
- If the notification itself fails, a run that succeeded, was interrupted or was cancelled SHALL end with `RUN_ERROR` whose `code` is `ThreadError`, and a run that already failed SHALL keep its own error code.

#### Scenario: Interrupted run
- **WHEN** a run ends with an approval interrupt
- **THEN** the store is notified with the interrupted outcome after the step's entries were committed

#### Scenario: Cancelled run
- **WHEN** a run is cancelled after the model streamed "Hel" in step 1
- **THEN** an assistant entry "Hel" under step 1's message id is committed, then the store is notified with the cancelled outcome

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
When the model calls a tool that requires approval, the agent SHALL NOT run it. Under the server history, it SHALL record an approval request on the assistant entry. Under either history, it SHALL end the run with `RUN_FINISHED` whose outcome is `interrupt`, listing one interrupt per pending approval, including the approvals of suspended subagents, with:
- `id` set to the approval id;
- `reason` `tool-approval`;
- `toolCallId` set to the tool call;
- `subagentRunId` set to the owning subagent, for an approval a subagent requested.

The approval id SHALL be determined by the tool call's id alone, so that a later run can match it to the call from the client's history. The tool call's `TOOL_CALL_START`/`ARGS`/`END` events SHALL still be streamed.

#### Scenario: Email needs approval
- **WHEN** the model calls "send-email", which requires approval
- **THEN** the run streams the tool call, emits no `TOOL_CALL_RESULT` for it, and ends with `RUN_FINISHED` whose outcome is `interrupt` with one interrupt whose `toolCallId` is the call's id

#### Scenario: Same call, same id
- **WHEN** two runs on different threads each interrupt for a "send-email" call with the same tool call id
- **THEN** both interrupts carry the same `id`, and interrupts for calls with different ids carry different `id`s

#### Scenario: Child needs approval
- **WHEN** a child of the agent calls "send-email"
- **THEN** the run ends with `RUN_FINISHED` whose outcome is `interrupt` with one interrupt for that call carrying the child's `subagentRunId`

### Requirement: Resume entries answer approvals
A run input MAY carry `resume` entries. Under the server history, for each pending approval request whose approval id equals an entry's `interruptId`, the agent SHALL record an approval response, owned by the same subagent as the request when a subagent requested it. The response SHALL be approved only when `status` is `resolved` and `payload.approved` is `true`; otherwise it SHALL be denied with `payload.reason` or a default reason. Entries matching no pending request SHALL be ignored. Under the client history, resume entries SHALL be matched against the calls in the client's history instead (see the run-history capability).

#### Scenario: Resolved with approval
- **WHEN** the next run carries `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]` for the pending email approval
- **THEN** an approving response is recorded for that approval id

#### Scenario: Resolved without an explicit approval
- **WHEN** the next run carries `status: "resolved"` with no `payload.approved`
- **THEN** the call is denied

#### Scenario: Unknown interrupt id
- **WHEN** a resume entry names an interrupt id with no pending request
- **THEN** it is ignored and the run proceeds

#### Scenario: Child's approval answered
- **WHEN** the next run approves the interrupt a child raised
- **THEN** the approving response is recorded as owned by the child, and the parent's model does not receive it

### Requirement: Approval decisions execute before the first model step
Approved calls SHALL execute before the first model step of the run and emit `TOOL_CALL_RESULT`; denied calls SHALL emit a failed `TOOL_CALL_RESULT` naming the reason. The model SHALL then be called with those results in the prompt.

#### Scenario: Approved
- **WHEN** the next run carries an approving resume entry for the pending email approval
- **THEN** the email handler runs once, `TOOL_CALL_RESULT` for the email call is emitted before any text, and the model is called with the result

#### Scenario: Cancelled
- **WHEN** the next run carries `resume: [{ interruptId, status: "cancelled" }]`
- **THEN** the email handler does not run and a failed `TOOL_CALL_RESULT` with content naming "cancelled" is emitted

### Requirement: Step events
The agent SHALL emit `STEP_STARTED` before the first content event of each model step and `STEP_FINISHED` after its last, with `stepName` `step-<n>` where `<n>` is the 1-based step number. Results of approvals resolved before the first model step SHALL be emitted without step events.

#### Scenario: Two steps
- **WHEN** a run makes a tool call in step 1 and replies in step 2
- **THEN** the events contain `STEP_STARTED step-1` … `STEP_FINISHED step-1`, then `STEP_STARTED step-2` … `STEP_FINISHED step-2`, and the sequence passes the AG-UI client's checks

### Requirement: Projected prompt is stable across a resumed run
The projection of the thread taken at the start of a run SHALL be memoised under the thread id and run id, so a run executed again after an interruption uses the same projection even if the store changed in between. The projection SHALL NOT include the agent's system prompt, which the agent run memoises separately.

#### Scenario: Store compacted between attempts
- **WHEN** a run is re-executed with a ledger-backed checkpoint store after the thread was rewritten
- **THEN** the model prompt for the remaining steps is built from the original projection

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

### Requirement: Run info from the AG-UI input and the caller
The agent SHALL run each AG-UI run with run info taken from its input: the input's `runId` and `threadId`, and the input's `forwardedProps` as the run's properties, unchanged. The trusted context the caller provides for the run SHALL reach the agent only as its declared run contexts' services and the services built from them. Nothing in the AG-UI input, including its `forwardedProps` and its own `context` field, SHALL become one of those services. An input without `forwardedProps` SHALL run with no properties.

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
- **WHEN** a caller provides the "app/Auth" service `{ userId: "u1" }` and the input's `forwardedProps` is `{ "app/Auth": { userId: "u2" }, userId: "u2" }`
- **THEN** the tool sees the `CurrentUser` for `userId: "u1"`, and the client's values appear only in the run's properties

### Requirement: A run id names one input on its thread
Everything the runner stores for a run SHALL be scoped by the input's thread id as well as its run id, because the client chooses both and the caller authorises only the thread. Before loading or committing anything, the runner SHALL memoise the input under the thread id and run id. If a run is executed again on the same thread with the same run id and a different input, it SHALL end with `RUN_ERROR` code `RunInputMismatch` without committing anything, calling the model or running a tool. The run-context services SHALL NOT be part of the memoised input: re-executing a run with different ones SHALL NOT be detected, and the caller SHALL provide the ones the run was first started with.

#### Scenario: Run id reused on another thread
- **WHEN** run "r1" on thread "t1" calls `get-weather`, and then a run with run id "r1" and a different message is started on thread "t2" with the same ledger-backed checkpoint store
- **THEN** the second run calls the model with only thread "t2"'s history, the weather handler does not run again, and thread "t2" holds only its own user message and reply

#### Scenario: Run id reused on the same thread with a different input
- **WHEN** run "r1" on thread "t1" finished, and a run with run id "r1" on thread "t1" is started with an added user message
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `RunInputMismatch`, the model is not called, and the added message is not committed

#### Scenario: Same input executed again
- **WHEN** a run is interrupted and executed again on the same thread with the same input
- **THEN** it continues from its stored steps

#### Scenario: Same input with a different context
- **WHEN** a run is interrupted and executed again on the same thread with the same input and a different "app/Auth" service
- **THEN** it does not fail with `RunInputMismatch`, and its remaining steps run with the services built from the new one

### Requirement: One active run per thread
Under the server history, every runner SHALL claim the input's thread after checking the input against its run id and before loading the thread. It SHALL release the claim after the run-ended notification and before emitting the terminal event, so a client's next run after `RUN_FINISHED` or `RUN_ERROR` finds the thread free.
- A run whose claim fails SHALL end with `RUN_ERROR` carrying the claim's error code (`ThreadBusy` when another run is active), without loading or committing anything.
- A cancelled run, on any runner, SHALL release its claim after its run-ended notification. The next run on the thread SHALL be an ordinary new run.
- A detached or workflow run that is interrupted without being cancelled SHALL keep its claim, so the thread stays busy until the run is resumed and ends.

#### Scenario: Second run while one is streaming
- **WHEN** run "r1" on thread "t1" is streaming and run "r2" is started on "t1"
- **THEN** "r2" ends with `RUN_STARTED` then `RUN_ERROR` with code `ThreadBusy`, commits nothing and is not reported to the store, and "r1" finishes normally

#### Scenario: Free when the client sees the end
- **WHEN** a client observes `RUN_FINISHED` for "r1"
- **THEN** another run can claim "t1" at that moment

#### Scenario: Cancelled request
- **WHEN** a request-scoped run is cancelled because its consumer stopped
- **THEN** its claim is released

#### Scenario: Cancelled detached run
- **WHEN** a detached run on "t1" is cancelled and its log has ended with the cancelled `RUN_FINISHED`
- **THEN** another run can claim "t1"

#### Scenario: Crashed detached run
- **WHEN** a detached run's scope is closed mid-step and another run is started on its thread
- **THEN** the other run ends with `ThreadBusy`, and after the detached run is started again and finishes, the thread is free

#### Scenario: Different threads
- **WHEN** a run holds thread "t1"
- **THEN** a run on thread "t2" runs normally

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

### Requirement: Streamed model reasoning
The agent SHALL stream each reasoning block a model step produces as it is produced: `REASONING_START`, `REASONING_MESSAGE_START` with role `reasoning`, one `REASONING_MESSAGE_CONTENT` per non-empty delta in the order produced, `REASONING_MESSAGE_END` and `REASONING_END`, all with the block's `messageId`. A block the model delivers whole SHALL be emitted the same way, with one content event. A block with no text SHALL emit no events. Provider metadata on a reasoning block, such as a signature, SHALL NOT appear in any event. Replayed steps SHALL emit no reasoning events.

#### Scenario: Reasoning before a reply
- **WHEN** the model produces a reasoning block with the deltas "Let", " me think", then the text "Hi"
- **THEN** the step emits `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT` "Let", `REASONING_MESSAGE_CONTENT` " me think", `REASONING_MESSAGE_END`, `REASONING_END`, then the text message, and the sequence passes the AG-UI client's checks

#### Scenario: Block delivered whole
- **WHEN** the model produces one complete reasoning part "Done thinking"
- **THEN** the step emits the five reasoning events with one `REASONING_MESSAGE_CONTENT` "Done thinking"

#### Scenario: Redacted block
- **WHEN** the model produces a reasoning block with no text and a provider signature in its metadata
- **THEN** the step emits no reasoning events for it, and the block is still stored and sent back to the model on the next step

#### Scenario: Replayed step
- **WHEN** a run is executed again and a step with reasoning is replayed from its checkpoint
- **THEN** no reasoning events are emitted for that step

### Requirement: Reasoning is controlled by the model layer
The agent SHALL have no option of its own that enables or disables reasoning. Whether reasoning appears SHALL depend only on whether the configured model produces it. A model that produces no reasoning SHALL yield no reasoning events.

#### Scenario: Model without reasoning
- **WHEN** a run's model produces only text and tool calls
- **THEN** the run's events contain no `REASONING_*` event

### Requirement: The client's copy of a cancelled turn is known
Under the server history, the assistant entry committed for a cancelled step SHALL carry the message id that step's AG-UI events used. A client that resends the partial message it was shown SHALL therefore have it matched as known, and not rejected as divergent.

#### Scenario: Next run after a stop
- **WHEN** run "r1" was cancelled after streaming "Hel", and the client sends its history including that partial assistant message, followed by a new user message
- **THEN** the partial message is matched as known, only the new user message is committed, and the model receives "Hel" as the earlier assistant turn
