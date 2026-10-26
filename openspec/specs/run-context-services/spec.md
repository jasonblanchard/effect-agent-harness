# run-context-services Specification

## Purpose

Lets the caller who starts a run declare which services each run needs from it, such as its trusted context, provide them for each run, and turn it into the services an agent requires, resolved again for every run attempt.

## Requirements

### Requirement: Declaring a run context
The package SHALL let a caller declare a run context: a service key, plus a schema for the service's value. The declared run context SHALL be usable as a service whose value is the schema's decoded type. Every runner SHALL accept a layer that builds per-run services. A detached runner SHALL also accept a list of per-run dependencies, each any service key, which that layer may require; a workflow runner SHALL accept only run contexts as its dependencies, so it can persist them. A request-scoped run SHALL accept no such list: whatever its layer and its agent require that the caller has not provided stays a requirement of the stream.

#### Scenario: Service built from a run context
- **WHEN** a runner declares a run context "app/Auth" with schema `{ userId: string }` and a layer that builds a `CurrentUser` service from it, and the agent's tool requires `CurrentUser`
- **THEN** a run provided with the "app/Auth" service `{ userId: "u1" }` executes the tool with the `CurrentUser` built from `userId: "u1"`

#### Scenario: Services that depend on each other
- **WHEN** the layer builds a `Tenant` service that requires `CurrentUser`, and the agent requires both
- **THEN** each run resolves `CurrentUser` from its own run context and `Tenant` from that `CurrentUser`

#### Scenario: Plain service as a dependency
- **WHEN** a detached runner declares a plain service `Principal` without a schema as its dependency, and a layer that builds `CurrentUser` from it
- **THEN** a run started with `Principal` provided executes the agent's tools with the `CurrentUser` built from it

#### Scenario: Workflow rejects a plain service
- **WHEN** a workflow runner is declared with a plain service without a schema as its dependency
- **THEN** the declaration fails to typecheck

#### Scenario: Runner without run contexts
- **WHEN** a detached or workflow runner declares no dependencies and no layer, or a request-scoped run has no layer
- **THEN** its runs require nothing beyond the agent's services and the stores, and behave as before

### Requirement: Run contexts are provided per run
A detached or workflow runner SHALL leave its declared per-run dependencies, including run contexts, as requirements of each start, rather than capturing them when the runner is built. A request-scoped run SHALL leave them, with everything else it needs, as requirements of its stream. Either way the caller provides them for each run as it would any service. A run whose run-context services are not provided SHALL fail to typecheck. Starting a run SHALL take only the run's input.

#### Scenario: Missing run context rejected at compile time
- **WHEN** a caller consumes a run from a runner declaring "app/Auth" without providing the "app/Auth" service
- **THEN** the program fails to typecheck

#### Scenario: Provided by middleware
- **WHEN** the caller's own context already holds the "app/Auth" service, and it forwards that context to the run
- **THEN** the run's per-run services are built from that service

### Requirement: Services are resolved per run attempt
For every run attempt, before checking the input or claiming the thread, the runner SHALL build the per-run layer from the run-context services the attempt was provided. The services SHALL be resolved again on every attempt, including a re-executed detached run and every replay of a workflow execution. They SHALL NOT be memoised. Steps an earlier attempt completed SHALL still replay from their checkpoints. The built services SHALL live until the attempt ends: their finalizers SHALL run once the attempt's last event has been emitted, or when it fails or is cancelled.

#### Scenario: Resolved again on re-execution
- **WHEN** a detached run is interrupted after step 1 and started again with the same input and run-context services
- **THEN** the layer is built once per attempt, step 1 replays from its checkpoint, and step 2 runs with the services the second attempt built

#### Scenario: Finalizer runs at the end of the attempt
- **WHEN** the layer acquires a resource with a finalizer and the run finishes
- **THEN** the finalizer runs once, after the terminal event

#### Scenario: Finalizer runs on cancellation
- **WHEN** a request-scoped run is cancelled mid-step
- **THEN** the layer's finalizer runs

### Requirement: Layer failures end the run before the claim
If building the per-run layer fails, the run SHALL end with `RUN_STARTED` then `RUN_ERROR` whose `code` is the failure's code. It SHALL NOT claim the thread, memoise its input, commit anything, call the model or run a tool, and the store SHALL NOT be told it ended.

#### Scenario: User lookup fails
- **WHEN** the layer fails with a tagged error `UserNotFound` while building `CurrentUser`
- **THEN** the events are `RUN_STARTED` then `RUN_ERROR` with code `UserNotFound`, the thread is not claimed, and the store receives no run-ended notification

### Requirement: Agents require per-run services as ordinary services
An agent whose system prompt or tools need a per-run service SHALL require it like any other service. A tool SHALL be able to declare such a service as a dependency. Running the agent directly, without a runner, SHALL take the service from whatever the caller provides. A request-scoped run's stream SHALL require the agent's requirements minus the services its layer provides, plus the layer's own requirements. A detached or workflow runner SHALL capture the same, minus its declared dependencies.

#### Scenario: Eval provides the service directly
- **WHEN** an eval runs an agent whose tool depends on `CurrentUser`, providing a literal `CurrentUser`, the model and the tool handlers
- **THEN** the tool sees that `CurrentUser`, and no run context is involved

#### Scenario: Missing service fails to typecheck
- **WHEN** an agent's tool depends on `CurrentUser`, and a runner's layer does not provide it and the caller does not provide it either
- **THEN** consuming the run, or building a detached runner, fails to typecheck
