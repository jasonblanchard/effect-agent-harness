## Why

AG-UI 1.0 defines subagents: one agent delegates part of a run to another, and the client sees the child's work attributed to it (`SUBAGENT_STARTED`/`FINISHED`/`ERROR` and `subagentRunId` on every event and message the child produces). Delegation is the usual way to keep a parent's context small and to give a focused task its own tools and instructions, and TanStack AI, the client in our example, already renders subagents. Today an agent can only call tools, so a library user who wants a child agent has to run it inside a tool handler, where its events, checkpoints, history and approvals are all lost.

## What Changes

- An agent definition MAY declare subagents: `subagents: { agents: [...] }`, a list of other agent definitions inside an envelope that leaves room for settings covering all of them (such as limits). A subagent is named by its own `name`, which is then both its telemetry name and the tool name the parent's model calls, so a subagent must have one. An agent definition also gains what it needs as a subagent: a description, an optional input schema (default: a `prompt` string), a context mode (`brief`, the default, or `conversation`), and an optional way to turn its outcome into the tool result (default: its final text).
- Each subagent is offered to the parent's model as a tool. A call runs the child agent inside the parent's run: same thread id, run id, checkpoint store and services; its own system prompt, tools and step limit; its checkpoint names prefixed by the call so they never collide with the parent's.
- A child's id (`subagentRunId`) is derived from the call that spawned it, so a replayed or resumed run gives it the same id.
- The AG-UI stream carries `SUBAGENT_STARTED` (with `parentToolCallId`, `parentMessageId` and, for nested children, `parentSubagentRunId`), every child event tagged with `subagentRunId`, and `SUBAGENT_FINISHED` or `SUBAGENT_ERROR`, before the spawning call's `TOOL_CALL_RESULT`. Several children may stream at once.
- A child's failure, including its step limit, ends the child with `SUBAGENT_ERROR` and gives the parent a failed tool result; the parent's run continues.
- A thread entry MAY name the subagent that owns it. Child entries are committed with the parent step that spawned them, between its assistant entry and its tool results. The parent's prompt never contains them; a child's prompt is built from its own entries. The child's brief is not stored: it is rebuilt from the call each time the child runs.
- Reading a thread returns child messages tagged with `subagentRunId`, after the call that spawned them. A client is not required to hold child messages: their absence is not divergence.
- The client history reads `subagentRunId` from incoming messages and keeps tagged messages out of the parent's prompt.
- **Suspension:** a child tool that needs approval suspends the child (`SUBAGENT_FINISHED` with outcome `suspended` and the interrupt ids it owns) and interrupts the parent's run with that interrupt, attributed to the child. The next run answers it with a `resume` entry as for any approval; the parent's step 0 re-enters the child, which resolves the approval in its own step 0 and continues. Nested children suspend and resume the same way.
- Children are not offered the client's frontend tools.

## Capabilities

### New Capabilities

- `agent-subagents`: declaring subagents, offering them to the model, running a child inside the parent's run (context, checkpoints, ids, result, failure), and suspending and resuming a child.
- `agui-subagent-events`: projecting child runs onto AG-UI: lifecycle events, attribution of child events, independent span tracking per subagent, and attribution of child interrupts.

### Modified Capabilities

- `agent-run`: the definition gains subagents; step 0 also re-enters suspended subagent calls and may end interrupted; step entries include the child entries; the model never receives the subagent mark.
- `agui-agent-loop`: the server prompt holds only parent entries; child entries are not checked for divergence; approval interrupts and recorded responses carry the owning subagent.
- `run-history`: the client history keeps tagged messages out of the parent prompt, recognises a suspended subagent call by its child's messages, and answers child approvals.
- `thread-history-read`: the read tags child messages, places child messages after the spawning call, and attributes open interrupts to their subagent.

## Impact

- `Agent.ts`: `define` and `Agent` (subagents, `Requirements` as the union of parent and children), `Event` (child events wrapped with their owner), `Approval` and `Outcome` (owner), `ToolStep` (suspended), step 0, a mark for subagent calls removed by `forModel`.
- `AgUi.ts`: `fold` state per owner, the three lifecycle events, `approvalInterrupt` with `subagentRunId`, `subagentRunId` on the lenient input `Message`.
- `Messages.ts`: `Entry.subagentRunId`; `project` filters by owner.
- `internal/conversions.ts`: `delta`, `fromHistory`, `resume`/`decision`, `restore`, `shown`.
- `Telemetry`: a child's spans nest under the parent's tool span, which becomes an agent span.
- `Thread` stores: none beyond storing the new optional `Entry` field; existing threads read unchanged. Compaction must keep the entries of a suspended child.
- Overlaps the open `interrupt-metadata` change, which also changes the approval interrupt; whichever lands second rebases its `approvalInterrupt` change.
- Examples: the tanstack example can demonstrate a subagent once TanStack's client accepts the events from this server.
- Not breaking: an agent without subagents emits exactly what it does today.
