import { verifyEvents } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { Effect, Layer, Schema, Stream } from "effect";
import { AiError, IdGenerator, LanguageModel, Tool, Toolkit } from "effect/ai";
import type { Prompt, Response } from "effect/ai";
import { from, lastValueFrom, toArray } from "rxjs";

// -----------------------------------------------------------------------------
// Scripted language model
//
// Each element of `steps` is the stream returned for one `streamText` call. Part
// ids mimic Anthropic, which reuses the content block index ("0", "1", ...) on
// every step.
// -----------------------------------------------------------------------------

export type Step =
  | ReadonlyArray<Response.StreamPartEncoded>
  | Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

export const scriptedModel = (steps: ReadonlyArray<Step>) => {
  const prompts: Array<Prompt.Prompt> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die("generateText is not scripted"),
      streamText: (options) => {
        const step = steps[prompts.length];
        prompts.push(options.prompt);
        if (step === undefined) {
          return Stream.die(`no scripted step ${prompts.length}`);
        }
        return Stream.isStream(step) ? step : Stream.fromIterable(step);
      },
    }),
  );
  return { layer, prompts };
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

export const counterIds = (prefix = "id") => {
  let n = 0;
  return Layer.succeed(IdGenerator.IdGenerator)({
    generateId: () => Effect.sync(() => `${prefix}-${++n}`),
  });
};

// -----------------------------------------------------------------------------
// Weather tool
// -----------------------------------------------------------------------------

export const GetWeather = Tool.make("get-weather", {
  description: "Get current weather for a location",
  parameters: Schema.Struct({ location: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Finite }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
});

export const WeatherToolkit = Toolkit.make(GetWeather);

export const WeatherToolkitLayer = WeatherToolkit.toLayer({
  "get-weather": ({ location }) =>
    location === "Nowhere"
      ? Effect.fail({ message: `Location '${location}' not found` })
      : Effect.succeed({ temperature: 18 }),
});

// -----------------------------------------------------------------------------
// AG-UI client verification
// -----------------------------------------------------------------------------

/** Runs events through `@ag-ui/client`'s verifier; rejects if the sequence is invalid. */
export const verify = (events: ReadonlyArray<BaseEvent>): Promise<Array<BaseEvent>> =>
  lastValueFrom(from(events).pipe(verifyEvents(), toArray()));
