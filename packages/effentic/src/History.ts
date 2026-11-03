import { Context, Effect, Layer } from "effect";
import * as internal from "./internal/history.ts";
import * as Thread from "./Thread.ts";

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
>()("effentic/History") {}

/**
 * The client owns the transcript: the run's history is `input.messages` as
 * sent, converted as `Messages.fromHistory` describes. Nothing is loaded,
 * stored, claimed or released, so edited and regenerated histories are taken
 * as sent, and two runs on one thread may run at once. The default; provide it
 * to force the client history where a server history is provided further out.
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
