import { type Cause, Context, Effect } from "effect";
import type * as Messages from "../Messages.ts";
import type * as Thread from "../Thread.ts";
import type { Approval } from "./events.ts";

// -----------------------------------------------------------------------------
// How a run hands what AG-UI can't carry to whatever runs it: a runner, or the
// parent run of a subagent. Not exported from the package: these link the loop
// to its runners, and are no extension point.
// -----------------------------------------------------------------------------

/**
 * Receives each step's thread entries, before the step's `STEP_FINISHED` is
 * emitted, including for a step replayed from its checkpoint. A runner sets it
 * to the history attempt's `commit`; a parent run sets it to collect its
 * child's entries into the step that called it. A failure ends the run with
 * `RUN_ERROR`. By default the entries are discarded.
 */
export const OnStepFinished = Context.Reference<
  (entries: ReadonlyArray<Messages.Entry>) => Effect.Effect<void, Thread.ThreadError>
>("effect-agent-harness/internal/OnStepFinished", { defaultValue: () => () => Effect.void });

/**
 * Receives a failed run's cause, before its `RUN_ERROR` is emitted: from the loop, from a runner's own failure, or
 * from the store failing to record the run's end. A runner sets it to end the run's root span with the cause, and
 * logs it there, so the span carries the original error once. A parent run sets it to end its subagent's
 * `invoke_agent` span with the cause, without logging: the parent reports the failure as a failed tool result. By
 * default (`Agent.run` with no runner) the cause is logged. Never fails.
 */
export const OnRunFailed = Context.Reference<(cause: Cause.Cause<unknown>) => Effect.Effect<void>>(
  "effect-agent-harness/internal/OnRunFailed",
  { defaultValue: () => (cause) => Effect.logError("effect-agent-harness: the run failed", cause) },
);

/** Reports a failed run's cause to `OnRunFailed`. */
export const reportFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.flatMap(OnRunFailed, (report) => report(cause));

/**
 * What a subagent's run reports to the parent running it, besides its events.
 * By default, nothing listens.
 */
export interface ChildReport {
  /** Called when the run serves a step or call from its checkpoint instead of executing it. */
  readonly replayed: () => void;
  /** Called with the approvals the run ends waiting for, before its terminal event. */
  readonly approvals: (approvals: ReadonlyArray<Approval>) => void;
}

export const ChildReport = Context.Reference<ChildReport>("effect-agent-harness/internal/ChildReport", {
  defaultValue: () => ({ replayed: () => {}, approvals: () => {} }),
});
