import { Context, Effect, Layer } from "effect";
import * as internal from "./internal/history.ts";
import * as Conversions from "./internal/conversions.ts";
import * as Thread from "./Thread.ts";

export {
  HistoryDiverged,
  HistoryMismatch,
  type Restored,
  UnansweredInterrupt,
  UnansweredToolCall,
} from "./internal/conversions.ts";

// -----------------------------------------------------------------------------
// Who owns a run's transcript. AG-UI has the client send its whole history on
// every run, and by default that history is the run's: nothing is stored. A
// deployment that must own the transcript (a thread shared between users or
// devices, or kept beyond the client) provides `layerServer`, and the run's
// history is then the thread store's, with only new user messages, approval
// answers and frontend results taken from the client.
//
// Neither is an authorization boundary. A client that writes the whole prompt
// can already steer the model into any call it could forge, so tool handlers
// and the per-run services they read (the verified principal, never anything
// from the input) are where access is checked. `needsApproval` protects the
// user from the model, not the server from the client: under the client
// history, a client that drops a call's result and approves it again runs the
// handler again, so handlers with side effects must be idempotent, or the
// deployment must use the server history.
// -----------------------------------------------------------------------------

/**
 * The run's canonical history: where its prompt comes from, and what happens
 * to its steps and its end. Read from the run's context, so it can be chosen
 * per runner or per request (`Stream.provide(History.layerServer)`); a run
 * without one uses the client history ({@link layerClient}).
 */
export class History extends Context.Service<
  History,
  /** Opaque: get one from {@link layerClient} or {@link layerServer}. Its members are internal. */
  { readonly [internal.TypeId]: internal.TypeId }
>()("effect-agent-harness/History") {}

/**
 * The client owns the transcript: the run's history is `input.messages` as
 * sent. Nothing is loaded, stored, claimed or released, so edited and
 * regenerated histories are taken as sent, and two runs on one thread may run
 * at once. The default; provide it to force the client history where a server
 * history is provided further out.
 *
 * The client's messages become the run's entries under their own ids:
 *
 * - `user` messages keep their text; `system` and `developer` messages are
 *   kept as system entries only with `clientSystem: "allow"`.
 * - `assistant` messages keep their text and tool calls. A call whose
 *   arguments are not a JSON object, such as one cut off by a cancelled run,
 *   is dropped together with its results.
 * - A `tool` message is its call's result (failed if it has `error`; JSON text
 *   parsed; content parts reduced to their text). Only the first per call is
 *   kept, and one whose call is not in the history is dropped.
 * - Other roles are dropped.
 *
 * A `resume` entry answers the call with no result whose
 * `Agent.approvalIdFor` it names, and the decision runs as step 0; an entry
 * naming no such call is ignored, and a `resolved` one whose payload is not an
 * `AgUi.ApprovalResponse` denies the call. Dropped calls, results with no
 * call, dropped content parts and such malformed answers are logged as
 * warnings.
 *
 * The run can't know what the previous run left open, so it never fails with
 * `UnansweredInterrupt` or `UnansweredToolCall`: a call with no result and no
 * answer is sent to the model with a failed result.
 */
export const layerClient: Layer.Layer<History> = Layer.succeed(History, internal.client);

/**
 * The server owns the transcript, in {@link Thread.Thread}: the run claims the
 * thread (`ThreadBusy` if another run holds it), loads it, takes from the
 * client only its delta, its `resume` answers and its results for pending
 * frontend calls, rejects history that doesn't match the store
 * (`HistoryMismatch`, `HistoryDiverged`) or leaves an interrupt or frontend
 * call unanswered (`UnansweredInterrupt`, `UnansweredToolCall`), commits each
 * step, reports its end (`runEnded`) and releases the thread before the
 * terminal event is emitted.
 */
export const layerServer: Layer.Layer<History, never, Thread.Thread> = Layer.effect(
  History,
  Effect.map(Thread.Thread, internal.server),
);

export interface RestoreOptions {
  /**
   * Set this only on a route that serves joins from the `EventLog`, which means
   * runs started with `Runner.makeDetached` or `Runner.makeWorkflow`. `Runner.makeAttached` claims the thread but never
   * writes to the log, so a client told to join one of its runs waits for
   * events that never come.
   *
   * The read then reports the run holding the thread as `activeRun`, and leaves
   * out the assistant messages and tool results that run committed, so the
   * returned messages followed by the run's log from its start show each
   * message once. The run's user messages stay, because the log doesn't show
   * them, and so do its answers to earlier runs' calls. Open interrupts and
   * pending frontend calls are computed from what remains.
   *
   * A claim is not proof of life: a crashed run holds its thread until the
   * claim expires, and its log never ends, so a join needs an idle timeout.
   */
  readonly rejoin?: boolean | undefined;
}

/**
 * The thread as its runs' events showed it, with its open interrupts and
 * pending frontend calls, for a client that has lost its state (a reload,
 * another device) to restore. Loads the thread from {@link Thread.Thread} and
 * makes no claim, so it needs no run and can be read while one is active.
 * Under the client history nothing is stored, and the client keeps its own
 * state. Serve it from a route of your own, authorised like the run route. A
 * client that sends the messages back, with new user messages after them, is
 * matched against the store as if it had streamed them.
 *
 * Messages are AG-UI's own type, in commit order, with each tool result moved
 * directly after the assistant message holding its call. An entry's reasoning
 * comes directly before its assistant message, even a block the model produced
 * after text, and a reasoning block with no text is skipped. Ids and content
 * are the events': an assistant message's text is its segments joined, a
 * reasoning message's is its deltas joined, and a tool result is its
 * `TOOL_CALL_RESULT` content. Tool call arguments are re-encoded, so their
 * formatting may differ from the streamed deltas. System entries and approval
 * responses are not returned, and neither is provider metadata such as a
 * reasoning signature. A client may send `reasoning` messages back or drop
 * them: they are never committed, and neither choice is a mismatch.
 *
 * With `rejoin` (see {@link RestoreOptions}), a thread with an active run reads
 * as if that run had not produced anything yet, and `activeRun` names it.
 */
export const restore = (
  threadId: string,
  options?: RestoreOptions,
): Effect.Effect<Conversions.Restored, Thread.ThreadError, Thread.Thread> =>
  Effect.gen(function* () {
    const thread = yield* Thread.Thread;
    // The claim first. A run that ends between the two reads is then left out
    // and joined through its finished log. The other order could report no
    // active run alongside messages that miss the run's last step.
    const activeRunId = options?.rejoin === true ? yield* thread.activeRun(threadId) : undefined;
    return Conversions.restore(yield* thread.load(threadId), activeRunId);
  });
