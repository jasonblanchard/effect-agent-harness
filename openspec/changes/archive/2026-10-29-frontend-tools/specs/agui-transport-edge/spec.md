## MODIFIED Requirements

### Requirement: Lenient run input decoding
The package SHALL provide a decoder for AG-UI `RunAgentInput` that checks only the fields the agent uses: `threadId`, `runId`, the `messages` fields needed for ingestion, `resume` entries (`interruptId`, `status`, optional `payload`), and `tools` entries (`name`, optional `description`, `parameters`). It SHALL keep an optional `forwardedProps` value of any shape without checking it, and each tool's `parameters` without checking it against JSON Schema. It SHALL accept and ignore any other fields, and it SHALL fail on input whose required fields are missing or malformed, so the caller can reject it before starting a run.

#### Scenario: Extra fields
- **WHEN** the input includes `tools`, `context`, `state`, `forwardedProps` and `protocolVersion`
- **THEN** decoding succeeds and returns only the fields the agent reads, including `tools` and `forwardedProps`

#### Scenario: Missing runId
- **WHEN** the input has no `runId`
- **THEN** decoding fails

#### Scenario: Resume entries
- **WHEN** the input includes `resume: [{ interruptId: "a1", status: "resolved", payload: { approved: true } }]`
- **THEN** decoding succeeds and the entry is available to the run

#### Scenario: Forwarded properties of any shape
- **WHEN** the input's `forwardedProps` is a string, an array or a nested object
- **THEN** decoding succeeds and returns `forwardedProps` unchanged

#### Scenario: Tool without a name
- **WHEN** an entry in `tools` has no `name`
- **THEN** decoding fails

#### Scenario: No tools
- **WHEN** the input has no `tools` field, or an empty one
- **THEN** decoding succeeds and the run has no frontend tools
