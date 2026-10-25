# Tasks

Conventions for every task: run from the repo root; `pnpm --filter effentic test` for the library tests; before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`. Type tests use `expectTypeOf` and `@ts-expect-error`, as `Agent.test.ts` does.

The change was first implemented with a `context` argument keyed by tag key (design 2, alternatives). Groups 2–6 rework it to run contexts provided through the Effect context.

## 1. RunInfo loses `context`

- [x] 1.1 In `Agent.ts` remove `context` from `RunInfo` and update the `RunInfo`, `RunInput` and `CurrentRun` doc comments: trusted per-run data reaches the agent as services it requires (8). Update the `Agent.test.ts` cases that read `CurrentRun.context` to read run id, thread id and props, and assert the run info has no `context` field ("Tool handler reads the context").
- [x] 1.2 Add a permanent type test in `Agent.test.ts`: a tool with `dependencies: [CurrentUser]` puts `CurrentUser` in `Agent.Requirements`, the toolkit's handler layer builds without it, a `CurrentUser` provided around `Agent.run` reaches the handler, and it stays required until the caller provides it ("Agents require per-run services as ordinary services", eval scenario).

## 2. Declaring run contexts

- [x] 2.1 In `Runner.ts` add `RunContext<Self>()(key, { schema })`: a `Context.Service` class whose service is `Schema.Type` of the schema, with the schema as a static `schema` (1; `context` would clash with `Context.Service`'s own `context` method). Add `ContextServices<Contexts>`, read from each key's `Identifier` (7).
- [x] 2.2 Remove `RunOptions`, `RunArgs`, `ContextOf`, `RunContextInvalid` and the per-attempt schema check (2). Keep `Options.contexts` (renamed `dependencies` in 8.1) and `Options.layer`, and `Requirements` as design 7 gives it.

## 3. Resolving services in the pipeline

- [x] 3.1 In `pipeline`, before the input fingerprint, build `layer` with `Layer.build` inside the attempt's `Stream.unwrap`, reading the run contexts from the attempt's context, and provide the built services to the rest of the attempt (6). The pipeline's stream requires `Requirements | ContextServices`. Update the pipeline doc comment's ordering list.
- [x] 3.2 `run` takes only the input and leaves `ContextServices` on its stream; `make` captures `Requirements` and returns streams requiring `ContextServices` (2, 7). Verify with type tests: a declared run context is required on the run's stream until provided, and a runner with no contexts returns streams with no requirements ("Missing run context rejected at compile time"); `make` doesn't require `CurrentUser` or `AuthContext` when the layer provides `CurrentUser` from `AuthContext`; a layer that also requires an unrelated service `S` makes `make` require `S`; without a layer the agent's `CurrentUser` stays required ("Per-run services are not captured", "Missing service fails to typecheck").
- [x] 3.3 Rework the request-scoped tests in `Runner.test.ts` to provide `AuthContext` with `Stream.provideService`: per-run services across two runs of one captured runner, `Tenant` depending on `CurrentUser`, forwarded props that can't set `CurrentUser`, and forwarding a context the caller already holds with `Stream.provideContext` ("Provided by middleware").
- [x] 3.4 Keep the layer-failure test (`RUN_STARTED`, `RUN_ERROR` code `UserNotFound`; no claim, no `input` checkpoint, no commit, no model call, no `runEnded`) and the finalizer and different-context tests, reworked to provide the run context. Remove the `RunContextInvalid` test.

## 4. Detached and workflow runners

- [x] 4.1 `makeDetached`'s `start` takes only the input, reads `ContextServices` when called and provides them, with the captured services, to the forked run (5). Update its doc. Rework the detached tests to provide `AuthContext` around `start`: services reach the run; a layer failure is logged as `RUN_ERROR`; a crashed run started again builds the layer once per attempt and replays step 1; a finished run started again doesn't build the layer.
- [x] 4.2 In `workflow`, keep the payload built from the declared contexts' schemas, keyed by tag key, and provide each decoded slice as its run context's service to the body. Add `start(input)`, which reads `ContextServices` from the caller, builds the payload and executes it with `discard`, and `executionId(input)`, which needs the run contexts too because the engine derives the id from the encoded payload (3). Update the `workflow` doc comment.
- [x] 4.3 Rework the workflow tests to use `start` with `AuthContext` provided: services reach tools, starting again joins; a value failing its schema makes `start` die with the engine's schema error and appends nothing; `executionId(input)` equals the id `workflow.executionId` gives the full payload. The existing workflow tests without run contexts use `start(input)` or keep `workflow.execute({ input })`.
  - Not covered: a workflow replay. The in-memory engine can't crash an execution mid-step (interrupting the caller leaves it running; `workflow.interrupt` doesn't end a body blocked in a step). The workflow body is the detached body, whose re-execution test (4.1) shows the layer is built again and step 1 replays.

## 5. Example

- [x] 5.1 In `packages/examples/ag-ui/src/server.ts`, drop the `context` arguments: provide `AuthContext` with `Stream.provideService` around `runAgent(input)` and `Effect.provideService` around `detached.start(input)`. Keep `auth.ts` (`AuthContext`, `CurrentUser`, `CurrentUserLayer`) and the email tool as they are. Update the example's `AGENTS.md` route notes.
- [x] 5.2 Run the example's manual checks in `packages/examples/ag-ui/AGENTS.md` and confirm the email still prints "from Demo User".
  - Done 2026-10-25 by driving the terminal client from a script: checks 1–3 pass; the approved email printed `from Demo User`.

## 6. Docs

- [x] 6.1 README: rework "Authentication and run context", the run-info section and the runner snippets (`make`, detached `start`, workflow `start`) to provide run contexts as services; drop `RunContextInvalid` from the error list and the runner steps; describe workflow `start` / `executionId` and the payload. Keep the per-attempt resolution, memoised system prompt, Effect "context" overlap, unique keys, principal-not-token and upgrade notes. Update the module reference row.
- [x] 6.2 `packages/effentic/AGENTS.md`: the `Runner.ts` note (run contexts left on each run, `start` capturing them, workflow `start` / `executionId`), and the "Run context" and "`context` never comes from the AG-UI input" bullets.

## 8. `dependencies`, with RunContexts only for workflows

- [x] 8.1 Rename `Options.contexts` to `dependencies` (any service key, like a tool's `dependencies`), the `Contexts` type parameter to `Dependencies` and `ContextServices` to `DependencyServices`; `WorkflowOptions` and `WorkflowPayloadFields` keep the RunContext constraint (1, 2, 7). Update the `RunContext` and `Options` doc comments.
- [x] 8.2 Verify in `Runner.test.ts`: a plain `Context.Service` dependency on `Runner.make` builds `CurrentUser` per run ("Plain service as a dependency"); `Runner.workflow` with a plain service fails to typecheck ("Workflow rejects a plain service").
- [x] 8.3 Make the example's `AuthContext` a plain `Context.Service` and inline the runner options. Rework the README's auth section around a plain service, and introduce `RunContext` in the workflow section; update both `AGENTS.md` files.

## 7. Wrap-up

- [x] 7.1 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding. Run `openspec validate typed-run-context --strict`.
