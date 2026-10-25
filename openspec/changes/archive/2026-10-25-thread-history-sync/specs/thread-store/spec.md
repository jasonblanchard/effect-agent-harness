## MODIFIED Requirements

### Requirement: Entries are identified model messages
A thread entry SHALL consist of a string id, one model message (system, user, assistant or tool, including tool calls, tool results, approval requests and approval responses), and optionally the id of the run that committed it. Entries SHALL be JSON-encodable so a store can persist them.

#### Scenario: Round trip
- **WHEN** an entry holding an assistant message with a tool call is encoded and decoded
- **THEN** the result equals the original entry

#### Scenario: Round trip with a run id
- **WHEN** an entry with run id "r1" is encoded and decoded
- **THEN** the result equals the original entry, run id included

### Requirement: Loading a thread
Loading SHALL return the thread's entries in commit order, each entry the store committed carrying the id of the run whose commit appended it. Entries a store wrote itself, such as a compaction summary, MAY carry no run id. Loading a thread that has never been committed to SHALL return an empty list.

#### Scenario: Unknown thread
- **WHEN** a thread id with no commits is loaded
- **THEN** an empty list is returned

#### Scenario: Run ids on load
- **WHEN** run "r1" commits entries A and B, and run "r2" then commits C
- **THEN** loading returns A and B with run id "r1" and C with run id "r2"

### Requirement: Commits are append-only and idempotent by id
Committing entries SHALL append, in the given order, each entry whose id is not already in the thread, recording the committing run's id on it, and SHALL ignore entries whose id is already present. A commit SHALL identify the run it belongs to.

#### Scenario: Repeated commit
- **WHEN** the same two entries are committed twice for the same thread
- **THEN** loading the thread returns those two entries once, in order

#### Scenario: Partial overlap
- **WHEN** entries A and B are committed, then B and C
- **THEN** loading returns A, B, C

#### Scenario: Recommitted by another run
- **WHEN** run "r1" commits entry A, and run "r2" commits A again
- **THEN** loading returns A once, with run id "r1"

### Requirement: The store owns compaction
The projection of a thread into a model prompt SHALL be the agent's system prompt followed by the loaded entries' messages verbatim, in order. The library SHALL NOT summarise, drop or reorder entries; a caller compacts by rewriting what the store returns. The only exception: a tool result or approval response whose tool call is in the projection MAY be moved to directly after the assistant message holding that call, because providers require a call's result to follow it. Because a run also reconciles the client's history and `resume` entries against the loaded entries, a compacted thread SHALL keep the latest entries the client has seen, with their ids, and every assistant entry holding an approval request that has no response yet. An entry the store writes in place of others SHALL be a system entry, or SHALL come before the latest entry the client has seen; a user, assistant or tool entry the client has never seen, placed after it, makes the client's next run fail with `HistoryDiverged`.

#### Scenario: Caller-compacted thread
- **WHEN** a store returns a single system entry holding a summary followed by the last user entry
- **THEN** the model receives the agent's system prompt, the summary system message and the user message, and nothing else from history

#### Scenario: Compaction drops every id the client knows
- **WHEN** a store returns only a summary entry whose id the client has never seen, and the client resends its history with a new user message
- **THEN** the run fails with `HistoryMismatch` and the model is not called

#### Scenario: Compaction drops a pending approval request
- **WHEN** a store returns a thread without the assistant entry holding an unanswered approval request, and the client sends a `resume` entry for that request
- **THEN** the `resume` entry is ignored and the tool is not executed

#### Scenario: Result stored after a later message
- **WHEN** a store returns an assistant tool call, then a user message, then the tool result for that call
- **THEN** the model receives the tool call, its result, then the user message

#### Scenario: Summary written as a later assistant entry
- **WHEN** a store returns the entries the client has seen followed by a summary written as an assistant entry the client has never seen, and the client resends its history with a new user message
- **THEN** the run fails with `HistoryDiverged` and the model is not called
