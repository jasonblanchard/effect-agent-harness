import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { AgUiSchema, AgUiServer, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Agent, Checkpoint, EventLog, Runner, Telemetry } from "effect-agent-harness";
import { AuthContext, Authentication, AuthenticationLayer } from "./auth.ts";
import { spanAttributes, TracingLayer } from "./telemetry.ts";
import { SendEmail, sendEmail } from "./tools/email.tool.ts";
import { GetWeather, getWeather } from "./tools/weather.tool.ts";

// The agent's behaviour, independent of the model provider and of any store.
const AssistantToolkit = Toolkit.make(GetWeather, SendEmail);

const assistant = Agent.define({
  // Names the agent in traces only.
  name: "assistant",
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

// No thread store: the client owns the transcript and sends it whole with
// every run (the default client history), so nothing is kept between runs but
// the event log. Swap these for durable implementations in production.
const StoresLayer = Layer.mergeAll(Checkpoint.layerNone, EventLog.layerMemory);

// -----------------------------------------------------------------------------
// The API
//
// Every endpoint is authenticated (`401` without the demo token), and the
// middleware provides the principal, never the token, as `AuthContext`, which
// the system prompt and the email tool require. A real server would also check
// that the principal owns the thread id: the stores do no access control. That
// one check also covers the thread's runs, because the library keys every run
// by thread id and run id, and the client picks the run id.
// -----------------------------------------------------------------------------

const RunIds = { threadId: Schema.String, runId: Schema.String };

/** An event from the log as an SSE frame: its cursor is the frame's `id`, which a reconnecting client sends back as `Last-Event-ID`. */
const StoredEvent = Schema.Struct({
  id: Schema.String,
  event: Schema.String,
  data: Schema.fromJsonString(Schema.toCodecJson(AgUiSchema.Event)),
});

export class AgentApi extends HttpApi.make("agent").add(
  HttpApiGroup.make("agent")
    // POST /agent: the run streams back as SSE, and ends if the client disconnects.
    .add(AgUiServer.endpoint("run", "/agent"))
    // POST /runs starts a run that outlives the request, and answers 202 at once.
    .add(
      HttpApiEndpoint.post("start", "/runs", { payload: AgUiSchema.RunAgentInput, success: HttpApiSchema.Empty(202) }),
    )
    // POST /threads/:threadId/runs/:runId/cancel stops a detached run: it ends
    // with `RUN_FINISHED` outcome `cancelled`, and what it streamed so far is
    // kept. It returns at once; follow the events endpoint to see the end.
    // Cancelling a run that has ended does nothing.
    .add(
      HttpApiEndpoint.post("cancel", "/threads/:threadId/runs/:runId/cancel", {
        params: RunIds,
        success: HttpApiSchema.Empty(202),
      }),
    )
    // GET /threads/:threadId/runs/:runId/events follows a run from the event
    // log, resuming after the client's `Last-Event-ID`. A cursor the log never
    // issued is a 400 before any event is sent.
    .add(
      HttpApiEndpoint.get("events", "/threads/:threadId/runs/:runId/events", {
        params: RunIds,
        headers: { "last-event-id": Schema.optional(Schema.String) },
        success: HttpApiSchema.WithHeaders(HttpApiSchema.StreamSse({ events: StoredEvent }), {
          "cache-control": Schema.Literal("no-cache"),
        }),
        error: EventLog.InvalidCursor.pipe(HttpApiSchema.status(400)),
      }),
    )
    .middleware(Authentication),
) {}

const AgentHandlers = HttpApiBuilder.group(
  AgentApi,
  "agent",
  Effect.fn(function* (handlers) {
    const runAgent = Runner.makeAttached(assistant);
    // A detached run outlives the request, so the runner captures its services
    // now and names the one each `start` provides instead. Its span attributes
    // are built per run from that dependency.
    const detached = yield* Runner.makeDetached(assistant, {
      dependencies: [AuthContext],
      layer: Layer.effect(
        Telemetry.SpanAttributes,
        Effect.gen(function* () {
          return spanAttributes(yield* AuthContext);
        }),
      ),
    });
    const log = yield* EventLog.EventLog;

    return handlers
      .handle(
        "run",
        // The endpoint provides the handler's context, including the principal, to the stream it reads.
        AgUiServer.handler((input) =>
          Stream.unwrap(
            Effect.map(AuthContext, (principal) =>
              runAgent(input).pipe(Stream.provideService(Telemetry.SpanAttributes, spanAttributes(principal))),
            ),
          ),
        ),
      )
      .handle("start", ({ payload }) => detached.start(payload))
      .handle("cancel", ({ params }) => detached.cancel(params))
      .handle("events", ({ params, headers }) =>
        log.subscribe(params.threadId, params.runId, headers["last-event-id"]).pipe(
          // A store failure is the server's fault (500); an unissued cursor stays the client's (400).
          Effect.catchTag("EventLogError", Effect.die),
          Effect.map((events) =>
            HttpApiSchema.withHeaders({
              // A store failure mid-stream aborts the response, as a failing body would.
              body: events.pipe(
                Stream.map(({ cursor, event }) => ({ id: cursor, event: "message", data: event })),
                Stream.orDie,
              ),
              headers: { "cache-control": "no-cache" as const },
            }),
          ),
        ),
      );
  }),
);

// The run stream reads its services from each request's context, so they must be in the layer's output
// (`Layer.provideMerge`), which the web handler provides to every request. `Layer.provide` would hide them.
const ApiRoutes = HttpApiBuilder.layer(AgentApi).pipe(
  Layer.provide(AgentHandlers),
  Layer.provide(AuthenticationLayer),
  Layer.provideMerge(Layer.mergeAll(ModelLayer, ToolsLayer, StoresLayer, TracingLayer)),
);

/**
 * The AG-UI endpoints as an in-process web handler (`Request => Promise<Response>`).
 * Swap for `HttpRouter.serve` + `NodeHttpServer` to expose them over the network.
 */
export const { handler, dispose } = HttpRouter.toWebHandler(ApiRoutes.pipe(Layer.provide(HttpServer.layerServices)), {
  disableLogger: true,
});
