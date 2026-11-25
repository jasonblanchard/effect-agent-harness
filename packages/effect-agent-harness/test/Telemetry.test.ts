import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Logger, Schema, Scope, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Prompt, Response } from "effect/ai";
import type { AgUiSchema } from "effect/ai";
import type { Tracer } from "effect";
import * as Agent from "../src/Agent.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as EventLog from "../src/EventLog.ts";
import * as internal from "../src/internal/telemetry.ts";
import * as Runner from "../src/Runner.ts";
import * as Telemetry from "../src/Telemetry.ts";
import {
  ApprovalToolkit,
  counterIds,
  countingApprovalLayer,
  evalLayers,
  finish,
  PickFile,
  reasoning,
  recordingTracer,
  runAgUi,
  scriptedModel,
  type Step,
  text,
  toolCall,
  verify,
  WeatherToolkit,
  WeatherToolkitLayer,
  agentRun,
} from "./fixtures.ts";

const assistant = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful.", name: "assistant" });
const approvalAgent = Agent.define({ toolkit: ApprovalToolkit, name: "assistant" });

const userMessage = (id: string, content: string): AgUiSchema.Message => ({ id, role: "user", content });
const run1: AgUiSchema.RunAgentInput = {
  tools: [],
  context: [],
  threadId: "t1",
  runId: "r1",
  messages: [userMessage("u1", "Weather in Paris?")],
};

const weatherTurn: ReadonlyArray<Step> = [
  [...toolCall("call-1", "get-weather", { location: "Paris" }), finish("tool-calls")],
  [...text("0", "It is 18°C."), finish("stop")],
];

const MODEL_SPAN = "LanguageModel.streamText";
const REQUEST_SPAN = "POST";

const CONTENT_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
];

const attr = (span: Tracer.Span, key: string) => span.attributes.get(key);
const parsed = (span: Tracer.Span, key: string) => JSON.parse(attr(span, key) as string);

/** Collects the messages logged at error level into `errors`. */
const errorLogs = (errors: Array<unknown>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") {
        errors.push(message);
      }
    }),
  ]);

class LayerFailed extends Schema.TaggedError<LayerFailed, { readonly brand: unique symbol }>()("LayerFailed", {
  reason: Schema.String,
}) {}

/** The exception events an exporter adds for the exit `span` ended with, as `OtlpTracer` derives them. */
const exportedExceptions = (span: Tracer.Span) =>
  span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
    ? Cause.prettyErrors(span.status.exit.cause).map(({ name, message }) => ({ name, message }))
    : [];

/** Runs `inputs` through `Runner.makeAttached` against `steps`, recording every span. */
const traced = (
  steps: ReadonlyArray<Step>,
  inputs: ReadonlyArray<AgUiSchema.RunAgentInput>,
  options?: { readonly agent?: typeof assistant; readonly capture?: boolean },
) =>
  Effect.gen(function* () {
    const tracer = recordingTracer();
    const model = scriptedModel(steps, { requestSpan: REQUEST_SPAN });
    const runs = yield* runAgUi(options?.agent ?? assistant, inputs).pipe(
      Effect.provide([
        model.layer,
        WeatherToolkitLayer,
        tracer.layer,
        options?.capture === true ? Telemetry.layerCaptureContent : Layer.empty,
      ]),
    );
    return { tracer, runs };
  }).pipe(Effect.provide(evalLayers));

/** {@link traced} for {@link approvalAgent}, with the given handlers. */
const tracedApproval = (
  steps: ReadonlyArray<Step>,
  inputs: ReadonlyArray<AgUiSchema.RunAgentInput>,
  handlers: ReturnType<typeof countingApprovalLayer>,
) =>
  Effect.gen(function* () {
    const tracer = recordingTracer();
    const runs = yield* runAgUi(approvalAgent, inputs).pipe(
      Effect.provide([scriptedModel(steps).layer, handlers.layer, tracer.layer]),
    );
    return { tracer, runs };
  }).pipe(Effect.provide(evalLayers));

// -----------------------------------------------------------------------------
// Message conversion
// -----------------------------------------------------------------------------

describe("GenAI message conversion", () => {
  const prompt = Prompt.make([
    { role: "system", content: "Be helpful." },
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this picture?" },
        { type: "file", mediaType: "image/png", data: "aGVsbG8=" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "" },
        { type: "reasoning", text: "Look it up." },
        { type: "tool-call", id: "c1", name: "get-weather", params: { location: "Paris" }, providerExecuted: false },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", id: "c1", name: "get-weather", result: { temperature: 18 }, isFailure: false }],
    },
  ]);

  it("splits out the system prompt as text parts", () => {
    expect(internal.systemInstructions(prompt)).toEqual([{ type: "text", content: "Be helpful." }]);
  });

  it("converts the rest of the prompt, dropping empty reasoning and file data", () => {
    expect(internal.inputMessages(prompt)).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "What is in this picture?" },
          { type: "blob", mime_type: "image/png", modality: "image" },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "Look it up." },
          { type: "tool_call", id: "c1", name: "get-weather", arguments: { location: "Paris" } },
        ],
      },
      { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: { temperature: 18 } }] },
    ]);
  });

  it("keeps a system message after the opening ones in place, in the input messages", () => {
    const interleaved = Prompt.make([
      { role: "system", content: "Be helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi." },
      { role: "assistant", content: "Hello." },
      { role: "system", content: "It is now noon." },
      { role: "user", content: "What time is it?" },
    ]);
    expect(internal.systemInstructions(interleaved)).toEqual([
      { type: "text", content: "Be helpful." },
      { type: "text", content: "Be brief." },
    ]);
    expect(internal.inputMessages(interleaved)).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hi." }] },
      { role: "assistant", parts: [{ type: "text", content: "Hello." }] },
      { role: "system", parts: [{ type: "text", content: "It is now noon." }] },
      { role: "user", parts: [{ type: "text", content: "What time is it?" }] },
    ]);
  });

  it("maps a file's media type to the conventions' modalities", () => {
    expect(["image/png", "audio/wav", "video/mp4", "application/pdf", "text/plain"].map(internal.modality)).toEqual([
      "image",
      "audio",
      "video",
      "document",
      "document",
    ]);
  });

  it("leaves out approval parts and messages left empty", () => {
    const withApproval = Prompt.fromMessages([
      Prompt.makeMessage("assistant", {
        content: [Prompt.toolApprovalRequestPart({ approvalId: "a1", toolCallId: "c1" })],
      }),
    ]);
    expect(internal.inputMessages(withApproval)).toEqual([]);
  });

  it("converts a response, dropping empty reasoning", () => {
    const parts = [
      Response.makePart("reasoning", { text: "" }),
      Response.makePart("text", { text: "Hello." }),
    ] as ReadonlyArray<Response.AnyPart>;
    expect(internal.outputMessages(parts)).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "Hello." }] },
    ]);
  });
});

// -----------------------------------------------------------------------------
// Root span
// -----------------------------------------------------------------------------

describe("run root span", () => {
  it.effect("is one parentless invoke_agent span named for the agent, holding the run's ids", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1]);
      const roots = tracer.spans.filter((span) => span.parent._tag === "None");
      expect(roots.map((span) => span.name)).toEqual(["invoke_agent assistant"]);
      const root = roots[0]!;
      expect(attr(root, "gen_ai.operation.name")).toBe("invoke_agent");
      expect(attr(root, "gen_ai.agent.name")).toBe("assistant");
      expect(attr(root, "gen_ai.conversation.id")).toBe("t1");
      expect(attr(root, "effect_agent_harness.run.id")).toBe("r1");
      expect(root.status._tag).toBe("Ended");
      expect(tracer.named("effect-agent-harness/Runner.run")).toEqual([]);
    }),
  );

  it.effect("is named invoke_agent without gen_ai.agent.name for an unnamed agent", () =>
    Effect.gen(function* () {
      const unnamed = Agent.define({ toolkit: WeatherToolkit });
      const { tracer } = yield* traced(weatherTurn, [run1], { agent: unnamed });
      const root = tracer.one("invoke_agent");
      expect(root.attributes.has("gen_ai.agent.name")).toBe(false);
      expect(root.attributes.has("gen_ai.agent.description")).toBe(false);
    }),
  );

  it.effect("carries the agent's description", () =>
    Effect.gen(function* () {
      const described = Agent.define({ toolkit: WeatherToolkit, name: "assistant", description: "Answers questions" });
      const { tracer } = yield* traced(weatherTurn, [run1], { agent: described });
      expect(attr(tracer.one("invoke_agent assistant"), "gen_ai.agent.description")).toBe("Answers questions");
    }),
  );

  it.effect("starts a new trace linked to the caller's span", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      yield* Stream.runDrain(Runner.makeAttached(assistant)(run1)).pipe(
        Effect.withSpan("http POST /agent"),
        Effect.provide([scriptedModel(weatherTurn).layer, WeatherToolkitLayer, tracer.layer, evalLayers]),
      );
      const http = tracer.one("http POST /agent");
      const root = tracer.one("invoke_agent assistant");
      expect(root.parent._tag).toBe("None");
      expect(root.traceId).not.toBe(http.traceId);
      expect(root.links.map((link) => link.span.spanId)).toEqual([http.spanId]);
    }),
  );

  it.effect("ends with error status and error.type when the run fails, while the stream still ends in RUN_ERROR", () =>
    Effect.gen(function* () {
      const { tracer, runs } = yield* traced(
        [[...text("0", "It").slice(0, 2), { type: "error", error: { message: "overloaded" } }]],
        [run1],
      );
      expect(runs[0]!.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ModelStreamError" });
      const root = tracer.one("invoke_agent assistant");
      expect(attr(root, "error.type")).toBe("ModelStreamError");
      expect(root.status._tag === "Ended" && Exit.isFailure(root.status.exit)).toBe(true);
    }),
  );

  it.effect("ends with the run's original error, which an exporter records as its one exception event", () =>
    Effect.gen(function* () {
      const errors: Array<unknown> = [];
      const { tracer } = yield* traced(
        [[...text("0", "It").slice(0, 2), { type: "error", error: { message: "overloaded" } }]],
        [run1],
      ).pipe(Effect.provide(errorLogs(errors)));
      expect(errors).toHaveLength(1);
      const root = tracer.one("invoke_agent assistant");
      // The span records no exception itself: an exporter (`OtlpTracer`) adds one per error in the exit's cause.
      expect(root.events.filter(([name]) => name === "exception")).toEqual([]);
      expect(exportedExceptions(root)).toEqual([{ name: "ModelStreamError", message: "overloaded" }]);
    }),
  );

  it.effect("ends with the runner's own failure when the run fails before the agent starts", () =>
    Effect.gen(function* () {
      // The per-run layer fails, so the run fails in the runner, before the agent runs.
      const tracer = recordingTracer();
      const runs = yield* runAgUi(assistant, [run1], {
        // `runAgUi` takes untyped runner options; the layer's error is what the run reports.
        layer: Layer.effect(
          Telemetry.SpanAttributes,
          Effect.fail(new LayerFailed({ reason: "no tenant" })),
        ) as unknown as Layer.Layer<never>,
      }).pipe(Effect.provide([scriptedModel([]).layer, WeatherToolkitLayer, tracer.layer, evalLayers]));
      expect(runs[0]!.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "LayerFailed" });
      const root = tracer.one("invoke_agent assistant");
      expect(attr(root, "error.type")).toBe("LayerFailed");
      expect(root.events.filter(([name]) => name === "exception")).toEqual([]);
      expect(exportedExceptions(root)).toHaveLength(1);
    }),
  );

  it.effect("records no exception event for a run that finishes", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced([[...text("0", "Hi"), finish("stop")]], [run1]);
      const root = tracer.one("invoke_agent assistant");
      expect(root.events.filter(([name]) => name === "exception")).toEqual([]);
      expect(root.status._tag === "Ended" && Exit.isSuccess(root.status.exit)).toBe(true);
    }),
  );

  it.effect("is not an error when the run ends with an approval interrupt", () =>
    Effect.gen(function* () {
      const { tracer, runs } = yield* tracedApproval(
        [[...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }), finish("tool-calls")]],
        [{ tools: [], context: [], threadId: "t1", runId: "r1", messages: [userMessage("u1", "Email Ada")] }],
        countingApprovalLayer(),
      );
      expect(runs[0]!.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } });
      const root = tracer.one("invoke_agent assistant");
      expect(root.attributes.has("error.type")).toBe(false);
      expect(root.status._tag === "Ended" && Exit.isSuccess(root.status.exit)).toBe(true);
    }),
  );
});

// -----------------------------------------------------------------------------
// Model and tool spans
// -----------------------------------------------------------------------------

describe("model call spans", () => {
  it.effect("are under the root span and carry the conversation id", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1]);
      const models = tracer.named(MODEL_SPAN);
      expect(models).toHaveLength(2);
      for (const span of models) {
        // A direct child: a backend that keeps only GenAI spans must not lose a span in between.
        expect(tracer.ancestors(span)[0]).toBe("invoke_agent assistant");
        expect(attr(span, "gen_ai.conversation.id")).toBe("t1");
      }
    }),
  );

  it.effect("leave the provider's request spans alone", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      yield* Stream.runDrain(
        Runner.makeAttached(assistant)(run1).pipe(
          Stream.provideService(Telemetry.SpanAttributes, { "user.id": "ada" }),
        ),
      ).pipe(
        Effect.provide([
          scriptedModel(weatherTurn, { requestSpan: REQUEST_SPAN }).layer,
          WeatherToolkitLayer,
          tracer.layer,
          evalLayers,
        ]),
      );
      const requests = tracer.named(REQUEST_SPAN);
      expect(requests).toHaveLength(2);
      for (const span of requests) {
        expect(span.attributes.has("gen_ai.conversation.id")).toBe(false);
        expect(span.attributes.has("user.id")).toBe(false);
      }
    }),
  );
});

describe("tool spans", () => {
  it.effect("trace an executed call, and no other span carries the tool's name or parameters", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1]);
      const tool = tracer.one("execute_tool get-weather");
      expect(tracer.ancestors(tool)[0]).toBe("invoke_agent assistant");
      expect(Object.fromEntries(tool.attributes)).toMatchObject({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "get-weather",
        "gen_ai.tool.call.id": "call-1",
        "gen_ai.tool.type": "function",
        "gen_ai.tool.description": expect.any(String),
        "gen_ai.agent.name": "assistant",
        "gen_ai.conversation.id": "t1",
      });
      expect(tool.attributes.has("error.type")).toBe(false);
      expect(tool.status._tag === "Ended" && Exit.isSuccess(tool.status.exit)).toBe(true);
      const others = tracer.spans.filter((span) => span !== tool);
      for (const span of others) {
        expect(span.attributes.has("tool")).toBe(false);
        expect(span.attributes.has("parameters")).toBe(false);
      }
    }),
  );

  it.effect("carry error.type and end with an error status when the handler returns a failure", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(
        [
          [...toolCall("call-1", "get-weather", { location: "Nowhere" }), finish("tool-calls")],
          [...text("0", "Unknown place."), finish("stop")],
        ],
        [run1],
      );
      const tool = tracer.one("execute_tool get-weather");
      expect(attr(tool, "error.type")).toBe("tool_error");
      expect(tool.status._tag === "Ended" && Exit.isFailure(tool.status.exit)).toBe(true);
      expect(tracer.named(MODEL_SPAN)).toHaveLength(2);
    }),
  );

  it.effect("are not produced for a frontend call", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(
        [[...toolCall("c_pick", "pick-file", {}), finish("tool-calls")]],
        [{ ...run1, tools: [PickFile] }],
      );
      expect(tracer.spans.filter((span) => span.name.startsWith("execute_tool"))).toEqual([]);
    }),
  );

  describe("for calls that need approval", () => {
    const emailStep: Step = [
      ...toolCall("c_email", "send-email", { to: "ada@example.com", body: "Hi" }),
      finish("tool-calls"),
    ];
    const afterEmailTurn: ReadonlyArray<AgUiSchema.Message> = [
      userMessage("u1", "Email Ada"),
      {
        id: "id-1",
        role: "assistant",
        toolCalls: [
          {
            id: "c_email",
            type: "function",
            function: { name: "send-email", arguments: '{"to":"ada@example.com","body":"Hi"}' },
          },
        ],
      },
    ];
    const resumeRun = (approved: boolean): AgUiSchema.RunAgentInput => ({
      tools: [],
      context: [],
      threadId: "t1",
      runId: "r2",
      messages: afterEmailTurn,
      resume: [{ interruptId: Agent.approvalIdFor("c_email"), status: "resolved", payload: { approved } }],
    });

    const emailSpans = (tracer: ReturnType<typeof recordingTracer>) => tracer.named("execute_tool send-email");

    it.effect("are not produced while approval is pending, and are produced once approved", () =>
      Effect.gen(function* () {
        const handlers = countingApprovalLayer();
        const first = yield* tracedApproval(
          [emailStep],
          [{ tools: [], context: [], threadId: "t1", runId: "r1", messages: [userMessage("u1", "Email Ada")] }],
          handlers,
        );
        expect(emailSpans(first.tracer)).toEqual([]);

        const second = yield* tracedApproval([[...text("0", "Sent."), finish("stop")]], [resumeRun(true)], handlers);
        expect(handlers.emails).toEqual(["ada@example.com"]);
        expect(emailSpans(second.tracer)).toHaveLength(1);
        expect(second.tracer.ancestors(emailSpans(second.tracer)[0]!)).toContain("invoke_agent assistant");
      }),
    );

    it.effect("are not produced for a denied call", () =>
      Effect.gen(function* () {
        const handlers = countingApprovalLayer();
        const { tracer } = yield* tracedApproval(
          [[...text("0", "Not sent."), finish("stop")]],
          [resumeRun(false)],
          handlers,
        );
        expect(handlers.emails).toEqual([]);
        expect(emailSpans(tracer)).toEqual([]);
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Content capture
// -----------------------------------------------------------------------------

describe("content capture", () => {
  it.effect("is off by default", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1]);
      for (const span of tracer.spans) {
        for (const key of CONTENT_KEYS) {
          expect(span.attributes.has(key)).toBe(false);
        }
      }
    }),
  );

  it.effect("writes messages, system instructions and tool definitions on model spans", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1], { capture: true });
      const [first, second] = tracer.named(MODEL_SPAN);
      expect(parsed(first!, "gen_ai.system_instructions")).toEqual([{ type: "text", content: "Be helpful." }]);
      expect(parsed(first!, "gen_ai.input.messages")).toEqual([
        { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }] },
      ]);
      expect(parsed(first!, "gen_ai.output.messages")).toEqual([
        {
          role: "assistant",
          parts: [{ type: "tool_call", id: "call-1", name: "get-weather", arguments: { location: "Paris" } }],
        },
      ]);
      expect(parsed(first!, "gen_ai.tool.definitions")).toEqual([
        expect.objectContaining({ type: "function", name: "get-weather", description: expect.any(String) }),
      ]);
      expect(parsed(second!, "gen_ai.input.messages").map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
      ]);
    }),
  );

  it.effect("writes arguments and result on tool spans", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(weatherTurn, [run1], { capture: true });
      const tool = tracer.one("execute_tool get-weather");
      expect(parsed(tool, "gen_ai.tool.call.arguments")).toEqual({ location: "Paris" });
      expect(parsed(tool, "gen_ai.tool.call.result")).toEqual({ temperature: 18 });
    }),
  );

  it.effect("leaves out a reasoning block with no text", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced([[...reasoning("r", []), ...text("0", "Hi."), finish("stop")]], [run1], {
        capture: true,
      });
      expect(parsed(tracer.one(MODEL_SPAN), "gen_ai.output.messages")).toEqual([
        { role: "assistant", parts: [{ type: "text", content: "Hi." }] },
      ]);
    }),
  );
});

// -----------------------------------------------------------------------------
// Replay, per-run attributes, behaviour
// -----------------------------------------------------------------------------

describe("replay", () => {
  it.effect("traces only the work the resumed attempt performs", () =>
    Effect.gen(function* () {
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: AgUiSchema.Event) => boolean) =>
        Effect.gen(function* () {
          const tracer = recordingTracer();
          const events = Runner.makeAttached(assistant)(run1);
          yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runDrain,
            Effect.provide([scriptedModel(steps).layer, WeatherToolkitLayer, tracer.layer]),
          );
          return tracer;
        });

      const first = yield* attempt(
        [weatherTurn[0]!, Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event.type === "TEXT_MESSAGE_CONTENT",
      );
      expect(first.named(MODEL_SPAN)).toHaveLength(2);
      expect(first.named("execute_tool get-weather")).toHaveLength(1);

      const second = yield* attempt([[...text("0", "It is 18°C."), finish("stop")]]);
      expect(second.named("invoke_agent assistant")).toHaveLength(1);
      expect(second.named(MODEL_SPAN)).toHaveLength(1);
      expect(second.named("execute_tool get-weather")).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)), counterIds()),
      ),
    ),
  );
});

describe("per-run span attributes", () => {
  /** The span attributes of each of the run's root, model and tool spans. */
  const runSpans = (tracer: ReturnType<typeof recordingTracer>, threadId: string) =>
    tracer.spans.filter(
      (span) =>
        attr(span, "gen_ai.conversation.id") === threadId &&
        (span.name.startsWith("invoke_agent") || span.name === MODEL_SPAN || span.name.startsWith("execute_tool")),
    );

  it.effect("reach every span of their own run under makeAttached", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      const runAs = (threadId: string, userId: string) =>
        Stream.runDrain(
          Runner.makeAttached(assistant)({ ...run1, threadId }).pipe(
            Stream.provideService(Telemetry.SpanAttributes, { "user.id": userId }),
          ),
        );
      yield* Effect.gen(function* () {
        yield* runAs("t-ada", "ada");
        yield* runAs("t-grace", "grace");
      }).pipe(
        Effect.provide([
          scriptedModel([...weatherTurn, ...weatherTurn], { requestSpan: REQUEST_SPAN }).layer,
          WeatherToolkitLayer,
          tracer.layer,
          evalLayers,
        ]),
      );
      for (const [threadId, userId] of [
        ["t-ada", "ada"],
        ["t-grace", "grace"],
      ] as const) {
        const spans = runSpans(tracer, threadId);
        // Root, two model calls, one tool call.
        expect(spans).toHaveLength(4);
        for (const span of spans) {
          expect(attr(span, "user.id")).toBe(userId);
        }
      }
    }),
  );

  it.effect("cannot replace the library's gen_ai attributes", () =>
    Effect.gen(function* () {
      const tracer = recordingTracer();
      yield* Stream.runDrain(
        Runner.makeAttached(assistant)(run1).pipe(
          Stream.provideService(Telemetry.SpanAttributes, {
            "gen_ai.conversation.id": "spoofed",
            "gen_ai.agent.name": "spoofed",
            "user.id": "ada",
          }),
        ),
      ).pipe(Effect.provide([scriptedModel(weatherTurn).layer, WeatherToolkitLayer, tracer.layer, evalLayers]));
      const spans = runSpans(tracer, "t1");
      // Root, two model calls, one tool call: none took the caller's conversation id.
      expect(spans).toHaveLength(4);
      for (const span of spans) {
        expect(attr(span, "user.id")).toBe("ada");
        expect(attr(span, "gen_ai.agent.name")).not.toBe("spoofed");
      }
    }),
  );

  it.effect("can be built per run by makeDetached's layer", () =>
    Effect.gen(function* () {
      class Principal extends Context.Service<Principal, { readonly userId: string }>()("test/Principal") {}
      const tracer = recordingTracer();
      const runner = yield* Runner.makeDetached(assistant, {
        dependencies: [Principal],
        layer: Layer.effect(
          Telemetry.SpanAttributes,
          Effect.gen(function* () {
            const principal = yield* Principal;
            return { "user.id": principal.userId };
          }),
        ),
      }).pipe(
        Effect.provide([scriptedModel([...weatherTurn, ...weatherTurn]).layer, WeatherToolkitLayer, tracer.layer]),
        Effect.provideService(Scope.Scope, yield* Scope.make()),
      );
      const log = yield* EventLog.EventLog;
      for (const [threadId, userId] of [
        ["t-ada", "ada"],
        ["t-grace", "grace"],
      ] as const) {
        yield* runner.start({ ...run1, threadId }).pipe(Effect.provideService(Principal, { userId }));
        const events = yield* Stream.runCollect(Stream.unwrap(log.subscribe(threadId, "r1")));
        yield* Effect.promise(() => verify(events.map((stored) => stored.event)));
      }
      for (const [threadId, userId] of [
        ["t-ada", "ada"],
        ["t-grace", "grace"],
      ] as const) {
        const spans = runSpans(tracer, threadId);
        expect(spans.length).toBeGreaterThanOrEqual(4);
        for (const span of spans) {
          expect(attr(span, "user.id")).toBe(userId);
        }
      }
    }).pipe(Effect.provide(Layer.mergeAll(evalLayers, EventLog.layerMemory))),
  );
});

describe("tracing and behaviour", () => {
  it.effect("leaves events and prompts unchanged", () =>
    Effect.gen(function* () {
      const plain = yield* Effect.gen(function* () {
        const model = scriptedModel(weatherTurn);
        const [events] = yield* runAgUi(assistant, [run1]).pipe(Effect.provide([model.layer, WeatherToolkitLayer]));
        return { events, prompts: model.prompts };
      }).pipe(Effect.provide(evalLayers));

      const withTracing = yield* Effect.gen(function* () {
        const model = scriptedModel(weatherTurn, { requestSpan: REQUEST_SPAN });
        const [events] = yield* runAgUi(assistant, [run1]).pipe(
          Effect.provide([
            model.layer,
            WeatherToolkitLayer,
            recordingTracer().layer,
            Telemetry.layerCaptureContent,
            Layer.succeed(Telemetry.SpanAttributes, { "user.id": "ada" }),
          ]),
        );
        return { events, prompts: model.prompts };
      }).pipe(Effect.provide(evalLayers));

      expect(withTracing.events).toEqual(plain.events);
      expect(withTracing.prompts).toEqual(plain.prompts);
    }),
  );

  it.effect("an agent's name changes neither prompts nor events", () =>
    Effect.gen(function* () {
      const runWith = (agent: typeof assistant) =>
        Effect.gen(function* () {
          const model = scriptedModel(weatherTurn);
          const [events] = yield* runAgUi(agent, [run1]).pipe(Effect.provide([model.layer, WeatherToolkitLayer]));
          return { events, prompts: model.prompts };
        }).pipe(Effect.provide(evalLayers));
      const named = yield* runWith(assistant);
      const unnamed = yield* runWith(Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." }));
      expect(named).toEqual(unnamed);
    }),
  );
});

// -----------------------------------------------------------------------------
// Subagents
// -----------------------------------------------------------------------------

describe("subagent spans", () => {
  const researcher = Agent.define({
    name: "researcher",
    description: "Looks things up",
    toolkit: WeatherToolkit,
    system: "You research.",
  });
  const lead = Agent.define({
    toolkit: WeatherToolkit,
    name: "assistant",
    subagents: { agents: [researcher] },
  }) as unknown as typeof assistant;
  const delegation: ReadonlyArray<Step> = [
    [...toolCall("c1", "researcher", { prompt: "Find the weather in Paris" }), finish("tool-calls")],
    [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
    [...text("0", "Paris is 18°C"), finish("stop")],
    [...text("0", "It's 18°C."), finish("stop")],
  ];

  it.effect("nests the child's model and tool spans under an invoke_agent span for the call", () =>
    Effect.gen(function* () {
      const { tracer } = yield* traced(delegation, [run1], { agent: lead });
      const span = tracer.one("invoke_agent researcher");
      expect(tracer.ancestors(span)).toEqual(["invoke_agent assistant"]);
      expect(attr(span, "gen_ai.operation.name")).toBe("invoke_agent");
      expect(attr(span, "gen_ai.agent.name")).toBe("researcher");
      expect(attr(span, "gen_ai.agent.description")).toBe("Looks things up");
      expect(attr(span, "gen_ai.tool.call.id")).toBe("c1");
      expect(attr(span, "gen_ai.conversation.id")).toBe("t1");
      expect(span.status._tag).toBe("Ended");
      expect(tracer.ancestors(tracer.one("execute_tool get-weather"))[0]).toBe("invoke_agent researcher");
      const models = tracer.named(MODEL_SPAN).map((model) => tracer.ancestors(model)[0]);
      expect(models).toEqual([
        "invoke_agent assistant",
        "invoke_agent researcher",
        "invoke_agent researcher",
        "invoke_agent assistant",
      ]);
    }),
  );

  it.effect("ends a failed child's span with an error", () =>
    Effect.gen(function* () {
      const hasty = Agent.define({ ...researcher, name: "researcher", maxSteps: 1 });
      const withHasty = Agent.define({
        toolkit: WeatherToolkit,
        name: "assistant",
        subagents: { agents: [hasty] },
      }) as unknown as typeof assistant;
      const errors: Array<unknown> = [];
      const { tracer } = yield* traced(
        [delegation[0]!, delegation[1]!, [...text("0", "Sorry."), finish("stop")]],
        [run1],
        { agent: withHasty },
      ).pipe(Effect.provide(errorLogs(errors)));
      // The parent reports the failure as a failed tool result, and succeeds: nothing is logged as an error.
      expect(errors).toEqual([]);
      const span = tracer.one("invoke_agent researcher");
      expect(attr(span, "error.type")).toBe("StepLimitExceeded");
      expect(span.events.filter(([name]) => name === "exception")).toEqual([]);
      expect(exportedExceptions(span).map((error) => error.name)).toEqual(["StepLimitExceeded"]);
      const root = tracer.one("invoke_agent assistant");
      expect(root.status._tag === "Ended" && Exit.isSuccess(root.status.exit)).toBe(true);
    }),
  );

  it.effect("opens no model or tool span for a child's replayed steps", () =>
    Effect.gen(function* () {
      const attempt = (steps: ReadonlyArray<Step>) =>
        Effect.gen(function* () {
          const tracer = recordingTracer();
          yield* agentRun(lead, { prompt: Prompt.make("Weather?") }).pipe(
            Stream.runDrain,
            Effect.provide([scriptedModel(steps).layer, WeatherToolkitLayer, tracer.layer]),
          );
          return tracer;
        });
      yield* attempt(delegation);
      const again = yield* attempt([]);
      expect(again.named(MODEL_SPAN)).toEqual([]);
      expect(again.named("execute_tool get-weather")).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)), counterIds()),
      ),
    ),
  );
});
