## Why

A run's trusted context, such as the verified principal, is `unknown` all the way through. `RunOptions.context`, `RunInfo.context` and the workflow payload all type it that way, so every reader decodes it again and has to `orDie` on a value the route already checked (the example's `currentPrincipal`). `CurrentRun` is one tag shared by all agents, so it can't carry an agent-specific type.

Requiring typed services such as `CurrentUser` directly doesn't work either, as the runners stand. `Runner.make` and `Runner.makeDetached` capture their services when they are built, so the service would be fixed for the life of the layer, not set per run. For a request-scoped run that capture exists only because a response body must be a stream with no requirements; the route holds the same services in its own context and can close over them per request instead. For a detached or workflow run the capture is inherent: the run outlives the request, so the runner must know ahead of time which services come from the caller per run. The aim is an Effect-native way to declare that where it is needed, and to resolve the services an agent requires for each run.

## What Changes

- **`Runner.RunContext`.** A class factory that declares a typed slice of the run's context: a tag whose service is the decoded value, plus the schema it is decoded with. For example, `class AuthContext extends Runner.RunContext<AuthContext>()("app/Auth", { schema: Schema.Struct({ userId: Schema.String }) }) {}`.
- **`Runner.make` is removed.** A request-scoped run is `Runner.run(agent)(input)`: a plain function, made without capturing anything, whose stream requires every service the run needs, the per-run service among them. The route calls it inside its handler, provides the per-run service (`Stream.provideService(AuthContext, principal)`) and closes over the rest with its own context (`Effect.context` + `Stream.provideContext`) before handing the stream to the response. Nothing is captured when the route is defined, so `run` needs no list of per-run dependencies.
- **Services come from an ordinary Layer.** Every runner's options gain a `layer` that builds per-run services, such as `CurrentUser`, by reading the per-run tags. The detached and workflow runners, which capture their services when built, also gain `dependencies: [AuthContext, ...]` (named after a tool's `dependencies`: services required per run rather than captured), naming the services to leave out of the capture. When one service depends on another, the layer's composition expresses it: tenant resolution can depend on the user, for instance. The library adds no ordering rules or `requires` of its own.
- **Resolved per run attempt.** The runner builds the layer once per run attempt, from the run-context services the attempt was provided, before the input check and the claim. A failure while building ends the run with `RUN_ERROR`, claims nothing, and isn't reported to the store through `runEnded`. A workflow execution rebuilds the layer on every replay, so the services are resolved again, not memoised. Completed steps still replay from their checkpoints. The layer is scoped to the attempt, so its finalizers run when the attempt ends.
- **The context is provided, not passed.** The per-run services are requirements of each run: `Runner.run(agent)(input)` is a stream requiring `AuthContext` alongside the agent's services, and `detached.start(input)` an `Effect<void, never, AuthContext>`. The route provides them like any service (`Stream.provideService(AuthContext, principal)`), so a missing one fails to typecheck. Runners take just the input.
- **Workflows start from the input.** `Runner.workflow` also returns `start(input)`, which reads the RunContexts' services from the caller, builds the payload (encoded with their schemas, so a value the schema rejects fails the start) and executes it, and `executionId(input)` for engine-level control.
- **Re-execution keeps today's contract.** The context is not part of the run-id fingerprint, so `RunInputMismatch` doesn't compare it. A detached run still doesn't store its context: the caller provides the same services again, now type-checked. A workflow keeps them in its payload.
- **Requirements.** A request-scoped run's stream requires the agent's requirements minus what the layer provides, plus what the layer needs. A detached or workflow runner requires the same minus its `dependencies`, captured when it is built, as stores are today.
- **`Agent` is unchanged.** An agent whose system prompt or tools need `CurrentUser` simply requires it. An eval calling `Agent.run` provides `CurrentUser` directly and never sees a RunContext. Tools declare `dependencies: [CurrentUser]`. This was checked on 2026-10-25 with a throwaway test:
  - The dependency appears in `Agent.Requirements`.
  - The toolkit's handler layer does not require it to build.
  - A `CurrentUser` provided around `Agent.run` reaches the handler at runtime.
  - Leaving it out fails to typecheck.

  The change keeps this as a permanent type test.
- **BREAKING:**
  - `Runner.make` is removed, and `Runner.run` takes no `dependencies`: the route closes over the services per request.
  - `RunInfo.context` is removed from `Agent.CurrentRun`; `props` stays.
  - `RunOptions` is removed: runners take just the input, and the context is provided as services.
  - The exported `Runner.WorkflowPayload` constant gives way to a payload built per workflow, and workflow runs are started with `start(input)` instead of `workflow.execute({ input, context })`.
- **The example** replaces `AppContext` decoding and `currentPrincipal`'s `orDie` with an `AuthContext` service the routes provide to each run; the system prompt and the email tool read it directly. `POST /agent` runs `Runner.run` inside its handler and closes over the handler's context in its SSE helper; `POST /runs` keeps `makeDetached` with `dependencies: [AuthContext]`.
- **Docs:** the README and `AGENTS.md` sections on run info, auth and the runners. They explain the overlap with Effect's "context": a RunContext adds entries to the run's Effect context.

## Capabilities

### New Capabilities
- `run-context-services`: declaring typed run-context services, leaving them as per-run requirements the caller provides, and building per-run services from them with a caller-supplied layer. This covers when the services are resolved (per attempt, before the input check and the claim, again on every replay), their scope, and how failures map to `RUN_ERROR` without a run-ended notification.

### Modified Capabilities
- `agent-run`: "Run from a prompt to step events" and "The current run is available to the system prompt and tool handlers" lose the run's context, and keep run id, thread id and properties.
- `agui-agent-loop`: "Run info from the AG-UI input and the caller": the caller's context no longer appears in the run info. It reaches the agent as services built from declared RunContexts, and the client still cannot set it. "A run id names one input on its thread" states that the context is not part of the memoised input.
- `agui-transport-edge`: the request-scoped runner no longer captures services: a run is a plain stream the route closes over per request, and `make` goes. The detached and workflow runners' options gain `dependencies` and `layer`; the request-scoped run takes `layer` alone. Runs require the declared dependencies (any service; RunContexts for a workflow); workflow runs start from the input, and the payload validates the context. Re-executing a detached run resolves its services again.

## Impact

- **`packages/effentic/src/Runner.ts`:**
  - the `RunContext` factory and its type helpers;
  - `make` removed; `Options` (`clientSystem`, `layer`) for `run`, `DetachedOptions` adding `dependencies` for `makeDetached`, `WorkflowOptions` narrowing them to RunContexts;
  - a type parameter for the layer on `pipeline`, `run`, `detached`, `makeDetached` and `workflow`, and for the declared dependencies on the last three;
  - layer building in the pipeline;
  - the payload schema built per workflow.
- **`packages/effentic/src/Agent.ts`:** `RunInfo` loses `context`, plus doc updates. No type parameter changes.
- **Tests:**
  - `Agent.test.ts`: the `CurrentRun` context cases.
  - `Runner.test.ts`: the run-info and runner sites.
  - `Sse.test.ts`: the `Runner.make` cases become `Runner.run` consumed the way a handler does, after the effect that built the stream has returned.
  - New tests: a typed context; resolution per attempt; dependent services; a layer failure ending in `RUN_ERROR` without a claim; a workflow that validates the payload and resolves again on replay; type tests for requirements and tool dependencies.
- **Example (`packages/examples/ag-ui`):** `auth.ts`, `tools/email.tool.ts` and `server.ts`. **`packages/examples/tanstack`:** `chat.server.ts` (`Runner.make` → `Runner.run` in the handler).
- **Docs:** the README, both `AGENTS.md` files, and the main specs above.
- **Ordering:** independent of `thread-history-sync` and `transient-model-retry`.
