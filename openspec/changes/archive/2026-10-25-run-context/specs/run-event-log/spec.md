## ADDED Requirements

### Requirement: Runs are keyed by thread id and run id
Every operation of the event log SHALL identify a run by its thread id and its run id together. Two runs with the same run id on different threads SHALL have separate logs and separate cursors, so a caller that authorises access to a thread authorises access to its runs' events.

#### Scenario: Same run id on two threads
- **WHEN** events are appended to run "r1" on thread "t1", and then one event to run "r1" on thread "t2"
- **THEN** reading "r1" on "t2" returns only its own event, with the first cursor, and reading "r1" on "t1" still returns its events
