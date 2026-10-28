## Context

See proposal.md for why. The current state that shapes the approach:

- **The decoder drops `tools`.** `AgUi.RunAgentInput` decodes `threadId`, `runId`, `messages`, `resume` and `forwardedProps`. The `agui-transport-edge` spec has a scenario that decodes `tools` and throws it away.
- **The loop runs tool calls itself.** `Agent.run` calls `LanguageModel.streamText` with `disableToolCallResolution: true`. After each model step it runs each call through `executeTool`, which is memoised as `tool:<toolCallId>`. A call either gets a result or becomes `ApprovalRequested`. The model is called again only once every call in the step has a result.
- **`Messages` doesn't know about the toolkit.** `delta`, `ingest`, `resume`, `project` and `history` are pure functions over `Thread.Entry`s. Whatever they need to know about a call has to be in the stored entries.
- **Clients can't write tool turns.** `ingest` keeps user text, plus system text when that's allowed, and drops every other role.
- **Approvals already end a run with calls left open.** The step's assistant entry stores a `tool-approval-request` part. `resume` turns the next run's `resume` entries into `tool-approval-response` entries and fails with `UnansweredInterrupt` if any are missing. That check runs before anything is committed. `project` leaves calls awaiting approval alone and gives every other unanswered call a failed `INCOMPLETE_TOOL_CALL_RESULT`, as a safety net for runs that crashed mid-step.
- **`delta` already matches TanStack's tool messages.** A client `tool` message is known when a stored result has its `toolCallId`, whatever the message's own id. A result that is already stored is therefore never in the delta again.
- **`effect/ai` has what's needed.** `Tool.dynamic(name, { parameters: <JSON Schema> })` builds a tool with no handler from a raw JSON Schema, and `Toolkit.merge` combines toolkits. Every `Prompt` part has `options: ProviderOptions`, a record keyed by provider name that the part schema encodes and decodes. Each provider reads only its own key.
- **TanStack AI 1.0** sends `tools: clientTools` and runs a client tool as soon as that call's `TOOL_CALL_END` arrives. After the stream ends it starts a new run carrying the tool result. It treats a `RUN_FINISHED` that isn't an interrupt as handing over the calls still pending.

## Goals / Non-Goals

**Goals:**

- Follow AG-UI 1.0's frontend tool rules exactly: no result or tool message from the producer for a frontend call, a success outcome, an exact `pendingToolCallIds`, and every pending call answered on continuation.
- A step with server calls, frontend calls and approvals all together works across the two runs it takes.
- A client can answer only the calls it owns.
- `Agent` stays independent of AG-UI, and evals can script frontend calls.

**Non-Goals:**

- Restricting or rewriting advertised tools (an allowlist, server-written descriptions). That's the later knob.
- Validating a client's answer against the tool's schema. The result is data for the model, like any tool result.
- Making `Agent.run` check its own prompt for unanswered frontend calls. `Messages` guarantees this for the AG-UI path, and a direct caller such as an eval builds its own prompt.
- Fixing the deferred double run of an approved call (an approved call can run twice across runs). Mixed steps don't make it worse, but they don't fix it either (Risks).

## Decisions

### 1. Advertised tools become dynamic tools for the run

`AgUi.RunAgentInput` gains an optional `tools` array of `{ name: String, description: optional String, parameters: Unknown }`. Fields the agent doesn't read are stripped. An entry that is malformed fails decoding, as malformed `resume` entries do. The runner passes the tools to `Agent.run` as `frontendTools: ReadonlyArray<Agent.FrontendTool>`. `Agent.FrontendTool` is the library's own type (name, description, JSON Schema), so `Agent` doesn't import AG-UI.

For each model call the loop builds `Toolkit.merge(agent.toolkit, Toolkit.make(...dynamicTools))`. A frontend tool whose name matches a server tool is left out, and the run logs a warning naming it (the agent, not the runner, since only the agent has the toolkit). `frontendTools` is on `RunInput`, not `RunInfo`: handlers and the system prompt don't see it through `CurrentRun`. The tool's `description` and `parameters` go to the model exactly as the client sent them.

A call is then classified by name:
- In `agent.toolkit`: a server call, unchanged.
- One of the run's frontend tools: a frontend call.
- Anything else: unchanged. `toolkit.handle` fails and the model gets a failure result.

Alternatives: let the client tool win a name clash (that would let a client hide a server tool's handler); fail the run on a clash (one stray client definition would break every run on the thread).

### 2. The stored call carries the marker

When the loop builds a step's assistant entry, it sets `options: { effentic: { frontend: true } }` on each frontend `tool-call` part. Before every model call the loop removes the marker, in the same pass that removes approval parts today (`stripApprovals`, renamed for what it now does). That way no provider ever receives it, even one that forwards unknown keys.

The marker is what lets `Messages` tell a client-owned call apart without seeing the toolkit, so it's the security boundary for decision 5.

Alternatives:
- **Work it out from the tool's name.** `Messages` doesn't have the toolkit, and server toolkits change between deploys. A server call left open by a crash would look like a frontend call to a client that names it.
- **A part next to the call, like `tool-approval-request`.** `Prompt` has no part type for this, and reusing another one would be misleading.
- **A hidden entry of its own.** `delta` and `history` would need new visibility rules for it.

### 3. A frontend call is pending, not checkpointed

A frontend call runs no handler and mints no id, so it doesn't go through `Checkpoint.memo`. The memoised model step gives the step's tool calls. The memoised input gives the run's frontend tools, and `RunInputMismatch` already guards that input, which now includes `tools`. A replayed step therefore classifies its calls the same way as the first attempt.

The loop emits no `ToolResult` for a frontend call, so `fold` emits no `TOOL_CALL_RESULT` for it.

### 4. The run stops after a step with a pending call

The continuation rule becomes: continue only if the finish reason is `tool-calls`, at least one call was made, no approval is pending and no frontend call is pending.

`Agent.Outcome` changes:
- `Success` gains `pendingToolCalls: ReadonlyArray<{ toolCallId, toolName }>`, in call order and empty when there are none.
- `Interrupted` gains the same field, so non-AG-UI consumers can see a mixed step.

`AgUi.fold` puts `pendingToolCallIds` on a success `RUN_FINISHED` when the list isn't empty. It never puts it on an interrupt, because AG-UI says the interrupt outcome doesn't carry the list.

When the finish reason is neither `tool-calls` nor `stop`, frontend calls are handled like server calls today: each gets a failed "interrupted" result, and nothing is left pending.

Alternatives: a third outcome, `AwaitingClient` (AG-UI says outright that this is a success and not a third kind of ending); putting the list on interrupts as well (spec readers would expect it to be missing).

### 5. Answers are accepted by a function that mirrors `resume`

`Messages.answers(stored, delta)` returns `Result<ReadonlyArray<Thread.Entry>, UnansweredToolCall>`. It finds the marked calls in `stored` that have no `tool-result`. For each, it takes the delta's `tool` message with that `toolCallId` (the first one, if there are several). It turns that message into a `tool-result` entry keyed by the client's message id, using the stored call's name.
- If `error` is set, the result is that text with `isFailure: true`.
- Otherwise the content is decoded as in decision 6.

If any marked call that is still pending has no answer, the result is `UnansweredToolCall { toolCallIds }`. Tool messages for anything else are still dropped by `ingest`, which doesn't change.

The runner runs `answers` next to `resume`, before committing. It reports `UnansweredInterrupt` first if both checks fail, so the existing error doesn't change for existing clients. The new error becomes `RUN_ERROR` with code `UnansweredToolCall`.

`project` doesn't change. Once both checks pass, no marked call is left unanswered, and its failed-result fill stays as the safety net for crashed runs. Step 0 doesn't change either: a frontend answer arrives as an ordinary stored result, and `pendingDecisions` sees only the approvals.

Alternatives:
- **Widen `ingest` with `stored`.** That mixes up two rules: what a client may write in general, and what it may answer.
- **One combined `UnansweredInterrupt`.** It's simpler for routes that map errors to HTTP status codes, but the AG-UI answers differ (resume entries against tool messages), and the error should tell the client which one it forgot.
- **Treat a missing answer as a failure.** That's against the spec's MUST.

### 6. The answer's content is decoded leniently

- A string that parses as JSON is stored as the parsed value. Any other string is stored as is. This keeps `history`'s `JSON.stringify` of the result from encoding a JSON string a second time (see Findings: TanStack sends JSON text).
- A list of parts is reduced to its `text` parts joined in order. Every other part is dropped with a logged warning, and the call is still answered, with an empty string if nothing is left. The spec forbids failing the run over a part the producer can't handle (Open question 1).

### 7. History reports pending frontend calls

`Messages.History` gains `pendingToolCalls: { runId, toolCallIds } | undefined`, in the same shape as `interrupts` and ordered by call. The calls themselves are already in `messages` as assistant `toolCalls` with no result. The `thread-store` compaction rule is extended in the same way: keep every assistant entry holding a marked call that has no result yet.

## Risks / Trade-offs

- **[Client text reaches the model as tool descriptions]** → This is the trade-off of option A, the same exposure as `clientSystem: "allow"`, but always on. It's limited to a run the caller has already authorised on its thread. The later knob (an allowlist, or server-written definitions) is the mitigation. AGENTS.md should say that advertised tools are untrusted input.
- **[A malformed JSON Schema in `parameters`]** → The provider rejects the request and the run ends in `RUN_ERROR` with a model error code. That's acceptable: it's the client's mistake and it shows up at once.
- **[The client continues before the server has released the thread]** → TanStack starts its continuation after the stream ends, and every runner releases the thread before the terminal event, so this doesn't happen. A detached client that polls the log is covered the same way. A test should still cover an immediate follow-up run.
- **[A step that mixes approvals and frontend calls also has the approval double-run]** → An approved call in step 0 can still run twice if the answering run is cancelled before step 0 commits. This is the issue that was deferred. Mixed-step tests should avoid cancelling inside step 0 until that fix lands.
- **[Several tool messages answer one call]** → The first one counts. The others are ignored without an error, as duplicate client messages are today.

## Migration Plan

Additive. Threads stored before this change hold no markers, so none of their calls count as frontend calls. Clients that advertise no tools see the same events and errors as before. Rolling back leaves marked calls in stores, which the old code treats as unanswered server calls and fills with `INCOMPLETE_TOOL_CALL_RESULT`, so threads keep working.

## Findings

Questions that were open when this design was written, and what answered them.

- **Advertised tools that change between runs.** Run N+1 may not advertise a tool that run N called, while the history keeps that call and its result. Does Anthropic accept a `tool_use` in history for a tool missing from the request? If not, the fix stays inside the per-run toolkit (decision 1): add a placeholder dynamic tool (the name, `{ "type": "object" }`) for each marked call in the prompt whose tool isn't advertised.
  - **Answered 2026-10-28:** accepted. A Messages API call (`claude-haiku-5-5`) whose history holds a `tool_use`/`tool_result` for `pick-file` succeeded both with `tools` offering only `get-weather` and with no `tools` field. No placeholder is needed.
- **What TanStack sends as tool message content.** Decision 6 assumes TanStack sends `output` as JSON text. To confirm: a reload brings the result back as the same message, and `delta` still matches it.
  - **Answered 2026-10-28:** `@tanstack/ai`'s `uiMessagesToWire` sends a string output unchanged and anything else as `JSON.stringify(output)` (`normalizeToolResult`). A failure sets `error`. A list of content parts is also sent as JSON text, in TanStack's part shape (`{ type: "text", content }`), so decision 6 stores it as the parsed array rather than as AG-UI parts. Decision 6 holds.
- **How TanStack continues after a mixed step.** TanStack runs a frontend call during run N and queues a continuation. Does it hold that continuation while one of run N's interrupts is open, or send it and get `UnansweredInterrupt`? The library's behaviour is the same either way. The answer decides only whether the example needs to delay its continuation, and what the mixed-step manual check expects.
  - **Answered from the source 2026-10-28, browser check pending:** `@tanstack/ai-client` 1.0's `checkForContinuation` returns early while `hasPendingInterrupts()`, and `shouldAutoSend` is false while any interrupt is listed. The continuation is therefore held, and the run that `resumeInterruptsUnsafe` sends carries the browser tool's result in its messages. The example needs no delay. Manual check 10 in the example's `AGENTS.md` confirms it in a browser.

## Open Questions

1. **Media results.** Decision 6 keeps only text. Can `effect/ai`'s `tool-result` carry file parts through to Anthropic? If so, a later change can store screenshots and files instead of dropping them.
2. **Reloading while a frontend call is pending.** From its source, TanStack appears to run a client tool when its call streams, not when a thread is restored (not checked in a browser). If so, a page reloaded between `RUN_FINISHED` and the continuation restores the call without a result, and the next message then fails with `UnansweredToolCall`. The window is small (the browser answers at once), and the fix is on the client side (running restored calls from `Messages.History.pendingToolCalls`), so it doesn't change the library.
3. **Confirming the mixed step in a browser.** The source says TanStack holds its continuation while an interrupt is open (Findings). Manual check 10 in the example's `AGENTS.md` confirms it (task 6.2).
