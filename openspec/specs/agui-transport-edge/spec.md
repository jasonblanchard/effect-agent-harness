# agui-transport-edge Specification

## Purpose

Lets applications expose the AG-UI agent through a transport they own (an HTTP route, a WebSocket, an in-process call). The package supplies the run input decoder, runners whose event streams have no service requirements, and an SSE encoding compatible with `@ag-ui/client`'s `HttpAgent`. It does not own a web server or route.
## Requirements
### Requirement: No server ownership
The package SHALL NOT start servers, register routes, or depend on an HTTP server module. The caller SHALL choose the transport, path, status codes, and headers.

#### Scenario: Caller-owned route
- **WHEN** an application defines its own `POST /agent` route that decodes the input, runs the agent, and encodes the events as SSE
- **THEN** an `HttpAgent` pointed at that route can run a multi-turn conversation that includes tool calls

### Requirement: Lenient run input decoding
The package SHALL provide a decoder for AG-UI `RunAgentInput` that checks only the fields the agent uses: `threadId`, `runId`, the `messages` fields needed for ingestion, `resume` entries (`interruptId`, `status`, optional `payload`), and `tools` entries (`name`, optional `description`, `parameters`). It SHALL keep an optional `forwardedProps` value of any shape without checking it, and each tool's `parameters` without checking it against JSON Schema. It SHALL accept and ignore any other fields, and it SHALL fail on input whose required fields are missing or malformed, so the caller can reject it before starting a run.

#### Scenario: Extra fields
- **WHEN** the input includes `tools`, `context`, `state`, `forwardedProps` and `protocolVersion`
- **THEN** decoding succeeds and returns only the fields the agent reads, including `tools` and `forwardedProps`

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails

#### Scenario: Resume entries
- **WHEN** the input includes `resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }]`
- **THEN** decoding succeeds and the entry is available to the run

#### Scenario: Forwarded properties of any shape
- **WHEN** the input's `forwardedProps` is a string, an array or a nested object
- **THEN** decoding succeeds and returns `forwardedProps` unchanged

#### Scenario: Tool without a name
- **WHEN** an entry in `tools` has no `name`
- **THEN** decoding fails

#### Scenario: No tools
- **WHEN** the input has no `tools` field, or an empty one
- **THEN** decoding succeeds and the run has no frontend tools

### Requirement: Runner without service requirements
The package SHALL provide a request-scoped run as a function from the run's input to an event stream, made without capturing any service.

**What the stream requires.** The stream SHALL require:
- the agent's services: the language model, the tool handlers, and any services the agent's system prompt or tools declare, such as the trusted context the caller provides per run;
- the checkpoint store;

less the services the run's per-run layer provides, plus that layer's own requirements. The stream SHALL NOT require a thread store or a history. A history MAY be provided to the stream, and the thread store is then a requirement of that history.

**Providing it.** The caller SHALL be able to provide these where it consumes the stream, for example by providing the per-request ones and closing over its own context. The stream then requires nothing, and can be consumed after the code that created it has returned, for example as a response body.

**Failures.** The stream SHALL NOT fail: failures are reported in-band as `RUN_ERROR`.

#### Scenario: Nothing captured when the function is made
- **WHEN** the run function is made outside any Effect, before any service exists
- **THEN** making it requires nothing, and each stream it returns requires the services the run needs

#### Scenario: Stream used as a response body
- **WHEN** a route calls the run inside its request handler, provides the request's principal to the stream and then provides the handler's own context to it
- **THEN** the stream requires nothing further and can be consumed after the handler has returned

#### Scenario: Context per request
- **WHEN** a route provides the "app/Auth" services `{ userId: "u1" }` and `{ userId: "u2" }` to the runs of two requests
- **THEN** each run's tools see only the services built from its own run context

#### Scenario: Per-run services are built per run
- **WHEN** an agent requires `CurrentUser`, and the run's layer provides it from "app/Auth"
- **THEN** the run's stream requires "app/Auth" and not `CurrentUser`, and `CurrentUser` is built for each run

#### Scenario: No thread store required
- **WHEN** a run's stream is provided the agent's services and a checkpoint store only
- **THEN** it requires nothing further, and the run uses the client history

#### Scenario: Server history brings its store
- **WHEN** a run's stream is provided the server history, built with an in-memory thread store, alongside the agent's services and a checkpoint store
- **THEN** it requires nothing further, and the run uses the store's history

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

For callers whose transport is `effect/http`, the package SHALL also provide an HTTP response built from such frames. It SHALL have content type `text/event-stream` and `cache-control: no-cache`, unless the caller overrides them, and the caller SHALL be able to set the status and add headers. Building the response SHALL require whatever services the frames still need, and SHALL provide them to the body from the context it is built in, so the body needs nothing further once the code that built the response has returned. The response SHALL NOT buffer the frames.

#### Scenario: Frames parse back into events
- **WHEN** a text-only run is encoded and the resulting frames are parsed
- **THEN** each `data:` frame decodes to the corresponding AG-UI event, in order

#### Scenario: HttpAgent consumes the encoding
- **WHEN** a caller's route responds with the encoded frames and content type `text/event-stream`
- **THEN** `HttpAgent` invokes its text, tool call, and tool result subscribers, and the run resolves without errors from the client's sequence checks

#### Scenario: Stored events carry ids
- **WHEN** stored events with cursors "0", "1", "2" are encoded
- **THEN** each frame has an `id:` line equal to its cursor

#### Scenario: Response headers
- **WHEN** a route responds with the package's SSE response and no options
- **THEN** the response has status 200, content type `text/event-stream` and `cache-control: no-cache`

#### Scenario: Caller's status and headers
- **WHEN** a route builds the response with an extra header `x-run: r1`
- **THEN** the response carries `x-run: r1` as well as the SSE content type and `cache-control: no-cache`

#### Scenario: Body carries the handler's services
- **WHEN** a request handler builds the response from a request-scoped run's frames, and the run's services are available only in the handler's context
- **THEN** the body, read after the handler has returned, yields the run's complete AG-UI sequence

#### Scenario: Missing service fails to typecheck
- **WHEN** a handler builds the response from frames that require a service the handler's context does not provide
- **THEN** the handler requires that service, and building or calling an app that does not provide it fails to typecheck

### Requirement: Detached runner
The package SHALL provide a runner that starts a run, given its input, in a scope the caller or a workflow engine owns, returns before the run completes, and appends every AG-UI event of the run to the event log under the thread id and run id. Starting a run SHALL require the runner's declared run contexts, read when the run is started, so a service the caller provides around the start reaches the run. Observing the run SHALL be done by subscribing to the event log.

#### Scenario: Start and observe
- **WHEN** a caller starts a run detached and then subscribes to the event log for that thread id and run id
- **THEN** the subscription yields the complete, valid AG-UI sequence from `RUN_STARTED` to the terminal event

#### Scenario: Reconnect
- **WHEN** a client subscribed to a detached run drops after cursor c and later subscribes again after c
- **THEN** it receives every event after c exactly once and the terminal event

#### Scenario: Context reaches the run
- **WHEN** a caller starts a detached run with the "app/Auth" service `{ userId: "u1" }` provided, on a runner whose layer builds `CurrentUser` from it
- **THEN** the run's system prompt and tool handlers see the `CurrentUser` for `userId: "u1"`

#### Scenario: Layer failure in the log
- **WHEN** a detached run's per-run layer fails with `UserNotFound`
- **THEN** the event log holds `RUN_STARTED` then `RUN_ERROR` with code `UserNotFound`

### Requirement: Re-executing a detached run
Starting a detached run again with the same thread id and run id SHALL NOT re-append events for steps that are replayed from the checkpoint store. Before appending any new event it SHALL close every text message, tool call and step left open in the log by an earlier attempt, and it SHALL NOT append a second `RUN_STARTED` to a log that already has one. If the log already ends with a terminal event, starting again SHALL do nothing. The caller SHALL provide the same run-context services it provided the first time; the run does not store them. Starting again SHALL resolve the run's per-run services again from them.

#### Scenario: Resume after a crash mid-step
- **WHEN** an earlier attempt appended `TEXT_MESSAGE_START` and content for step 2 and stopped, and the run is started again with a ledger-backed checkpoint store
- **THEN** the log receives `TEXT_MESSAGE_END` for that message and `STEP_FINISHED` for step 2, no second `RUN_STARTED` and no repeated events for step 1, then step 2's events under a new message id, and the whole log passes the AG-UI client's checks

#### Scenario: Already finished
- **WHEN** the log for the thread id and run id ends with `RUN_FINISHED`
- **THEN** starting again appends nothing, calls no model and does not build the per-run layer

### Requirement: Workflow-backed runner
The package SHALL provide the run as an `effect/workflow` workflow named by a name the caller must supply, whose payload is the run's input together with, when the runner declares dependencies, their services' values, which SHALL be run contexts so they can be encoded, and whose idempotency key is made from the thread id and the run id, using workflow activities as the checkpoint store, so a durable engine persists and replays runs. The package SHALL provide a way to start a run from its input alone, reading the declared run contexts' services from the caller and returning before the run completes, and a way to get a run's execution id from its input and the same run-context services. The payload's run-context values SHALL be encoded and decoded with the declared run contexts' schemas, so a value that does not match them fails to start an execution. Starting it twice with the same thread id and run id SHALL join the same execution; the same run id on another thread SHALL be a separate execution. A resumed execution SHALL see the run-context values from its payload, and SHALL resolve its per-run services again from them. Workflows for different agents registered with one engine under different names SHALL each run their own agent.

#### Scenario: Run inside the in-memory engine
- **WHEN** a run is executed through the workflow runner with the in-memory workflow engine
- **THEN** the event log holds the same valid AG-UI sequence the request-scoped runner would produce, and each tool handler ran once

#### Scenario: Run id reused on another thread
- **WHEN** inputs with run id "r1" on threads "t1" and "t2" are each executed through the workflow runner
- **THEN** each thread's event log holds its own complete run, and the weather handler ran once per thread

#### Scenario: Two agents on one engine
- **WHEN** workflows for an agent with system prompt "Be helpful." named "weather" and one with "Be brief." named "brief" are registered with one in-memory engine, and each executes a run
- **THEN** the "weather" run's model calls start with "Be helpful." and the "brief" run's with "Be brief."

#### Scenario: Context in the payload
- **WHEN** a run is started through the workflow runner with the "app/Auth" service `{ userId: "u1" }` provided
- **THEN** its tool handlers see the `CurrentUser` built for `userId: "u1"`

#### Scenario: Context the schema rejects
- **WHEN** a workflow run is started with an "app/Auth" service whose `userId` fails its run context's schema
- **THEN** starting the run fails, and no event is appended to the event log

#### Scenario: Execution id from the input
- **WHEN** a run is started through the workflow runner and its execution id is then asked for with the same input and run-context services
- **THEN** the id is the one the engine gave the execution

#### Scenario: Replay resolves the services again
- **WHEN** a workflow execution is replayed after its first step completed
- **THEN** the per-run layer is built again for the replay, and the first step is not executed again
