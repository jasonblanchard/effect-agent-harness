# agui-transport-edge Specification

## Purpose

Lets applications expose the AG-UI agent through a transport they own (an HTTP route, a WebSocket, an in-process call). The package supplies runners whose event streams have no service requirements. The input schema, the AG-UI endpoint and the SSE encoding come from Effect (`effect/ai`'s `AgUiSchema` and `AgUiServer`, `effect/http-api`'s `StreamSse`), and the package has no HTTP code of its own. It does not own a web server or route.
## Requirements

### Requirement: No server ownership
The package SHALL NOT start servers, register routes, or depend on an HTTP server module. The caller SHALL choose the transport, path, status codes, and headers.

#### Scenario: Caller-owned route
- **WHEN** an application defines its own `POST /agent` route that decodes the input, runs the agent, and encodes the events as SSE
- **THEN** an `HttpAgent` pointed at that route can run a multi-turn conversation that includes tool calls

### Requirement: Run input is the AG-UI input as Effect decodes it
Every runner SHALL take the AG-UI 1.0 `RunAgentInput` as `effect/ai`'s `AgUiSchema.RunAgentInput` decodes it. The package SHALL NOT provide its own input schema or decoder. Input that schema rejects SHALL be rejected by the caller before a run starts, and nothing SHALL be committed for it. The run SHALL read `threadId`, `runId`, `messages`, `resume`, `tools` (as the frontend tools) and `forwardedProps` (as the run's untrusted `props`). It SHALL ignore every other field, though those fields stay part of the input the runner memoises.

#### Scenario: Extra fields
- **WHEN** the input includes `context`, `state`, `parentRunId` and `protocolVersion` alongside the fields the run reads
- **THEN** decoding succeeds, and the run behaves as it would without them

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails, and no run starts

#### Scenario: Tool without a description
- **WHEN** an entry in `tools` has a `name` and no `description`
- **THEN** decoding fails, and no run starts

#### Scenario: Resume entries
- **WHEN** the input includes `resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }]`
- **THEN** decoding succeeds and the entry is available to the run

#### Scenario: Forwarded properties of any shape
- **WHEN** the input's `forwardedProps` is a string, an array or a nested object
- **THEN** decoding succeeds and the run's `props` is that value, unchanged

#### Scenario: No tools
- **WHEN** the input has no `tools` field, or an empty one
- **THEN** decoding succeeds and the run has no frontend tools

#### Scenario: Unknown message role
- **WHEN** the input holds a message whose `role` the AG-UI version doesn't define, between two user messages
- **THEN** decoding succeeds without it, and the model receives both user messages

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
For the request-scoped runner, when the consumer of a run's event stream stops reading before the terminal event (for example, because a client disconnects or calls `abortRun()`), the run SHALL be cancelled. Any model request or tool execution still in progress SHALL be stopped, as for any cancelled run. The run SHALL then end as cancelled even though no consumer reads its remaining events: it SHALL commit its cancelled step and notify the store, and release its claim under the server history. The consumer's stream SHALL finish closing only once the run has ended, or once a time limit (`cancelTimeout`, 30 seconds by default) has passed. A run still going then SHALL be interrupted, and its claim released without a run-ended notification, so a hung store or handler cannot hold the request, or a shutdown, for ever. The detached runner SHALL NOT be affected by any consumer stopping.

#### Scenario: Consumer takes only the first events
- **WHEN** a consumer of the request-scoped runner reads the first three events and then stops while the model is still streaming
- **THEN** the model stream is interrupted

#### Scenario: Disconnect records the partial turn
- **WHEN** a request-scoped run under the server history has streamed "Hel" and its consumer stops
- **THEN** the thread holds an assistant entry "Hel" under the step's message id, the store is notified with the cancelled outcome, and the thread is free

#### Scenario: A cancelled run that doesn't end in time
- **WHEN** a request-scoped run's consumer stops, and committing the run's partial step hangs
- **THEN** after `cancelTimeout` the run is interrupted, the thread is released, and the consumer's stream finishes closing

#### Scenario: Subscriber of a detached run disconnects
- **WHEN** a subscriber to a detached run's event log stops reading while the model is still streaming
- **THEN** the run continues and its remaining events are appended to the log

### Requirement: Serving runs through Effect's AG-UI binding
A request-scoped run's event stream SHALL be servable as the response of `effect/ai`'s AG-UI endpoint (`AgUiServer.endpoint` implemented with `AgUiServer.handler`) without any adapter from this package, and an `HttpAgent` SHALL accept the result. Events read from the event log SHALL be servable as Server-Sent Events with each event's cursor as its SSE `id`, using `effect/http-api`'s SSE stream schema, so a client can resume with `Last-Event-ID`. The package SHALL contain no HTTP code of its own.

#### Scenario: HttpAgent runs a conversation through the endpoint
- **WHEN** an application serves a request-scoped runner through the AG-UI endpoint, and an `HttpAgent` runs a multi-turn conversation that includes tool calls against it
- **THEN** `HttpAgent` invokes its text, tool call and tool result subscribers, and every run resolves without errors from the client's sequence checks

#### Scenario: One run lifecycle on the wire
- **WHEN** a run is served through the AG-UI endpoint
- **THEN** the client receives exactly one `RUN_STARTED` first and exactly one terminal event last, and the terminal event is the one the run emitted (its outcome, interrupts, `pendingToolCallIds`, or `RUN_ERROR` message and code)

#### Scenario: Disconnect cancels the run
- **WHEN** a client of the AG-UI endpoint disconnects while the model is still streaming
- **THEN** the model stream is interrupted, and under the server history the thread's claim is released

#### Scenario: Invalid input is rejected before the stream
- **WHEN** a request to the AG-UI endpoint carries a body that the AG-UI input schema rejects
- **THEN** the response has status 400, no event stream opens, and the model is not called

#### Scenario: Replay carries cursors as ids
- **WHEN** a route serves stored events with cursors "0", "1", "2" from the event log as Server-Sent Events
- **THEN** each event's frame has an `id:` line equal to its cursor, and its `data:` line decodes to the stored event

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

### Requirement: A request-scoped runner is an AG-UI server agent
The package SHALL provide an adapter that turns an agent and the request-scoped runner's options into a value of `effect/ai`'s AG-UI server agent type. It SHALL NOT be a separate kind of runner: each accepted input SHALL run exactly as the request-scoped runner runs it, including cancellation when the consumer stops. The adapter exists so the runner can be served wherever `effect/ai`'s own agent is (`AgUiServer.layerHttp` with `agent`, or `AgUiServer.agentHandler`) with no glue code in the application. Before any event stream opens, the agent it returns SHALL reject an input whose frontend tools reuse the name of one of the agent's tools or subagents, which `effect/ai`'s endpoint answers with status 400. For an accepted input, its stream SHALL be the runner's stream for that input, so tool handlers see the run's AG-UI input through `effect/ai`'s run input service as they do under `effect/ai`'s own agent (see the agent-run capability).

#### Scenario: Served by the layer
- **WHEN** an application serves an agent with `AgUiServer.layerHttp({ path: "/agent", agent })`, where `agent` comes from a request-scoped runner, and an `HttpAgent` runs a conversation with a tool call against it
- **THEN** `HttpAgent` receives the text, the tool call and its result, and the run resolves without errors from the client's sequence checks

#### Scenario: Same run as the request-scoped runner
- **WHEN** a client of an endpoint served through the adapter disconnects while the model is still streaming
- **THEN** the run is cancelled exactly as a request-scoped run is: the model stream is interrupted, and under the server history the partial step is committed and the thread released

#### Scenario: Frontend tool clash
- **WHEN** a request to that endpoint advertises the frontend tool `get-weather`, which is also one of the agent's tools
- **THEN** the response has status 400, no event stream opens, and the model is not called

#### Scenario: Swapping in for effect's agent
- **WHEN** an application that served `AgUiServer.agent({ toolkit, system, maxSteps })` serves instead an agent defined with the same toolkit, system prompt and step limit through a request-scoped runner, with tools that read the run input service unchanged
- **THEN** a client running a text-only turn and a turn with a server tool call receives a valid AG-UI sequence, with the same text, tool calls and tool results, and `RUN_FINISHED` with `usage`

### Requirement: Internal markers never leave a runner
Every event a runner emits or appends to the event log SHALL be free of the `effect-agent-harness` metadata key the agent's run uses to mark replayed events. A replayed `TOOL_CALL_RESULT` or subagent closing event SHALL be emitted or appended only when the earlier attempt's log does not hold it already, as the agui-subagent-events capability specifies for resumed attempts, and without that key.

#### Scenario: Resume publishes a held result once
- **WHEN** a detached run's step calls `get-weather` and a subagent, `get-weather` finishes, the attempt crashes while the subagent streams, and the run is started again
- **THEN** the log holds one `TOOL_CALL_RESULT` for the `get-weather` call, and no event in the log carries the `effect-agent-harness` metadata key

#### Scenario: Already published
- **WHEN** a resumed attempt replays a tool call whose `TOOL_CALL_RESULT` the earlier attempt's log already holds
- **THEN** the runner appends no second `TOOL_CALL_RESULT` for it
