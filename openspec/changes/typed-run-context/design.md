## Context

See proposal.md for why. The current state that shapes the approach:

- **The context is opaque end to end.** `RunOptions.context` is `unknown`. The pipeline copies it into `Agent.RunInfo.context`, which `Agent.CurrentRun` exposes. The workflow payload declares it `Schema.optional(Schema.Unknown)`. The example decodes it again in `currentPrincipal` and calls `orDie`.
- **Runners capture services when they're built.** `make` and `makeDetached` take `Effect.context<Agent.Requirements<Tools, R> | Thread.Thread | …>()` once and provide it to every run. `workflow` returns a layer with those requirements. Nothing per run can reach the agent except `RunInfo`.
- **The input fingerprint ignores the context.** The `input` checkpoint memoises `JSON.stringify` of the encoded AG-UI input only (`Runner.ts`, `pipeline`). `RunInputMismatch` therefore never compares contexts.
- **Re-execution takes the context from the caller.** A detached run doesn't store its context. `makeDetached`'s doc tells callers to pass the same one again. A workflow persists it in the payload, because the engine persists the payload.
- **Failures before the claim aren't reported to the store.** `pipeline` checks the input, then claims, and only `claimed` routes terminal events through `endRun`. Errors before the claim still become `RUN_ERROR` via `failInBand`.
- **Tool dependencies already flow into `Agent.Requirements`.** A tool with `dependencies: [CurrentUser]` adds `CurrentUser` to the agent's requirements, the handler layer builds without it, and a `CurrentUser` provided around `Agent.run` reaches the handler (checked 2026-10-25, see proposal).

## Goals / Non-Goals

**Goals:**

- The route hands the run its trusted context the Effect way, by providing a service, and the compiler checks it did.
- Per-run services are built by an ordinary `Layer`, with Effect's own composition for dependencies between them.
- Agents and evals don't change: an agent requires `CurrentUser` like any other service.

**Non-Goals:**

- Fingerprinting or storing the context outside a workflow's payload (decisions 4 and 5).
- Memoising the services across replays. They are resolved again on every attempt.
- Detecting two RunContexts that share a tag key. Effect's context already treats them as one service.
- Typing `forwardedProps`. It comes from the client and stays `unknown` on `CurrentRun`.

## Decisions

### 1. A RunContext is a tag plus a schema, needed only by workflows

`Runner.RunContext<Self>()(key, { schema })` returns a `Context.Service` class whose service is `Schema.Type` of `schema`, with the schema kept as a static `schema` property. It can't be called `context`: `Context.Service` classes already have a `context(self)` method.

```ts
class AuthContext extends Runner.RunContext<AuthContext>()("app/Auth", {
  schema: Schema.Struct({ userId: Schema.String, name: Schema.String }),
}) {}
```

An ordinary tag means the route provides it with `provideService`, and a per-run layer reads it with `yield* AuthContext`, like any other dependency. Only a workflow needs the schema, to persist the value (decision 3), so only `workflow` requires its dependencies to be RunContexts. The request-scoped and detached runners take any service key; a RunContext works there too, so declaring one up front makes a later move to a workflow free.

Alternatives: a plain schema with a separate tag (two things to keep in step); requiring a RunContext for every runner (one kind of declaration, but a schema nobody reads for request-scoped and detached runs, and an odd error for a plain service under an option named like a tool's `dependencies`). That was the first choice; it was reversed once the option was renamed `dependencies` (decision 2).

### 2. Per-run dependencies are provided through the Effect context

A runner that declares `dependencies: [AuthContext]` leaves those services as requirements on each run, instead of capturing them when it's built. It's the same idea as a tool's `dependencies`, which are required per call instead of when the handler layer is built, so it has the same name:

- `Runner.make`'s function returns `Stream<AgUi.Event, never, AuthContext>`;
- `Runner.run`'s stream requires them alongside everything else;
- `makeDetached`'s `start` returns `Effect<void, never, AuthContext>`.

The route provides them: `runAgent(input).pipe(Stream.provideService(AuthContext, principal))`, or `Stream.provideContext(yield* Effect.context<AuthContext>())` to forward what auth middleware provided. A runner without `contexts` has no extra requirements, as today.

The list is still needed: TypeScript can't tell which of the agent's or the layer's requirements the caller means to provide per run, so `dependencies` names them. Everything else is captured when the runner is built.

There is no runtime check of a provided value. A service is as trustworthy as any other in Effect: the type says what it holds.

Alternatives:

- A `context` argument keyed by tag key (`{ "app/Auth": principal }`), checked against each schema in the runner. This was implemented first. It worked, but it duplicated what Effect's context already does: callers built a map of string keys, the runner needed a rest-tuple type to make the argument required, and a runtime check (`RunContextInvalid`) to cover casts.
- `make`'s function returning `Effect<Stream<AgUi.Event>, never, AuthContext>`, which captures from the route's context. With middleware that's one `yield*`, but a route without middleware wraps it in `provideService` anyway, and a run is no longer a plain stream.

### 3. A workflow is started from its input, with the context read from the caller

`Runner.workflow` returns, besides `workflow` and `layer`:

- `start(input)`: `Effect<void, never, AuthContext | WorkflowEngine>`. It reads each declared run context's service from the caller's context, builds the payload, and executes it with `discard`, like `makeDetached`'s `start`. Starting a run that already has an execution joins it.
- `executionId(input)`: the execution id for `workflow.resume`, `poll` or `interrupt`, so callers never build a payload. It requires the run contexts too: the engine encodes the whole payload to derive the id, so it can't be computed from the input alone without reimplementing the engine's hashing.

The payload is `{ input, context }`, with `context` a `Schema.Struct` of each run context's full schema keyed by its tag key, or `{ input }` without run contexts. It stays internal. The engine encodes it when the execution starts, and a value the schema rejects (a refinement, say) makes `start` die with the engine's schema error before any execution exists, as `execute` already does. Each execution decodes the payload and provides each slice as its run context's service to the body.

Alternative: keep `workflow.execute({ input, context: { "app/Auth": principal } })`. No new API, but workflow callers would write the context differently from every other runner.

### 4. The context is not part of the run's input

The fingerprint stays the encoded AG-UI input alone. Re-executing a run id with different run-context services is not `RunInputMismatch`. The context is set by the server, never by the client, so a mismatch is a bug in the caller, not something a client can trigger. The `A run id names one input on its thread` requirement says so explicitly.

Alternative: add the context to the fingerprint. That catches a caller bug, but needs every run context to be encoded for request-scoped runs too.

### 5. A detached run's caller provides the context again

`makeDetached`'s `start` reads the run-context services when it's called, before forking, so a provider wrapped around `start` reaches the forked run. Re-execution needs the same services provided again; nothing stores them. A workflow keeps them in its payload.

Alternative: store the context with the run, in the event log or the thread store. That adds a field and an encoding to a store interface for something the caller already has, and would need decision 4's fingerprint to detect a mismatch.

### 6. Services are resolved per attempt, before the input check and the claim

Order within an attempt:

1. build the per-run layer, which reads the run contexts from the attempt's context;
2. check the input fingerprint, claim, load, commit and run, all with the built services provided.

Building comes first so a broken layer memoises nothing and claims nothing. The layer is built with `Layer.build` inside the `Stream.unwrap` that already wraps the attempt, so its scope is the attempt's stream: its finalizers run when that stream ends (after its last event), is cancelled or fails. A workflow replay runs the body again, so it builds the layer again. The layer is not an activity.

A failure while building ends the run with `RUN_STARTED` then `RUN_ERROR` whose code is the error's `errorCode`, through the existing `failInBand`. Because the thread was never claimed, `runEnded` is not called, the same as for `RunInputMismatch` and `ThreadBusy`.

Alternative: build the layer when the runner is built and read the tags lazily. That fixes the services for the life of the runner, which is what the proposal rules out.

### 7. Options and types

`Options` gains `dependencies` (a readonly tuple of service keys) and `layer`. Both are optional. `WorkflowOptions` narrows `dependencies` to RunContexts. The services a tuple of keys names are read from each key's `Identifier` (`DependencyServices<Dependencies>`), not `InstanceType`, which is `any` for these classes.

Each runner function gains type parameters `Dependencies` and the layer's `ROut`, `E` and `RIn`. `Runner.Requirements<Tools, R, Dependencies, ROut, RIn>` is what a runner captures:

`Exclude<Agent.Requirements<Tools, R>, ROut | DependencyServices<Dependencies>> | Exclude<RIn, DependencyServices<Dependencies>> | Thread.Thread | Checkpoint.Checkpoint`

`Checkpoint` is always required from outside, because the input check uses it before the per-run services exist; a layer that provided it would otherwise remove it from the requirements.

- `run`'s stream requires `Requirements | DependencyServices`.
- `make` captures `Requirements`; its streams require `DependencyServices`.
- `makeDetached` captures `Requirements | EventLog`; `start` requires `DependencyServices`.
- `workflow`'s layer requires `Requirements` minus `Checkpoint`, plus `EventLog` and the engine; `start` requires `DependencyServices | WorkflowEngine`.

`RunOptions` and `WorkflowPayload` are removed. Runners take just the input.

### 8. `RunInfo` loses `context`

`Agent.RunInfo` keeps `runId`, `threadId` and `props`. `Agent.run` and `Agent` need no new type parameter: per-run services arrive as ordinary requirements (see Context). An eval provides `CurrentUser` around `Agent.run`. A permanent type test pins the tool-dependency behaviour the proposal records.

## Risks / Trade-offs

- [A replayed attempt can see different service values from the first attempt] → Completed steps replay from their checkpoints, so only steps not yet run see the new values. A computed system prompt is memoised as `system`, so it keeps the first attempt's text even if it reads a per-run service; only tool handlers see the new values. The README states that services are resolved again on every attempt, and that a layer reading external state should expect this.
- [A route that re-executes with a different context isn't caught] → Decision 4. The detached runner's doc and the spec say to provide the same services. A workflow can't hit this, because the context comes from the payload.
- [The context is implicit at the call site] → It's a requirement in the run's type until provided, so it can't be forgotten; that's how every other Effect dependency works.
- [Type complexity: every runner carries more type parameters] → Defaults keep the no-context case unchanged at call sites. Type tests cover the requirements arithmetic.
- [Two RunContexts with the same tag key] → They collapse into one service and one payload field. The docs say keys must be unique, as for any Effect service.

## Migration Plan

- Library callers: replace `{ context: value }` with a service (a RunContext for a workflow), `dependencies`, `layer`, and `provideService` around the run; read services instead of `CurrentRun.context`. Start workflow runs with `start(input)` instead of `workflow.execute`.
- Workflow executions in flight when this ships were persisted with `context: unknown`. The new payload schema may reject them on decode. Drain them first, or register the new workflow under a new `name`.
