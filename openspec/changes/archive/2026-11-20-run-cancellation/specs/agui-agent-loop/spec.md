## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: The client's copy of a cancelled turn is known
Under the server history, the assistant entry committed for a cancelled step SHALL carry the message id that step's AG-UI events used. A client that resends the partial message it was shown SHALL therefore have it matched as known, and not rejected as divergent.

#### Scenario: Next run after a stop
- **WHEN** run "r1" was cancelled after streaming "Hel", and the client sends its history including that partial assistant message, followed by a new user message
- **THEN** the partial message is matched as known, only the new user message is committed, and the model receives "Hel" as the earlier assistant turn
