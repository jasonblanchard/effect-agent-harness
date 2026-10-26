## MODIFIED Requirements

### Requirement: Run from a prompt to step events
Given a run's info and a prompt, the run SHALL produce an event stream that never fails. The run info SHALL consist of a run id, a thread id and optional properties supplied by the client. The prompt SHALL NOT contain the agent's system prompt; the run adds it. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome) or failed (with the error's message and code), and SHALL emit nothing after it.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are step-started (step 1), the model parts in order, step-finished (step 1), finished with the success outcome

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream ends with one failed event whose code is `ModelStreamError` and no event follows it

### Requirement: The current run is available to the system prompt and tool handlers
While it computes the system prompt and while it executes each tool handler, the run SHALL make its run info (run id, thread id and properties) available as the current run, exactly as the run was given it. A tool SHALL be able to read the current run by declaring it as a dependency. Running an agent SHALL NOT require the caller to provide the current run. Trusted per-run data, such as the verified principal, SHALL reach the agent as services it requires, not through the current run.

#### Scenario: Tool handler reads the context
- **WHEN** a run is given run id "r1", thread id "t1" and properties `{ locale: "fr" }`, and the model calls a tool whose handler reads the current run
- **THEN** the handler sees run id "r1", thread id "t1" and properties `{ locale: "fr" }`, and the run info has no context field

#### Scenario: Eval supplies the run info
- **WHEN** an eval runs an agent directly with literal run info and mock services, without any AG-UI input
- **THEN** the system prompt and tool handlers see that literal run info

#### Scenario: Nothing extra to provide
- **WHEN** an agent with a tool that reads the current run is run with only the model, the tool handlers and a checkpoint store provided
- **THEN** the run proceeds without a missing-service error
