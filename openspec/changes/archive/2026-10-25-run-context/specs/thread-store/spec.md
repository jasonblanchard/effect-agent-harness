## MODIFIED Requirements

### Requirement: The store is told when a run ends
After a run that claimed its thread finishes, is interrupted for approval, or fails, the store SHALL be notified once per terminal outcome with the thread id, run id and outcome kind, before the run's claim is released, so a caller can hook compaction or bookkeeping there. A run that never claimed the thread SHALL NOT be notified.

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

## ADDED Requirements

### Requirement: A thread has at most one active run
The store SHALL let a run claim a thread and release its claim. Claiming SHALL succeed when the thread has no active run or when the claiming run already is the active run, and SHALL fail with `ThreadBusy`, naming the active run, when another run is active. Releasing SHALL end the claim only if the releasing run is the active run. A store shared by several processes SHALL make claiming atomic.

#### Scenario: Second run on a busy thread
- **WHEN** run "r1" has claimed thread "t1" and run "r2" claims "t1"
- **THEN** the claim fails with `ThreadBusy` naming "r1"

#### Scenario: A resumed run claims again
- **WHEN** run "r1" has claimed thread "t1" and claims it again
- **THEN** the claim succeeds

#### Scenario: Only the active run releases
- **WHEN** run "r2" releases thread "t1" while "r1" holds it, and then "r1" releases it
- **THEN** "t1" stays claimed by "r1" after the first release and is free after the second

#### Scenario: Threads are independent
- **WHEN** run "r1" holds thread "t1"
- **THEN** a run can claim thread "t2"
