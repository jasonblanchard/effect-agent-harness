## ADDED Requirements

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
