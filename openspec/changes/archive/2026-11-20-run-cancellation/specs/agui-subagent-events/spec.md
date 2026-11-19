## MODIFIED Requirements

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
