## MODIFIED Requirements

### Requirement: Cancellation when the consumer stops
For the request-scoped runner, when the consumer of a run's event stream stops reading before the terminal event (for example, because a client disconnects or calls `abortRun()`), the run SHALL be cancelled. Any model request or tool execution still in progress SHALL be stopped, as for any cancelled run. The run SHALL then end as cancelled even though no consumer reads its remaining events: it SHALL commit its cancelled step and notify the store, and release its claim under the server history. The consumer's stream SHALL finish closing only once the run has ended, or once a time limit (`cancelTimeout`, 30 seconds by default) has passed. A run still going then SHALL be interrupted, and its claim released without a run-ended notification, so a hung store or handler cannot hold the request, or a shutdown, for ever. The detached runner SHALL NOT be affected by any consumer stopping.

#### Scenario: Consumer takes only the first events
- **WHEN** a consumer of the request-scoped runner reads the first three events and then stops while the model is still streaming
- **THEN** the model stream is interrupted

#### Scenario: Disconnect records the partial turn
- **WHEN** a request-scoped run under the server history has streamed "Hel" and its consumer stops
- **THEN** the thread holds an assistant entry "Hel" under the step's message id, the store is notified with the cancelled outcome, and the thread is free

#### Scenario: A cancelled run that doesn't end in time
- **WHEN** a request-scoped run's consumer stops, and committing the run's partial step hangs
- **THEN** after `cancelTimeout` the run is interrupted, the thread is released, and the consumer's stream finishes closing

#### Scenario: Subscriber of a detached run disconnects
- **WHEN** a subscriber to a detached run's event log stops reading while the model is still streaming
- **THEN** the run continues and its remaining events are appended to the log
