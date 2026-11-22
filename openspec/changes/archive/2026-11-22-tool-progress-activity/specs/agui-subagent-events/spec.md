## MODIFIED Requirements

### Requirement: Child events are attributed
Every text message, reasoning, tool call, tool result, activity snapshot and step event a child produces SHALL carry the child's `subagentRunId`. Events the parent produces SHALL NOT carry one. A child's step events SHALL be named `step-<n>` with the child's own step numbers.

#### Scenario: Child text
- **WHEN** the child streams text and calls a tool
- **THEN** its `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `TOOL_CALL_RESULT` and `STEP_*` events each carry the child's `subagentRunId`, and the parent's events carry none

#### Scenario: Child tool progress
- **WHEN** a tool the child calls reports progress
- **THEN** the resulting `ACTIVITY_SNAPSHOT` events carry the child's `subagentRunId`
