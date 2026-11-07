## MODIFIED Requirements

### Requirement: Reading a thread as AG-UI messages
The package SHALL provide a read of a thread's loaded entries that returns AG-UI messages in commit order, with each tool message moved to directly after the assistant message holding its tool call. A user entry SHALL become a `user` message with the entry's id and text. An assistant entry SHALL become an `assistant` message with the entry's id, the concatenation of its text as `content`, and every tool call it holds as `toolCalls` (each with the call's id, tool name and JSON-encoded arguments). Each reasoning block with text in an assistant entry SHALL become a `reasoning` message with the `messageId` and the full text its events carried, placed before that entry's `assistant` message, in the order the blocks were produced. A tool entry holding a tool result SHALL become a `tool` message with the entry's id, the call's id as `toolCallId`, and the result as `content`, encoded exactly as the run's `TOOL_CALL_RESULT` event encoded it. System entries, approval-response entries, reasoning blocks with no text, and assistant entries with no text, tool calls or reasoning text SHALL NOT appear. An assistant entry holding only reasoning SHALL yield its `reasoning` messages and no `assistant` message. Provider metadata on a reasoning block SHALL NOT appear. The returned type SHALL be the AG-UI message type, with no narrowing to any consumer's message shape. The read SHALL NOT require a run, an agent or a claim on the thread.

#### Scenario: Thread with a tool call
- **WHEN** a thread holds a user message, an assistant message with text and one tool call, the tool's result, and a final assistant reply
- **THEN** the read returns four messages in that order, and each message's id and the tool message's `toolCallId` equal the ids the run's events used for them

#### Scenario: Same content as the event stream
- **WHEN** a run streams an assistant message in two text segments and a tool result `{"temp":21}`
- **THEN** the read of the thread afterwards gives that assistant message the two segments' text joined as `content`, and the tool message the same `content` string as the `TOOL_CALL_RESULT` event

#### Scenario: Result committed after a later message
- **WHEN** a thread holds an assistant tool call, then a user message, then the call's result
- **THEN** the read returns the assistant message, then the tool message, then the user message

#### Scenario: Server-only entries are hidden
- **WHEN** a thread holds a summary system entry, a user message, an assistant approval request, and the approval response for it
- **THEN** the read returns the user message and the assistant message only

#### Scenario: Unknown thread
- **WHEN** a thread with no entries is read
- **THEN** the read returns no messages and no open interrupts

#### Scenario: Reasoning matches the event stream
- **WHEN** a run streams a reasoning block in two deltas, then text
- **THEN** the read returns a `reasoning` message with the `messageId` of that block's events and the two deltas joined as `content`, followed by the assistant message

#### Scenario: Several reasoning blocks
- **WHEN** a step streams two reasoning blocks and a tool call
- **THEN** the read returns two `reasoning` messages in order under their events' ids, then the assistant message, then the tool message

#### Scenario: Reasoning with no text
- **WHEN** a step's first reasoning block has no text and its second block has text
- **THEN** the read returns one `reasoning` message, under the same `messageId` the second block's events used

#### Scenario: Entry holding only reasoning
- **WHEN** a stored assistant entry holds a reasoning block and neither text nor tool calls
- **THEN** the read returns the `reasoning` message and no `assistant` message for that entry

#### Scenario: Provider signature
- **WHEN** a stored reasoning block has a provider signature in its options
- **THEN** the `reasoning` message returned for it has no `encryptedValue` and no provider metadata

### Requirement: A read history is accepted as the client's history
A client that sends back the read's messages, with or without new user messages appended, and with or without their `reasoning` messages, SHALL be matched against the store without `HistoryMismatch` or `HistoryDiverged`, as long as the thread has not changed since the read. `reasoning` messages a client sends SHALL NOT be committed.

#### Scenario: Reload then continue
- **WHEN** a client reads a thread of two completed turns and starts a run with those messages plus a new user message
- **THEN** only the new user message is committed, and the model receives both earlier turns followed by it

#### Scenario: Reload with reasoning
- **WHEN** a client reads a thread whose assistant turn has reasoning and starts a run with those messages, `reasoning` messages included, plus a new user message
- **THEN** only the new user message is committed, and the model receives the stored assistant turn with its reasoning and provider metadata intact

#### Scenario: Reload without reasoning
- **WHEN** a client reads that thread, removes the `reasoning` messages, and starts a run with the rest plus a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Thread ending in reasoning
- **WHEN** a client reads a thread whose last entry holds only reasoning, and starts a run with those messages plus a new user message
- **THEN** the run is not rejected, and only the new user message is committed
