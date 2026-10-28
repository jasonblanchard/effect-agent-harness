## ADDED Requirements

### Requirement: Pending frontend calls are returned with their run
The read SHALL also return the ids of every frontend tool call in the thread that has no result yet, in the order the calls were made, together with the id of the run that committed them. When no frontend call is pending, the read SHALL return none. When the store did not record the committing run, the ids SHALL be returned without a run id. The calls themselves SHALL appear in the returned messages as tool calls of their assistant message, with no tool message after them.

#### Scenario: Run left a frontend call pending
- **WHEN** run "r1" ends with `RUN_FINISHED` whose `pendingToolCallIds` holds the `pick-file` call, and the thread is then read
- **THEN** the read returns that call id as pending, with run id "r1", and the assistant message holding the call with no tool message for it

#### Scenario: Answered call
- **WHEN** the next run answered the `pick-file` call, and the thread is then read
- **THEN** the read returns no pending calls, and the call's tool message follows its assistant message

#### Scenario: Restored pending call can be answered
- **WHEN** a client reads a thread with a pending frontend call, then starts a run with the read's messages and a tool message answering that call
- **THEN** the answer is committed, and the run does not fail with `UnansweredToolCall`, `HistoryMismatch` or `HistoryDiverged`
