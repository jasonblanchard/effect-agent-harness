# agent-run Specification

## Purpose
Runs an agent's defined behaviour (system prompt, tools, step limit) from its AG-UI input and a model prompt to the run's stream of AG-UI events, independent of any transport and of any durability mechanism, so the same behaviour can run in production and in an eval.
## Requirements

### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt, an optional volatile system prompt, a step limit (a positive integer, default 10), an optional name, optional subagents, and the options that apply when it runs as a subagent (see the agent-subagents capability). The definition SHALL NOT reference any model provider, thread store, checkpoint store or event log. The name SHALL identify the agent in telemetry. An agent's name SHALL NOT be sent to its own model or change the events its own run emits; when the agent is a subagent, its name is also the tool name its parent's model calls and its name in the parent's events. The system prompt SHALL be either fixed text or computed for each run, reading the current run and services the definition declares. The volatile system prompt SHALL be either fixed text or computed for each run from the prompt the run was given, reading the current run and services the definition declares, and its computation MAY produce no text. The services either prompt reads SHALL be part of what the definition requires to run, and so SHALL the services its subagents require. The same definition SHALL be runnable under different sets of provided services without modification.

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

#### Scenario: No subagents, no change
- **WHEN** an agent is defined without subagents
- **THEN** its runs emit the same events and entries as before subagents existed

#### Scenario: No volatile system prompt, no change
- **WHEN** an agent is defined without a volatile system prompt and run without a model prompt function
- **THEN** its runs send the same prompts and emit the same events and entries as before volatile system prompts existed

### Requirement: Run from a prompt to step events
Given the run's AG-UI input, a prompt and an optional cancel signal, the run SHALL produce a stream of AG-UI events that never fails. Every element of the stream SHALL be an AG-UI event that `effect/ai`'s AG-UI event schema accepts, and the stream SHALL hold no other kind of element. The sequence SHALL follow the agui-agent-loop capability: the run's own `RUN_STARTED` first, its steps, messages, tool calls, results, activity and subagent events, then exactly one terminal event, with nothing after it.

The prompt is the conversation the model sees. It SHALL NOT contain the agent's system prompt, which the run adds. The run SHALL take its conversation from the prompt only, never from the input's `messages`: under the server history, `messages` holds only what the client sent.

The run SHALL take from the AG-UI input:
- its run id and thread id;
- its properties, from `forwardedProps`;
- the frontend tools the client advertised, from `tools`.

Elsewhere in this specification:
- the current run means the run's AG-UI input;
- step-started and step-finished mean `STEP_STARTED` and `STEP_FINISHED`;
- a tool-result event means `TOOL_CALL_RESULT`;
- finished means `RUN_FINISHED` with its outcome: success, interrupted (AG-UI's `interrupt`) or cancelled;
- failed means `RUN_ERROR` with the error's message and code.

#### Scenario: Text-only reply
- **WHEN** the model replies with text and finish reason `stop`
- **THEN** the events are `RUN_STARTED`, `STEP_STARTED` `step-1`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` events in order, `TEXT_MESSAGE_END`, `STEP_FINISHED` `step-1`, then `RUN_FINISHED` with outcome `success`, and the sequence passes the AG-UI client's checks

#### Scenario: Model failure
- **WHEN** the model stream emits an error part during step 1
- **THEN** the stream closes the text, reasoning and tool-call spans step 1 opened, leaves `step-1` itself without a `STEP_FINISHED`, and ends with one `RUN_ERROR` whose code is `ModelStreamError`, and no event follows it

#### Scenario: Eval reads the outcome
- **WHEN** an eval runs an agent directly whose model calls `send-email`, which requires approval
- **THEN** the eval reads the last event as `RUN_FINISHED` with outcome `interrupt` naming that call, without any projection step

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
When a tool call targets a tool that requires approval (statically or by evaluating its approval predicate with the decoded parameters), the run SHALL NOT execute the handler. It SHALL record the request, with a new approval id, on the step's assistant message, and SHALL finish the run with the interrupted outcome, holding one interrupt per pending approval as the agui-agent-loop capability specifies. Other tool calls in the same step SHALL still execute.

#### Scenario: Approval required
- **WHEN** the model calls `send-email` (requires approval) and `get-weather` in one step
- **THEN** the weather handler runs, the email handler does not, no tool-result event is emitted for the email call, and the run finishes with the interrupted outcome holding one interrupt for the email call, with no further model call

#### Scenario: Approval predicate throws
- **WHEN** a tool's approval predicate fails while evaluating
- **THEN** the tool is treated as not requiring approval

### Requirement: Approvals carried by the prompt are resolved before the first model step
Before calling the model, the run SHALL resolve, as step 0:
- every approval response in the prompt for a request whose tool call has no result yet: an approved call executes its handler, and a denied call receives a failed result stating the denial reason;
- every suspended subagent call in the prompt that has no result yet, by re-entering the child (see the agent-subagents capability).

These SHALL be resolved concurrently. Their results SHALL be emitted as step 0, SHALL be appended to the prompt, and SHALL NOT count against the step limit. If any of them is waiting for approval again, the run SHALL finish with the interrupted outcome after step 0 and SHALL NOT call the model.

#### Scenario: Approved on resume
- **WHEN** the prompt holds a `send-email` call, its approval request and an approving response
- **THEN** the email handler runs once, its result is emitted as step 0, and the model is then called with the tool result in the prompt

#### Scenario: Denied on resume
- **WHEN** the prompt holds a denied approval response with reason "no"
- **THEN** no handler runs and the model receives a failed tool result whose content names the reason "no"

#### Scenario: Suspended subagent on resume
- **WHEN** the prompt holds a suspended `researcher` call and the child's approval was approved
- **THEN** the child is re-entered in step 0, the call's result is emitted as step 0, and the model is then called with it in the prompt

### Requirement: The model never receives approval parts
Before each model call the run SHALL remove approval request and approval response parts from the prompt and drop any message left empty. It SHALL also remove the record that a tool call belongs to the client, and the record that a tool call is a suspended subagent call, so that no provider receives them.

#### Scenario: Prompt after an approval round trip
- **WHEN** the model is called after step 0 resolved an approval
- **THEN** the prompt it receives contains the tool call and its result but no approval request or response parts

#### Scenario: Prompt after a frontend call was answered
- **WHEN** the model is called on a thread holding an answered frontend tool call
- **THEN** the prompt it receives contains the tool call and its result, and nothing marking the call as the client's

#### Scenario: Prompt after a subagent was resumed
- **WHEN** the model is called after step 0 resumed a suspended `researcher` call
- **THEN** the prompt it receives contains the call and its result, and nothing marking the call as suspended

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
Before it emits a step's step-finished, the run SHALL hand that step's thread entries to its step-finished hook. The hook is the package's internal link between a run and whatever runs it: a runner installs one that passes the entries to the run's history, and a parent run installs one for each subagent it runs. An application SHALL NOT be able to provide one, and a run started without one SHALL discard the entries and emit the same events.

The entries SHALL be: one assistant entry whose id is the step's message id and whose message holds the text, tool calls, approval requests and suspended subagent calls of the step; then the entries of every child the step ran, each owned by its child; then one tool entry per tool result, whose id is that result's message id. For step 0, the run SHALL hand over only the entries of the children it re-entered and the tool entries. A step served from the checkpoint store SHALL hand over its entries again, with the same ids, because an earlier attempt may have stopped before committing them. If the hook fails, the run SHALL end with a failed event carrying the failure's code, and SHALL run no further step.

#### Scenario: Entries for a tool step
- **WHEN** a run under the server history, in step 1, produces text, one tool call and its result
- **THEN** the thread store receives one commit for step 1, before `STEP_FINISHED` `step-1` is emitted, holding two entries: the assistant entry (id = step message id) and the tool entry (id = the tool result's message id)

#### Scenario: Entries for a subagent step
- **WHEN** a run under the server history, in step 1, calls `researcher` and the child replies in one step
- **THEN** the thread store's commit for step 1 holds the parent's assistant entry, the child's assistant entry owned by the child, then the parent's tool entry for the call

#### Scenario: Run without a runner
- **WHEN** an eval runs an agent directly, with no runner
- **THEN** the run emits the same events as the same run under a runner with the server history

#### Scenario: Commit fails
- **WHEN** a run under the server history fails to commit step 1 with code `ThreadError`
- **THEN** the run ends with `RUN_ERROR` whose code is `ThreadError`, and the model is not called for step 2

#### Scenario: Replayed step commits again
- **WHEN** a run under the server history is executed again and step 1 is served from the checkpoint store
- **THEN** the thread store receives step 1's commit again, with the ids of the first execution, and stores no duplicate

### Requirement: Replayed work is marked
The run SHALL emit no event for work served from the checkpoint store, with these exceptions, because an earlier attempt may have checkpointed them without publishing them:
- the tool-result event of a tool call served from the store;
- a subagent's events that its own run marked, forwarded with their marker;
- for a child that replayed something and emitted no unmarked event: its `SUBAGENT_STARTED` and its closing event (`SUBAGENT_FINISHED` or `SUBAGENT_ERROR`).

The run SHALL emit each exception with `metadata["effect-agent-harness"]` set to `{ "replayed": true }`. No other event SHALL carry that marker. A replayed model step SHALL emit no step, message, reasoning or tool-call events.

#### Scenario: Second execution of a completed step
- **WHEN** a run is executed again and step 1, which called `get-weather`, is served from the checkpoint store
- **THEN** no `STEP_STARTED`, `STEP_FINISHED`, text or tool-call event is emitted for step 1, and the call's `TOOL_CALL_RESULT` is emitted once with `metadata["effect-agent-harness"]` `{ "replayed": true }`

#### Scenario: A replayed child's lifecycle is marked
- **WHEN** a run is executed again and a subagent call's child replays every step from the checkpoint store
- **THEN** the child's `SUBAGENT_STARTED`, its replayed `TOOL_CALL_RESULT`s and its closing event each carry `metadata["effect-agent-harness"]` `{ "replayed": true }`

#### Scenario: Executed work is not marked
- **WHEN** a run executes every step itself
- **THEN** no event carries the `effect-agent-harness` metadata key

### Requirement: Identifiers are minted inside checkpoints
Message ids and approval ids SHALL be generated through the id generator service, inside the checkpoint that owns them, so a replayed step reproduces the same ids and a re-executed step receives new ones. Tool call ids SHALL pass through unchanged.

#### Scenario: Deterministic ids under a counter generator
- **WHEN** the run uses a counting id generator
- **THEN** step and tool-result message ids are exactly the generator's outputs, in order

#### Scenario: Ids survive replay
- **WHEN** a completed step is replayed from the checkpoint store
- **THEN** the entries it hands to the step-finished hook carry the same ids as in the original execution

### Requirement: The current run is available to the system prompt and tool handlers
While it computes the system prompt and the volatile system prompt, evaluates approval predicates and executes each tool handler, the run SHALL make its AG-UI input available, exactly as the run was given it, as `effect/ai`'s AG-UI run input service, the one `effect/ai`'s own AG-UI agent provides. A tool SHALL be able to read it by declaring that service as a dependency, so a tool written for `effect/ai`'s agent runs unchanged. Running an agent SHALL NOT require the caller to provide that service. Every field of the input comes from the client and SHALL be treated as untrusted. Trusted per-run data, such as the verified principal, SHALL reach the agent as services it requires, never through the input.

#### Scenario: Tool handler reads the context
- **WHEN** a run is given an input with run id "r1", thread id "t1", `forwardedProps` `{ locale: "fr" }` and `state` `{ cart: 2 }`, and the model calls a tool whose handler reads the run input service
- **THEN** the handler sees that input, with run id "r1", thread id "t1", `forwardedProps` `{ locale: "fr" }` and `state` `{ cart: 2 }`

#### Scenario: Eval supplies the run info
- **WHEN** an eval runs an agent directly with a literal AG-UI input and mock services, without a runner
- **THEN** the system prompt and tool handlers see that literal input

#### Scenario: Nothing extra to provide
- **WHEN** an agent with a tool that reads the run input service is run with only the model, the tool handlers and a checkpoint store provided
- **THEN** the run proceeds without a missing-service error

#### Scenario: Messages are the client's, not the conversation
- **WHEN** a run under the server history is given an input whose `messages` hold only the client's new user message, while its prompt holds the whole stored thread
- **THEN** the model receives the whole thread, and a tool reading the run input service sees only the client's message in `messages`

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
Every model call in a run SHALL offer the agent's own tools together with the run's frontend tools, each frontend tool with the name, description and parameter schema the client gave. A run with no frontend tools SHALL offer exactly the agent's own tools. When a frontend tool has the same name as one of the agent's tools or subagents, the run SHALL end with a failed event whose code is `FrontendToolConflict`, naming the tool, without calling the model or running any tool.

#### Scenario: Advertised tool offered
- **WHEN** a run's frontend tools include `pick-file` with a description and a JSON Schema for its parameters
- **THEN** every model call in the run offers `pick-file` with that description and schema, alongside the agent's tools

#### Scenario: Name clash with a server tool
- **WHEN** a run's frontend tools include `get-weather`, which is also one of the agent's tools
- **THEN** the run emits `RUN_STARTED` then `RUN_ERROR` with code `FrontendToolConflict`, and the model is not called

#### Scenario: Name clash under a runner stores nothing
- **WHEN** a runner under the server history and a durable checkpoint store receives a run whose frontend tools include `get-weather`, then the same run id with the tool renamed
- **THEN** the first run ends with `RUN_ERROR` `FrontendToolConflict` before the thread is claimed or the input is memoised, and the second run succeeds

### Requirement: Frontend tool calls are left pending
When the model calls a frontend tool in a step that finishes with reason `tool-calls` or `stop`, the run SHALL NOT produce a result for the call and SHALL emit no tool-result event for it. It SHALL record on the step's assistant message that the call belongs to the client. Other tool calls in the same step SHALL execute or request approval as they would without the frontend call.

#### Scenario: Frontend call on its own
- **WHEN** the model calls `pick-file`, a frontend tool, and finishes with reason `tool-calls`
- **THEN** no tool-result event is emitted for the call, the step's committed entries hold the assistant message with the call and no result for it, and the model is not called again

#### Scenario: Frontend call next to a server call
- **WHEN** the model calls `pick-file` (frontend) and `get-weather` (server) in one step
- **THEN** the weather handler runs and its result is emitted, the frontend call gets no result, and the run finishes without another model call

#### Scenario: Replayed step
- **WHEN** a run that left a frontend call pending is executed again with the same run id against a durable checkpoint
- **THEN** the replayed step leaves the same call pending and the run finishes with the same outcome

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
When a step is cancelled, the run SHALL hand to the step-finished hook, before the step's step-finished, entries for what the step produced, under the step's assistant message id:
- the assistant text streamed so far, and the reasoning blocks that ended (an unended block is left out, because it may lack the signature a provider requires to replay it);
- every tool call whose input was complete;
- for each such call, its result if its handler completed, or a failed result naming "cancelled" otherwise.

A tool call whose input was not complete SHALL be left out, and so SHALL a provider-executed call whose result had not arrived, because the run does not answer those. A step that produced nothing SHALL hand over no entries. A cancelled subagent call SHALL get the failed "cancelled" result. The child's own partial entries SHALL be tagged with its subagent id, as for any child step.

#### Scenario: Partial text is kept
- **WHEN** the signal fires after the model has streamed "Hel" in step 1
- **THEN** step 1's committed entries hold one assistant entry, under step 1's message id, with the text "Hel"

#### Scenario: Complete calls get results
- **WHEN** step 1's model streamed two complete weather calls, the handler for the first completed, and the signal fires during the second
- **THEN** step 1's committed entries hold the assistant entry with both calls, the first call's real result, and a failed result naming "cancelled" for the second

#### Scenario: Incomplete call is dropped
- **WHEN** the signal fires while the model is streaming a weather call's arguments
- **THEN** step 1's committed entries hold no tool call

#### Scenario: Child cancelled with its parent
- **WHEN** the signal fires while the `researcher` subagent's model is streaming "Look"
- **THEN** the child closes with `SUBAGENT_ERROR` code `Cancelled`, its entry "Look" is tagged with its subagent id, the spawning call gets a failed result naming "cancelled", and the parent ends with the cancelled outcome

### Requirement: Preliminary tool results are emitted as progress
When a tool handler reports a preliminary result while it executes, the run SHALL emit an `ACTIVITY_SNAPSHOT` for it, as the agui-agent-loop capability specifies, with the preliminary value encoded with the tool's success schema. A call's snapshots SHALL be emitted in the order the handler reported them, and before that call's tool-result event. Their `messageId` SHALL be derived from the step's assistant message id and the tool call id, or from the approval id and the tool call id for an approved call executed in step 0, whose call an earlier run made, so a call executed again reports under the same id. Preliminary values SHALL NOT be sent to the model, SHALL NOT appear in step entries, and SHALL NOT be stored in the checkpoint store. A call served from the checkpoint store SHALL emit no snapshot. The call's final result SHALL be the same as without preliminary results.

#### Scenario: Progress during a call
- **WHEN** a handler reports preliminary values `{"done":1,"of":2}` and `{"done":2,"of":2}` and then returns `{"hits":3}`
- **THEN** the run emits two `ACTIVITY_SNAPSHOT` events with those values as `content`, in that order and under one `messageId`, followed by one `TOOL_CALL_RESULT` with `{"hits":3}`

#### Scenario: Progress is not part of the transcript
- **WHEN** a handler reports a preliminary value and then returns a result
- **THEN** the step's committed entries hold only the final result for that call, and the next model step's prompt contains no preliminary value

#### Scenario: Replayed call emits no progress
- **WHEN** a run is executed again and a tool call that reported progress in the earlier attempt is served from the checkpoint store
- **THEN** no `ACTIVITY_SNAPSHOT` is emitted for that call

#### Scenario: Re-executed call reports progress again
- **WHEN** a run is executed again after an interruption during a tool call that had reported progress, so the handler runs again
- **THEN** the progress the handler reports this time is emitted again, under the same `messageId` as before

#### Scenario: Approved call reports progress
- **WHEN** a call approved in an earlier run reports a preliminary value while it executes in step 0
- **THEN** the run emits an `ACTIVITY_SNAPSHOT` for it, outside any step

#### Scenario: Call fails after progress
- **WHEN** a handler reports a preliminary value and then fails
- **THEN** the `ACTIVITY_SNAPSHOT` is emitted, and the call's `TOOL_CALL_RESULT` carries the failure as it would without the preliminary value

### Requirement: The run applies the volatile system prompt last
The run SHALL send the agent's volatile system prompt as the last message of every model call, as a system message after the conversation so far (the given prompt, the results of approvals it carried, and every earlier step of the run). Every model call of a run SHALL receive the same volatile text. An agent without a volatile system prompt, or whose volatile system prompt produced no text or empty text, SHALL send no such message.

#### Scenario: Fixed volatile system prompt
- **WHEN** an agent with the system prompt "Be helpful." and the volatile system prompt "Today is Monday." is run with a prompt holding one user message
- **THEN** the model call receives the system message "Be helpful.", then the user message, then the system message "Today is Monday."

#### Scenario: Several steps
- **WHEN** a run with a volatile system prompt takes two model steps, the first calling a tool
- **THEN** the second model call receives the user message, the first step's assistant message and its tool result, then the volatile system message, which appears only once

#### Scenario: Computed from the given prompt
- **WHEN** an agent's volatile system prompt is computed from the last user message of the prompt the run was given, and the run is given a prompt whose last user message is "weather in Paris"
- **THEN** the volatile text the model receives is the one computed for "weather in Paris"

#### Scenario: No text
- **WHEN** an agent's volatile system prompt computes no text
- **THEN** every model call receives the system prompt and the conversation only

### Requirement: A volatile system prompt is resolved once per run
A computed volatile system prompt SHALL be resolved once per run, after the system prompt and before the first model call and before approvals carried by the prompt are resolved, from the prompt the run was given. It SHALL be memoised under the thread id and run id, so a run executed again after an interruption uses the same text even if the services it reads now return different values. If resolving it fails, the run SHALL end with a failed event without calling the model or running any tool.

#### Scenario: Resolved once
- **WHEN** a run with a computed volatile system prompt takes two model steps
- **THEN** the volatile system prompt is resolved once and both model calls receive the same text

#### Scenario: Re-executed run
- **WHEN** a run with a ledger-backed checkpoint store resolves its volatile system prompt from a clock service, is interrupted during step 1, and is executed again after the clock has moved on
- **THEN** the model calls in the second execution receive the volatile text resolved in the first

#### Scenario: Resolution dies
- **WHEN** resolving the volatile system prompt dies with a defect
- **THEN** the run ends with one failed event, the model is not called and no tool handler runs

### Requirement: The volatile system prompt is never stored or emitted
The volatile text SHALL reach only the run's model calls. It SHALL NOT be part of any step's entries, any event the run emits, the thread a server history commits, or a history restored from it. A later run on the same thread SHALL send its own volatile text and not an earlier run's.

#### Scenario: Not in the entries
- **WHEN** a run with the volatile system prompt "Today is Monday." finishes after one step
- **THEN** no committed entry and no emitted event holds the text "Today is Monday."

#### Scenario: Next run
- **WHEN** a thread's first run sends the volatile text "Today is Monday.", and its second run, under the server history, resolves "Today is Tuesday."
- **THEN** the second run's model calls hold "Today is Tuesday." as their last message and nowhere hold "Today is Monday."

### Requirement: A caller can adjust each model call's prompt
The run SHALL let its caller provide, as an optional service, a model prompt function. The run SHALL call it for every model call it executes, with the prompt exactly as the run built it (the agent's system prompt, the conversation so far, then the volatile system message) and a layout giving the index of the conversation's first message, the index just after its last message, the step number and the agent's name, and the model SHALL receive the prompt it returns. Without one, the model SHALL receive the prompt as built. What the function returns SHALL reach only that model call: it SHALL NOT be part of any step's entries, any event the run emits, the thread, any memoised value, or the prompt a subagent is built from, and the next model call SHALL be built from the conversation, not from an earlier result. A model step served from the checkpoint store SHALL NOT call it. A subagent's model calls SHALL use the same function, with the subagent's name in the layout. If the function throws, the run SHALL end with a failed event.

#### Scenario: Marking the end of the conversation
- **WHEN** a run of an agent with a system prompt and a volatile system prompt, given one user message, is provided a function that adds `{ anthropic: { cacheControl: { type: "ephemeral" } } }` to the message just before the layout's conversation end
- **THEN** the model call receives the system message, the user message carrying those options, then the volatile message, and the layout's conversation spans index 1 to 2

#### Scenario: The mark is not carried forward
- **WHEN** such a run takes two model steps, the first calling a tool
- **THEN** in the second model call only the tool result message carries the added options, the user message carries only its own options, and no committed entry or emitted event carries them

#### Scenario: Layout without a system prompt or volatile text
- **WHEN** an agent with neither a system prompt nor a volatile system prompt is run with a prompt of three messages and a model prompt function
- **THEN** the layout's conversation spans index 0 to 3

#### Scenario: No function
- **WHEN** a run is provided no model prompt function
- **THEN** every model call receives the prompt as the run built it

#### Scenario: Replayed step
- **WHEN** a run with a ledger-backed checkpoint store is interrupted during step 2 and executed again with a model prompt function that counts its calls
- **THEN** in the second execution the function is called for step 2 only

#### Scenario: Subagents
- **WHEN** an agent with a subagent named `researcher` is run with a model prompt function, and its model calls the subagent
- **THEN** the function is called for the subagent's model calls with `researcher` as the layout's agent name, and the parent's results never reach the subagent's prompt

#### Scenario: Function throws
- **WHEN** the model prompt function throws
- **THEN** the run ends with one failed event
