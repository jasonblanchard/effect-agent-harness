## Why

effect-agent-harness's approval interrupts are plain AG-UI interrupts, and some clients won't resolve those with their own API. TanStack AI 1.0 only offers `resolveInterrupt` for an interrupt that carries its own resume binding under `metadata["tanstack:interruptBinding"]`. Any other interrupt it lists as `unbound`, so the `tanstack` example has to answer approvals through `resumeInterruptsUnsafe` and collect the decisions itself. AG-UI defines `Interrupt.metadata` as an open, namespaced extension bag, so the library can let a server attach a client's binding without changing anything else on the wire. It just needs a place to put it, and the library itself has to stay neutral about which client is on the other end.

## What Changes

- **New runner option `interruptMetadata`.** It goes on the construction-time `Runner.Options`, not on the per-run `RunOptions`, so it applies to every runner (`makeAttached`, `make`, `makeDetached`, `makeWorkflow`). It's a pure function from an interrupt the library has built (`id`, `reason`, `toolCallId`, `message`, `responseSchema`) and the run's `{ threadId, runId }` to a metadata object, or `undefined` for none. The runner puts the result on that interrupt's `metadata`.
- **Default unchanged.** Without the option, interrupts are emitted exactly as today, with no `metadata` field.
- **Safe by construction.** If the function throws, the interrupt is emitted without metadata, the failure is logged as a warning, and the run still ends with its normal `RUN_FINISHED` interrupt outcome. The event streams keep their error type `never`.
- **Stored with the event.** The metadata is part of the emitted event, so the `EventLog` stores it, and a client following a detached run sees the same interrupt as one that streamed it.
- **The `tanstack` example** supplies the hook. It builds TanStack's minimal `kind: "generic"` binding (`v`, `kind`, `interruptId`, `interruptedRunId`, `generation`, `responseSchemaHash`) with `@tanstack/ai`'s exported helpers. The page then answers approvals with each interrupt's own `resolveInterrupt({ approved })` and `cancel()`. TanStack waits until every interrupt in the batch is answered before resuming, which matches effect-agent-harness's rule that every open approval must be answered. The hand-rolled decision state and the `resumeInterruptsUnsafe` call go away.
- **Out of scope.** TanStack's typed `kind: "tool-approval"` binding is left out: it would need TanStack's response schema and hashes that match the client's own tool schemas, and support for `editedArgs`. The library adds no dependency on `@tanstack/*`.
- Not breaking: the option is additive.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agui-agent-loop`: approval interrupts may carry caller-supplied `metadata`, computed per interrupt by the new runner option, with a defined behaviour when that computation fails.

## Impact

- `packages/effect-agent-harness/src/Runner.ts`: `Options.interruptMetadata`, passed through to the projection in every runner.
- `packages/effect-agent-harness/src/AgUi.ts`: `fold` takes the hook and applies it when it builds the interrupt outcome. The interrupt type is `AgUiSchema.Interrupt`, which already has an optional `metadata` (`Record<string, Schema.Json>`), so no type changes.
- `packages/effect-agent-harness/test`: tests for the default, the attached metadata, a hook that throws, and a detached run's stored log. Every sequence goes through `verify`.
- `packages/examples/tanstack`: the server passes the hook, and `src/routes/index.tsx` switches to the bound interrupt API. Its `AGENTS.md` and manual checks are updated.
- `packages/effect-agent-harness/AGENTS.md`: the `Runner` and `AgUi` module notes.
- No new library dependencies. The example already depends on `@tanstack/ai`.
- **Overlap:** the open `typed-run-context` change also extends `Runner.Options` (with `contexts` and `layer`). The two fields are independent; whichever lands second rebases onto the other.
