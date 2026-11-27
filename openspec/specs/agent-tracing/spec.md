# agent-tracing Specification

## Purpose
Describes the OpenTelemetry spans and attributes an agent run produces, following the OpenTelemetry GenAI semantic conventions, so LLM observability backends such as PostHog can show each run as a trace, each thread as a session, and each model and tool call with its cost and content.
## Requirements

### Requirement: A run is one GenAI agent trace

Every run attempt started through a runner SHALL produce one root span named `invoke_agent {agent name}`, or `invoke_agent` when the agent has no name, that starts a new trace. When the runner is called inside an existing span, the root span SHALL carry a link to that span instead of being its child. The root span SHALL carry `gen_ai.operation.name` = `invoke_agent`, `gen_ai.conversation.id` = the thread id, the run id, and `gen_ai.agent.name` when the agent has a name. It SHALL cover the whole attempt, from opening the history to the terminal event.

#### Scenario: Named agent

- **WHEN** an agent defined with the name `assistant` runs on thread `t1`
- **THEN** exactly one exported span has no parent; it is named `invoke_agent assistant`, with `gen_ai.operation.name` = `invoke_agent`, `gen_ai.agent.name` = `assistant` and `gen_ai.conversation.id` = `t1`

#### Scenario: Called from a request span

- **WHEN** a route handler running inside an HTTP server span starts a run
- **THEN** the run's root span is in a different trace from the HTTP span and carries a link to it

#### Scenario: Unnamed agent

- **WHEN** an agent defined without a name runs
- **THEN** its root span is named `invoke_agent` and has no `gen_ai.agent.name`

### Requirement: A failed run marks its root span as an error

When a run ends with `RUN_ERROR`, its root span SHALL end with error status and carry `error.type` = the `RUN_ERROR` code, or `Error` when it has none. The span SHALL end with the run's original failure as its exit, wherever the failure arose (the agent's run, the runner, or the store recording the run's end), so an exporter records the original error, with its type, message and stack, as the span's one exception event. The library SHALL NOT add an exception event to the span itself. The failure SHALL be logged once, at error level. A subagent's failure that its parent reports as a failed tool result SHALL end the subagent's span with the child's original failure and SHALL NOT be logged at error level. Even so, the run's event stream SHALL NOT fail.

#### Scenario: Model failure

- **WHEN** the model stream emits an error part and the run ends with `RUN_ERROR` of code `ModelStreamError`
- **THEN** the root span has error status, `error.type` = `ModelStreamError`, and ends with the model's error as its exit, which an exporter records as one exception event; the stream still ends with `RUN_ERROR` rather than failing

#### Scenario: Failure before the agent runs

- **WHEN** a run under the server history fails to load its thread and ends with `RUN_ERROR` of code `ThreadError`
- **THEN** the root span has error status, `error.type` = `ThreadError`, and ends with the store's error as its exit

#### Scenario: A subagent fails and the parent recovers

- **WHEN** a subagent's run fails and its parent reports the failure as a failed tool result and finishes
- **THEN** the subagent's `invoke_agent` span ends with the child's error as its exit, the root span has no error status, and nothing is logged at error level

#### Scenario: Successful run

- **WHEN** a run finishes with any finished outcome, including an interrupt
- **THEN** the root span does not have error status and ends with a successful exit

### Requirement: Model calls are tied to the conversation

Every model call a run makes SHALL be traced as a child of that run's root span. Its span SHALL carry `gen_ai.conversation.id` = the thread id, in addition to the attributes the model provider writes. The run SHALL NOT add its attributes to spans it neither creates nor receives from the model layer, such as the HTTP client spans of a provider request.

#### Scenario: Two model steps

- **WHEN** a run calls the model, executes a tool, and calls the model again
- **THEN** two model call spans are descendants of the root span and both carry `gen_ai.conversation.id` = the thread id

#### Scenario: Provider HTTP spans are left alone

- **WHEN** the model provider creates an HTTP client span for its request
- **THEN** that span has no `gen_ai.conversation.id` and none of the caller's span attributes

### Requirement: Executed tool calls have their own spans

Each tool call whose handler the run executes SHALL produce one span named `execute_tool {tool name}`, a descendant of the root span, covering the handler. It SHALL carry `gen_ai.operation.name` = `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` = `function` and `gen_ai.conversation.id`, plus `gen_ai.agent.name` when the agent is named and `gen_ai.tool.description` when the tool has one. When the handler's result is a failure, the span SHALL carry `error.type` and end with error status, while the run still receives the failure as the tool's result. A tool call whose handler doesn't run SHALL produce no tool span. That covers a call awaiting approval, a denied call, a frontend tool call and an interrupted call. The run's root and other spans SHALL NOT carry the tool's name or parameters.

#### Scenario: Server tool executed

- **WHEN** the model calls `get-weather` with id `call-1` and the handler runs
- **THEN** one span named `execute_tool get-weather` has `gen_ai.tool.name` = `get-weather` and `gen_ai.tool.call.id` = `call-1`, and no other span carries the tool's parameters

#### Scenario: Approval requested

- **WHEN** the model calls a tool that needs approval and the run ends with the interrupt outcome
- **THEN** no `execute_tool` span is produced for that call

#### Scenario: Approved on resume

- **WHEN** the next run answers that approval with `approved: true` and the handler runs as step 0
- **THEN** that run's trace contains one `execute_tool` span for the call

#### Scenario: Tool failure returned to the model

- **WHEN** a tool with return-style failures fails for an unknown location
- **THEN** its `execute_tool` span carries `error.type` and has error status, and the run continues to the next model step

### Requirement: Replayed steps produce no spans

A model step or tool call that a run executed again reads from its checkpoint SHALL NOT produce a model call span or an `execute_tool` span. Only the work an attempt actually performs is traced, so token usage and cost are never counted twice.

#### Scenario: Resume after a crash

- **WHEN** a run with a durable checkpoint store completes step 1, including a tool call, crashes in step 2, and is executed again with the same run id
- **THEN** the second attempt's trace has no model call span for step 1 and no `execute_tool` span for that tool call

### Requirement: Content is not captured by default

Without content capture enabled, no span SHALL carry prompt, response, system prompt, tool definition, tool argument or tool result content.

#### Scenario: Default run

- **WHEN** a run executes a tool call without content capture enabled
- **THEN** no exported span carries `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments` or `gen_ai.tool.call.result`

### Requirement: Content capture follows the GenAI message format

With content capture enabled, each model call span SHALL carry, as JSON text:
- `gen_ai.system_instructions`: the system messages that open the prompt, as text parts;
- `gen_ai.input.messages`: the rest of the prompt, in the conventions' input message format, with any later system message kept in its position as a `system` message;
- `gen_ai.output.messages`: the response, without a per-message finish reason (the conventions deprecate it; the finish reason is the model span's `gen_ai.response.finish_reasons`);
- `gen_ai.tool.definitions`: the tools offered, with name, description and parameter schema.

Messages SHALL use the conventions' part types (`text`, `reasoning`, `tool_call`, `tool_call_response`, `blob`). Reasoning parts with no text SHALL be left out. Each `execute_tool` span SHALL carry `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` as JSON text.

#### Scenario: Tool-calling step

- **WHEN** content capture is enabled and the model answers "What's the weather in Paris?" with a `get-weather` call
- **THEN** the model call span's input messages hold one user message with that text, and its output messages hold one assistant message with a `tool_call` part named `get-weather`

#### Scenario: Tool arguments and result

- **WHEN** content capture is enabled and the weather handler returns a result
- **THEN** the `execute_tool` span's arguments are the call's parameters as JSON and its result is the handler's encoded result as JSON

#### Scenario: Empty reasoning block

- **WHEN** the model emits a reasoning block with no text followed by text
- **THEN** the output messages contain only the text part

### Requirement: Callers can add span attributes per run

A caller SHALL be able to supply a set of attributes for a run, for example a user id, without changing the agent definition. These attributes SHALL appear on the root span, every model call span and every `execute_tool` span of that run, and on no other span. Attributes in the `gen_ai.` namespace SHALL be ignored, so a caller can't change the library's own attributes. Different runs SHALL be able to carry different attributes under the same runner.

#### Scenario: User id per request

- **WHEN** one request runs the agent with attributes `{ "user.id": "ada" }` and another with `{ "user.id": "grace" }`
- **THEN** every root, model call and tool span of the first run carries `user.id` = `ada`, every one of the second carries `grace`, and the provider's HTTP spans carry neither

#### Scenario: Caller sets a gen_ai attribute

- **WHEN** a run is given attributes `{ "gen_ai.conversation.id": "spoofed", "user.id": "ada" }`
- **THEN** every root, model call and tool span of the run carries `user.id` = `ada` and `gen_ai.conversation.id` = the thread id

### Requirement: Tracing never changes a run's behaviour

The events a run emits, the prompts the model receives and the checkpoints a run writes SHALL be identical whether or not a tracer is provided, content capture is enabled or span attributes are supplied.

#### Scenario: Same run, traced and untraced

- **WHEN** the same input runs against a scripted model once with no tracer and once with a recording tracer and content capture enabled
- **THEN** both runs emit the same AG-UI events and the model receives the same prompts

### Requirement: A cancelled run is not an error
When a run ends with the cancelled outcome, its root span SHALL end without error status and SHALL NOT carry `error.type`. A tool span whose handler was interrupted by the cancellation SHALL end as interrupted, as it does when a request is cancelled.

#### Scenario: Cancelled while the model streams
- **WHEN** a run is cancelled while the model streams
- **THEN** the root span ends without error status and has no `error.type`
