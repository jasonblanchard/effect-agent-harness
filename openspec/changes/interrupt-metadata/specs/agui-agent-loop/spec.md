## ADDED Requirements

### Requirement: Caller-supplied interrupt metadata
Whoever builds a runner MAY supply a function that computes `metadata` for each approval interrupt. The function SHALL receive the interrupt as the agent built it (`id`, `reason`, `toolCallId`, `message`, `responseSchema`) together with the run's `threadId` and `runId`. It SHALL return either a metadata object or nothing. When it returns an object, that interrupt SHALL carry it as its `metadata`. When it returns nothing, or no function was supplied, the interrupt SHALL carry no `metadata`. The function SHALL NOT be able to change any other field of the interrupt or of the event. Every runner (request-scoped, detached and workflow-backed) SHALL apply it in the same way. If the function throws, that interrupt SHALL be emitted without `metadata`, a warning SHALL be logged, and the run SHALL still end with `RUN_FINISHED` whose outcome is `interrupt`, listing every pending approval.

#### Scenario: No function supplied
- **WHEN** a runner built without the function ends a run on an approval for "send-email"
- **THEN** the `RUN_FINISHED` interrupt outcome lists one interrupt with `id`, `reason` `tool-approval`, `toolCallId`, `message` and `responseSchema`, and no `metadata`

#### Scenario: Metadata attached per interrupt
- **WHEN** a runner is built with a function that returns `{ "acme:binding": { interruptId, runId } }`, and a run with `runId` "r1" ends on two pending approvals
- **THEN** each interrupt in the outcome carries `metadata` `{ "acme:binding": { interruptId: <its own id>, runId: "r1" } }`, and its other fields are the same as without the function

#### Scenario: Function returns nothing for one interrupt
- **WHEN** the function returns metadata for the first pending approval and nothing for the second
- **THEN** the first interrupt carries the metadata and the second carries no `metadata`

#### Scenario: Function throws
- **WHEN** the function throws for a pending approval
- **THEN** a warning is logged, that interrupt is emitted without `metadata`, and the run still ends with `RUN_FINISHED` whose outcome is `interrupt` listing every pending approval, with no `RUN_ERROR`

#### Scenario: Detached run stores the metadata
- **WHEN** a detached runner built with the function ends a run on an approval, and a client then reads that run from the event log from the beginning
- **THEN** the stored `RUN_FINISHED` event's interrupt carries the same `metadata` as the one emitted live

#### Scenario: Resume is unaffected
- **WHEN** the next run answers an interrupt that carried `metadata`, with `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]`
- **THEN** the approval is recorded exactly as it would be for an interrupt without `metadata`, and any extra fields on the resume entry are ignored
