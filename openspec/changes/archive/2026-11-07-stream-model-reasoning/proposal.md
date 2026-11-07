## Why

A model's reasoning reaches the store but never reaches a client. `AgUi.fold` drops reasoning parts, and `History.restore` drops them to match. The original design marked this as "dropped (for now)", so it is deferred scope rather than a decision to hide reasoning. `restore`'s return type has also narrowed around one consumer: `ShownMessage` happens to fit TanStack's `ModelMessage`, which says nothing about what a thread holds.

The stream and `restore` should both show what the model produced, as AG-UI, and each consumer should adapt AG-UI to its own types.

## What Changes

- **The stream carries reasoning.** `AgUi.fold` emits `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`, `REASONING_MESSAGE_END` and `REASONING_END` for each reasoning block a model step produces. Open reasoning spans are closed at step end, before `RUN_ERROR`, and by `closeOpen` when a detached run resumes.
- **`History.restore` returns reasoning.** A thread read back includes a `reasoning` message for each reasoning block with text, under the same id its events used, directly before the assistant message of that step.
- **BREAKING: `History.ShownMessage` is removed.** `Restored.messages` becomes `ReadonlyArray<Message>`, AG-UI's own message type. Callers can no longer assume `content` is a string, or that only three roles appear.
- **Reconciliation ignores reasoning.** A client may keep or drop reasoning rows. Neither causes `HistoryMismatch` or `HistoryDiverged`.
- **No effentic switch.** The caller decides whether a model produces reasoning by configuring the model provider layer, for example Anthropic's `thinking` config. A model that produces none leaves the stream and `restore` unchanged.
- **Provider neutral.** The core reads only a reasoning block's text. Provider metadata such as signatures stays on the stored parts for model replay, and is not sent to clients.
- **The `tanstack` example adapts for itself.** Its route turns AG-UI messages into what TanStack needs, and its model layer turns reasoning on so the path is exercised.

Out of scope:

- `file`, `source` and `response-metadata` parts, which have no direct AG-UI message type.
- `REASONING_ENCRYPTED_VALUE`, and `encryptedValue` on restored messages. Reading a signature needs knowledge of each provider's options.
- Returning reasoning to the model under the client history. `fromHistory` still drops `reasoning` messages, so that history loses reasoning between runs, as it does today.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agui-agent-loop`: reasoning is streamed, spans include reasoning, reasoning blocks get their own message ids, and divergence checks ignore reasoning.
- `thread-history-read`: the read returns reasoning as AG-UI messages, and a read history containing reasoning is accepted.
- `agui-transport-edge`: resuming a detached run also closes reasoning left open in the log.

## Impact

- **`packages/effentic/src/AgUi.ts`:** the `Event` union, event builders, `handlePart`, `StepState` and `closeOpen`.
- **`packages/effentic/src/internal/conversions.ts`:** `restore` and `Restored`; `ShownMessage` removed. `delta` and `fromHistory` keep their behaviour.
- **`packages/effentic/src/History.ts`:** the re-export and doc comment.
- **`packages/examples/tanstack`:** the hydration route and the model layer.
- **Docs:** `packages/effentic/README.md` and `AGENTS.md`, and the `tanstack` example's `AGENTS.md` if it describes hydration.
- **Clients:** any model configured to produce reasoning now sends it to every client on the stream and through `restore`. A caller that doesn't want this leaves reasoning off in the model layer.
- **Overlap:** the open `interrupt-metadata` change also touches `AgUi.ts`, in the interrupt path rather than the part handling.
