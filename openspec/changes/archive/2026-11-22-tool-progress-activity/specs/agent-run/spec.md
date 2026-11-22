## ADDED Requirements

### Requirement: Preliminary tool results are emitted as progress
When a tool handler reports a preliminary result while it executes, the run SHALL emit a tool-progress event. The event SHALL carry the step number, the assistant message id of the step that made the call (none for an approved call executed in step 0, whose call an earlier run made), the tool call id, the tool name, and the preliminary value encoded with the tool's success schema. Progress events for a call SHALL be emitted in the order the handler reported them, and before that call's tool-result event. A tool-progress event SHALL NOT be marked replayed. Preliminary values SHALL NOT be sent to the model, SHALL NOT appear in step entries, and SHALL NOT be stored in the checkpoint store. A call served from the checkpoint store SHALL emit no progress. The call's final result SHALL be the same as without preliminary results.

#### Scenario: Progress during a call
- **WHEN** a handler reports preliminary values `{"done":1,"of":2}` and `{"done":2,"of":2}` and then returns `{"hits":3}`
- **THEN** the run emits two tool-progress events with those encoded values, in that order, each carrying the call's tool call id, the tool name and the step's assistant message id, followed by one tool-result event with `{"hits":3}`

#### Scenario: Progress is not part of the transcript
- **WHEN** a handler reports a preliminary value and then returns a result
- **THEN** the step's entries hold only the final result for that call, and the next model step's prompt contains no preliminary value

#### Scenario: Replayed call emits no progress
- **WHEN** a run is executed again and a tool call that reported progress in the earlier attempt is served from the checkpoint store
- **THEN** no tool-progress event is emitted for that call

#### Scenario: Re-executed call reports progress again
- **WHEN** a run is executed again after an interruption during a tool call that had reported progress, so the handler runs again
- **THEN** the progress the handler reports this time is emitted again, with the same step assistant message id as before

#### Scenario: Approved call reports progress
- **WHEN** a call approved in an earlier run reports a preliminary value while it executes in step 0
- **THEN** the run emits a tool-progress event for step 0 that carries no step assistant message id

#### Scenario: Call fails after progress
- **WHEN** a handler reports a preliminary value and then fails
- **THEN** the tool-progress event is emitted, and the call's tool-result event carries the failure as it would without the preliminary value
