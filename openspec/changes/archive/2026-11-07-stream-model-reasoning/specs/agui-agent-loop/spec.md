## ADDED Requirements

### Requirement: Streamed model reasoning
The agent SHALL stream each reasoning block a model step produces as it is produced: `REASONING_START`, `REASONING_MESSAGE_START` with role `reasoning`, one `REASONING_MESSAGE_CONTENT` per non-empty delta in the order produced, `REASONING_MESSAGE_END` and `REASONING_END`, all with the block's `messageId`. A block the model delivers whole SHALL be emitted the same way, with one content event. A block with no text SHALL emit no events. Provider metadata on a reasoning block, such as a signature, SHALL NOT appear in any event. Replayed steps SHALL emit no reasoning events.

#### Scenario: Reasoning before a reply
- **WHEN** the model produces a reasoning block with the deltas "Let", " me think", then the text "Hi"
- **THEN** the step emits `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT` "Let", `REASONING_MESSAGE_CONTENT` " me think", `REASONING_MESSAGE_END`, `REASONING_END`, then the text message, and the sequence passes the AG-UI client's checks

#### Scenario: Block delivered whole
- **WHEN** the model produces one complete reasoning part "Done thinking"
- **THEN** the step emits the five reasoning events with one `REASONING_MESSAGE_CONTENT` "Done thinking"

#### Scenario: Redacted block
- **WHEN** the model produces a reasoning block with no text and a provider signature in its metadata
- **THEN** the step emits no reasoning events for it, and the block is still stored and sent back to the model on the next step

#### Scenario: Replayed step
- **WHEN** a run is executed again and a step with reasoning is replayed from its checkpoint
- **THEN** no reasoning events are emitted for that step

### Requirement: Reasoning is controlled by the model layer
The agent SHALL have no option of its own that enables or disables reasoning. Whether reasoning appears SHALL depend only on whether the configured model produces it. A model that produces no reasoning SHALL yield no reasoning events.

#### Scenario: Model without reasoning
- **WHEN** a run's model produces only text and tool calls
- **THEN** the run's events contain no `REASONING_*` event

## MODIFIED Requirements

### Requirement: Well-formed spans
Every `TEXT_MESSAGE_CONTENT` SHALL fall between a `TEXT_MESSAGE_START` and a `TEXT_MESSAGE_END` with the same `messageId`. Every `TOOL_CALL_ARGS` SHALL fall between a `TOOL_CALL_START` and a `TOOL_CALL_END` with the same `toolCallId`. Every `REASONING_MESSAGE_CONTENT` SHALL fall between a `REASONING_MESSAGE_START` and a `REASONING_MESSAGE_END` with the same `messageId`, inside a `REASONING_START` and `REASONING_END` with that `messageId`. No text message, reasoning message, reasoning span or tool call SHALL be left open when the terminal event is emitted, including when the model stream ends abruptly or the run fails.

#### Scenario: Model stream ends mid-message
- **WHEN** the model stream stops after a text delta without signalling the end of the text
- **THEN** the agent emits `TEXT_MESSAGE_END` for that message before the terminal event

#### Scenario: Failure during tool-call arguments
- **WHEN** the model fails while streaming a tool call's arguments
- **THEN** the agent emits `TOOL_CALL_END` for that tool call before `RUN_ERROR`

#### Scenario: Failure during reasoning
- **WHEN** the model fails after a reasoning delta, before the block ends
- **THEN** the agent emits `REASONING_MESSAGE_END` and `REASONING_END` for that block before `RUN_ERROR`

#### Scenario: Step ends with reasoning open
- **WHEN** a model step finishes after a reasoning delta without signalling the end of the block
- **THEN** the agent emits `REASONING_MESSAGE_END` and `REASONING_END` before `STEP_FINISHED`

### Requirement: Provider-independent message identifiers
The agent SHALL assign its own AG-UI message IDs and SHALL NOT reuse the model provider's text-part or reasoning-part IDs. Each model step SHALL get one new assistant `messageId`, shared by all of that step's text. Each reasoning block SHALL get its own `messageId`, different from the step's assistant `messageId`, and that id SHALL be the same every time the block is read. Each `TOOL_CALL_RESULT` SHALL get a new `messageId`. Message IDs SHALL be unique across steps and across runs.

#### Scenario: Provider reuses part IDs across steps
- **WHEN** the provider labels the text of step 1 and the text of step 2 both with part ID "0"
- **THEN** the two steps' `TEXT_MESSAGE_START` events have different `messageId`s

#### Scenario: Multiple text blocks in one step
- **WHEN** the model emits two separate text blocks within one step
- **THEN** both are emitted with the same `messageId`

#### Scenario: Multiple reasoning blocks in one step
- **WHEN** the model emits two separate reasoning blocks within one step
- **THEN** they are emitted with two different `messageId`s, neither equal to the step's assistant `messageId`

#### Scenario: Deterministic IDs in tests
- **WHEN** the agent is run with a deterministic ID generator
- **THEN** the emitted `messageId`s are exactly the ones that generator produced, or derived only from them

### Requirement: Divergent history is rejected
Under the server history, when the client's history has a known message, the agent SHALL find the stored entry matched by the last known client message. It SHALL then check every stored entry after it that holds a user message, an assistant message with text or tool calls, or a tool result. An assistant entry holding only reasoning SHALL NOT be checked, and reasoning messages SHALL NOT count as known or as missing. Entries committed by the run itself SHALL NOT be checked, because a run executed again after a crash meets the steps its earlier attempt committed. If any checked entry is not matched by some client message, the agent SHALL NOT commit anything, SHALL NOT call the model, and SHALL end the run with `RUN_ERROR` whose `code` is `HistoryDiverged`. The store SHALL be told the run ended, as for any failure after the claim.

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

#### Scenario: Client dropped reasoning
- **WHEN** the store holds an assistant entry with reasoning and text, and the client resends that assistant message without its reasoning rows, plus a new user message
- **THEN** the run is not rejected, and only the new user message is committed

#### Scenario: Entry holding only reasoning
- **WHEN** the store ends with an assistant entry holding only reasoning, and the client's history ends before it
- **THEN** the run is not rejected for divergence
