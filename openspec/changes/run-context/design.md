## Context

Today `Agent.Agent<Tools>` holds `system: string | undefined`. `Agent.run(agent)({ runId, prompt })` sends `prompt` as given and never reads `agent.system`. The runner adds it while projecting the thread, `Messages.project(agent.system, entries)`, inside the `prompt` checkpoint (`Runner.ts`, pipeline step 2). Tool handlers are built once by `toolkit.toLayer(...)`, and nothing about the run reaches them.

These facts constrain where per-run values can come from:

- `Runner.make` captures its services when it is built and provides them to every stream it returns (`Stream.provideContext`), so a request handler has no way to add a service for one request.
- `makeDetached` and `workflow` run in a fork or on a workflow worker. The only per-run data they have is what they were started with. For `workflow`, that is the payload the engine persists.
- `AgUi.RunAgentInput` is controlled by the client, and its decoder currently strips `forwardedProps`.
- `effect/ai` runs a tool handler under `Context.merge(layerContext, callerContext)` (`effect/src/ai/Toolkit.ts`, `handle`). A tool's `dependencies` (`Tool.make(name, { dependencies: [...] })`) are its per-call requirements (`Tool.HandlerServices`). So a service that `Agent.run` provides around `toolkit.handle` reaches handlers that declare it.

## Goals / Non-Goals

**Goals:**

- The system prompt and tool handlers can see which run they are in, including a server-verified identity, the same way in production and in evals.
- Evals exercise the system prompt through `Agent.run` alone, with mock services and literal run info.
- Resumed runs see the same resolved system prompt and the same context, under every runner that resumes.
- Agents with a fixed prompt and tools that ignore the run need no change beyond the `RunInput` change.

**Non-Goals:**

- Authentication or authorisation in the library. Verifying tokens and checking thread ownership stay the caller's job (decision 6).
- Typed `props` or `context`. Both are `unknown`, and readers decode them with a Schema.
- Prompt caching controls, or a stable/changing split of the prompt (follow-up).
- Dynamic tools or a dynamic step limit.

## Decisions

### 1. The agent applies its system prompt, in `Agent.run`

`Agent.run` puts the resolved system prompt first, before the prompt it is given. Everything that runs the agent goes through this, so evals and runners send the same prompt.

*Alternative rejected:* a runner option such as `instructions: (run) => Effect<string>`. It works for AG-UI, but an eval calling `Agent.run` would skip it and would have to go through the runner. That is the leak this change removes.

### 2. Run info, and `CurrentRun`

```ts
export interface RunInfo {
  readonly runId: string;
  readonly threadId: string;
  /** From the client (AG-UI `forwardedProps`). Untrusted. */
  readonly props?: unknown;
  /** From the server: whoever started the run, e.g. the verified principal. Trusted. */
  readonly context?: unknown;
}
export interface RunInput extends RunInfo {
  readonly prompt: Prompt.Prompt; // without the agent's system prompt
}
/** The run being executed. Provided by `Agent.run`; never provide it yourself. */
export class CurrentRun extends Context.Service<CurrentRun, RunInfo>()("effentic/Agent/CurrentRun") {}
```

`Agent.run` provides `CurrentRun` around the whole run, so the system prompt effect, every `toolkit.handle` call (step 0 and every step) and `needsApproval` predicates can all read it. Providing it once, at the outside of the run, also keeps the `Exclude` from `Requirements` (decision 3) in one place. A tool opts in:

```ts
const SendEmail = Tool.make("send-email", { parameters, success, dependencies: [Agent.CurrentRun], needsApproval: true });
// handler
(params) => Effect.gen(function* () {
  const run = yield* Agent.CurrentRun;
  const { principal } = yield* Schema.decodeUnknownEffect(AppContext)(run.context);
  …
});
```

- **A service, not an argument.** Tool handlers are built once in a layer and can only receive per-run data through their context. Using the same service for the system prompt means there is one way to read the run.
- *Alternative rejected:* `system: (run: RunInfo) => Effect<…>`. It is explicit, but it would be a second way to get the same information, and it doesn't help tools.

### 3. `system: string | Effect<string, never, R>`, and `Requirements`

```ts
export interface Agent<Tools extends Record<string, Tool.Any>, R = never> {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  readonly system: string | Effect.Effect<string, never, R> | undefined;
  readonly maxSteps: number;
}
export type Requirements<Tools extends Record<string, Tool.Any>, R = never> = Exclude</* today's union */ | R, CurrentRun>;
```

`define` infers `R`, so a fixed string gives `R = never`. `CurrentRun` is removed from `Requirements` whether it comes from the system effect or from a tool's `dependencies`, because `Agent.run` provides it.

**The error type is `never`.** The checkpoint ledger stores exits through schemas, so a typed error would need an error codec from the caller. Callers handle failures inside the effect, for example by falling back to a default. A defect still fails the run (decision 4).

### 4. Resolve once, as the `system` checkpoint, before step 0

When `system` is an effect, `Agent.run` resolves it with `checkpoint.memo({ runId, name: "system", success: Schema.String, error: Schema.Never }, agent.system)` under `CurrentRun`. That happens before approvals carried by the prompt are resolved (step 0), so a failure runs no tool. A fixed string is used directly and not checkpointed, so it costs no ledger write.

The ledger encodes exits with `Schema.Defect`, so a defect is memoised like any other failed step: the run ends with `Failed`, and re-executing it fails the same way (as the resume rules already say for failed steps). Under `Checkpoint.layerWorkflow` the resolution is an activity, which keeps it out of the workflow body's replay.

### 5. Trusted `context` and untrusted `props` are separate channels

The runner sets `props` from `input.forwardedProps` and `context` only from its caller. Every runner takes an optional second argument:

```ts
export interface RunOptions { readonly context?: unknown }

Runner.run(agent, options)(input, { context })      // and the function `Runner.make` returns
detached.start(input, { context })
workflow.execute({ input, context }, { discard: true }) // payload: Schema.Struct({ input: AgUi.RunAgentInput, context: Schema.optional(Schema.Unknown) })
```

- **Two fields, not one.** A route could put a verified principal in `forwardedProps`, but then safety depends on every route overwriting, never merging, the client's value. One route that forgets lets a client claim to be anyone, and nothing downstream can tell. With separate fields, nothing the client sends can become `context`.
- **The workflow payload carries the context,** because the engine resumes executions from the payload alone. The idempotency key is built from the input's thread and run ids (decision 9). The context must be JSON-encodable, because `Schema.Unknown` stores it as is.
- **A detached run doesn't store its context.** Restarting it after a crash means calling `start` again with the same input and context. The caller already holds both, because it holds the input.
- *Alternative deferred:* a context schema (`Runner.workflow(agent, { context: Principal })`), which would type it and validate it on decode. That can be added without breaking this API.

### 6. Authentication and thread ownership stay with the caller

The library never sees the bearer token. The README shows the pattern:
1. verify the token in the route;
2. check that the principal may use `input.threadId`;
3. pass `{ context: { principal } }` to the runner.

Two rules go in the docs:

- **Put the verified principal in `context`, not the raw token.** `context` is persisted in the workflow payload, and may be in logs. A token can also expire before a resumed run reaches a tool. A tool that calls a downstream API as the user should get credentials from a service keyed by the principal.
- **`Thread.load(threadId)` does no access control.** The route checks that the principal owns the thread before starting the run. The `Thread` service sees only ids, so it can't make this check itself. Rewriting `threadId` to a namespaced id in the route also works, but the client then sees the rewritten id in `RUN_STARTED` and later events.

### 7. `Messages.project` loses its system parameter

`project(entries)` returns the projection of the thread only. The runner's `prompt` checkpoint then holds exactly that, and the agent adds the system prompt per model call. Leaving `project(system, entries)` in place and passing `undefined` was considered. It keeps a parameter that no caller should use any more and invites applying the system prompt twice.

### 8. Runner wiring

The pipeline builds `RunInfo` from the input and the run options (`runId`, `threadId`, `props: input.forwardedProps`, `context: runOptions?.context`) and calls `Agent.run(agent)({ ...info, prompt })`. Every runner's type gains the agent's `R`: `run`/`make`/`makeDetached` require `Agent.Requirements<Tools, R>`, and `workflow` requires `Exclude<Agent.Requirements<Tools, R>, Checkpoint>`. `AgUi.RunAgentInput` gains `forwardedProps: Schema.optional(Schema.Unknown)`. The decoder stays lenient, and the value is passed through untouched.

### 9. Run keys include the thread id

The client chooses `runId` (`HttpAgent` mints one per request), and before this change it was the only key for the checkpoint ledger, the workflow idempotency key and the event log. The caller authorises `threadId` (decision 6), and nothing authorises `runId`. A signed-in user who sent another user's run id under their own thread would replay that run's `prompt` and `system` checkpoints and tool results into their own thread, join its workflow execution, or read its event log. That breaks decision 5's invariant from the other side: server-trusted data from one principal reaches another.

Every key for a run is now `(threadId, runId)`:

- `MemoOptions` and `Ledger.get`/`set` take a `threadId`;
- `EventLog` operations take one;
- the workflow idempotency key is `JSON.stringify([threadId, runId])`.

The in-memory stores build their keys with `JSON.stringify` too, so no choice of ids makes two keys collide. Authorising the thread then authorises its runs, so the caller has one check to make.

Within a thread, a reused run id is still the owner's own data, but replaying it with a different input would commit the new messages while replaying the old prompt. So the pipeline memoises the encoded input as the `input` checkpoint before it loads or commits anything, and fails with `RunInputMismatch` if a re-execution's input differs. With `layerNone` the check never fires. Under `layerWorkflow` the payload is fixed, so it always passes.

- *Alternative rejected:* documenting that callers must validate `runId`. A caller can only do that with its own persistent `runId → owner` table, and minting run ids on the server conflicts with AG-UI, where the client sends them.
- *Alternative rejected:* binding `runId → (threadId, principal)` on first use. It needs a new store, and the library would have to know about principals.

## Risks / Trade-offs

- [A system prompt that changes every run defeats prefix prompt caching on long threads, because it is the first thing in the prompt] → Document it, recommend keeping changing values small and few, and leave the stable/changing split as the follow-up named in the proposal.
- [`props` come from the client: prompt injection if the system prompt pastes them in] → `RunInfo.props` is documented as untrusted. The README example uses `props` to choose between known values (e.g. a locale) rather than interpolating them, and puts identity in `context`.
- [A thread used by someone who doesn't own it] → Decision 6. The README's authentication example includes the ownership check, so copying the example gets it right.
- [A detached run restarted with a different context than its first attempt] → Documented on `start`. Replayed steps keep their original results, so only the steps that run again would see the new context.
- [A run checkpointed by the previous version stores a `prompt` that already includes the system message, so resuming it after the upgrade sends the system prompt twice] → The package is `0.0.1` with in-memory and test ledgers only. The change is noted as breaking, and the migration plan below covers durable ledgers.
- [The resolved prompt isn't stored in the thread or shown in events, which makes it harder to debug] → It is in the checkpoint ledger under `system` for any durable layer, and evals can read it from the scripted model's recorded prompts.

## Migration Plan

1. Archive `durable-agent-planes` first, because this change modifies requirements it introduces.
2. Custom `Checkpoint.Ledger` and `EventLog` implementations take the thread id as a new first argument and include it in their keys.
3. Callers of `Agent.run` add `threadId` (and `props`/`context` if wanted) and drop the system message from their prompt. Callers of `Messages.project` drop the first argument.
4. Callers of `Runner.workflow` execute with `{ input, context }` instead of `input`. Executions already persisted with the old payload shape won't decode, so let them finish before deploying.
5. Before deploying over durable checkpoint ledgers, event logs or workflow engines, let in-flight runs finish, or give the runs started after the deploy new run ids. Old `prompt` checkpoints must not be resumed by the new code, and old keys lack the thread id, so the new code wouldn't find them anyway.
