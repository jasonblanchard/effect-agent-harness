## ADDED Requirements

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
