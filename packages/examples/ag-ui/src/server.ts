import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Agent, AgUi, Checkpoint, EventLog, Runner, Sse, Thread } from "effentic";
import { AuthContext, authenticate } from "./auth.ts";
import { SendEmail, sendEmail } from "./tools/email.tool.ts";
import { GetWeather, getWeather } from "./tools/weather.tool.ts";

// The agent's behaviour, independent of the model provider and of any store.
const AssistantToolkit = Toolkit.make(GetWeather, SendEmail);

const assistant = Agent.define({
  toolkit: AssistantToolkit,
  // Resolved once per run, from the run's user and the clock.
  system: Effect.gen(function* () {
    const user = yield* AuthContext;
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    return `
      You are a helpful AI assistant. Be friendly, conversational, and helpful.
      Answer questions to the best of your ability and engage in natural conversation.
      You are talking to ${user.name}. Today is ${today}.
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

// In-memory stores: each thread is kept for the life of the process.
// Swap these for durable implementations in production.
const StoresLayer = Layer.mergeAll(Thread.layerMemory, Checkpoint.layerNone, EventLog.layerMemory);

// The response body is consumed after the handler has returned, so it closes
// over the handler's context. Whatever the stream still needs is a requirement
// of the handler, which the web handler provides from the app layer's
// services (`Layer.provideMerge` below keeps them in the layer's output).
const sse = <R>(frames: Stream.Stream<string, unknown, R>) =>
  Effect.map(Effect.context<R>(), (context) =>
    HttpServerResponse.stream(frames.pipe(Stream.provideContext(context), Stream.encodeText), {
      contentType: Sse.contentType,
      headers: { "cache-control": "no-cache" },
    }),
  );

const invalidInput = (error: { readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(`Invalid RunAgentInput: ${error.message}`, { status: 400 }));

const unauthorized = () => Effect.succeed(HttpServerResponse.empty({ status: 401 }));

// The routes authenticate the request and provide the principal, never the
// token, as the run's `AuthContext`, which the system prompt and the email
// tool require. A real server would also check here that the principal owns
// the thread id: the stores do no access control. That one check also covers
// the thread's runs, because the library keys every run by thread id and run
// id, and the client picks the run id.

const AgentRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // POST /agent: the run streams back as SSE, and ends if the client disconnects.
    yield* router.add(
      "POST",
      "/agent",
      Effect.gen(function* () {
        const principal = yield* authenticate;
        const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
        return yield* sse(Sse.encode(Runner.run(assistant)(input).pipe(Stream.provideService(AuthContext, principal))));
      }).pipe(Effect.catchTag("Unauthorized", unauthorized), Effect.catch(invalidInput)),
    );

    // POST /runs starts a run that outlives the request;
    // GET /threads/:threadId/runs/:runId/events follows it, resuming after the
    // client's `Last-Event-ID`.
    // A detached run outlives the request, so the runner captures its services
    // now and names the one each `start` provides instead.
    const detached = yield* Runner.makeDetached(assistant, { dependencies: [AuthContext] });
    const log = yield* EventLog.EventLog;

    yield* router.add(
      "POST",
      "/runs",
      Effect.gen(function* () {
        const principal = yield* authenticate;
        const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
        yield* detached.start(input).pipe(Effect.provideService(AuthContext, principal));
        return HttpServerResponse.empty({ status: 202 });
      }).pipe(Effect.catchTag("Unauthorized", unauthorized), Effect.catch(invalidInput)),
    );

    yield* router.add(
      "GET",
      "/threads/:threadId/runs/:runId/events",
      Effect.gen(function* () {
        yield* authenticate;
        const { threadId, runId } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({ threadId: Schema.String, runId: Schema.String }),
        );
        const { "last-event-id": lastEventId } = yield* HttpServerRequest.schemaHeaders(
          Schema.Struct({ "last-event-id": Schema.optional(Schema.String) }),
        );

        // Fails before the response starts if the cursor was never issued, so
        // the client gets a 400 instead of a stream that never yields.
        const events = yield* log.subscribe(threadId, runId, lastEventId);
        return yield* sse(Sse.encodeStored(events));
      }).pipe(
        Effect.catchTags({
          Unauthorized: unauthorized,
          InvalidCursor: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
        }),
        Effect.orElseSucceed(() => HttpServerResponse.text("Invalid request", { status: 400 })),
      ),
    );
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(ModelLayer, ToolsLayer, StoresLayer)));

/**
 * The AG-UI endpoints as an in-process web handler (`Request => Promise<Response>`).
 * Swap for `HttpRouter.serve` + `NodeHttpServer` to expose them over the network.
 */
export const { handler, dispose } = HttpRouter.toWebHandler(AgentRoutes, {
  disableLogger: true,
});
