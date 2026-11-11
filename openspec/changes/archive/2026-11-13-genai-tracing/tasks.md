## 1. Telemetry module and test support

- [x] 1.1 Add `src/Telemetry.ts` with `ContentCapture` (`Context.Reference<boolean>`, default `false`), `layerCaptureContent` and `SpanAttributes` (`Context.Reference<Record<string, unknown>>`, default `{}`). Export it as `Telemetry` from `src/index.ts`.
- [x] 1.2 Add `src/internal/telemetry.ts`:
  - the attribute-name constants;
  - the conversion from `Prompt` and response parts to the GenAI input/output message JSON (system instructions split out, empty reasoning dropped, files as data-less `blob`, approval parts dropped);
  - tool definitions JSON.
- [x] 1.3 Unit-test the conversion: user text, tool call and result, reasoning (empty and non-empty), file part, system prompt split, output finish reason.
- [x] 1.4 Add a recording tracer to `test/fixtures.ts`. It records each ended span's name, parent, root/links, attributes and exit, and lets tests find spans by name and walk parents.

## 2. Agent: name, model spans and tool spans

- [x] 2.1 Add optional `name` to `Agent.define` and the `Agent` value. Test that prompts and events are identical with and without it.
- [x] 2.2 Around each `LanguageModel.streamText` in `modelStep`, provide a `CurrentSpanTransformer`. It runs any existing transformer first, then writes `gen_ai.conversation.id` and the `SpanAttributes`. With `ContentCapture` on, it also writes system instructions, input/output messages and tool definitions.
- [x] 2.3 In `executeTool`, wrap the handler (`toolkit.handle` and its final result) in an `execute_tool {name}` span with the GenAI tool attributes, the conversation id and the `SpanAttributes`. Set `error.type` on a failure result. With capture on, add arguments and result.
- [x] 2.4 Drop `threadId`/`runId` from the `effect-agent-harness/Agent.run` span.
- [x] 2.5 Tests:
  - two-step run: model spans carry the conversation id;
  - tool span attributes, and no `tool`/`parameters` on other spans;
  - approval requested, denied and frontend calls have no tool span;
  - approved call on resume has one;
  - failure result sets `error.type`;
  - no content attributes without capture;
  - content attributes with capture.
- [x] 2.6 Test that a span created by the model layer's own child effects (simulate an HTTP client span inside the scripted model) gets neither the conversation id nor the caller's attributes.

## 3. Runner: root span

- [x] 3.1 Replace the `effect-agent-harness/Runner.run` span with a manually managed root span. It's named `invoke_agent {name}` (or `invoke_agent`), with `root: true` and a link to `Effect.currentParentSpan` when present. Attributes: `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`, the run id and the `SpanAttributes`. It covers the whole attempt, including `beginAttempt`, `end` and `fold`.
- [x] 3.2 End the root span with a failed exit and `error.type` = the code when the terminal event is `Failed`, and with success otherwise. Check that an abandoned `makeAttached` stream still ends the span.
- [x] 3.3 Apply the same root span to `makeDetached` and `makeWorkflow` attempts.
- [x] 3.4 Tests:
  - one span with no parent per attempt, named for the agent;
  - link present when run inside a parent span;
  - model and tool spans are descendants;
  - `ModelStreamError` sets error status while the AG-UI stream still ends with `RUN_ERROR` and passes `verify`;
  - an interrupt outcome is not an error.
- [x] 3.5 Replay test: a crash in step 2 under `Checkpoint.layerMemoryLedger`, then the same run id again. The second attempt has no model span for step 1 and no tool span for its call.
- [x] 3.6 Test the run with no tracer, then with a recording tracer, capture and attributes. Both emit the same events and the model receives the same prompts.
- [x] 3.7 Per-run attributes test: two runs through one runner with different `SpanAttributes` (on the stream for `makeAttached`, via `Options.layer` for `makeDetached`) carry their own values.

## 4. Library docs

- [x] 4.1 Update `packages/effect-agent-harness/AGENTS.md`:
  - the `Telemetry` module;
  - the span layout;
  - the "spans only for executed work" rule;
  - the rule that the library never uses `TracerSpanAnnotations` to reach spans it doesn't own.
- [x] 4.2 Add a README section on tracing:
  - providing a tracer;
  - content capture and its privacy implications;
  - per-run attributes for each runner;
  - the renamed root span.

## 5. Example: reference PostHog setup

- [x] 5.1 Rewrite `packages/examples/ag-ui/src/telemetry.ts`:
  - `OtlpTracer` layer to `/i/v0/ai/otel` with a bearer token and `maxBatchSize: 100`, off without `POSTHOG_PROJECT_TOKEN`;
  - `Telemetry.layerCaptureContent`;
  - the PostHog tracer wrapper (tool `$ai_input_state`/`$ai_output_state`, `$ai_cache_reporting_exclusive: false` on model spans).

  Delete the spike's flags, `traceTool`, `traceAgent`, `PromptCacheLayer` and scoped-annotation wrapper.
- [x] 5.2 In `src/server.ts`:
  - give the agent a name;
  - remove the spike wrappers;
  - provide `Telemetry.SpanAttributes` with `posthog.distinct_id` from the principal (on the stream for `/agent`, via the runner's `Options.layer` for `/runs`).
- [ ] 5.3 Keep the scripted-input mode and the flush-on-exit in `src/index.ts`. Replace the "SPIKE" section of the example's `AGENTS.md` with a "Tracing" section and a manual check: run the scripted weather + approved-email conversation and confirm in PostHog that each run is a trace named `invoke_agent assistant`, with tool input and output, the session `main-conversation` and the person `demo`.
- [ ] 5.4 Find PostHog's cache-write property. Temporarily enable Anthropic prompt caching on a large system prompt, send a cache-writing run, and check whether PostHog prices the cache write correctly with the wrapper mapping `gen_ai.usage.cache_write.input_tokens` to the candidate property. Keep the mapping if it works; otherwise record the gap in the example's `AGENTS.md`. Remove the temporary caching afterwards.

## 6. Wrap-up

- [ ] 6.1 File upstream `effect` issues: model span name (`chat {model}`), provider HTTP span not nested under the model span, a transformer provided at `LanguageModel` layer build time can't be chained by a per-call one, streamed finish reasons use `effect/ai`'s values rather than the conventions'. (Cache writes are not an issue: `gen_ai.usage.cache_write.input_tokens` is the conventions' name; PostHog doesn't read it, and the example bridges that.) Link them from the README's tracing section.
- [x] 6.2 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding.
