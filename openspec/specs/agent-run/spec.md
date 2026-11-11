# agent-run Specification

## Purpose
Runs an agent's defined behaviour (system prompt, tools, step limit) from a model prompt to a stream of step events, independent of AG-UI, of any transport and of any durability mechanism, so the same behaviour can run in production and in an eval.
## Requirements
### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt, a step limit (a positive integer, default 10) and an optional name. The definition SHALL NOT reference any model provider, thread store, checkpoint store or event log. The name SHALL identify the agent in telemetry only; it SHALL NOT be sent to the model or change the events a run emits. The system prompt SHALL be either fixed text or computed for each run, reading the current run and services the definition declares; those services SHALL be part of what the definition requires to run. The same definition SHALL be runnable under different sets of provided services without modification.

#### Scenario: Same definition, two environments
- **WHEN** one agent definition is run against a scripted model with passthrough checkpoints and again with a ledger-backed checkpoint store
- **THEN** the model receives identical prompts in both runs

#### Scenario: Invalid step limit
- **WHEN** an agent is defined with a step limit of 0 or a non-integer
- **THEN** definition fails with a range error

#### Scenario: Same definition, different service values
- **WHEN** an agent whose system prompt includes the name from a user directory service is run once with a directory returning "Ada" and once with one returning "Grace"
- **THEN** the first run's system prompt names Ada, the second's names Grace, and the definition is unchanged

#### Scenario: Name does not reach the model
- **WHEN** the same definition is run once with the name `assistant` and once without a name
- **THEN** the model receives identical prompts and the runs emit identical events

### Requirement: Run from a prompt to step events
Given a run's info, a prompt and the frontend tools the client advertised for the run (none when it advertised none), the run SHALL produce an event stream that never fails. The run info SHALL consist of a run id, a thread id and optional properties supplied by the client. The prompt SHALL NOT contain the agent's system prompt; the run adds it. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome) or failed (with the error's message and code), and SHALL emit nothing after it.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are step-started (step 1), the model parts in order, step-finished (step 1), finished with the success outcome

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream ends with one failed event whose code is `ModelStreamError` and no event follows it

### Requirement: Tool calls are not executed inside the model call
The run SHALL request model output with tool resolution disabled, so the model layer emits tool calls without running handlers. The run SHALL execute each tool call itself, after the model step completes, as its own checkpointed unit keyed by the tool call id.

#### Scenario: Tool call executed by the run
- **WHEN** the model calls `get-weather` and finishes with reason `tool-calls`
- **THEN** the weather handler runs after the model stream has ended, and a tool-result event for that tool call id is emitted before step-finished

### Requirement: Each tool call executes at most once per run
A tool handler SHALL run at most once for a given thread id, run id and tool call id, including when the run is executed again after an interruption and the earlier attempt had already completed that tool call. A run with the same run id on another thread SHALL NOT replay that tool call's result.

#### Scenario: Resume after a crash following a tool call
- **WHEN** a run with a ledger-backed checkpoint store completes the `get-weather` call in step 1 and then fails before step 2 completes, and the same run id is executed again on the same thread against the same ledger
- **THEN** the weather handler has run exactly once in total and the second execution continues from step 2

#### Scenario: Parallel tool calls
- **WHEN** the model makes two tool calls in one step
- **THEN** both handlers run and both results are emitted, each once

### Requirement: Tool failures are returned to the model
When a tool with return-style failures fails, the run SHALL emit its failure as that call's tool result, marked as a failure, and SHALL continue to the next model step instead of ending the run.

#### Scenario: Unknown location
- **WHEN** the weather handler fails because the location is unknown
- **THEN** a tool-result event marked as a failure is emitted and the model is called again with that result

### Requirement: Tools that need approval interrupt the run
When a tool call targets a tool that requires approval (statically or by evaluating its approval predicate with the decoded parameters), the run SHALL NOT execute the handler. It SHALL emit an approval-requested event with a new approval id, record the request on the step's assistant message, and finish the run with the interrupted outcome listing every pending approval. Other tool calls in the same step SHALL still execute.

#### Scenario: Approval required
- **WHEN** the model calls `send-email` (requires approval) and `get-weather` in one step
- **THEN** the weather handler runs, the email handler does not, an approval-requested event names the email tool call, and the run finishes interrupted with that approval and no further model call

#### Scenario: Approval predicate throws
- **WHEN** a tool's approval predicate fails while evaluating
- **THEN** the tool is treated as not requiring approval

### Requirement: Approvals carried by the prompt are resolved before the first model step
If the prompt contains an approval response for a request whose tool call has no result yet, the run SHALL resolve it before calling the model: an approved call executes its handler; a denied call receives a failed result stating the denial reason. These results SHALL be emitted as step 0, SHALL be appended to the prompt, and SHALL NOT count against the step limit.

#### Scenario: Approved on resume
- **WHEN** the prompt holds a `send-email` call, its approval request and an approving response
- **THEN** the email handler runs once, its result is emitted as step 0, and the model is then called with the tool result in the prompt

#### Scenario: Denied on resume
- **WHEN** the prompt holds a denied approval response with reason "no"
- **THEN** no handler runs and the model receives a failed tool result whose content names the reason "no"

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

### Requirement: Step limit
The run SHALL enforce the agent's step limit on model steps. When the limit is reached and the model still requests tool calls, the run SHALL fail with a step-limit error and SHALL NOT call the model again.

#### Scenario: Model keeps calling tools
- **WHEN** the step limit is 2 and the model requests tool calls on both steps
- **THEN** the run ends with a failed event whose code is `StepLimitExceeded`, after two model calls

### Requirement: Step entries
Each step-finished event SHALL carry the thread entries the step produced: one assistant entry whose id is the step's message id and whose message holds the text, tool calls and approval requests of the step, and one tool entry per tool result whose id is that result's message id. Step 0 SHALL carry tool entries only.

#### Scenario: Entries for a tool step
- **WHEN** step 1 produces text, one tool call and its result
- **THEN** its step-finished event carries two entries: the assistant entry (id = step message id) and the tool entry (id = the tool result's message id)

### Requirement: Replayed work is marked
Events derived from a checkpoint that was replayed rather than executed SHALL be marked as replayed. A replayed model step SHALL emit no model part events.

#### Scenario: Second execution of a completed step
- **WHEN** a run is executed again and step 1 is served from the checkpoint store
- **THEN** step 1's step-started, tool-result and step-finished events are marked replayed and no model part events are emitted for it

### Requirement: Identifiers are minted inside checkpoints
Message ids and approval ids SHALL be generated through the id generator service, inside the checkpoint that owns them, so a replayed step reproduces the same ids and a re-executed step receives new ones. Tool call ids SHALL pass through unchanged.

#### Scenario: Deterministic ids under a counter generator
- **WHEN** the run uses a counting id generator
- **THEN** step and tool-result message ids are exactly the generator's outputs, in order

#### Scenario: Ids survive replay
- **WHEN** a completed step is replayed from the checkpoint store
- **THEN** its step-finished entries carry the same ids as in the original execution

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
