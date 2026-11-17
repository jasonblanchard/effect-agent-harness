## MODIFIED Requirements

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
