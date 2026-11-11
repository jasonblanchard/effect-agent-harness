## MODIFIED Requirements

### Requirement: Behaviour is defined once as a value
An agent definition SHALL consist of a tool set, an optional system prompt, a step limit (a positive integer, default 10) and an optional name. The definition SHALL NOT reference any model provider, thread store, checkpoint store or event log. The name SHALL identify the agent in telemetry only; it SHALL NOT be sent to the model or change the events a run emits. The system prompt SHALL be either fixed text or computed for each run, reading the current run and services the definition declares; those services SHALL be part of what the definition requires to run. The same definition SHALL be runnable under different sets of provided services without modification.

#### Scenario: Same definition, two environments
- **WHEN** one agent definition is run against a scripted model with passthrough checkpoints and again with a ledger-backed checkpoint store
- **THEN** the model receives identical prompts in both runs

#### Scenario: Invalid step limit
- **WHEN** an agent is defined with a step limit of 0 or a non-integer
- **THEN** definition fails with a range error

#### Scenario: Same definition, different service values
- **WHEN** an agent whose system prompt includes the name from a user directory service is run once with a directory returning "Ada" and once with one returning "Grace"
- **THEN** the first run's system prompt names Ada, the second's names Grace, and the definition is unchanged

#### Scenario: Name does not reach the model
- **WHEN** the same definition is run once with the name `assistant` and once without a name
- **THEN** the model receives identical prompts and the runs emit identical events
