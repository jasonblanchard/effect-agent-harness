## Context

`Agent.run` already emits every reasoning stream part as a `ModelPart`, and `Prompt.fromResponseParts` already stores reasoning in the step's assistant entry with its provider options. `forModel` leaves those parts in place, so the model gets them back. The only gaps are at the edges:

- `handlePart` in `AgUi.ts` has no reasoning case.
- `shown` in `internal/conversions.ts` drops reasoning, and its result type is `ShownMessage`.

`delta` uses `shown` as its visibility rule, so changing `shown` would also change what counts as divergence.

## Goals / Non-Goals

**Goals:**

- A client sees the same reasoning live and after a reload, under the same ids.
- `restore` returns AG-UI's `Message` type.
- The core stays provider neutral and gains no reasoning option.

**Non-Goals:**

- `file`, `source` and `response-metadata` parts.
- `REASONING_ENCRYPTED_VALUE` and `encryptedValue`.
- Returning reasoning to the model under the client history. `fromHistory` is unchanged.

## Decisions

### 1. One message id per reasoning block, derived from the step's id

A reasoning block's id is `<stepMessageId>:reasoning:<n>`, where `n` is the block's position among the step's reasoning blocks, counted from 0. Treat the format as opaque, as with `Agent.approvalIdFor`. One private function in `AgUi.ts` builds it, and `fold` and `restore` both call it.

The step's message id is minted inside the `model:<step>` checkpoint, so a derived id replays the same way and needs no change to the stored `ModelStep` or `Entry` shapes. Minting a separate id per block would mean storing those ids on the part or the entry, which is a schema change for stored data.

**Alternative: one reasoning message per step, as text shares one id.** Rejected. Text can do this because a step has one assistant message. Reasoning blocks can be separated by text, so sharing an id means either holding one span open across the text or restarting a message under the same id. A block per message also matches the stored parts one to one.

### 2. Each block is one span holding one message

Every block emits `REASONING_START` and `REASONING_MESSAGE_START` when it first has text, and `REASONING_MESSAGE_END` and `REASONING_END` when it ends. The span and the message share the block's id. `@ag-ui/client`'s verifier tracks spans and messages in separate sets, so this is valid, and a test confirms it through `verify`. Holding one span across a step would add state for no benefit to a client.

### 3. Fold mirrors what the store keeps

`StepState` gains a count of the step's reasoning blocks and a map from provider part id to the open block.

| Part              | Behaviour                                                                               |
| ----------------- | --------------------------------------------------------------------------------------- |
| `reasoning-start` | Takes the next `n`. Emits nothing yet.                                                  |
| `reasoning-delta` | Ignored if the part id has no open block. On the first non-empty delta, opens the span. |
| `reasoning-end`   | Closes the span if it opened, and removes the block.                                    |
| `reasoning`       | Takes the next `n`. If it has text, emits the whole span with one content event.        |

`fromResponseParts` ignores a delta with no start, so fold ignores it too. Otherwise a block would be shown that `restore` can't return. Opening lazily means a redacted block, which has a signature but no text, emits nothing and still takes its `n`. `restore` skips it the same way, so later ids stay aligned.

`StepState.close` and `closeOpen` close reasoning after text and before tool calls, each block as `REASONING_MESSAGE_END` then `REASONING_END`. `closeOpen` tracks the message and span sets separately, because a log can stop between the two starts.

### 4. `shown` stays as it is, and `restore` adds reasoning beside it

`shown` keeps its rule, so `delta` doesn't change. A new private `reasoningOf(entry)` returns the entry's `reasoning` messages, and `restore` builds `[...reasoningOf(entry), shown(entry)]`.

If `shown` returned reasoning instead, an entry holding only reasoning would become visible to `delta`. Its client row would have an id with no stored entry, so the entry could never be matched, and the run would fail with `HistoryDiverged`. Keeping them apart avoids that with no change to `delta`. The comment that says to keep `shown` and `delta` together is updated to say why reasoning sits outside.

Client reasoning rows need no new code either. Their ids match no entry, so `delta` treats them as unknown, and `ingest` drops every role but user and allowed system messages. A test covers each case in the delta specs.

### 5. `Restored.messages` is `ReadonlyArray<Message>`

`ShownMessage` is deleted, along with its re-export from `History`. Inside `restore`, the existing role checks narrow `Message` as they narrow the union today. The function's output is still only `user`, `assistant`, `tool` and `reasoning`, and strings for content, but the type no longer promises that.

### 6. Reasoning comes before the entry's assistant message

An AG-UI `assistant` message has one `content`, so an entry's text can't be split around a reasoning block. All of an entry's reasoning goes first. A block produced after text moves ahead of that text after a reload. The block's order among other reasoning is kept, and reasoning usually comes first anyway.

### 7. No option, and no provider code

Reasoning appears when the model produces it. A caller enables it in the provider layer, for example `AnthropicLanguageModel.layer({ model, config: { thinking } })` with `thinking` being `{ type: "adaptive", display: "summarized" }`, and hiding it means leaving that off. Without `display`, the API returns thinking blocks with no text, which show nothing. `@effect/ai-anthropic`'s type doesn't declare `display`, so `thinking` is a separate constant. Fold and `restore` read only `delta` and `text`. They never read `metadata` or `options`.

### 8. The `tanstack` example adapts in its route

TanStack speaks AG-UI on the run stream, but its hydrate requires `UIMessage`s, so the route converts. It uses TanStack's own functions, `modelMessagesToUIMessages(convertMessagesToModelMessages(messages))`: the first folds each `reasoning` message into the `thinking` of the assistant message after it, and the second turns that into a `ThinkingPart`. `convertMessagesToModelMessages` handles AG-UI rows at runtime, but its type doesn't accept them, so the route casts.

A `reasoning` message with no assistant message directly after it is dropped. A step that produced only reasoning therefore shows live and not after a reload. This is accepted for the example: such steps should be rare, the entry stays in the store for the model, and `delta` ignores its rows. `MESSAGES_SNAPSHOT` would avoid the conversion, but it needs an open stream, which a reload doesn't have.

The `ag-ui` example needs no change.

## Risks / Trade-offs

- **[A block that never ends is shown live but not stored]** `fromResponseParts` drops unended reasoning, because it may lack the signature a provider needs for replay. If a step finishes with a block unended, a reload loses it, and any later block in that step would shift to a lower `n` than it streamed under. → Accept it. A provider that finishes a step without ending a block is misbehaving, and the only effect is a client row with an unknown id, which `delta` ignores. Closing the block in fold keeps the stream valid.
- **[A failed step's reasoning is shown but never stored]** → Same as partial text today. No change.
- **[TanStack may split a step into two messages live]** Reasoning arrives before `TEXT_MESSAGE_START`, and TanStack's processor attaches it through `ensureAssistantMessage`, which may create a message under a different id from the step's. → A task runs the example with reasoning on and checks one bubble per step, live and after a reload. This is an example-level fix if needed: the library's stream stays valid AG-UI either way.
- **[Reasoning reaches every client once enabled]** Reasoning can hold content a caller wouldn't show users. → The README says so next to how to enable it. Filtering can be added by mapping the stream if a caller needs it later.
- **[Breaking type change]** `History.ShownMessage` goes away. → The package is `0.0.1`, and the only consumer in the repo is the `tanstack` example.

## Migration Plan

No stored data changes. Threads stored before this change already hold their reasoning parts, so `restore` returns reasoning for them under ids no earlier stream used. Those rows are unknown to `delta` and harmless. A client that has already rendered the old messages keeps them until its next read.

## Open Questions

None. Scope, provider neutrality and how reasoning is enabled were decided before this proposal.
