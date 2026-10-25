# Tasks

Conventions for every task: run from the repo root; `pnpm --filter effentic test` for the library tests; before ticking a group, `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` must pass with no findings (lint denies warnings). Numbers in parentheses point at design.md decisions. Every AG-UI event sequence a test produces goes through `verify` from `test/fixtures.ts`. Archive `durable-agent-planes` before archiving this change; implementing it doesn't depend on that.

## 1. Run input and decoding

- [x] 1.1 In `AgUi.ts` add `forwardedProps: Schema.optional(Schema.Unknown)` to `RunAgentInput` (8). Verify in `AgUi.test.ts`: the extra-fields case now keeps `forwardedProps`; a string, an array and a nested object each round-trip unchanged; the other extra fields are still stripped.
- [x] 1.2 In `Agent.ts` add `RunInfo` (`runId`, `threadId`, optional `props` and `context`, both `unknown`) and make `RunInput` extend it with `prompt` (2). Update every `Agent.run` call in tests and fixtures to pass a `threadId`. Verify `pnpm tsc` passes.

## 2. Current run

- [x] 2.1 Add `Agent.CurrentRun` (`Context.Service` holding `RunInfo`, id `"effentic/Agent/CurrentRun"`). Provide it for the whole of `Agent.run` (so every `toolkit.handle` call, step 0 included, sees it), and `Exclude` it from `Requirements` (2, 3). Verify in `Agent.test.ts`, with a test tool declaring `dependencies: [Agent.CurrentRun]`:
  - its handler sees the literal run info passed to `Agent.run`, including `context: { userId: "u1" }`;
  - the run needs no `CurrentRun` layer (`pnpm tsc` passes, and the test provides only the model, handlers and checkpoint);
  - a step-0 approved call also sees the run info.

## 3. Agent-owned system prompt

- [x] 3.1 Make `Agent` generic as `Agent<Tools, R = never>` with `system: string | Effect<string, never, R> | undefined`, have `define` infer `R`, and add `R` to `Requirements<Tools, R>` (3). Verify `pnpm tsc` passes, and that a type-level test shows a fixed-string agent's requirements unchanged and a system effect needing a `UserDirectory` service requiring it.
- [x] 3.2 In `Agent.run`, resolve the system prompt before step 0 under `CurrentRun`: use a fixed string as is, and memoise an effect as `checkpoint.memo({ runId, name: "system", success: Schema.String, error: Schema.Never }, …)` (4). Put it as the first message of every model call. Verify in `Agent.test.ts`:
  - with the system prompt "Be helpful.", every recorded model prompt starts with that system message;
  - an effect reading a mock `UserDirectory` gives "Ada" and "Grace" prompts under two service layers, with the same definition;
  - an effect reading `CurrentRun` sees `props: { locale: "fr" }`;
  - a prompt that starts with a summary system message comes after the agent's system prompt;
  - a two-step run resolves the effect once (counter);
  - an agent without a system prompt sends the prompt unchanged.
- [x] 3.3 Verify resolution failure and replay in `Agent.test.ts`:
  - an effect that dies ends the run with one `Failed`, the model is never called, and no handler runs, including for a prompt with an approved approval waiting for step 0;
  - with `Checkpoint.layerMemoryLedger` and a clock-like service that changes between attempts, a run interrupted in step 1 and executed again sends the first attempt's system text in every model call.

## 4. Projection and runners

- [x] 4.1 Drop the system parameter from `Messages.project` (7) and update its tests in `Messages.test.ts`, keeping every ordering and repair case. Verify the summary case now expects only the summary and user messages.
- [x] 4.2 In `Runner.ts` add `RunOptions { context?: unknown }`, and take it as an optional second argument in the `run` stream function, in the function `make` returns, and in `makeDetached`'s `start` (5, 8). Build `RunInfo` from the input and the options, project without the system prompt inside the `prompt` memo, and pass the info to `Agent.run`. Thread the agent's `R` through every runner. Verify the existing `Runner.test.ts` and `Sse.test.ts` pass with unchanged behaviour (prompts still start with the system prompt).
- [x] 4.3 Change `Runner.workflow`'s payload to `Schema.Struct({ input: AgUi.RunAgentInput, context: Schema.optional(Schema.Unknown) })` with idempotency key `payload.input.runId` (5). Update the workflow tests to execute `{ input, context }`. Verify that a tool reading `CurrentRun` sees the payload's context, and that executing twice still joins one execution.
- [x] 4.4 Verify in `Runner.test.ts`:
  - `forwardedProps: { locale: "fr" }` reaches the system effect as `props`, with the input's run and thread ids;
  - without `forwardedProps` there are no props;
  - a run started with `{ context: { userId: "u1" } }` and `forwardedProps: { context: { userId: "u2" }, userId: "u2" }` gives tools `context: { userId: "u1" }`, with the client values only in `props`;
  - two runs from one `Runner.make` function with different contexts each see their own;
  - a detached run sees the context passed to `start`;
  - after a finished run, the stored thread holds no system entry;
  - the prompt-memo test still sends the original projection after the thread is rewritten.

## 5. Docs and example

- [x] 5.1 Update `packages/effentic/README.md`:
  - "Defining an agent" shows a system effect reading a service and `CurrentRun`, and notes the prompt-caching tradeoff;
  - a tool section shows `dependencies: [Agent.CurrentRun]`;
  - a new "Authentication and run context" section: verify the bearer token in the route, check thread ownership, pass the verified principal (not the token) as `context`, and treat `props` as untrusted (choose between known values, don't interpolate);
  - "Running over AG-UI" shows the second argument and the workflow payload;
  - "Testing and evals" shows literal run info and mock services with `Agent.run`;
  - the module reference lists `RunInfo`, `CurrentRun` and `RunOptions`.
- [x] 5.2 Update `packages/effentic/AGENTS.md`: the `Agent.ts`, `Messages.ts` and `Runner.ts` entries, the resume rules for the `system` checkpoint and the detached-run context, and an invariant that `context` never comes from the AG-UI input.
- [x] 5.3 In `packages/examples/ag-ui`:
  - the system prompt includes today's date through a system effect;
  - `/agent` and `/runs` read `Authorization: Bearer <token>` through a placeholder `verify` that accepts a fixed demo token and returns a principal, answer `401` otherwise, and pass `{ context: { principal } }`;
  - `send-email` reads the principal from `CurrentRun` and prints it as the sender;
  - `src/agent.ts` sends the demo token.

  Verify `pnpm --filter ag-ui tsc` and lint pass, run the example's manual checks from its `AGENTS.md`, and add a check that the email shows the demo principal as the sender.

## 6. Run keys scoped by thread

- [x] 6.1 Add `threadId` to `Checkpoint.MemoOptions` and to `Ledger.get`/`set`, key `layerMemoryLedger` by `JSON.stringify([threadId, runId, name])`, and pass `input.threadId` from every memo in `Agent.run` and the runner (9). Verify in `Checkpoint.test.ts` that the same run id and name under two thread ids execute once each and the first replays.
- [x] 6.2 Add `threadId` to every `EventLog` operation and key `layerMemory` by both ids (9). Verify in `EventLog.test.ts` that the same run id on two threads has separate events and cursors.
- [x] 6.3 Make `Runner.workflow`'s idempotency key `JSON.stringify([threadId, runId])` (9). Verify in `Runner.test.ts` that run id "r1" on threads "t1" and "t2" gives two complete executions, with the weather handler running once per thread.
- [x] 6.4 Memoise the encoded input as the `input` checkpoint before loading the thread, and fail with `RunInputMismatch` when it differs (9). Verify in `Runner.test.ts` with a ledger:
  - run id "r1" reused on "t2" with another message calls the model with only "t2"'s history, runs no tool again, and "t2" holds only its own entries;
  - run id "r1" reused on "t1" with an added message ends `RUN_STARTED`, `RUN_ERROR` (`RunInputMismatch`), calls no model and commits nothing new;
  - the prompt-memo test (same input re-executed) still passes.
- [x] 6.5 Docs and example: the README's authentication rules say the thread check covers its runs, and the checkpoint, workflow, event-log and custom-store sections show the new keys; `packages/effentic/AGENTS.md` gets the invariant; the example's events route becomes `GET /threads/:threadId/runs/:runId/events` and authenticates.

## 7. Unanswered interrupts

- [x] 7.1 Add `Messages.UnansweredInterrupt` (TaggedError with brand, `interruptIds`) and make `resume` return `Result<entries, UnansweredInterrupt>`, failing when any pending approval has no resume entry (10). Verify in `Messages.test.ts`: no entries fails naming "a1"; answering one of two fails naming the other; only an unknown id fails naming both; `cancelled` still gives a "cancelled" denial; an already answered request needs no entry.
- [x] 7.2 Fail the pipeline with the error before committing (10). Verify in `Runner.test.ts`:
  - a run with a new message and no `resume` after an interrupt ends `RUN_STARTED`, `RUN_ERROR` (`UnansweredInterrupt`), leaves the thread unchanged and calls no model; a later run approving the interrupt sends the email once and finishes `success`;
  - `cancelled` with a new user message gives the model the call, its "cancelled" result, then the message;
  - an unknown interrupt id next to a real answer is ignored.
- [x] 7.3 Docs and example: the README approval rules (with the AG-UI rule and the `cancelled` pattern) and module reference, both `AGENTS.md` files, and `src/index.ts` cancels interrupts still open when the user sends a new message.

## 8. One active run per thread

- [x] 8.1 Add `Thread.ThreadBusy` (TaggedError with brand, `activeRunId`) and `claim`/`release` to `Thread`, and implement them in `layerMemory` (11). Verify in `Thread.test.ts`: a second run's claim fails naming the first; the same run claims again; a release by another run does nothing; the holder's release frees the thread; threads are independent.
- [x] 8.2 In the pipeline, claim after the `input` check and before `load`; release after `runEnded` and before the terminal event, even if `runEnded` failed; in `run`/`make`, release a run whose stream stops before its terminal event (11). Verify in `Runner.test.ts`:
  - a second run while one is streaming ends `RUN_STARTED`, `RUN_ERROR` (`ThreadBusy`), commits nothing and isn't reported; the first finishes, and the thread can be claimed at the moment its `RUN_FINISHED` is seen;
  - a run on another thread runs normally;
  - a failing claim ends with `ThreadError` and isn't reported;
  - a cancelled request-scoped run releases the thread; the commit logs show `claim` first and `release` after `runEnded`;
  - a `RunInputMismatch` run neither claims nor is reported;
  - a crashed detached run keeps the thread busy until it is started again and ends.
- [x] 8.3 Docs: the README's Threads section (one run at a time, claim expiry, re-entrancy), the detached-runs caveat, the custom `Thread` store example and the error list; `packages/effentic/AGENTS.md`'s `Thread.ts` and `Runner.ts` entries and an invariant.
