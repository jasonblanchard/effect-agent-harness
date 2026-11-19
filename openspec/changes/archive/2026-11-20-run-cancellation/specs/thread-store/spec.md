## MODIFIED Requirements

### Requirement: The store is told when a run ends
After a run that claimed its thread finishes, is interrupted for approval, is cancelled, or fails, the store SHALL be notified once per terminal outcome with the thread id, run id and outcome kind, before the run's claim is released, so a caller can hook compaction or bookkeeping there. Only runs using the server history claim a thread. A run that never claimed the thread SHALL NOT be notified. A detached or workflow run that stops without a terminal outcome (a crash) SHALL NOT be notified until an attempt ends it.

#### Scenario: Notification after success
- **WHEN** a run on thread "t1" finishes successfully
- **THEN** the store receives a run-ended notification for "t1" with that run id and the success outcome, after the run's last commit

#### Scenario: Notification after a failure before the model is called
- **WHEN** a run fails with `HistoryMismatch` before the model is called
- **THEN** the store receives one run-ended notification with the failed outcome and code `HistoryMismatch`

#### Scenario: Cancelled run
- **WHEN** a request-scoped run is cancelled because its consumer stopped
- **THEN** the store receives one run-ended notification for that run with the cancelled outcome

#### Scenario: Crashed detached run
- **WHEN** a detached run's scope is closed mid-step
- **THEN** the store receives no run-ended notification until the run is started again and ends

#### Scenario: Run rejected before claiming
- **WHEN** a run fails with `ThreadBusy` or `RunInputMismatch`
- **THEN** the store receives no run-ended notification for that run

#### Scenario: Run with the client history
- **WHEN** a run that uses the client history finishes
- **THEN** the store receives no run-ended notification for that run
