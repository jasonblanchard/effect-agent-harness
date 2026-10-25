# Spec Delta

## Purpose

Memoises the named steps of a run so each executes at most once and a re-executed run replays stored results instead of repeating work, with implementations ranging from a passthrough for tests to a caller-supplied ledger and `effect/workflow` activities.

## ADDED Requirements

### Requirement: A named step executes once per run
Memoising an effect under a run id and a step name SHALL execute the effect the first time and store its completed exit (success or failure) encoded with the supplied success and error schemas. A later memoisation with the same run id and name SHALL NOT execute the effect; it SHALL return the stored success, marked as replayed, or re-fail with the stored error.

#### Scenario: Second call is served from the store
- **WHEN** an effect that increments a counter is memoised twice under the same run id and name
- **THEN** the counter is 1, the first result is not marked replayed and the second result is marked replayed with the same value

#### Scenario: Stored failure is replayed
- **WHEN** an effect that fails with a typed error is memoised, then memoised again
- **THEN** the second call fails with an equal error without executing the effect

#### Scenario: Different runs do not share
- **WHEN** the same name is memoised under two different run ids
- **THEN** the effect executes once per run id

### Requirement: Interrupted work is not recorded
If the memoised effect is interrupted before completing, nothing SHALL be stored, so a later memoisation executes it again.

#### Scenario: Interrupted attempt
- **WHEN** a memoised effect is interrupted mid-execution and then memoised again under the same key
- **THEN** the effect executes a second time

### Requirement: Stored values round-trip through their schemas
The stored exit SHALL be produced by encoding with the supplied schemas and SHALL decode back to an equal value. A store MAY persist the encoded form as JSON.

#### Scenario: Prompt value
- **WHEN** a model prompt is memoised and replayed
- **THEN** the replayed prompt equals the original

### Requirement: Passthrough implementation
The package SHALL provide a passthrough implementation that always executes the effect and never marks a result as replayed, for tests and evals.

#### Scenario: Passthrough
- **WHEN** the same key is memoised twice under the passthrough implementation
- **THEN** the effect executes twice and neither result is marked replayed

### Requirement: Caller-supplied ledger implementation
The package SHALL provide an implementation backed by a ledger interface with two operations, get and set, keyed by run id and step name and holding the encoded exit, so a caller can use any store. An in-memory ledger SHALL be provided for tests.

#### Scenario: Custom ledger
- **WHEN** a caller supplies a ledger backed by a map
- **THEN** memoised steps are stored in and replayed from that map

### Requirement: Workflow implementation
The package SHALL provide an implementation that runs each memoised step as an `effect/workflow` activity named after the step, so a durable workflow engine stores and replays it. It SHALL be usable only inside a workflow execution.

#### Scenario: Inside a workflow with the in-memory engine
- **WHEN** a step is memoised inside a workflow execution backed by the in-memory engine
- **THEN** the step executes once and its value is returned
