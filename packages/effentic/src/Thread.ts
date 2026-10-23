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

/**
 * The server-owned store of threads: the committed messages of each one.
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
     * Appends, in order, every entry whose id is not in the thread yet. Must be
     * idempotent: a resumed run commits the same entries again.
     */
    readonly commit: (
      threadId: string,
      runId: string,
      entries: ReadonlyArray<Entry>,
    ) => Effect.Effect<void, ThreadError>;
    /**
     * Called once per run, after its last commit, whether the run succeeded,
     * was interrupted for approval or failed (including before the model was
     * called). Not called for a run that was itself interrupted, such as a
     * cancelled request: it has not ended. A hook for compaction or
     * bookkeeping. If it fails, a successful or interrupted run ends with
     * `RUN_ERROR` instead; a failed run keeps its own error.
     */
    readonly runEnded: (threadId: string, runId: string, outcome: RunOutcome) => Effect.Effect<void, ThreadError>;
  }
>()("effentic/Thread") {}

/** Keeps every thread in memory for the lifetime of the process. For tests, local development and examples. */
export const layerMemory: Layer.Layer<Thread> = Layer.sync(Thread, () => {
  const threads = new Map<string, Array<Entry>>();
  return Thread.of({
    load: (threadId) => Effect.sync(() => [...(threads.get(threadId) ?? [])]),
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
