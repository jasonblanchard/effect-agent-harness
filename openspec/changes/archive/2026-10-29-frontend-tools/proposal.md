## Why

AG-UI lets a client advertise tools of its own in `RunAgentInput.tools`: the agent proposes a call, and the application runs it and answers in the next run's `messages`. effentic currently ignores `tools` and drops every client `tool` message. As a result, a client such as TanStack AI, which sends its client tools and runs them as soon as their calls stream, cannot use them with an effentic backend at all.

## What Changes

- **Advertised tools are offered to the model.** The run input decoder keeps `tools` (`name`, `description`, JSON Schema `parameters`). Each run's model call gets the agent's own toolkit plus one dynamic tool per advertised tool, taken as the client sent it. If an advertised tool has the same name as a server tool, the server tool wins and the client's entry is ignored. A later option may restrict which advertised tools are accepted. This change accepts them all, so the library follows the spec and works with TanStack AI without configuration.
- **Frontend calls are left to the client.** A call to an advertised tool runs no handler and gets no `TOOL_CALL_RESULT`, and the run makes no tool message for it. The run stops after the step that made the call. Server calls in the same step still run.
- **The run finishes as a success.** `RUN_FINISHED` has outcome `success` and lists the calls still pending in `pendingToolCallIds`, in the order they were made. A run that stops on a frontend call is not interrupted.
- **Mixed steps work.** A step may make server calls, frontend calls and calls that need approval together. Server calls run, frontend calls stay pending, and approval requests interrupt the run as they do today. The interrupt outcome carries no `pendingToolCallIds`: the client finds the pending calls from the stream, as the spec says. The next run answers both kinds, `resume` entries for the approvals and tool messages for the frontend calls. Approved calls then run in step 0, and the model is called once every call in the step has a result.
- **The client answers its own calls, and nothing else.** The stored assistant entry marks which of its calls belong to the client. A client `tool` message becomes a stored tool result only if it answers a marked call that has no result yet, and an `error` makes it a failed result. Every other client tool message is still dropped, so a client still cannot write results for server calls.
- **Every pending call must be answered.** A run that continues a thread without answering every pending frontend call is rejected before anything is committed, just as an unanswered approval is rejected today. The prompt never fills in a result the client didn't send.
- **History shows pending calls.** `Messages.history` returns the frontend calls still waiting for an answer, next to the open interrupts, so a client that reloads can answer them.
- **The `tanstack` example** gets a client tool, plus manual checks for a frontend call on its own and for a mixed step (a server tool, a client tool and an email that needs approval in one request).
- Not breaking. Clients that advertise no tools see no difference.

`design.md` lists the questions still open, among them how TanStack continues after a mixed step and how tool sets that change between runs are handled.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-run`: the run takes the client's tool definitions; a call to one runs no handler and stays pending; the continuation rule stops after a step with a pending frontend call; the success outcome carries the pending calls.
- `agui-agent-loop`: `RUN_FINISHED` carries `pendingToolCallIds`; the client's delta may carry tool messages that answer marked pending calls; every pending frontend call must be answered, alongside every open approval; a mixed step is answered with both resume entries and tool messages.
- `agui-transport-edge`: the lenient run input decoder keeps `tools` instead of ignoring it.
- `thread-history-read`: a read thread includes the frontend calls still pending.
- `thread-store`: a compacted thread must also keep every assistant entry holding a frontend call that has no result yet.

## Impact

- `packages/effentic/src/AgUi.ts`: `RunAgentInput.tools`; `fold` sets `pendingToolCallIds` on the success outcome.
- `packages/effentic/src/Agent.ts`: a per-run toolkit with dynamic tools; a pending state for a tool call; the continuation rule; `Outcome.Success` gains the pending calls; the marker on stored calls, stripped before the model sees it.
- `packages/effentic/src/Messages.ts`: `ingest` accepts answers to marked calls, `project` leaves pending frontend calls alone, `history` returns them, and a new check for unanswered calls runs next to `resume`.
- `packages/effentic/src/Runner.ts`: passes the advertised tools to the agent and reports unanswered frontend calls before committing.
- `packages/effentic/test`: frontend calls on their own, mixed steps, unanswered calls, forged results for server calls, name collisions, replay after a crash, and history reads. Every sequence goes through `verify`.
- `packages/examples/tanstack`: a client tool and its manual checks; `AGENTS.md` for the example and the library.
- No new dependencies. `Tool.dynamic` and `Toolkit.merge` already exist in `effect/ai`, and `@ag-ui/core@1.0.3` already types `pendingToolCallIds`.
- **Overlap:** `interrupt-metadata` also changes `fold`'s `RUN_FINISHED` outcome (metadata on interrupts). This change touches the success outcome only. Whichever lands second rebases onto the other.
