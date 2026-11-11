## Why

Teams running an agent need to see each run in an LLM observability tool: the conversation, each model call with its tokens and cost, and each tool call. PostHog AI observability and other OpenTelemetry backends read this from the OpenTelemetry GenAI semantic conventions. Today a run exports only `effect/ai`'s model spans plus two library spans with no GenAI attributes, so these tools show it badly. A spike in the `ag-ui` example sent real runs to PostHog and found:

- the trace was named after an internal span and had no latency;
- tool calls had no spans, and their details landed on `Agent.run`;
- the thread wasn't recognised as a session;
- prompts and responses were missing.

## What Changes

- The runner's span becomes the run's GenAI root span: `invoke_agent {agent name}`, starting a new trace and linked to the caller's span. It carries `gen_ai.operation.name`, `gen_ai.agent.name` and `gen_ai.conversation.id` (the thread id), and records the error code when the run fails.
- Each tool call the run actually executes gets an `execute_tool {tool name}` span with the tool name, call id and type. Steps a replay skips, approval requests and frontend calls get no tool span.
- The run puts `gen_ai.conversation.id` on the model call spans `effect/ai` creates, and on nothing else it doesn't own.
- `Agent.define` takes an optional `name`, used as `gen_ai.agent.name`.
- A new `Telemetry` module:
  - `Telemetry.layerCaptureContent` (opt-in) writes prompts, responses, system instructions and tool definitions on model spans, and arguments and results on tool spans, all in the conventions' JSON message format.
  - `Telemetry.SpanAttributes` lets a caller add its own attributes per run (for example a user id) to every span the run creates or annotates.
- The `ag-ui` example becomes the reference setup:
  - export with Effect's own `OtlpTracer`, with batches capped for PostHog;
  - a small PostHog mapping in the example (tool input/output, cache-token accounting, user id) that wraps the tracer.

  The spike's other experiments are removed.
- No new dependencies. Tracing costs nothing unless the application provides a tracer.

## Capabilities

### New Capabilities

- `agent-tracing`: the OpenTelemetry spans and attributes a run produces, how they follow the GenAI semantic conventions, opt-in content capture, and caller-supplied span attributes.

### Modified Capabilities

- `agent-run`: an agent definition can carry an optional name.

## Impact

- `packages/effect-agent-harness`: `src/Agent.ts` (name, tool spans, model span attributes), `src/Runner.ts` (root span), new `src/Telemetry.ts` and its export from `src/index.ts`, tests, `AGENTS.md`, README.
- The span names `effect-agent-harness/Runner.run` change. Anyone filtering on them must update.
- `packages/examples/ag-ui`: `src/telemetry.ts` is rewritten from the spike into the reference setup. The scripted-input mode stays, for the manual checks. `src/server.ts`, `src/index.ts`, `AGENTS.md`.
- Upstream `effect` issues to report, not fixed here:
  - streamed finish reasons use `effect/ai`'s values (`tool-calls`), not the conventions' (`tool_call`);
  - model spans are named `LanguageModel.streamText`, not `chat {model}`;
  - the provider's HTTP span isn't nested under the model span.
