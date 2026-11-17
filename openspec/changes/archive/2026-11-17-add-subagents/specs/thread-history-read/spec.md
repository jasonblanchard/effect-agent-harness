## MODIFIED Requirements

### Requirement: Reading a thread as AG-UI messages
The package SHALL provide a read of a thread's loaded entries that returns AG-UI messages in commit order, with each tool message moved to directly after the assistant message holding its tool call. A user entry SHALL become a `user` message with the entry's id and text. An assistant entry SHALL become an `assistant` message with the entry's id, the concatenation of its text as `content`, and every tool call it holds as `toolCalls` (each with the call's id, tool name and JSON-encoded arguments). Each reasoning block with text in an assistant entry SHALL become a `reasoning` message with the `messageId` and the full text its events carried, placed before that entry's `assistant` message, in the order the blocks were produced. A tool entry holding a tool result SHALL become a `tool` message with the entry's id, the call's id as `toolCallId`, and the result as `content`, encoded exactly as the run's `TOOL_CALL_RESULT` event encoded it; a failed result SHALL also carry its error as `error` (the result itself when it is a string, otherwise its JSON encoding). This is the one place the read shows more than the events did: `TOOL_CALL_RESULT` has no field for a failure, while AG-UI's tool message has `error` for it, so a client that reads the thread back learns which results failed and sends them back as failures. System entries, approval-response entries, reasoning blocks with no text, and assistant entries with no text, tool calls or reasoning text SHALL NOT appear. An assistant entry holding only reasoning SHALL yield its `reasoning` messages and no `assistant` message. Provider metadata on a reasoning block SHALL NOT appear. Every message from an entry owned by a subagent SHALL carry that subagent's id as `subagentRunId`. The messages of a subagent SHALL come after the assistant message holding the call that spawned it and before that call's tool message. The returned type SHALL be the AG-UI message type, with no narrowing to any consumer's message shape. The read SHALL NOT require a run, an agent or a claim on the thread.

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

#### Scenario: Failed result
- **WHEN** a thread holds a tool call whose result is the failure "Out of range", and the thread is then read
- **THEN** the call's tool message has `content` `"Out of range"` encoded as JSON and `error` "Out of range", and a run started with the read's messages accepts them

#### Scenario: Thread with a subagent
- **WHEN** a run's parent calls `researcher`, whose child calls a tool and replies, and the thread is then read
- **THEN** the read returns the parent's assistant message with the call, the child's assistant, tool and assistant messages each carrying the child's `subagentRunId` and the ids their events used, then the call's tool message

### Requirement: Open interrupts are returned with their run
The read SHALL also return every approval request in the thread that has no response yet, each as the same AG-UI interrupt (`id`, `reason`, `toolCallId`, `message`, `responseSchema`, and `subagentRunId` for a subagent's request) that the run's `RUN_FINISHED` interrupt outcome carried, together with the id of the run that committed the requests. When no request is open, the read SHALL return no interrupts. When the store did not record the committing run, the interrupts SHALL be returned without a run id.

#### Scenario: Run interrupted for approval
- **WHEN** run "r1" ends with `RUN_FINISHED` with an interrupt outcome for a `send-email` call, and the thread is then read
- **THEN** the read returns that same interrupt, with run id "r1", and the assistant message holding the call

#### Scenario: Restored interrupt can be answered
- **WHEN** a client reads an interrupted thread, then starts a run with the read's messages and a `resume` entry approving the returned interrupt id
- **THEN** the run executes the tool and does not fail with `UnansweredInterrupt` or `HistoryMismatch`

#### Scenario: Answered approval
- **WHEN** the approval request in a thread has a response
- **THEN** the read returns no interrupts

#### Scenario: Suspended child
- **WHEN** run "r1" ends interrupted because a child of the agent waits for a `send-email` approval, and the thread is then read
- **THEN** the read returns that interrupt carrying the child's `subagentRunId`, with run id "r1", and answering it in a run started with the read's messages resumes the child
