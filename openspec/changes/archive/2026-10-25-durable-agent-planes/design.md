# Design

This document is written as a handoff: it fixes names, signatures and algorithms so that implementation needs no further design decisions. Where it cites a library API, the API was verified in the installed `effect@4.0.5` and `@ag-ui/core@1.0.3` / `@ag-ui/client@1.0.3`. See proposal.md for motivation.

## Context

**Current state.** `Agent.run` in `packages/effentic/src/Agent.ts` converts the client's full `messages` into a `Prompt`, calls `LanguageModel.streamText({ prompt, toolkit })` once per step, maps stream parts to AG-UI events inline (`handlePart` + `StepState`), folds the step's parts back into the prompt with `Prompt.fromResponseParts`, and loops while the finish reason is `tool-calls`. Tool handlers run *inside* `streamText`: `LanguageModel.make` (which both providers and the test `scriptedModel` go through) resolves tool calls itself and emits `tool-result` parts. `Agent.make` captures the context so a route can return a requirement-free stream. The server keeps no state.

**Decisions already taken with the user** (not re-opened here): the server owns the history and the client sends a delta; the delta is "client messages after the last stored message id"; commits happen per step; the library knows nothing about compaction and projects whatever the store returns; tool calls must execute at most once; crash/deploy resumes from the ledger; approvals use AG-UI's interrupt outcome and `resume` entries rather than `DurableDeferred`; whether a disconnect cancels the run is a choice of runner.

**Verified library facts the design relies on.**

- `LanguageModel.streamText` accepts `disableToolCallResolution: true`. Handlers are then not run; the stream still contains `tool-params-*`, `tool-call` and `finish` parts. Tool-call `params` are in *encoded* form in this mode (Effect decodes them against `Schema.toEncoded(tool.parametersSchema)`). `toolCallValidation` defaults to `"strict"`, so undeclared tool names are rejected by the model layer.
- `Toolkit.WithHandler.handle(name, encodedParams, toolCallId)` returns `Effect<Stream<Tool.HandlerResult>>`. `HandlerResult` has `result`, `encodedResult` (JSON-serialisable), `isFailure`, `preliminary`. The final result is the last element with `preliminary === false`. A tool with `failureMode: "return"` yields `isFailure: true` instead of failing the effect.
- `Tool.needsApproval` is `boolean | (decodedParams, { toolCallId, messages }) => boolean | Effect<boolean>`. Effect's own evaluation (`isApprovalNeeded`) decodes params with `tool.parametersSchema` and treats any error as `false`.
- `Prompt` has `tool-approval-request { approvalId, toolCallId }` parts on assistant messages and `tool-approval-response { approvalId, approved, reason? }` parts on tool messages, with constructors `Prompt.toolApprovalRequestPart` / `Prompt.toolApprovalResponsePart`. `Prompt.fromResponseParts` places a `Response` `tool-approval-request` part into the assistant message. Effect's denial result shape is `{ type: "execution-denied", reason }` with `isFailure: true`. Effect strips approval parts whose approvals are resolved before sending a prompt to a provider, because providers reject them.
- `Prompt.Prompt` and `Prompt.Message` are `Schema.Codec`s (JSON-encodable). `Response.makePart("tool-result", {...})` builds a result part.
- `effect/workflow`: `Workflow.make(tag, { payload, idempotencyKey, success?, error? })`, `workflow.toLayer(execute)`, `workflow.execute(payload, { discard })`, `Activity.make({ name, success, error, execute })` memoises a completed exit by activity name within an execution; `WorkflowEngine.layerMemory` for tests; `ClusterWorkflowEngine` for production. Activities require `WorkflowEngine | WorkflowInstance` in context, available inside `toLayer`'s `execute`.
- `@ag-ui/core`: `RunFinishedOutcome = success | interrupt { interrupts: Interrupt[] } | cancelled`; `Interrupt { id, reason, message?, toolCallId? }`; `RunAgentInput.resume?: ResumeEntry[]` with `ResumeEntry { interruptId, status: "resolved" | "cancelled", payload?: any }`; `STEP_STARTED` / `STEP_FINISHED { stepName }`. `@ag-ui/client`'s verifier accepts step events, and `HttpAgent` tracks pending interrupts and sends `resume` from `runAgent({ resume })`.
- `Effect.forkIn(scope)` exists; `PubSub.unbounded`, `PubSub.publish`, `PubSub.subscribe`, `Stream.fromSubscription` exist. Services are defined with `class X extends Context.Service<X, {...}>()("effentic/X")`.

## Goals / Non-Goals

**Goals:**

- One `Agent.define(...)` value runs under `Checkpoint.layerNone` with a scripted model in tests and under the workflow runner in production, producing identical model prompts.
- Every nondeterministic or side-effecting step of a run (model call, tool call, id minting) goes through exactly one `Checkpoint.memo`, so a replay is deterministic and side effects do not repeat.
- The library stays transport-agnostic and provider-agnostic, and keeps the two invariants in `packages/effentic/AGENTS.md`: the AG-UI stream never fails, and every emitted sequence is valid AG-UI.

**Non-Goals:**

- Compaction policy or summarisation. The caller rewrites what `Thread.load` returns.
- Redis, SQL or other production implementations of `Thread` and `EventLog`. The package ships in-memory layers and the interfaces; production stores are written by the application (or a later change).
- Frontend (client-executed) tools, reasoning round-trips, provider-executed tools. The design must not block them; see Open Questions.
- Public API stability (package is `0.0.1`).

## Decisions

### 1. Behaviour is a value: `Agent.define`

```ts
// Agent.ts
export interface Agent<Tools extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  readonly system: string | undefined;
  readonly maxSteps: number; // validated positive integer, default 10
}
export const define = <Tools>(options: {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  readonly system?: string | undefined;
  readonly maxSteps?: number | undefined;
}): Agent<Tools>;
```

`define` performs the `maxSteps` validation that `run` does today (throws `RangeError`). `clientSystem` moves off the agent: it is a trust policy of the AG-UI edge, so it becomes a `Runner` option. Nothing on `Agent` names a service.

### 2. The core loop is `Prompt → Stream<Agent.Event>`; AG-UI and messages are folds

```ts
// Agent.ts
export interface RunInput { readonly runId: string; readonly prompt: Prompt.Prompt }

export type Event =
  | { readonly _tag: "StepStarted"; readonly step: number; readonly messageId: string; readonly replayed: boolean }
  | { readonly _tag: "ModelPart"; readonly step: number; readonly messageId: string; readonly part: Response.AnyPart; readonly replayed: false }
  | { readonly _tag: "ToolResult"; readonly step: number; readonly messageId: string; readonly toolCallId: string; readonly toolName: string; readonly encodedResult: unknown; readonly isFailure: boolean; readonly replayed: boolean }
  | { readonly _tag: "ApprovalRequested"; readonly step: number; readonly approvalId: string; readonly toolCallId: string; readonly toolName: string; readonly replayed: boolean }
  | { readonly _tag: "StepFinished"; readonly step: number; readonly entries: ReadonlyArray<Thread.Entry>; readonly replayed: boolean }
  | { readonly _tag: "Finished"; readonly outcome: Outcome }
  | { readonly _tag: "Failed"; readonly error: unknown; readonly code: string | undefined };

export type Outcome =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Interrupted"; readonly approvals: ReadonlyArray<{ approvalId: string; toolCallId: string; toolName: string }> };

export type Requirements<Tools> = LanguageModel.LanguageModel | Checkpoint.Checkpoint | Tool.HandlersFor<Tools> | Tool.HandlerServices<...> | Tool.ParametersEncodingServices<...> | Tool.ResultDecodingServices<...>;

export const run = <Tools>(agent: Agent<Tools>) => (input: RunInput): Stream.Stream<Event, never, Requirements<Tools>>;
```

The stream never fails: any failure cause (other than interrupt-only) becomes one `Failed` event, after which the stream ends. `Finished` is always the last event of a successful run. `ModelPart` is emitted only from a live model stream (see decision 5), so a replayed step produces `StepStarted`, `ToolResult`s and `StepFinished` only.

*Alternative considered:* keep AG-UI as the native output and add services around it. Rejected: evals and the thread commit would have to parse AG-UI events back into messages, and the entries' ids would have to be smuggled through events.

### 3. Three services, and which runner requires which

| Service | Required by | Implementations in package |
|---|---|---|
| `Checkpoint` | `Agent.run` (core) | `layerNone`, `layerLedger` (over a caller `Ledger`), `layerWorkflow` |
| `Thread` | `Runner.*` (AG-UI edge) | `layerMemory` |
| `EventLog` | `Runner.makeDetached`, `Runner.workflow` | `layerMemory` |

`Checkpoint` is a hard requirement of the core rather than an optional service, so a missing layer is a type error, not a silent loss of durability. Tests and evals provide `Checkpoint.layerNone`. A request-scoped runner with `layerLedger` is meaningful: a client retry with the same `runId` does not re-run tools.

```ts
// Thread.ts
export const Entry = Schema.Struct({ id: Schema.String, message: Prompt.Message });   // Prompt.Message is the Codec; Entry.Encoded is JSON
export type Entry = typeof Entry.Type;
export class ThreadError extends Schema.TaggedError<ThreadError, { readonly brand: unique symbol }>()("ThreadError", { cause: Schema.Defect }) {}
export class Thread extends Context.Service<Thread, {
  readonly load: (threadId: string) => Effect.Effect<ReadonlyArray<Entry>, ThreadError>;
  readonly commit: (threadId: string, runId: string, entries: ReadonlyArray<Entry>) => Effect.Effect<void, ThreadError>;
  readonly runEnded: (threadId: string, runId: string, outcome: RunOutcome) => Effect.Effect<void, ThreadError>;
}>()("effentic/Thread") {}
export type RunOutcome = { _tag: "Success" } | { _tag: "Interrupted" } | { _tag: "Failed"; code: string | undefined };
export const layerMemory: Layer.Layer<Thread>;  // Map<threadId, Array<Entry>>; commit appends entries whose id is not present yet, in order
```

```ts
// Checkpoint.ts
export interface Memoized<A> { readonly value: A; readonly replayed: boolean }
export interface MemoOptions<A, I, E, EI> {
  readonly runId: string;
  readonly name: string;                        // unique within the run, see naming below
  readonly success: Schema.Codec<A, I>;
  readonly error: Schema.Codec<E, EI>;
}
export class Checkpoint extends Context.Service<Checkpoint, {
  readonly memo: <A, I, E, EI, R>(options: MemoOptions<A, I, E, EI>, effect: Effect.Effect<A, E, R>) => Effect.Effect<Memoized<A>, E, R>;
}>()("effentic/Checkpoint") {}

export interface Ledger {   // the "arbitrary ledger" seam; implemented by the caller over any store
  readonly get: (runId: string, name: string) => Effect.Effect<Option.Option<unknown>, LedgerError>;  // stored encoded Exit
  readonly set: (runId: string, name: string, exit: unknown) => Effect.Effect<void, LedgerError>;
}
export class LedgerError extends Schema.TaggedError<LedgerError, { readonly brand: unique symbol }>()("LedgerError", { cause: Schema.Defect }) {}
export const layerNone: Layer.Layer<Checkpoint>;                 // runs the effect, replayed: false
export const layerLedger: Layer.Layer<Checkpoint, never, Ledger>; // Ledger is itself a Context.Service "effentic/Checkpoint/Ledger"
export const layerMemoryLedger: Layer.Layer<Ledger>;              // Map keyed by `${runId}\u0000${name}`; for tests and local dev
export const layerWorkflow: Layer.Layer<Checkpoint, never, WorkflowEngine | WorkflowInstance>;
```

Semantics of `memo`: the completed exit (success *or* failure) of the first execution is encoded with `Schema.toCodecJson(Schema.Exit(success, error, Schema.Defect()))` (`Schema.Exit` takes positional arguments; the JSON codec makes the stored value plain JSON) and stored; a later call with the same `(runId, name)` decodes it and returns `{ value, replayed: true }` or re-fails with the stored error. An interrupted or crashed attempt stores nothing, so a resumed run re-executes it. Ledger errors are defects (`Effect.orDie`), since the loop cannot report them meaningfully in-band beyond `Failed`.

`layerWorkflow`: captures `Effect.context<WorkflowEngine | WorkflowInstance>()` when the layer is built and implements `memo` as `Activity.make({ name, success, error, execute: effect.pipe(Effect.tap(() => Effect.sync(() => { ran = true })) ) })` provided with that context, returning `replayed: !ran`. The `runId` is ignored; the workflow execution already scopes activity names. This layer must be built inside a workflow execution (decision 8).

```ts
// EventLog.ts
export interface Stored { readonly cursor: string; readonly event: AgUi.Event }
export class EventLogError extends Schema.TaggedError<EventLogError, { readonly brand: unique symbol }>()("EventLogError", { cause: Schema.Defect }) {}
export class EventLog extends Context.Service<EventLog, {
  readonly append: (runId: string, event: AgUi.Event) => Effect.Effect<Stored, EventLogError>;
  readonly read: (runId: string, after?: string | undefined) => Effect.Effect<ReadonlyArray<Stored>, EventLogError>;
  readonly subscribe: (runId: string, after?: string | undefined) => Stream.Stream<Stored, EventLogError>;
}>()("effentic/EventLog") {}
export const layerMemory: Layer.Layer<EventLog>;
```

Cursors are opaque strings, strictly increasing within a run, assigned by the log (decision 7 explains why not by the loop). `subscribe` yields history after `after`, then live events, and completes after it has yielded a terminal event (`RUN_FINISHED` or `RUN_ERROR`). Subscribing to a run that has not started yields nothing until events arrive. In-memory implementation: per run `{ events: Array<Stored>, pubsub: PubSub<Stored> }`; cursor is the zero-based index as a string; `subscribe` opens the PubSub subscription first, then snapshots history, then drops live events whose cursor is not greater than the last history cursor, and ends with `Stream.takeUntil(isTerminal)` (inclusive).

### 4. Tool execution is split out of the model call

Per model step `k` (1-based):

1. **Model checkpoint** `model:${k}`. Body: mint `messageId` with `IdGenerator` (via `Effect.serviceOption`, falling back to `defaultIdGenerator`, as today); run `LanguageModel.streamText({ prompt: modelPrompt, toolkit: agent.toolkit, disableToolCallResolution: true })`; for each part emit `ModelPart` live and collect the part; on completion return
   ```ts
   { messageId, assistant: Prompt.Prompt /* Prompt.fromResponseParts(parts) */, toolCalls: Array<{ id, name, params: unknown /* encoded */ }>, finishReason: string }
   ```
   with success schema `Schema.Struct({ messageId: Schema.String, assistant: Prompt.Prompt, toolCalls: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, params: Schema.Unknown })), finishReason: Schema.String })` and error schema `Schema.Never`. A model `error` part fails the body with `ModelStreamError` (as today). Model and tool bodies are wrapped in `Effect.orDie` before `memo`, so a failure is stored (and replayed) as a defect; the run turns any non-interrupt cause into `Failed` with the original error, so the typed channel adds nothing, and an `unknown` error channel is rejected by the Effect lint rules. Storing the prompt delta rather than the raw stream parts avoids needing a toolkit-specific parts codec; replay does not need the deltas because the event log already has them.
   Emitting live parts from inside a memoised body: the body writes to a `Queue` that the surrounding stream drains (`Stream.fromQueue` merged with the checkpoint effect), or equivalently the step is `Stream.unwrap` of an effect that forks the checkpoint and returns the queue stream. Either is acceptable; the test is that `ModelPart` events arrive before the checkpoint completes.
2. **Tool checkpoints** `tool:${toolCallId}`, one per tool call, run with `Effect.forEach(..., { concurrency: "unbounded" })` after the model checkpoint completes. Body:
   - if the call was pre-resolved by a resume entry (decision 6) use that decision; otherwise evaluate `needsApproval` exactly as Effect does: `undefined` → false; boolean → itself; function → decode params with `Schema.decodeUnknownEffect(tool.parametersSchema)`, call with `{ toolCallId, messages: modelPrompt.content }`, await if an effect, any error → false.
   - approval needed → mint `approvalId`, return `{ _tag: "ApprovalRequested", approvalId }`.
   - denied → mint `messageId`, return `{ _tag: "Result", messageId, encodedResult: { type: "execution-denied", reason }, isFailure: true }`.
   - otherwise `yield* toolkit.handle(name, params, id)`, take the last non-preliminary `HandlerResult` (die if none, as Effect does), mint `messageId`, return `{ _tag: "Result", messageId, encodedResult, isFailure }`.
   Success schema: `Schema.Union([Schema.TaggedStruct("Result", { messageId: Schema.String, encodedResult: Schema.Unknown, isFailure: Schema.Boolean }), Schema.TaggedStruct("ApprovalRequested", { approvalId: Schema.String })])`; error schema `Schema.Never` (body wrapped in `Effect.orDie`, as for the model step). A handler with `failureMode: "error"` fails the body and therefore the run (`Failed`), matching today. The `toolkit` with handlers comes from context via `agent.toolkit` (`Toolkit.Toolkit` resolves to `WithHandler` through `Tool.HandlersFor` in context; `yield* agent.toolkit` gives the `WithHandler`, as `LanguageModel` does internally).
   Tool calls are executed only when `finishReason` is `"tool-calls"` or `"stop"`. For any other finish reason each call gets, without a checkpoint body running the handler, the failed result `{ type: "execution-interrupted", reason: \`Tool call execution was interrupted because the response finished with reason "${finishReason}"\` }` (Effect's shape), still minted through a `tool:` checkpoint so the id is stable.
3. **Step entries.** Build `entries`:
   - assistant entry: `{ id: messageId, message }` where `message` is the assistant message of `Prompt.fromResponseParts([...modelParts /* or on replay: the stored assistant prompt's content */, ...approvalRequestParts])`, i.e. the stored `assistant` message with one `tool-approval-request` part appended per `ApprovalRequested` (use `Prompt.makeMessage("assistant", { content: [...existing, Prompt.toolApprovalRequestPart({ approvalId, toolCallId })] })`).
   - one tool entry per `Result`: `{ id: result.messageId, message: Prompt.makeMessage("tool", { content: [Prompt.makePart("tool-result", { id: toolCallId, name, result: encodedResult, isFailure, providerExecuted: false })] }) }`.
   Emit `ToolResult` / `ApprovalRequested` events, then `StepFinished { step: k, entries }`.
4. **Continue or finish.** If any `ApprovalRequested` → `Finished { Interrupted, approvals }`. Else if `finishReason === "tool-calls"` and `toolCalls.length > 0` → `prompt_{k+1} = Prompt.concat(prompt_k, Prompt.fromMessages(entries.map(e => e.message)))`, go to step `k+1` (if `k + 1 > maxSteps` → fail with `StepLimitExceeded`, as today). Else → `Finished { Success }`.

The prompt given to the model (`modelPrompt`) is `prompt_k` with every `tool-approval-request` and `tool-approval-response` part removed and messages left empty dropped. By the time a model call happens all approvals are resolved (decision 6), so this matches Effect's `stripResolvedApprovals`.

*Alternative considered:* one checkpoint per whole step with handlers inside `streamText`. Rejected: a crash after a handler ran but before the step completed would re-run the handler.

### 5. Step 0 resolves approvals carried by the prompt

Before step 1, `run` scans `input.prompt` (Effect's `collectToolApprovals` logic): for each `tool-approval-response` whose `approvalId` matches a `tool-approval-request`, find the `tool-call` with that `toolCallId`; if no `tool-result` for that id exists anywhere, it is pending: approved → run the `tool:${id}` checkpoint with the decision "approved" (skips `needsApproval`); denied → the denial result with `reason` from the response (default `"denied"`). These produce `ToolResult` events with `step: 0` and one `StepFinished { step: 0, entries }` (tool entries only), and are added to the prompt before step 1, placed directly after their calls with `orderToolResults` (see decision 6) rather than appended: the prompt may continue past the calls, e.g. with a user message sent alongside the approval answer. Step 0 emits no `StepStarted` and is not counted against `maxSteps`. If nothing is pending, step 0 emits nothing.

### 6. Server-owned history: entries, delta, resume, projection

`Messages.ts` becomes a set of pure functions over `Thread.Entry`:

- `delta(stored: ReadonlyArray<Entry>, client: ReadonlyArray<AgUi.Message>): Result<ReadonlyArray<AgUi.Message>, HistoryMismatch>` (Effect v4's `Result`, which replaces `Either`). If `stored` is empty, the whole client list is the delta. Otherwise find the last client message whose `id` equals some stored entry id; the delta is everything after it. If none matches, `HistoryMismatch` (a `Schema.TaggedError`, carried in-band as `RUN_ERROR` with code `HistoryMismatch`).
- `ingest(delta, { clientSystem }): ReadonlyArray<Entry>`: `user` with non-empty text → `{ id: message.id, message: user(text) }`; `system`/`developer` with non-empty text → system entry only when `clientSystem === "allow"`; every other role is dropped (the server writes assistant and tool turns itself).
- `resume(stored, resume: ReadonlyArray<AgUi.ResumeEntry>): ReadonlyArray<Entry>`: pending requests are `tool-approval-request` parts with no `tool-approval-response` in `stored`. For each pending request answered by a resume entry: `approved = status === "resolved" && payload?.approved === true` (default deny), `reason = payload?.reason ?? (status === "cancelled" ? "cancelled" : "denied")`. Pending requests with no resume entry are denied with reason `"not answered"`, so one lost answer does not block the thread for ever. Each response becomes a tool entry `{ id: \`${approvalId}:response\`, message: tool([toolApprovalResponsePart({ approvalId, approved, reason })]) }`. Resume entries that match no pending request are ignored.
- `project(system: string | undefined, entries): Prompt`: `[system message if non-empty, ...entries.map(e => e.message)]`, passed through `Agent.orderToolResults`, then the existing unanswered-call repair (`INCOMPLETE_TOOL_CALL_RESULT`) with one new exception: a tool call whose id has a `tool-approval-request` is skipped by the repair (it is resolved by decisions 5/6, not by a synthetic failure).

`toPrompt(messages, options)` is removed; `textOf` and the repair are reused by the functions above (`parseJson` is no longer needed, since client assistant and tool turns are not ingested).

**Tool results follow their calls.** Providers require each tool call's result directly after the assistant message that made it, but a result can be committed after later messages: an interrupted run's call is answered in the next run, which may also carry a new user message (or carry only a new user message, when the client ignores the interrupt and the call is denied as "not answered"). `Agent.orderToolResults(prompt)` therefore moves every `tool-result` and `tool-approval-response` part whose call is in the prompt to a tool message directly after the assistant message holding the call (one tool message per call), leaving all other messages in order. Entries are never dropped, summarised or reordered; only these parts move. It lives in `Agent.ts` because both step 0 (decision 5) and `project` use it. For the same reason the pipeline commits the approval responses before the ingested delta (decision 8).

### 7. Event log cursors come from the log; replay does not re-publish

An earlier sketch had the loop assign sequence numbers deterministically so `append` could be idempotent. That does not survive retries: if attempt 1 of step `k` published partial events `n..n+9` and crashed before the model checkpoint committed, attempt 2 produces a *different* model output, so a deterministic numbering would either collide with or silently drop the new events. Therefore:

- The log assigns cursors. `append` is append-only.
- Replayed steps publish nothing. The AG-UI fold (decision 9) drops every `Agent.Event` with `replayed: true`; completed steps are memoised, so a resumed run never re-publishes them, and a step that was not memoised is executed live again with fresh ids.
- On resume, the detached runner first calls `EventLog.read(runId)`: if the last stored event is terminal the run is already complete and the runner does nothing. Otherwise `AgUi.closeOpen(history)` finds the text messages, tool calls *and steps* left open by the crashed attempt, and the runner appends the matching `TEXT_MESSAGE_END` / `TOOL_CALL_END` / `STEP_FINISHED` events before any new event. It also drops the new attempt's `RUN_STARTED`, since the log already has one. Both are required by `@ag-ui/client`'s verifier, which rejects a second `RUN_STARTED` while a run is active and a `STEP_STARTED` for a step that is still active (the retried step reuses its `step-<n>` name). A reconnecting client thus sees the aborted partial message and step closed, followed by the retried step under a new `messageId`.
- `Thread.commit` is not memoised; it is idempotent by entry id, and entry ids come from memoised checkpoints, so a replay re-commits the same ids harmlessly.

### 8. Runners

```ts
// Runner.ts
export interface Options { readonly clientSystem?: "allow" | "drop" | undefined }  // default "drop"

export const run = <Tools>(agent: Agent<Tools>, options?: Options) =>
  (input: AgUi.RunAgentInput): Stream.Stream<AgUi.Event, never, Agent.Requirements<Tools> | Thread>;
export const make = <Tools>(agent, options?) =>
  Effect.Effect<(input: AgUi.RunAgentInput) => Stream.Stream<AgUi.Event>, never, Agent.Requirements<Tools> | Thread>;   // captures context, like today's Agent.make

export const makeDetached = <Tools>(agent, options?) =>
  Effect.Effect<{ readonly start: (input: AgUi.RunAgentInput) => Effect.Effect<void> }, never, Agent.Requirements<Tools> | Thread | EventLog | Scope.Scope>;

export const workflow = <Tools>(agent, options?) => {
  readonly workflow: Workflow.Workflow<"effentic/Run", typeof AgUi.RunAgentInput, Schema.Void, Schema.Never>;
  readonly layer: Layer.Layer<never, never, Exclude<Agent.Requirements<Tools>, Checkpoint> | Thread | EventLog | WorkflowEngine>;
};
```

All runners share one pipeline, `pipeline(agent, options)(input): Stream<AgUi.Event, never, ...>`:

1. `entries = Thread.load(threadId)`; `delta`, `ingest`, `resume` as in decision 6; `Thread.commit(threadId, runId, [...responses, ...ingested])` (answers to the previous run come before anything new the client says).
2. `prompt = project(agent.system, [...entries, ...responses, ...ingested])`, memoised with `Checkpoint.memo({ runId, name: "prompt", success: Prompt.Prompt, error: Schema.Never })` so a resumed run uses the prompt the crashed attempt used even if the thread was compacted in between.
3. `Agent.run(agent)({ runId, prompt })`, with `Stream.tap` committing `StepFinished.entries` and calling `Thread.runEnded` on `Finished` / `Failed`.
4. `AgUi.fold(input)` (decision 9).
5. Any failure before the core starts (`ThreadError`, `HistoryMismatch`, ledger defects), and any failure of a later `commit` / `runEnded`, is turned into a `Failed` event, and so by the fold into `RUN_ERROR { code: tag }` (preceded by `RUN_STARTED` when nothing else was emitted), so the stream never fails. `runEnded` is called only for the core's own `Finished` / `Failed`.

- `run` / `make`: return the pipeline stream; the consumer's interruption cancels the run (today's behaviour, now scoped to these runners).
- `makeDetached`: `start` reads the log and returns at once if it ends with a terminal event (before forking, so this is observable when `start` returns); otherwise it performs the rest of decision 7's resume handling inside `Effect.forkIn(scope)` of `pipeline(...).pipe(Stream.runForEach(event => EventLog.append(runId, event)))` and returns immediately. Dropping an HTTP response never reaches the run. Calling `start` again with the same input (after a crash) re-runs the pipeline; with `Checkpoint.layerLedger` it replays. This runner is for callers with their own ledger and process supervision.
- `workflow`: `Workflow.make("effentic/Run", { payload: AgUi.RunAgentInput, idempotencyKey: (input) => input.runId })`; `layer = workflow.toLayer((input) => the detached body above, provided with Checkpoint.layerWorkflow)`. Starting is `workflow.execute(input, { discard: true })`; starting again with the same `runId` joins the existing execution or, after a restart with a durable engine, replays it. Resuming a crashed execution is the engine's concern (`workflow.resume(executionId)` with `executionId = yield* workflow.executionId(input)`); the package documents this and does not wrap it.

### 9. AG-UI projection (`AgUi.fold`)

`AgUi.fold(input: { threadId, runId })(events: Stream<Agent.Event>): Stream<AgUi.Event>` moves `handlePart` and `StepState` out of `Agent.ts` unchanged in logic, and maps:

| `Agent.Event` | AG-UI |
|---|---|
| (stream start) | `RUN_STARTED { threadId, runId, protocolVersion }` |
| `replayed: true` (any tag) | nothing |
| `StepStarted { step, messageId }` | `STEP_STARTED { stepName: \`step-${step}\` }`; new `StepState(messageId)` |
| `ModelPart` text / tool-params / tool-call | as today (`TEXT_MESSAGE_*`, `TOOL_CALL_START/ARGS/END`) |
| `ModelPart` finish / reasoning / other | nothing |
| `ToolResult { messageId, toolCallId, encodedResult }` | `TOOL_CALL_END` if the call is still open, then `TOOL_CALL_RESULT { messageId, toolCallId, content: JSON.stringify(encodedResult ?? null), role: "tool" }` (step 0 results have no open call) |
| `ApprovalRequested` | nothing in-stream (carried by the outcome) |
| `StepFinished { step }` | `state.close()` events, then `STEP_FINISHED { stepName }` only if the fold emitted the matching `STEP_STARTED` (step 0 emits no step events; a step whose model call was replayed but whose tool calls ran live emits no step events either, since the verifier rejects finishing a step that was not started) |
| `Finished { Success }` | `RUN_FINISHED { outcome: { type: "success" } }` |
| `Finished { Interrupted, approvals }` | `RUN_FINISHED { outcome: { type: "interrupt", interrupts: approvals.map(a => ({ id: a.approvalId, reason: "tool-approval", toolCallId: a.toolCallId, message: \`Approve call to ${a.toolName}?\` })) } }` |
| `Failed { error, code }` | `state.close()` events, then `RUN_ERROR { message, code }` |

`pendingToolCallIds` is no longer produced: every call the model makes is answered by a checkpoint or turns into an approval interrupt. `AgUi.ts` gains constructors `stepStarted`, `stepFinished`, `runInterrupted`, the helpers `isTerminal` and `closeOpen` (decision 7), the `Event` union gains `StepStartedEvent | StepFinishedEvent`, and `RunAgentInput` gains `resume: Schema.optional(Schema.Array(ResumeEntry))` with `ResumeEntry = Schema.Struct({ interruptId: Schema.String, status: Schema.Literals(["resolved", "cancelled"]), payload: Schema.optional(Schema.Unknown) })`.

### 10. Identifiers

Every id (`messageId` per step, `messageId` per tool result, `approvalId`) is minted inside the checkpoint that owns it, so a replay sees the same ids and a re-executed (non-memoised) attempt gets fresh ones. `IdGenerator` stays optional in context with `defaultIdGenerator` as fallback, so `counterIds()` in tests still makes ids deterministic. Tool-call ids and `threadId` / `runId` pass through unchanged, as before.

### 11. SSE

`Sse.encodeEvent(event, id?)` sets the SSE `id` field when given. `Sse.encodeStored(stream: Stream<EventLog.Stored>)` maps each stored event with its cursor as `id`. `Sse.encode` is unchanged. Reading `Last-Event-ID` and calling `EventLog.subscribe(runId, lastEventId)` is the caller's route code; the example shows it.

### 12. Module layout and exports

```
packages/effentic/src/
  Agent.ts         define, run, Agent, RunInput, Event, Outcome, Approval, Requirements, StepLimitExceeded, ModelStreamError,
                   errorMessage, errorCode, stripApprovals, orderToolResults
  AgUi.ts          schemas (+ resume), event constructors (+ step, interrupt), isTerminal, fold, closeOpen
  Messages.ts      delta, ingest, resume, project, HistoryMismatch, INCOMPLETE_TOOL_CALL_RESULT
  Thread.ts        Entry, Thread, ThreadError, RunOutcome, layerMemory
  Checkpoint.ts    Checkpoint, Memoized, MemoOptions, Ledger, LedgerError, layerNone, layerLedger, layerMemoryLedger, layerWorkflow
  EventLog.ts      EventLog, Stored, EventLogError, layerMemory
  Runner.ts        Options, run, make, makeDetached, workflow
  Sse.ts           contentType, encodeEvent, encode, encodeStored
  index.ts         export * as AgUi, Messages, Agent, Sse, Thread, Checkpoint, EventLog, Runner
```

### 13. Testing strategy

- `scriptedModel` is unchanged: `LanguageModel.make` honours `disableToolCallResolution`, so handlers no longer run inside the fake model and the loop's own tool checkpoints are exercised.
- `fixtures.ts` gains: `countingWeatherLayer()` returning `{ layer, calls: Array<string> }` to assert at-most-once execution; `SendEmail` tool with `needsApproval: true` and `failureMode: "return"`, and `ApprovalToolkit = Toolkit.make(GetWeather, SendEmail)`; `countingApprovalLayer()` recording weather calls and email recipients; `evalLayers = Layer.mergeAll(Checkpoint.layerNone, counterIds())`, where `counterIds` builds a fresh counter each time its layer is built; `runAgUi(agent, inputs)` helper that runs several `RunAgentInput`s through `Runner.run` and returns the AG-UI events per run (already `verify`-ed), with the caller providing one `Thread` layer (and the scripted model, whose prompts it reads) around it.
- Core tests (`Agent.test.ts`) assert on `Agent.Event` and on prompts. AG-UI tests (`AgUi.test.ts`, now also covering `fold`) assert on events and always pass them through `verify`.
- Replay tests use `Checkpoint.layerLedger` + `layerMemoryLedger` shared between two runs of the same `runId`, with a model script that fails after the first step's tool call in run 1 and succeeds in run 2.
- `layerWorkflow` / `Runner.workflow` are smoke-tested with `WorkflowEngine.layerMemory`: a happy-path run inside the workflow produces the same events as the request-scoped runner and calls each handler once.

## Risks / Trade-offs

- [`effect/workflow` and `effect/ai` are unstable] → All workflow use is confined to `Checkpoint.layerWorkflow` and `Runner.workflow`; everything else works with `layerNone` / `layerLedger`.
- [Tool-call `params` are encoded in disabled-resolution mode] → `toolkit.handle` expects encoded params, so pass them through; decode explicitly only for `needsApproval` functions. A test pins that a weather call round-trips.
- [Providers reject approval parts] → Strip them from every prompt sent to the model (decision 4); keep them in the committed thread only.
- [A tool result committed after later messages breaks the provider's call/result pairing] → `orderToolResults` (decision 6) places results directly after their calls in every prompt; a test covers an ignored interrupt followed by a new user message.
- [A crashed attempt leaves a half-written message in the event log] → Decision 7 closes its spans and step on resume; the retried step uses a new `messageId`, so the client shows an aborted message followed by the real one.
- [A model-step failure is memoised] → Intended: a failed run is terminal (`RUN_ERROR`); the client retries with a new `runId`. Only in-flight (interrupted) runs are resumed.
- [`Prompt.fromResponseParts` is fed streaming parts] → Already relied on today; a core test asserts the assistant prompt built from `text-delta` parts.
- [Default-deny on malformed resume payloads] → A resolved entry without `payload.approved === true` denies the tool. Documented on `ResumeEntry`; the example client sends `{ approved: true }`.
- [In-memory `Thread` / `EventLog` lose state on restart] → They are for tests, local dev and the example; the interfaces are the product.
- [Every run loads the whole thread] → Acceptable now; compaction is the caller's lever and the interface takes a thread id, so a store can page or summarise internally.

## Migration Plan

Single change, no deployed consumers. Implement in the order of tasks.md (services first, then the core, then folds, runners, example). The example switches to `Runner.make` + `Thread.layerMemory` and adds `GET /runs/:runId/events` backed by `EventLog.layerMemory` with the detached runner. On archive, the delta specs replace the history and cancellation requirements of the two existing capabilities. Rollback is reverting the change.

## Open Questions

- **Frontend tools** (`RunAgentInput.tools`): would appear as tool calls with no handler; the natural fit is an `Interrupted`-style outcome and client-supplied results arriving as delta tool messages, which `ingest` currently drops. Deferred; nothing here precludes it.
- **Reasoning parts**: the stored assistant prompt keeps them (and provider options such as signatures), the AG-UI fold drops them. Emitting `REASONING_*` events can be added to the fold later without touching the core.
- **Compaction helpers**: a `Thread` decorator that summarises on `runEnded` could ship later; the current interface already supports it.
