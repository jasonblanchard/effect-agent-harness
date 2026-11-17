## Purpose

Lets an agent delegate part of a run to other agents: declaring subagents, offering them to the parent's model as tools, running each call as a child agent inside the parent's run, and suspending and resuming a child that waits for approval.

## ADDED Requirements

### Requirement: Subagents are declared as agent definitions
An agent definition SHALL accept a subagents setting holding a list of agents, each an agent definition. A subagent's name SHALL be the tool name the parent's model calls, the subagent's name in the events, and its name in telemetry. An agent definition SHALL accept a description, an optional input schema, a context mode (`brief` by default, or `conversation`) and an optional conversion from its outcome to the result returned to a parent; these SHALL apply when the agent runs as a subagent. Defining an agent SHALL fail when one of its subagents has no name, has a name that is not 1 to 64 letters, digits, `_` or `-`, or has the same name as one of the agent's tools or another of its subagents. The services a child requires SHALL be part of what the parent definition requires.

#### Scenario: Name clash with a tool
- **WHEN** an agent with a `get-weather` tool is defined with a subagent named `get-weather`
- **THEN** definition fails

#### Scenario: Name clash between subagents
- **WHEN** an agent is defined with two subagents both named `researcher`
- **THEN** definition fails

#### Scenario: Unnamed subagent
- **WHEN** an agent is defined with a subagent that has no name
- **THEN** definition fails

#### Scenario: Name that is not a tool name
- **WHEN** an agent is defined with a subagent named `Research Assistant`
- **THEN** definition fails

#### Scenario: Free-form name at the top level
- **WHEN** an agent named `Research Assistant` is defined and run on its own
- **THEN** definition succeeds and the run proceeds

#### Scenario: Child services required by the parent
- **WHEN** a child's tool handler requires a search service and the parent is run without one
- **THEN** the parent definition does not type-check as runnable

### Requirement: Subagents are offered to the model as tools
Each subagent SHALL be offered to the parent's model as a tool with the subagent's name and description. Its parameters SHALL be the input schema when given, and otherwise an object with one required string field `prompt`. Subagents SHALL NOT be offered to the child agents themselves unless a child declares its own. A child SHALL NOT be offered the frontend tools the client advertised.

#### Scenario: Default input
- **WHEN** an agent with a subagent `researcher` and no input schema is run
- **THEN** the model is offered a `researcher` tool whose parameters require a `prompt` string

#### Scenario: Frontend tools stay with the parent
- **WHEN** the client advertises `pick-file` and the parent calls `researcher`
- **THEN** the parent's model is offered `pick-file` and the child's model is not

### Requirement: A subagent call runs the child inside the parent's run
A call to a subagent tool in a step that finishes with reason `tool-calls` or `stop` SHALL run the child agent with the parent's thread id, run id, run properties and services, and with the child's own system prompt, tools and step limit. The child SHALL have an id determined by the spawning tool call's id alone. The child's model steps and tool calls SHALL be checkpointed under names that cannot collide with the parent's or another child's, so a run executed again replays the child's completed work and never repeats its tool handlers. Several subagent calls in one step SHALL run concurrently, like other tool calls.

#### Scenario: Child replayed after a crash
- **WHEN** a run with a ledger-backed checkpoint store crashes after the child's first tool call completed, and the same run id is executed again
- **THEN** the child's tool handler has run exactly once in total, and the child's id is the same in both attempts

#### Scenario: Two calls, two ids
- **WHEN** the parent calls `researcher` twice in one step
- **THEN** both children run, each with a different id, and neither replays the other's steps

#### Scenario: Same call, same id
- **WHEN** two runs on different threads each call `researcher` with the same tool call id
- **THEN** both children have the same id

### Requirement: The child's prompt
The child's prompt SHALL begin with its brief: a user message holding the call's `prompt` field when the subagent has no input schema, and otherwise the call's input encoded as JSON. Under the `brief` context mode the prompt SHALL be the brief alone. Under the `conversation` mode it SHALL be the user messages and the assistant text of the prompt the parent's model received for the step that made the call, followed by the brief; it SHALL NOT hold the parent's system prompt, tool calls or tool results. The child's system prompt SHALL be its own.

#### Scenario: Brief only
- **WHEN** the parent's model calls `researcher` with `{ "prompt": "find X" }` under the `brief` mode
- **THEN** the child's model receives the child's system prompt and one user message "find X"

#### Scenario: With the conversation
- **WHEN** the parent's thread holds a user message and the parent calls `researcher` under the `conversation` mode
- **THEN** the child's model receives the child's system prompt, that user message, then the brief, and no unanswered tool call

#### Scenario: Parent tool calls left out
- **WHEN** under the `conversation` mode, the parent's model wrote "Checking." and called `get-weather` in an earlier step, then calls `researcher`
- **THEN** the child's model receives the user message, an assistant message "Checking.", then the brief, and neither the `get-weather` call nor its result

### Requirement: The child's outcome is the call's result
When the child finishes successfully, the spawning call's result SHALL be the child's last assistant text, or the value the subagent's result conversion returns; a returned value that is not JSON SHALL give a failed result instead. When the child fails, including by exceeding its step limit, the call's result SHALL be a failed result holding the error message, and the parent's run SHALL continue to its next model step.

#### Scenario: Child replies
- **WHEN** the child's final step replies "X is 42"
- **THEN** the parent's model receives "X is 42" as the result of the `researcher` call

#### Scenario: Child exceeds its step limit
- **WHEN** the child's step limit is 2 and its model keeps calling tools
- **THEN** the spawning call gets a failed result naming the step limit, and the parent's model is called again

### Requirement: Child entries are carried by the parent step
A child's entries SHALL name the child as their owner. They SHALL be carried by the step-finished event of the parent step that made the call, after that step's assistant entry and before its tool entries. The child's brief SHALL NOT be stored: each time the child runs, its prompt SHALL be rebuilt as the parent prefix (under the `conversation` mode), the brief from the spawning call's input, then the child's own entries. The parent's prompt SHALL NOT contain any entry owned by a child.

#### Scenario: Entries of a step with a subagent call
- **WHEN** parent step 1 calls `researcher`, whose child makes one tool call and then replies
- **THEN** step 1's step-finished event carries the parent's assistant entry, the child's assistant, tool and assistant entries owned by the child, then the parent's tool entry for the call

#### Scenario: Parent prompt
- **WHEN** the parent's model is called in step 2
- **THEN** it receives the `researcher` call and its result, and none of the child's messages

### Requirement: A child waiting for approval suspends the parent
When a child's tool call needs approval, the child SHALL end interrupted. The spawning call SHALL get no result, SHALL be recorded on the parent's assistant entry as a suspended subagent call, and the parent's run SHALL finish with the interrupted outcome listing the child's approvals, each naming its owner, together with any approvals of the parent's own calls. A grandchild's approval SHALL suspend each agent above it in the same way.

#### Scenario: Child needs approval
- **WHEN** the child calls `send-email`, which needs approval
- **THEN** the email handler does not run, the parent finishes interrupted with one approval naming the child as its owner, and the parent's model is not called again

#### Scenario: Parent and child both wait
- **WHEN** in one step the parent calls `send-email` and `researcher`, and the child also calls `send-email`
- **THEN** the parent finishes interrupted with two approvals, one owned by the parent and one by the child

#### Scenario: Grandchild needs approval
- **WHEN** a child calls its own subagent, which calls `send-email`
- **THEN** the parent finishes interrupted with one approval owned by the grandchild

### Requirement: Suspended subagent calls are resumed before the first model step
When the prompt holds a suspended subagent call with no result, the run SHALL re-enter the child before calling the model, as step 0, with the child's own entries as its prompt and the same child id. The child SHALL resolve its approval responses in its own step 0 and continue. Suspended calls and the parent's own decided approvals SHALL be resolved together. If a re-entered child or a resolved call is waiting for approval again, the run SHALL finish interrupted after step 0 without calling the model. Otherwise the results SHALL be appended to the prompt and the model called.

#### Scenario: Approved inside the child
- **WHEN** the run after a suspension carries an approving answer for the child's `send-email` approval
- **THEN** the email handler runs once inside the child, the child continues and replies, the spawning call gets the child's reply as its result in step 0, and the parent's model is called with it

#### Scenario: Denied inside the child
- **WHEN** the answer denies the child's approval with reason "no"
- **THEN** the email handler does not run, the child's model receives a failed result naming "no", and the parent receives the child's reply

#### Scenario: Mixed resume
- **WHEN** the parent and its child were both waiting, and the next run approves both
- **THEN** both email handlers run once, and the parent's model is called once with both calls answered

#### Scenario: Child waits again
- **WHEN** a re-entered child requests another approval
- **THEN** the run finishes interrupted after step 0 with that approval, and the parent's model is not called

#### Scenario: Grandchild resumed
- **WHEN** the run after a grandchild's suspension approves its call
- **THEN** the parent re-enters the child, the child re-enters the grandchild, the call runs once, and each agent continues in turn
