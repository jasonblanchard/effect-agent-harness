## Why

A run's trusted context, such as the verified principal, is `unknown` all the way through. `RunOptions.context`, `RunInfo.context` and the workflow payload all type it that way, so every reader decodes it again and has to `orDie` on a value the route already checked (the example's `currentPrincipal`). `CurrentRun` is one tag shared by all agents, so it can't carry an agent-specific type.

Requiring typed services such as `CurrentUser` directly doesn't work either. `Runner.make` and `Runner.makeDetached` capture their services when they are built, so the service would be fixed for the life of the layer, not set per run. The aim is an Effect-native way to declare, ahead of time, what a run's context looks like and which services it produces, and to resolve them for each run.

## What Changes

- **`Runner.RunContext`.** A class factory that declares a typed slice of the run's context: a tag whose service is the decoded value, plus the schema it is decoded with. For example, `class AuthContext extends Runner.RunContext<AuthContext>()("app/Auth", { context: Schema.Struct({ userId: Schema.String }) }) {}`.
- **Services come from an ordinary Layer.** The runner options gain `contexts: [AuthContext, ...]` and a `layer` that builds per-run services, such as `CurrentUser`, by reading those tags. When one service depends on another, the layer's composition expresses it: tenant resolution can depend on the user, for instance. The library adds no ordering rules or `requires` of its own.
- **Resolved per run attempt.** The runner decodes each slice, provides the tags, and builds the layer once per run attempt, before the thread is claimed. A failure while decoding or building ends the run with `RUN_ERROR` and claims nothing. A workflow execution rebuilds the layer on every replay, so the services are resolved again, not memoised. Completed steps still replay from their checkpoints. The layer is scoped to the attempt, so its finalizers run when the attempt ends.
- **Typed `context` at the call site.** `RunOptions` is typed from the declared RunContexts, keyed per RunContext, so `start(input, { context })` and `workflow.execute({ input, context })` are checked at compile time. The workflow payload schema is built from the declared schemas, so the context is validated on decode.
- **Requirements.** A runner requires the agent's requirements minus what the layer provides, plus what the layer needs other than the context tags. Those needs are captured when the runner is built, as stores are today.
- **`Agent` is unchanged.** An agent whose system prompt or tools need `CurrentUser` simply requires it. An eval calling `Agent.run` provides `CurrentUser` directly and never sees a RunContext. Tools declare `dependencies: [CurrentUser]`. This was checked on 2026-10-25 with a throwaway test:
  - The dependency appears in `Agent.Requirements`.
  - The toolkit's handler layer does not require it to build.
  - A `CurrentUser` provided around `Agent.run` reaches the handler at runtime.
  - Leaving it out fails to typecheck.

  The change keeps this as a permanent type test.
- **BREAKING:**
  - `RunInfo.context` is removed from `Agent.CurrentRun`; `props` stays.
  - `RunOptions` is no longer `{ context?: unknown }`.
  - The exported `Runner.WorkflowPayload` constant gives way to a payload built per workflow.
- **The example** replaces `AppContext` decoding and `currentPrincipal`'s `orDie` with an `AuthContext` RunContext, a `CurrentUser` service and its layer. The email tool depends on `CurrentUser`.
- **Docs:** the README and `AGENTS.md` sections on run info, auth and the runners. They explain the overlap with Effect's "context": a RunContext adds entries to the run's Effect context.

## Capabilities

### New Capabilities
- `run-context-services`: declaring typed run-context slices, decoding them from what the caller passes, and building per-run services from them with a caller-supplied layer. This covers when the services are resolved (per attempt, before the claim, again on every replay), their scope, and how failures map to `RUN_ERROR`.

### Modified Capabilities
- `agent-run`: "The current run is available to the system prompt and tool handlers" loses the run's context, and keeps run id, thread id and properties.
- `agui-agent-loop`: "Run info from the AG-UI input and the caller": the caller's context no longer appears in the run info. It reaches the agent as services built from declared RunContexts, and the client still cannot set it.
- `agui-transport-edge`: the runner requirements and the detached and workflow runners. The runner options gain `contexts` and `layer`. The context is typed, and the workflow payload validates it. Re-executing a detached run resolves its services again.

## Impact

- **`packages/effentic/src/Runner.ts`:**
  - the `RunContext` factory and its type helpers;
  - a type parameter for the declared contexts and layer on `pipeline`, `run`, `make`, `detached`, `makeDetached` and `workflow`;
  - layer building in the pipeline;
  - the payload schema built per workflow.
- **`packages/effentic/src/Agent.ts`:** `RunInfo` loses `context`, plus doc updates. No type parameter changes.
- **Tests:**
  - `Agent.test.ts`: the `CurrentRun` context cases.
  - `Runner.test.ts`: the run-info and runner sites.
  - New tests: a typed context; resolution per attempt; dependent services; a layer failure ending in `RUN_ERROR` without a claim; a workflow that validates the payload and resolves again on replay; type tests for requirements and tool dependencies.
- **Example (`packages/examples/ag-ui`):** `auth.ts`, `tools/email.tool.ts` and `server.ts`.
- **Docs:** the README, both `AGENTS.md` files, and the main specs above.
- **Ordering:** independent of `thread-history-sync` and `transient-model-retry`.
