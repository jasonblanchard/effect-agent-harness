## MODIFIED Requirements

### Requirement: Run from a prompt to step events
Given a run's info, a prompt, the frontend tools the client advertised for the run (none when it advertised none) and an optional cancel signal, the run SHALL produce an event stream that never fails. The run info SHALL consist of a run id, a thread id and optional properties supplied by the client. The prompt SHALL NOT contain the agent's system prompt; the run adds it. Each model step SHALL begin with a step-started event carrying the step number and that step's assistant message id. The stream SHALL end with exactly one terminal event: finished (with an outcome: success, interrupted or cancelled) or failed (with the error's message and code), and SHALL emit nothing after it.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are step-started (step 1), the model parts in order, step-finished (step 1), finished with the success outcome

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream ends with one failed event whose code is `ModelStreamError` and no event follows it

## ADDED Requirements

### Requirement: A run can be cancelled
When a run's cancel signal fires, the run SHALL stop the work in progress: the model stream, or the tool handlers of the current step, including a subagent's run. It SHALL then emit step-finished for the current step if one is open, and end with finished and the cancelled outcome. The run SHALL check the signal before each step. If the signal has already fired, it SHALL end with the cancelled outcome without calling the model, after replaying the steps that completed in an earlier attempt. A tool handler region made uninterruptible SHALL run to completion before the run ends. A call keeps its real result only if its whole execution completed. The cancelled outcome SHALL carry no approvals and no pending frontend calls. A run without a cancel signal SHALL behave as before.

#### Scenario: Cancelled while the model streams
- **WHEN** the signal fires after the model has streamed "Hel" in step 1
- **THEN** the model stream is interrupted, and the events end with step-finished (step 1) then finished with the cancelled outcome

#### Scenario: Cancelled while a tool runs
- **WHEN** the signal fires while the weather handler is running in step 1
- **THEN** the handler is interrupted, no further model call is made, and the run ends with the cancelled outcome

#### Scenario: Uninterruptible region
- **WHEN** a handler runs `send` inside `Effect.uninterruptible` and the signal fires during `send`
- **THEN** `send` completes before the run ends with the cancelled outcome, and the call gets the failed "cancelled" result, because the tool execution after `send` was interrupted

#### Scenario: Already cancelled
- **WHEN** a run starts with a signal that has already fired
- **THEN** the model is not called and the stream is finished with the cancelled outcome

#### Scenario: Pending frontend call is not reported
- **WHEN** the signal fires after the model streamed a complete call to the frontend tool `pick-file`
- **THEN** the cancelled outcome lists no pending frontend calls

### Requirement: A cancelled step keeps what it produced
When a step is cancelled, its step-finished event SHALL carry entries for what the step produced, under the step's assistant message id:
- the assistant text streamed so far, and the reasoning blocks that ended (an unended block is left out, because it may lack the signature a provider requires to replay it);
- every tool call whose input was complete;
- for each such call, its result if its handler completed, or a failed result naming "cancelled" otherwise.

A tool call whose input was not complete SHALL be left out, and so SHALL a provider-executed call whose result had not arrived, because the run does not answer those. A step that produced nothing SHALL carry no entries. A cancelled subagent call SHALL get the failed "cancelled" result. The child's own partial entries SHALL be tagged with its subagent id, as for any child step.

#### Scenario: Partial text is kept
- **WHEN** the signal fires after the model has streamed "Hel" in step 1
- **THEN** step 1's entries hold one assistant entry, under step 1's message id, with the text "Hel"

#### Scenario: Complete calls get results
- **WHEN** step 1's model streamed two complete weather calls, the handler for the first completed, and the signal fires during the second
- **THEN** step 1's entries hold the assistant entry with both calls, the first call's real result, and a failed result naming "cancelled" for the second

#### Scenario: Incomplete call is dropped
- **WHEN** the signal fires while the model is streaming a weather call's arguments
- **THEN** step 1's entries hold no tool call

#### Scenario: Child cancelled with its parent
- **WHEN** the signal fires while the `researcher` subagent's model is streaming "Look"
- **THEN** the child ends with the cancelled outcome, its entry "Look" is tagged with its subagent id, the spawning call gets a failed result naming "cancelled", and the parent ends with the cancelled outcome
