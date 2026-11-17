# thread-history-read Specification

## Purpose
Turns a stored thread into the AG-UI messages its event streams showed, plus what the stored thread knows and an event can't carry (a failed result's error), plus its open approval interrupts and the run that raised them, so a client that has lost its state (a reload, a new device) can restore it and continue the thread.
## Requirements
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

### Requirement: Pending frontend calls are returned with their run
The read SHALL also return the ids of every frontend tool call in the thread that has no result yet, in the order the calls were made, together with the id of the run that committed them. When no frontend call is pending, the read SHALL return none. When the store did not record the committing run, the ids SHALL be returned without a run id. The calls themselves SHALL appear in the returned messages as tool calls of their assistant message, with no tool message after them.

#### Scenario: Run left a frontend call pending
- **WHEN** run "r1" ends with `RUN_FINISHED` whose `pendingToolCallIds` holds the `pick-file` call, and the thread is then read
- **THEN** the read returns that call id as pending, with run id "r1", and the assistant message holding the call with no tool message for it

#### Scenario: Answered call
- **WHEN** the next run answered the `pick-file` call, and the thread is then read
- **THEN** the read returns no pending calls, and the call's tool message follows its assistant message

#### Scenario: Restored pending call can be answered
- **WHEN** a client reads a thread with a pending frontend call, then starts a run with the read's messages and a tool message answering that call
- **THEN** the answer is committed, and the run does not fail with `UnansweredToolCall`, `HistoryMismatch` or `HistoryDiverged`

### Requirement: A rejoining read reports the active run
A caller that serves joins from the run's event log SHALL be able to ask the read to rejoin. A rejoining read SHALL return the id of the run holding the thread's claim as the active run, or no active run when the thread has none. A read that does not ask to rejoin SHALL NOT report an active run, and SHALL return the same messages, interrupts and pending calls whether or not a run is active. The active run SHALL be read before the thread is loaded. A rejoining read SHALL NOT require a run, an agent or a claim on the thread.

#### Scenario: Run in flight
- **WHEN** run "r1" holds thread "t1" and a rejoining read of "t1" is made
- **THEN** the read returns active run "r1"

#### Scenario: No run in flight
- **WHEN** no run holds thread "t1" and a rejoining read of "t1" is made
- **THEN** the read returns no active run and the same messages, interrupts and pending calls as a read that does not ask to rejoin

#### Scenario: Read without rejoin during a run
- **WHEN** run "r1" holds thread "t1" and has committed a step, and a read that does not ask to rejoin is made
- **THEN** the read returns no active run and includes the step's messages

#### Scenario: Run ends between the two reads
- **WHEN** a rejoining read observes run "r1" as active, and "r1" commits its last step and releases the thread before the thread is loaded
- **THEN** the read returns active run "r1" and leaves out that run's output, so joining the finished log shows the whole run

### Requirement: A rejoining read leaves out what the active run's log replays
While a run is active, a rejoining read SHALL leave out the assistant entries that run committed and the tool results answering calls those entries hold, so that the returned messages followed by a replay of the run's event log from its start show each message exactly once. It SHALL keep the user messages the active run committed, and the results and approval responses it committed for calls made by earlier runs, because the run's log does not show the client's messages. Open interrupts and pending frontend calls SHALL be computed from the entries that remain.

#### Scenario: Multi-step run
- **WHEN** run "r1" committed a user message and two steps with tool calls and results, still holds the thread, and a rejoining read is made
- **THEN** the read returns the earlier turns and the user message, and none of the two steps' assistant or tool messages

#### Scenario: Replay after the read
- **WHEN** a client applies a rejoining read of a multi-step active run and then replays that run's event log from its start
- **THEN** each step's text and tool calls appear exactly once

#### Scenario: Continuation of an interrupted run
- **WHEN** run "r2" answers an approval raised by "r1", holds the thread, and a rejoining read is made
- **THEN** the read keeps "r1"'s assistant message and returns no open interrupt for it

#### Scenario: Frontend result answered by the active run
- **WHEN** run "r2" committed the client's result for a frontend call made by "r1", holds the thread, and a rejoining read is made
- **THEN** the read keeps the tool message and returns no pending call for it

#### Scenario: Entries with no run id
- **WHEN** a compacted thread holds a store-written entry with no run id and a run is active
- **THEN** the entry is treated as it would be by a read that does not ask to rejoin
