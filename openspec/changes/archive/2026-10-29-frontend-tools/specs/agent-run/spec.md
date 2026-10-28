## MODIFIED Requirements

### Requirement: Run from a prompt to step events
Given a run's info, a prompt and the frontend tools the client advertised for the run (none when it advertised none), the run SHALL produce an event stream that never fails. The run info SHALL consist of a run id, a thread id and optional properties supplied by the client. The prompt SHALL NOT contain the agent's system prompt; the run adds it. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome) or failed (with the error's message and code), and SHALL emit nothing after it.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are step-started (step 1), the model parts in order, step-finished (step 1), finished with the success outcome

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream ends with one failed event whose code is `ModelStreamError` and no event follows it

### Requirement: The model never receives approval parts
Before each model call the run SHALL remove approval request and approval response parts from the prompt and drop any message left empty. It SHALL also remove the record that a tool call belongs to the client, so that no provider receives it.

#### Scenario: Prompt after an approval round trip
- **WHEN** the model is called after step 0 resolved an approval
- **THEN** the prompt it receives contains the tool call and its result but no approval request or response parts

#### Scenario: Prompt after a frontend call was answered
- **WHEN** the model is called on a thread holding an answered frontend tool call
- **THEN** the prompt it receives contains the tool call and its result, and nothing marking the call as the client's

### Requirement: Continuation rule
After a step, the run SHALL continue with a new model step only when the finish reason is `tool-calls`, at least one tool call was made, no approval is pending and no frontend tool call is pending. When the finish reason is neither `tool-calls` nor `stop`, each tool call in that step, frontend calls included, SHALL receive a failed result stating the finish reason instead of running its handler or being left pending, and the run SHALL finish.

#### Scenario: Finish reason length with a tool call
- **WHEN** the model emits a tool call and finishes with reason `length`
- **THEN** the handler does not run, a failed tool result naming the reason is emitted, and the run finishes successfully

#### Scenario: Finish reason length with a frontend call
- **WHEN** the model calls a frontend tool and finishes with reason `length`
- **THEN** a failed tool result naming the reason is emitted for the call, and the run finishes successfully with no pending calls

## ADDED Requirements

### Requirement: Frontend tools are offered to the model
Every model call in a run SHALL offer the agent's own tools together with the run's frontend tools, each frontend tool with the name, description and parameter schema the client gave. When a frontend tool has the same name as one of the agent's tools, the agent's tool SHALL be offered and the frontend tool SHALL be left out. A run with no frontend tools SHALL offer exactly the agent's own tools.

#### Scenario: Advertised tool offered
- **WHEN** a run's frontend tools include `pick-file` with a description and a JSON Schema for its parameters
- **THEN** every model call in the run offers `pick-file` with that description and schema, alongside the agent's tools

#### Scenario: Name clash with a server tool
- **WHEN** a run's frontend tools include `get-weather`, which is also one of the agent's tools
- **THEN** the model is offered the agent's `get-weather` only, and a call to it runs the agent's handler

### Requirement: Frontend tool calls are left pending
When the model calls a frontend tool in a step that finishes with reason `tool-calls` or `stop`, the run SHALL NOT produce a result for the call and SHALL emit no tool-result event for it. It SHALL record on the step's assistant message that the call belongs to the client. Other tool calls in the same step SHALL execute or request approval as they would without the frontend call.

#### Scenario: Frontend call on its own
- **WHEN** the model calls `pick-file`, a frontend tool, and finishes with reason `tool-calls`
- **THEN** no tool-result event is emitted for the call, step-finished's entries hold the assistant message with the call and no result for it, and the model is not called again

#### Scenario: Frontend call next to a server call
- **WHEN** the model calls `pick-file` (frontend) and `get-weather` (server) in one step
- **THEN** the weather handler runs and its result is emitted, the frontend call gets no result, and the run finishes without another model call

#### Scenario: Replayed step
- **WHEN** a run that left a frontend call pending is executed again with the same run id against a durable checkpoint
- **THEN** the replayed step leaves the same call pending and the run finishes with the same outcome

### Requirement: The outcome lists pending frontend calls
The success outcome and the interrupted outcome SHALL each list the frontend tool calls the run left pending, with their tool call ids and tool names, in the order the model made them. The list SHALL be empty when none are pending.

#### Scenario: Success with a pending call
- **WHEN** a run's last step calls the frontend tool `pick-file`
- **THEN** the run finishes with the success outcome listing that call

#### Scenario: Interrupted with a pending call
- **WHEN** one step calls `pick-file` (frontend) and `send-email` (requires approval)
- **THEN** the run finishes with the interrupted outcome listing the email approval and the pending `pick-file` call
