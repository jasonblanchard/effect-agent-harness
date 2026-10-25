import { Context, Effect, Layer, Schema } from "effect";
import { Prompt } from "effect/ai";

/**
 * One committed message of a thread. The id is the AG-UI message id the client
 * sees (the user's own id, or the id the server minted for an assistant step or
 * tool result), so the client's history can be matched against the store.
 */
export const Entry = Schema.Struct({
  id: Schema.String,
  message: Prompt.Message,
});
export type Entry = typeof Entry.Type;

/** How a run ended, as reported to {@link Thread.runEnded}. */
export type RunOutcome =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly code: string | undefined };

export class ThreadError extends Schema.TaggedError<ThreadError, { readonly brand: unique symbol }>()("ThreadError", {
  cause: Schema.Defect(),
}) {}

/** Another run holds the thread. A thread has at most one active run. */
export class ThreadBusy extends Schema.TaggedError<ThreadBusy, { readonly brand: unique symbol }>()("ThreadBusy", {
  activeRunId: Schema.String,
}) {
  override get message(): string {
    return `Another run (${this.activeRunId}) is active on this thread`;
  }
}

/**
 * The server-owned store of threads: the committed messages of each one, and
 * which run, if any, is active on each.
 *
 * The library projects whatever `load` returns into the model prompt, after the
 * agent's system prompt and without changing it. Compaction is therefore the
 * store's concern: return a summary entry instead of the history it replaces.
 *
 * What `load` returns is also what a run reconciles the client against, so a
 * compacted thread must still hold:
 *
 * - the latest entries the client has seen, by id. The client's new messages
 *   are those after the last one whose id is loaded; with no id in common the
 *   run fails with `HistoryMismatch`.
 * - every assistant entry with an unanswered approval request. The client's
 *   `resume` answers are matched against those; an answer to a request that is
 *   not loaded is ignored.
 *
 * A thread has at most one active run, because each run reconciles the client
 * against what it loaded and commits on top of it. Every runner claims the
 * thread before loading it and releases it when the run ends. A durable store
 * must make `claim` atomic (e.g. a conditional update), and should let a claim
 * expire after longer than any run takes, so a run that crashed and is never
 * resumed doesn't hold its thread for ever.
 */
export class Thread extends Context.Service<
  Thread,
  {
    /**
     * The thread's entries in commit order, possibly compacted (see above);
     * empty for an unknown thread.
     */
    readonly load: (threadId: string) => Effect.Effect<ReadonlyArray<Entry>, ThreadError>;
    /**
     * Makes `runId` the thread's active run. Succeeds if the thread has no
     * active run or `runId` already is it (a resumed run claims again); fails
     * with `ThreadBusy` if another run is active.
     */
    readonly claim: (threadId: string, runId: string) => Effect.Effect<void, ThreadBusy | ThreadError>;
    /** Ends `runId`'s claim. Does nothing if `runId` is not the active run. */
    readonly release: (threadId: string, runId: string) => Effect.Effect<void, ThreadError>;
    /**
     * Appends, in order, every entry whose id is not in the thread yet. Must be
     * idempotent: a resumed run commits the same entries again.
     */
    readonly commit: (
      threadId: string,
      runId: string,
      entries: ReadonlyArray<Entry>,
    ) => Effect.Effect<void, ThreadError>;
    /**
     * Called once per run that claimed the thread, after its last commit and
     * before its claim is released, whether the run succeeded, was interrupted
     * for approval or failed (including before the model was called). Not
     * called for a run that never claimed the thread (`ThreadBusy`,
     * `RunInputMismatch`), nor for a run that was itself interrupted, such as
     * a cancelled request: it has not ended. A hook for compaction or
     * bookkeeping. If it fails, a successful or interrupted run ends with
     * `RUN_ERROR` instead; a failed run keeps its own error.
     */
    readonly runEnded: (threadId: string, runId: string, outcome: RunOutcome) => Effect.Effect<void, ThreadError>;
  }
>()("effentic/Thread") {}

/** Keeps every thread in memory for the lifetime of the process. For tests, local development and examples. */
export const layerMemory: Layer.Layer<Thread> = Layer.sync(Thread, () => {
  const threads = new Map<string, Array<Entry>>();
  const active = new Map<string, string>();
  return Thread.of({
    load: (threadId) => Effect.sync(() => [...(threads.get(threadId) ?? [])]),
    claim: (threadId, runId) =>
      Effect.suspend(() => {
        const activeRunId = active.get(threadId);
        if (activeRunId !== undefined && activeRunId !== runId) {
          return Effect.fail(new ThreadBusy({ activeRunId }));
        }
        active.set(threadId, runId);
        return Effect.void;
      }),
    release: (threadId, runId) =>
      Effect.sync(() => {
        if (active.get(threadId) === runId) {
          active.delete(threadId);
        }
      }),
    commit: (threadId, _runId, entries) =>
      Effect.sync(() => {
        const thread = threads.get(threadId) ?? [];
        const ids = new Set(thread.map((entry) => entry.id));
        for (const entry of entries) {
          if (!ids.has(entry.id)) {
            ids.add(entry.id);
            thread.push(entry);
          }
        }
        threads.set(threadId, thread);
      }),
    runEnded: () => Effect.void,
  });
});
