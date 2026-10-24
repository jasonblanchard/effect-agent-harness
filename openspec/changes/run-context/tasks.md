# Tasks

Conventions for every task: run from the repo root; `pnpm --filter effentic test` for the library tests; before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`. Start only after `durable-agent-planes` is archived.

## 1. Run input and decoding

- [ ] 1.1 In `AgUi.ts` add `forwardedProps: Schema.optional(Schema.Unknown)` to `RunAgentInput` (8). Verify in `AgUi.test.ts`: the extra-fields case now keeps `forwardedProps`; a string, an array and a nested object each round-trip unchanged; the other extra fields are still stripped.
- [ ] 1.2 In `Agent.ts` add `RunInfo` (`runId`, `threadId`, optional `props` and `context`, both `unknown`) and make `RunInput` extend it with `prompt` (2). Update every `Agent.run` call in tests and fixtures to pass a `threadId`. Verify `pnpm tsc` passes.

## 2. Current run

- [ ] 2.1 Add `Agent.CurrentRun` (`Context.Service` holding `RunInfo`, id `"effentic/Agent/CurrentRun"`). Provide it around every `toolkit.handle` call in `Agent.run` (step 0 and each step), and `Exclude` it from `Requirements` (2, 3). Verify in `Agent.test.ts`, with a test tool declaring `dependencies: [Agent.CurrentRun]`:
  - its handler sees the literal run info passed to `Agent.run`, including `context: { userId: "u1" }`;
  - the run needs no `CurrentRun` layer (`pnpm tsc` passes, and the test provides only the model, handlers and checkpoint);
  - a step-0 approved call also sees the run info.

## 3. Agent-owned system prompt

- [ ] 3.1 Make `Agent` generic as `Agent<Tools, R = never>` with `system: string | Effect<string, never, R> | undefined`, have `define` infer `R`, and add `R` to `Requirements<Tools, R>` (3). Verify `pnpm tsc` passes, and that a type-level test shows a fixed-string agent's requirements unchanged and a system effect needing a `UserDirectory` service requiring it.
- [ ] 3.2 In `Agent.run`, resolve the system prompt before step 0 under `CurrentRun`: use a fixed string as is, and memoise an effect as `checkpoint.memo({ runId, name: "system", success: Schema.String, error: Schema.Never }, …)` (4). Put it as the first message of every model call. Verify in `Agent.test.ts`:
  - with the system prompt "Be helpful.", every recorded model prompt starts with that system message;
  - an effect reading a mock `UserDirectory` gives "Ada" and "Grace" prompts under two service layers, with the same definition;
  - an effect reading `CurrentRun` sees `props: { locale: "fr" }`;
  - a prompt that starts with a summary system message comes after the agent's system prompt;
  - a two-step run resolves the effect once (counter);
  - an agent without a system prompt sends the prompt unchanged.
- [ ] 3.3 Verify resolution failure and replay in `Agent.test.ts`:
  - an effect that dies ends the run with one `Failed`, the model is never called, and no handler runs, including for a prompt with an approved approval waiting for step 0;
  - with `Checkpoint.layerMemoryLedger` and a clock-like service that changes between attempts, a run interrupted in step 1 and executed again sends the first attempt's system text in every model call.

## 4. Projection and runners

- [ ] 4.1 Drop the system parameter from `Messages.project` (7) and update its tests in `Messages.test.ts`, keeping every ordering and repair case. Verify the summary case now expects only the summary and user messages.
- [ ] 4.2 In `Runner.ts` add `RunOptions { context?: unknown }`, and take it as an optional second argument in the `run` stream function, in the function `make` returns, and in `makeDetached`'s `start` (5, 8). Build `RunInfo` from the input and the options, project without the system prompt inside the `prompt` memo, and pass the info to `Agent.run`. Thread the agent's `R` through every runner. Verify the existing `Runner.test.ts` and `Sse.test.ts` pass with unchanged behaviour (prompts still start with the system prompt).
- [ ] 4.3 Change `Runner.workflow`'s payload to `Schema.Struct({ input: AgUi.RunAgentInput, context: Schema.optional(Schema.Unknown) })` with idempotency key `payload.input.runId` (5). Update the workflow tests to execute `{ input, context }`. Verify that a tool reading `CurrentRun` sees the payload's context, and that executing twice still joins one execution.
- [ ] 4.4 Verify in `Runner.test.ts`:
  - `forwardedProps: { locale: "fr" }` reaches the system effect as `props`, with the input's run and thread ids;
  - without `forwardedProps` there are no props;
  - a run started with `{ context: { userId: "u1" } }` and `forwardedProps: { context: { userId: "u2" }, userId: "u2" }` gives tools `context: { userId: "u1" }`, with the client values only in `props`;
  - two runs from one `Runner.make` function with different contexts each see their own;
  - a detached run sees the context passed to `start`;
  - after a finished run, the stored thread holds no system entry;
  - the prompt-memo test still sends the original projection after the thread is rewritten.

## 5. Docs and example

- [ ] 5.1 Update `packages/effentic/README.md`:
  - "Defining an agent" shows a system effect reading a service and `CurrentRun`, and notes the prompt-caching tradeoff;
  - a tool section shows `dependencies: [Agent.CurrentRun]`;
  - a new "Authentication and run context" section: verify the bearer token in the route, check thread ownership, pass the verified principal (not the token) as `context`, and treat `props` as untrusted (choose between known values, don't interpolate);
  - "Running over AG-UI" shows the second argument and the workflow payload;
  - "Testing and evals" shows literal run info and mock services with `Agent.run`;
  - the module reference lists `RunInfo`, `CurrentRun` and `RunOptions`.
- [ ] 5.2 Update `packages/effentic/AGENTS.md`: the `Agent.ts`, `Messages.ts` and `Runner.ts` entries, the resume rules for the `system` checkpoint and the detached-run context, and an invariant that `context` never comes from the AG-UI input.
- [ ] 5.3 In `packages/examples/ag-ui`:
  - the system prompt includes today's date through a system effect;
  - `/agent` and `/runs` read `Authorization: Bearer <token>` through a placeholder `verify` that accepts a fixed demo token and returns a principal, answer `401` otherwise, and pass `{ context: { principal } }`;
  - `send-email` reads the principal from `CurrentRun` and prints it as the sender;
  - `src/agent.ts` sends the demo token.

  Verify `pnpm --filter ag-ui tsc` and lint pass, run the example's manual checks from its `AGENTS.md`, and add a check that the email shows the demo principal as the sender.
