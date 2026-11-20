## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Lenient run input decoding
**Reason**: The package no longer owns an input schema. Runners take `effect/ai`'s `AgUiSchema.RunAgentInput`, which validates the input against the AG-UI spec and keeps the fields the run ignores. See "Run input is the AG-UI input as Effect decodes it".
**Migration**: Decode request bodies with `AgUiSchema.RunAgentInput` from `effect/ai` (for example, as the `AgUiServer.endpoint` payload) in place of `AgUi.RunAgentInput` / `AgUi.decodeRunAgentInput`. Clients must send spec-valid input: for example, a `description` on every tool and `type: "function"` on every tool call.

### Requirement: SSE encoding
**Reason**: Effect's AG-UI endpoint and its `StreamSse` response schema cover SSE encoding, content type, `cache-control: no-cache` and per-event ids. See "Serving runs through Effect's AG-UI binding".
**Migration**: Replace `Sse.encode` + `Sse.response` with `AgUiServer.endpoint` / `AgUiServer.handler`. Replace `Sse.encodeStored` with an `HttpApi` endpoint whose success schema is `HttpApiSchema.StreamSse({ events })`, with an events schema whose `id` is the stored cursor and whose `data` is the JSON-encoded AG-UI event.
