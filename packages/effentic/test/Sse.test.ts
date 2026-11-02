import { HttpAgent, randomUUID } from "@ag-ui/client";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { expectTypeOf } from "vitest";
import * as EffectSse from "effect/encoding/Sse";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Tool } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as AgUi from "../src/AgUi.ts";
import * as Runner from "../src/Runner.ts";
import * as Sse from "../src/Sse.ts";
import * as Thread from "../src/Thread.ts";
import {
  ApprovalToolkit,
  countingApprovalLayer,
  evalLayers,
  finish,
  scriptedModel,
  type Step,
  text,
  toolCall,
  WeatherToolkit,
  WeatherToolkitLayer,
} from "./fixtures.ts";

const input: AgUi.RunAgentInput = {
  threadId: "t1",
  runId: "r1",
  messages: [{ id: "u1", role: "user", content: "hi" }],
};

const weatherAgent = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });

const services = (steps: ReadonlyArray<Step>) => {
  const model = scriptedModel(steps);
  return {
    layer: Layer.mergeAll(model.layer, WeatherToolkitLayer, evalLayers, Thread.layerMemory),
    prompts: model.prompts,
  };
};

const parseSse = (body: string) =>
  body
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return JSON.parse(frame.slice("data: ".length));
    });

describe("Sse.encode", () => {
  it.effect("encodes each event as one SSE data frame, in order", () =>
    Effect.gen(function* () {
      const { layer } = services([[...text("0", "Hel", "lo"), finish("stop")]]);
      const frames = yield* Stream.runCollect(Sse.encode(Runner.run(weatherAgent)(input))).pipe(Effect.provide(layer));
      expect(parseSse(frames.join(""))).toEqual([
        { type: "RUN_STARTED", threadId: "t1", runId: "r1", protocolVersion: "1.0" },
        { type: "STEP_STARTED", stepName: "step-1" },
        { type: "TEXT_MESSAGE_START", messageId: "id-1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "id-1", delta: "Hel" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "id-1", delta: "lo" },
        { type: "TEXT_MESSAGE_END", messageId: "id-1" },
        { type: "STEP_FINISHED", stepName: "step-1" },
        { type: "RUN_FINISHED", threadId: "t1", runId: "r1", outcome: { type: "success" } },
      ]);
    }),
  );
});

describe("Sse.encodeStored", () => {
  it.effect("carries each cursor as the SSE id", () =>
    Effect.gen(function* () {
      const events = [AgUi.runStarted(input), AgUi.stepStarted("step-1"), AgUi.runFinished(input)];
      const frames = yield* Stream.runCollect(
        Sse.encodeStored(Stream.fromIterable(events.map((event, i) => ({ cursor: String(i), event })))),
      );
      frames.forEach((frame, i) => expect(frame).toContain(`id: ${i}\n`));

      const parsed: Array<EffectSse.AnyEvent> = [];
      const parser = EffectSse.makeParser((event) => parsed.push(event));
      parser.feed(frames.join(""));
      expect(parsed.map((event) => (event._tag === "Event" ? [event.id, JSON.parse(event.data)] : event))).toEqual(
        events.map((event, i) => [String(i), event]),
      );
    }),
  );
});

describe("Sse.response", () => {
  const frames = Sse.encode(Stream.fromIterable<AgUi.Event>([{ type: "RUN_STARTED", threadId: "t1", runId: "r1" }]));

  it.effect("streams SSE without caching by default", () =>
    Effect.gen(function* () {
      const response = HttpServerResponse.toWeb(yield* Sse.response(frames));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }),
  );

  it.effect("merges the caller's status and headers over the defaults", () =>
    Effect.gen(function* () {
      const extra = HttpServerResponse.toWeb(yield* Sse.response(frames, { headers: { "x-run": "r1" } }));
      expect(extra.headers.get("x-run")).toBe("r1");
      expect(extra.headers.get("content-type")).toBe("text/event-stream");
      expect(extra.headers.get("cache-control")).toBe("no-cache");
      const overridden = HttpServerResponse.toWeb(
        yield* Sse.response(frames, { status: 201, headers: { "cache-control": "no-store" } }),
      );
      expect(overridden.status).toBe(201);
      expect(overridden.headers.get("cache-control")).toBe("no-store");
    }),
  );

  it.effect("gives the body the services of the context it was built in", () =>
    Effect.gen(function* () {
      const { layer } = services([[...text("0", "Hello"), finish("stop")]]);
      const runAgent = Runner.run(weatherAgent);
      const built = Sse.response(Sse.encode(runAgent(input)));
      // The effect requires what the run needs; the response it builds requires nothing.
      expectTypeOf<Effect.Services<typeof built>>().toEqualTypeOf<Stream.Services<ReturnType<typeof runAgent>>>();
      expectTypeOf<Effect.Services<ReturnType<typeof Sse.response<never>>>>().toEqualTypeOf<never>();
      // Read after the effect that built it has returned, outside the layer.
      const response = yield* built.pipe(Effect.provide(layer));
      const body = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
      expect(parseSse(body).map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
    }),
  );
});

describe("Runner.run", () => {
  it.effect("returns a stream the route closes over and consumes after its handler has returned", () =>
    Effect.gen(function* () {
      const { layer } = services([[...text("0", "Hel", "lo"), finish("stop")]]);
      // Made outside any Effect: nothing is captured until a request runs it.
      const runAgent = Runner.run(weatherAgent);
      // As a request handler does: it provides its own context to the stream and returns it.
      const handler = Effect.gen(function* () {
        const stream = runAgent(input);
        return stream.pipe(Stream.provideContext(yield* Effect.context<Stream.Services<typeof stream>>()));
      });
      const stream = yield* handler.pipe(Effect.provide(layer));
      expectTypeOf(stream).toEqualTypeOf<Stream.Stream<AgUi.Event, never, never>>();
      const events = yield* Stream.runCollect(stream);
      expect(events.map((e) => e.type)).toEqual([
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED",
      ]);
    }),
  );

  it.effect("stops the run when the consumer stops reading", () =>
    Effect.gen(function* () {
      // The model stream never ends on its own, so its finalizer only runs if the
      // run is interrupted.
      let interrupted = false;
      const { layer } = services([
        Stream.fromIterable(text("0", "first").slice(0, 2)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Effect.sync(() => (interrupted = true))),
        ),
      ]);
      const events = yield* Stream.runCollect(Runner.run(weatherAgent)(input).pipe(Stream.take(3))).pipe(
        Effect.provide(layer),
      );
      expect(events.map((e) => e.type)).toEqual(["RUN_STARTED", "STEP_STARTED", "TEXT_MESSAGE_START"]);
      expect(interrupted).toBe(true);
    }),
  );
});

// -----------------------------------------------------------------------------
// A caller-owned HTTP edge, as an application would write it.
// -----------------------------------------------------------------------------

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

/** The agent's route. The handler requires what the run's stream needs; the router's layer provides it. */
const agentRoute = <Tools extends Record<string, Tool.Any>>(agent: Agent.Agent<Tools>) => {
  const runAgent = Runner.run(agent);
  return HttpRouter.use((router) =>
    router.add(
      "POST",
      "/agent",
      HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
        Effect.flatMap((input) => Sse.response(Sse.encode(runAgent(input)))),
        Effect.orElseSucceed(() => HttpServerResponse.text("Invalid RunAgentInput", { status: 400 })),
      ),
    ),
  );
};

/** Keeps a web handler's `dispose` for `afterEach`. */
const track = <Handler>(app: { readonly handler: Handler; readonly dispose: () => Promise<void> }): Handler => {
  disposers.push(app.dispose);
  return app.handler;
};

describe("HttpAgent against a caller-owned SSE route", () => {
  it("runs a multi-turn conversation with tool calls", async () => {
    const { layer, prompts } = services([
      [
        ...text("0", "Let me check."),
        ...toolCall("toolu_1", "get-weather", { location: "Paris" }),
        finish("tool-calls"),
      ],
      [...text("0", "It is 18°C in Paris."), finish("stop")],
      [...text("0", "Still 18°C."), finish("stop")],
    ]);
    const handler = track(
      HttpRouter.toWebHandler(agentRoute(weatherAgent).pipe(Layer.provideMerge(layer)), { disableLogger: true }),
    );
    const agent = new HttpAgent({
      url: "http://localhost/agent",
      threadId: "main-conversation",
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

    expect(prompts).toHaveLength(3);
    expect(prompts[2]!.content.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(prompts[2]!.content[2]).toMatchObject({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool-call", id: "toolu_1", name: "get-weather", params: { location: "Paris" } },
      ],
    });
  });
});

describe("HttpAgent tool approval", () => {
  it("answers an interrupt with resume and runs the approved tool", async () => {
    const model = scriptedModel([
      [...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }), finish("tool-calls")],
      [...text("0", "Sent."), finish("stop")],
    ]);
    const handlers = countingApprovalLayer();
    const handler = track(
      HttpRouter.toWebHandler(
        agentRoute(Agent.define({ toolkit: ApprovalToolkit })).pipe(
          Layer.provideMerge(Layer.mergeAll(model.layer, handlers.layer, evalLayers, Thread.layerMemory)),
        ),
        { disableLogger: true },
      ),
    );
    const agent = new HttpAgent({
      url: "http://localhost/agent",
      threadId: "approvals",
      fetch: (url, init) => handler(new Request(url, init)),
    });

    agent.messages.push({ id: randomUUID(), role: "user", content: "Email Ada" });
    await agent.runAgent();
    expect(handlers.emails).toEqual([]);
    expect(agent.pendingInterrupts).toHaveLength(1);
    const [interrupt] = agent.pendingInterrupts;
    expect(interrupt).toMatchObject({ reason: "tool-approval", toolCallId: "c_email" });

    await agent.runAgent({ resume: [{ interruptId: interrupt!.id, status: "resolved", payload: { approved: true } }] });
    expect(handlers.emails).toEqual(["ada@example.com"]);
    expect(agent.pendingInterrupts).toEqual([]);
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(model.prompts[1]!.content.at(-1)).toMatchObject({ role: "tool" });
  });
});
