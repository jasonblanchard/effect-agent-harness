## Context

See proposal.md for why. What shapes the approach:

- `Agent.run` is a flat loop with one owner. Its checkpoint names (`system`, `model:<n>`, `tool:<callId>`) are keyed by `(threadId, runId, name)`, so a child running in the same run would collide with its parent.
- Tool handlers go through `toolkit.handle`, which reduces a handler to one final result. A child's events have nowhere to go from there.
- `AgUi.fold` tracks open text, reasoning and tool spans in one state and names steps `step-<n>`. Tool calls in a step run concurrently, so two children can stream at once.
- `Messages.project` reads every entry. `delta`'s divergence rule (`shown`) treats every shown entry as one the client must hold.
- `AgUi.Message` is lenient and strips unknown fields, so `subagentRunId` on an incoming message is lost today. Under the client history, a child's messages echoed back by the client would become the parent's turns.
- Approvals are already owner-blind where it helps: `pendingApprovals` scans every stored entry, and a child's step 0 resolves its own approvals through the existing `pendingDecisions` once its prompt is its own entries.
- The pinned AG-UI 1.0 schema and `@ag-ui/client` 1.0.3 already define the three lifecycle events and the `subagentRunId` attribution, so `verify` checks the new sequences without schema work.

## Goals / Non-Goals

**Goals:**

- A child is a full agent run inside the parent's run: checkpointed, replayable, traced, and streamed live.
- One thread holds every transcript, each read by owner.
- A child suspended for approval resumes through the parent with no new client protocol beyond AG-UI's.
- An agent without subagents is unchanged, event for event.

**Non-Goals:**

- Frontend tools in children.
- Router or handoff strategies (TanStack's `router`, `strategy: "handoff"`): the parent's model decides through tool calls only.
- Continuing a finished child in a later run (TanStack's `sessionId`).
- Limits shared across the tree (depth, concurrency, call count, timeout) beyond each agent's own step limit.
- A visibility switch for clients that don't know subagent events (LangGraph's `inline`/`hidden`). It can be added later as a `fold` option without changing the run.
- Per-subagent state: AG-UI state is run-scoped.

## Decisions

### A subagent is named by `Agent.name`

`define({ ..., subagents: { agents: [researcher, writer] } })`, where each entry of `agents` is an ordinary agent definition. The envelope holds settings that apply to all of a parent's subagents; it has only `agents` for now, and leaves room for limits (concurrency, depth, call count, timeout) or a routing strategy without adding sibling fields to `define` or making `subagents` a union of a list and an object. Per-child overrides, if ever needed, go inside `agents` as a wrapper (see below). A subagent's `name` is its telemetry name, the tool name the parent's model calls, and the lifecycle event's `name`: one name for one thing. What an agent needs in order to be delegated to lives on its own definition: `description`, `input` (a schema; default `{ prompt: string }`), `context` (`brief` or `conversation`) and `result`. They are ignored when the agent runs at the top level, except `description`, which is also written to telemetry (`gen_ai.agent.description`).

Because the name now reaches the model when the agent is a subagent, the parent's `define` checks each subagent and fails, with the same kind of error as an invalid step limit, when a subagent:

- has no name;
- has a name that isn't a valid tool name (1 to 64 letters, digits, `_` or `-`, the pattern the major providers share);
- has the same name as one of the parent's tools or another subagent.

A top-level agent's name is still never sent to the model, so its name may stay free-form.

`Requirements` becomes the union of the parent's and every child's requirements, recursively, computed from the element types of `agents` so a child's tool handlers and system prompt services surface on the parent.

*Alternative:* a record keyed by tool name, with `Agent.name` kept telemetry-only. Rejected: it gives a subagent two names that can drift apart, one in traces and one in the UI.

*Alternative:* delegation options (`context`, `result`) on a per-use wrapper (`Agent.subagent(agent, { context })`), so one agent can be delegated to differently by different parents. Not needed yet; it can be added later as an optional wrapper without changing the definition fields.

### The loop runs a child itself, not through the toolkit

A subagent call is recognised by the subagent's name before `toolkit.handle`. The loop runs `Agent.run` on the child, offering the child's events to the parent's queue wrapped as `{ _tag: "Subagent", subagentRunId, parent, event }`, where `parent` carries the spawning call, the parent step's message id and, for nested children, the enclosing subagent's id. The wrapper nests: a grandchild's events reach the root wrapped twice, and `fold` unwraps them. The child's terminal event becomes the call's `ToolStep`.

The subagent tool is a `Tool.dynamic` built from the input schema (default `{ prompt: string }`), added to the model toolkit beside frontend tools, so the model is offered it with its description and the parameters are decoded as for any tool.

*Alternative:* a tool handler streaming child events as preliminary results. Rejected: preliminary results are values, not events, and the handler would run inside one `tool:<id>` checkpoint, which hides the child's own checkpoints (see the risk below).

### Checkpoint names are prefixed; ids are derived from the call

The child runs with a checkpoint service that prefixes every name with `sub:<toolCallId>/`, so its `model:1` is `sub:tc1/model:1`. Nested children compound the prefix. The child is not wrapped in an outer checkpoint: its own steps make it deterministic, and only its outcome is memoised afterwards, under `tool:<toolCallId>`, so a replay of the parent's tool phase does not re-enter it.

`subagentRunId` is `subagentIdFor(toolCallId)` (`subagent:<toolCallId>`), as `approvalIdFor` is: no checkpoint is needed to mint it, a replay reproduces it, and a resumed run reuses it, which AG-UI asks for so a client reads the second `SUBAGENT_STARTED` as a continuation. The format is opaque to clients; only the library's conversions derive it.

### The child's prompt

- `brief` (default): the brief alone, as a user message rendered from the call's decoded input (the `prompt` string, or the input encoded as JSON).
- `conversation`: the user messages and assistant text of the prompt the parent's model received for the step that made the call, then the brief. The assistant message holding the call is left out: it may hold sibling calls that have no results yet, and the child would see them unanswered. The parent's system prompt, tool calls and tool results are left out too: the calls name tools the child may not have, and a provider can reject a request whose history holds tool calls when it offers no tools (Anthropic does). The child loses what the parent's tools returned; a parent that needs to pass it on puts it in the brief.

The brief is never stored. Every time the child runs, on its first run and on each resume, its prompt is rebuilt from the call: the parent prefix (under `conversation`), the brief from the call's input, then the child's own entries. Storing it was the first design, but a client never sees the brief (no event shows it), so under the client history a resumed child would have started with an assistant message, which providers reject. Rebuilding it is deterministic and works under both histories. Under `conversation`, the parent prefix is not copied either: on resume it is rebuilt from the parent's prompt, so a compacted thread gives the child the compacted prefix, as it gives the parent.

On resume, the Runner memoises the prompts of the suspended children (`Messages.projectSuspended`: one projection per suspended subagent call with no result, at any depth) next to the parent's prompt, and passes them to `Agent.run` as `subagentPrompts`. Each level passes the same map to its children; the ids are derived from globally unique call ids, so one flat map serves every depth.

### What the parent gets back

By default the child's final assistant text (the last step's text) is the tool result, and also `SUBAGENT_FINISHED.result`. `result: (outcome) => unknown` replaces both. A child ending `Failed` (model failure, step limit, a failing handler without `failureMode: "return"`) becomes a failed tool result holding the error message, and `SUBAGENT_ERROR` with the error's message and code. The parent's run continues, as with a `failureMode: "return"` tool. An interrupted child is the `Suspended` tool step below.

### Entries carry an owner; child entries are committed with the parent step

`Entry` gains `subagentRunId?: string`. A child does not commit its own steps. Its `StepFinished` entries are collected, tagged with the owner, and emitted inside the parent step's entries, between the parent's assistant entry and its tool results:

```
P1  assistant  call tc1                 (parent)
C1  assistant  call tc2 + approval req  subagent:tc1
R1  tool       result tc1               (parent)      ← absent while suspended
```

This keeps the thread in causal order, so `restore` places child messages after their spawning call with no new ordering rule, and the client can attach them to the call even though a messages snapshot doesn't carry `parentToolCallId`. Crash recovery doesn't need per-child commits: the child's steps are checkpointed.

`project(entries, owner?)` keeps the entries whose owner equals `owner` (none for the parent). Everything that builds a prompt passes the owner.

*Alternatives:* (A) never store child entries: a reload loses the child's work and suspension can't resume, and the client-history guard is needed anyway. (C) a separate thread per child: a second claim, two-store commits and a merge on read, and it's AG-UI's other model (a separate run with `parentRunId`).

### Divergence ignores child entries

`delta` checks only parent entries for `HistoryDiverged`, as it already skips reasoning. Clients that collapse subagents, or older clients behind the AG-UI shim, never hold child messages. A client that does send them back anchors on their ids normally. `ingest` still drops every client assistant and tool message, so a client cannot write child turns under the server history.

### Suspension

A child tool needing approval ends the child `Interrupted`. The parent's call becomes `ToolStep.Suspended { subagentRunId, approvals }`, where each approval carries its owner. The parent step ends `Interrupted` with its own approvals plus every descendant's. The spawning call in the parent's assistant entry gets the mark `options.agent.subagent` (as frontend calls get `options.agent.frontend`), which:

- carries the id of the assistant message holding the call, which the resumed child reports as `parentMessageId` (a prompt carries no message ids);
- puts it in `project`'s awaiting set, so it is not answered "did not complete";
- tells step 0 to re-enter it;
- is removed by `forModel`.

On resume:

1. Under the server history, `resume` answers the child's request as any other, and `decision` copies the request entry's owner onto the response.
2. Step 0 collects the parent's decided calls and its marked calls without results, and runs them concurrently. A marked call re-enters the child with `project(entries, subagentRunId)` as its prompt; the child's own step 0 resolves its approval.
3. If any re-entered child suspends again, or any decided call needs approval again, step 0 ends the run `Interrupted`. Otherwise step 0's results are appended and the model is called.

Nesting needs nothing more: a suspended child's own call to a grandchild is marked in the child's entry, and its step 0 re-enters the grandchild. Only the direct owner lists `interruptIds` on its `SUBAGENT_FINISHED`; ancestors suspend with none, as AG-UI allows.

Under the client history, marks don't survive the round trip. `fromHistory` marks an unanswered call when the history holds messages tagged `subagentIdFor(call.id)`, and attaches resume answers to child calls with the child's owner. A client that dropped the child's messages gets today's behaviour: the call gets a failed result and the resume entry is ignored.

`cancelled` keeps its meaning: the child's call is denied with reason "cancelled", and the child's model decides what to do.

### AG-UI projection

`fold` keeps its span state per owner (a map keyed by `subagentRunId`, with the parent under no key). Step names stay `step-<n>`; AG-UI scopes steps to their owner, and every child step event is tagged. For a `Subagent` event, `fold` emits `SUBAGENT_STARTED` on the child's first event, tags every projected child event with `subagentRunId`, closes the child's open spans before its terminal event, and maps the child's terminal event to `SUBAGENT_FINISHED` (success, or `suspended` with the interrupt ids it owns) or `SUBAGENT_ERROR`. The child's `RUN_*` events are never emitted. A successful child's `SUBAGENT_FINISHED` carries the result its parent receives, which exists only once the parent's tool step for the call is recorded, so `fold` holds it until the parent's `ToolResult` for the spawning call and emits it just before `TOOL_CALL_RESULT`; a failed or suspended child closes on its own terminal event. `closeOpen` (a resumed detached log) closes the spans an attempt left open under their owners' attribution, and leaves subagents open: the detached runner passes the earlier log to `fold` as `resumed`, so the attempt that completes the run continues a child the log left open without a second `SUBAGENT_STARTED`, and does not close one the log already closed.

### Telemetry

A child's model and tool spans nest under an `invoke_agent {name}` span for the subagent call (not `execute_tool`: the GenAI conventions name an agent invocation `invoke_agent`, and a top-level run's root span already is one), with `gen_ai.agent.name`, `gen_ai.agent.description` and `gen_ai.tool.call.id`. A failed child ends it with an error status and `error.type`. The child runs again on a replay, so its agent span is opened again, but its replayed steps open no model or tool spans. The parent's run attributes reach the child's spans the same way they reach the parent's.

## Risks / Trade-offs

- [Checkpoints under `layerWorkflow`] Never wrap a child in an outer checkpoint: an activity inside another activity's body would be skipped on replay, and with it the child's own activities. → Spike result (task 1.1): under `WorkflowEngine.layerMemory`, a parent activity, two concurrent children with `sub:<id>/` activities, and an outcome memo per child run correctly as sibling activities; an execution suspended mid-child and resumed replays every completed activity without running it, runs only the remaining ones, and completes.
- [Step 0 is now a loop phase that can interrupt] Today step 0 always yields results. → Specified scenarios for the mixed case (a parent approval and a suspended child in one step), tested under both histories.
- [Snapshot gap] AG-UI messages carry `subagentRunId` but not the spawning call. Clients place child messages by order. → `restore` order is specified; the TanStack client's reconstruction is checked in the example.
- [Unbounded resumes] A child that keeps requesting approval can run indefinitely across runs, as a parent can. → Accepted; same as today.
- [Cost of `conversation` mode] Each child call re-sends the parent's history. → `brief` is the default.
- [`interrupt-metadata` overlap] Both changes alter `approvalInterrupt`. → Whichever lands second rebases.

## Migration Plan

Additive. `Entry.subagentRunId` is optional, so existing thread stores and stored threads keep working. An agent without subagents emits the same events and stores the same entries.
