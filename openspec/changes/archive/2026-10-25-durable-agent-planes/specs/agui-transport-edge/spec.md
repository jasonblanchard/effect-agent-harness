# Spec Delta

## MODIFIED Requirements

### Requirement: Lenient run input decoding
The package SHALL provide a decoder for AG-UI `RunAgentInput` that checks only the fields the agent uses: `threadId`, `runId`, the `messages` fields needed for ingestion, and `resume` entries (`interruptId`, `status`, optional `payload`). It SHALL accept and ignore any other fields, and it SHALL fail on input whose required fields are missing or malformed, so the caller can reject it before starting a run.

#### Scenario: Extra fields
- **WHEN** the input includes `tools`, `context`, `state`, `forwardedProps` and `protocolVersion`
- **THEN** decoding succeeds and returns only the fields the agent reads

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails

#### Scenario: Resume entries
- **WHEN** the input includes `resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }]`
- **THEN** decoding succeeds and the entry is available to the run

### Requirement: Runner without service requirements
The package SHALL provide a way to capture the agent's services (language model, tool handlers, thread store, checkpoint store) once and obtain a request-scoped runner. Each run's event stream SHALL then have no outstanding service requirements, so it can be consumed after the code that created it has returned, for example as a response body. The stream SHALL NOT fail: failures are reported in-band as `RUN_ERROR`.

#### Scenario: Stream used as a response body
- **WHEN** a caller captures the runner while its route is being set up and calls it for each request
- **THEN** each returned event stream can be consumed without providing any further services

### Requirement: Cancellation when the consumer stops
For the request-scoped runner, when the consumer of a run's event stream stops reading, for example because a client disconnects or calls `abortRun()`, the run SHALL stop and any model request or tool execution still in progress SHALL be cancelled. The detached runner SHALL NOT be affected by any consumer stopping.

#### Scenario: Consumer takes only the first events
- **WHEN** a consumer of the request-scoped runner reads the first three events and then stops while the model is still streaming
- **THEN** the model stream is interrupted

#### Scenario: Subscriber of a detached run disconnects
- **WHEN** a subscriber to a detached run's event log stops reading while the model is still streaming
- **THEN** the run continues and its remaining events are appended to the log

### Requirement: SSE encoding
The package SHALL provide a pure transform from a stream of AG-UI events to Server-Sent Events frames, along with the matching content type (`text/event-stream`). Each event SHALL become one `data:` frame containing the event as JSON, in emission order. When encoding stored events from the event log, each frame SHALL carry the event's cursor in the SSE `id` field, so a client can resume with `Last-Event-ID`. Each frame SHALL be produced as soon as its event is produced, not buffered until the run ends.

#### Scenario: Frames parse back into events
- **WHEN** a text-only run is encoded and the resulting frames are parsed
- **THEN** each `data:` frame decodes to the corresponding AG-UI event, in order

#### Scenario: HttpAgent consumes the encoding
- **WHEN** a caller's route responds with the encoded frames and content type `text/event-stream`
- **THEN** `HttpAgent` invokes its text, tool call, and tool result subscribers, and the run resolves without errors from the client's sequence checks

#### Scenario: Stored events carry ids
- **WHEN** stored events with cursors "0", "1", "2" are encoded
- **THEN** each frame has an `id:` line equal to its cursor

## ADDED Requirements

### Requirement: Detached runner
The package SHALL provide a runner that starts a run in a scope the caller or a workflow engine owns, returns before the run completes, and appends every AG-UI event of the run to the event log under the run id. Observing the run SHALL be done by subscribing to the event log.

#### Scenario: Start and observe
- **WHEN** a caller starts a run detached and then subscribes to the event log for that run id
- **THEN** the subscription yields the complete, valid AG-UI sequence from `RUN_STARTED` to the terminal event

#### Scenario: Reconnect
- **WHEN** a client subscribed to a detached run drops after cursor c and later subscribes again after c
- **THEN** it receives every event after c exactly once and the terminal event

### Requirement: Re-executing a detached run
Starting a detached run again with the same run id SHALL NOT re-append events for steps that are replayed from the checkpoint store. Before appending any new event it SHALL close every text message, tool call and step left open in the log by an earlier attempt, and it SHALL NOT append a second `RUN_STARTED` to a log that already has one. If the log already ends with a terminal event, starting again SHALL do nothing.

#### Scenario: Resume after a crash mid-step
- **WHEN** an earlier attempt appended `TEXT_MESSAGE_START` and content for step 2 and stopped, and the run is started again with a ledger-backed checkpoint store
- **THEN** the log receives `TEXT_MESSAGE_END` for that message and `STEP_FINISHED` for step 2, no second `RUN_STARTED` and no repeated events for step 1, then step 2's events under a new message id, and the whole log passes the AG-UI client's checks

#### Scenario: Already finished
- **WHEN** the log for the run id ends with `RUN_FINISHED`
- **THEN** starting again appends nothing and calls no model

### Requirement: Workflow-backed runner
The package SHALL provide the run as an `effect/workflow` workflow whose idempotency key is the run id, using workflow activities as the checkpoint store, so a durable engine persists and replays runs. Executing it twice with the same run id SHALL join the same execution.

#### Scenario: Run inside the in-memory engine
- **WHEN** a run is executed through the workflow runner with the in-memory workflow engine
- **THEN** the event log holds the same valid AG-UI sequence the request-scoped runner would produce, and each tool handler ran once
