## 1. Library: the hook

- [ ] 1.1 Add `interruptMetadata?: (interrupt: Interrupt, run: { threadId; runId }) => Record<string, unknown> | undefined` to `Runner.Options`, documented as a pure function of its arguments, applied by every runner and unable to change any field but `metadata`
- [ ] 1.2 Give `AgUi.fold` an optional options argument carrying the hook. On `Finished` with approvals, call it for each built interrupt and set `metadata` only when it returns an object
- [ ] 1.3 Catch a throwing hook in `fold`: emit that interrupt without `metadata` and log `Effect.logWarning` with the interrupt id and error, keeping the stream's error type `never` and the other events on the pure path
- [ ] 1.4 Pass `Options.interruptMetadata` to `fold` from `makeAttached`/`make`, `makeDetached` and `makeWorkflow` (`WorkflowOptions` extends `Options`, so it inherits the field)

## 2. Library: tests

- [ ] 2.1 No hook: the interrupt outcome is unchanged and has no `metadata` (existing approval tests stay green)
- [ ] 2.2 Hook returning metadata from the interrupt id and `runId`, with two pending approvals: each interrupt carries its own metadata, and the other fields equal the no-hook output
- [ ] 2.3 Hook returning `undefined` for one interrupt: only the other carries `metadata`
- [ ] 2.4 Throwing hook: no `RUN_ERROR`, that interrupt has no `metadata`, the outcome still lists every approval, and a warning is logged
- [ ] 2.5 Detached run with the hook: the `RUN_FINISHED` read back from the `EventLog` carries the same `metadata` as the live event
- [ ] 2.6 Resuming an interrupt that carried `metadata`, with extra fields on the resume entry, records the approval as usual
- [ ] 2.7 Pass every event sequence the new tests produce through `verify`

## 3. Example: TanStack binding

- [ ] 3.1 In `packages/examples/tanstack/src/server/chat.server.ts`, define the hook building TanStack's generic binding with `@tanstack/ai`'s `INTERRUPT_BINDING_METADATA_KEY`, `INTERRUPT_BINDING_VERSION`, `canonicalInterruptJson` and `digestInterruptJson` (`interruptedRunId: run.runId`, `generation: 0`, `responseSchemaHash` over the interrupt's `responseSchema`), and pass it to `Runner.make`
- [ ] 3.2 In `src/routes/index.tsx`, render `kind: "generic"` tool-approval interrupts with Approve/Deny calling `interrupt.resolveInterrupt({ approved })`; remove the decision state and `resumeInterruptsUnsafe` if TanStack's batching covers them, otherwise keep the minimal workaround with a comment saying why
- [ ] 3.3 Run the example in Chrome: approval card appears and the interrupt is not `unbound`; approve sends once (dev server prints `📧`) with result `{"sent":true}`; deny gives `execution-denied`; a follow-up turn works; check what happens when typing while an approval is open
- [ ] 3.4 If the model can be made to request two emails in one turn, check that both cards show and the run resumes only after both are answered

## 4. Docs and checks

- [ ] 4.1 Update `packages/effentic/AGENTS.md`: the `Runner` options, and `fold`'s interrupt metadata and throw behaviour
- [ ] 4.2 Update `packages/examples/tanstack/AGENTS.md`: replace the "unbound + `resumeInterruptsUnsafe`" explanation with the binding hook, and update the manual checks
- [ ] 4.3 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
