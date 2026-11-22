## MODIFIED Requirements

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

## ADDED Requirements

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
