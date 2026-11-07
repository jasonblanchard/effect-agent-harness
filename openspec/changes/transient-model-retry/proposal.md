## Why

A transient model failure, such as a 429 or `overloaded`, ends a run, and nothing on the way can retry it (review finding #8). The model step calls `Effect.orDie` before `Checkpoint.memo`, so the typed `AiError` becomes a defect, and the memo stores it like any other non-interrupt exit. Re-executing the run replays the stored failure. This hurts `Runner.makeWorkflow` most, since durability is the point of using it. The README's advice to "retry with a new `runId`" still works, but it hands every transient fault to the client and the user.

## What Changes

- **Retry a model call that fails before it streams anything.** If `LanguageModel.streamText` fails with an `AiError` whose `isRetryable` is true before the step has emitted its first part, the step retries the call. It waits for the error's `retryAfter` when one is given, and otherwise follows the configured schedule. The client has seen nothing yet and the step has collected no parts, so a retry can't show or store anything twice. The retry runs inside the memo, so a step that succeeds after a retry is stored as a success.
- **Make the retry policy configurable.** A schedule and an attempt limit, with a conservative default. Whether it lives on `Agent.define` or on the runner options is for the design to decide. Evals that call `Agent.run` directly should get the same behaviour.
- **Mid-stream failures still fail the step.** Once a part has been emitted, the step fails as it does today. AG-UI has no event that takes a partial message back, so a retry would show the client the text twice. Out of scope.
- **Tool failures are not retried by the library.** Only a tool's author knows whether its handler is safe to run twice. The docs say that handlers retry their own transient failures.
- **The docs** cover what is retried and what is not, the policy option, and that a retried step is replayed from the memo as one success. They also mention `HttpClient.retryTransient` as a lower-level option.

## Capabilities

### New Capabilities
- `model-step-retry`: which model failures are retried, when (only before the first part), under what policy, and how a retry relates to the step's memo and events.

### Modified Capabilities
<!-- None: agent-run and its memo requirements come in with run-context, which is not archived yet. If it is archived first, this change modifies agent-run instead of adding a new capability. -->

## Impact

- **`packages/effentic/src/Agent.ts`:**
  - The model step catches `AiError` before `orDie`.
  - It tracks whether a part has been emitted, and retries with the configured schedule.
  - Its `StepStarted` and `messageId` are generated once per step, not once per attempt.
- **Options type:** a new optional retry option on the agent or the runner. The change is additive and doesn't break any caller.
- **Tests:** a model layer that fails N times before streaming and then succeeds; a mid-stream failure that is not retried; a non-retryable error that is not retried; and a ledger replay after a retried success.
- **Docs:** the README sections on checkpoints and errors, and `AGENTS.md`.
- **Ordering:** independent of `thread-history-sync`. Builds on `run-context`'s thread-scoped memo keys.
