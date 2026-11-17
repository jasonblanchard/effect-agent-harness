## MODIFIED Requirements

### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt, a step limit (a positive integer, default 10), an optional name, optional subagents, and the options that apply when it runs as a subagent (see the agent-subagents capability). The definition SHALL NOT reference any model provider, thread store, checkpoint store or event log. The name SHALL identify the agent in telemetry. An agent's name SHALL NOT be sent to its own model or change the events its own run emits; when the agent is a subagent, its name is also the tool name its parent's model calls and its name in the parent's events. The system prompt SHALL be either fixed text or computed for each run, reading the current run and services the definition declares; those services SHALL be part of what the definition requires to run, and so SHALL the services its subagents require. The same definition SHALL be runnable under different sets of provided services without modification.

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

### Requirement: Step entries
Each step-finished event SHALL carry the thread entries the step produced: one assistant entry whose id is the step's message id and whose message holds the text, tool calls, approval requests and suspended subagent calls of the step; then the entries of every child the step ran, each owned by its child; then one tool entry per tool result whose id is that result's message id. Step 0 SHALL carry the entries of the children it re-entered and tool entries only.

#### Scenario: Entries for a tool step
- **WHEN** step 1 produces text, one tool call and its result
- **THEN** its step-finished event carries two entries: the assistant entry (id = step message id) and the tool entry (id = the tool result's message id)

#### Scenario: Entries for a subagent step
- **WHEN** step 1 calls `researcher` and the child replies in one step
- **THEN** its step-finished event carries the parent's assistant entry, the child's assistant entry owned by the child, then the parent's tool entry for the call
