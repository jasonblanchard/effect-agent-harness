# Core Effect Comparison Audit

_Audited 2026-11-27 against `effect@4.1.4`, the pinned version._

This audit asks, for each abstraction `effect-agent-harness` builds itself, whether a module in core Effect could replace it. It covers every module in the installed package: `effect`, `effect/ai`, `effect/persistence`, `effect/workflow`, `effect/eventlog`, `effect/cluster`, `effect/encoding` and the rest. Sources are the package's own code and doc comments, not web docs.

## Summary

- **No custom module can be replaced by a core one.** Each one either already sits on core Effect or differs from its nearest core counterpart on purpose. Those differences come from what the harness guarantees: approvals, subagents, resumable runs, cancellation, and server-owned threads.
- **Two functions copy Effect internals that aren't exported.** They can't be reused, but they need checking whenever `effect` is bumped.
- **Two small follow-ups are optional:**
  - Two switches control the same tool-arguments span attribute.
  - SQL-backed store layers could be added on `effect/sql`.

## Already built on core Effect

| Harness                                             | Core Effect it uses                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| AG-UI protocol types and HTTP binding               | `effect/ai` `AgUiSchema`, `AgUiServer.endpoint` / `handler`                       |
| The run's AG-UI input, as tools and prompts read it | `effect/ai` `AgUiServer.RunInput`, the service `AgUiServer.agent` provides        |
| `Runner.toAgUiServerAgent`                          | `effect/ai` `AgUiServer.Agent`, served by `AgUiServer.layerHttp` / `agentHandler` |
| A failed `TOOL_CALL_RESULT`'s marker                | `effect/ai`'s `metadata["effect/ai"].isFailure`, which `AgUi.toPrompt` reads      |
| Model calls, tools, toolkits, ids                   | `LanguageModel.streamText`, `Tool`, `Toolkit`, `IdGenerator`                      |
| Prompt and entry content                            | `Prompt` (each `Messages.Entry` wraps a `Prompt.Message`)                         |
| `Runner.makeWorkflow`, `Checkpoint.layerWorkflow`   | `effect/workflow` `Workflow`, `Activity`, `DurableDeferred`, `WorkflowEngine`     |
| `Checkpoint.layerKeyValueStore`                     | `effect/persistence` `KeyValueStore`                                              |
| Model span attributes                               | `effect/ai` `Telemetry.CurrentSpanTransformer` and its `gen_ai.*` attributes      |
| `EventLog.layerMemory`                              | `PubSub`, `Stream`                                                                |
| Runner signals, timeouts, cancel polling            | `Deferred`, `Queue`, `Fiber`, `Schedule`, `Effect.race`                           |
| Errors                                              | `Schema.TaggedError`                                                              |

## Module by module

### `Thread`: keep

**Nearest core counterpart:** `effect/ai` `Chat.Persistence` over `BackingPersistence`.

`Chat.Persistence` stores each chat as one blob holding the whole `Prompt`. It saves once, when a `Chat.streamText` call ends, and the last write wins. It can only be used through `Chat`'s own model loop. Replacing `Thread` with it would lose:

- **An id per entry.** The client delta, `HistoryMismatch` and `HistoryDiverged`, and `restore` all match messages by AG-UI id. `Chat` gives one id per turn, kept in provider options.
- **One active run per thread.** `Chat` has nothing like `claim`, `ThreadBusy`, `activeRun` or `release`, and its `Semaphore` only works within one process. `activeRun` is also what `restore({ rejoin })` relies on.
- **An idempotent commit after every step.** Resumed detached and workflow runs depend on committing again being safe.
- **`runId` and `subagentRunId` on each entry.** `Messages.project` needs `subagentRunId` to separate a subagent's transcript from its parent's.
- **The `runEnded` hook and the compaction contract.**

A `Thread` adapter over `BackingPersistence` or `KeyValueStore` would be possible for `load` and `commit`. But neither store has a compare-and-set, so `claim` couldn't be made atomic, and the adapter would only be safe in a single process.

### `Agent`: keep

**Nearest core counterparts:** `AgUiServer.agent`, `Chat.streamText` with `maxSteps`, and `LanguageModel`'s own tool resolution and approvals.

`AgUiServer.agent` is a complete AG-UI agent, but it has no approvals, subagents, checkpoints, cancellation or server history. `Agent.run` now emits AG-UI itself, as `AgUiServer.agent`'s stream does, and provides the same `AgUiServer.RunInput`, so tools port between them unchanged and `Runner.toAgUiServerAgent` serves an agent wherever `AgUiServer.agent` is served. It calls `LanguageModel.streamText` with `disableToolCallResolution: true` and runs tool calls itself, because each call has to go through `Checkpoint.memo` and the cancellation guard, and a subagent call is run by the loop rather than by the toolkit.

### AG-UI event building (`internal/events.ts`): keep

**Nearest core counterparts:** `effect/ai` `AgUi.fromStreamParts`, `AgUi.withRunLifecycle`, `AgUi.toPrompt`.

- **`fromStreamParts`** converts raw `Response` parts into AG-UI, as the loop's own step emitter (`internal/events.ts`) does. It can't stand in for it: it takes message ids from the provider, which aren't deterministic across a replay (the loop mints them inside checkpoints), derives no reasoning message ids that `History.restore` can reproduce, and emits no activity. Its failure marker is the one the loop adopts.
- **`withRunLifecycle`** ends any subagent still open with `SUBAGENT_ERROR`. It still wraps a run served through `AgUiServer.handler`, harmlessly: the run's own lifecycle is complete. The runners' internal `closeOpen` (`internal/publish.ts`) deliberately leaves subagents open, so the next attempt of a detached or workflow run can carry on with them. That makes the two incompatible.
- **`toPrompt`** returns a `Prompt` without message ids. The history conversions use it for user message content, but they need their own code for the rest, because they key everything by AG-UI id.

### `Checkpoint`: keep

The interface, `Checkpoint.memo`, is the harness's own, but every storage layer uses core Effect. `layerKeyValueStore` stores each step's `Exit` in `effect/persistence`'s `KeyValueStore`, which brings memory, file system, SQL and Web Storage backends. `layerWorkflow` wraps `effect/workflow` `Activity`. `layerNone` stores nothing.

### `EventLog`: keep

**Nearest core counterparts:** `effect/eventlog`, `PersistedQueue`.

- **`effect/eventlog`** is a local-first, replicated, optionally encrypted journal of typed events with handlers and compaction. It has nothing to do with a per-run log of AG-UI events with cursors for SSE reconnects, despite the shared name.
- **`PersistedQueue`** hands each item to one consumer, at least once. `EventLog.subscribe` gives every subscriber every event, in order, from a cursor.

### `Runner`: keep

**Nearest core counterparts:** `FiberMap`, `effect/cluster` entities.

- **`FiberMap`** looks like a fit for the `signals` map in `makeDetached`, but it isn't one. A cancel has to survive a crashed attempt so the next `start` sees it. And cancelling commits the partial step and ends the run in-band, rather than interrupting the fiber.
- **`effect/cluster` entities** would give one writer per thread across processes, which is the guarantee `Thread.claim` asks a durable store to provide. Adopting cluster would be an architectural choice for durable deployments, not a module swap.

### `History`, `Messages`, `internal/conversions`: keep

Nothing in core reconciles a client's AG-UI history against a stored thread by message id, or projects entries into a prompt with subagent ownership and approval state. User message content is converted with `AgUi.toPrompt`.

### `Telemetry`: keep, with one overlap

The library uses `effect/ai` `Telemetry` for the standard `gen_ai.*` attributes. Its own `Telemetry` module is just two `Context.Reference`s: `ContentCapture` and `SpanAttributes`. `internal/telemetry.ts` formats messages and tool definitions into the GenAI conventions' JSON shapes, which `effect/ai` doesn't do.

The overlap is that `effect/ai`'s `Toolkit.RecordToolArguments` controls the same `gen_ai.tool.call.arguments` attribute that `ContentCapture` controls on the harness's tool spans. See follow-up 1.

## Copies of Effect internals that aren't exported

These functions in `Agent.ts` copy behaviour that `effect/ai` keeps private. They can't be swapped for an import. Check them whenever `effect` is bumped:

| Harness function   | Effect internal it copies                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalNeeded`   | `LanguageModel`'s `isApprovalNeeded`: a predicate gets the decoded parameters, and one that fails or throws means no approval is needed |
| `pendingDecisions` | `LanguageModel`'s `collectToolApprovals`                                                                                                |

If `effect/ai` ever exports the first two, switch to the exported versions.

## Optional follow-ups

1. **Tool-argument capture.** `Telemetry.layerCaptureContent` and `Toolkit.RecordToolArguments` both control `gen_ai.tool.call.arguments`, and both write it to the same `execute_tool` span. Either document that `layerCaptureContent` already covers it, or have `ContentCapture` read `RecordToolArguments` too, so users have one switch. This is low priority: turning both on just sets the same attribute twice.
2. **SQL store layers.** `effect/sql` (`SqlClient`) would make it possible to ship `Thread.layerSql` and `EventLog.layerSql`. A conditional `UPDATE` would make `claim` atomic, which `KeyValueStore` can't do. These would be new layers rather than replacements, and only worth building if users ask for a ready-made durable backend.
3. **Media in frontend tool results.** `answers` reduces a client `tool` message's content parts to text and logs a warning for the rest. `toPrompt` doesn't help here: it passes the content parts through as an unconverted result value. Supporting media in tool results would need its own design.

## Not relevant here

Looked at and judged out of scope:

- **`Decision`, `DecisionModel`:** structured classification.
- **`ResponseIdTracker`:** a provider-side concern.
- **`EmbeddingModel`, `Tokenizer`, MCP modules.**
- **`ExecutionPlan`:** model fallback is something callers already get by providing `LanguageModel`.
- **`PersistedCache`, `RateLimiter`, `CircuitBreaker`.**
- **`reactivity`, `rpc`, `cli`, `workers`.**
