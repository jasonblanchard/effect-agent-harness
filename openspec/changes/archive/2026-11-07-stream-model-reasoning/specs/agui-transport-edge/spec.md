## MODIFIED Requirements

### Requirement: Re-executing a detached run
Starting a detached run again with the same thread id and run id SHALL NOT re-append events for steps that are replayed from the checkpoint store. Before appending any new event it SHALL close every text message, reasoning message, reasoning span, tool call and step left open in the log by an earlier attempt, and it SHALL NOT append a second `RUN_STARTED` to a log that already has one. If the log already ends with a terminal event, starting again SHALL do nothing. The caller SHALL provide the same run-context services it provided the first time; the run does not store them. Starting again SHALL resolve the run's per-run services again from them.

#### Scenario: Resume after a crash mid-step
- **WHEN** an earlier attempt appended `TEXT_MESSAGE_START` and content for step 2 and stopped, and the run is started again with a ledger-backed checkpoint store
- **THEN** the log receives `TEXT_MESSAGE_END` for that message and `STEP_FINISHED` for step 2, no second `RUN_STARTED` and no repeated events for step 1, then step 2's events under a new message id, and the whole log passes the AG-UI client's checks

#### Scenario: Resume after a crash mid-reasoning
- **WHEN** an earlier attempt appended `REASONING_START`, `REASONING_MESSAGE_START` and content for step 2 and stopped, and the run is started again with a ledger-backed checkpoint store
- **THEN** the log receives `REASONING_MESSAGE_END` and `REASONING_END` for that block and `STEP_FINISHED` for step 2, then step 2's events under new message ids, and the whole log passes the AG-UI client's checks

#### Scenario: Already finished
- **WHEN** the log for the thread id and run id ends with `RUN_FINISHED`
- **THEN** starting again appends nothing, calls no model and does not build the per-run layer
