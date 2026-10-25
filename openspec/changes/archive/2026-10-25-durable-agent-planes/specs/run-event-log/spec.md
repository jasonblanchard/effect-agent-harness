# Spec Delta

## Purpose

Stores the AG-UI events of a run under increasing cursors and serves them as history plus live tail, so a client can observe a run that outlives its request and reconnect from where it left off.

## ADDED Requirements

### Requirement: Appending assigns increasing cursors
Appending an event to a run SHALL store it and return it with a cursor that is strictly greater than every cursor previously assigned to that run. Cursors are opaque strings.

#### Scenario: Three appends
- **WHEN** three events are appended to one run
- **THEN** reading the run returns them in append order with three distinct, increasing cursors

### Requirement: Reading history after a cursor
Reading a run SHALL return its stored events in order. Given a cursor, it SHALL return only events stored after that cursor. Reading an unknown run SHALL return an empty list.

#### Scenario: Read after the second event
- **WHEN** a run holds events with cursors c1, c2, c3 and is read after c2
- **THEN** only the event at c3 is returned

### Requirement: Subscribing yields history then live events
Subscribing to a run SHALL yield the stored events after the given cursor (or all of them), then every event appended afterwards, each exactly once and in order, and SHALL complete after yielding a terminal event (`RUN_FINISHED` or `RUN_ERROR`). Subscribing to a run with no events SHALL wait for them.

#### Scenario: Reconnect mid-run
- **WHEN** a client subscribes after cursor c2 while the run is still appending
- **THEN** it receives the events after c2, then each later event once, and the subscription completes after `RUN_FINISHED`

#### Scenario: Subscribe to a completed run
- **WHEN** a client subscribes to a run whose last event is `RUN_ERROR`
- **THEN** it receives the stored events and the subscription completes

#### Scenario: Subscribe before the run starts
- **WHEN** a client subscribes to a run id with no events and events are appended later
- **THEN** it receives those events as they are appended

### Requirement: In-memory implementation
The package SHALL provide an in-memory log that keeps each run's events for the lifetime of the process and satisfies every requirement above.

#### Scenario: Two subscribers
- **WHEN** two clients subscribe to the same in-memory run from the start
- **THEN** both receive the full, identical event sequence
