## Why

The `ag-ui` example currently runs its agent in-process through Mastra (`MastraAgent`). We want an Effect-native agent runtime that speaks the AG-UI protocol, so any AG-UI client (starting with `HttpAgent` from `@ag-ui/client`) can drive an agent built on `effect/ai` without coupling to a specific model provider.

## What Changes

- Add the `effentic` package (`packages/effentic`), built on Effect v4 (`effect@4.0.5`, `effect/ai`, `effect/encoding/Sse`). The package does not own a web server or route.
- Provide an agent loop that turns an AG-UI `RunAgentInput` into a stream of AG-UI events by driving `LanguageModel.streamText` step by step, resolving server-side tools, and continuing while the model finishes with tool calls.
- Convert AG-UI conversation messages into an Effect `Prompt` on every run, so the server holds no state and the client owns history.
- Keep transports at the caller's edge. The agent emits a plain stream of AG-UI events, and the package exports a pure SSE encoder (events → SSE frames, the format `HttpAgent` expects), the `RunAgentInput` decoder, and a way to capture the agent's services so callers can serve the stream over HTTP, WebSockets, or any other transport they own.
- Assign AG-UI identifiers independently of the provider: message IDs are minted per model step and per tool result, tool-call IDs pass through unchanged, and thread and run IDs are echoed from the input.
- Return tool handler failures to the model as tool results instead of failing the run.
- Update `packages/examples/ag-ui` so that it owns its HTTP route (`POST /agent` → SSE) and serves it in-process through `HttpRouter.toWebHandler`. `agent.ts` exports an `HttpAgent` with a custom `fetch` pointing at that handler. Port the weather tool to an Effect `Tool`, and leave `index.ts` unchanged.

### Non-goals

- Client-provided (frontend) tools from `RunAgentInput.tools`. These are not decided yet, and the loop must not preclude them.
- Protobuf transport, shared state (`STATE_*`), reasoning events, steps, subagents, and interrupts/resume.
- Persisting threads on the server.

## Capabilities

### New Capabilities

- `agui-agent-loop`: Runs an `effect/ai` agent loop for an AG-UI `RunAgentInput` and emits a well-formed AG-UI event stream. Covers run lifecycle, text and tool-call event mapping, multi-step tool resolution, converting messages to a `Prompt`, identifier rules, and error reporting.
- `agui-transport-edge`: Lets callers expose the agent through a transport they own. Covers lenient decoding of `RunAgentInput`, runners with no service requirements, SSE encoding compatible with `HttpAgent`, and cancellation when the consumer stops.

### Modified Capabilities

(none)

## Impact

- **New package**: `packages/effentic`. Dependencies: `effect` (catalog), `@ag-ui/core` (types only). It depends only on the abstract `LanguageModel` service, not on any provider package.
- **Example**: `packages/examples/ag-ui` gains `effect`, `@effect/ai-anthropic`, and `effentic` (workspace) as dependencies. It adds `server.ts`, which owns the HTTP route, and rewrites `agent.ts` and `tools/weather.tool.ts`. The Mastra dependencies are removed.
- **Workspace**: Effect v4 enters the repo for the first time (`effect` is already pinned in the catalog but not yet installed).
