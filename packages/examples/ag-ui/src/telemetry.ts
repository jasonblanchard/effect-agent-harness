/**
 * Tracing to PostHog AI observability.
 *
 * The library traces each run following the OpenTelemetry GenAI semantic
 * conventions (see docs/robodocs.md, "Tracing"). This file only exports those spans
 * to PostHog's OTLP endpoint, with content capture on, and adds the few
 * PostHog-specific properties its trace view and cost accounting need. Off
 * unless `POSTHOG_PROJECT_TOKEN` is set (`POSTHOG_HOST` defaults to the US
 * cloud).
 */
import { Config, Effect, Layer, Option, Redacted, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/observability";
import { Telemetry } from "effect-agent-harness";
import type { Principal } from "./auth.ts";

/**
 * Adds PostHog's own properties to the GenAI spans when they end:
 *
 * - Tool spans: PostHog shows a span's input and output only from
 *   `$ai_input_state` / `$ai_output_state`, not from the conventions'
 *   `gen_ai.tool.call.arguments` / `result`.
 * - Model call spans: the conventions count cached tokens inside
 *   `gen_ai.usage.input_tokens`, but PostHog assumes Anthropic's own
 *   reporting, where they are excluded, and so charges cache reads twice.
 *   `$ai_cache_reporting_exclusive: false` tells it otherwise.
 *   Cache writes come as the conventions' `gen_ai.usage.cache_write.input_tokens`,
 *   which PostHog doesn't read, so they're copied to
 *   `$ai_cache_creation_input_tokens`.
 */
const withPostHogProperties = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
    span(options) {
      const span = tracer.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        const attributes = span.attributes;
        const operation = attributes.get("gen_ai.operation.name");
        if (operation === "execute_tool") {
          copy(span, "gen_ai.tool.call.arguments", "$ai_input_state");
          copy(span, "gen_ai.tool.call.result", "$ai_output_state");
        } else if (operation === "chat") {
          span.attribute("$ai_cache_reporting_exclusive", false);
          copy(span, "gen_ai.usage.cache_write.input_tokens", "$ai_cache_creation_input_tokens");
        }
        end(endTime, exit);
      };
      return span;
    },
  });

const copy = (span: Tracer.Span, from: string, to: string) => {
  const value = span.attributes.get(from);
  if (value !== undefined) {
    span.attribute(to, value);
  }
};

/** The tracer exporting to PostHog, with content capture, or nothing without a token. */
export const TracingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.option(Config.Redacted("POSTHOG_PROJECT_TOKEN"));
    if (Option.isNone(token)) {
      return Layer.empty;
    }
    const host = yield* Config.String("POSTHOG_HOST").pipe(Config.withDefault("https://us.i.posthog.com"));
    const tracer = OtlpTracer.make({
      // PostHog's traces endpoint, as is: no `/v1/traces` suffix.
      url: `${host.replace(/\/$/, "")}/i/v0/ai/otel`,
      headers: { authorization: `Bearer ${Redacted.value(token.value)}` },
      resource: { serviceName: "effect-agent-harness-ag-ui-example" },
      // PostHog rejects an export holding more than 100 AI spans.
      maxBatchSize: 100,
      exportInterval: "1 second",
    });
    return Layer.effect(Tracer.Tracer, Effect.map(tracer, withPostHogProperties)).pipe(
      Layer.provideMerge(OtlpExporter.layerFlusher),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.merge(Telemetry.layerCaptureContent),
    );
  }),
).pipe(Layer.orDie);

/** A run's span attributes: PostHog reads the person from `posthog.distinct_id`. */
export const spanAttributes = (principal: Principal) => ({ "posthog.distinct_id": principal.userId });
