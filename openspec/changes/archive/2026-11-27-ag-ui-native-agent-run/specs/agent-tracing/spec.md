## MODIFIED Requirements

### Requirement: A failed run marks its root span as an error

When a run ends with `RUN_ERROR`, its root span SHALL end with error status and carry `error.type` = the `RUN_ERROR` code, or `Error` when it has none. The span SHALL end with the run's original failure as its exit, wherever the failure arose (the agent's run, the runner, or the store recording the run's end), so an exporter records the original error, with its type, message and stack, as the span's one exception event. The library SHALL NOT add an exception event to the span itself. The failure SHALL be logged once, at error level. A subagent's failure that its parent reports as a failed tool result SHALL end the subagent's span with the child's original failure and SHALL NOT be logged at error level. Even so, the run's event stream SHALL NOT fail.

#### Scenario: Model failure

- **WHEN** the model stream emits an error part and the run ends with `RUN_ERROR` of code `ModelStreamError`
- **THEN** the root span has error status, `error.type` = `ModelStreamError`, and ends with the model's error as its exit, which an exporter records as one exception event; the stream still ends with `RUN_ERROR` rather than failing

#### Scenario: Failure before the agent runs

- **WHEN** a run under the server history fails to load its thread and ends with `RUN_ERROR` of code `ThreadError`
- **THEN** the root span has error status, `error.type` = `ThreadError`, and ends with the store's error as its exit

#### Scenario: A subagent fails and the parent recovers

- **WHEN** a subagent's run fails and its parent reports the failure as a failed tool result and finishes
- **THEN** the subagent's `invoke_agent` span ends with the child's error as its exit, the root span has no error status, and nothing is logged at error level

#### Scenario: Successful run

- **WHEN** a run finishes with any finished outcome, including an interrupt
- **THEN** the root span does not have error status and ends with a successful exit
