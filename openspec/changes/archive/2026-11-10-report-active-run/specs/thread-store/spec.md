## ADDED Requirements

### Requirement: Reading a thread's active run
The store SHALL report which run holds a thread's claim, or no run when the thread has none. The read SHALL NOT change the claim. A store that lets claims expire SHALL report no run once the claim has expired. Reading a thread that has never been claimed SHALL report no run.

#### Scenario: Claimed thread
- **WHEN** run "r1" has claimed thread "t1" and the active run of "t1" is read
- **THEN** the read reports "r1", and a claim by "r2" still fails with `ThreadBusy` naming "r1"

#### Scenario: Released thread
- **WHEN** run "r1" has claimed and released thread "t1" and the active run of "t1" is read
- **THEN** the read reports no run

#### Scenario: Unknown thread
- **WHEN** the active run of a thread that was never claimed is read
- **THEN** the read reports no run, and a later claim on that thread succeeds

#### Scenario: Threads are independent
- **WHEN** run "r1" holds thread "t1" and the active run of "t2" is read
- **THEN** the read reports no run
