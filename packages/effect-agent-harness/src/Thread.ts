import { Context, Effect, Layer, Schema } from "effect";
import type * as Messages from "./Messages.ts";

/** How a run ended, as reported to {@link Thread.runEnded}. */
export type RunOutcome =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Interrupted" }
  /** The run was cancelled on purpose (a stop, a disconnect, a runner's `cancel`), after committing its partial step. */
  | { readonly _tag: "Cancelled" }
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
 * The server history's store of threads: the committed messages of each one,
 * and which run, if any, is active on each. Runs use it only through
 * `History.layerServer`; a run on the default client history never touches it.
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
 * - every entry of a suspended subagent, and the assistant entry holding the
 *   call that spawned it, with its tool-call `options` intact. The subagent is
 *   resumed from those.
 *
 * And it must not put a user, assistant or tool entry the client has never
 * seen after the latest one it has: the client's next run would fail with
 * `HistoryDiverged`. Write a summary as a `system` entry, which the client is
 * never expected to hold.
 *
 * A thread has at most one active run, because each run reconciles the client
 * against what it loaded and commits on top of it. The server history claims
 * the thread before loading it and releases it when the run ends. A durable store
 * must make `claim` atomic (e.g. a conditional update), and should let a claim
 * expire after longer than any run takes, so a run that crashed and is never
 * resumed doesn't hold its thread for ever.
 */
export class Thread extends Context.Service<
  Thread,
  {
    /**
     * The thread's entries in commit order, possibly compacted (see above);
     * empty for an unknown thread. Every entry the store committed carries the
     * `runId` of the commit that appended it; an entry the store wrote itself,
     * such as a compaction summary, may have none.
     */
    readonly load: (threadId: string) => Effect.Effect<ReadonlyArray<Messages.Entry>, ThreadError>;
    /**
     * Makes `runId` the thread's active run. Succeeds if the thread has no
     * active run or `runId` already is it (a resumed run claims again); fails
     * with `ThreadBusy` if another run is active.
     */
    readonly claim: (threadId: string, runId: string) => Effect.Effect<void, ThreadBusy | ThreadError>;
    /**
     * The run holding the thread's claim, or `undefined` if it has none. Only a
     * read: it never changes the claim. A store that lets claims expire reports
     * `undefined` once the claim has expired.
     */
    readonly activeRun: (threadId: string) => Effect.Effect<string | undefined, ThreadError>;
    /** Ends `runId`'s claim. Does nothing if `runId` is not the active run. */
    readonly release: (threadId: string, runId: string) => Effect.Effect<void, ThreadError>;
    /**
     * Appends, in order, every entry whose id is not in the thread yet, with
     * `runId` recorded on it. Must be idempotent: a resumed run commits the same
     * entries again, and an entry already present keeps its first run.
     */
    readonly commit: (
      threadId: string,
      runId: string,
      entries: ReadonlyArray<Messages.Entry>,
    ) => Effect.Effect<void, ThreadError>;
    /**
     * Called once per run that claimed the thread, after its last commit and
     * before its claim is released, whether the run succeeded, was interrupted
     * for approval, was cancelled (a request whose consumer stopped, or a
     * runner's `cancel`) or failed (including before the model was called).
     * Not called for a run that never claimed the thread (`ThreadBusy`,
     * `RunInputMismatch`), nor for a detached or workflow attempt that stopped
     * without a terminal event (a crash): it has not ended. A hook for
     * compaction or bookkeeping. If it fails, a successful, interrupted or
     * cancelled run ends with `RUN_ERROR` instead; a failed run keeps its own
     * error.
     */
    readonly runEnded: (threadId: string, runId: string, outcome: RunOutcome) => Effect.Effect<void, ThreadError>;
  }
>()("effect-agent-harness/Thread") {}

/** Keeps every thread in memory for the lifetime of the process. For tests, local development and examples. */
export const layerMemory: Layer.Layer<Thread> = Layer.sync(Thread, () => {
  const threads = new Map<string, Array<Messages.Entry>>();
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
    activeRun: (threadId) => Effect.sync(() => active.get(threadId)),
    release: (threadId, runId) =>
      Effect.sync(() => {
        if (active.get(threadId) === runId) {
          active.delete(threadId);
        }
      }),
    commit: (threadId, runId, entries) =>
      Effect.sync(() => {
        const thread = threads.get(threadId) ?? [];
        const ids = new Set(thread.map((entry) => entry.id));
        for (const entry of entries) {
          if (!ids.has(entry.id)) {
            ids.add(entry.id);
            thread.push({ ...entry, runId });
          }
        }
        threads.set(threadId, thread);
      }),
    runEnded: () => Effect.void,
  });
});
