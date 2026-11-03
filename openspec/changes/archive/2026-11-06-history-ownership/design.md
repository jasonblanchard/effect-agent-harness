## Context

Every runner (`run`, `makeDetached`, `workflow`) shares one `pipeline` in `Runner.ts`. After the per-run layer and the input check, it:

1. calls `thread.claim`;
2. calls `thread.load`;
3. runs `Messages.delta`, then `Messages.resume`, `Messages.answers` and `Messages.ingest`;
4. calls `thread.commit`;
5. runs `Messages.project`, memoised as the `prompt` checkpoint;
6. runs `Agent.run`, with `thread.commit` on each `StepFinished`;
7. calls `endRun`, which runs `runEnded` and then `release` before the terminal event is emitted.

`run` also releases a cancelled run's claim in `Stream.ensuring`. A detached or workflow run that is interrupted keeps its claim, so that executing it again finishes it. `Requirements` always includes `Thread.Thread`, and `Options.clientSystem` feeds `Messages.ingest`.

Steps 1–4, the commit in 6, step 7 and `run`'s release are the only places that depend on who owns the transcript. Everything else (the per-run layer, the input check, the `prompt` memo, `Agent.run` and `fold`) does not.

The trust rules live in `Messages`:

- `ingest` drops client assistant and tool messages.
- `answers` accepts only results for calls the store marked as frontend calls.
- `resume` only answers approvals the store holds.

Approval ids are random. `Agent.run` mints one with `ids.generateId()` inside the `tool:<callId>` memo. Only the stored `tool-approval-request` part links the id to its call. `Agent.run`'s step 0, however, resolves approvals from prompt parts alone (`pendingDecisions`). It needs a request part, a response part and an unanswered call.

`Agent.run` already reads an optional service with a fallback: `Effect.serviceOption(IdGenerator.IdGenerator)`, defaulting to `IdGenerator.defaultIdGenerator`.

See proposal.md for the motivation and scope.

## Goals / Non-Goals

**Goals:**

- One pipeline with no branch: the history-dependent steps move behind a run attempt the `History` service opens.
- Client history with no wiring at all, and no `Thread` anywhere in a runner's types.
- The server history's behaviour unchanged, including when the claim is released.
- A public surface small enough to open later without breaking anything: a tag, two layers, and an opaque service type.

**Non-Goals:**

- **A public `History` contract.** The service's interface stays internal until its rerun rules are worth committing to (see Decision 2).
- **A client history that records to `Thread`.** It would be a third layer, using the same private interface, when someone needs it.
- **Input filters and guards.** They come later, probably as layers wrapping a `History`.
- **Detecting unanswered interrupts or frontend calls under client history.** See Open Questions.

## Decisions

### 1. `History` is an optional service with a client fallback

```ts
// src/History.ts
/**
 * The run's canonical history: where its prompt comes from, and what happens
 * to its steps and its end. Read from the run's context; a run without one
 * uses the client history ({@link layerClient}).
 */
export class History extends Context.Service<
  History,
  /** Opaque: get one from `layerClient` or `layerServer`. Its members are internal. */
  { readonly [TypeId]: TypeId }
>()("effentic/History") {}

/**
 * The client owns the transcript: the run's history is `input.messages` as
 * sent. Nothing is loaded, stored, claimed or released. The default.
 */
export const layerClient: Layer.Layer<History>;

/**
 * The server owns the transcript, in `Thread`: the run claims the thread,
 * loads it, takes from the client only its delta, its `resume` answers and
 * its results for pending frontend calls, rejects history that doesn't match
 * the store, commits each step, reports its end and releases the thread.
 */
export const layerServer: Layer.Layer<History, never, Thread.Thread>;
```

The pipeline reads it with `Effect.serviceOption(History)` and falls back to the client implementation.

- **Why optional rather than required:** a required service would put `History` in every runner's `Requirements`, and the client default would then need wiring. The fallback makes the default free: `Runner.run(agent)` requires neither `History` nor `Thread`. It follows the `IdGenerator` precedent.
- **Why a service rather than a runner option:**
  - `layerServer`'s need for `Thread` is resolved by layer composition, so `Requirements` simply drops `Thread`, with no type parameter that has to follow an option.
  - The choice can be made per request: `Stream.provide(History.layerServer)` on some runs and nothing on others, with the same runner.
- **Why export `layerClient` when it is the fallback:** a route can then force the client history inside a context where a server history is provided further out.
- **What is lost:** the choice isn't visible where the runner is built, and forgetting `layerServer` silently gives client history. Since client history is the intended default, forgetting the layer gives the default, which is acceptable. The README shows both setups.

**Where each runner reads it:**

- **`run`:** from the stream's context.
- **`makeDetached`:** from the context it captured when built, overridden by whatever is provided around `start`, since `start` merges its caller's context over the captured one.
- **`workflow`:** from the context its `layer` is built in. A workflow's execution replays from its persisted payload, which can't hold a service, so its history can't vary per request. That is documented on `workflow`.

### 2. `beginAttempt` opens a private `Attempt` for each attempt of a run

```ts
// src/internal/history.ts, not exported from the package
interface Service {
  readonly [TypeId]: TypeId;
  readonly beginAttempt: (input: AgUi.RunAgentInput, options: AttemptOptions) => Effect.Effect<Attempt, AttemptError>;
  /** Called by `run` when its stream stops before a terminal event, whether or not `beginAttempt` returned. */
  readonly abandonAttempt: (input: AgUi.RunAgentInput) => Effect.Effect<void>;
}

/** `ThreadError | ThreadBusy | HistoryMismatch | HistoryDiverged | UnansweredInterrupt | UnansweredToolCall`. */
type AttemptError = ...;

interface AttemptOptions {
  readonly clientSystem: "allow" | "drop" | undefined;
}

interface Attempt {
  /** The history the run starts from that is already persisted (`[]` for the client history). */
  readonly stored: ReadonlyArray<Messages.Entry>;
  /** What the run adds before the model is called. Projected after `stored`. */
  readonly added: ReadonlyArray<Messages.Entry>;
  /** Called with each step's entries. */
  readonly commit: (entries: ReadonlyArray<Messages.Entry>) => Effect.Effect<void, Thread.ThreadError>;
  /** Called once with the terminal event, before it is emitted. Returns the event to emit. */
  readonly end: (event: Terminal) => Effect.Effect<Agent.Event>;
}
```

The pipeline becomes:

```
layer → input memo → beginAttempt → memo "prompt" (project stored ++ added) → Agent.run (tap commit) → failInBand → end → fold
```

`run` calls `abandonAttempt` from its `Stream.ensuring` when the stream ends without a terminal event.

| Member         | Client history         | Server history                                                              |
| -------------- | ---------------------- | --------------------------------------------------------------------------- |
| `beginAttempt`        | `Messages.fromHistory` | claim, load, `delta`, `resume`, `answers`, `ingest`, commit (moved from Runner) |
| `stored`       | `[]`                   | what `load` returned                                                        |
| `commit`       | `Effect.void`          | `thread.commit`                                                             |
| `end`          | `Effect.succeed(event)` | `endRun` (moved from Runner)                                                |
| `abandonAttempt`      | `Effect.void`          | `release`, with errors logged (moved from `run`)                            |

- **Why `abandonAttempt` is on the service, not the attempt:** a stream can stop after the server history has claimed the thread but before `beginAttempt` returns (during `load`, say). `abandonAttempt` releases by thread id and run id, as `run` did before, so it covers that window. For the same reason, the server's `beginAttempt` reports a failure after its claim (`runEnded`, then `release`) itself before failing, since no attempt exists yet to `end`.
- **Why `abandonAttempt` and not a scoped `beginAttempt`:** a scoped claim would release whenever the attempt's scope closes. That changes two things today's design relies on:
  - a detached run interrupted by a graceful shutdown would release its claim, instead of keeping it until it is executed again;
  - the release would come after the terminal event, instead of before it, so a client that starts its next run immediately could hit `ThreadBusy`.

  An explicit `end` and `abandonAttempt` keep today's behaviour exactly. Because the interface is private, its tidiness costs nothing to revisit.
- **Why private:** `beginAttempt` runs again on every re-execution of a run. A correct implementation has to:
  - be idempotent across attempts (the server history relies on `delta` ignoring entries the same `runId` committed);
  - commit idempotently by id;
  - keep `end` and `abandonAttempt` consistent with when the claim is released.

  Those rules are what a public contract would have to document and test. Keeping the interface private lets the two shipped implementations prove them out first.
- **Why `stored`/`added` rather than a finished prompt:** the `prompt` memo and `Messages.project` stay in the pipeline, shared by both implementations. An attempt only decides which entries the run starts from.

### 3. Runner types and options

- **`Requirements`:** loses `| Thread.Thread`. Nothing else changes, including the type parameters.
- **`Options`:** no new field. `clientSystem` is passed to `beginAttempt`.
- **`workflow`'s `layer` type:** follows `Requirements` and so also loses `Thread`. A workflow with the server history provides `History.layerServer` to that layer.
- **`Thread`:** its service shape is unchanged. Its documentation says it is the server history's store, and "every runner claims the thread" becomes "the server history claims the thread".

### 4. `Messages.fromHistory`: the client history's conversion

```ts
/** What {@link fromHistory} produced, and what it dropped. */
export interface FromHistory {
  /**
   * One entry per kept message, keyed by the client's message id, then one
   * approval response per answered approval (`<approvalId>:response`).
   */
  readonly entries: ReadonlyArray<Messages.Entry>;
  /** Tool calls dropped because their arguments are not a JSON object, with any results for them. */
  readonly droppedCalls: ReadonlyArray<string>;
  /** Ids of tool messages dropped because no assistant message in the history makes their call. */
  readonly orphanResults: ReadonlyArray<string>;
  /** Calls whose result held content parts other than text, which were dropped. */
  readonly droppedParts: ReadonlyArray<string>;
}

/** The client's history as entries to project, with its `resume` answers resolved. */
export const fromHistory: (
  messages: ReadonlyArray<AgUi.Message>,
  resume: ReadonlyArray<AgUi.ResumeEntry>,
  options?: IngestOptions,
) => FromHistory;
```

Per role:

- **`user`:** a user entry with its text, as `ingest` builds it. A message with no text is dropped.
- **`assistant`:** a text part for non-empty `content`, plus one `tool-call` part per `toolCalls` entry, with `params` set to `JSON.parse(function.arguments)`. A call whose arguments don't parse to an object is dropped together with its results. A client that stopped a run mid-call holds exactly such partial arguments, and rejecting them would leave the thread unusable. This follows how the server history ignores a step that was cancelled before it committed. An assistant message left with neither text nor calls is dropped.
- **`tool`:** a `tool-result` for `toolCallId`, named after its call. The result is decoded as `answers` decodes it, via the existing `resultOf`. The first message per call wins. A message whose call isn't in the history is dropped, because providers reject a result with no call.
- **`system` / `developer`:** handled per `clientSystem`, as `ingest` handles them.
- **Other roles:** dropped, as today.

The client history logs a warning for each non-empty `dropped*` or `orphanResults` list, as the server history does for `malformedAnswers` and `droppedParts`.

`Messages.project` is unchanged. It still gives every unanswered call the failed `INCOMPLETE_TOOL_CALL_RESULT`, and that is the documented weaker guarantee. Frontend calls need nothing extra: their results are `tool` messages with a call in the history. The `effentic.frontend` mark is still written on step entries, but only the server history reads it.

`Messages.history` is renamed `Messages.restore`, and its `Messages.History` result `Messages.Restored`, so "history" means only the run's history. Otherwise it is unchanged. It reads what `Thread` holds, so it serves the server history, and the hydrate route uses it next to `layerServer`.

### 5. Approval ids derive from the tool call id

```ts
// Agent.ts
/** The id of the approval request for a tool call, and of the AG-UI interrupt carrying it. */
export const approvalIdFor = (toolCallId: string): string => `approval:${toolCallId}`;
```

`executeTool` returns `approvalIdFor(call.id)` instead of `ids.generateId()`. The id is still produced inside the `tool:<callId>` memo, so a run replayed from an older checkpoint keeps its random id.

`fromHistory` resolves `resume` by working forward from the calls. For each converted call with no result, when a resume entry's `interruptId` equals `approvalIdFor(call.id)`, it:

- adds `Prompt.toolApprovalRequestPart({ approvalId, toolCallId })` to that assistant entry, and
- appends the response entry.

The decision is built as `Messages.resume` builds it, through a shared non-exported `decision(entry)` helper. Resume entries matching no unanswered call are ignored, as under the server history. Step 0 then executes the decisions with no change to `Agent.run`.

- **Why derive the id:** the history already carries the call, and `Interrupt.toolCallId` already exposes it to the client. A derived id needs no state and no signature. The security model accepts that ids are guessable.
- **Why work forward instead of parsing the id:** the format stays opaque.
- **Why both histories:** `Agent.run` doesn't know which history it was given, and the server history doesn't care what the id is.
- **Alternative considered:** `approvalId === toolCallId`. Rejected: an id that doubles as another kind of id invites clients to conflate the two.

### 6. Documentation

- **Security model:** in the README, linked from `History`.
  - Tool handlers and per-run dependencies are the authorization boundary.
  - `needsApproval` protects the user from the model.
  - The `History` service decides who owns the transcript.
- **README setups:** both, with and without `layerServer`. Choosing a history per request is shown with `run`.
- **Module comments:** `Runner`'s `pipeline` comment lists the shared steps and points to `History` for the rest. The `Messages` module comment describes the toolbox both histories use.
- **`Thread`:** its compaction and reconciliation constraints are scoped to the server history.
- **`workflow`:** documented as taking its history from its `layer`'s context.

### 7. Tests and examples

- **Existing suite:** runs with `History.layerServer`, through the fixtures' runner helpers, with no change to its assertions. That shows the server history is unchanged.
- **New tests on the default (no `History` provided):**
  - an edited earlier turn and a regenerated last turn are both sent as given;
  - approve and cancel through `resume`;
  - an unmatched interrupt id is ignored;
  - an approval-needing call with no `resume` entry gets the failed result;
  - a frontend result is accepted;
  - partial arguments and orphan tool messages are dropped and logged;
  - `clientSystem` drops or allows client system messages.
- **Types:** a stream from `Runner.run(agent)` requires neither `Thread` nor `History`. This is checked by providing only the agent's services and the checkpoint store.
- **Per request:** one runner serves one run under `layerServer` and one with nothing provided, and only the first touches the store.
- **`makeDetached`:** `History` provided around `start` wins over the one captured when the runner was built.
- **`verify`:** every sequence still goes through it.
- **Examples:**
  - `packages/examples/ag-ui` drops `Thread.layerMemory` and uses the default.
  - `packages/examples/tanstack` adds `History.layerServer` to its app layer, for its hydrate route.

## Risks / Trade-offs

- **[The choice is invisible at the runner]** A deployment that means to use the server history but never provides `layerServer` silently runs client history. → Forgetting gives the intended default. The README and `Thread`'s documentation say that the store is read only through `layerServer`. A hydrate route over an empty store is the visible symptom.
- **[Workflows can't choose per request]** → It is documented on `workflow`. A deployment that needs both histories runs two workflows, each registered with its own `layer`.
- **[Approval replay under client history]** A client that removes a call's result from its history and resends an approving `resume` runs the handler again. → This is accepted by the security model and documented on `History`. Handlers with side effects must be idempotent, or the deployment must use `layerServer`.
- **[The deferred double-run fix]** The fix relies on a stored approval response that exactly one run commits. → It still applies, now inside `layerServer`'s `beginAttempt`. Client history falls under the replay risk above.
- **[No concurrency control under client history]** Two runs on one thread can run at once. → The client owns the transcript, so it owns ordering too. A recording client history with a claim is the deferred third layer.
- **[Prompt size]** Under client history, the client sends its whole history on every run, and compaction is the client's problem. → This is inherent to client history and is a reason to choose `layerServer`.

## Migration Plan

There are no deployments yet, so nothing is migrated in the field. In the repo:

1. **The test fixtures and the TanStack example** provide `History.layerServer`.
2. **The ag-ui example** removes its `Thread` layer.
3. **For a future app on the current behaviour:** provide `History.layerServer` wherever it provides `Thread` today. Interrupts it raised before upgrading carry random ids, which the server history still resolves from the store.
4. **Rollback:** go back to the previous version. The store format is unchanged. Approval responses committed under derived ids are ordinary entries.

## Open Questions

- **An optional strictness check for client history.** Should the library offer one that rejects a history whose last assistant message leaves a frontend call or an approval-needing call unanswered? It would restore `UnansweredToolCall`/`UnansweredInterrupt` for apps that want them. It would belong with the deferred filters and guards, probably as a wrapping layer, and can be added later without changing anything here.
