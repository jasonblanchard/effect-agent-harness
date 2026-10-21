import { Cause, Effect, Option, Predicate, Schema, Stream } from "effect";
import { IdGenerator, LanguageModel, Prompt } from "effect/ai";
import type { Response, Tool, Toolkit } from "effect/ai";
import type { RunFinishedOutcome } from "@ag-ui/core";
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
  /** Maximum number of model steps per run, a positive integer. Defaults to 10. */
  readonly maxSteps?: number | undefined;
  /** What to do with client-sent `system`/`developer` messages. See {@link Messages.ToPromptOptions}. */
  readonly clientSystem?: Messages.ToPromptOptions["clientSystem"];
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
 *
 * Interrupting the stream (the consumer stops reading) cancels the run without
 * a terminal event, since nothing can be emitted once it is interrupted. A
 * caller that stops runs on its own (a deadline, shutdown) should do so
 * in-band, e.g. by failing a tool or the model call, so the client still
 * receives `RUN_ERROR`.
 *
 * `RUN_ERROR.message` carries the underlying error's message, which may include
 * provider details; callers serving untrusted clients can rewrite it by mapping
 * the stream. `RUN_ERROR.code` is the error's tag.
 */
export const run = <Tools extends Record<string, Tool.Any>>(options: AgentOptions<Tools>) => {
  const maxSteps = options.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`maxSteps must be a positive integer, got ${maxSteps}`);
  }
  return (input: AgUi.RunAgentInput): Stream.Stream<AgUi.Event, never, Requirements<Tools>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ids = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
          Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator)),
        );
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
                  // The toolkit's own part type is narrower than both of these,
                  // which only widen the tool names and parameter types.
                  parts.push(part as Response.AnyPart);
                  return handlePart(state, part as Response.StreamPart<Record<string, Tool.Any>>, ids);
                }),
                Stream.flattenIterable,
              );

              const next = Stream.suspend(() => {
                const closing = Stream.fromIterable(state.close());
                // Continue only when every call made in this step was answered.
                // An unanswered call ends the run and is reported as pending.
                return state.finishReason === "tool-calls" && state.unanswered().length === 0
                  ? Stream.concat(closing, step(Prompt.concat(prompt, Prompt.fromResponseParts(parts)), index + 1))
                  : closing;
              });

              return Stream.concat(events, next);
            }),
          );

        const prompt = Messages.toPrompt(input.messages, {
          system: options.system,
          clientSystem: options.clientSystem,
        });

        return Stream.make(AgUi.runStarted(input)).pipe(
          Stream.concat(step(prompt, 1)),
          Stream.concat(Stream.sync(() => AgUi.runFinished(input, outcomeOf(current)))),
          Stream.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              // An interrupt-only cause has no failures, so its error type is irrelevant.
              return Stream.failCause(cause as Cause.Cause<never>);
            }
            const error = Cause.squash(cause);
            return Stream.fromIterable([
              ...(current?.close() ?? []),
              AgUi.runError(errorMessage(error), errorCode(error)),
            ]);
          }),
          Stream.withSpan("effentic/Agent.run", { attributes: { threadId: input.threadId, runId: input.runId } }),
        );
      }),
    );
};

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
  readonly answeredTools = new Set<string>();
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

  /** Tool calls made in this step that got no result. */
  unanswered(): Array<string> {
    return [...this.seenTools].filter((id) => !this.answeredTools.has(id));
  }
}

const outcomeOf = (state: StepState | undefined): RunFinishedOutcome => {
  const pending = state?.unanswered() ?? [];
  return pending.length > 0 ? { type: "success", pendingToolCallIds: pending } : { type: "success" };
};

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
      state.answeredTools.add(part.id);
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

const errorMessage = (error: unknown): string => {
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }
  return Predicate.isString(error) ? error : "Unknown error";
};

/** The error's tag; for an `AiError`, the tag of its reason (e.g. `RateLimitError`). */
const errorCode = (error: unknown): string | undefined =>
  (Predicate.hasProperty(error, "reason") ? tagOf(error.reason) : undefined) ?? tagOf(error);

const tagOf = (value: unknown): string | undefined =>
  Predicate.hasProperty(value, "_tag") && Predicate.isString(value._tag) ? value._tag : undefined;
