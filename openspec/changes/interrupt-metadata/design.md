## Context

`AgUi.fold` projects `Agent.Event`s onto AG-UI. On `Finished` with approvals pending, it builds one `AgUiSchema.Interrupt` per approval (`id` = approval id, `reason: "tool-approval"`, `toolCallId`, `message`, `responseSchema` = the `ApprovalResponse` JSON Schema) inside a `RUN_FINISHED` interrupt outcome. Every runner reaches the client through `fold`: `makeAttached`/`make` stream it, and `makeDetached` and `makeWorkflow` publish it to the `EventLog`. `Interrupt.metadata` is already an optional, open `Metadata` (`Record<string, Schema.Json>`) in `AgUiSchema`, so the hook's values must be JSON; effect-agent-harness never sets it.

TanStack AI 1.0's client (read from the installed 1.0.0 source) treats an interrupt as resolvable only when `metadata["tanstack:interruptBinding"]` holds a binding of a version it knows. The minimal form is:

```ts
{
  v: 1,
  kind: "generic",
  interruptId,        // must equal the interrupt's id
  interruptedRunId,   // must equal the runId the client sent: the run's runId
  generation,         // read back from the binding; 0 is fine
  responseSchemaHash, // required when the interrupt has a responseSchema:
                      // digestInterruptJson(canonicalInterruptJson(responseSchema))
}
```

`@tanstack/ai` exports `INTERRUPT_BINDING_METADATA_KEY`, `INTERRUPT_BINDING_VERSION`, `canonicalInterruptJson` and `digestInterruptJson`.

## Goals / Non-Goals

**Goals:**
- One library seam that lets a server add client-specific interrupt metadata, with no client named in the library.
- Identical behaviour across all four runners, including detached runs read back from the log.

**Non-Goals:**
- Metadata on other events (messages, tool calls). There's no known need, and AG-UI's other `metadata` fields can get their own hook later.
- Shipping a TanStack adapter from the library. The binding lives in the example.
- TanStack's `tool-approval` binding and `editedArgs` (see proposal).

## Decisions

### The hook goes on `Runner.Options`, not `RunOptions`

`interruptMetadata` is set when the runner is built: `Runner.make(agent, { interruptMetadata })`.
- **Why not per run:** the workflow runner persists `RunOptions` (`WorkflowPayload.context`), and a function can't be persisted. Which client protocol a server speaks is a deployment choice made once, not something each request decides.
- **Per-run data still reaches it:** the run's `threadId` and `runId` are passed in, which is everything the TanStack binding needs.
- **Alternative considered:** `RunOptions.interruptMetadata`, which allows per-request variation. Rejected: it can't work for `makeWorkflow`, so the four runners would differ.

### A synchronous, pure function

```ts
readonly interruptMetadata?: (
  interrupt: Interrupt,
  run: { readonly threadId: string; readonly runId: string },
) => Record<string, unknown> | undefined;
```

- **Why synchronous:** `fold` is a synchronous projection, and every known use (hashing, stamping ids) is pure computation.
- **Alternative considered:** returning `Effect<Metadata>`, which would allow services such as a signing key. Rejected for now: it would make `fold` effectful and add requirements to every runner's type for a need nobody has yet. A later change can widen the type without breaking existing callers.

### Applied inside `fold`

`fold(input, options?)` gains an optional second argument carrying the hook, and the runners pass `Options.interruptMetadata` through.
- **Why `fold`:** it's the single point all runners share, so stored and live events can't drift apart.
- **What the hook sees:** the interrupt exactly as the library built it, so hashes over `responseSchema` match what the client receives.
- **What it can change:** only `metadata` is set from the result. The hook can't touch `id`, `reason` or the outcome.
- **Merging:** the library sets no metadata of its own today, so the result becomes `metadata` as is. If the library ever adds keys of its own, they win over the hook's, merged by key.

### A throwing hook degrades, never fails the stream

The invariant "the event streams never fail" holds:
- `fold` catches an exception from the hook, emits that interrupt without metadata, and logs `Effect.logWarning` naming the interrupt id and the error.
- To log, the interrupt outcome is built in an effectful step, for example `Stream.mapEffect` on just the `Finished` event, while every other event keeps the existing pure path.
- **Why degrade:** without metadata, a client like TanStack shows the interrupt as unbound but still sees the run paused. That's better than turning a correct pause into `RUN_ERROR`.
- **Alternative considered:** dying, i.e. treating a throw as a defect. Rejected, because it would break the stream invariant.

### The example builds the generic binding

`packages/examples/tanstack/src/server/chat.server.ts` defines the hook with the `@tanstack/ai` helpers listed in Context, using `generation: 0` and `interruptedRunId: run.runId`. The page then:
- renders interrupts whose `kind` is `"generic"` and `reason` is `"tool-approval"`, with Approve/Deny buttons calling `interrupt.resolveInterrupt({ approved })`;
- relies on TanStack to stage the answers and submit the batch once every interrupt is answered;
- falls back to plain text for any other kind.

The decision state, the `resumeInterruptsUnsafe` call and the disabled-input workaround are removed if TanStack's own batch handling covers them (see Risks).

## Risks / Trade-offs

- **[TanStack internals change]** The binding format is TanStack's (`v: 1`), not part of the AG-UI spec. → It lives only in the example, is versioned on their side, and the example's manual checks catch a break. The library is unaffected.
- **[Hash mismatch]** TanStack hashes the `responseSchema` it receives. The hook hashes the same object before it's serialized. → Canonical JSON sorts keys and survives the round trip; the example's manual check confirms the interrupt is resolvable rather than `unbound`.
- **[TanStack's batch handling differs from what the source suggests]** For example, it might not auto-submit, or might allow a new message while interrupts are open. → The apply step confirms this in the browser. If it differs, the example keeps the minimal part of today's workaround and documents why.
- **[Non-deterministic hook]** A hook reading the clock or randomness would give a detached run's live stream and a later re-execution different metadata. → In practice the terminal event is written once (a re-executed run whose log is terminal publishes nothing). The option's docs say the hook should be a pure function of its arguments.

## Migration Plan

Additive: existing callers are unaffected. Rollback means removing the option.
