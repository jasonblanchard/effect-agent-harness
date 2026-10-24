# Spec Delta

## MODIFIED Requirements

### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt and a step limit (a positive integer, default 10), and SHALL NOT reference any model provider, thread store, checkpoint store or event log. The system prompt SHALL be either fixed text or computed for each run, reading the current run and services the definition declares; those services SHALL be part of what the definition requires to run. The same definition SHALL be runnable under different sets of provided services without modification.

#### Scenario: Same definition, two environments
- **WHEN** one agent definition is run against a scripted model with passthrough checkpoints and again with a ledger-backed checkpoint store
- **THEN** the model receives identical prompts in both runs

#### Scenario: Invalid step limit
- **WHEN** an agent is defined with a step limit of 0 or a non-integer
- **THEN** definition fails with a range error

#### Scenario: Same definition, different service values
- **WHEN** an agent whose system prompt includes the name from a user directory service is run once with a directory returning "Ada" and once with one returning "Grace"
- **THEN** the first run's system prompt names Ada, the second's names Grace, and the definition is unchanged

### Requirement: Run from a prompt to step events
Given a run's info and a prompt, the run SHALL produce an event stream that never fails. The run info SHALL consist of a run id, a thread id, optional properties supplied by the client and an optional context supplied by the server. The prompt SHALL NOT contain the agent's system prompt; the run adds it. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome) or failed (with the error's message and code), and SHALL emit nothing after it.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are step-started (step 1), the model parts in order, step-finished (step 1), finished with the success outcome

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream ends with one failed event whose code is `ModelStreamError` and no event follows it

### Requirement: Each tool call executes at most once per run
A tool handler SHALL run at most once for a given thread id, run id and tool call id, including when the run is executed again after an interruption and the earlier attempt had already completed that tool call. A run with the same run id on another thread SHALL NOT replay that tool call's result.

#### Scenario: Resume after a crash following a tool call
- **WHEN** a run with a ledger-backed checkpoint store completes the `get-weather` call in step 1 and then fails before step 2 completes, and the same run id is executed again on the same thread against the same ledger
- **THEN** the weather handler has run exactly once in total and the second execution continues from step 2

#### Scenario: Parallel tool calls
- **WHEN** the model makes two tool calls in one step
- **THEN** both handlers run and both results are emitted, each once

## ADDED Requirements

### Requirement: The current run is available to the system prompt and tool handlers
While it computes the system prompt and while it executes each tool handler, the run SHALL make its run info available as the current run, exactly as the run was given it. A tool SHALL be able to read the current run by declaring it as a dependency. Running an agent SHALL NOT require the caller to provide the current run.

#### Scenario: Tool handler reads the context
- **WHEN** a run is given the context `{ userId: "u1" }` and the model calls a tool whose handler reads the current run
- **THEN** the handler sees run info with that context and the run's run id and thread id

#### Scenario: Eval supplies the run info
- **WHEN** an eval runs an agent directly with literal run info and mock services, without any AG-UI input
- **THEN** the system prompt and tool handlers see that literal run info

#### Scenario: Nothing extra to provide
- **WHEN** an agent with a tool that reads the current run is run with only the model, the tool handlers and a checkpoint store provided
- **THEN** the run proceeds without a missing-service error

### Requirement: The run applies the system prompt
The run SHALL send the agent's system prompt as the first message of every model call, followed by the given prompt. An agent without a system prompt SHALL send the given prompt unchanged.

#### Scenario: Fixed system prompt
- **WHEN** an agent with the system prompt "Be helpful." is run with a prompt holding one user message
- **THEN** every model call receives the system message "Be helpful." followed by that user message

#### Scenario: Computed from the run's properties
- **WHEN** an agent's system prompt reads the properties of the current run and the run is given properties `{ locale: "fr" }`
- **THEN** the system prompt the model receives is the one computed for locale "fr"

#### Scenario: Prompt starting with a system message
- **WHEN** the given prompt starts with a system message holding a summary
- **THEN** the model receives the agent's system prompt first and the summary second

### Requirement: A computed system prompt is resolved once per run
A computed system prompt SHALL be resolved once per run, before the first model call and before approvals carried by the prompt are resolved, and SHALL be memoised under the thread id and run id, so a run executed again after an interruption uses the same text even if the services it reads now return different values. If resolving it fails, the run SHALL end with a failed event without calling the model or running any tool.

#### Scenario: Several steps
- **WHEN** a run with a computed system prompt takes two model steps
- **THEN** the system prompt is resolved once and both model calls receive the same text

#### Scenario: Re-executed run
- **WHEN** a run with a ledger-backed checkpoint store resolves its system prompt from a clock service, is interrupted during step 1, and is executed again after the clock has moved on
- **THEN** the model calls in the second execution receive the system prompt resolved in the first

#### Scenario: Resolution dies
- **WHEN** resolving the system prompt dies with a defect
- **THEN** the run ends with one failed event, the model is not called and no tool handler runs
