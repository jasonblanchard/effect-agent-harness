import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, DateTime, Effect, Layer, Schema, Stream } from "effect";
import { AgUiSchema, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { convertMessagesToModelMessages, modelMessagesToUIMessages } from "@tanstack/ai";
import type { ModelMessage, SubagentPart, UIMessage } from "@tanstack/ai";
import { Agent, Checkpoint, EventLog, History, Runner, Thread } from "effect-agent-harness";
import { SendEmail, sendEmail } from "../tools/email.tool.ts";
import { SearchDocs, searchDocs } from "../tools/search-docs.tool.ts";
import { GetWeather, getWeather } from "../tools/weather.tool.ts";

// The agent's behaviour, independent of the model provider and of any store.
const AssistantToolkit = Toolkit.make(GetWeather, SendEmail, SearchDocs);

// A subagent: an agent of its own, which the assistant's model calls as a tool
// named after it. Its work streams to the page as a card, and a call it makes
// that needs approval suspends the assistant until the user answers.
const weatherDesk = Agent.define({
  name: "weather-desk",
  description:
    "Checks the weather in one or more places and writes a short report, which it can email. " +
    "Give it the places, what to compare, and who to email, if anyone.",
  toolkit: AssistantToolkit,
  system: `
    You are a weather desk. Check the weather for each place you are given, then reply with a
    short report in plain text. Email it only if you were asked to.
  `,
});

const assistant = Agent.define({
  toolkit: AssistantToolkit,
  system: Effect.gen(function* () {
    const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
    return `
      You are a helpful AI assistant. Be friendly, conversational, and concise.
      Reply in plain text: the chat window does not render Markdown.
      For a weather report on several places, or one to be emailed, ask the weather desk.
      Today is ${today}.
    `;
  }),
  subagents: { agents: [weatherDesk] },
});

/** The subagents the hydrate route can show, by name. */
const subagentsByName = new Map((assistant.subagents?.agents ?? []).map((agent) => [agent.name, agent]));

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

const ToolsLayer = AssistantToolkit.toLayer({
  "get-weather": getWeather,
  "send-email": sendEmail,
  "search-docs": searchDocs,
});

// The server owns the transcript (`History.layerServer`), because the hydrate
// route below reads each thread back from the store after a reload. Threads
// live in memory for the life of the process, and a crashed run is not
// replayed. `Thread` stays in the output for the hydrate route.
const StoresLayer = Layer.mergeAll(
  History.layerServer.pipe(Layer.provideMerge(Thread.layerMemory)),
  Checkpoint.layerNone,
  EventLog.layerMemory,
);

const ChatQuery = {
  threadId: Schema.String,
  runId: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
};

const ResumeHeaders = { "last-event-id": Schema.optional(Schema.String) };

/** What TanStack AI's `stop()` posts to `cancelUrl`. */
const CancelBody = Schema.Struct({ threadId: Schema.String, runId: Schema.String });

/** An event from the log as an SSE frame: its cursor is the frame's `id`, which a reconnecting client sends back as `Last-Event-ID`. */
const StoredEvent = Schema.Struct({
  id: Schema.String,
  event: Schema.String,
  data: Schema.fromJsonString(Schema.toCodecJson(AgUiSchema.Event)),
});

/** A run's events, followed from the log. */
const RunEvents = HttpApiSchema.WithHeaders(HttpApiSchema.StreamSse({ events: StoredEvent }), {
  "cache-control": Schema.Literal("no-cache"),
});

/** TanStack AI's server hydrate: the thread's `UIMessage`s, its open approvals, and the run still going, if any. */
const Hydrate = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  interrupts: Schema.NullOr(Schema.Unknown),
  activeRun: Schema.NullOr(Schema.Unknown),
});

/** How long a run's event stream stays open with nothing new. Longer than the slowest model or tool step. */
const IDLE_TIMEOUT = "2 minutes";

/**
 * A read thread as TanStack's `UIMessage`s, which its hydrate requires: it speaks
 * AG-UI on the run stream, but not here. `convertMessagesToModelMessages` takes
 * AG-UI rows, folding each `reasoning` message into the assistant message after
 * it, though its type doesn't say so, hence the cast. Reasoning with no assistant
 * message directly after it (a step that produced only reasoning) is dropped.
 */
const toUIMessages = (messages: ReadonlyArray<History.Restored["messages"][number]>) =>
  modelMessagesToUIMessages(convertMessagesToModelMessages([...messages] as Array<ModelMessage>));

/**
 * A read thread as `UIMessage`s, with each subagent's messages in a `subagent`
 * part on the message holding the call that spawned it, as TanStack builds them
 * from a live run. The read tags a subagent's messages with its
 * `subagentRunId`, which `Agent.subagentIdFor` derives from the spawning call;
 * the card's name, description and status come from that call, the agent's
 * definition, and whether the call has a result or an open interrupt.
 */
const toUIMessagesWithSubagents = (
  messages: History.Restored["messages"],
  interrupts: History.Restored["interrupts"],
): Array<UIMessage> => {
  const byOwner = Map.groupBy(messages, (message) => message.subagentRunId);
  const build = (owner: string | undefined): Array<UIMessage> => {
    // TanStack's converter would split tagged messages off again: they are this level's own.
    const own = (byOwner.get(owner) ?? []).map((tagged) => {
      const { subagentRunId: _, ...message } = tagged;
      return message;
    });
    const ui = toUIMessages(own);
    for (const message of own) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        const id = Agent.subagentIdFor(call.id);
        if (!byOwner.has(id)) continue;
        const answer = own.find((m) => m.role === "tool" && m.toolCallId === call.id);
        // A failed child's call has a result too: its error, as the live card's `SUBAGENT_ERROR` showed.
        const error = answer?.role === "tool" ? answer.error : undefined;
        const interruptIds = (interrupts?.pending ?? []).flatMap((i) => (i.subagentRunId === id ? [i.id] : []));
        const description = subagentsByName.get(call.function.name)?.description;
        const part: SubagentPart = {
          type: "subagent",
          subagent: {
            id,
            name: call.function.name,
            ...(description === undefined ? {} : { description }),
            status: answer === undefined ? "suspended" : error === undefined ? "finished" : "error",
            ...(error === undefined ? {} : { error: { message: error } }),
            ...(owner === undefined ? {} : { parentSubagentRunId: owner }),
            parentToolCallId: call.id,
            ...(interruptIds.length === 0 ? {} : { interruptIds }),
            messages: build(id),
          },
        };
        const host = ui.findLast((m) => m.parts.some((p) => p.type === "tool-call" && p.id === call.id));
        if (host !== undefined) host.parts = [...host.parts, part];
      }
    }
    return ui;
  };
  return build(undefined);
};

// The chat's endpoints, as TanStack AI calls them. They are not `AgUiServer.endpoint`: every run is detached, and
// its stream follows the event log with cursors as SSE ids, so a client reconnects with `Last-Event-ID`. A real
// server would authorise the thread on every endpoint, which also authorises its runs.
class ChatApi extends HttpApi.make("chat").add(
  HttpApiGroup.make("chat")
    // GET /api/chat?threadId=…: TanStack AI's server hydrate (`persistence:
    // true`). On mount, the page restores the thread's messages and its open
    // approvals from here, and learns of a run still going (`activeRun`).
    //
    // GET /api/chat?threadId=…&offset=-1&runId=…: TanStack AI's join of that
    // run, replayed from the start. `-1` is its own marker for "from the start",
    // which the log would reject as a cursor. The rejoining read leaves out what
    // the replay shows, so each message appears once.
    .add(
      HttpApiEndpoint.get("read", "/api/chat", {
        query: ChatQuery,
        headers: ResumeHeaders,
        success: [Hydrate, RunEvents],
        error: EventLog.InvalidCursor.pipe(HttpApiSchema.status(400)),
      }),
    )
    // POST /api/chat: TanStack AI's `fetchServerSentEvents` posts an AG-UI
    // `RunAgentInput` and reads the AG-UI events back as SSE. A run that stops
    // for an approval is answered by the next run's `resume` entries. After a
    // dropped connection the client sends the same request again with
    // `Last-Event-ID`: that only follows the run, because starting it again
    // would fork a second attempt beside the first.
    .add(
      HttpApiEndpoint.post("send", "/api/chat", {
        payload: AgUiSchema.RunAgentInput,
        headers: ResumeHeaders,
        success: RunEvents,
        error: EventLog.InvalidCursor.pipe(HttpApiSchema.status(400)),
      }),
    )
    // POST /api/chat/cancel: the page's Stop button. TanStack AI's `stop()`
    // aborts its own stream and posts the run's ids here (`cancelUrl`). The run
    // ends as cancelled: its log ends with `RUN_FINISHED` outcome `cancelled`,
    // and the partial reply is committed to the thread, which is then free for
    // the next message. Cancelling a run that has ended does nothing.
    .add(HttpApiEndpoint.post("cancel", "/api/chat/cancel", { payload: CancelBody, success: HttpApiSchema.NoContent })),
) {}

const ChatHandlers = HttpApiBuilder.group(
  ChatApi,
  "chat",
  Effect.fn(function* (handlers) {
    // A detached run outlives its request and writes to the event log, so a
    // reloaded page or a second tab can follow it. A disconnect doesn't stop
    // it; only `detached.cancel` does (the cancel endpoint).
    const detached = yield* Runner.makeDetached(assistant);
    const log = yield* EventLog.EventLog;

    // A run's log as SSE, after `after`. A crashed run's log never ends, so the
    // stream ends once nothing has arrived for a while; the client reconnects
    // once and then reports an error. A store failure is the server's fault
    // (500), and aborts a stream already going; an unissued cursor is a 400.
    const follow = (threadId: string, runId: string, after: string | undefined) =>
      log.subscribe(threadId, runId, after).pipe(
        Effect.catchTag("EventLogError", Effect.die),
        Effect.map((events) =>
          HttpApiSchema.withHeaders({
            body: events.pipe(
              Stream.timeout(IDLE_TIMEOUT),
              Stream.map(({ cursor, event }) => ({ id: cursor, event: "message", data: event })),
              Stream.orDie,
            ),
            headers: { "cache-control": "no-cache" as const },
          }),
        ),
      );

    return handlers
      .handle("read", ({ query: { threadId, runId, offset }, headers }) => {
        if (runId !== undefined) {
          return follow(threadId, runId, headers["last-event-id"] ?? (offset === "-1" ? undefined : offset));
        }
        return History.restore(threadId, { rejoin: true }).pipe(
          Effect.orDie,
          Effect.map(({ messages, interrupts, activeRun }) => ({
            messages: toUIMessagesWithSubagents(messages, interrupts),
            interrupts: interrupts === undefined ? null : interrupts,
            activeRun: activeRun === undefined ? null : activeRun,
          })),
        );
      })
      .handle("send", ({ payload, headers }) => {
        const lastEventId = headers["last-event-id"];
        return Effect.andThen(lastEventId === undefined ? detached.start(payload) : Effect.void, () =>
          follow(payload.threadId, payload.runId, lastEventId),
        );
      })
      .handle("cancel", ({ payload }) => detached.cancel(payload));
  }),
);

// The run streams read their services from each request's context, so they must be in the layer's output
// (`Layer.provideMerge`), which the web handler provides to every request. `Layer.provide` would hide them.
const ChatRoutes = HttpApiBuilder.layer(ChatApi).pipe(
  Layer.provide(ChatHandlers),
  Layer.provideMerge(Layer.mergeAll(ModelLayer, ToolsLayer, StoresLayer)),
  Layer.provide(HttpServer.layerServices),
);

/** The chat endpoints as a web handler (`Request => Promise<Response>`), mounted by `src/routes/api/chat.ts`. */
export const { handler } = HttpRouter.toWebHandler(ChatRoutes, { disableLogger: true });
