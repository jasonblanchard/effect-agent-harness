import { Cause, Effect } from "effect";
import * as Agent from "../Agent.ts";
import type * as AgUi from "../AgUi.ts";
import type * as Messages from "../Messages.ts";
import type * as Thread from "../Thread.ts";
import * as Conversions from "./conversions.ts";

// -----------------------------------------------------------------------------
// The private side of `History`: what the runner calls on it. Not exported from
// the package, so its rerun rules can change before they become a contract.
// -----------------------------------------------------------------------------

export const TypeId: unique symbol = Symbol.for("effect-agent-harness/History");
export type TypeId = typeof TypeId;

/** A terminal event of `Agent.run`. */
export type Terminal = Extract<Agent.Event, { readonly _tag: "Finished" | "Failed" }>;

/** What opening a run can fail with. Only the server history fails. */
export type AttemptError =
  | Thread.ThreadError
  | Thread.ThreadBusy
  | Conversions.HistoryMismatch
  | Conversions.HistoryDiverged
  | Conversions.UnansweredInterrupt
  | Conversions.UnansweredToolCall;

export interface AttemptOptions {
  readonly clientSystem: Conversions.IngestOptions["clientSystem"];
}

/**
 * A history's implementation. `beginAttempt` runs again on every attempt of a run, so
 * it must be idempotent across attempts, and so must `commit`.
 */
export interface Service {
  readonly [TypeId]: TypeId;
  /**
   * Opens the run's attempt: everything before the prompt is projected. A
   * failure after the history took hold of the thread is reported to it
   * before `beginAttempt` fails, as `Attempt.end` would report it.
   */
  readonly beginAttempt: (input: AgUi.RunAgentInput, options: AttemptOptions) => Effect.Effect<Attempt, AttemptError>;
  /**
   * Called by the request-scoped runner when its stream stops before a
   * terminal event, whether or not `beginAttempt` returned.
   */
  readonly abandonAttempt: (input: AgUi.RunAgentInput) => Effect.Effect<void>;
}

/** One attempt of a run, as `beginAttempt` opened it. */
export interface Attempt {
  /** The history the run starts from that is already persisted (`[]` for the client history). */
  readonly stored: ReadonlyArray<Messages.Entry>;
  /** What the run adds before the model is called. Projected after `stored`. */
  readonly added: ReadonlyArray<Messages.Entry>;
  /** Called with each step's entries. */
  readonly commit: (entries: ReadonlyArray<Messages.Entry>) => Effect.Effect<void, Thread.ThreadError>;
  /** Called once with the terminal event, before it is emitted. Returns the event to emit. */
  readonly end: (event: Terminal) => Effect.Effect<Agent.Event>;
}

/** A failure as the `Failed` event that reports it. */
export const failed = (cause: Cause.Cause<unknown>): Terminal => {
  const error = Cause.squash(cause);
  return { _tag: "Failed", error, code: Agent.errorCode(error) };
};

const logMalformed = (input: AgUi.RunAgentInput) =>
  Effect.gen(function* () {
    const malformed = Conversions.malformedAnswers(input.resume ?? []);
    if (malformed.length > 0) {
      yield* Effect.logWarning(
        "effect-agent-harness: resolved answers that are not approval responses were denied",
        malformed,
      );
    }
  });

// -----------------------------------------------------------------------------
// Client history
// -----------------------------------------------------------------------------

/** The client history: `input.messages` as sent, with nothing loaded, stored, claimed or released. */
export const client: Service = {
  [TypeId]: TypeId,
  beginAttempt: (input, options) =>
    Effect.gen(function* () {
      const converted = Conversions.fromHistory(input.messages, input.resume ?? [], options);
      yield* logMalformed(input);
      if (converted.droppedCalls.length > 0) {
        yield* Effect.logWarning(
          "effect-agent-harness: tool calls whose arguments are not a JSON object were dropped from the client's history",
          converted.droppedCalls,
        );
      }
      if (converted.orphanResults.length > 0) {
        yield* Effect.logWarning(
          "effect-agent-harness: tool messages with no call in the client's history were dropped",
          converted.orphanResults,
        );
      }
      if (converted.droppedParts.length > 0) {
        yield* Effect.logWarning(
          "effect-agent-harness: content parts other than text were dropped from tool results",
          converted.droppedParts,
        );
      }
      return {
        stored: [],
        added: converted.entries,
        commit: () => Effect.void,
        end: Effect.succeed,
      } satisfies Attempt;
    }),
  abandonAttempt: () => Effect.void,
};

// -----------------------------------------------------------------------------
// Server history
// -----------------------------------------------------------------------------

/**
 * Calls `runEnded` and then releases the thread, even if `runEnded` failed. If
 * either fails, a successful or interrupted run ends as failed instead; a run
 * that already failed keeps its own error.
 */
const endRun = (thread: Thread.Thread["Service"], threadId: string, runId: string, event: Terminal) =>
  thread
    .runEnded(
      threadId,
      runId,
      event._tag === "Finished" ? { _tag: event.outcome._tag } : { _tag: "Failed", code: event.code },
    )
    .pipe(
      Effect.exit,
      Effect.flatMap((ended) => Effect.andThen(thread.release(threadId, runId), ended)),
      Effect.as<Agent.Event>(event),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? // An interrupt-only cause has no failures, so its error type is irrelevant.
            Effect.failCause(cause as Cause.Cause<never>)
          : Effect.succeed(event._tag === "Failed" ? event : failed(cause)),
      ),
    );

/**
 * The server history over `thread`: the run claims the thread (so it has one
 * active run), loads it, takes the client's delta, its `resume` answers and its
 * results for pending frontend calls, and commits them. Each step is
 * committed, and the run's end is reported to the store before the thread is
 * released, so the client's next run finds it free. A run that never claimed
 * the thread, or was itself interrupted, is not reported: an interrupted
 * detached run keeps its claim, and running it again finishes it.
 */
export const server = (thread: Thread.Thread["Service"]): Service => ({
  [TypeId]: TypeId,
  beginAttempt: (input, options) => {
    const { threadId, runId } = input;
    const prepare = Effect.gen(function* () {
      const stored = yield* thread.load(threadId);
      const delta = yield* Effect.fromResult(Conversions.delta(stored, input.messages, runId));
      const responses = yield* Effect.fromResult(Conversions.resume(stored, input.resume ?? []));
      // After `resume`, so a run that leaves both kinds open reports the unanswered interrupt.
      const answered = yield* Effect.fromResult(Conversions.answers(stored, delta));
      yield* logMalformed(input);
      if (answered.droppedParts.length > 0) {
        yield* Effect.logWarning(
          "effect-agent-harness: content parts other than text were dropped from frontend tool results",
          answered.droppedParts,
        );
      }
      // Answers to the previous run come before anything new the client says.
      const added = [
        ...responses,
        ...answered.entries,
        ...Conversions.ingest(delta, { clientSystem: options.clientSystem }),
      ];
      yield* thread.commit(threadId, runId, added);
      return {
        stored,
        added,
        commit: (entries) => thread.commit(threadId, runId, entries),
        end: (event) => endRun(thread, threadId, runId, event),
      } satisfies Attempt;
    });

    return Effect.andThen(
      thread.claim(threadId, runId),
      // A run that failed once it held the thread reports its end before the failure is emitted.
      Effect.tapCause(prepare, (cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : endRun(thread, threadId, runId, failed(cause)),
      ),
    );
  },
  abandonAttempt: (input) =>
    thread
      .release(input.threadId, input.runId)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("effect-agent-harness: releasing a cancelled run's thread failed", cause),
        ),
      ),
});
