## Purpose

Lets applications expose the AG-UI agent through a transport they own (an HTTP route, a WebSocket, an in-process call). The package supplies the run input decoder, runners whose event streams have no service requirements, and an SSE encoding compatible with `@ag-ui/client`'s `HttpAgent`. It does not own a web server or route.

## ADDED Requirements

### Requirement: No server ownership
The package SHALL NOT start servers, register routes, or depend on an HTTP server module. The caller SHALL choose the transport, path, status codes, and headers.

#### Scenario: Caller-owned route
- **WHEN** an application defines its own `POST /agent` route that decodes the input, runs the agent, and encodes the events as SSE
- **THEN** an `HttpAgent` pointed at that route can run a multi-turn conversation that includes tool calls

### Requirement: Lenient run input decoding
The package SHALL provide a decoder for AG-UI `RunAgentInput` that checks only the fields the agent uses: `threadId`, `runId`, and the `messages` fields needed for conversion. It SHALL accept and ignore any other fields, and it SHALL fail on input whose required fields are missing or malformed, so the caller can reject it before starting a run.

#### Scenario: Extra fields
- **WHEN** the input includes `tools`, `context`, `state`, `forwardedProps` and `protocolVersion`
- **THEN** decoding succeeds and returns only the fields the agent reads

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails

### Requirement: Runner without service requirements
The package SHALL provide a way to capture the agent's services (language model and tool handlers) once and obtain a runner. Each run's event stream SHALL then have no outstanding service requirements, so it can be consumed after the code that created it has returned, for example as a response body. The stream SHALL NOT fail: failures are reported in-band as `RUN_ERROR`.

#### Scenario: Stream used as a response body
- **WHEN** a caller captures the runner while its route is being set up and calls it for each request
- **THEN** each returned event stream can be consumed without providing any further services

### Requirement: Cancellation when the consumer stops
When the consumer of a run's event stream stops reading, for example because a client disconnects or calls `abortRun()`, the run SHALL stop and any model request or tool execution still in progress SHALL be cancelled.

#### Scenario: Consumer takes only the first events
- **WHEN** a consumer reads the first three events and then stops while the model is still streaming
- **THEN** the model stream is interrupted

### Requirement: SSE encoding
The package SHALL provide a pure transform from a stream of AG-UI events to Server-Sent Events frames, along with the matching content type (`text/event-stream`). Each event SHALL become one `data:` frame containing the event as JSON, in emission order. Each frame SHALL be produced as soon as its event is produced, not buffered until the run ends.

#### Scenario: Frames parse back into events
- **WHEN** a text-only run is encoded and the resulting frames are parsed
- **THEN** each `data:` frame decodes to the corresponding AG-UI event, in order

#### Scenario: HttpAgent consumes the encoding
- **WHEN** a caller's route responds with the encoded frames and content type `text/event-stream`
- **THEN** `HttpAgent` invokes its text, tool call, and tool result subscribers, and the run resolves without errors from the client's sequence checks
