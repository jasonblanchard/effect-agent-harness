## Why

A long-running tool call is silent on the AG-UI stream. A client sees `TOOL_CALL_END`, then nothing until the step's results go out, and those wait for every call in the step to finish. `effect/ai` already gives tool handlers a progress channel, `ctx.preliminary(value)`, but the agent loop discards those values (`Stream.filter(results, (r) => !r.preliminary)`), and so does `effect/ai`'s own AG-UI encoder. AG-UI's activity events (`ACTIVITY_SNAPSHOT`) are the protocol's way to show structured, frontend-only status, and TanStack AI already renders them as `activity` messages. Connecting the two lets a tool report progress with no new API in this library.

## What Changes

- **The run emits tool progress.** Each preliminary result a tool handler produces becomes a new `Agent.Event`, `ToolProgress`, carrying the step, the calling step's assistant message id, the tool call id and name, and the value encoded with the tool's success schema. Progress is never sent to the model, committed to the thread, or checkpointed. A call served from a checkpoint emits none.
- **Progress streams as `ACTIVITY_SNAPSHOT`.** `AgUi.fold` turns each `ToolProgress` into an `ACTIVITY_SNAPSHOT` whose `activityType` is the tool name, whose `content` is the encoded value (a value that isn't a JSON object is wrapped as `{ value }`), and whose `metadata` carries the tool call id under the prefixed key `effect-agent-harness:toolCallId`. Every snapshot of one call has the same `messageId`, derived from the step's assistant message id and the tool call id, so it stays stable when a step is executed again. `ActivitySnapshotEvent` joins the `AgUi.Event` union.
- **Superseded snapshots may be dropped.** If a consumer falls behind and a later snapshot for the same activity is already buffered, the earlier one is dropped. The last snapshot before the call's result is always delivered.
- **Subagent progress is attributed.** A child's snapshots carry its `subagentRunId`, like its other events.
- **The `tanstack` example shows it.** A slow server tool reports progress, and the page renders the activity message as a progress card.

Out of scope:

- `ACTIVITY_DELTA`. Only snapshots are emitted, because they replace each other and stay correct when a step is executed again.
- Durable activity. `History.restore` doesn't return activity messages, so after a reload only the tool result remains.
- Activity from anything other than a tool handler (the model step, the runner, a system prompt effect), and more than one activity per call.
- A separate progress type per tool. Progress shares the tool's `Success` type. A tool whose progress differs from its result uses a union.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-run`: tool handlers' preliminary results are emitted as progress events, never sent to the model, committed or checkpointed.
- `agui-agent-loop`: tool progress streams as `ACTIVITY_SNAPSHOT` events, superseded snapshots may be dropped, and the message identifier rules cover activity ids.
- `agui-subagent-events`: a child's activity snapshots carry its `subagentRunId`.

## Impact

- **`packages/effect-agent-harness/src/Agent.ts`:** the `Event` union and `handleTool`, which currently drops preliminary results.
- **`packages/effect-agent-harness/src/AgUi.ts`:** the `Event` union, a snapshot builder, `fold`'s projection, and the internal conflation operators.
- **`packages/effect-agent-harness/src/Runner.ts`:** conflation of superseded progress on `Agent.run`'s output in `agUiRun`, and of superseded snapshots after `makeAttached`'s queue.
- **`packages/examples/tanstack`:** a slow tool on the server and an activity renderer on the page.
- **Docs:** `packages/effect-agent-harness/README.md` and `AGENTS.md` (how to report progress from a tool), and the example's `AGENTS.md`.
- **Clients:** a tool that already calls `ctx.preliminary` will start sending activity snapshots to every client. AG-UI clients that don't know activity ignore it, and TanStack AI shows the activity message. Clients don't send activity back (`History.layerClient` already drops unknown roles), so reconciliation is unaffected.
- **Types:** `Agent.Event` and `AgUi.Event` gain a member, so a caller's exhaustive `switch` over either stops compiling until it handles the new case.
- **Overlap:** the open `interrupt-metadata` change also touches `AgUi.ts`, in the interrupt path.
