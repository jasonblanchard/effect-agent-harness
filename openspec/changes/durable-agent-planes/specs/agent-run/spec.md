# Spec Delta

## Purpose

Runs an agent's defined behaviour (system prompt, tools, step limit) from a model prompt to a stream of step events, independent of AG-UI, of any transport and of any durability mechanism, so the same behaviour can run in production and in an eval.

## ADDED Requirements

### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt and a step limit (a positive integer, default 10), and SHALL NOT reference any model provider, conversation store, checkpoint store or event log. The same definition SHALL be runnable under different sets of provided services without modification.

#### Scenario: Same definition, two environments
- **WHEN** one agent definition is run against a scripted model with passthrough checkpoints and again with a ledger-backed checkpoint store
- **THEN** the model receives identical prompts in both runs

#### Scenario: Invalid step limit
- **WHEN** an agent is defined with a step limit of 0 or a non-integer
- **THEN** definition fails with a range error

### Requirement: Run from a prompt to step events
Given a run id and a prompt, the run SHALL produce an event stream that never fails. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome) or failed (with the error's message and code), and SHALL emit nothing after it.

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
A tool handler SHALL run at most once for a given run id and tool call id, including when the run is executed again after an interruption and the earlier attempt had already completed that tool call.

#### Scenario: Resume after a crash following a tool call
- **WHEN** a run with a ledger-backed checkpoint store completes the `get-weather` call in step 1 and then fails before step 2 completes, and the same run id is executed again against the same ledger
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
Before each model call the run SHALL remove approval request and approval response parts from the prompt and drop any message left empty.

#### Scenario: Prompt after an approval round trip
- **WHEN** the model is called after step 0 resolved an approval
- **THEN** the prompt it receives contains the tool call and its result but no approval request or response parts

### Requirement: Continuation rule
After a step, the run SHALL continue with a new model step only when the finish reason is `tool-calls`, at least one tool call was made, and no approval is pending. When the finish reason is neither `tool-calls` nor `stop`, each tool call in that step SHALL receive a failed result stating the finish reason instead of running its handler, and the run SHALL finish.

#### Scenario: Finish reason length with a tool call
- **WHEN** the model emits a tool call and finishes with reason `length`
- **THEN** the handler does not run, a failed tool result naming the reason is emitted, and the run finishes successfully

### Requirement: Step limit
The run SHALL enforce the agent's step limit on model steps. When the limit is reached and the model still requests tool calls, the run SHALL fail with a step-limit error and SHALL NOT call the model again.

#### Scenario: Model keeps calling tools
- **WHEN** the step limit is 2 and the model requests tool calls on both steps
- **THEN** the run ends with a failed event whose code is `StepLimitExceeded`, after two model calls

### Requirement: Step entries
Each step-finished event SHALL carry the conversation entries the step produced: one assistant entry whose id is the step's message id and whose message holds the text, tool calls and approval requests of the step, and one tool entry per tool result whose id is that result's message id. Step 0 SHALL carry tool entries only.

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
