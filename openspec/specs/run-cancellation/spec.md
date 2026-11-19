# run-cancellation Specification

## Purpose

Lets a caller stop a detached or workflow run on purpose, so that it ends as cancelled rather than being treated as crashed. Each runner delivers the request with the durability it already promises. A detached run is cancelled within the process that runs it. A workflow run is cancelled through its engine, which reaches the run on any host and across restarts.

## Requirements

### Requirement: Detached and workflow runners can cancel a run
The detached runner and the workflow-backed runner SHALL each provide a way to cancel a run given only its thread id and run id. Cancelling SHALL return without waiting for the run to end, and SHALL be idempotent. A run cancelled this way SHALL end as cancelled: its event log SHALL end with `RUN_FINISHED` whose outcome is `cancelled`, and subscribers SHALL receive that terminal event. Cancelling a run whose log already ends with a terminal event SHALL change nothing. A cancel for run "r1" on thread "t1" SHALL NOT affect run "r1" on thread "t2".

#### Scenario: Cancel while the model streams
- **WHEN** a detached run on ("t1", "r1") is streaming model text and the run is cancelled
- **THEN** the model stream is interrupted, and the log ends with `TEXT_MESSAGE_END` for the open message, `STEP_FINISHED`, then `RUN_FINISHED` with outcome `cancelled`, and passes the AG-UI client's checks

#### Scenario: Subscriber sees the end
- **WHEN** a client subscribed to a detached run's log and the run is cancelled
- **THEN** the subscription yields `RUN_FINISHED` with outcome `cancelled` and completes

#### Scenario: Cancel a finished run
- **WHEN** the log for ("t1", "r1") ends with `RUN_FINISHED` with outcome `success` and the run is cancelled
- **THEN** nothing is appended to the log

#### Scenario: Same run id on another thread
- **WHEN** detached runs ("t1", "r1") and ("t2", "r1") are streaming and ("t1", "r1") is cancelled
- **THEN** ("t1", "r1") ends cancelled and ("t2", "r1") finishes with outcome `success`

#### Scenario: Cancelling twice
- **WHEN** a streaming detached run is cancelled twice
- **THEN** both calls succeed and the log holds one terminal event

#### Scenario: Cancel a workflow run
- **WHEN** a run executed through the workflow runner with the in-memory engine is cancelled while a tool handler runs
- **THEN** the handler is interrupted, and the log ends with `RUN_FINISHED` with outcome `cancelled`

#### Scenario: Cancel a streaming workflow run
- **WHEN** a run executed through the workflow runner has streamed "Hel" and is cancelled
- **THEN** the log ends with `TEXT_MESSAGE_END`, `STEP_FINISHED` and `RUN_FINISHED` with outcome `cancelled`, and under the server history the thread holds the partial assistant text "Hel"

#### Scenario: Cancel a workflow run from another host
- **WHEN** a running workflow run is cancelled through another runner value with the same name on the same engine
- **THEN** the run ends as cancelled, keeping its partial turn, within the runner's cancel poll interval

### Requirement: A workflow run cancelled before it starts is honoured
When a run is cancelled through the workflow runner before it is started, the run SHALL still run up to its first live model step, and SHALL then end as cancelled without calling the model. Under the server history, it SHALL claim the thread and commit the client's new user message as usual, notify the store that the run was cancelled, and release the thread. Its event log SHALL hold `RUN_STARTED` then `RUN_FINISHED` with outcome `cancelled`.

#### Scenario: Workflow cancelled before start
- **WHEN** run ("t1", "r1") is cancelled through the workflow runner and then started
- **THEN** the model is not called, and the log holds `RUN_STARTED` then `RUN_FINISHED` with outcome `cancelled`

### Requirement: A resumed workflow run honours its cancel
When a workflow execution is resumed after its earlier attempt stopped without a terminal event, and the run was cancelled, the resumed attempt SHALL close what the earlier attempt left open, as any re-execution does. It SHALL replay the steps the earlier attempt completed, and SHALL end as cancelled before its next live step. It SHALL NOT call the model or run a tool handler again.

#### Scenario: Cancelled while suspended
- **WHEN** a workflow run is interrupted mid-step 2 without being cancelled, then cancelled, then resumed
- **THEN** the log receives the closers for step 2's open spans and `STEP_FINISHED`, then `RUN_FINISHED` with outcome `cancelled`; the model is not called again; and the whole log passes the AG-UI client's checks

### Requirement: A detached cancel lives in the runner's process
A detached run's cancel SHALL reach only runs started through the same runner, in the same process. The runner SHALL keep state only for runs it started that have not ended: a cancel for a run it never started SHALL do nothing and SHALL keep nothing, so the ids a caller passes cannot grow the runner's memory. A cancel for a run whose attempt was interrupted without a terminal event SHALL be kept, and SHALL be honoured when that run is next started through the runner. The runner SHALL drop a run's state when an attempt ends with a terminal event or fails.

#### Scenario: Cancel for a run the runner never started
- **WHEN** run ("t1", "r1") is cancelled through a detached runner that has not started it, and is then started through it
- **THEN** the run is not cancelled and finishes with outcome `success`

#### Scenario: Restarted by the same runner
- **WHEN** a detached run's attempt is interrupted mid-step, the run is then cancelled, and it is started again through the same runner
- **THEN** the new attempt closes the earlier attempt's open spans and ends with `RUN_FINISHED` with outcome `cancelled` without calling the model

#### Scenario: Another runner
- **WHEN** a run is cancelled through one detached runner and started through another
- **THEN** the run is not cancelled
