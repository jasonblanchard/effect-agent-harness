# Spec Delta

## MODIFIED Requirements

### Requirement: Lenient run input decoding
The package SHALL provide a decoder for AG-UI `RunAgentInput` that checks only the fields the agent uses: `threadId`, `runId`, the `messages` fields needed for ingestion, and `resume` entries (`interruptId`, `status`, optional `payload`). It SHALL keep an optional `forwardedProps` value of any shape without checking it. It SHALL accept and ignore any other fields, and it SHALL fail on input whose required fields are missing or malformed, so the caller can reject it before starting a run.

#### Scenario: Extra fields
- **WHEN** the input includes `tools`, `context`, `state`, `forwardedProps` and `protocolVersion`
- **THEN** decoding succeeds and returns only the fields the agent reads, including `forwardedProps`

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails

#### Scenario: Resume entries
- **WHEN** the input includes `resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }]`
- **THEN** decoding succeeds and the entry is available to the run

#### Scenario: Forwarded properties of any shape
- **WHEN** the input's `forwardedProps` is a string, an array or a nested object
- **THEN** decoding succeeds and returns `forwardedProps` unchanged

### Requirement: Runner without service requirements
The package SHALL provide a way to capture the agent's services (language model, tool handlers, thread store, checkpoint store, and any services the agent's system prompt declares) once and obtain a request-scoped runner. The runner SHALL accept, for each run, the run's input and an optional context. Each run's event stream SHALL then have no outstanding service requirements, so it can be consumed after the code that created it has returned, for example as a response body. The stream SHALL NOT fail: failures are reported in-band as `RUN_ERROR`.

#### Scenario: Stream used as a response body
- **WHEN** a caller captures the runner while its route is being set up and calls it for each request
- **THEN** each returned event stream can be consumed without providing any further services

#### Scenario: Context per request
- **WHEN** a caller captures the runner once and calls it for two requests with the contexts `{ userId: "u1" }` and `{ userId: "u2" }`
- **THEN** each run sees only its own context

### Requirement: Detached runner
The package SHALL provide a runner that starts a run, given its input and an optional context, in a scope the caller or a workflow engine owns, returns before the run completes, and appends every AG-UI event of the run to the event log under the thread id and run id. Observing the run SHALL be done by subscribing to the event log.

#### Scenario: Start and observe
- **WHEN** a caller starts a run detached and then subscribes to the event log for that thread id and run id
- **THEN** the subscription yields the complete, valid AG-UI sequence from `RUN_STARTED` to the terminal event

#### Scenario: Reconnect
- **WHEN** a client subscribed to a detached run drops after cursor c and later subscribes again after c
- **THEN** it receives every event after c exactly once and the terminal event

#### Scenario: Context reaches the run
- **WHEN** a caller starts a detached run with the context `{ userId: "u1" }`
- **THEN** the run's system prompt and tool handlers see that context

### Requirement: Re-executing a detached run
Starting a detached run again with the same thread id and run id SHALL NOT re-append events for steps that are replayed from the checkpoint store. Before appending any new event it SHALL close every text message, tool call and step left open in the log by an earlier attempt, and it SHALL NOT append a second `RUN_STARTED` to a log that already has one. If the log already ends with a terminal event, starting again SHALL do nothing. The caller SHALL pass the same context it passed the first time; the run does not store it.

#### Scenario: Resume after a crash mid-step
- **WHEN** an earlier attempt appended `TEXT_MESSAGE_START` and content for step 2 and stopped, and the run is started again with a ledger-backed checkpoint store
- **THEN** the log receives `TEXT_MESSAGE_END` for that message and `STEP_FINISHED` for step 2, no second `RUN_STARTED` and no repeated events for step 1, then step 2's events under a new message id, and the whole log passes the AG-UI client's checks

#### Scenario: Already finished
- **WHEN** the log for the thread id and run id ends with `RUN_FINISHED`
- **THEN** starting again appends nothing and calls no model

### Requirement: Workflow-backed runner
The package SHALL provide the run as an `effect/workflow` workflow whose payload is the run's input together with its optional context, and whose idempotency key is made from the thread id and the run id, using workflow activities as the checkpoint store, so a durable engine persists and replays runs. Executing it twice with the same thread id and run id SHALL join the same execution; the same run id on another thread SHALL be a separate execution. A resumed execution SHALL see the context from its payload.

#### Scenario: Run inside the in-memory engine
- **WHEN** a run is executed through the workflow runner with the in-memory workflow engine
- **THEN** the event log holds the same valid AG-UI sequence the request-scoped runner would produce, and each tool handler ran once

#### Scenario: Run id reused on another thread
- **WHEN** inputs with run id "r1" on threads "t1" and "t2" are each executed through the workflow runner
- **THEN** each thread's event log holds its own complete run, and the weather handler ran once per thread

#### Scenario: Context in the payload
- **WHEN** a run is executed through the workflow runner with the context `{ userId: "u1" }`
- **THEN** its tool handlers see that context
