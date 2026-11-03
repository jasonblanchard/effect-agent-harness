## Why

AG-UI says a producer MUST treat `RunAgentInput.messages` as the complete history it is being shown. effentic instead treats that history as untrusted. It rebuilds every prompt from its own thread store, keeps only a delta of new user messages, and rejects legitimate client behaviour such as editing or regenerating a turn (`HistoryDiverged`). That assumes a server-authoritative deployment, and the library shouldn't assume it.

Server authority isn't a security boundary either. A client that writes the whole prompt can already steer the model into any tool call it could forge. The real boundary is the tool handlers, which run as the verified principal that the caller provides, never as anything taken from the input. So server authority decides who owns the transcript, which matters when a thread is shared or persisted beyond the client that sent it. That is a deployment decision for the implementer. The library should default to the history AG-UI describes, and let the implementer opt into the store-backed one.

## What Changes

- **New `History` service: the run's canonical history.** A run gets its history, and reports its steps and its end, through a `History` service read from the run's context. The library ships two implementations:
  - **Client history (the default):** the run's history is `input.messages` as sent. It is converted to the model prompt without reconciliation. Client assistant and tool messages are kept, and edited or regenerated history is accepted. It needs no store.
  - **`History.layerServer` (opt-in):** today's behaviour, unchanged. The run claims the thread, loads it from `Thread`, and takes only the client's delta, its `resume` answers and its results for pending frontend calls. It rejects `HistoryMismatch` and `HistoryDiverged`, commits each step, notifies `runEnded`, and releases the thread. It is the only part of the library that requires `Thread`.

  A run with no `History` in its context uses the client history. `History.layerClient` is exported too, so a caller can choose it explicitly.
- **The service is provided on the run's stream, not passed to the runner.** That makes the choice possible per runner or per request: a route can serve shared threads with the server history and scratch chats with the client history, using one runner. A workflow runner takes it from the context its `layer` is built in.
- **The service's interface is private for now.** `History` is an opaque type, and the two layers are the only way to get a value. Custom implementations are not supported yet; a public contract can come later without breaking anything.
- **BREAKING: runners no longer require `Thread`.** `Thread` leaves `Runner.Requirements`. A server-history deployment provides it to `History.layerServer` instead.
- **BREAKING: `Messages.history` is renamed `Messages.restore`**, and its result type `Messages.History` is renamed `Messages.Restored`, so "history" means only the run's history. Its behaviour is unchanged.
- **BREAKING: `Thread.Entry` moves to `Messages.Entry`.** Both histories produce entries, but only the server history stores them, so the shared type no longer belongs to the store. Its shape and encoding are unchanged.
- **BREAKING: client history is the default.** Code that relies on today's behaviour provides `History.layerServer`. Nothing is deployed on the library yet.
- **Approvals under client history** are resolved from the client's history and its `resume` entries, trusted as sent. To make that possible, an approval's id is derived from its tool call id, so an interrupt can be matched to its call from the history alone. This applies under both histories.
- **Frontend calls under client history** need no special handling. A client's result for one is a `tool` message like any other, and it is accepted because its call is in the history.
- **A weaker guarantee under client history, documented as such:** the run can't know which interrupts or frontend calls the previous run left open. So it can't fail with `UnansweredInterrupt` or `UnansweredToolCall`, and it doesn't keep one active run per thread. An unresolved call is sent to the model with a failed result, as an interrupted call is today.
- **`clientSystem` keeps its meaning under both histories.** Client `system`/`developer` messages are dropped unless it is `"allow"`.
- **Documented security model.** Tool handlers and per-run dependencies are the authorization boundary. `needsApproval` protects the user from the model and is not authorization against the client. The `History` service decides who owns the transcript.
- **Out of scope:**
  - a public `History` contract and custom implementations;
  - a client history that also records to `Thread`, which can be added later as a third layer;
  - input filters and guards;
  - signed or single-use approval ids;
  - approvals by a party other than the requester;
  - run lifecycle hooks;
  - any change to `Agent.run`'s loop or to checkpoint replay. Under either history, the `input` fingerprint, `RunInputMismatch` and the memoised `prompt` work as today.

## Capabilities

### New Capabilities

- `run-history`:
  - the `History` service and its default;
  - the client history: how it converts `input.messages` into the prompt and resolves approvals and frontend results from it;
  - `History.layerServer` as the opt-in to the server-authoritative requirements.

### Modified Capabilities

- `agui-agent-loop`: the requirements that hard-wire the store now apply only under the server history:
  - "Thread history from the server store"
  - "Client messages are ingested as a delta"
  - "History mismatch is rejected"
  - "Divergent history is rejected"
  - "Per-step commit"
  - "Run-ended notification"
  - "One active run per thread"
  - "Every open approval must be answered"
  - "Tool messages answer pending frontend calls"
  - "Every pending frontend call must be answered"

  "Resume entries answer approvals" gains its client form. "Tool approval interrupts the run" states the derived interrupt id. "A mixed step is answered with resume entries and tool messages" keeps its strictness under the server history only. "Run lifecycle"'s thread-load failure scenario is scoped to the server history.
- `agui-transport-edge`: "Runner without service requirements" no longer lists the thread store; a history may be provided to the stream and brings its own store. How each runner (including the workflow runner) reads its history is specified in `run-history`.
- `thread-store`: the store is a dependency of `History.layerServer`, not of every run. "A thread has at most one active run" is scoped to the server history.

## Impact

- `packages/effentic/src/History.ts` (new):
  - the service;
  - `layerClient` and `layerServer`;
  - the private interface (the service and the run attempt it opens);
  - the server implementation, moved out of `Runner.ts`.
- `packages/effentic/src/Runner.ts`: the pipeline calls the history instead of `Thread`. `endRun` and `run`'s release-on-cancel move behind it. `Thread` leaves `Requirements`.
- `packages/effentic/src/Messages.ts`: `fromHistory`.
- `packages/effentic/src/Agent.ts`: approval ids derived from the tool call id.
- `packages/effentic/src/index.ts`: exports `History`.
- `packages/effentic/test`: the existing suite runs with `History.layerServer` and is otherwise unchanged. New tests cover:
  - the client default: edited and regenerated history, approvals, frontend results, unresolved calls, partial tool arguments, `clientSystem`;
  - a runner with no `Thread` in its context;
  - choosing the history per request.

  Every sequence still goes through `verify`.
- `packages/examples/ag-ui`: drops its `Thread` layer and uses the default. `packages/examples/tanstack` provides `History.layerServer`, because its hydrate route reads the store.
- `packages/effentic/AGENTS.md` and README: the module notes, the resume rules for both histories, and the security model.
- No new dependencies.
- **Overlap:** the open `interrupt-metadata` change edits `Runner.Options`. It is independent of this change; whichever lands second rebases. The proposed fix for the deferred approval double-run ("the answering run owns step 0") assumes stored approval state. It applies inside `History.layerServer`, and doesn't apply to the client history (see design).
