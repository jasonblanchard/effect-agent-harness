## MODIFIED Requirements

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
