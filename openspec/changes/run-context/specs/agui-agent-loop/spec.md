# Spec Delta

## MODIFIED Requirements

### Requirement: Thread history from the server store
The agent SHALL keep the history of each `threadId` in the thread store and SHALL rebuild the model prompt on every run from the store, not from the client's full history. The prompt SHALL be: the agent's system prompt as resolved for this run, then the stored entries' messages in order, then the approval responses recorded for this run, then the ingested client delta, with every tool result placed directly after the assistant message holding its tool call. Every tool call sent to the model SHALL have a result: a stored tool call with no result and no approval request SHALL be sent with a failed result.

#### Scenario: Follow-up question uses earlier context
- **WHEN** a second run on the same thread arrives after a first run that made a tool call
- **THEN** the model receives the first run's user message, assistant message with its tool call, tool result, and the new user message, in that order, all taken from the store

#### Scenario: Earlier run stopped before a tool result
- **WHEN** the store holds an assistant tool call with no tool result and no approval request for it
- **THEN** the model receives the tool call followed by a failed result for it, and the run proceeds

#### Scenario: Client system messages dropped by default
- **WHEN** the agent is not configured to allow client system messages and the client delta includes a `system` message
- **THEN** that message is neither committed nor sent to the model, and the agent's system prompt still is

#### Scenario: Unsupported message role
- **WHEN** the client delta includes an `activity` message
- **THEN** the run proceeds and the activity message is neither committed nor sent to the model

#### Scenario: Compacted store
- **WHEN** the store returns a summary system entry and the latest user entry
- **THEN** the model receives the agent's system prompt, the summary and the user message only

#### Scenario: System prompt is not stored
- **WHEN** a run on a new thread finishes
- **THEN** the thread's stored entries do not include the agent's system prompt

### Requirement: Projected prompt is stable across a resumed run
The projection of the thread taken at the start of a run SHALL be memoised under the run id, so a run executed again after an interruption uses the same projection even if the store changed in between. The projection SHALL NOT include the agent's system prompt, which the agent run memoises separately.

#### Scenario: Store compacted between attempts
- **WHEN** a run is re-executed with a ledger-backed checkpoint store after the thread was rewritten
- **THEN** the model prompt for the remaining steps is built from the original projection

## ADDED Requirements

### Requirement: Run info from the AG-UI input and the caller
The agent SHALL run each AG-UI run with run info taken from its input and from the caller: the input's `runId` and `threadId`, the input's `forwardedProps` as the run's properties, unchanged, and as its context the value the caller passed when starting the run, unchanged. Nothing in the AG-UI input SHALL become the run's context. An input without `forwardedProps` SHALL run with no properties, and a run started without a context SHALL run with no context.

#### Scenario: Forwarded properties reach the system prompt
- **WHEN** an agent's system prompt reads the properties of the current run and a run arrives with `forwardedProps: { locale: "fr" }`
- **THEN** the system prompt is computed with properties `{ locale: "fr" }` and with that input's run id and thread id

#### Scenario: No forwarded properties
- **WHEN** a run arrives without `forwardedProps`
- **THEN** the system prompt is computed with no properties

#### Scenario: Caller's context reaches tools
- **WHEN** a caller starts a run with the context `{ userId: "u1" }` and the model calls a tool that reads the current run
- **THEN** the handler sees the context `{ userId: "u1" }`

#### Scenario: The client cannot set the context
- **WHEN** a caller starts a run with the context `{ userId: "u1" }` and the input's `forwardedProps` is `{ context: { userId: "u2" }, userId: "u2" }`
- **THEN** the run's context is `{ userId: "u1" }`, and the client's values appear only in the run's properties
