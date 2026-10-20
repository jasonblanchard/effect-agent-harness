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
3. If `finish.reason === "tool-calls"`, append the step's assistant content and tool results to the prompt and continue.
4. Otherwise emit `RUN_FINISHED`.

Implement it as an explicit unfold over `(prompt, step)`. *Alternative:* `effect/ai` `Chat`, which manages history for you but holds mutable state for each request and hides what goes back to the model. Folding by hand keeps each step a pure function of its input, which mock-model tests rely on.

Configurable step limit (default 10). Exceeding it emits `RUN_ERROR` with a clear message instead of silently truncating the answer.

### 5. Mapping stream parts to events

| `Response.StreamPart` | AG-UI event |
|---|---|
| (run start) | `RUN_STARTED {threadId, runId}` |
| `text-start` / `text-delta` / `text-end` | `TEXT_MESSAGE_START {messageId: stepMsg, role: "assistant"}` / `_CONTENT` / `_END` |
| `tool-params-start` / `-delta` / `-end` | `TOOL_CALL_START {toolCallId, toolCallName, parentMessageId: stepMsg}` / `_ARGS` / `_END` |
| `tool-call` | dropped (already streamed as args) |
| `tool-result` | `TOOL_CALL_RESULT {messageId: mint(), toolCallId, content: JSON}` |
| `finish` | drives the loop |
| `error` part / stream failure | `RUN_ERROR {message}` |
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
| `system` / `developer` | system |
| `user` (string, or text parts) | user text (media parts out of scope) |
| `assistant {content, toolCalls}` | assistant `[text, tool-call(id, name, JSON.parse(arguments))]` |
| `tool {toolCallId, content}` | tool `[tool-result(id, name, parsed content)]` |
| `activity`, `reasoning` | dropped |

An AG-UI `ToolMessage` has no tool name, so the converter looks up the name from earlier assistant `toolCalls` by ID and therefore has to scan the whole message list. Content that is not valid JSON is passed through as a string.

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
- **[Client-supplied history is trusted]** → Fine for a local example. Authentication and history validation are out of scope.
- **[`toWebHandler` hides real network behaviour (buffering, disconnects)]** → An integration test can serve with `NodeHttpServer` on an ephemeral port.

## Open Questions

- **Frontend tools** (`RunAgentInput.tools`): the likely shape is `Tool.dynamic` with JSON Schema, unresolved calls emitted as `TOOL_CALL_*`, and the run ending so the client runs the tool and calls again. Deferred. The design keeps the loop's stopping rule (decision 4) and conversion of tool messages (decision 7) general enough to add this later.
