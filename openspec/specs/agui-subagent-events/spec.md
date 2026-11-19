# agui-subagent-events Specification

## Purpose
Projects child agent runs onto the AG-UI event stream: the subagent lifecycle events, attribution of every child event to its subagent, independent span tracking per subagent, and attribution of child interrupts.

## Requirements
### Requirement: Subagent lifecycle events
For each child run, the agent SHALL emit `SUBAGENT_STARTED` before the child's first event, carrying the child's id as `subagentRunId`, the subagent's name as `name`, its description, the spawning call's id as `parentToolCallId`, the message id of the parent step holding that call as `parentMessageId`, and, for a child of a child, the enclosing child's id as `parentSubagentRunId`. It SHALL emit exactly one closing event for the child, before the spawning call's `TOOL_CALL_RESULT`:
- `SUBAGENT_FINISHED` with the child's result (left out when it is `null`) and outcome `success` when the child finished;
- `SUBAGENT_FINISHED` with outcome `suspended` when it waits for approval;
- `SUBAGENT_ERROR` with the error's message and code when it failed;
- `SUBAGENT_ERROR` with code `Cancelled` when it was cancelled with its parent, because AG-UI has no cancelled subagent outcome.

The child's own run lifecycle events SHALL NOT be emitted. Every sequence SHALL pass the AG-UI client's checks.

#### Scenario: Child finishes
- **WHEN** the parent calls `researcher` and the child replies "X is 42"
- **THEN** the stream holds `TOOL_CALL_END` for the call, `SUBAGENT_STARTED` with `name` "researcher" and `parentToolCallId` set to the call, the child's events, `SUBAGENT_FINISHED` with `result` "X is 42", then `TOOL_CALL_RESULT` for the call, and the sequence passes the AG-UI client's checks

#### Scenario: Child fails
- **WHEN** the child's model fails
- **THEN** the stream holds `SUBAGENT_ERROR` with the child's id and the error message, then a failed `TOOL_CALL_RESULT` for the call, and the run continues

#### Scenario: Child cancelled with its parent
- **WHEN** the run is cancelled while the child's model is streaming text
- **THEN** the stream closes the child's open text message under its attribution, then holds `SUBAGENT_ERROR` with the child's id and code `Cancelled`, a failed `TOOL_CALL_RESULT` naming "cancelled" for the call, `STEP_FINISHED` for the parent step, and `RUN_FINISHED` with outcome `cancelled`, and the sequence passes the AG-UI client's checks

#### Scenario: Nested child
- **WHEN** a child calls its own subagent
- **THEN** the grandchild's `SUBAGENT_STARTED` carries the child's id as `parentSubagentRunId`

#### Scenario: Replayed child
- **WHEN** a run is executed again and the child's work is replayed from checkpoints
- **THEN** no event of the replayed child is emitted again

### Requirement: Child events are attributed
Every text message, reasoning, tool call, tool result and step event a child produces SHALL carry the child's `subagentRunId`. Events the parent produces SHALL NOT carry one. A child's step events SHALL be named `step-<n>` with the child's own step numbers.

#### Scenario: Child text
- **WHEN** the child streams text and calls a tool
- **THEN** its `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `TOOL_CALL_RESULT` and `STEP_*` events each carry the child's `subagentRunId`, and the parent's events carry none

### Requirement: Concurrent children stream independently
When several children run at once, each child's text messages, reasoning and tool calls SHALL be opened and closed under its own attribution, and SHALL NOT close another child's or the parent's. Each child's open spans SHALL be closed before its closing event. When a resumed detached attempt completes an event log, the spans the earlier attempt left open SHALL be closed under their owners' attribution, and a child the earlier attempt started and did not close SHALL be continued without a second `SUBAGENT_STARTED` and closed once, with its result. Any tool call result, of the agent or of a child, that the earlier attempt checkpointed but did not publish (a step publishes its results only once all its calls finish) SHALL be emitted once when it is replayed, under its owner's attribution; this includes the spawning call of a child that finished in the earlier attempt.

#### Scenario: Two children interleave
- **WHEN** two children stream text at the same time
- **THEN** each text message starts and ends under its own child's id, and the sequence passes the AG-UI client's checks

#### Scenario: Detached run crashed mid-child
- **WHEN** a detached run's attempt crashes while a child is streaming, and the run is started again
- **THEN** the log holds the crashed attempt's open text closed under the child's id, one `SUBAGENT_STARTED` and one `SUBAGENT_FINISHED` for the child, and the whole log passes the AG-UI client's checks

#### Scenario: Detached run crashed after one of two children finished
- **WHEN** a detached run's parent calls two children in one step, the first finishes, and the attempt crashes while the second is streaming, and the run is started again
- **THEN** the log holds one `SUBAGENT_FINISHED` for each child, the first carrying its result, and one `TOOL_CALL_RESULT` for each spawning call

#### Scenario: Detached run crashed with a tool result held by its step
- **WHEN** a detached run's agent, or one of its children, calls `get-weather` and a subagent in one step, `get-weather` finishes, and the attempt crashes while the subagent is streaming, and the run is started again
- **THEN** the weather handler has run once, and the log holds one `TOOL_CALL_RESULT` for the `get-weather` call, under the attribution of the agent that made it

#### Scenario: Child stream ends mid-message
- **WHEN** a child's model stream stops after a text delta without ending the text
- **THEN** `TEXT_MESSAGE_END` for that message is emitted under the child's id before the child's closing event

### Requirement: Child interrupts are attributed
When the run finishes with the interrupt outcome, each interrupt for a child's approval SHALL carry the owning child's `subagentRunId`, with the same `id`, `reason` and `toolCallId` rules as the parent's approval interrupts. The suspended child's `SUBAGENT_FINISHED` SHALL list, as `interruptIds`, the ids of the interrupts it owns directly; a child suspended only because a descendant waits SHALL list none. A child re-entered in a later run SHALL emit `SUBAGENT_STARTED` again with the same `subagentRunId`.

#### Scenario: Suspended child
- **WHEN** the child calls `send-email`, which needs approval
- **THEN** the stream holds `SUBAGENT_FINISHED` with outcome `suspended` and that approval's id in `interruptIds`, then `RUN_FINISHED` with an interrupt carrying the child's `subagentRunId`, and no `TOOL_CALL_RESULT` for the spawning call

#### Scenario: Resumed child
- **WHEN** the next run approves that interrupt
- **THEN** it emits `SUBAGENT_STARTED` with the same `subagentRunId`, the email's `TOOL_CALL_RESULT` under that id, the child's reply, `SUBAGENT_FINISHED` with outcome `success`, then `TOOL_CALL_RESULT` for the spawning call

#### Scenario: Grandchild interrupt
- **WHEN** a grandchild waits for approval
- **THEN** the grandchild's `SUBAGENT_FINISHED` lists the interrupt, and the child's `SUBAGENT_FINISHED` has outcome `suspended` and no `interruptIds`
