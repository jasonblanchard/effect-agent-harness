## MODIFIED Requirements

### Requirement: Run info from the AG-UI input and the caller
The agent SHALL run each AG-UI run with run info taken from its input: the input's `runId` and `threadId`, and the input's `forwardedProps` as the run's properties, unchanged. The trusted context the caller provides for the run SHALL reach the agent only as its declared run contexts' services and the services built from them. Nothing in the AG-UI input, including its `forwardedProps` and its own `context` field, SHALL become one of those services. An input without `forwardedProps` SHALL run with no properties.

#### Scenario: Forwarded properties reach the system prompt
- **WHEN** an agent's system prompt reads the properties of the current run and a run arrives with `forwardedProps: { locale: "fr" }`
- **THEN** the system prompt is computed with properties `{ locale: "fr" }` and with that input's run id and thread id

#### Scenario: No forwarded properties
- **WHEN** a run arrives without `forwardedProps`
- **THEN** the system prompt is computed with no properties

#### Scenario: Caller's context reaches tools
- **WHEN** a caller provides the "app/Auth" service `{ userId: "u1" }` to a run on a runner whose layer builds `CurrentUser` from "app/Auth", and the model calls a tool that requires `CurrentUser`
- **THEN** the handler sees the `CurrentUser` for `userId: "u1"`

#### Scenario: The client cannot set the context
- **WHEN** a caller provides the "app/Auth" service `{ userId: "u1" }` and the input's `forwardedProps` is `{ "app/Auth": { userId: "u2" }, userId: "u2" }`
- **THEN** the tool sees the `CurrentUser` for `userId: "u1"`, and the client's values appear only in the run's properties

### Requirement: A run id names one input on its thread
Everything the runner stores for a run SHALL be scoped by the input's thread id as well as its run id, because the client chooses both and the caller authorises only the thread. Before loading or committing anything, the runner SHALL memoise the input under the thread id and run id. If a run is executed again on the same thread with the same run id and a different input, it SHALL end with `RUN_ERROR` code `RunInputMismatch` without committing anything, calling the model or running a tool. The run-context services SHALL NOT be part of the memoised input: re-executing a run with different ones SHALL NOT be detected, and the caller SHALL provide the ones the run was first started with.

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
