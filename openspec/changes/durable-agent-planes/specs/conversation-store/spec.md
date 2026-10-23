# Spec Delta

## Purpose

Holds the committed, server-owned conversation of a thread as an ordered list of identified model messages, so runs can be projected from it, extend it step by step, and callers can read or rewrite it outside any run.

## ADDED Requirements

### Requirement: Entries are identified model messages
A conversation entry SHALL consist of a string id and one model message (system, user, assistant or tool, including tool calls, tool results, approval requests and approval responses). Entries SHALL be JSON-encodable so a store can persist them.

#### Scenario: Round trip
- **WHEN** an entry holding an assistant message with a tool call is encoded and decoded
- **THEN** the result equals the original entry

### Requirement: Loading a thread
Loading SHALL return the thread's entries in commit order. Loading a thread that has never been committed to SHALL return an empty list.

#### Scenario: Unknown thread
- **WHEN** a thread id with no commits is loaded
- **THEN** an empty list is returned

### Requirement: Commits are append-only and idempotent by id
Committing entries SHALL append, in the given order, each entry whose id is not already in the thread, and SHALL ignore entries whose id is already present. A commit SHALL identify the run it belongs to.

#### Scenario: Repeated commit
- **WHEN** the same two entries are committed twice for the same thread
- **THEN** loading the thread returns those two entries once, in order

#### Scenario: Partial overlap
- **WHEN** entries A and B are committed, then B and C
- **THEN** loading returns A, B, C

### Requirement: The store is told when a run ends
After a run finishes, is interrupted for approval, or fails, the store SHALL be notified once per terminal outcome with the thread id, run id and outcome kind, so a caller can hook compaction or bookkeeping there.

#### Scenario: Notification after success
- **WHEN** a run on thread "t1" finishes successfully
- **THEN** the store receives a run-ended notification for "t1" with that run id and the success outcome, after the run's last commit

### Requirement: The store owns compaction
The projection of a thread into a model prompt SHALL be the agent's system prompt followed by the loaded entries' messages verbatim, in order. The library SHALL NOT summarise, drop or reorder entries; a caller compacts by rewriting what the store returns.

#### Scenario: Caller-compacted thread
- **WHEN** a store returns a single system entry holding a summary followed by the last user entry
- **THEN** the model receives the agent's system prompt, the summary system message and the user message, and nothing else from history

### Requirement: In-memory implementation
The package SHALL provide an in-memory store that keeps entries per thread for the lifetime of the process and satisfies every requirement above.

#### Scenario: Two runs on one thread
- **WHEN** two consecutive runs on the same thread are served with the in-memory store
- **THEN** the second run's model prompt contains the first run's user, assistant and tool messages
