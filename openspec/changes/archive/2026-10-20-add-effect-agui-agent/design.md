## Context

- The workspace catalog pins `effect@4.0.5`. In v4 the AI modules live in core (`effect/ai`: `LanguageModel`, `Tool`, `Toolkit`, `Prompt`, `Response`, `IdGenerator`). HTTP lives in `effect/http`, SSE encoding in `effect/encoding/Sse`, and providers ship as `@effect/ai-<provider>@4.0.5`. The v3 `@effect/ai` docs do not apply.
- `@ag-ui/client@1.0.3` `HttpAgent` sends `POST` with a JSON `RunAgentInput` body and the header `Accept: text/event-stream`. It parses the response as SSE (`data: <json>\n\n`) unless the content type is the AG-UI protobuf media type.
- The client checks every event against a strict sequence, and the run fails if any rule is broken:
  - `RUN_STARTED` comes first.
  - Every `TEXT_MESSAGE_*` and `TOOL_CALL_*` span is opened before it is used and closed before `RUN_FINISHED`.
  - Nothing is sent after `RUN_FINISHED` or `RUN_ERROR`.
- The client applies events to its own `messages` list:
  - `TEXT_MESSAGE_START` with an existing `messageId` reuses that message, and `TEXT_MESSAGE_CONTENT` appends to it.
  - `TOOL_CALL_START.parentMessageId` attaches the call to that assistant message, creating the message if needed.
  - `TOOL_CALL_RESULT` inserts a tool message after the assistant message that owns the `toolCallId`.
- Each run sends the full `messages` history.
- Providers disagree on stream part IDs. Anthropic sets `text-start.id` to the content block index (`"0"`, `"1"`, …), which repeats on every step. OpenAI uses globally unique item IDs. The only contract Effect guarantees is that IDs link the parts of one stream (text start/delta/end, and tool params/call/result).

## Goals / Non-Goals

**Goals:**

- `effentic` depends only on the abstract `LanguageModel` service and never imports a provider package.
- A pure core (`RunAgentInput → Stream<AgUiEvent>`) that is independent of transport, so the loop can be tested without a server or network and callers can serve it however they choose.
- Event streams are deterministic under test (injectable IDs, a scripted mock model).

**Non-Goals:**

- Choosing a design for frontend tools (see Open Questions). The loop must not rule them out.
- Public API stability. The package is version 0.0.1 and its API may change.
- Owning a web server, route, or HTTP status semantics. These belong to the caller (see decision 9).

## Decisions

### 1. Effect v4, not v3

Use `effect@4.0.5` (already in the catalog) with `effect/ai`. v4 includes `Tool.dynamic` (JSON Schema parameters, which frontend tools will need later) and `effect/encoding/Sse`. *Alternative:* v3 `@effect/ai` to match the linked docs. Rejected because it contradicts the catalog pin and would be a dead end.

### 2. Module layout

```
packages/effentic/src/
  AgUi.ts       RunAgentInput Effect Schema (subset) + event constructors using @ag-ui/core types
  Messages.ts   AG-UI Message[] → Prompt
  Agent.ts      run: RunAgentInput → Stream<AgUiEvent, never, LanguageModel | handlers>
                make: capture services → (RunAgentInput) => Stream<AgUiEvent>
  Sse.ts        Stream<AgUiEvent> → Stream<string> (SSE frames) + content type
```

The agent is configured with a `Toolkit`, an optional system prompt, and a step limit. The model itself comes from the environment as a `LanguageModel` layer that the application provides.

### 3. Input validation: decode only the fields we read

Decode `RunAgentInput` with an Effect Schema that covers only the fields the loop reads: `threadId`, `runId`, and `messages` (role, id, content, `toolCalls`, `toolCallId`). Unknown fields and message roles pass through unchanged and are ignored. The decoder is exported so the caller can reject bad input at its own edge (the example returns HTTP 400 before any SSE output). Outgoing events use the `@ag-ui/core` TypeScript types and the `EventType` enum, with no runtime zod. *Alternatives:* use the full `@ag-ui/core` zod schemas (pulls zod onto the Effect boundary and returns untyped errors), or write a full Effect Schema of the spec (too much to maintain for what we use).

### 4. One `streamText` per step, history folded manually

v4 `LanguageModel` has no `maxSteps`. One `streamText` call is one model step. During the step, the toolkit's handlers run and emit `tool-result` parts. The loop:

1. `prompt₀ = system + toPrompt(input.messages)`
2. Stream step *k*. Map each part to AG-UI events and collect the step's parts.
3. If `finish.reason === "tool-calls"` **and every tool call made in the step got a `tool-result`**, append the step's assistant content and tool results to the prompt and continue.
4. Otherwise emit `RUN_FINISHED` with the success outcome. Tool calls that the step made and did not answer are listed in `outcome.pendingToolCallIds`. Calling the model again with unanswered calls would be rejected by the provider. AG-UI also requires a producer to leave such calls to the client, which is how frontend tools will work.

Each step is a stream that, once it ends, either stops or concatenates the next step on the prompt extended with that step's parts. Span bookkeeping for a step lives in a per-step state object that is created inside the run's `Stream.unwrap`, so no state is shared between runs. *Alternative considered:* `Stream.mapAccumEffect` with `onHalt` emitting the closing events, which would carry the same state in an accumulator. Worth adopting if the per-step state grows. *Alternative:* `effect/ai` `Chat`, which manages history for you but holds mutable state for each request and hides what goes back to the model. Folding by hand keeps what goes back to the model explicit, which mock-model tests rely on.

Configurable step limit (default 10, must be a positive integer, checked when the agent is configured). Exceeding it emits `RUN_ERROR` with a clear message instead of silently truncating the answer.

### 5. Mapping stream parts to events

| `Response.StreamPart` | AG-UI event |
|---|---|
| (run start) | `RUN_STARTED {threadId, runId, protocolVersion}` |
| (run end) | `RUN_FINISHED {threadId, runId, outcome: {type: "success", pendingToolCallIds?}}` |
| `text-start` / `text-delta` / `text-end` | `TEXT_MESSAGE_START {messageId: stepMsg, role: "assistant"}` / `_CONTENT` / `_END` |
| `tool-params-start` / `-delta` / `-end` | `TOOL_CALL_START {toolCallId, toolCallName, parentMessageId: stepMsg}` / `_ARGS` / `_END` |
| `tool-call` | dropped (already streamed as args) |
| `tool-result` | `TOOL_CALL_RESULT {messageId: mint(), toolCallId, content: JSON}` |
| `finish` | drives the loop |
| `error` part / stream failure | `RUN_ERROR {message, code}`, where `code` is the error's tag (for `AiError`, its reason's tag) |
| `reasoning-*`, `file`, `source`, `response-metadata` | dropped (for now) |

Before a step ends, or the run finishes or fails, every text span and tool-call span that is still open gets closed. This keeps abrupt provider stream endings from breaking the client's sequence checks.

### 6. Identifiers are independent of the provider

- **Effect part IDs** (text and reasoning) link parts within one stream and never leave the bridge. Passing them through would merge messages: Anthropic's repeated `"0"` would make the client append step 2's text, and later runs' text, onto the first message.
- **AG-UI `messageId`** is minted by effentic: **one per model step**, shared by every text block and used as `parentMessageId` for that step's tool calls. This matches one Effect `Prompt` assistant message, so converting it back on the next run is 1:1. A separate fresh ID is minted for each `TOOL_CALL_RESULT`.
- **Tool-call IDs** pass through unchanged. They are the provider↔conversation contract and must round-trip on the next run. Effect already guarantees an ID, filling in from `IdGenerator` when the provider omits one. Rewriting them would require cross-run mapping on a stateless server and would break provider-executed tools.
- **`threadId` / `runId`** are echoed from the input.
- Minting reuses the `effect/ai` **`IdGenerator`** service (optional, with the default as fallback), so tests can provide a deterministic counter.

*Alternative:* pass every provider ID through. Rejected for the merging bug above.

### 7. Message conversion (AG-UI → Prompt)

| AG-UI | Prompt |
|---|---|
| `system` / `developer` | dropped by default; system with `clientSystem: "allow"` |
| `user` (string, or text parts) | user text. Media parts are out of scope, and a message with no text is skipped. |
| `assistant {content, toolCalls}` | assistant `[text, tool-call(id, name, JSON.parse(arguments))]` |
| `tool {toolCallId, content, error}` | tool `[tool-result(id, name, parsed content, isFailure: error !== undefined)]` |
| `activity`, `reasoning` | dropped |

An AG-UI `ToolMessage` has no tool name, so the converter looks up the name from earlier assistant `toolCalls` by ID and therefore has to scan the whole message list. Content that is not valid JSON is passed through as a string.

**Repairing broken history.** A run that fails or is aborted between `TOOL_CALL_END` and `TOOL_CALL_RESULT` leaves an assistant tool call with no tool message in the client's history. Providers reject a tool call that has no result, so without repair every later run on that thread would fail. A tool call counts as answered only by tool messages that follow its assistant message before the next user, system or assistant message. Any call left unanswered at that point, or at the end of the history, gets a synthetic failed result (`"Tool call did not complete"`). Later tool messages for that call are dropped. Once frontend tools exist, this repair must skip calls that are legitimately pending in the last assistant turn.

**Client system messages.** By default, client `system`/`developer` messages are dropped, so only the server's `system` prompt instructs the model. Otherwise anyone who can call the endpoint could override it. AG-UI's `context` is the sanctioned channel for ambient client information, so dropping them loses nothing. Callers whose clients are trusted to send instructions opt in with `clientSystem: "allow"`. Dropping system messages alone does not make the history trusted: the client still sends assistant turns and tool results.

### 8. Tool failures go back to the model

Server tools use `failureMode: "return"`. Handler failures become `tool-result` parts that the model can react to and are emitted as `TOOL_CALL_RESULT`. Only model/provider errors (`AiError`) and loop violations end the run with `RUN_ERROR`.

### 9. Transports belong to the caller

The package stops at a plain `Stream<AgUiEvent>`. It does not register routes or start servers, and it does not import `effect/http`. Callers own the transport, and encodings are pure stream transforms applied at their edge. This lets the same run serve SSE today and WebSockets or other formats later. *Alternative:* a ready-made `HttpRouter` route in the package. Rejected because it fixes the path, status codes, and wire format, and couples the package to one transport.

Two pieces support the edge:

- **`Agent.make`** captures the model and tool-handler services once (for example when a route layer is built) and returns a runner whose streams have no requirements. Every transport needs this, because a response body or socket is consumed after the handler effect returns. `Agent.run` remains available for callers that provide services themselves.
- **`Sse.encode`** maps each event to one `data: <json>\n\n` frame (via `effect/encoding/Sse`) and exports the `text/event-stream` content type. Callers pipe it through `Stream.encodeText` for a byte body.

Failures inside a run go in-band as `RUN_ERROR`, so status codes only reflect the caller's own checks, such as decoding. When the consumer stops reading (a client disconnect or `abortRun()`), the stream is interrupted, which cancels the in-flight model request.

The example owns a `POST /agent` route built with `HttpRouter.use` + `Agent.make`, serves it in-process through `HttpRouter.toWebHandler`, and passes `fetch: (url, init) => handler(new Request(url, init))` to `HttpAgent`. Serving with `NodeHttpServer` stays a layer swap in the example.

## Risks / Trade-offs

- **[Effect v4 AI APIs marked `@stability unstable`]** → Pin through the catalog and keep provider-facing code limited to `Agent.ts` and `Messages.ts`.
- **[Text blocks in one step are concatenated with no separator]** (text → tool_use → text in a single step) → Acceptable. It matches how the client merges messages. Revisit if formatting suffers.
- **[Assuming `tool-params-*` IDs equal `tool-call`/`tool-result` IDs]** → Verified for Anthropic and OpenAI 4.0.5. Add a mock-model test that pins this assumption.
- **[Client-supplied history is trusted]** → Fine for a local example. Authentication and history validation are out of scope. Client system messages are dropped by default, but clients can still fabricate assistant turns and tool results.
- **[Provider error text reaches the client]** → `RUN_ERROR.message` is the underlying error's message, which may include upstream response details. Callers serving untrusted clients rewrite it by mapping the stream; `code` stays machine-readable.
- **[Provider-executed tools do not survive a second run]** → Their results are emitted as `TOOL_CALL_RESULT` and come back as plain `tool` messages, without the `providerExecuted` flag that providers expect. Unsupported for now. Supporting them means carrying the flag in message `metadata`.
- **[Server-side interruption has no terminal event]** → Interrupting the stream cancels the run and emits nothing more, which is correct when the consumer has gone. A caller that stops runs itself (deadlines, shutdown) must do it in-band, by failing the model call or a tool, so the client still gets `RUN_ERROR`. `RUN_FINISHED` with the cancelled outcome is not emitted.
- **[`toWebHandler` hides real network behaviour (buffering, disconnects)]** → An integration test can serve with `NodeHttpServer` on an ephemeral port.

## Open Questions

- **Frontend tools** (`RunAgentInput.tools`): the likely shape is `Tool.dynamic` with JSON Schema, unresolved calls emitted as `TOOL_CALL_*`, and the run ending so the client runs the tool and calls again. Deferred. The stopping rule (decision 4) already ends the run on unanswered calls and reports them as `pendingToolCallIds`. Two pieces remain: the history repair (decision 7) must skip calls pending in the last assistant turn, and Anthropic extended thinking must round-trip signed reasoning (`REASONING_ENCRYPTED_VALUE`) when a tool call is resolved in a later run. Plan reasoning and frontend tools together.
- **Events from server code, not the model**: state (`STATE_*`), activity, `CUSTOM`, steps, interrupts and subagents all originate in tool handlers or the loop, not in model stream parts. Today only the model can emit events. The intended seam is an `Emitter` service, a queue of AG-UI events merged into the run stream, that tool handlers can depend on. It would extend `Requirements` and the `Event` union. Interrupts will also need the interrupt outcome on `RUN_FINISHED`. Not implemented yet.
