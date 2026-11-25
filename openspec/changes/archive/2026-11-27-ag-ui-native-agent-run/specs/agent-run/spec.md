## MODIFIED Requirements

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

### Requirement: Tools that need approval interrupt the run
When a tool call targets a tool that requires approval (statically or by evaluating its approval predicate with the decoded parameters), the run SHALL NOT execute the handler. It SHALL record the request, with a new approval id, on the step's assistant message, and SHALL finish the run with the interrupted outcome, holding one interrupt per pending approval as the agui-agent-loop capability specifies. Other tool calls in the same step SHALL still execute.

#### Scenario: Approval required
- **WHEN** the model calls `send-email` (requires approval) and `get-weather` in one step
- **THEN** the weather handler runs, the email handler does not, no tool-result event is emitted for the email call, and the run finishes with the interrupted outcome holding one interrupt for the email call, with no further model call

#### Scenario: Approval predicate throws
- **WHEN** a tool's approval predicate fails while evaluating
- **THEN** the tool is treated as not requiring approval

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

## REMOVED Requirements

### Requirement: The outcome lists pending frontend calls
**Reason**: The run's outcome is now AG-UI's `RUN_FINISHED` outcome. It lists pending calls as `pendingToolCallIds` on `success` only, and AG-UI's `interrupt` outcome carries none. Tool names are already in the call's `TOOL_CALL_START`.
**Migration**: See the agui-agent-loop requirement "Frontend tool calls end the run as a success". Read `pendingToolCallIds` from `RUN_FINISHED`, and find a call's name in its `TOOL_CALL_START`.
