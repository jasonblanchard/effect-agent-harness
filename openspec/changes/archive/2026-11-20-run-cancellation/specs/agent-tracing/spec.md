## ADDED Requirements

### Requirement: A cancelled run is not an error
When a run ends with the cancelled outcome, its root span SHALL end without error status and SHALL NOT carry `error.type`. A tool span whose handler was interrupted by the cancellation SHALL end as interrupted, as it does when a request is cancelled.

#### Scenario: Cancelled while the model streams
- **WHEN** a run is cancelled while the model streams
- **THEN** the root span ends without error status and has no `error.type`
