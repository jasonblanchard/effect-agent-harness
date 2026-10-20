import { HttpAgent, randomUUID } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Agent from "../src/Agent.ts";
import * as AgUi from "../src/AgUi.ts";
import * as Sse from "../src/Sse.ts";
import {
  counterIds,
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

const services = (steps: ReadonlyArray<Step>) => {
  const model = scriptedModel(steps);
  return { layer: Layer.mergeAll(model.layer, WeatherToolkitLayer, counterIds()), prompts: model.prompts };
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
      const runAgent = yield* Agent.make({ toolkit: WeatherToolkit }).pipe(Effect.provide(layer));
      const frames = yield* Stream.runCollect(Sse.encode(runAgent(input)));
      expect(parseSse(frames.join(""))).toEqual([
        { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "id-1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "Hel" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "id-1", delta: "lo" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "id-1" },
        { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" },
      ]);
    }),
  );
});

describe("Agent.make", () => {
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
      const runAgent = yield* Agent.make({ toolkit: WeatherToolkit }).pipe(Effect.provide(layer));
      const events = yield* Stream.runCollect(runAgent(input).pipe(Stream.take(3)));
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
      ]);
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

const makeHandler = (steps: ReadonlyArray<Step>) => {
  const { layer, prompts } = services(steps);
  const AgentRoute = HttpRouter.use((router) =>
    Effect.gen(function* () {
      const runAgent = yield* Agent.make({ toolkit: WeatherToolkit, system: "Be helpful." });
      yield* router.add(
        "POST",
        "/agent",
        HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
          Effect.map((input) =>
            HttpServerResponse.stream(Sse.encode(runAgent(input)).pipe(Stream.encodeText), {
              contentType: Sse.contentType,
            }),
          ),
          Effect.orElseSucceed(() => HttpServerResponse.text("Invalid RunAgentInput", { status: 400 })),
        ),
      );
    }),
  ).pipe(Layer.provide(layer));
  const { handler, dispose } = HttpRouter.toWebHandler(AgentRoute, { disableLogger: true });
  disposers.push(dispose);
  return { handler, prompts };
};

describe("HttpAgent against a caller-owned SSE route", () => {
  it("runs a multi-turn conversation with tool calls", async () => {
    const { handler, prompts } = makeHandler([
      [
        ...text("0", "Let me check."),
        ...toolCall("toolu_1", "get-weather", { location: "Paris" }),
        finish("tool-calls"),
      ],
      [...text("0", "It is 18°C in Paris."), finish("stop")],
      [...text("0", "Still 18°C."), finish("stop")],
    ]);
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

    // Second turn: the client resends history, and the server rebuilds it.
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
