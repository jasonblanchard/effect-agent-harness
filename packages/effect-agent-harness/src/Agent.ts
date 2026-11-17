import { Cause, Context, Effect, Option, Predicate, Queue, Result, Schema, Stream } from "effect";
import { IdGenerator, LanguageModel, Prompt, Telemetry as AiTelemetry, Tool } from "effect/ai";
import type { Response, Toolkit } from "effect/ai";
import type { JsonSchema } from "effect";
import * as Checkpoint from "./Checkpoint.ts";
import * as internalTelemetry from "./internal/telemetry.ts";
import type * as Messages from "./Messages.ts";
import * as Telemetry from "./Telemetry.ts";

const { Attr } = internalTelemetry;

// -----------------------------------------------------------------------------
// Definition
// -----------------------------------------------------------------------------

/**
 * An agent's behaviour: what it can do and how far it may go. It names no
 * model provider and no durability mechanism, so the same value runs in
 * production and in an eval by providing different services. `R` is what its
 * system prompt needs.
 */
export interface Agent<Tools extends Record<string, Tool.Any>, R = never> {
  /**
   * Server-side tools, run by the loop between model steps. Use
   * `failureMode: "return"` on tools whose failures should go back to the
   * model, and `needsApproval` on tools that must not run without the user.
   */
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /**
   * System prompt placed before the conversation: fixed text, or an effect
   * resolved once per run (memoised as the `system` checkpoint). The effect
   * may read {@link CurrentRun} and the services `R`.
   */
  readonly system: string | Effect.Effect<string, never, R> | undefined;
  /** Maximum number of model steps per run. */
  readonly maxSteps: number;
  /**
   * Identifies the agent in telemetry (`gen_ai.agent.name` and the name of a
   * run's root span). Never sent to the agent's own model. When the agent is a
   * subagent, it is also the tool name its parent's model calls and its name in
   * the parent's events.
   */
  readonly name: string | undefined;
  /** What the agent is for: the subagent tool's description, and `gen_ai.agent.description`. */
  readonly description: string | undefined;
  /**
   * As a subagent, the parameters its parent's model calls it with. Without
   * one, it takes `{ prompt: string }`. Must need no services to decode.
   */
  readonly input: Schema.Top | undefined;
  /** As a subagent, what its prompt starts from (see {@link ContextMode}). */
  readonly context: ContextMode;
  /**
   * As a subagent, the value its parent receives as the call's result when it
   * finishes. Without one, its last assistant text. A value that isn't JSON
   * gives the parent a failed result.
   */
  readonly result: ((reply: SubagentReply) => unknown) | undefined;
  /** Agents this agent may delegate to, each offered to its model as a tool named after the agent. */
  readonly subagents: Subagents | undefined;
}

/** An agent of any tools and requirements, as a list of subagents holds it. */
// `Toolkit` is invariant in its tools, so only `any` admits every agent.
export type Any = Agent<any, any>;

/** The subagents of an agent, and room for settings that apply to all of them. */
export interface Subagents {
  readonly agents: ReadonlyArray<Any>;
}

/**
 * What a subagent's prompt starts from: `brief`, the call's input alone; or
 * `conversation`, the user's messages and the assistant's text from the
 * prompt its parent's model received for the step that made the call,
 * followed by the input. Tool calls and results are left out: they name
 * tools the child may not have.
 */
export type ContextMode = "brief" | "conversation";

/** What a subagent's `result` receives when it finishes. */
export interface SubagentReply {
  /** The text of its last assistant message. */
  readonly text: string;
  /** The call's decoded input. */
  readonly input: unknown;
}

/** What running the agents in a list of subagents requires. */
export type SubagentRequirements<Agents extends ReadonlyArray<Any>> = Agents[number] extends infer A
  ? A extends Agent<infer T, infer CR>
    ? Requirements<T, CR>
    : never
  : never;

/** A name a model provider accepts for a tool. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A subagent's parameters when it declares no `input`. */
const PromptInput = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task to delegate, with everything needed to do it." }),
});

/**
 * Defines an agent. Throws a `RangeError` if `maxSteps` (default 10) is not a
 * positive integer, or if a subagent has no name, has a name that is not 1 to
 * 64 letters, digits, `_` or `-`, or has the name of a tool or of another
 * subagent. What the subagents require is part of what the agent requires.
 */
export const define = <
  Tools extends Record<string, Tool.Any>,
  R = never,
  const Agents extends ReadonlyArray<Any> = readonly [],
>(options: {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  readonly system?: string | Effect.Effect<string, never, R> | undefined;
  readonly maxSteps?: number | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly input?: Schema.Top | undefined;
  readonly context?: ContextMode | undefined;
  readonly result?: ((reply: SubagentReply) => unknown) | undefined;
  readonly subagents?: { readonly agents: Agents } | undefined;
}): Agent<Tools, R | SubagentRequirements<Agents>> => {
  const maxSteps = options.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new RangeError(`maxSteps must be a positive integer, got ${maxSteps}`);
  }
  const names = new Set<string>();
  for (const child of options.subagents?.agents ?? []) {
    if (child.name === undefined) {
      throw new RangeError("A subagent must have a name");
    }
    if (!TOOL_NAME.test(child.name)) {
      throw new RangeError(
        `A subagent's name must be 1 to 64 letters, digits, "_" or "-", got ${JSON.stringify(child.name)}`,
      );
    }
    if (Object.hasOwn(options.toolkit.tools, child.name) || names.has(child.name)) {
      throw new RangeError(`The subagent name ${JSON.stringify(child.name)} is already used by a tool or a subagent`);
    }
    names.add(child.name);
  }
  return {
    toolkit: options.toolkit,
    system: options.system,
    maxSteps,
    name: options.name,
    description: options.description,
    input: options.input,
    context: options.context ?? "brief",
    result: options.result,
    subagents: options.subagents,
  };
};

// -----------------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------------

/**
 * Which run is executing, as the system prompt and tool handlers see it
 * through {@link CurrentRun}. Trusted per-run data, such as the verified
 * principal, is not here: the agent requires it as an ordinary service, which
 * a runner builds per run from its declared `Runner.RunContext`s.
 */
export interface RunInfo {
  readonly runId: string;
  readonly threadId: string;
  /** Set by the client (AG-UI `forwardedProps`), so untrusted: choose between known values, don't interpolate. */
  readonly props?: unknown;
}

export interface RunInput extends RunInfo {
  /** The conversation, without the agent's system prompt: the run adds it. */
  readonly prompt: Prompt.Prompt;
  /**
   * Tools the client runs itself (AG-UI frontend tools), offered to the model
   * next to the agent's own. A call to one is left pending for the client to
   * answer in a later run. Set by the client, so untrusted.
   */
  readonly frontendTools?: ReadonlyArray<FrontendTool> | undefined;
  /**
   * The prompts of the suspended subagents in the history, at any depth, by
   * `subagentRunId` (see `Messages.projectSuspended`). A suspended subagent
   * call is resumed from its prompt here; one without is answered with a
   * failed result.
   */
  readonly subagentPrompts?: Readonly<Record<string, Prompt.Prompt>> | undefined;
}

/** A tool the client advertised and runs itself. */
export interface FrontendTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** A JSON Schema for the call's arguments, sent to the model as given. */
  readonly parameters: unknown;
}

/**
 * The run in progress. `run` provides it, so a system prompt effect can read
 * it, and so can a tool handler whose tool declares
 * `dependencies: [Agent.CurrentRun]`. Never provide it yourself.
 */
export class CurrentRun extends Context.Service<CurrentRun, RunInfo>()("effect-agent-harness/Agent/CurrentRun") {}

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
      readonly entries: ReadonlyArray<Messages.Entry>;
      readonly replayed: boolean;
    }
  | { readonly _tag: "Finished"; readonly outcome: Outcome }
  | { readonly _tag: "Failed"; readonly error: unknown; readonly code: string | undefined }
  /**
   * An event of a subagent the run is running, as that subagent's own run
   * emitted it. A subagent's subagents arrive wrapped once more. Every child
   * run ends with its own `Finished` or `Failed`, which ends only the child.
   */
  | {
      readonly _tag: "Subagent";
      readonly subagentRunId: string;
      readonly name: string;
      readonly description: string | undefined;
      /** The call that spawned the subagent. */
      readonly parentToolCallId: string;
      /** The message id of the step holding that call. */
      readonly parentMessageId: string;
      readonly event: Event;
    };

export interface Approval {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** The subagent whose call waits for approval; absent for the agent's own calls. */
  readonly subagentRunId?: string | undefined;
}

/** A call to a frontend tool, left for the client to run and answer. */
export interface PendingToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Both outcomes list the frontend calls the run left pending, in call order. */
export type Outcome =
  | { readonly _tag: "Success"; readonly pendingToolCalls: ReadonlyArray<PendingToolCall> }
  /** The run stopped because these tool calls wait for the user's approval. */
  | {
      readonly _tag: "Interrupted";
      readonly approvals: ReadonlyArray<Approval>;
      readonly pendingToolCalls: ReadonlyArray<PendingToolCall>;
    };

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

/** Everything a run touches, including what `run` provides itself. */
type RunServices<Tools extends Record<string, Tool.Any>, R> =
  | LanguageModel.LanguageModel
  | Checkpoint.Checkpoint
  | Tool.HandlersFor<Tools>
  | Tool.HandlerServices<Tools[keyof Tools]>
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>
  | Tool.ResultDecodingServices<Tools[keyof Tools]>
  | R;

/** What a caller provides to run an agent whose system prompt needs `R`. */
export type Requirements<Tools extends Record<string, Tool.Any>, R = never> = Exclude<
  RunServices<Tools, R>,
  CurrentRun
>;

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
  /** A subagent call whose child waits for these approvals, its own or its descendants'. */
  Schema.TaggedStruct("Suspended", {
    approvals: Schema.Array(
      Schema.Struct({
        approvalId: Schema.String,
        toolCallId: Schema.String,
        toolName: Schema.String,
        subagentRunId: Schema.optional(Schema.String),
      }),
    ),
  }),
]);
type ToolStep = typeof ToolStep.Type;

/** A tool call's step, with the entries of the subagent it ran, if any. */
type ToolOutcome = Checkpoint.Memoized<ToolStep> & { readonly entries: ReadonlyArray<Messages.Entry> };

/** Result sent to the model for a suspended subagent call whose child can't be resumed from the history. */
const INCOMPLETE_SUBAGENT_RESULT = "The subagent did not complete and could not be resumed";

/**
 * Internal: carries a failed tool result out of its `execute_tool` span, so the span ends with an error
 * status. It's caught just outside the span and never escapes `Agent.run`.
 */
class ToolResultFailure extends Schema.TaggedError<ToolResultFailure, { readonly brand: unique symbol }>()(
  "ToolResultFailure",
  { step: ToolStep },
) {}

/**
 * Internal: carries a subagent's failure out of its `invoke_agent` span, so the span ends with an error
 * status. It's caught just outside the span and never escapes `Agent.run`.
 */
class SubagentFailure extends Schema.TaggedError<SubagentFailure, { readonly brand: unique symbol }>()(
  "SubagentFailure",
  { error: Schema.Unknown },
) {}

/**
 * The id of the approval request for a tool call, and of the AG-UI interrupt
 * carrying it. Derived from the call, so a client's history alone links an
 * interrupt to its call. Treat it as opaque.
 */
export const approvalIdFor = (toolCallId: string): string => `approval:${toolCallId}`;

/** A user's answer to an approval request, found in the prompt. */
interface Decision {
  readonly approved: boolean;
  readonly reason: string;
}

/**
 * Runs the agent on a prompt: model steps, with the tool calls of each step
 * executed after the model call, until the model stops calling tools, a tool
 * needs approval, the model calls a frontend tool, or the step limit is
 * reached. A frontend call gets no result: the step's assistant entry marks it
 * as the client's (see {@link isFrontendCall}) and the outcome lists it. Every model call starts with
 * the agent's system prompt, resolved once before anything else runs. The
 * run's info is available as {@link CurrentRun} throughout.
 *
 * Every model call and every tool call is memoised through the
 * {@link Checkpoint.Checkpoint} in context, under `model:<step>` and
 * `tool:<toolCallId>`, so a run executed again with the same `threadId` and `runId` against a
 * durable store replays completed work instead of repeating it.
 *
 * The stream never fails. It ends with exactly one `Finished` or `Failed`
 * event. Interrupting it (the consumer stops reading) cancels the run, and
 * nothing more is emitted.
 */
export const run = <Tools extends Record<string, Tool.Any>, R>(
  agent: Agent<Tools, R>,
  input: RunInput,
): Stream.Stream<Event, never, Requirements<Tools, R>> =>
  Stream.callback<Event, never, Requirements<Tools, R>>((queue) => {
    const emit = (event: Event) => Queue.offer(queue, event);
    const { prompt: _, frontendTools = [], subagentPrompts, ...info } = input;
    return Effect.gen(function* () {
      const checkpoint = yield* Checkpoint.Checkpoint;
      const toolkit = yield* agent.toolkit;
      // `define` checked that every subagent has a name.
      const subagents = new Map((agent.subagents?.agents ?? []).map((child) => [child.name ?? "", child]));
      // The model is offered the agent's tools and subagents plus the client's. The agent's own win a name clash.
      const frontend = new Map<string, Tool.Any>();
      for (const tool of frontendTools) {
        if (Object.hasOwn(toolkit.tools, tool.name) || subagents.has(tool.name)) {
          yield* Effect.logWarning(
            "effect-agent-harness: frontend tool ignored, a server tool has its name",
            tool.name,
          );
        } else if (!frontend.has(tool.name)) {
          frontend.set(
            tool.name,
            Tool.dynamic(tool.name, {
              description: tool.description,
              parameters: tool.parameters as JsonSchema.JsonSchema,
            }),
          );
        }
      }
      // Typed as the agent's toolkit: frontend and subagent tools have no handlers and need no services, and
      // since tool calls are not resolved by the model call, `handle` is never called for one.
      const modelToolkit = {
        tools: {
          ...toolkit.tools,
          ...Object.fromEntries(
            [...subagents].map(([name, child]) => [
              name,
              Tool.dynamic(name, { description: child.description, parameters: child.input ?? PromptInput }),
            ]),
          ),
          ...Object.fromEntries(frontend),
        },
        handle: toolkit.handle,
      } as Toolkit.WithHandler<Tools>;
      const ids = yield* Effect.serviceOption(IdGenerator.IdGenerator).pipe(
        Effect.map(Option.getOrElse(() => IdGenerator.defaultIdGenerator)),
      );

      // Telemetry: the attributes every span this run creates or annotates carries.
      const capture = yield* Telemetry.ContentCapture;
      const runAttributes = {
        ...internalTelemetry.callerAttributes(yield* Telemetry.SpanAttributes),
        [Attr.conversationId]: input.threadId,
      };
      const outerTransformer = yield* Effect.serviceOption(AiTelemetry.CurrentSpanTransformer);
      // Reaches only the model call's own span, unlike span annotations, which would also reach the
      // provider's HTTP spans. Runs any transformer the caller provided first. One provided only when
      // the LanguageModel layer was built can't be seen here, so it's replaced (see the README).
      const modelSpanTransformer: AiTelemetry.SpanTransformer = (options) => {
        if (Option.isSome(outerTransformer)) {
          outerTransformer.value(options);
        }
        annotateModelSpan(options, runAttributes, capture);
      };
      // A failing step is stored as a defect: the run reports it as `Failed`, so its type does not matter.
      const memoTool = <E>(name: string, body: Effect.Effect<ToolStep, E, RunServices<Tools, R>>) =>
        checkpoint.memo(
          { threadId: input.threadId, runId: input.runId, name, success: ToolStep, error: Schema.Never },
          Effect.orDie(body),
        );

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
                return { _tag: "ApprovalRequested", approvalId: approvalIdFor(call.id) } as const;
              }
            } else if (!decision.approved) {
              return yield* result({ type: "execution-denied", reason: decision.reason }, true);
            }
            return yield* handleTool(call);
          }),
        );

      // Only an executed handler is traced: a replayed, denied, interrupted or pending call has no span.
      const handleTool = (call: ToolCall) =>
        Effect.gen(function* () {
          const results = yield* toolkit.handle(call.name, call.params as never, call.id);
          const final = yield* Stream.runLast(Stream.filter(results, (r) => !r.preliminary));
          if (Option.isNone(final)) {
            return yield* Effect.die("Tool handler did not produce a final result");
          }
          const { encodedResult, isFailure } = final.value;
          yield* Effect.annotateCurrentSpan({
            ...(isFailure ? { [Attr.errorType]: internalTelemetry.toolFailure } : {}),
            // Also on a failure, unlike the conventions' description: it's what the model was given, and the
            // most useful thing to see when a call fails.
            ...(capture ? internalTelemetry.jsonAttribute(Attr.toolCallResult, encodedResult) : {}),
          });
          const step = yield* result(encodedResult, isFailure);
          // A failure result fails the span's effect, so the span ends with an error status as the conventions
          // require. It's turned back into a result just outside the span, so the run sees no difference.
          return isFailure ? yield* new ToolResultFailure({ step }) : step;
        }).pipe(
          Effect.withSpan(internalTelemetry.toolSpanName(call.name), {
            kind: "internal",
            attributes: {
              ...runAttributes,
              [Attr.operationName]: "execute_tool",
              [Attr.toolName]: call.name,
              [Attr.toolCallId]: call.id,
              [Attr.toolType]: "function",
              ...(agent.name === undefined ? {} : { [Attr.agentName]: agent.name }),
              ...(toolkit.tools[call.name]?.description === undefined
                ? {}
                : { [Attr.toolDescription]: toolkit.tools[call.name]?.description }),
              ...(capture ? internalTelemetry.jsonAttribute(Attr.toolCallArguments, call.params) : {}),
            },
          }),
          Effect.catchTag("ToolResultFailure", (failure) => Effect.succeed(failure.step)),
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

      const toolEntry = (call: ToolCall, step: Extract<ToolStep, { _tag: "Result" }>): Messages.Entry => ({
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

      // -- Subagents --------------------------------------------------------------------------------------

      const withoutEntries = (step: Checkpoint.Memoized<ToolStep>): ToolOutcome => ({ ...step, entries: [] });
      const failedCall = (call: ToolCall, message: string) =>
        Effect.map(memoTool(`tool:${call.id}`, result(message, true)), withoutEntries);

      // The call's decoded input, or a failed result for the model to correct.
      const decodeInput = (call: ToolCall, child: Any) =>
        Schema.decodeUnknownEffect((child.input ?? PromptInput) as Schema.Codec<unknown, unknown>)(call.params).pipe(
          Effect.mapError((error) => `Invalid input for subagent ${call.name}: ${error.message}`),
        );

      // The child's terminal event as the call's tool step.
      const childStep = (
        call: ToolCall,
        child: Any,
        decoded: unknown,
        own: ReadonlyArray<Messages.Entry>,
        terminal: Extract<Event, { _tag: "Finished" | "Failed" }>,
      ): Effect.Effect<ToolStep> => {
        if (terminal._tag === "Failed") {
          return result(errorMessage(terminal.error), true);
        }
        if (terminal.outcome._tag === "Interrupted") {
          const subagentRunId = subagentIdFor(call.id);
          return Effect.succeed({
            _tag: "Suspended",
            approvals: terminal.outcome.approvals.map((approval) => ({
              approvalId: approval.approvalId,
              toolCallId: approval.toolCallId,
              toolName: approval.toolName,
              subagentRunId: approval.subagentRunId ?? subagentRunId,
            })),
          });
        }
        const text = lastText(own);
        const convert = child.result;
        if (convert === undefined) {
          return result(text, false);
        }
        return Effect.try(() => convert({ text, input: decoded })).pipe(
          Effect.matchEffect({
            onFailure: (error) => result(errorMessage(error.cause), true),
            onSuccess: (value) =>
              isJson(value)
                ? result(value, false)
                : result(`The result of subagent ${call.name} is not a JSON value`, true),
          }),
        );
      };

      // Runs the child a subagent call spawns, forwarding its events, and records how it ended as the call's
      // tool step. Its prompt is the parent's conversation (under the `conversation` mode), then its brief, rebuilt from the
      // call every time so it is never stored, then `history`: what it did in earlier runs, if it is resumed.
      // Its entries are those of its steps, owned by it unless a deeper subagent owns them already. Not inside
      // a checkpoint: the child's own steps are, under names prefixed by the call, so running it again replays
      // them.
      const callSubagent = (
        call: ToolCall,
        child: Any,
        parentMessageId: string,
        parentPrompt: Prompt.Prompt,
        history: Prompt.Prompt,
      ) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.result(decodeInput(call, child));
          if (Result.isFailure(parsed)) {
            return yield* failedCall(call, parsed.failure);
          }
          const decoded = parsed.success;
          const text =
            child.input === undefined ? (decoded as typeof PromptInput.Type).prompt : JSON.stringify(call.params ?? {});
          const brief = Prompt.fromMessages([
            Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
          ]);
          const childPrompt = Prompt.concat(
            child.context === "conversation" ? Prompt.concat(conversationOf(parentPrompt), brief) : brief,
            history,
          );
          const subagentRunId = subagentIdFor(call.id);
          const own: Array<Messages.Entry> = [];
          let terminal: Extract<Event, { _tag: "Finished" | "Failed" }> | undefined;
          // `define` made the child's requirements part of the agent's.
          const events = run(child, {
            ...info,
            prompt: childPrompt,
            subagentPrompts,
          }) as Stream.Stream<Event, never, RunServices<Tools, R>>;
          // The child's model and tool spans are children of one agent span for the call, as a run's are of its
          // root. A failed child fails the span's effect, so the span ends with an error status; it's caught just
          // outside, so the run sees no difference.
          yield* events.pipe(
            Stream.provideService(Checkpoint.Checkpoint, prefixed(checkpoint, `sub:${call.id}/`)),

            Stream.runForEach((event) => {
              if (event._tag === "StepFinished") {
                own.push(...event.entries);
              } else if (event._tag === "Finished" || event._tag === "Failed") {
                terminal = event;
              }

              return emit({
                _tag: "Subagent",
                subagentRunId,
                name: call.name,
                description: child.description,
                parentToolCallId: call.id,
                parentMessageId,
                event,
              });
            }),
            Effect.andThen(
              Effect.suspend(() => {
                const ended = terminal;
                return ended?._tag === "Failed"
                  ? Effect.andThen(
                      Effect.annotateCurrentSpan({ [Attr.errorType]: ended.code ?? "Error" }),
                      new SubagentFailure({ error: ended.error }),
                    )
                  : Effect.void;
              }),
            ),
            Effect.withSpan(internalTelemetry.agentSpanName(call.name), {
              kind: "internal",
              attributes: {
                ...runAttributes,
                [Attr.operationName]: "invoke_agent",
                [Attr.agentName]: call.name,
                ...(child.description === undefined ? {} : { [Attr.agentDescription]: child.description }),
                [Attr.toolCallId]: call.id,
              },
            }),
            Effect.catchTag("SubagentFailure", () => Effect.void),
          );

          if (terminal === undefined) {
            return yield* Effect.die("A subagent run ended without a terminal event");
          }

          const ended = terminal;
          const step = yield* memoTool(
            `tool:${call.id}`,
            Effect.suspend(() =>
              childStep(
                call,
                child,
                decoded,
                own.filter((entry) => entry.subagentRunId === undefined),
                ended,
              ),
            ),
          );
          const entries = own.map((entry) => (entry.subagentRunId === undefined ? { ...entry, subagentRunId } : entry));

          return { ...step, entries } satisfies ToolOutcome;
        });

      // A suspended subagent call in the prompt: the child resumes from what it did in earlier runs.
      const resumeSubagent = (call: ToolCall, parentMessageId: string, parentPrompt: Prompt.Prompt) => {
        const child = subagents.get(call.name);
        const history = subagentPrompts?.[subagentIdFor(call.id)];
        return child === undefined || history === undefined
          ? failedCall(call, INCOMPLETE_SUBAGENT_RESULT)
          : callSubagent(call, child, parentMessageId, forModel(promptBefore(parentPrompt, call.id)), history);
      };

      // Emits the outcome of each call of a step, in call order, and sorts the step's approvals and entries.
      const settle = (step: number, calls: ReadonlyArray<ToolCall>, outcomes: ReadonlyArray<ToolOutcome>) =>
        Effect.gen(function* () {
          const approvals: Array<Approval> = [];
          const childEntries: Array<Messages.Entry> = [];
          const toolEntries: Array<Messages.Entry> = [];
          const suspended = new Set<string>();
          for (const [i, call] of calls.entries()) {
            const { value, replayed, entries } = outcomes[i]!;
            childEntries.push(...entries);
            switch (value._tag) {
              case "ApprovalRequested": {
                approvals.push({ approvalId: value.approvalId, toolCallId: call.id, toolName: call.name });
                yield* emit({
                  _tag: "ApprovalRequested",
                  step,
                  approvalId: value.approvalId,
                  toolCallId: call.id,
                  toolName: call.name,
                  replayed,
                });
                break;
              }
              case "Suspended": {
                // The child's events reported its approvals.
                suspended.add(call.id);
                approvals.push(...value.approvals);
                break;
              }
              case "Result": {
                toolEntries.push(toolEntry(call, value));
                yield* emit(toolResultEvent(step, call, value, replayed));
                break;
              }
            }
          }
          return { approvals, childEntries, toolEntries, suspended };
        });

      const modelStep = (step: number, prompt: Prompt.Prompt) =>
        checkpoint.memo(
          {
            threadId: input.threadId,
            runId: input.runId,
            name: `model:${step}`,
            success: ModelStep,
            error: Schema.Never,
          },
          Effect.gen(function* () {
            const messageId = yield* ids.generateId();
            yield* emit({ _tag: "StepStarted", step, messageId, replayed: false });
            const parts: Array<Response.AnyPart> = [];
            yield* LanguageModel.streamText({
              prompt: withSystem(forModel(prompt)),
              toolkit: modelToolkit,
              disableToolCallResolution: true,
            }).pipe(
              Stream.provideService(AiTelemetry.CurrentSpanTransformer, modelSpanTransformer),
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

      // Resolved before step 0, so a system prompt that fails runs no tool.
      const system =
        agent.system === undefined || typeof agent.system === "string"
          ? agent.system
          : (yield* checkpoint.memo(
              {
                threadId: input.threadId,
                runId: input.runId,
                name: "system",
                success: Schema.String,
                error: Schema.Never,
              },
              agent.system,
            )).value;
      const withSystem = (prompt: Prompt.Prompt) =>
        system === undefined || system.length === 0
          ? prompt
          : Prompt.fromMessages([Prompt.makeMessage("system", { content: system }), ...prompt.content]);

      // Step 0: approval answers carried by the prompt, and suspended subagents, are resolved before the model
      // is called.
      let prompt = input.prompt;
      const decided = pendingDecisions(prompt);
      const suspended = suspendedCalls(prompt);
      if (decided.length > 0 || suspended.length > 0) {
        const opening = prompt;
        const outcomes = yield* Effect.all(
          [
            ...decided.map(({ call, decision }) => Effect.map(executeTool(call, opening, decision), withoutEntries)),
            ...suspended.map(({ call, parentMessageId }) => resumeSubagent(call, parentMessageId, opening)),
          ],
          { concurrency: "unbounded" },
        );
        const settled = yield* settle(
          0,
          [...decided.map(({ call }) => call), ...suspended.map(({ call }) => call)],
          outcomes,
        );
        yield* emit({
          _tag: "StepFinished",
          step: 0,
          entries: [...settled.childEntries, ...settled.toolEntries],
          replayed: outcomes.every((outcome) => outcome.replayed),
        });
        // A resumed subagent waits again. A decision always yields a result.
        if (settled.approvals.length > 0) {
          return yield* emit({
            _tag: "Finished",
            outcome: { _tag: "Interrupted", approvals: settled.approvals, pendingToolCalls: [] },
          });
        }
        // The prompt may continue past the calls (e.g. a new user message), so place the results right after them.
        prompt = orderToolResults(
          Prompt.concat(prompt, Prompt.fromMessages(settled.toolEntries.map((entry) => entry.message))),
        );
      }

      for (let step = 1; ; step++) {
        const model = yield* modelStep(step, prompt);
        const { messageId, assistant, toolCalls, finishReason } = model.value;
        if (model.replayed) {
          yield* emit({ _tag: "StepStarted", step, messageId, replayed: true });
        }

        const complete = finishReason === "tool-calls" || finishReason === "stop";
        const modelPrompt = forModel(prompt);
        // Left to the client. A step cut short answers them like any other call.
        const pending = complete ? toolCalls.filter((call) => frontend.has(call.name)) : [];
        const pendingIds = new Set(pending.map((call) => call.id));
        const executed = toolCalls.filter((call) => !pendingIds.has(call.id));
        const tools = yield* Effect.forEach(
          executed,
          (call): Effect.Effect<ToolOutcome, never, RunServices<Tools, R>> => {
            if (!complete) {
              return Effect.map(interruptTool(call, finishReason), withoutEntries);
            }
            const child = subagents.get(call.name);
            return child === undefined
              ? Effect.map(executeTool(call, modelPrompt, undefined), withoutEntries)
              : callSubagent(call, child, messageId, modelPrompt, Prompt.empty);
          },
          { concurrency: "unbounded" },
        );
        const { approvals, childEntries, toolEntries, suspended } = yield* settle(step, executed, tools);

        const assistantMessage = assistant.content.find((message) => message.role === "assistant");
        const entries: Array<Messages.Entry> = [];
        if (assistantMessage !== undefined) {
          entries.push({
            id: messageId,
            message: Prompt.makeMessage("assistant", {
              content: [
                ...assistantMessage.content.map((part) => {
                  if (part.type !== "tool-call") {
                    return part;
                  }
                  if (pendingIds.has(part.id)) {
                    return markFrontend(part);
                  }
                  return suspended.has(part.id) ? markSuspendedSubagent(part, messageId) : part;
                }),
                // A subagent's requests are on its own entries.
                ...approvals
                  .filter((a) => a.subagentRunId === undefined)
                  .map((a) => Prompt.toolApprovalRequestPart({ approvalId: a.approvalId, toolCallId: a.toolCallId })),
              ],
              options: assistantMessage.options,
            }),
          });
        }
        const own = [...entries, ...toolEntries];
        entries.push(...childEntries, ...toolEntries);
        yield* emit({
          _tag: "StepFinished",
          step,
          entries,
          replayed: model.replayed && tools.every((t) => t.replayed),
        });

        const pendingToolCalls = pending.map((call) => ({ toolCallId: call.id, toolName: call.name }));
        if (approvals.length > 0) {
          return yield* emit({ _tag: "Finished", outcome: { _tag: "Interrupted", approvals, pendingToolCalls } });
        }
        if (pendingToolCalls.length > 0 || finishReason !== "tool-calls" || toolCalls.length === 0) {
          return yield* emit({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls } });
        }
        if (step + 1 > agent.maxSteps) {
          return yield* new StepLimitExceeded({ maxSteps: agent.maxSteps });
        }
        prompt = Prompt.concat(prompt, Prompt.fromMessages(own.map((entry) => entry.message)));
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
      // No span of its own: model and tool spans are children of the caller's span (a runner's
      // `invoke_agent` root), so a backend that keeps only GenAI spans sees an unbroken tree.
      Effect.provideService(CurrentRun, info),
    );
  });

/**
 * Writes the run's attributes, and the call's content when capture is on, on
 * a model call's span. Never throws: telemetry must not change the run.
 */
const annotateModelSpan = (
  options: Parameters<AiTelemetry.SpanTransformer>[0],
  runAttributes: Readonly<Record<string, unknown>>,
  capture: boolean,
): void => {
  const { span } = options;
  try {
    internalTelemetry.setAttributes(span, runAttributes);
    if (!capture) {
      return;
    }
    const system = internalTelemetry.systemInstructions(options.prompt);
    internalTelemetry.setAttributes(span, {
      ...(system.length > 0 ? internalTelemetry.jsonAttribute(Attr.systemInstructions, system) : {}),
      ...internalTelemetry.jsonAttribute(Attr.inputMessages, internalTelemetry.inputMessages(options.prompt)),
      ...internalTelemetry.jsonAttribute(
        Attr.outputMessages,
        internalTelemetry.outputMessages(options.response as ReadonlyArray<Response.AnyPart>),
      ),
      ...internalTelemetry.jsonAttribute(Attr.toolDefinitions, internalTelemetry.toolDefinitions(options.tools)),
    });
  } catch {
    // A span left without some attributes is better than a failed run.
  }
};

const isJson = Schema.is(Schema.Json);

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

// -----------------------------------------------------------------------------
// Frontend calls
// -----------------------------------------------------------------------------

/** The options key of the library's own marks on stored parts. Removed before the model is called. */
const MARK = "agent";

/** The call, marked as the client's to answer. */
const markFrontend = (part: Prompt.ToolCallPart): Prompt.ToolCallPart =>
  Prompt.makePart("tool-call", {
    id: part.id,
    name: part.name,
    params: part.params,
    providerExecuted: part.providerExecuted,
    options: { ...part.options, [MARK]: { frontend: true } },
  });

/**
 * Whether a stored tool call is a frontend call: one the run left for the
 * client, whose `tool` message is the only result a client may write.
 */
export const isFrontendCall = (part: Prompt.ToolCallPart): boolean => {
  const mark = part.options[MARK];
  return Predicate.hasProperty(mark, "frontend") && mark.frontend === true;
};

// -----------------------------------------------------------------------------
// Subagent calls
// -----------------------------------------------------------------------------

/**
 * The id of the subagent run a tool call spawns (AG-UI `subagentRunId`), and
 * the owner of that run's thread entries. Derived from the call, so a replayed
 * or resumed run gives the child the same id. Treat it as opaque.
 */
export const subagentIdFor = (toolCallId: string): string => `subagent:${toolCallId}`;

/**
 * The call, marked as a subagent call whose child is suspended, for the next
 * run to resume. `messageId` is the id of the assistant message holding the
 * call, which the resumed child reports as its `parentMessageId`.
 */
export const markSuspendedSubagent = (part: Prompt.ToolCallPart, messageId: string): Prompt.ToolCallPart =>
  Prompt.makePart("tool-call", {
    id: part.id,
    name: part.name,
    params: part.params,
    providerExecuted: part.providerExecuted,
    options: { ...part.options, [MARK]: { subagent: { messageId } } },
  });

/**
 * The id of the message holding a suspended subagent call, or `undefined` if
 * the call is not one.
 */
const suspendedParent = (part: Prompt.ToolCallPart): string | undefined => {
  const mark = part.options[MARK];
  return Predicate.hasProperty(mark, "subagent") &&
    Predicate.hasProperty(mark.subagent, "messageId") &&
    Predicate.isString(mark.subagent.messageId)
    ? mark.subagent.messageId
    : undefined;
};

/**
 * Whether a stored tool call spawned a subagent that is suspended. Such a call
 * has no result until a later run resumes the child.
 */
export const isSuspendedSubagentCall = (part: Prompt.ToolCallPart): boolean => suspendedParent(part) !== undefined;

/** The suspended subagent calls in the prompt that have no result yet, with the id of the message holding each. */
const suspendedCalls = (
  prompt: Prompt.Prompt,
): Array<{ readonly call: ToolCall; readonly parentMessageId: string }> => {
  const answered = new Set<string>();
  for (const message of prompt.content) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          answered.add(part.id);
        }
      }
    }
  }
  return prompt.content.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => {
          const parentMessageId = part.type === "tool-call" ? suspendedParent(part) : undefined;
          return part.type === "tool-call" && parentMessageId !== undefined && !answered.has(part.id)
            ? [{ call: { id: part.id, name: part.name, params: part.params }, parentMessageId }]
            : [];
        })
      : [],
  );
};

/** The prompt before the assistant message holding the call: what the model had when it made it. */
const promptBefore = (prompt: Prompt.Prompt, toolCallId: string): Prompt.Prompt => {
  const index = prompt.content.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "tool-call" && part.id === toolCallId),
  );
  return index === -1 ? prompt : Prompt.fromMessages(prompt.content.slice(0, index));
};

/**
 * What a child under the `conversation` mode is shown of its parent's prompt: the user's messages and the
 * assistant's text. System messages are the parent's own, and tool calls and results are left out because
 * they name tools the child may not have, which a provider can reject.
 */
const conversationOf = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.flatMap((message): Array<Prompt.Message> => {
      switch (message.role) {
        case "user": {
          return [message];
        }
        case "assistant": {
          const content = message.content.filter((part) => part.type === "text");
          return content.length === 0 ? [] : [Prompt.makeMessage("assistant", { content, options: message.options })];
        }
        default: {
          return [];
        }
      }
    }),
  );

/** The text of the last assistant entry in `entries`, or "" if there is none. */
const lastText = (entries: ReadonlyArray<Messages.Entry>): string => {
  const last = entries.findLast((entry) => entry.message.role === "assistant");
  return last?.message.role === "assistant"
    ? last.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
};

/** The checkpoint service with every step name prefixed, so a child's steps never meet its parent's. */
const prefixed = (checkpoint: Checkpoint.Checkpoint["Service"], prefix: string): Checkpoint.Checkpoint["Service"] =>
  Checkpoint.Checkpoint.of({
    memo: (options, effect) => checkpoint.memo({ ...options, name: `${prefix}${options.name}` }, effect),
  });

const unmark = (part: Prompt.AssistantMessagePart): Prompt.AssistantMessagePart => {
  if (part.type !== "tool-call" || !(MARK in part.options)) {
    return part;
  }
  const { [MARK]: _, ...options } = part.options;
  return Prompt.makePart("tool-call", {
    id: part.id,
    name: part.name,
    params: part.params,
    providerExecuted: part.providerExecuted,
    options,
  });
};

/**
 * The prompt as the model receives it: approval requests and responses, which
 * providers reject, and the marks on frontend and subagent calls are removed, and messages
 * left empty are dropped. By the time the model is called every approval in
 * the prompt has been resolved.
 */
export const forModel = (prompt: Prompt.Prompt): Prompt.Prompt =>
  Prompt.fromMessages(
    prompt.content.flatMap((message): Array<Prompt.Message> => {
      switch (message.role) {
        case "assistant": {
          const content = message.content.filter((part) => part.type !== "tool-approval-request").map(unmark);
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
