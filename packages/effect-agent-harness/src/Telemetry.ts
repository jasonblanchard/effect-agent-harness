/**
 * OpenTelemetry for agent runs, following the OpenTelemetry GenAI semantic
 * conventions (https://opentelemetry.io/docs/specs/semconv/gen-ai/).
 *
 * A run traces itself whenever the application provides a `Tracer` (e.g.
 * `OtlpTracer` from `effect/observability`): each runner attempt is one
 * `invoke_agent {name}` root span, which starts a new trace linked to the
 * caller's span. Under it are the model calls `effect/ai` traces, with
 * `gen_ai.conversation.id` (the thread id) added, and one
 * `execute_tool {name}` span per tool call the run actually executes. A step
 * replayed from a checkpoint is not traced again.
 *
 * Nothing here is needed for that. This module holds the two opt-in parts:
 *
 * - {@link layerCaptureContent} adds prompts, responses, the system prompt,
 *   tool definitions, and tool arguments and results to those spans. It is off
 *   by default, because the content may hold personal data.
 * - {@link SpanAttributes} adds the caller's own attributes, such as a user id,
 *   to the spans of one run.
 */
import { Context, Layer } from "effect";

/**
 * Whether a run writes message and tool content on its spans. Off by default;
 * provide {@link layerCaptureContent} to turn it on.
 */
export const ContentCapture = Context.Reference<boolean>("effect-agent-harness/Telemetry/ContentCapture", {
  defaultValue: () => false,
});

/**
 * Turns on content capture. Model call spans get `gen_ai.system_instructions`,
 * `gen_ai.input.messages`, `gen_ai.output.messages` and
 * `gen_ai.tool.definitions`; tool spans get `gen_ai.tool.call.arguments` and
 * `gen_ai.tool.call.result`. All are JSON text in the GenAI conventions'
 * formats: the conventions ask for structured values, but Effect's OTLP
 * exporter can only send text. A value that can't be serialised is left out.
 * A file part is recorded as a `blob` without its data. A failed tool call's
 * result is recorded too, since it's what the model was given.
 *
 * Every model call span holds the whole prompt, so spans grow with the
 * conversation: check your backend's size limits.
 */
export const layerCaptureContent: Layer.Layer<never> = Layer.succeed(ContentCapture, true);

/**
 * Attributes to add to every span a run creates or annotates: its root span,
 * its model call spans and its tool spans, and no other span. Empty by
 * default. Keys in the `gen_ai.` namespace are ignored: the library sets
 * those, and a caller's value would split a run's spans across sessions.
 *
 * Provide it per run: on the run's stream for `Runner.makeAttached`, or
 * through the runner's `Options.layer` for `makeDetached` and `makeWorkflow`,
 * built from a dependency such as the verified principal.
 *
 * ```ts
 * Stream.provideService(Telemetry.SpanAttributes, { "user.id": principal.userId })
 * ```
 */
export const SpanAttributes = Context.Reference<Readonly<Record<string, unknown>>>(
  "effect-agent-harness/Telemetry/SpanAttributes",
  { defaultValue: () => ({}) },
);
