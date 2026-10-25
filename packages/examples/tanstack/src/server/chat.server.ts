import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Stream } from "effect";
import { Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Agent, AgUi, Checkpoint, EventLog, Runner, Sse, Thread } from "effentic";
import { SendEmail, sendEmail } from "../tools/email.tool.ts";
import { GetWeather, getWeather } from "../tools/weather.tool.ts";

// The agent's behaviour, independent of the model provider and of any store.
const AssistantToolkit = Toolkit.make(GetWeather, SendEmail);

const assistant = Agent.define({
  toolkit: AssistantToolkit,
  system: Effect.gen(function* () {
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    return `
      You are a helpful AI assistant. Be friendly, conversational, and concise.
      Reply in plain text: the chat window does not render Markdown.
      Today is ${today}.
    `;
  }),
});

const ModelLayer = AnthropicLanguageModel.layer({
  model: "claude-haiku-5-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const ToolsLayer = AssistantToolkit.toLayer({ "get-weather": getWeather, "send-email": sendEmail });

// Stateless: threads live in memory for the life of the process, and a crashed
// run is not replayed. Approvals still work, because the interrupted thread is
// held in memory until the next run answers them.
const StoresLayer = Layer.mergeAll(Thread.layerMemory, Checkpoint.layerNone, EventLog.layerMemory);

const ChatRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runAgent = yield* Runner.make(assistant);

    // POST /api/chat: TanStack AI's `fetchServerSentEvents` posts an AG-UI
    // `RunAgentInput` and reads the AG-UI events back as SSE. A disconnect
    // (the client's `stop()`) cancels the run. A run that stops for an
    // approval is answered by the next run's `resume` entries.
    yield* router.add(
      "POST",
      "/api/chat",
      Effect.gen(function* () {
        const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
        return HttpServerResponse.stream(Sse.encode(runAgent(input)).pipe(Stream.encodeText), {
          contentType: Sse.contentType,
          headers: { "cache-control": "no-cache" },
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(`Invalid RunAgentInput: ${error.message}`, { status: 400 })),
        ),
      ),
    );
  }),
).pipe(Layer.provide(Layer.mergeAll(ModelLayer, ToolsLayer, StoresLayer)));

/** The chat endpoint as a web handler (`Request => Promise<Response>`), mounted by `src/routes/api/chat.ts`. */
export const { handler } = HttpRouter.toWebHandler(ChatRoutes, { disableLogger: true });
