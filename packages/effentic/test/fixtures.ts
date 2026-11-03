import { verifyEvents } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { Effect, Layer, Schema, Stream } from "effect";
import { AiError, IdGenerator, LanguageModel, Tool, Toolkit } from "effect/ai";
import type { Prompt, Response } from "effect/ai";
import type * as Agent from "../src/Agent.ts";
import type * as AgUi from "../src/AgUi.ts";
import * as AgUiSchema from "../src/AgUiSchema.ts";
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

export const scriptedModel = (steps: ReadonlyArray<Step>) => {
  const prompts: Array<Prompt.Prompt> = [];
  const tools: Array<ReadonlyArray<Tool.Any>> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die("generateText is not scripted"),
      streamText: (options) => {
        const step = steps[prompts.length];
        prompts.push(options.prompt);
        tools.push(options.tools);
        if (step === undefined) {
          return Stream.die(`no scripted step ${prompts.length}`);
        }
        return Stream.isStream(step) ? step : Stream.fromIterable(step);
      },
    }),
  );
  return { layer, prompts, tools };
};

export const text = (id: string, ...deltas: Array<string>): Array<Response.StreamPartEncoded> => [
  { type: "text-start", id },
  ...deltas.map((delta): Response.StreamPartEncoded => ({ type: "text-delta", id, delta })),
  { type: "text-end", id },
];

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

export const finish = (reason: Response.FinishReason): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: {}, outputTokens: {} },
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
// Frontend tools
// -----------------------------------------------------------------------------

/** A frontend tool as a client advertises it in `RunAgentInput.tools`. */
export const PickFile: AgUi.FrontendTool = {
  name: "pick-file",
  description: "Ask the user to pick a file",
  parameters: { type: "object", properties: { accept: { type: "string" } } },
};

export const GetLocation: AgUi.FrontendTool = {
  name: "get-location",
  description: "Read the browser's location",
  parameters: { type: "object", properties: {} },
};

/** A client `tool` message answering a frontend call, as TanStack AI sends it (its own id, JSON text content). */
export const toolAnswer = (
  toolCallId: string,
  content: unknown,
  options?: { readonly id?: string; readonly error?: string },
): AgUi.Message => ({
  id: options?.id ?? `tool-${toolCallId}`,
  role: "tool",
  toolCallId,
  content: typeof content === "string" ? content : JSON.stringify(content),
  ...(options?.error === undefined ? {} : { error: options.error }),
});

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
export const verify = async (events: ReadonlyArray<AgUi.Event>): Promise<Array<BaseEvent>> => {
  for (const event of events) {
    decodeEvent(event, { onExcessProperty: "error" });
  }
  return lastValueFrom(from(events as ReadonlyArray<BaseEvent>).pipe(verifyEvents(), toArray()));
};

/**
 * Runs each input through `Runner.run`, one after another, and returns each
 * run's AG-UI events, already verified. The runs use the client history,
 * unless a history is provided around it: provide one `serverStores` so the
 * runs share a thread store.
 */
export const runAgUi = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent.Agent<Tools, R>,
  inputs: ReadonlyArray<AgUi.RunAgentInput>,
  options?: Runner.Options,
) =>
  Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      const events = Array.from(yield* Stream.runCollect(Runner.run(agent, options)(input)));
      yield* Effect.promise(() => verify(events));
      return events;
    }),
  );
