# thread-store Specification

## Purpose
Holds the committed, server-owned history of a thread as an ordered list of identified model messages, so runs can be projected from it, extend it step by step, and callers can read or rewrite it outside any run.
## Requirements
### Requirement: Entries are identified model messages
A thread entry SHALL consist of a string id and one model message (system, user, assistant or tool, including tool calls, tool results, approval requests and approval responses). Entries SHALL be JSON-encodable so a store can persist them.

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
After a run that claimed its thread finishes, is interrupted for approval, or fails, the store SHALL be notified once per terminal outcome with the thread id, run id and outcome kind, before the run's claim is released, so a caller can hook compaction or bookkeeping there. A run that never claimed the thread SHALL NOT be notified.

#### Scenario: Notification after success
- **WHEN** a run on thread "t1" finishes successfully
- **THEN** the store receives a run-ended notification for "t1" with that run id and the success outcome, after the run's last commit

#### Scenario: Notification after a failure before the model is called
- **WHEN** a run fails with `HistoryMismatch` before the model is called
- **THEN** the store receives one run-ended notification with the failed outcome and code `HistoryMismatch`

#### Scenario: Cancelled run
- **WHEN** a request-scoped run is cancelled because its consumer stopped
- **THEN** the store receives no run-ended notification for that run

#### Scenario: Run rejected before claiming
- **WHEN** a run fails with `ThreadBusy` or `RunInputMismatch`
- **THEN** the store receives no run-ended notification for that run

### Requirement: The store owns compaction
The projection of a thread into a model prompt SHALL be the agent's system prompt followed by the loaded entries' messages verbatim, in order. The library SHALL NOT summarise, drop or reorder entries; a caller compacts by rewriting what the store returns. The only exception: a tool result or approval response whose tool call is in the projection MAY be moved to directly after the assistant message holding that call, because providers require a call's result to follow it. Because a run also reconciles the client's history and `resume` entries against the loaded entries, a compacted thread SHALL keep the latest entries the client has seen, with their ids, and every assistant entry holding an approval request that has no response yet.

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

### Requirement: In-memory implementation
The package SHALL provide an in-memory store that keeps entries per thread for the lifetime of the process and satisfies every requirement above.

#### Scenario: Two runs on one thread
- **WHEN** two consecutive runs on the same thread are served with the in-memory store
- **THEN** the second run's model prompt contains the first run's user, assistant and tool messages

### Requirement: A thread has at most one active run
The store SHALL let a run claim a thread and release its claim. Claiming SHALL succeed when the thread has no active run or when the claiming run already is the active run, and SHALL fail with `ThreadBusy`, naming the active run, when another run is active. Releasing SHALL end the claim only if the releasing run is the active run. A store shared by several processes SHALL make claiming atomic.

#### Scenario: Second run on a busy thread
- **WHEN** run "r1" has claimed thread "t1" and run "r2" claims "t1"
- **THEN** the claim fails with `ThreadBusy` naming "r1"

#### Scenario: A resumed run claims again
- **WHEN** run "r1" has claimed thread "t1" and claims it again
- **THEN** the claim succeeds

#### Scenario: Only the active run releases
- **WHEN** run "r2" releases thread "t1" while "r1" holds it, and then "r1" releases it
- **THEN** "t1" stays claimed by "r1" after the first release and is free after the second

#### Scenario: Threads are independent
- **WHEN** run "r1" holds thread "t1"
- **THEN** a run can claim thread "t2"

