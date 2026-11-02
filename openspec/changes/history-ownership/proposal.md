## Why

AG-UI says a producer MUST treat `RunAgentInput.messages` as the complete history it is being shown. effentic instead treats that history as untrusted. It rebuilds every prompt from its own thread store, keeps only a delta of new user messages, and rejects legitimate client behaviour such as editing or regenerating a turn (`HistoryDiverged`). That assumes a server-authoritative deployment, and the library shouldn't assume it. Server authority isn't a security boundary either. A client that writes the whole prompt can already steer the model into any tool call it could forge. The real boundary is the tool handlers, which run as the verified principal that the caller provides, never as anything taken from the input. So server authority decides who owns the transcript, which matters when a thread is shared or persisted beyond the client that sent it. That is a deployment decision for the implementer, so the library should make it pluggable rather than mandatory.

## What Changes

- **BREAKING: Pass-through history by default.** A run takes its history from `input.messages` as sent. The library converts it to the model prompt with no load, no reconciliation and no per-step commit. It no longer drops client assistant, tool or system messages, and it no longer rejects edited or regenerated history. A pass-through run needs no `Thread` store and claims no thread.
- **New history source option** on `Runner.Options`, applying to every runner (`run`, `makeDetached`, `workflow`). It chooses who owns the transcript:
  - **pass-through** (the default): the client owns it.
  - **server-authoritative**: today's behaviour, unchanged. The source loads the thread from the store and ingests only the client's delta. It rejects `HistoryMismatch` and `HistoryDiverged`, commits each step, notifies run end, and enforces one active run per thread. It is the only source that requires `Thread`. `Messages.history` and the hydrate route that serves it only make sense with this source.
- **Composable guards** an implementer can add to either source. A guard checks the messages the source treats as the client's contribution: the delta under server-authoritative, the incoming history under pass-through. A guard can drop messages or reject the run, and a rejection ends the run in band with `RUN_ERROR`. One guard is built in: a role guard, for example rejecting or dropping `system`/`developer` messages. It replaces today's `clientSystem` option. Guards are hygiene, not authorization.
- **Approvals under pass-through** are resolved from the client's history and its `resume` entries, trusted as sent. Each interrupt's id has to be resolvable to its tool call from that history alone. A server-authoritative run still resolves approvals against the store.
- **Frontend calls under pass-through** are recognised from the history itself: an assistant call to a tool in `input.tools` with no `tool` message after it. The stored frontend-call mark stays an internal detail of the server-authoritative source.
- **A weaker guarantee under pass-through, documented as such:** pass-through can't know which interrupts the previous run raised. So it can't fail an unanswered approval with `UnansweredInterrupt`. An unresolved server tool call is sent to the model with a failed result, as an interrupted call is today.
- **Documented security model.** Tool handlers and per-run dependencies are the authorization boundary. `needsApproval` protects the user from the model and is not authorization against the client. The history source decides who owns the transcript.
- **Out of scope:** signed or single-use approval ids, approvals by a party other than the requester, and any change to `Agent.run` or to checkpoint replay. Under either source the `input` fingerprint, `RunInputMismatch` and the memoised `prompt` work as today.

## Capabilities

### New Capabilities

- `run-history-source`: choosing a history source per runner (pass-through or server-authoritative), the pass-through conversion of `input.messages` into the prompt, guards and the built-in role guard, and how pass-through resolves approvals and frontend calls from the client's history.

### Modified Capabilities

- `agui-agent-loop`: the requirements that hard-wire the server store now apply only under the server-authoritative source:
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

  "Resume entries answer approvals" gains its pass-through form. The client-system-message scenarios move to the role guard.
- `agui-transport-edge`: runners no longer require `Thread` unless they use the server-authoritative source, and a runner's `Requirements` reflect the source it was given.
- `thread-store`: the store is a dependency of the server-authoritative source, not of every run. "A thread has at most one active run" is scoped to that source.

## Impact

- `packages/effentic/src/Runner.ts`: the source and guard options, the pipeline split at the load, delta, commit and claim points, and `Requirements` with `Thread` dropped when the source doesn't need it.
- `packages/effentic/src/Messages.ts`: a conversion from AG-UI messages to the prompt for pass-through, separate from the store-based `delta`/`ingest`/`project`. Both sources share the visibility and projection rules.
- `packages/effentic/src/AgUi.ts`: approval interrupt ids that pass-through can resolve to their tool call.
- `packages/effentic/test`: today's suite moves under the server-authoritative source. New tests cover pass-through (edited and regenerated history, approvals, frontend calls, unresolved calls) and the guards. Every sequence still goes through `verify`.
- `packages/examples/tanstack`: it uses the hydrate route, so it opts into server-authoritative. `packages/examples/ag-ui` can use the default.
- `packages/effentic/AGENTS.md` and README: the module notes, the resume rules for both sources, and the security model. The invariants "One active run per thread" and "A client writes only the results of its own calls" become rules of the server-authoritative source.
- No new dependencies.
- **Overlap:** the open `interrupt-metadata` change also adds a field to `Runner.Options`. The two are independent; whichever lands second rebases. The proposed fix for the deferred approval double-run ("the answering run owns step 0") assumes stored approval state. It should be rechecked against both sources when either is designed.
