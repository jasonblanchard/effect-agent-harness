## Context

See proposal.md for motivation. Facts this design builds on, from the code and from the PostHog spike in `packages/examples/ag-ui/src/telemetry.ts`:

- **Model spans already exist.** `effect/ai`'s `LanguageModel.streamText` opens a `client` span. `@effect/ai-anthropic` writes the GenAI provider, request, response and usage attributes on it, so PostHog already computes generation tokens and cost.
- **There's a hook for annotating model spans.** `effect/ai` calls the `Telemetry.CurrentSpanTransformer` service, when one is provided, at the end of each `streamText`. It receives the prompt, tools, response parts and the span.
- **Tool calls have no span.** `Toolkit.handle` creates none, and it annotates whatever span is current with `tool` and `parameters`. Today that's `Agent.run`.
- **The runner's span isn't a trace root.** `Runner.run` and `Agent.run` are plain `withSpan`s under the caller's span. PostHog drops the caller's HTTP span because it has no GenAI attributes. It then builds a pseudo-trace named after an arbitrary surviving span, with no latency. In the spike, a GenAI span *with no parent* became a proper `$ai_trace` with a name and latency.
- **Annotating everything is too broad.** `Effect.annotateSpans` / `References.TracerSpanAnnotations` reach every span below them, including the provider's HTTP client spans. In the spike those then passed PostHog's `gen_ai.` filter and showed up as AI spans.
- **The run's event streams never fail.** The `Runner.run` span therefore always ends OK, even when the run ends with `RUN_ERROR`.
- **Effect ships an OTLP exporter.** `effect/observability` has `OtlpTracer`, which needs no `@opentelemetry/*` dependency.

## Goals / Non-Goals

**Goals:**

- Runs that render correctly in PostHog, with only standard GenAI attributes in the library and a thin PostHog-specific mapping on the consumer's side.
- The same spans useful to any backend that follows the OTel GenAI conventions.

**Non-Goals:**

- Exporter setup, sampling or batching in the library. The application provides the `Tracer`.
- Metrics and logs. `gen_ai.client.*` metrics can be a later change.
- Fixing upstream `effect` behaviour: model span names, streamed finish-reason values, HTTP span nesting. These get reported upstream.
- A span option to stay in the caller's trace (see Risks).

## Decisions

### 1. The library emits standard attributes only. PostHog specifics live in the example.

The library writes only attributes from the OTel GenAI conventions, plus `error.type` and its own run id. The PostHog mapping is a `Tracer` wrapper in the `ag-ui` example. When a span ends, the wrapper adds PostHog's properties:
- `$ai_input_state` / `$ai_output_state` on `execute_tool` spans, copied from the tool's arguments and result;
- `$ai_cache_reporting_exclusive: false` and the cache-write count on model spans. The library's `gen_ai.usage.cache_write.input_tokens` is the conventions' name; PostHog just doesn't read it.

It's a tracer wrapper rather than a span transformer because it has to reach the library's tool spans as well as `effect/ai`'s model spans.

*Alternative:* a `Telemetry.layerPostHog` in the library. Rejected for now: it ties the library to one vendor's unstable property names. The example documents the recipe, and it can be promoted once it has settled.

### 2. The runner owns the root span, and it starts a new trace linked to the caller.

Each runner attempt opens `invoke_agent {name}` with `root: true` and a span link to the caller's current span, if there is one. It wraps the whole attempt: input check, `beginAttempt`, the agent, `end`, and `AgUi.fold`. This replaces `effect-agent-harness/Runner.run`. `Agent.run` drops its own span, `effect-agent-harness/Agent.run`, so model and tool spans are direct children of the root. PostHog keeps only spans with GenAI attributes. An attribute-less middle span would be dropped, leaving the model and tool spans pointing at a parent PostHog never received. This was found while implementing.

*Why the runner and not `Agent.run`:* the runner's attempt is what a user sees as "the run". Opening the history (claims, reconciliation) belongs inside it, and `Agent.run` is also called directly by evals, which have their own root. Model and tool spans come from `Agent.run`, so evals still get them.

*Why a new trace:* the spike showed PostHog needs a GenAI root with no parent. The link keeps the HTTP request findable from the run in backends that show links.

### 3. The runner sets the root span's error status itself.

Because the stream never fails, the runner can't rely on `Stream.withSpan`'s exit. It creates the root span itself (`Effect.makeSpanScoped` in the attempt's scope), runs the attempt with that span as parent, and records the outcome when the terminal event goes by. A `Failed` event sets `error.type` to its code and ends the span with a failed exit. Anything else ends it with success. An attempt the consumer abandons, such as a disconnect under `makeAttached`, ends with the scope's interrupt, as spans do today.

### 4. Model spans are annotated by composing a span transformer, not by span annotations.

Around each `LanguageModel.streamText` call, `Agent.run` provides its own `CurrentSpanTransformer`. It runs any transformer already in the context first. It then writes `gen_ai.conversation.id`, the caller's span attributes and, when capture is on, the content attributes onto the span it's given. That reaches only the model span, never the HTTP spans created under it.

*Alternative:* `TracerSpanAnnotations` around the call. Rejected: the spike showed it leaks onto the provider's HTTP spans.

*Cost:* when a transformer is present, `effect/ai` gathers the response parts. `Agent.run` already keeps every part of the step, so nothing new is held for longer.

### 5. Tool spans wrap only the handler, inside the tool's checkpoint.

In `executeTool`, the `execute_tool {name}` span wraps `toolkit.handle` and the wait for its final result. That's after the approval check and inside `memoTool`. So a replayed call, a call awaiting approval, a denied call, an interrupted call and a frontend call all get no span, as the spec requires. `Toolkit.handle`'s own `tool`/`parameters` annotations now land on the tool span rather than `Agent.run`. They're redundant but harmless.

### 6. Replay produces no spans.

This follows from 4 and 5. Model and tool spans exist only inside the checkpointed effects, which don't run on replay. So a resumed attempt's trace shows only the work that attempt did, and PostHog never counts a step's tokens twice. The root span of each attempt is a separate trace with the same `gen_ai.conversation.id`, so a backend's session view groups the attempts.

### 7. `Telemetry` module: two context references and the message conversion.

`src/Telemetry.ts` exports:

- `ContentCapture`: a `Context.Reference` holding whether to capture content, off by default. `layerCaptureContent` is `Layer.succeed(ContentCapture, true)`, or an options object if truncation is added (see Open Questions). It's read inside the run, so it works the same under every runner.
- `SpanAttributes`: a `Context.Reference<Record<string, unknown>>`, `{}` by default. Keys in the `gen_ai.` namespace are dropped: the library owns them, and letting a caller set them (per-run layer values are written after the root span opens) would give different values on different spans of one run. The library adds it explicitly to the root, model and tool spans, and never through `TracerSpanAnnotations`. Under `makeAttached`, the route provides it on the stream. Under `makeDetached`/`makeWorkflow`, `Options.layer` provides it, built from a dependency such as `AuthContext`. That's the same path per-run services already take, so no new runner option is needed.

The conversion from `Prompt` and response parts to the GenAI JSON message format is internal (`src/internal/telemetry.ts`) and isn't exported.
- The system messages that open the prompt go to `gen_ai.system_instructions`. A system message later in the prompt, such as a volatile one placed near the tail for prompt caching, stays in `gen_ai.input.messages` in its position, with role `system`. The trace then shows the order the prompt was built in. How the provider then places it in the request isn't visible to the library and isn't reproduced.
- `tool-call` becomes `tool_call` with parsed arguments.
- `tool-result` becomes `tool_call_response`.
- Reasoning parts with no text are dropped.
- Files become `blob` parts with `mime_type` and `modality` but no data, to keep base64 out of spans.
- Approval request and response parts are dropped, since the conventions have no type for them.
- A file's `modality` is `image`, `video` or `audio` from its media type, and `document` otherwise, the conventions' values.
- Content goes out as JSON text, not structured values: Effect's OTLP exporter can't send structured attribute values. A value that can't be serialised is left out.
- A failed tool call's result is still written to `gen_ai.tool.call.result`, although the conventions describe it for successful calls. It's what the model saw, and the example maps it to PostHog's tool output, where it matters most when a call fails.

### 8. Agent name

`Agent.define({ name?: string })`. It's stored on the `Agent` value and read only by the runner's root span and `gen_ai.agent.name`. It never reaches the prompt or the events.

### 9. The example becomes the reference setup.

`packages/examples/ag-ui/src/telemetry.ts` is rewritten:
- `OtlpTracer` to `${POSTHOG_HOST}/i/v0/ai/otel`, with a `Bearer` token and `maxBatchSize: 100`;
- `Telemetry.layerCaptureContent`;
- the PostHog tracer wrapper (Decision 1);
- `posthog.distinct_id` supplied through `Telemetry.SpanAttributes` from the route's principal.

Everything stays off without `POSTHOG_PROJECT_TOKEN`. The spike's other parts are deleted: experiment flags, `traceTool`, `traceAgent`, prompt-cache padding, scoped-annotation hack. The scripted-input mode in `src/index.ts` stays, because it makes the manual checks repeatable.

## Risks / Trade-offs

- **[The GenAI conventions are still in "Development" status, so attribute names may change.]** → All names live in `src/internal/telemetry.ts` and `Telemetry.ts`, and are tested against literal expected names. A rename is a one-file change.
- **[Starting a new trace breaks one end-to-end trace for backends that prefer that, e.g. APM views.]** → The span link keeps the request reachable. If someone needs to stay in the caller's trace, a runner option can be added later without changing these specs' defaults.
- **[Content capture repeats the whole history and system prompt on every model span. PostHog drops events over 8MB and rejects exports over 4MB.]** → Capture is opt-in. The example caps batches at 100 spans. Truncation is an open question below.
- **[Captured content may contain personal data.]** → Off by default. The docs say what turning it on exports.
- **[Renamed spans break anyone filtering on `effect-agent-harness/Runner.run`.]** → Noted in the proposal and the README. There are no known external consumers yet.
- **[The PostHog mapping relies on undocumented properties (`$ai_cache_reporting_exclusive`, `$ai_input_state`).]** → They live only in the example, and each was verified against PostHog in the spike, apart from the cache-write property (see Open Questions).

## Migration Plan

No data migration. Consumers see renamed spans, and no spans at all unless they provide a tracer. Rollback is reverting the change.

## Open Questions

- **Which PostHog property carries cache-write tokens?** `$ai_cache_creation_input_tokens` is likely. This is verified during implementation by sending a cache-writing run (task 5.4). It only affects the example's mapping.
- **Should content capture truncate long attributes, and with what default?** This can be added to `layerCaptureContent`'s options later without changing the specs, which only say what's captured.
