import type { AgUiSchema } from "effect/ai";
import type { Array as Arr } from "effect";
import { Stream } from "effect";
import {
  attribute,
  closeReasoning,
  isReplayed,
  reasoningEnd,
  stepFinished,
  subagentFinished,
  textMessageEnd,
  toolCallEnd,
  unmarked,
} from "./events.ts";

// -----------------------------------------------------------------------------
// What the runners apply to a run's events before they go out: dropping
// superseded progress, closing what an aborted attempt left open, and deciding
// which replayed work an attempt publishes.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Conflating superseded progress
//
// A snapshot replaces the one before it, so one that a later snapshot of the
// same activity already follows shows nothing a client would keep. A stream
// read through a queue delivers everything queued since the last read as one
// chunk, so dropping such snapshots within a chunk does nothing for a reader
// that keeps up, and drops only the backlog of one that doesn't. The last
// snapshot of an activity in a chunk always stays, in its place.
// -----------------------------------------------------------------------------

/** `chunk` without the elements a later element of the same key follows; elements without a key all stay. */
const dropSuperseded = <A>(
  chunk: Arr.NonEmptyReadonlyArray<A>,
  key: (a: A) => string | undefined,
): Arr.NonEmptyReadonlyArray<A> => {
  const last = new Map<string, number>();
  let keyed = 0;
  chunk.forEach((a, i) => {
    const k = key(a);
    if (k !== undefined) {
      keyed++;
      last.set(k, i);
    }
  });
  if (keyed === last.size) {
    return chunk;
  }
  // The last element of each key stays, so the result is never empty.
  return chunk.filter((a, i) => {
    const k = key(a);
    return k === undefined || last.get(k) === i;
  }) as unknown as Arr.NonEmptyReadonlyArray<A>;
};

/**
 * Drops each `ACTIVITY_SNAPSHOT` that a later one with the same `messageId`
 * follows in the same chunk. For AG-UI events read through a queue.
 */
export const conflateActivity = <E, R>(
  events: Stream.Stream<AgUiSchema.Event, E, R>,
): Stream.Stream<AgUiSchema.Event, E, R> =>
  Stream.mapArray(events, (chunk) =>
    dropSuperseded(chunk, (event) => (event.type === "ACTIVITY_SNAPSHOT" ? event.messageId : undefined)),
  );

// -----------------------------------------------------------------------------
// Completing an aborted attempt's log
// -----------------------------------------------------------------------------

/** The subagent an event is attributed to, if any. */
const ownerOf = (event: AgUiSchema.Event): string | undefined =>
  "subagentRunId" in event &&
  event.type !== "SUBAGENT_STARTED" &&
  event.type !== "SUBAGENT_FINISHED" &&
  event.type !== "SUBAGENT_ERROR"
    ? event.subagentRunId
    : undefined;

/**
 * Events that close every text message, reasoning message, reasoning span,
 * tool call and step left open in `history`, e.g. by an attempt of the run that
 * crashed, each attributed to the subagent that opened it. Empty when nothing
 * is open. Subagents are left open: the attempt that completes the run
 * continues them.
 */
export const closeOpen = (history: ReadonlyArray<AgUiSchema.Event>): Array<AgUiSchema.Event> => {
  // Each open span's owner, by its id.
  const text = new Map<string, string | undefined>();
  // Tracked apart, because a log can stop between a block's two starts.
  const reasoningMessages = new Set<string>();
  const reasoningSpans = new Map<string, string | undefined>();
  const tools = new Map<string, string | undefined>();
  // Steps are scoped to their owner.
  const steps = new Map<string, { readonly stepName: string; readonly owner: string | undefined }>();
  const stepKey = (stepName: string, owner: string | undefined) => JSON.stringify([owner ?? null, stepName]);
  for (const event of history) {
    const owner = ownerOf(event);
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        text.set(event.messageId, owner);
        break;
      case "TEXT_MESSAGE_END":
        text.delete(event.messageId);
        break;
      case "REASONING_START":
        reasoningSpans.set(event.messageId, owner);
        break;
      case "REASONING_END":
        reasoningSpans.delete(event.messageId);
        break;
      case "REASONING_MESSAGE_START":
        reasoningMessages.add(event.messageId);
        break;
      case "REASONING_MESSAGE_END":
        reasoningMessages.delete(event.messageId);
        break;
      case "TOOL_CALL_START":
        tools.set(event.toolCallId, owner);
        break;
      case "TOOL_CALL_END":
        tools.delete(event.toolCallId);
        break;
      case "STEP_STARTED":
        steps.set(stepKey(event.stepName, owner), { stepName: event.stepName, owner });
        break;
      case "STEP_FINISHED":
        steps.delete(stepKey(event.stepName, owner));
        break;
    }
  }
  return [
    ...[...text].map(([id, owner]) => attribute(textMessageEnd(id), owner)),
    ...[...reasoningSpans].flatMap(([id, owner]) =>
      (reasoningMessages.has(id) ? closeReasoning(id) : [reasoningEnd(id)]).map((event) => attribute(event, owner)),
    ),
    ...[...tools].map(([id, owner]) => attribute(toolCallEnd(id), owner)),
    ...[...steps.values()].map(({ stepName, owner }) => attribute(stepFinished(stepName), owner)),
  ];
};

// -----------------------------------------------------------------------------
// Publishing an attempt
// -----------------------------------------------------------------------------

/**
 * Publishes a run attempt's events: what a client receives and the event log
 * stores. The run marks the work it served from its checkpoints that an
 * earlier attempt may have stored without publishing (a step publishes its
 * results only once all its calls finish): a replayed tool call result, and a
 * replayed subagent's lifecycle events. `resumed` is the log of an earlier
 * attempt this one completes, if any. A marked result goes out if that log
 * lacks it, or if it belongs to a subagent whose closing goes out now; a
 * marked subagent closing goes out if the log left the subagent open, or if
 * this attempt started it; a marked `SUBAGENT_STARTED` goes out just before
 * the first of the subagent's events that does. Without a log, nothing marked
 * goes out. A subagent the log left open and this attempt doesn't close is
 * closed before `RUN_FINISHED`. Every event goes out without the library's
 * markers.
 */
export const publish =
  (resumed: ReadonlyArray<AgUiSchema.Event> | undefined) =>
  <E, R>(events: Stream.Stream<AgUiSchema.Event, E, R>): Stream.Stream<AgUiSchema.Event, E, R> =>
    Stream.suspend(() => {
      // The subagents the log started and has not closed, and those it closed.
      const open = new Set<string>();
      const closed = new Set<string>();
      // The call that spawned each subagent, so a finished one's result goes out with it.
      const spawnedBy = new Map<string, string>();
      // The calls whose results the log holds, when there is a log.
      const published = resumed === undefined ? undefined : new Set<string>();
      for (const event of resumed ?? []) {
        if (event.type === "SUBAGENT_STARTED") {
          open.add(event.subagentRunId);
          if (event.parentToolCallId !== undefined) {
            spawnedBy.set(event.subagentRunId, event.parentToolCallId);
          }
        } else if (event.type === "SUBAGENT_FINISHED" || event.type === "SUBAGENT_ERROR") {
          open.delete(event.subagentRunId);
          closed.add(event.subagentRunId);
        } else if (event.type === "TOOL_CALL_RESULT") {
          published?.add(event.toolCallId);
        }
      }
      // Subagents this attempt started, the marked starts waiting for an event to go out, and the calls whose
      // subagent's closing went out ahead of their result.
      const started = new Set<string>();
      const held = new Map<string, AgUiSchema.SubagentStartedEvent>();
      const awaiting = new Set<string>();

      // The held start of `subagentRunId`, after those of the subagents enclosing it.
      const release = (subagentRunId: string | undefined): Array<AgUiSchema.Event> => {
        const start = subagentRunId === undefined ? undefined : held.get(subagentRunId);
        if (start === undefined) {
          return [];
        }
        held.delete(start.subagentRunId);
        started.add(start.subagentRunId);
        return [...release(start.parentSubagentRunId), unmarked(start)];
      };
      const out = (owner: string | undefined, event: AgUiSchema.Event): Array<AgUiSchema.Event> => [
        ...release(owner),
        unmarked(event),
      ];

      const project = (event: AgUiSchema.Event): Array<AgUiSchema.Event> => {
        switch (event.type) {
          case "SUBAGENT_STARTED": {
            const id = event.subagentRunId;
            if (event.parentToolCallId !== undefined) {
              spawnedBy.set(id, event.parentToolCallId);
            }
            if (open.has(id) || closed.has(id)) {
              // An earlier attempt started it.
              return [];
            }
            if (isReplayed(event)) {
              held.set(id, event);
              return [];
            }
            started.add(id);
            return out(event.parentSubagentRunId, event);
          }
          case "SUBAGENT_FINISHED":
          case "SUBAGENT_ERROR": {
            const id = event.subagentRunId;
            if (isReplayed(event) && !open.has(id) && !started.has(id)) {
              // An earlier attempt closed it, or nothing of it goes out.
              held.delete(id);
              return [];
            }
            open.delete(id);
            closed.add(id);
            const call = spawnedBy.get(id);
            if (event.type === "SUBAGENT_FINISHED" && event.outcome?.type === "success" && call !== undefined) {
              awaiting.add(call);
            }
            return out(id, event);
          }
          case "TOOL_CALL_RESULT": {
            if (
              isReplayed(event) &&
              !awaiting.has(event.toolCallId) &&
              (published === undefined || published.has(event.toolCallId))
            ) {
              return [];
            }
            awaiting.delete(event.toolCallId);
            published?.add(event.toolCallId);
            return out(event.subagentRunId, event);
          }
          case "RUN_FINISHED": {
            // Every subagent closes before the run does; one the log left open never got its parent's result.
            const unclosed = [...open].map((id) => subagentFinished(id, undefined));
            open.clear();
            return [...unclosed, event];
          }
          case "RUN_STARTED":
          case "RUN_ERROR": {
            return [event];
          }
          default: {
            return out("subagentRunId" in event ? event.subagentRunId : undefined, event);
          }
        }
      };
      return Stream.flattenIterable(Stream.map(events, project));
    });
