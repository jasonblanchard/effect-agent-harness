import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { convertMessagesToModelMessages, modelMessagesToUIMessages } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { Agent, AgUi, Checkpoint, EventLog, History, Runner, Sse, Thread } from "effect-agent-harness";
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

// Reasoning is switched on here, in the provider's config: effect-agent-harness streams
// whatever the model produces, to every client. Without `display`, the API
// returns thinking blocks with no text. `@effect/ai-anthropic`'s type doesn't
// declare it yet, hence the separate constant.
const thinking = { type: "adaptive", display: "summarized" } as const;

const ModelLayer = AnthropicLanguageModel.layer({
  model: "claude-haiku-5-5",
  config: { thinking },
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const ToolsLayer = AssistantToolkit.toLayer({ "get-weather": getWeather, "send-email": sendEmail });

// The server owns the transcript (`History.layerServer`), because the hydrate
// route below reads each thread back from the store after a reload. Threads
// live in memory for the life of the process, and a crashed run is not
// replayed. `Thread` stays in the output for the hydrate route.
const StoresLayer = Layer.mergeAll(
  History.layerServer.pipe(Layer.provideMerge(Thread.layerMemory)),
  Checkpoint.layerNone,
  EventLog.layerMemory,
);

const ChatQuery = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
});

const ResumeHeaders = Schema.Struct({ "last-event-id": Schema.optional(Schema.String) });

/** How long a run's event stream stays open with nothing new. Longer than the slowest model or tool step. */
const IDLE_TIMEOUT = "2 minutes";

/**
 * A read thread as TanStack's `UIMessage`s, which its hydrate requires: it speaks
 * AG-UI on the run stream, but not here. `convertMessagesToModelMessages` takes
 * AG-UI rows, folding each `reasoning` message into the assistant message after
 * it, though its type doesn't say so, hence the cast. Reasoning with no assistant
 * message directly after it (a step that produced only reasoning) is dropped.
 */
const toUIMessages = (messages: History.Restored["messages"]) =>
  modelMessagesToUIMessages(convertMessagesToModelMessages([...messages] as Array<ModelMessage>));

const ChatRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // A detached run outlives its request and writes to the event log, so a
    // reloaded page or a second tab can follow it. Nothing cancels one once
    // it has started, which is why the page has no Stop button.
    const detached = yield* Runner.makeDetached(assistant);
    const log = yield* EventLog.EventLog;

    // Streams a run's log as SSE, after `after`. A crashed run's log never ends,
    // so the stream ends once nothing has arrived for a while; the client
    // reconnects once and then reports an error.
    const follow = (threadId: string, runId: string, after: string | undefined) =>
      Effect.flatMap(log.subscribe(threadId, runId, after), (events) =>
        events.pipe(Stream.timeout(IDLE_TIMEOUT), Sse.encodeStored, Sse.response),
      );

    // GET /api/chat?threadId=…: TanStack AI's server hydrate (`persistence:
    // true`). On mount, the page restores the thread's messages and its open
    // approvals from here, and learns of a run still going (`activeRun`).
    //
    // GET /api/chat?threadId=…&offset=-1&runId=…: TanStack AI's join of that
    // run, replayed from the start. `-1` is its own marker for "from the start",
    // which the log would reject as a cursor. The rejoining read leaves out what
    // the replay shows, so each message appears once. The thread id comes from
    // the connection URL. A real route would authorise that thread here, which
    // also authorises its runs.
    yield* router.add(
      "GET",
      "/api/chat",
      Effect.gen(function* () {
        const { threadId, runId, offset } = yield* HttpServerRequest.schemaSearchParams(ChatQuery);

        if (runId !== undefined) {
          const { "last-event-id": lastEventId } = yield* HttpServerRequest.schemaHeaders(ResumeHeaders);
          return yield* follow(threadId, runId, lastEventId ?? (offset === "-1" ? undefined : offset));
        }

        const { messages, interrupts, activeRun } = yield* History.restore(threadId, { rejoin: true });

        return yield* HttpServerResponse.json({
          messages: toUIMessages(messages),
          interrupts: interrupts === undefined ? null : interrupts,
          activeRun: activeRun === undefined ? null : activeRun,
        });
      }).pipe(
        Effect.catchTags({
          SchemaError: () => Effect.succeed(HttpServerResponse.text("Missing threadId", { status: 400 })),
          InvalidCursor: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
        }),
      ),
    );

    // POST /api/chat: TanStack AI's `fetchServerSentEvents` posts an AG-UI
    // `RunAgentInput` and reads the AG-UI events back as SSE. A run that stops
    // for an approval is answered by the next run's `resume` entries. The
    // frames carry cursors, so after a dropped connection the client sends the
    // same request again with `Last-Event-ID`: that only follows the run,
    // because starting it again would fork a second attempt beside the first.
    yield* router.add(
      "POST",
      "/api/chat",
      Effect.gen(function* () {
        const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
        const { "last-event-id": lastEventId } = yield* HttpServerRequest.schemaHeaders(ResumeHeaders);

        if (lastEventId === undefined) {
          yield* detached.start(input);
        }

        return yield* follow(input.threadId, input.runId, lastEventId);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(`Invalid request: ${error.message}`, { status: 400 })),
        ),
      ),
    );
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(ModelLayer, ToolsLayer, StoresLayer)));

/** The chat endpoint as a web handler (`Request => Promise<Response>`), mounted by `src/routes/api/chat.ts`. */
export const { handler } = HttpRouter.toWebHandler(ChatRoutes, { disableLogger: true });
