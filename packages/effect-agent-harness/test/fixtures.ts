import { expect } from "@effect/vitest";
import { verifyEvents } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { Effect, Layer, Option, Schema, Stream, Tracer } from "effect";
import { AgUiSchema, AiError, IdGenerator, LanguageModel, Response, Tool, Toolkit } from "effect/ai";
import type { Prompt } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import { isReplayed } from "../src/internal/events.ts";
import { OnStepFinished } from "../src/internal/hooks.ts";
import type * as Messages from "../src/Messages.ts";
import * as Runner from "../src/Runner.ts";
import { from, lastValueFrom, toArray } from "rxjs";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as History from "../src/History.ts";
import * as Thread from "../src/Thread.ts";

// -----------------------------------------------------------------------------
// Scripted language model
//
// Each element of `steps` is the stream returned for one `streamText` call. Part
// ids mimic Anthropic, which reuses the content block index ("0", "1", ...) on
// every step. `prompts` and `tools` record what each call received.
// -----------------------------------------------------------------------------

export type Step =
  | ReadonlyArray<Response.StreamPartEncoded>
  | Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

export const scriptedModel = (
  steps: ReadonlyArray<Step>,
  options?: {
    /** Streams each step inside a span of this name, as a provider's HTTP client span would be. */
    readonly requestSpan?: string | undefined;
  },
) => {
  const prompts: Array<Prompt.Prompt> = [];
  const tools: Array<ReadonlyArray<Tool.Any>> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die("generateText is not scripted"),
      streamText: (call) => {
        const step = steps[prompts.length];
        prompts.push(call.prompt);
        tools.push(call.tools);
        if (step === undefined) {
          return Stream.die(`no scripted step ${prompts.length}`);
        }
        const stream = Stream.isStream(step) ? step : Stream.fromIterable(step);
        return options?.requestSpan === undefined ? stream : Stream.withSpan(stream, options.requestSpan);
      },
    }),
  );
  return { layer, prompts, tools };
};

// -----------------------------------------------------------------------------
// Recording tracer
// -----------------------------------------------------------------------------

/** A tracer that keeps every span it creates, for tests to inspect once they have ended. */
export const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const named = (name: string) => spans.filter((span) => span.name === name);
  const one = (name: string) => {
    const found = named(name);
    if (found.length !== 1) {
      throw new Error(`expected one span named ${name}, found ${found.length}`);
    }
    return found[0]!;
  };
  /** The names of a span's ancestors, nearest first. */
  const ancestors = (span: Tracer.AnySpan): Array<string> => {
    const names: Array<string> = [];
    let parent = span._tag === "Span" ? span.parent : Option.none();
    while (Option.isSome(parent)) {
      const value: Tracer.AnySpan = parent.value;
      names.push(value._tag === "Span" ? value.name : `external:${value.spanId}`);
      parent = value._tag === "Span" ? value.parent : Option.none();
    }
    return names;
  };
  return { layer: Layer.succeed(Tracer.Tracer, tracer), spans, named, one, ancestors };
};

export const text = (id: string, ...deltas: Array<string>): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id },
  ...deltas.map((delta): Response.StreamPartEncoded => ({ type: "text-delta", id, delta })),
  { type: "text-end", id },
];

/** Metadata as a provider puts it on a reasoning block, holding a signature for replay. */
export const signature = (value: string) => ({ anthropic: { signature: value } });

/** A streamed reasoning block. `metadata` goes on its end part, where a provider sends the signature. */
export const reasoning = (
  id: string,
  deltas: ReadonlyArray<string>,
  metadata?: ReturnType<typeof signature>,
): Array<Response.StreamPartEncoded> => [
  { type: "reasoning-start", id },
  ...deltas.map((delta): Response.StreamPartEncoded => ({ type: "reasoning-delta", id, delta })),
  metadata === undefined ? { type: "reasoning-end", id } : { type: "reasoning-end", id, metadata },
];

/**
 * A reasoning block delivered whole. Not a stream part, so `LanguageModel`
 * rejects it from a scripted step: pass it straight to a `StepEmitter`.
 */
export const wholeReasoning = (reasoningText: string): Response.ReasoningPart =>
  Response.makePart("reasoning", { text: reasoningText });

export const toolCall = (
  id: string,
  name: string,
  params: Record<string, unknown>,
  argChunks: ReadonlyArray<string> = [JSON.stringify(params)],
): Array<Response.StreamPartEncoded> => [
  { type: "tool-params-start", id, name },
  ...argChunks.map((delta): Response.StreamPartEncoded => ({ type: "tool-params-delta", id, delta })),
  { type: "tool-params-end", id },
  { type: "tool-call", id, name, params },
];

export const finish = (
  reason: Response.FinishReason,
  usage?: { readonly input?: number; readonly output?: number; readonly reasoning?: number; readonly cached?: number },
): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: {
      ...(usage?.input === undefined ? {} : { total: usage.input }),
      ...(usage?.cached === undefined ? {} : { cacheRead: usage.cached }),
    },
    outputTokens: {
      ...(usage?.output === undefined ? {} : { total: usage.output }),
      ...(usage?.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    },
  },
});

// -----------------------------------------------------------------------------
// Deterministic ids
// -----------------------------------------------------------------------------

/** Ids `${prefix}-1`, `${prefix}-2`, ..., counting from 1 again each time the layer is built. */
export const counterIds = (prefix = "id") =>
  Layer.sync(IdGenerator.IdGenerator, () => {
    let n = 0;
    return { generateId: () => Effect.sync(() => `${prefix}-${++n}`) };
  });

// -----------------------------------------------------------------------------
// Weather tool
// -----------------------------------------------------------------------------

const weather = (location: string) =>
  location === "Nowhere"
    ? Effect.fail({ message: `Location '${location}' not found` })
    : Effect.succeed({ temperature: 18 });

export const GetWeather = Tool.make("get-weather", {
  description: "Get current weather for a location",
  parameters: Schema.Struct({ location: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Finite }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
});

export const WeatherToolkit = Toolkit.make(GetWeather);

export const WeatherToolkitLayer = WeatherToolkit.toLayer({
  "get-weather": ({ location }) => weather(location),
});

/** The weather handlers, recording the location of every call in `calls`. */
export const countingWeatherLayer = () => {
  const calls: Array<string> = [];
  const layer = WeatherToolkit.toLayer({
    "get-weather": ({ location }) => Effect.suspend(() => (calls.push(location), weather(location))),
  });
  return { layer, calls };
};

// -----------------------------------------------------------------------------
// Approval tool
// -----------------------------------------------------------------------------

export const SendEmail = Tool.make("send-email", {
  description: "Send an email",
  parameters: Schema.Struct({ to: Schema.String, body: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
  needsApproval: true,
});

export const ApprovalToolkit = Toolkit.make(GetWeather, SendEmail);

/** Handlers for {@link ApprovalToolkit}, recording every weather location and email recipient. */
export const countingApprovalLayer = () => {
  const weatherCalls: Array<string> = [];
  const emails: Array<string> = [];
  const layer = ApprovalToolkit.toLayer({
    "get-weather": ({ location }) => Effect.suspend(() => (weatherCalls.push(location), weather(location))),
    "send-email": ({ to }) => Effect.sync(() => (emails.push(to), { sent: true })),
  });
  return { layer, weatherCalls, emails };
};

// -----------------------------------------------------------------------------
// Progress tools
// -----------------------------------------------------------------------------

/** Reports `{ done, of }` for each source as a preliminary result; the final one adds `hits`. */
export const Search = Tool.make("search", {
  description: "Search some sources, reporting progress",
  parameters: Schema.Struct({ query: Schema.String, sources: Schema.Finite }),
  success: Schema.Struct({ done: Schema.Finite, of: Schema.Finite, hits: Schema.optionalKey(Schema.Finite) }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
});

/** Reports each number below `to` as a preliminary result, then returns `to`: progress that isn't an object. */
export const Count = Tool.make("count", {
  description: "Count up to a number",
  parameters: Schema.Struct({ to: Schema.Finite }),
  success: Schema.Finite,
});

export const ProgressToolkit = Toolkit.make(Search, Count);

/**
 * Handlers for {@link ProgressToolkit}, recording each search query in `calls`.
 * `between` runs after every preliminary result, so a test can block a handler
 * mid-call. A search for "fail" fails after reporting its progress.
 */
export const progressLayer = (options?: { readonly between?: Effect.Effect<void> | undefined }) => {
  const calls: Array<string> = [];
  const between = options?.between ?? Effect.void;
  const layer = ProgressToolkit.toLayer({
    search: ({ query, sources }, ctx) =>
      Effect.gen(function* () {
        calls.push(query);
        for (let done = 1; done <= sources; done++) {
          yield* ctx.preliminary({ done, of: sources });
          yield* between;
        }
        if (query === "fail") {
          return yield* Effect.fail({ message: "search failed" });
        }
        return { done: sources, of: sources, hits: 3 };
      }),
    count: ({ to }, ctx) =>
      Effect.gen(function* () {
        for (let n = 1; n < to; n++) {
          yield* ctx.preliminary(n);
          yield* between;
        }
        return to;
      }),
  });
  return { layer, calls };
};

// -----------------------------------------------------------------------------
// Frontend tools
// -----------------------------------------------------------------------------

/** A frontend tool as a client advertises it in `RunAgentInput.tools`. */
export const PickFile = {
  name: "pick-file",
  description: "Ask the user to pick a file",
  parameters: { type: "object", properties: { accept: { type: "string" } } },
} satisfies AgUiSchema.Tool;

export const GetLocation = {
  name: "get-location",
  description: "Read the browser's location",
  parameters: { type: "object", properties: {} },
} satisfies AgUiSchema.Tool;

/** A client `tool` message answering a frontend call, as TanStack AI sends it (its own id, JSON text content). */
export const toolAnswer = (
  toolCallId: string,
  content: unknown,
  options?: { readonly id?: string; readonly error?: string },
): AgUiSchema.Message => ({
  id: options?.id ?? `tool-${toolCallId}`,
  role: "tool",
  toolCallId,
  content: typeof content === "string" ? content : JSON.stringify(content),
  ...(options?.error === undefined ? {} : { error: options.error }),
});

// -----------------------------------------------------------------------------
// Run input
// -----------------------------------------------------------------------------

/**
 * A run input as AG-UI's schema decodes it, with `tools` and `context` defaulting to the empty arrays a request
 * without them decodes to.
 */
export const runInput = (
  input: Omit<AgUiSchema.RunAgentInput, "tools" | "context"> &
    Partial<Pick<AgUiSchema.RunAgentInput, "tools" | "context">>,
): AgUiSchema.RunAgentInput => ({ tools: [], context: [], ...input });

// -----------------------------------------------------------------------------
// Running an agent directly
// -----------------------------------------------------------------------------

/** The AG-UI input of a run on thread `t1`, run `r1`, with no messages, unless `input` says otherwise. */
export const agentInput = (input?: Partial<AgUiSchema.RunAgentInput>): AgUiSchema.RunAgentInput =>
  runInput({ threadId: "t1", runId: "r1", messages: [], ...input });

/** `Agent.run` on `prompt`, with {@link agentInput}'s input unless the options give one. */
export const agentRun = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  options: Omit<Agent.RunOptions, "input"> & { readonly input?: Partial<AgUiSchema.RunAgentInput> | undefined },
) => Agent.run(agent, { ...options, input: agentInput(options.input) });

/** A run's AG-UI events, and the entries each step handed to whatever runs it, in order. */
export interface Collected {
  readonly events: Array<AgUiSchema.Event>;
  readonly steps: Array<ReadonlyArray<Messages.Entry>>;
}

/** Collects a run's events, recording the entries each step hands to its runner as a runner's commit would. */
export const collect = <E, R>(events: Stream.Stream<AgUiSchema.Event, E, R>): Effect.Effect<Collected, E, R> =>
  Effect.gen(function* () {
    const steps: Array<ReadonlyArray<Messages.Entry>> = [];
    const collected = yield* events.pipe(
      Stream.provideService(OnStepFinished, (entries) => Effect.sync(() => steps.push(entries))),
      Stream.runCollect,
    );
    return { events: Array.from(collected), steps };
  });

/** The events' types, in order. */
export const types = (events: ReadonlyArray<AgUiSchema.Event>) => events.map((event) => event.type);

/** The events of one type. */
export const ofType = <T extends AgUiSchema.Event["type"]>(events: ReadonlyArray<AgUiSchema.Event>, type: T) =>
  events.filter((event): event is Extract<AgUiSchema.Event, { type: T }> => event.type === type);

/** Each `TOOL_CALL_RESULT`, read back: its decoded value, whether it failed, and whether it is marked replayed. */
export const resultsOf = (events: ReadonlyArray<AgUiSchema.Event>) =>
  ofType(events, "TOOL_CALL_RESULT").map((event) => ({
    toolCallId: event.toolCallId,
    messageId: event.messageId,
    value: typeof event.content === "string" ? (JSON.parse(event.content) as unknown) : event.content,
    isFailure: (event.metadata?.["effect/ai"] as { isFailure?: boolean } | undefined)?.isFailure === true,
    replayed: isReplayed(event),
    ...(event.subagentRunId === undefined ? {} : { subagentRunId: event.subagentRunId }),
  }));

/** The run's terminal event. */
export const terminalOf = (events: ReadonlyArray<AgUiSchema.Event>) => {
  const last = events.at(-1);
  if (last?.type !== "RUN_FINISHED" && last?.type !== "RUN_ERROR") {
    throw new Error(`the run did not end with a terminal event, but with ${last?.type}`);
  }
  return last;
};

/** The run's `RUN_FINISHED` outcome; throws if it ended otherwise. */
export const outcomeOf = (events: ReadonlyArray<AgUiSchema.Event>) => {
  const last = terminalOf(events);
  if (last.type !== "RUN_FINISHED") {
    throw new Error(`the run failed: ${last.message}`);
  }
  return last.outcome;
};

// -----------------------------------------------------------------------------
// Evals
// -----------------------------------------------------------------------------

/** What an eval or unit test provides besides the model and tool handlers: no durability, deterministic ids. */
export const evalLayers = Layer.mergeAll(Checkpoint.layerNone, counterIds());

/**
 * The server history over an in-memory thread store. `Thread` stays in the
 * output, so a test can read the store its runs wrote.
 */
export const serverStores = History.layerServer.pipe(Layer.provideMerge(Thread.layerMemory));

/** The server history over `thread`, keeping `thread`'s `Thread` in the output. */
export const serverHistory = <E, R>(thread: Layer.Layer<Thread.Thread, E, R>) =>
  History.layerServer.pipe(Layer.provideMerge(thread));

// -----------------------------------------------------------------------------
// AG-UI client verification
// -----------------------------------------------------------------------------

const decodeEvent = Schema.decodeUnknownSync(AgUiSchema.Event);

/**
 * Checks each event against the AG-UI schema (no undeclared fields), then runs
 * the sequence through `@ag-ui/client`'s verifier; rejects if either fails.
 * The client types `type` as its `EventType` enum, whose values are the wire
 * strings our events carry, hence the cast.
 */
export const verify = async (events: ReadonlyArray<AgUiSchema.Event>): Promise<Array<BaseEvent>> => {
  for (const event of events) {
    decodeEvent(event, { onExcessProperty: "error" });
  }
  // What goes out never carries the library's marker, and a result never goes out twice.
  expect(JSON.stringify(events)).not.toContain('"effect-agent-harness":');
  const results = events.flatMap((event) => (event.type === "TOOL_CALL_RESULT" ? [event.toolCallId] : []));
  expect(new Set(results).size).toBe(results.length);
  return lastValueFrom(from(events as ReadonlyArray<BaseEvent>).pipe(verifyEvents(), toArray()));
};

/**
 * Runs each input through `Runner.makeAttached`, one after another, and returns each
 * run's AG-UI events, already verified. The runs use the client history,
 * unless a history is provided around it: provide one `serverStores` so the
 * runs share a thread store.
 */
export const runAgUi = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  inputs: ReadonlyArray<AgUiSchema.RunAgentInput>,
  options?: Runner.Options,
) =>
  Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(Runner.makeAttached(agent, options)(input)));
      yield* Effect.promise(() => verify(events));
      return events;
    }),
  );
