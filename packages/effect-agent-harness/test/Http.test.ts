// The library has no HTTP code of its own: applications serve runs through Effect's AG-UI endpoint and SSE
// streaming. These tests build that edge as an application would, and check what a client sees through it.
import { HttpAgent, randomUUID } from "@ag-ui/client";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { AgUiSchema, AgUiServer, Tool, Toolkit } from "effect/ai";
import { Sse } from "effect/encoding";
import { HttpRouter, HttpServer } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";
import * as Agent from "../src/Agent.ts";
import * as RunLog from "../src/RunLog.ts";
import * as Runner from "../src/Runner.ts";
import * as Thread from "../src/Thread.ts";
import {
  ApprovalToolkit,
  countingApprovalLayer,
  evalLayers,
  finish,
  runAgUi,
  scriptedModel,
  serverHistory,
  serverStores,
  type Step,
  text,
  toolCall,
  WeatherToolkit,
  WeatherToolkitLayer,
} from "./fixtures.ts";

// -----------------------------------------------------------------------------
// The edge, as an application writes it
// -----------------------------------------------------------------------------

/** The verified caller, which the authentication middleware provides to every handler. */
class Principal extends Context.Service<Principal, { readonly userId: string }>()("test/Principal") {}

const TOKEN = "t0k";

class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

class Authentication extends HttpApiMiddleware.Service<Authentication, { provides: Principal; requires: never }>()(
  "test/Authentication",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}

const AuthenticationLayer = Layer.succeed(
  Authentication,
  Authentication.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === TOKEN
        ? Effect.provideService(httpEffect, Principal, { userId: "u1" })
        : Effect.fail(new Unauthorized()),
  }),
);

/** An event from the log as an SSE frame, its cursor as the frame's `id`. */
const StoredEvent = Schema.Struct({
  id: Schema.String,
  event: Schema.String,
  data: Schema.fromJsonString(Schema.toCodecJson(AgUiSchema.Event)),
});

const RunIds = { threadId: Schema.String, runId: Schema.String };

class TestApi extends HttpApi.make("test").add(
  HttpApiGroup.make("agent")
    .add(AgUiServer.endpoint("run", "/agent"))
    .add(
      HttpApiEndpoint.post("start", "/runs", { payload: AgUiSchema.RunAgentInput, success: HttpApiSchema.Empty(202) }),
    )
    .add(
      HttpApiEndpoint.get("events", "/threads/:threadId/runs/:runId/events", {
        params: RunIds,
        headers: { "last-event-id": Schema.optional(Schema.String) },
        success: HttpApiSchema.StreamSse({ events: StoredEvent }),
        error: RunLog.InvalidCursor.pipe(HttpApiSchema.status(400)),
      }),
    )
    .middleware(Authentication),
) {}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

/**
 * Serves `agent` through the test API, with `services` (model, tool handlers, stores) in the layer's output so each
 * request's run stream can read them. Attached runs go through `AgUiServer.handler`; detached runs take the principal
 * as a dependency and are followed through the event log.
 */
/**
 * Serves `agent` through the test API as a web handler, with `services` (model, tool handlers, stores) in the
 * layer's output so each request's run stream can read them. Attached runs go through `AgUiServer.handler`; detached
 * runs take the principal as a dependency and are followed through the event log.
 *
 * The tests serve agents with different toolkits through this one helper, so it takes any agent and any services.
 * A generic version can't type the web handler: its request requirements stay unresolved inside the helper, and
 * every call site then needs a context argument. What the tests check is the runtime behaviour.
 */
const serve = (agent: Agent.Any, services: Layer.Layer<any>) => {
  const handlers = HttpApiBuilder.group(
    TestApi,
    "agent",
    Effect.fn(function* (handlers) {
      const runAgent = Runner.makeAttached(agent);
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- `Agent.Any`, see `serve`.
      const detached = yield* Runner.makeDetached(agent, { dependencies: [Principal] });
      const log = yield* RunLog.RunLog;
      return handlers
        .handle(
          "run",
          AgUiServer.handler((input) => runAgent(input)),
        )
        .handle("start", ({ payload }) => detached.start(payload))
        .handle("events", ({ params, headers }) =>
          log.subscribe(params.threadId, params.runId, headers["last-event-id"]).pipe(
            Effect.catchTag("RunLogError", Effect.die),
            Effect.map((events) =>
              events.pipe(
                Stream.map(({ cursor, event }) => ({ id: cursor, event: "message", data: event })),
                Stream.orDie,
              ),
            ),
          ),
        );
    }),
  );
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- `Agent.Any`, see `serve`.
    Layer.provide(handlers),
    Layer.provide(AuthenticationLayer),
    Layer.provideMerge(Layer.mergeAll(services, RunLog.layerMemory)),
    Layer.provide(HttpServer.layerServices),
  );
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(app.dispose);
  return (request: Request) => app.handler(request);
};

const authorized = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, init?: RequestInit) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(body),
      ...init,
    }),
  );

/** The events of an SSE body, keepalive comments and all other non-event lines skipped. */
const parseEvents = (body: string) => {
  const events: Array<Sse.Event> = [];
  Sse.makeParser((event) => {
    if (event._tag === "Event") {
      events.push(event);
    }
  }).feed(body);
  return events;
};

const input = (runId: string, messages: ReadonlyArray<AgUiSchema.Message>): AgUiSchema.RunAgentInput => ({
  threadId: "t1",
  runId,
  messages,
  tools: [],
  context: [],
});

const weatherAgent = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });

// -----------------------------------------------------------------------------
// HttpAgent through the endpoint
// -----------------------------------------------------------------------------

describe("HttpAgent through the AG-UI endpoint", () => {
  it("runs a multi-turn conversation with tool calls", async () => {
    const model = scriptedModel([
      [
        ...text("0", "Let me check."),
        ...toolCall("toolu_1", "get-weather", { location: "Paris" }),
        finish("tool-calls"),
      ],
      [...text("0", "It is 18°C in Paris."), finish("stop")],
      [...text("0", "Still 18°C."), finish("stop")],
    ]);
    const handler = serve(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers, serverStores));
    const agent = new HttpAgent({
      url: "http://localhost/agent",
      threadId: "main-conversation",
      headers: { authorization: `Bearer ${TOKEN}` },
      fetch: (url, init) => handler(new Request(url, init)),
    });

    const seen: Array<string> = [];
    const subscriber = {
      onTextMessageContentEvent: ({ event }: { event: { delta: string } }) => {
        seen.push(`text:${event.delta}`);
      },
      onToolCallStartEvent: ({ event }: { event: { toolCallName: string } }) => {
        seen.push(`tool:${event.toolCallName}`);
      },
      onToolCallArgsEvent: ({ event }: { event: { delta: string } }) => {
        seen.push(`args:${event.delta}`);
      },
      onToolCallEndEvent: () => {
        seen.push("tool-end");
      },
      onToolCallResultEvent: ({ event }: { event: { content: unknown } }) => {
        seen.push(`result:${String(event.content)}`);
      },
    };

    agent.messages.push({ id: randomUUID(), role: "user", content: "Weather in Paris?" });
    await agent.runAgent({}, subscriber);

    expect(seen).toEqual([
      "text:Let me check.",
      "tool:get-weather",
      'args:{"location":"Paris"}',
      "tool-end",
      'result:{"temperature":18}',
      "text:It is 18°C in Paris.",
    ]);
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    // Second turn: the client resends its history; the server takes only the new message and uses its own.
    agent.messages.push({ id: randomUUID(), role: "user", content: "And now?" });
    await agent.runAgent({}, subscriber);

    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[2]!.content.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  it("answers an interrupt with resume and runs the approved tool", async () => {
    const model = scriptedModel([
      [...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }), finish("tool-calls")],
      [...text("0", "Sent."), finish("stop")],
    ]);
    const tools = countingApprovalLayer();
    const handler = serve(
      Agent.define({ toolkit: ApprovalToolkit }),
      Layer.mergeAll(model.layer, tools.layer, evalLayers, serverStores),
    );
    const agent = new HttpAgent({
      url: "http://localhost/agent",
      threadId: "approvals",
      headers: { authorization: `Bearer ${TOKEN}` },
      fetch: (url, init) => handler(new Request(url, init)),
    });

    agent.messages.push({ id: randomUUID(), role: "user", content: "Email Ada" });
    await agent.runAgent();
    expect(tools.emails).toEqual([]);
    expect(agent.pendingInterrupts).toHaveLength(1);
    const [interrupt] = agent.pendingInterrupts;
    expect(interrupt).toMatchObject({ reason: "tool-approval", toolCallId: "c_email" });

    await agent.runAgent({ resume: [{ interruptId: interrupt!.id, status: "resolved", payload: { approved: true } }] });
    expect(tools.emails).toEqual(["ada@example.com"]);
    expect(agent.pendingInterrupts).toEqual([]);
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

// -----------------------------------------------------------------------------
// In place of effect/ai's own agent
// -----------------------------------------------------------------------------

/**
 * Serves `agent` as `effect/ai`'s own agent is served: `AgUiServer.layerHttp` with the adapted agent, its services
 * provided when the route is built. No history is provided, so the runs use the client history.
 */
const serveAsAgent = (agent: Agent.Any, services: Layer.Layer<any>) => {
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- `Agent.Any`, see `serve`.
  const routes = AgUiServer.layerHttp({ path: "/agent", agent: Runner.toAgUiServerAgent(agent) }).pipe(
    Layer.provide(services),
    Layer.provide(HttpServer.layerServices),
  );
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(app.dispose);
  return (request: Request) => app.handler(request);
};

describe("Runner.toAgUiServerAgent through AgUiServer.layerHttp", () => {
  const clientOf = (handler: (request: Request) => Promise<Response>, threadId: string) =>
    new HttpAgent({
      url: "http://localhost/agent",
      threadId,
      fetch: (url, init) => handler(new Request(url, init)),
    });

  it("runs a conversation with a tool call, as effect/ai's agent would serve it", async () => {
    const model = scriptedModel([
      [...toolCall("toolu_1", "get-weather", { location: "Paris" }), finish("tool-calls", { input: 3 })],
      [...text("0", "It is 18°C."), finish("stop", { input: 4 })],
    ]);
    const handler = serveAsAgent(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers));
    const agent = clientOf(handler, "swap");
    agent.messages.push({ id: randomUUID(), role: "user", content: "Weather in Paris?" });
    const finished: Array<unknown> = [];
    await agent.runAgent({}, { onRunFinishedEvent: ({ event }) => void finished.push(event) });
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(agent.messages[2]).toMatchObject({ role: "tool", content: '{"temperature":18}' });
    expect(finished).toEqual([expect.objectContaining({ usage: [{ inputTokens: 7, totalTokens: 7 }] })]);
  });

  it("rejects a frontend tool named like one of the agent's with 400, before the stream and the model", async () => {
    const model = scriptedModel([[...text("0", "Hi"), finish("stop")]]);
    const handler = serveAsAgent(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers));
    const response = await post(handler, "/agent", {
      ...input("r1", [{ id: "u1", role: "user", content: "Hi" }]),
      tools: [{ name: "get-weather", description: "The client's", parameters: { type: "object" } }],
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(model.prompts).toEqual([]);
  });

  it("keeps a failed result failed when the client sends its history back", async () => {
    const model = scriptedModel([
      [...toolCall("toolu_1", "get-weather", { location: "Nowhere" }), finish("tool-calls")],
      [...text("0", "I couldn't find it."), finish("stop")],
      [...text("0", "Sorry again."), finish("stop")],
    ]);
    const handler = serveAsAgent(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers));
    const agent = clientOf(handler, "failures");
    agent.messages.push({ id: randomUUID(), role: "user", content: "Weather in Nowhere?" });
    await agent.runAgent();
    // The client keeps the marker the result carried on the tool message it built.
    expect(agent.messages[2]).toMatchObject({ role: "tool", metadata: { "effect/ai": { isFailure: true } } });

    agent.messages.push({ id: randomUUID(), role: "user", content: "Try again?" });
    await agent.runAgent();
    const resent = model.prompts[2]!.content.find((message) => message.role === "tool");
    expect(resent).toMatchObject({ content: [{ type: "tool-result", id: "toolu_1", isFailure: true }] });
  });
});

// -----------------------------------------------------------------------------
// What the wire carries
// -----------------------------------------------------------------------------

describe("the AG-UI endpoint", () => {
  const steps = { approval: [[...toolCall("e1", "send-email", { to: "a@b.c", body: "hi" }), finish("tool-calls")]] };
  const failure = [[...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")]];
  const runInput = input("r1", [{ id: "u1", role: "user", content: "Go" }]);
  const toolLayers = () => Layer.mergeAll(countingApprovalLayer().layer, evalLayers);

  /** The run's events read straight from the runner, for comparison with what the endpoint sends. */
  const direct = (agent: Agent.Any, model: ReadonlyArray<Step>) =>
    Effect.runPromise(
      runAgUi(agent as typeof weatherAgent, [runInput]).pipe(
        Effect.provide(Layer.mergeAll(scriptedModel(model).layer, toolLayers())),
        Effect.map(([events]) => events!),
      ),
    );

  /** The run's events as the endpoint sends them, checking the response's SSE headers. */
  const overWire = async (agent: Agent.Any, model: ReadonlyArray<Step>) => {
    const handler = serve(agent, Layer.mergeAll(scriptedModel(model).layer, toolLayers()));
    const response = await post(handler, "/agent", runInput);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    return parseEvents(await response.text()).map((frame) => JSON.parse(frame.data) as AgUiSchema.Event);
  };

  it("sends exactly the run's own lifecycle and terminal event, for an interrupt", async () => {
    const approvals = Agent.define({ toolkit: ApprovalToolkit });
    const wire = await overWire(approvals, steps.approval);
    expect(wire).toEqual(await direct(approvals, steps.approval));
    expect(wire.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
    expect(wire[0]!.type).toBe("RUN_STARTED");
    expect(wire.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } });
  });

  it("sends exactly the run's own lifecycle and terminal event, for a failure", async () => {
    const limited = Agent.define({ toolkit: ApprovalToolkit, maxSteps: 1 });
    const wire = await overWire(limited, failure);
    expect(wire).toEqual(await direct(limited, failure));
    expect(wire.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1);
    expect(wire.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "StepLimitExceeded" });
  });

  it("rejects input the AG-UI schema rejects with 400, before the stream and the model", async () => {
    const model = scriptedModel([[...text("0", "hi"), finish("stop")]]);
    const handler = serve(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers));
    const response = await post(handler, "/agent", {
      ...input("r1", [{ id: "u1", role: "user", content: "hi" }]),
      tools: [{ name: "pick-file", parameters: {} }],
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(model.prompts).toHaveLength(0);
  });

  it("rejects a request without the token with 401", async () => {
    const model = scriptedModel([[...text("0", "hi"), finish("stop")]]);
    const handler = serve(weatherAgent, Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers));
    const response = await post(handler, "/agent", input("r1", [{ id: "u1", role: "user", content: "hi" }]), {
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(401);
    expect(model.prompts).toHaveLength(0);
  });

  it("cancels the run when the client disconnects, and releases the thread", async () => {
    let interrupted = false;
    const model = scriptedModel([
      Stream.fromIterable(text("0", "first").slice(0, 2)).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Effect.sync(() => (interrupted = true))),
      ),
    ]);
    const thread = await Effect.runPromise(Effect.scoped(Layer.build(Thread.layerMemory)));
    const store = Layer.succeedContext(thread);
    const handler = serve(
      weatherAgent,
      Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers, serverHistory(store)),
    );

    const abort = new AbortController();
    const response = await post(handler, "/agent", input("r1", [{ id: "u1", role: "user", content: "hi" }]), {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("TEXT_MESSAGE_CONTENT")) {
      const chunk = await reader.read();
      received += decoder.decode(chunk.value);
    }
    abort.abort();
    await reader.cancel();

    await expect.poll(() => interrupted).toBe(true);
    const activeRun = () =>
      Effect.runPromise(Effect.flatMap(Thread.Thread, (t) => t.activeRun("t1")).pipe(Effect.provide(store)));
    await expect.poll(activeRun).toBeUndefined();
    const runEnded = await Effect.runPromise(
      Effect.flatMap(Thread.Thread, (t) => t.load("t1")).pipe(Effect.provide(store)),
    );
    // The partial step was committed: the run ended cancelled instead of being dropped.
    expect(runEnded.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
  });
});

// -----------------------------------------------------------------------------
// Services from the middleware, and replay
// -----------------------------------------------------------------------------

const WhoAmI = Tool.make("who-am-i", {
  description: "Names the caller",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ userId: Schema.String }),
  dependencies: [Principal],
});
const WhoAmIToolkit = Toolkit.make(WhoAmI);
const WhoAmILayer = WhoAmIToolkit.toLayer({
  "who-am-i": () =>
    Effect.gen(function* () {
      const principal = yield* Principal;
      return { userId: principal.userId };
    }),
});
const whoAmIAgent = Agent.define({ toolkit: WhoAmIToolkit });
const whoAmISteps = () => [
  [...toolCall("c1", "who-am-i", {}), finish("tool-calls")],
  [...text("0", "You are u1."), finish("stop")],
];

const resultOf = (events: ReadonlyArray<AgUiSchema.Event>) =>
  events.flatMap((event) => (event.type === "TOOL_CALL_RESULT" ? [event.content] : []));

describe("services the middleware provides", () => {
  it("reach the tool handlers of an attached run", async () => {
    const handler = serve(whoAmIAgent, Layer.mergeAll(scriptedModel(whoAmISteps()).layer, WhoAmILayer, evalLayers));
    const response = await post(handler, "/agent", input("r1", [{ id: "u1", role: "user", content: "Who am I?" }]));
    const events = parseEvents(await response.text()).map((frame) => JSON.parse(frame.data) as AgUiSchema.Event);
    expect(resultOf(events)).toEqual(['{"userId":"u1"}']);
  });

  it("reach the tool handlers of a detached run, whose log replays with cursors as SSE ids", async () => {
    const handler = serve(whoAmIAgent, Layer.mergeAll(scriptedModel(whoAmISteps()).layer, WhoAmILayer, evalLayers));
    const started = await post(handler, "/runs", input("r1", [{ id: "u1", role: "user", content: "Who am I?" }]));
    expect(started.status).toBe(202);

    const events = await handler(new Request("http://localhost/threads/t1/runs/r1/events", { headers: authorized }));
    expect(events.status).toBe(200);
    const frames = parseEvents(await events.text());
    expect(frames.map((frame) => frame.id)).toEqual(frames.map((_, i) => String(i)));
    const decoded = frames.map((frame) => JSON.parse(frame.data) as AgUiSchema.Event);
    expect(decoded[0]!.type).toBe("RUN_STARTED");
    expect(decoded.at(-1)!.type).toBe("RUN_FINISHED");
    expect(resultOf(decoded)).toEqual(['{"userId":"u1"}']);

    // Resuming after cursor 2 sends every later event exactly once.
    const resumed = await handler(
      new Request("http://localhost/threads/t1/runs/r1/events", { headers: { ...authorized, "last-event-id": "2" } }),
    );
    expect(parseEvents(await resumed.text()).map((frame) => frame.id)).toEqual(
      frames.slice(3).map((frame) => frame.id),
    );

    // A cursor the log never issued is a 400, before any event.
    const invalid = await handler(
      new Request("http://localhost/threads/t1/runs/r1/events", { headers: { ...authorized, "last-event-id": "99" } }),
    );
    expect(invalid.status).toBe(400);
  });
});
