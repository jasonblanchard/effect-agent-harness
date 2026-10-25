## Purpose

Turns a stored thread into the AG-UI messages its event streams showed, plus its open approval interrupts and the run that raised them, so a client that has lost its state (a reload, a new device) can restore it and continue the thread.

## ADDED Requirements

### Requirement: Reading a thread as AG-UI messages
The package SHALL provide a read of a thread's loaded entries that returns AG-UI messages in commit order, with each tool message moved to directly after the assistant message holding its tool call. A user entry SHALL become a `user` message with the entry's id and text. An assistant entry SHALL become an `assistant` message with the entry's id, the concatenation of its text as `content`, and every tool call it holds as `toolCalls` (each with the call's id, tool name and JSON-encoded arguments). A tool entry holding a tool result SHALL become a `tool` message with the entry's id, the call's id as `toolCallId`, and the result as `content`, encoded exactly as the run's `TOOL_CALL_RESULT` event encoded it. System entries, approval-response entries, reasoning, and assistant entries with neither text nor tool calls SHALL NOT appear. The read SHALL NOT require a run, an agent or a claim on the thread.

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

### Requirement: Open interrupts are returned with their run
The read SHALL also return every approval request in the thread that has no response yet, each as the same AG-UI interrupt (`id`, `reason`, `toolCallId`, `message`, `responseSchema`) that the run's `RUN_FINISHED` interrupt outcome carried, together with the id of the run that committed the requests. When no request is open, the read SHALL return no interrupts. When the store did not record the committing run, the interrupts SHALL be returned without a run id.

#### Scenario: Run interrupted for approval
- **WHEN** run "r1" ends with `RUN_FINISHED` with an interrupt outcome for a `send-email` call, and the thread is then read
- **THEN** the read returns that same interrupt, with run id "r1", and the assistant message holding the call

#### Scenario: Restored interrupt can be answered
- **WHEN** a client reads an interrupted thread, then starts a run with the read's messages and a `resume` entry approving the returned interrupt id
- **THEN** the run executes the tool and does not fail with `UnansweredInterrupt` or `HistoryMismatch`

#### Scenario: Answered approval
- **WHEN** the approval request in a thread has a response
- **THEN** the read returns no interrupts

### Requirement: A read history is accepted as the client's history
A client that sends back the read's messages, with or without new user messages appended, SHALL be matched against the store without `HistoryMismatch` or `HistoryDiverged`, as long as the thread has not changed since the read.

#### Scenario: Reload then continue
- **WHEN** a client reads a thread of two completed turns and starts a run with those messages plus a new user message
- **THEN** only the new user message is committed, and the model receives both earlier turns followed by it
