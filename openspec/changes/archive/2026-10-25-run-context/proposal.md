## Why

Agents need to know about the run they are in, and today they can't. An agent's system prompt is part of its behaviour, but `Agent.run` never applies it: only the runner's projection (`Messages.project(agent.system, …)`) does, so an eval that calls `Agent.run` directly runs without it. The prompt is also a fixed string, so it can't include values that differ per run or per deployment (the user's name, the tenant's settings, today's date). Tool handlers are built once in a layer and learn nothing about the run either, so a tool can't act as the current user. And the only per-run data a run carries, its AG-UI input, is controlled by the client, so there is no trusted place for an identity the server has verified.

Putting a dynamic-prompt hook on the runner was considered and rejected, because evals would then have to go through the AG-UI runner to exercise it.

## What Changes

- Each run has **run info**: `runId`, `threadId`, `props` (optional, from the client, untrusted) and `context` (optional, set by the server, trusted). `Agent.RunInput` carries it. **BREAKING**: `Agent.run` requires a `threadId`.
- `Agent.run` provides the run info as an `Agent.CurrentRun` service while it resolves the system prompt and while it runs each tool handler. A tool declares `dependencies: [Agent.CurrentRun]` to read it. `CurrentRun` is not part of an agent's requirements, so nobody provides it.
- `Agent.define`'s `system` accepts a string or an effect producing the prompt: `string | Effect<string, never, R>`. The effect may read `CurrentRun` and any services `R` it declares. `R` becomes part of the agent's type and of its requirements, so an eval provides mock services and a deployment provides real ones. **BREAKING**: `Agent<Tools>` becomes `Agent<Tools, R = never>`, and `Agent.Requirements` takes the agent's `R`.
- `Agent.run` applies the system prompt itself, before the prompt it is given. An effect is resolved once per run and memoised as the `system` checkpoint, so a resumed run reuses the resolved text. **BREAKING**: the prompt passed to `Agent.run` must not include the agent's system prompt, and `Messages.project` no longer takes one.
- The runners fill the run info. `runId`, `threadId` and `props` come from the AG-UI input (`props` from `forwardedProps`, which the input decoder now keeps). `context` comes only from a new optional second argument: `runAgent(input, { context })` and `detached.start(input, { context })`. The workflow runner's payload becomes `{ input, context }`, so a resumed execution has the original context. **BREAKING** for `Runner.workflow` callers. The runner's `prompt` checkpoint now holds only the projection of the thread.
- Everything stored for a run is keyed by **thread id and run id**: checkpoints (`Checkpoint.MemoOptions`, `Ledger.get`/`set`), the event log (`append`/`read`/`subscribe`) and the workflow idempotency key. The client chooses the run id and the caller authorises only the thread, so before this a run id reused on another thread replayed that run's prompt, system prompt and tool results, joined its workflow execution and exposed its events. The runner also memoises the input (`input` checkpoint), and a run id reused on the same thread with a different input fails with `RunInputMismatch` before anything is committed. **BREAKING** for custom `Ledger` and `EventLog` implementations.
- **A run must answer every open interrupt.** A run that leaves a pending approval without a resume entry now fails with `RUN_ERROR` code `UnansweredInterrupt`, before anything is committed. Before this, the approval was denied as "not answered" and the run could finish as success, which AG-UI 1.0 forbids ("A producer MUST NOT … treat the omission as abandonment"). A client gives up on an approval by answering it `cancelled`. **BREAKING**: `Messages.resume` returns a `Result`.
- **One active run per thread.** The `Thread` store gains `claim` and `release`. Every runner claims the thread before loading it, and a run started while another is active ends with `RUN_ERROR` code `ThreadBusy` without touching the thread. The claim is released after `runEnded` and before the terminal event. Before this, two runs on one thread (a second tab, or a detached run still going) each planned against their own snapshot and interleaved their commits. `runEnded` is now called only for runs that claimed the thread. **BREAKING** for custom `Thread` implementations.
- **`Runner.workflow` takes a required `name`** (`Runner.workflow(agent, { name: "support" })`), in place of the fixed `"effentic/Run"`. The engine registers workflows by name and derives execution ids from it, so two agents on one engine replaced each other's registration and shared execution ids. **BREAKING** for `Runner.workflow` callers.
- Docs say what stays the caller's job:
  - authenticate the request and put the verified principal into `context`, not the raw token (the context is persisted, and a token can expire before a resumed run);
  - check that the principal may use the `threadId`, or namespace thread ids by user or tenant. That one check also covers the thread's runs, including routes that read a run's events.
- Out of scope, noted as a follow-up: splitting the system prompt into a stable part and a part that changes per run, placed separately so that prefix prompt caching keeps working across a long thread.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-run`: run info with `props` and `context`; the system prompt may be an effect; the run applies and memoises it; the current run is available to the system prompt and to tool handlers.
- `agui-agent-loop`: how the runner fills the run info from the AG-UI input and the caller's context; the memoised projection no longer includes the system prompt.
- `agui-agent-loop` also: a run id names one input on its thread; every open approval must be answered (replaces "Unanswered approvals are denied").
- `agui-transport-edge`: input decoding keeps `forwardedProps`; every runner accepts a per-run context, and the workflow runner persists it; the detached and workflow runners key runs by thread id and run id.
- `run-checkpoint`: steps are keyed by thread id, run id and name, in the memo options and in the ledger interface.
- `run-event-log`: runs are keyed by thread id and run id.
- `thread-store`: a thread has at most one active run (`claim`/`release`); the run-ended notification is only for runs that claimed the thread.
- `agui-agent-loop` also: one active run per thread, and the run-ended notification excludes runs rejected before claiming.

`agent-run`, `run-checkpoint`, `run-event-log`, `thread-store` and the current text of the `agui-*` requirements this change modifies are introduced by `durable-agent-planes`, so that change must be archived before this one.

## Impact

- `packages/effentic/src/Agent.ts`: `Agent`, `define`, `RunInfo`, `RunInput`, `CurrentRun`, `Requirements`, and `run` (system resolution, `system` checkpoint, `CurrentRun` around tools).
- `packages/effentic/src/Messages.ts`: `project` drops its system parameter; `resume` rejects unanswered approvals with `UnansweredInterrupt`.
- `packages/effentic/src/AgUi.ts`: `RunAgentInput` gains `forwardedProps`.
- `packages/effentic/src/Runner.ts`: every runner's types gain the agent's `R`; `run`/`make` streams and `detached.start` take an optional context; the workflow payload, idempotency key and name change; the pipeline checks the input (`RunInputMismatch`), passes run info and projects without the system prompt.
- `packages/effentic/src/Checkpoint.ts` and `EventLog.ts`: keys gain the thread id.
- `packages/effentic/src/Thread.ts`: `claim`, `release`, `ThreadBusy`, and claims in `layerMemory`.
- Tests that call `Agent.run`, `Messages.project` or the workflow runner, the fixtures, the README and `AGENTS.md`.
- `packages/examples/ag-ui`: a date-stamped system prompt, and a placeholder bearer-token check on every route that puts a principal in `context`; the events route becomes `GET /threads/:threadId/runs/:runId/events`.
