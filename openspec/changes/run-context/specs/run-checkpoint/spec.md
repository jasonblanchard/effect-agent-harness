## MODIFIED Requirements

### Requirement: A named step executes once per run
Memoising an effect under a thread id, a run id and a step name SHALL execute the effect the first time and store its completed exit (success or failure) encoded with the supplied success and error schemas. A later memoisation with the same thread id, run id and name SHALL NOT execute the effect; it SHALL return the stored success, marked as replayed, or re-fail with the stored error. The thread id is part of the key because the client chooses the run id, so a run id is only unique within its thread.

#### Scenario: Second call is served from the store
- **WHEN** an effect that increments a counter is memoised twice under the same thread id, run id and name
- **THEN** the counter is 1, the first result is not marked replayed and the second result is marked replayed with the same value

#### Scenario: Stored failure is replayed
- **WHEN** an effect that fails with a typed error is memoised, then memoised again
- **THEN** the second call fails with an equal error without executing the effect

#### Scenario: Different runs do not share
- **WHEN** the same name is memoised under two different run ids
- **THEN** the effect executes once per run id

#### Scenario: Different threads do not share a run id
- **WHEN** the same run id and name are memoised under two different thread ids
- **THEN** the effect executes once per thread id, and memoising again under the first thread id replays its result

### Requirement: Caller-supplied ledger implementation
The package SHALL provide an implementation backed by a ledger interface with two operations, get and set, keyed by thread id, run id and step name and holding the encoded exit, so a caller can use any store. An in-memory ledger SHALL be provided for tests.

#### Scenario: Custom ledger
- **WHEN** a caller supplies a ledger backed by a map
- **THEN** memoised steps are stored in and replayed from that map
