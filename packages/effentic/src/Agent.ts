import { Cause, Effect, Option, Predicate, Queue, Schema, Stream } from "effect";
import { IdGenerator, LanguageModel, Prompt } from "effect/ai";
import type { Response, Tool, Toolkit } from "effect/ai";
import * as Checkpoint from "./Checkpoint.ts";
import type * as Thread from "./Thread.ts";

// -----------------------------------------------------------------------------
// Definition
// -----------------------------------------------------------------------------

/**
 * An agent's behaviour: what it can do and how far it may go. It names no
 * model provider and no durability mechanism, so the same value runs in
 * production and in an eval by providing different services.
 */
export interface Agent<Tools extends Record<string, Tool.Any>> {
  /**
   * Server-side tools, run by the loop between model steps. Use
   * `failureMode: "return"` on tools whose failures should go back to the
   * model, and `needsApproval` on tools that must not run without the user.
   */
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /** System prompt placed before the conversation. */
  readonly system: string | undefined;
  /** Maximum number of model steps per run. */
  readonly maxSteps: number;
}

/** Defines an agent. Throws a `RangeError` if `maxSteps` (default 10) is not a positive integer. */
export const define = <Tools extends Record<string, Tool.Any>>(options: {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  readonly system?: string | undefined;
  readonly maxSteps?: number | undefined;
}): Agent<Tools> => {
  const maxSteps = options.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`maxSteps must be a positive integer, got ${maxSteps}`);
  }
  return { toolkit: options.toolkit, system: options.system, maxSteps };
};

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

export interface RunInput {
  readonly runId: string;
  readonly prompt: Prompt.Prompt;
}

/**
 * What a run emits. Events derived from a checkpoint served from the store
 * rather than executed carry `replayed: true`; a replayed model step emits no
 * `ModelPart`s.
 */
export type Event =
  | { readonly _tag: "StepStarted"; readonly step: number; readonly messageId: string; readonly replayed: boolean }
  | {
      readonly _tag: "ModelPart";
      readonly step: number;
      readonly messageId: string;
      readonly part: Response.AnyPart;
      readonly replayed: false;
    }
  | {
      readonly _tag: "ToolResult";
      readonly step: number;
      readonly messageId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly encodedResult: unknown;
      readonly isFailure: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly _tag: "ApprovalRequested";
      readonly step: number;
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly replayed: boolean;
    }
  | {
      readonly _tag: "StepFinished";
      readonly step: number;
      /** The thread entries this step produced, to be committed. */
      readonly entries: ReadonlyArray<Thread.Entry>;
      readonly replayed: boolean;
    }
  | { readonly _tag: "Finished"; readonly outcome: Outcome }
  | { readonly _tag: "Failed"; readonly error: unknown; readonly code: string | undefined };

export interface Approval {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export type Outcome =
  | { readonly _tag: "Success" }
  /** The run stopped because these tool calls wait for the user's approval. */
  | { readonly _tag: "Interrupted"; readonly approvals: ReadonlyArray<Approval> };

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
  | Checkpoint.Checkpoint
  | Tool.HandlersFor<Tools>
  | Tool.HandlerServices<Tools[keyof Tools]>
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>
  | Tool.ResultDecodingServices<Tools[keyof Tools]>;

/** What a model step stores in its checkpoint. */
const ModelStep = Schema.Struct({
  messageId: Schema.String,
  /** The step's output as prompt messages, built from the streamed parts. */
  assistant: Prompt.Prompt,
  /** Calls for the loop to execute, with parameters in encoded form. */
  toolCalls: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, params: Schema.Unknown })),
  finishReason: Schema.String,
});
type ModelStep = typeof ModelStep.Type;
type ToolCall = ModelStep["toolCalls"][number];

/** What a tool call stores in its checkpoint. */
const ToolStep = Schema.Union([
  Schema.TaggedStruct("Result", {
    messageId: Schema.String,
    encodedResult: Schema.Unknown,
    isFailure: Schema.Boolean,
  }),
  Schema.TaggedStruct("ApprovalRequested", { approvalId: Schema.String }),
]);
type ToolStep = typeof ToolStep.Type;

/** A user's answer to an approval request, found in the prompt. */
interface Decision {
  readonly approved: boolean;
  readonly reason: string;
}

/**
 * Runs the agent on a prompt: model steps, with the tool calls of each step
 * executed after the model call, until the model stops calling tools, a tool
 * needs approval, or the step limit is reached.
 *
 * Every model call and every tool call is memoised through the
 * {@link Checkpoint.Checkpoint} in context, under `model:<step>` and
 * `tool:<toolCallId>`, so a run executed again with the same `runId` against a
 * durable store replays completed work instead of repeating it.
 *
 * The stream never fails. It ends with exactly one `Finished` or `Failed`
 * event. Interrupting it (the consumer stops reading) cancels the run, and
 * nothing more is emitted.
 */
export const run =
  <Tools extends Record<string, Tool.Any>>(agent: Agent<Tools>) =>
  (input: RunInput): Stream.Stream<Event, never, Requirements<Tools>> =>
    Stream.callback<Event, never, Requirements<Tools>>((queue) => {
      const emit = (event: Event) => Queue.offer(queue, event);
      return Effect.gen(function* () {
        const checkpoint = yield* Checkpoint.Checkpoint;
        const toolkit = yield* agent.toolkit;
        const ids = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
          Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator)),
        );
        // A failing step is stored as a defect: the run reports it as `Failed`, so its type does not matter.
        const memoTool = <E>(name: string, body: Effect.Effect<ToolStep, E, Requirements<Tools>>) =>
          checkpoint.memo({ runId: input.runId, name, success: ToolStep, error: Schema.Never }, Effect.orDie(body));

        const result = (encodedResult: unknown, isFailure: boolean) =>
          Effect.map(ids.generateId(), (messageId): ToolStep => ({
            _tag: "Result",
            messageId,
            encodedResult,
            isFailure,
          }));

        // Runs the handler, unless the call needs approval and no decision was made yet.
        const executeTool = (call: ToolCall, prompt: Prompt.Prompt, decision: Decision | undefined) =>
          memoTool(
            `tool:${call.id}`,
            Effect.gen(function* () {
              if (decision === undefined) {
                const needed = yield* approvalNeeded(toolkit.tools[call.name], call, prompt);
                if (needed) {
                  return { _tag: "ApprovalRequested", approvalId: yield* ids.generateId() } as const;
                }
              } else if (!decision.approved) {
                return yield* result({ type: "execution-denied", reason: decision.reason }, true);
              }
              const results = yield* toolkit.handle(call.name, call.params as never, call.id);
              const final = yield* Stream.runLast(Stream.filter(results, (r) => !r.preliminary));
              if (Option.isNone(final)) {
                return yield* Effect.die("Tool handler did not produce a final result");
              }
              return yield* result(final.value.encodedResult, final.value.isFailure);
            }),
          );

        // The model stopped for a reason that does not complete the response.
        const interruptTool = (call: ToolCall, finishReason: string) =>
          memoTool(
            `tool:${call.id}`,
            result(
              {
                type: "execution-interrupted",
                reason: `Tool call execution was interrupted because the response finished with reason "${finishReason}"`,
              },
              true,
            ),
          );

        const toolEntry = (call: ToolCall, step: Extract<ToolStep, { _tag: "Result" }>): Thread.Entry => ({
          id: step.messageId,
          message: Prompt.makeMessage("tool", {
            content: [
              Prompt.makePart("tool-result", {
                id: call.id,
                name: call.name,
                result: step.encodedResult,
                isFailure: step.isFailure,
                providerExecuted: false,
              }),
            ],
          }),
        });

        const modelStep = (step: number, prompt: Prompt.Prompt) =>
          checkpoint.memo(
            { runId: input.runId, name: `model:${step}`, success: ModelStep, error: Schema.Never },
            Effect.gen(function* () {
              const messageId = yield* ids.generateId();
              yield* emit({ _tag: "StepStarted", step, messageId, replayed: false });
              const parts: Array<Response.AnyPart> = [];
              yield* LanguageModel.streamText({
                prompt: stripApprovals(prompt),
                toolkit: agent.toolkit,
                disableToolCallResolution: true,
              }).pipe(
                Stream.runForEach((streamed) => {
                  // The toolkit's own part type is narrower; this only widens tool names and parameters.
                  const part = streamed as Response.AnyPart;
                  if (part.type === "error") {
                    return Effect.fail(new ModelStreamError({ error: part.error }));
                  }
                  parts.push(part);
                  return emit({ _tag: "ModelPart", step, messageId, part, replayed: false });
                }),
              );
              const finish = parts.find((part) => part.type === "finish");
              return {
                messageId,
                assistant: Prompt.fromResponseParts(parts),
                toolCalls: parts.flatMap((part) =>
                  part.type === "tool-call" && part.providerExecuted !== true
                    ? [{ id: part.id, name: part.name, params: part.params }]
                    : [],
                ),
                finishReason: finish?.type === "finish" ? finish.reason : "unknown",
              } satisfies ModelStep;
            }).pipe(Effect.orDie),
          );

        // Step 0: approval answers carried by the prompt are resolved before the model is called.
        let prompt = input.prompt;
        const decided = pendingDecisions(prompt);
        if (decided.length > 0) {
          const steps = yield* Effect.forEach(decided, ({ call, decision }) => executeTool(call, prompt, decision), {
            concurrency: "unbounded",
          });
          const entries: Array<Thread.Entry> = [];
          for (const [i, { call }] of decided.entries()) {
            const { value, replayed } = steps[i]!;
            // A decision always yields a result.
            if (value._tag === "Result") {
              entries.push(toolEntry(call, value));
              yield* emit(toolResultEvent(0, call, value, replayed));
            }
          }
          yield* emit({ _tag: "StepFinished", step: 0, entries, replayed: steps.every((s) => s.replayed) });
          // The prompt may continue past the calls (e.g. a new user message), so place the results right after them.
          prompt = orderToolResults(Prompt.concat(prompt, Prompt.fromMessages(entries.map((entry) => entry.message))));
        }

        for (let step = 1; ; step++) {
          const model = yield* modelStep(step, prompt);
          const { messageId, assistant, toolCalls, finishReason } = model.value;
          if (model.replayed) {
            yield* emit({ _tag: "StepStarted", step, messageId, replayed: true });
          }

          const complete = finishReason === "tool-calls" || finishReason === "stop";
          const modelPrompt = stripApprovals(prompt);
          const tools = yield* Effect.forEach(
            toolCalls,
            (call) => (complete ? executeTool(call, modelPrompt, undefined) : interruptTool(call, finishReason)),
            { concurrency: "unbounded" },
          );

          const approvals: Array<Approval> = [];
          const toolEntries: Array<Thread.Entry> = [];
          for (const [i, call] of toolCalls.entries()) {
            const { value, replayed } = tools[i]!;
            if (value._tag === "ApprovalRequested") {
              approvals.push({ approvalId: value.approvalId, toolCallId: call.id, toolName: call.name });
              yield* emit({
                _tag: "ApprovalRequested",
                step,
                approvalId: value.approvalId,
                toolCallId: call.id,
                toolName: call.name,
                replayed,
              });
            } else {
              toolEntries.push(toolEntry(call, value));
              yield* emit(toolResultEvent(step, call, value, replayed));
            }
          }

          const assistantMessage = assistant.content.find((message) => message.role === "assistant");
          const entries: Array<Thread.Entry> = [];
          if (assistantMessage !== undefined) {
            entries.push({
              id: messageId,
              message: Prompt.makeMessage("assistant", {
                content: [
                  ...assistantMessage.content,
                  ...approvals.map((a) =>
                    Prompt.toolApprovalRequestPart({ approvalId: a.approvalId, toolCallId: a.toolCallId }),
                  ),
                ],
                options: assistantMessage.options,
              }),
            });
          }
          entries.push(...toolEntries);
          yield* emit({
            _tag: "StepFinished",
            step,
            entries,
            replayed: model.replayed && tools.every((t) => t.replayed),
          });

          if (approvals.length > 0) {
            return yield* emit({ _tag: "Finished", outcome: { _tag: "Interrupted", approvals } });
          }
          if (finishReason !== "tool-calls" || toolCalls.length === 0) {
            return yield* emit({ _tag: "Finished", outcome: { _tag: "Success" } });
          }
          if (step + 1 > agent.maxSteps) {
            return yield* new StepLimitExceeded({ maxSteps: agent.maxSteps });
          }
          prompt = Prompt.concat(prompt, Prompt.fromMessages(entries.map((entry) => entry.message)));
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            // An interrupt-only cause has no failures, so its error type is irrelevant.
            return Queue.failCause(queue, cause as Cause.Cause<never>);
          }
          const error = Cause.squash(cause);
          return emit({ _tag: "Failed", error, code: errorCode(error) });
        }),
        Effect.andThen(Queue.end(queue)),
        Effect.withSpan("effentic/Agent.run", { attributes: { runId: input.runId } }),
      );
    });

const toolResultEvent = (
  step: number,
  call: ToolCall,
  result: Extract<ToolStep, { _tag: "Result" }>,
  replayed: boolean,
): Event => ({
  _tag: "ToolResult",
  step,
  messageId: result.messageId,
  toolCallId: call.id,
  toolName: call.name,
  encodedResult: result.encodedResult,
  isFailure: result.isFailure,
  replayed,
});

// -----------------------------------------------------------------------------
// Approvals
// -----------------------------------------------------------------------------

/**
 * Evaluates a tool's `needsApproval` as Effect does: a predicate gets the
 * decoded parameters, and a predicate that fails or throws means no approval.
 */
const approvalNeeded = (tool: Tool.Any | undefined, call: ToolCall, prompt: Prompt.Prompt): Effect.Effect<boolean> => {
  const needsApproval = tool?.needsApproval;
  if (tool === undefined || needsApproval === undefined || typeof needsApproval === "boolean") {
    return Effect.succeed(needsApproval === true);
  }
  return Effect.gen(function* () {
    const params = yield* Schema.decodeUnknownEffect(tool.parametersSchema as Schema.Codec<unknown, unknown>)(
      call.params,
    );
    const needed = yield* Effect.try(() => needsApproval(params, { toolCallId: call.id, messages: prompt.content }));
    return Effect.isEffect(needed) ? yield* needed : needed;
  }).pipe(Effect.orElseSucceed(() => false));
};

/**
 * Approval responses in the prompt whose tool call has no result yet, with the
 * call they decide. Mirrors Effect's own `collectToolApprovals`.
 */
const pendingDecisions = (prompt: Prompt.Prompt): Array<{ readonly call: ToolCall; readonly decision: Decision }> => {
  const requests = new Map<string, string>();
  const calls = new Map<string, ToolCall>();
  const answered = new Set<string>();
  const responses: Array<Prompt.ToolApprovalResponsePart> = [];
  for (const message of prompt.content) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-approval-request") {
          requests.set(part.approvalId, part.toolCallId);
        } else if (part.type === "tool-call") {
          calls.set(part.id, { id: part.id, name: part.name, params: part.params });
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-approval-response") {
          responses.push(part);
        } else if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    }
  }
  return responses.flatMap((response) => {
    const toolCallId = requests.get(response.approvalId);
    const call = toolCallId === undefined ? undefined : calls.get(toolCallId);
    if (call === undefined || answered.has(call.id)) {
      return [];
    }
    answered.add(call.id);
    return [{ call, decision: { approved: response.approved, reason: response.reason ?? "denied" } }];
  });
};

/**
 * Moves every tool result and approval response to directly after the
 * assistant message holding its tool call, one tool message per call. Providers
 * require a call's result to follow it, but a result can be committed after
 * later messages: an approval answered in a run that also brings a new user
 * message. Parts whose call is not in the prompt stay where they are.
 */
export const orderToolResults = (prompt: Prompt.Prompt): Prompt.Prompt => {
  const callIds = new Set<string>();
  const callOfApproval = new Map<string, string>();
  for (const message of prompt.content) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && !part.providerExecuted) {
          callIds.add(part.id);
        } else if (part.type === "tool-approval-request") {
          callOfApproval.set(part.approvalId, part.toolCallId);
        }
      }
    }
  }
  const callOf = (part: Prompt.ToolMessagePart) =>
    part.type === "tool-result" ? part.id : callOfApproval.get(part.approvalId);

  const byCall = new Map<string, Array<Prompt.ToolMessagePart>>();
  for (const message of prompt.content) {
    if (message.role === "tool") {
      for (const part of message.content) {
        const id = callOf(part);
        if (id !== undefined && callIds.has(id)) {
          byCall.set(id, [...(byCall.get(id) ?? []), part]);
        }
      }
    }
  }

  const messages: Array<Prompt.Message> = [];
  for (const message of prompt.content) {
    if (message.role === "tool") {
      const content = message.content.filter((part) => {
        const id = callOf(part);
        return id === undefined || !callIds.has(id);
      });
      if (content.length > 0) {
        messages.push(Prompt.makeMessage("tool", { content, options: message.options }));
      }
      continue;
    }
    messages.push(message);
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool-call") {
          continue;
        }
        const parts = byCall.get(part.id);
        if (parts !== undefined) {
          messages.push(Prompt.makeMessage("tool", { content: parts }));
          byCall.delete(part.id);
        }
      }
    }
  }
  return Prompt.fromMessages(messages);
};

/**
 * Removes approval requests and responses, which providers reject, and drops
 * messages left empty. By the time the model is called every approval in the
 * prompt has been resolved.
 */
export const stripApprovals = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.flatMap((message): Array<Prompt.Message> => {
      switch (message.role) {
        case "assistant": {
          const content = message.content.filter((part) => part.type !== "tool-approval-request");
          return content.length === 0 ? [] : [Prompt.makeMessage("assistant", { content, options: message.options })];
        }
        case "tool": {
          const content = message.content.filter((part) => part.type !== "tool-approval-response");
          return content.length === 0 ? [] : [Prompt.makeMessage("tool", { content, options: message.options })];
        }
        default:
          return [message];
      }
    }),
  );

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** A human-readable message for a `Failed` event's error. */
export const errorMessage = (error: unknown): string => {
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return error.message;
  }
  return Predicate.isString(error) ? error : "Unknown error";
};

/** The error's tag; for an `AiError`, the tag of its reason (e.g. `RateLimitError`). */
export const errorCode = (error: unknown): string | undefined =>
  (Predicate.hasProperty(error, "reason") ? tagOf(error.reason) : undefined) ?? tagOf(error);

const tagOf = (value: unknown): string | undefined =>
  Predicate.hasProperty(value, "_tag") && Predicate.isString(value._tag) ? value._tag : undefined;
