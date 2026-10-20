import { Cause, Effect, Option, Schema, Stream } from "effect";
import { IdGenerator, LanguageModel, Prompt } from "effect/ai";
import type { Response, Tool, Toolkit } from "effect/ai";
import * as AgUi from "./AgUi.ts";
import * as Messages from "./Messages.ts";

export interface AgentOptions<Tools extends Record<string, Tool.Any>> {
  /**
   * Server-side tools. Handlers run inside the loop; use `failureMode: "return"`
   * on tools whose failures should be reported back to the model.
   */
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /** System prompt placed before the client-provided history. */
  readonly system?: string | undefined;
  /** Maximum number of model steps per run. Defaults to 10. */
  readonly maxSteps?: number | undefined;
}

export class StepLimitExceeded extends Schema.TaggedError<StepLimitExceeded, { readonly brand: unique symbol }>()(
  "StepLimitExceeded",
  {
    maxSteps: Schema.Finite,
  },
) {
  override get message(): string {
    return `Step limit exceeded: the model was still calling tools after ${this.maxSteps} steps`;
  }
}

export class ModelStreamError extends Schema.TaggedError<ModelStreamError, { readonly brand: unique symbol }>()(
  "ModelStreamError",
  {
    error: Schema.Unknown,
  },
) {
  override get message(): string {
    return errorMessage(this.error);
  }
}

export type Requirements<Tools extends Record<string, Tool.Any>> =
  | LanguageModel.LanguageModel
  | Tool.HandlersFor<Tools>
  | Tool.HandlerServices<Tools[keyof Tools]>
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>
  | Tool.ResultDecodingServices<Tools[keyof Tools]>;

/**
 * Runs one AG-UI run: rebuilds the prompt from the client's messages, drives
 * the model step by step (resolving tool calls in between) and emits a
 * well-formed AG-UI event stream. Failures are reported in-band as
 * `RUN_ERROR`, so the stream itself never fails.
 */
export const run =
  <Tools extends Record<string, Tool.Any>>(options: AgentOptions<Tools>) =>
  (input: AgUi.RunAgentInput): Stream.Stream<AgUi.Event, never, Requirements<Tools>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ids = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
          Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator)),
        );
        const maxSteps = options.maxSteps ?? 10;
        let current: StepState | undefined;

        const step = (prompt: Prompt.Prompt, index: number): Stream.Stream<AgUi.Event, unknown, Requirements<Tools>> =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (index > maxSteps) {
                return yield* new StepLimitExceeded({ maxSteps });
              }
              const state = new StepState(yield* ids.generateId());
              current = state;
              const parts: Array<Response.AnyPart> = [];

              const events = LanguageModel.streamText({ prompt, toolkit: options.toolkit }).pipe(
                Stream.mapEffect((part) => {
                  parts.push(part as Response.AnyPart);
                  return handlePart(state, part as Response.StreamPart<Record<string, Tool.Any>>, ids);
                }),
                Stream.flattenIterable,
              );

              const next = Stream.suspend(() => {
                const closing = Stream.fromIterable(state.close());
                return state.finishReason === "tool-calls"
                  ? Stream.concat(closing, step(Prompt.concat(prompt, Prompt.fromResponseParts(parts)), index + 1))
                  : closing;
              });

              return Stream.concat(events, next);
            }),
          );

        return Stream.make(AgUi.runStarted(input)).pipe(
          Stream.concat(step(Messages.toPrompt(input.messages, { system: options.system }), 1)),
          Stream.concat(Stream.sync(() => AgUi.runFinished(input))),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Stream.failCause(cause as Cause.Cause<never>)
              : Stream.fromIterable([...(current?.close() ?? []), AgUi.runError(causeMessage(cause))]),
          ),
        );
      }),
    );

/**
 * Captures the agent's services once and returns a runner whose streams have
 * no requirements. Use this at a transport edge (HTTP response, WebSocket,
 * ...) where the stream is consumed after the surrounding effect has returned.
 */
export const make = <Tools extends Record<string, Tool.Any>>(
  options: AgentOptions<Tools>,
): Effect.Effect<(input: AgUi.RunAgentInput) => Stream.Stream<AgUi.Event>, never, Requirements<Tools>> =>
  Effect.map(Effect.context<Requirements<Tools>>(), (context) => {
    const runWith = run(options);
    return (input) => runWith(input).pipe(Stream.provideContext(context));
  });

// -----------------------------------------------------------------------------
// Per-step state
//
// Provider part ids are only meaningful inside one model stream (Anthropic, for
// example, uses the content block index), so they are used purely to track
// which spans are open. Every AG-UI message id is minted here instead.
// -----------------------------------------------------------------------------

class StepState {
  readonly openText = new Set<string>();
  readonly openTools = new Set<string>();
  readonly seenTools = new Set<string>();
  finishReason: Response.FinishReason | undefined;
  readonly messageId: string;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** Closes every span still open, e.g. at step end or when the run fails. */
  close(): Array<AgUi.Event> {
    const events: Array<AgUi.Event> = [];
    if (this.openText.size > 0) {
      this.openText.clear();
      events.push(AgUi.textMessageEnd(this.messageId));
    }
    for (const id of this.openTools) {
      events.push(AgUi.toolCallEnd(id));
    }
    this.openTools.clear();
    return events;
  }
}

const handlePart = (
  state: StepState,
  part: Response.StreamPart<Record<string, Tool.Any>>,
  ids: IdGenerator.Service,
): Effect.Effect<ReadonlyArray<AgUi.Event>, ModelStreamError> => {
  switch (part.type) {
    case "text-start": {
      const events = state.openText.size === 0 ? [AgUi.textMessageStart(state.messageId)] : [];
      state.openText.add(part.id);
      return Effect.succeed(events);
    }
    case "text-delta": {
      const events: Array<AgUi.Event> = [];
      if (state.openText.size === 0) {
        state.openText.add(part.id);
        events.push(AgUi.textMessageStart(state.messageId));
      }
      if (part.delta.length > 0) {
        events.push(AgUi.textMessageContent(state.messageId, part.delta));
      }
      return Effect.succeed(events);
    }
    case "text-end": {
      const closed = state.openText.delete(part.id) && state.openText.size === 0;
      return Effect.succeed(closed ? [AgUi.textMessageEnd(state.messageId)] : []);
    }
    case "tool-params-start": {
      state.seenTools.add(part.id);
      state.openTools.add(part.id);
      return Effect.succeed([AgUi.toolCallStart(part.id, part.name, state.messageId)]);
    }
    case "tool-params-delta": {
      return Effect.succeed(state.openTools.has(part.id) ? [AgUi.toolCallArgs(part.id, part.delta)] : []);
    }
    case "tool-params-end": {
      return Effect.succeed(state.openTools.delete(part.id) ? [AgUi.toolCallEnd(part.id)] : []);
    }
    case "tool-call": {
      // Providers that do not stream parameters only emit the complete call.
      if (state.seenTools.has(part.id)) {
        return Effect.succeed([]);
      }
      state.seenTools.add(part.id);
      return Effect.succeed([
        AgUi.toolCallStart(part.id, part.name, state.messageId),
        AgUi.toolCallArgs(part.id, JSON.stringify(part.params ?? {})),
        AgUi.toolCallEnd(part.id),
      ]);
    }
    case "tool-result": {
      if (part.preliminary === true) {
        return Effect.succeed([]);
      }
      const events: Array<AgUi.Event> = [];
      if (state.openTools.delete(part.id)) {
        events.push(AgUi.toolCallEnd(part.id));
      }
      return ids
        .generateId()
        .pipe(
          Effect.map((messageId) => [
            ...events,
            AgUi.toolCallResult(messageId, part.id, JSON.stringify(part.encodedResult ?? null)),
          ]),
        );
    }
    case "finish": {
      state.finishReason = part.reason;
      return Effect.succeed([]);
    }
    case "error": {
      return Effect.fail(new ModelStreamError({ error: part.error }));
    }
    default: {
      return Effect.succeed([]);
    }
  }
};

const causeMessage = (cause: Cause.Cause<unknown>): string => errorMessage(Cause.squash(cause));

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
};
