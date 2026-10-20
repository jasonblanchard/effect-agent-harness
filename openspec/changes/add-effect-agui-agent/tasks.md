## 1. Setup

- [x] 1.1 Add `effect` (catalog) and `@ag-ui/core` to `packages/effentic`, plus a test runner (`vitest`, and `@effect/vitest` if a 4.x release exists) with a `test` script
- [x] 1.2 Give `packages/effentic/package.json` `exports` pointing at `src/index.ts` so workspace consumers can import it directly
- [x] 1.3 Create the module skeleton: `src/AgUi.ts`, `src/Messages.ts`, `src/Agent.ts`, `src/Http.ts`, `src/index.ts`
- [x] 1.4 Confirm `tsc` passes for `packages/effentic` with the empty modules

## 2. AG-UI input and events (`AgUi.ts`)

- [x] 2.1 Define an Effect Schema for the subset of `RunAgentInput` we read (`threadId`, `runId`, `messages` with role/id/content/toolCalls/toolCallId), allowing unknown fields and roles to pass through
- [x] 2.2 Define event constructors for RUN_STARTED/FINISHED/ERROR, TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END/RESULT, typed with `@ag-ui/core` `EventType` and event types
- [x] 2.3 Unit tests: valid input decodes; extra fields are accepted; missing `runId` fails

## 3. Message conversion (`Messages.ts`)

- [x] 3.1 Convert system/developer/user/assistant/tool messages to `Prompt`, dropping unsupported roles
- [x] 3.2 Look up tool names for tool messages from earlier assistant `toolCalls`; JSON-parse arguments and content, falling back to the raw string
- [x] 3.3 Prepend the configured system prompt
- [x] 3.4 Unit tests covering the "Conversation history from the client" scenarios

## 4. Agent loop (`Agent.ts`)

- [x] 4.1 Define agent options (toolkit, system prompt, `maxSteps` default 10) and `run(input)` returning `Stream<AgUiEvent>` that requires `LanguageModel` and the toolkit handlers
- [x] 4.2 Implement the per-step mapping from `Response.StreamPart` to events, with one minted step `messageId` (via `IdGenerator`), `parentMessageId` on tool calls, and a fresh `messageId` per tool result
- [x] 4.3 Track open text and tool spans and close them at step end, at RUN_FINISHED, and on failure
- [x] 4.4 Implement the multi-step loop: fold the step's assistant content and tool results into the prompt and continue while `finish.reason` is `"tool-calls"`; on exceeding `maxSteps`, emit RUN_ERROR
- [x] 4.5 Wrap the run with RUN_STARTED/RUN_FINISHED, and map stream failures to RUN_ERROR with no events after it
- [x] 4.6 Build a scripted mock `LanguageModel` test helper that emits Anthropic-style index part IDs (`"0"` on every step) and a deterministic `IdGenerator` layer
- [x] 4.7 Tests for every `agui-agent-loop` scenario: lifecycle, spans, text, tool calls, multi-step, tool failure returned to the model, step limit, ID uniqueness across steps, tool ID passthrough
- [x] 4.8 Validate the emitted streams with `@ag-ui/client`'s event verifier (e.g. by running them through an `AbstractAgent` subclass) so the client's sequence checks are covered by tests

## 5. Transport edge (`Agent.make`, `Sse.ts`)

- [x] 5.1 Add `Agent.make`: capture the agent's services once and return a runner whose event streams have no requirements
- [x] 5.2 Add `Sse.ts`: a pure `Stream<AgUiEvent>` → SSE frame transform (`effect/encoding/Sse`) and the `text/event-stream` content type, without buffering
- [x] 5.3 Keep HTTP out of the package: no routes, servers, or `effect/http` imports in `src/`
- [x] 5.4 Tests: SSE frames parse back into the expected events; a consumer that stops reading interrupts the run (the mock model observes the interruption)
- [x] 5.5 End-to-end test: a caller-owned `HttpRouter` route (decode → `Agent.make` runner → `Sse.encode`) served through `toWebHandler`, with `HttpAgent` using a custom `fetch`; subscriber callbacks fire and multi-turn history round-trips

## 6. Example migration (`packages/examples/ag-ui`)

- [x] 6.1 Add `effect`, `@effect/ai-anthropic` (4.0.5), and `effentic` (`workspace:*`) dependencies
- [x] 6.2 Port `tools/weather.tool.ts` to an Effect `Tool` + `Toolkit` with handlers (`failureMode: "return"`)
- [x] 6.3 Create `src/server.ts`, which owns the `POST /agent` route (decode → `Agent.make` runner → `Sse.encode`, 400 on bad input), the Anthropic model layer from `ANTHROPIC_API_KEY`, the system instructions carried over from the Mastra agent, the toolkit layer, and an exported in-process web handler
- [x] 6.4 Rewrite `src/agent.ts` to export `new HttpAgent({ url, threadId: "main-conversation", fetch })` that forwards to the in-process handler
- [x] 6.5 Verify the `dev` script's env path loads the repo-root `.env` (the original `../../../.env` is correct; no change needed)
- [x] 6.6 Remove the now-unused Mastra dependencies (`@ag-ui/mastra`, `@mastra/*`) and `zod` if nothing else uses it

## 7. Verification

- [x] 7.1 `tsc` passes for both packages and all tests pass
- [x] 7.2 Manual run of `pnpm dev` in the example with `index.ts` unchanged: plain chat streams text; "what's the weather in Paris?" shows the tool call, args and result, then the answer; a follow-up turn uses earlier context; an unknown city returns a graceful answer
- [x] 7.3 Run `openspec validate add-effect-agui-agent --strict` and fix any issues
