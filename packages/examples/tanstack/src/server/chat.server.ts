import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { modelMessagesToUIMessages } from "@tanstack/ai";
import { Agent, AgUi, Checkpoint, EventLog, Messages, Runner, Sse, Thread } from "effentic";
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

const HydrateQuery = Schema.Struct({ threadId: Schema.String });

const ChatRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runAgent = yield* Runner.make(assistant);
    const thread = yield* Thread.Thread;

    // GET /api/chat?threadId=…: TanStack AI's server hydrate (`persistence:
    // true`). On mount, the page restores the thread's messages and its open
    // approvals from here, so a reload continues the thread. Runs are
    // request-scoped, so a reload cancels the run in flight: there is never
    // an `activeRun` to rejoin.
    yield* router.add(
      "GET",
      "/api/chat",
      Effect.gen(function* () {
        const { threadId } = yield* HttpServerRequest.schemaSearchParams(HydrateQuery);
        const { messages, interrupts } = Messages.history(yield* thread.load(threadId));
        return yield* HttpServerResponse.json({
          // TanStack's model messages are AG-UI's, except that `content` is required (`null` when absent).
          messages: modelMessagesToUIMessages(
            messages.map((message) => ({ ...message, content: message.content ?? null })),
          ),
          interrupts: interrupts === undefined ? null : interrupts,
          activeRun: null,
        });
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(HttpServerResponse.text("Missing threadId", { status: 400 })),
        ),
      ),
    );

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
