## MODIFIED Requirements

### Requirement: A run id names one input on its thread
Everything the runner stores for a run SHALL be scoped by the input's thread id as well as its run id, because the client chooses both and the caller authorises only the thread. Before loading or committing anything, the runner SHALL memoise the input under the thread id and run id. The memoised input SHALL be the whole AG-UI input as decoded, including fields the run ignores, such as `context` and `state`. If a run is executed again on the same thread with the same run id and a different input, it SHALL end with `RUN_ERROR` code `RunInputMismatch` without committing anything, calling the model or running a tool. The run-context services SHALL NOT be part of the memoised input: re-executing a run with different ones SHALL NOT be detected, and the caller SHALL provide the ones the run was first started with.

#### Scenario: Run id reused on another thread
- **WHEN** run "r1" on thread "t1" calls `get-weather`, and then a run with run id "r1" and a different message is started on thread "t2" with the same ledger-backed checkpoint store
- **THEN** the second run calls the model with only thread "t2"'s history, the weather handler does not run again, and thread "t2" holds only its own user message and reply

#### Scenario: Run id reused on the same thread with a different input
- **WHEN** run "r1" on thread "t1" finished, and a run with run id "r1" on thread "t1" is started with an added user message
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `RunInputMismatch`, the model is not called, and the added message is not committed

#### Scenario: Same input executed again
- **WHEN** a run is interrupted and executed again on the same thread with the same input
- **THEN** it continues from its stored steps

#### Scenario: Same input with a different context
- **WHEN** a run is interrupted and executed again on the same thread with the same input and a different "app/Auth" service
- **THEN** it does not fail with `RunInputMismatch`, and its remaining steps run with the services built from the new one

#### Scenario: A field the run ignores differs
- **WHEN** run "r1" on thread "t1" is interrupted, and executed again with the same messages and a different `state`
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `RunInputMismatch`, and the model is not called
