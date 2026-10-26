## MODIFIED Requirements

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
