## ADDED Requirements

### Requirement: Only the server history uses the store
A run SHALL load, commit to, claim, release and notify the thread store only when it uses the server history. The store SHALL be a requirement of the server history, not of every run.

#### Scenario: Client history
- **WHEN** a run uses the client history in a context that also holds a thread store
- **THEN** the store receives no call for that run

#### Scenario: Server history
- **WHEN** a run uses the server history
- **THEN** it claims the thread, loads it, commits its entries, notifies the store that it ended and releases the thread

## MODIFIED Requirements

### Requirement: The store is told when a run ends
After a run that claimed its thread finishes, is interrupted for approval, or fails, the store SHALL be notified once per terminal outcome with the thread id, run id and outcome kind, before the run's claim is released, so a caller can hook compaction or bookkeeping there. Only runs using the server history claim a thread. A run that never claimed the thread SHALL NOT be notified.

#### Scenario: Notification after success
- **WHEN** a run on thread "t1" finishes successfully
- **THEN** the store receives a run-ended notification for "t1" with that run id and the success outcome, after the run's last commit

#### Scenario: Notification after a failure before the model is called
- **WHEN** a run fails with `HistoryMismatch` before the model is called
- **THEN** the store receives one run-ended notification with the failed outcome and code `HistoryMismatch`

#### Scenario: Cancelled run
- **WHEN** a request-scoped run is cancelled because its consumer stopped
- **THEN** the store receives no run-ended notification for that run

#### Scenario: Run rejected before claiming
- **WHEN** a run fails with `ThreadBusy` or `RunInputMismatch`
- **THEN** the store receives no run-ended notification for that run

#### Scenario: Run with the client history
- **WHEN** a run that uses the client history finishes
- **THEN** the store receives no run-ended notification for that run

### Requirement: The store owns compaction
Under the server history, the projection of a thread into a model prompt SHALL be the agent's system prompt followed by the loaded entries' messages verbatim, in order. The library SHALL NOT summarise, drop or reorder entries; a caller compacts by rewriting what the store returns. The only exception: a tool result or approval response whose tool call is in the projection MAY be moved to directly after the assistant message holding that call, because providers require a call's result to follow it.

A run also reconciles the client's history, its `resume` entries and its answers to frontend calls against the loaded entries. A compacted thread SHALL therefore keep:
- the latest entries the client has seen, with their ids;
- every assistant entry holding an approval request that has no response yet;
- every assistant entry holding a frontend tool call that has no result yet, with its record that the call belongs to the client.

An entry the store writes in place of others SHALL be a system entry, or SHALL come before the latest entry the client has seen. A user, assistant or tool entry the client has never seen, placed after it, makes the client's next run fail with `HistoryDiverged`.

#### Scenario: Caller-compacted thread
- **WHEN** a store returns a single system entry holding a summary followed by the last user entry
- **THEN** the model receives the agent's system prompt, the summary system message and the user message, and nothing else from history

#### Scenario: Compaction drops every id the client knows
- **WHEN** a store returns only a summary entry whose id the client has never seen, and the client resends its history with a new user message
- **THEN** the run fails with `HistoryMismatch` and the model is not called

#### Scenario: Compaction drops a pending approval request
- **WHEN** a store returns a thread without the assistant entry holding an unanswered approval request, and the client sends a `resume` entry for that request
- **THEN** the `resume` entry is ignored and the tool is not executed

#### Scenario: Result stored after a later message
- **WHEN** a store returns an assistant tool call, then a user message, then the tool result for that call
- **THEN** the model receives the tool call, its result, then the user message

#### Scenario: Summary written as a later assistant entry
- **WHEN** a store returns the entries the client has seen followed by a summary written as an assistant entry the client has never seen, and the client resends its history with a new user message
- **THEN** the run fails with `HistoryDiverged` and the model is not called

#### Scenario: Pending frontend call dropped by compaction
- **WHEN** a store compacts away the assistant entry holding a pending frontend call, and the client then answers that call
- **THEN** the client's tool message is dropped, because no stored call is pending for it
