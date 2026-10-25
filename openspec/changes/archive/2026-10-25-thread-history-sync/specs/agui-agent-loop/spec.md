## MODIFIED Requirements

### Requirement: Client messages are ingested as a delta
A client message SHALL be known to the store when a stored entry has its id, or when it is a `tool` message and a stored tool result has its `toolCallId`. Every other client message SHALL be ignored for matching. The agent SHALL treat as new only the client messages after the last known client message; when the store is empty, every client message is new. From the delta it SHALL accept `user` messages with text (as user entries keyed by the client's message id) and, only when configured to allow them, `system`/`developer` messages; every other role in the delta SHALL be dropped. The accepted entries SHALL be committed before the model is called.

#### Scenario: Full history resent by the client
- **WHEN** the client sends the stored history plus one new user message
- **THEN** only the new user message is committed and appended to the prompt

#### Scenario: Client sends assistant turns
- **WHEN** the delta contains an assistant message
- **THEN** it is neither committed nor sent to the model

#### Scenario: First run on a thread
- **WHEN** the store is empty and the client sends one user message
- **THEN** that message is committed and the model receives it after the system prompt

#### Scenario: Tool message with a client-chosen id
- **WHEN** the client's history carries a stored tool result under the id `tool-<toolCallId>` instead of the stored id, followed by a new user message
- **THEN** the tool message is matched by its `toolCallId`, and only the new user message is committed

#### Scenario: Leftover text from a cancelled step
- **WHEN** the client's history holds an assistant message from a step that was cancelled before it committed, followed by the later stored turns and a new user message
- **THEN** the leftover message is ignored, and only the new user message is committed

#### Scenario: Tool result placed earlier by the client
- **WHEN** the store holds an assistant tool call, a user message, then the call's result, and the client sends the tool result before the user message, followed by a new user message
- **THEN** only the new user message is committed

## ADDED Requirements

### Requirement: Divergent history is rejected
When the client's history has a known message, the agent SHALL find the stored entry matched by the last known client message, and SHALL check every stored entry after it that a read of the thread would show as a message (user, assistant with text or tool calls, tool result). Entries committed by the run itself SHALL NOT be checked, because a run executed again after a crash meets the steps its earlier attempt committed. If any checked entry is not matched by some client message, the agent SHALL NOT commit anything and SHALL NOT call the model, and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryDiverged`. The store SHALL be told the run ended, as for any failure after the claim.

#### Scenario: Edited earlier turn
- **WHEN** the store holds five messages m1 to m5 and the client sends m1 followed by a new user message m2' in place of m2
- **THEN** the run emits `RUN_STARTED` then `RUN_ERROR` with code `HistoryDiverged`, nothing is committed and the model is not called

#### Scenario: Regenerate
- **WHEN** the store ends with a user message and the assistant reply to it, and the client resends the history without that reply
- **THEN** the run ends with `RUN_ERROR` with code `HistoryDiverged`

#### Scenario: Server-only entries after the anchor
- **WHEN** the store ends with an assistant approval request followed by its approval response, and the client's history ends with that assistant message
- **THEN** the run is not rejected for divergence

#### Scenario: Compaction summary
- **WHEN** the store returns a summary system entry the client has never seen followed by the latest entries the client has seen, and the client resends its full history with a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Run executed again after a crash
- **WHEN** an attempt of run "r1" commits its first step and crashes, and "r1" is executed again with the same input
- **THEN** the run is not rejected for divergence, and completes without repeating the committed step

#### Scenario: Run-ended notification
- **WHEN** a run fails with `HistoryDiverged`
- **THEN** the store receives one run-ended notification with the failed outcome and code `HistoryDiverged`
