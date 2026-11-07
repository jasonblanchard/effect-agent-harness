## 1. Streaming reasoning

- [x] 1.1 Add reasoning part builders to `test/fixtures.ts` (streamed start/delta/end, a whole `reasoning` part, and metadata for a signature)
- [x] 1.2 Add the five reasoning events to `AgUi.Event`, with builders, and a private function that derives a block's id from the step's message id and `n`
- [x] 1.3 Handle `reasoning-start`, `reasoning-delta`, `reasoning-end` and `reasoning` in `handlePart`, with lazy opening and the block count on `StepState`
- [x] 1.4 Close open reasoning in `StepState.close` and in `closeOpen`, tracking messages and spans separately
- [x] 1.5 Update `fold`'s doc comment
- [x] 1.6 Test the `Streamed model reasoning` and `Reasoning is controlled by the model layer` scenarios, each sequence through `verify`, including a span and message sharing an id, and two blocks with text between them
- [x] 1.7 Test `Failure during reasoning`, `Step ends with reasoning open` and `Multiple reasoning blocks in one step`
- [x] 1.8 Test `Resume after a crash mid-reasoning` on a detached run, including a log that stops between `REASONING_START` and `REASONING_MESSAGE_START`

## 2. Reading reasoning back

- [x] 2.1 Add `reasoningOf` to `internal/conversions.ts`, using the shared id function, and have `restore` place its messages before the entry's assistant message
- [x] 2.2 Change `Restored.messages` to `ReadonlyArray<Message>`, delete `ShownMessage`, and remove its re-export from `History.ts`
- [x] 2.3 Update the comments on `shown` and `restore`, and `History.restore`'s doc comment
- [x] 2.4 Update `conversions.test.ts:252`, which expects reasoning to be hidden
- [x] 2.5 Test the new `Reading a thread as AG-UI messages` scenarios, including an id comparison against a real run's events and a block with no text before one with text
- [x] 2.6 Test the `Divergent history is rejected` and `A read history is accepted as the client's history` reasoning scenarios, including a thread ending in a reasoning-only entry, and that the model still receives stored reasoning with its options

## 3. TanStack example

- [x] 3.1 Convert restored messages in the hydration route as design decision 8 describes, with TanStack's own functions
- [x] 3.2 Enable reasoning in the example's model layer
- [x] 3.3 Render `thinking` parts in the chat page if it doesn't already
- [ ] 3.4 Run the example with reasoning on: confirm one message per step live and after a reload, then a further turn after the reload without a history error. Fix any split in the example

## 4. Docs and checks

- [x] 4.1 README: document the reasoning events, how to enable reasoning in the provider layer, that it then reaches every client, and that signatures aren't sent. Update the section on `restore` and the module table to drop `ShownMessage`
- [x] 4.2 Update `packages/effentic/AGENTS.md` (`AgUi.ts`, `internal/conversions.ts`, invariants) and the `tanstack` example's `AGENTS.md` if it describes hydration
- [x] 4.3 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
