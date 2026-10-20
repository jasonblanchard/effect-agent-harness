import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, Effect, Layer, Stream } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Agent, AgUi, Sse } from "effentic";
import { WeatherToolkit, WeatherToolkitLayer } from "./tools/weather.tool.ts";

const ModelLayer = AnthropicLanguageModel.layer({ model: "claude-haiku-5-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

// POST /agent: decode the AG-UI run input and stream the run back as SSE.
const AgentRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runAgent = yield* Agent.make({
      toolkit: WeatherToolkit,
      system: `
        You are a helpful AI assistant. Be friendly, conversational, and helpful.
        Answer questions to the best of your ability and engage in natural conversation.
      `,
    });
    yield* router.add(
      "POST",
      "/agent",
      HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
        Effect.map((input) =>
          HttpServerResponse.stream(Sse.encode(runAgent(input)).pipe(Stream.encodeText), {
            contentType: Sse.contentType,
            headers: { "cache-control": "no-cache" },
          })
        ),
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(`Invalid RunAgentInput: ${error.message}`, { status: 400 }))
        ),
      ),
    );
  })
).pipe(Layer.provide(Layer.mergeAll(ModelLayer, WeatherToolkitLayer)));

/**
 * The AG-UI endpoint as an in-process web handler (`Request => Promise<Response>`).
 * Swap for `HttpRouter.serve` + `NodeHttpServer` to expose it over the network.
 */
export const { handler, dispose } = HttpRouter.toWebHandler(AgentRoute, { disableLogger: true });
