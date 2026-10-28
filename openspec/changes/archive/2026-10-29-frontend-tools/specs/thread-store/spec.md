## MODIFIED Requirements

### Requirement: The store owns compaction
The projection of a thread into a model prompt SHALL be the agent's system prompt followed by the loaded entries' messages verbatim, in order. The library SHALL NOT summarise, drop or reorder entries; a caller compacts by rewriting what the store returns. The only exception: a tool result or approval response whose tool call is in the projection MAY be moved to directly after the assistant message holding that call, because providers require a call's result to follow it. Because a run also reconciles the client's history, `resume` entries and answers to frontend calls against the loaded entries, a compacted thread SHALL keep the latest entries the client has seen, with their ids, every assistant entry holding an approval request that has no response yet, and every assistant entry holding a frontend tool call that has no result yet, with its record that the call belongs to the client. An entry the store writes in place of others SHALL be a system entry, or SHALL come before the latest entry the client has seen; a user, assistant or tool entry the client has never seen, placed after it, makes the client's next run fail with `HistoryDiverged`.

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

#### Scenario: Pending frontend call dropped by compaction
- **WHEN** a store compacts away the assistant entry holding a pending frontend call, and the client then answers that call
- **THEN** the client's tool message is dropped, because no stored call is pending for it
