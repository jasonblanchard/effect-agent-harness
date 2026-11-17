## 1. Spike

- [x] 1.1 In a scratch test, run a parent whose tool phase runs a second loop with prefixed checkpoint names, followed by an outcome memo, under `Checkpoint.layerWorkflow` inside an `effect/workflow` execution; crash it mid-child and resume. Record the result in design.md and adjust the checkpoint decision if nested activities are not supported.

## 2. Entries and projection

- [x] 2.1 Add optional `subagentRunId` to `Messages.Entry` and to the lenient `AgUi.Message`
- [x] 2.2 Give `Messages.project` an owner and keep only that owner's entries; leave calls marked as suspended subagent calls unanswered
- [x] 2.3 Add `subagentIdFor(toolCallId)` and the subagent mark (`options.agent.subagent`) with its predicate in `Agent.ts`; remove the mark in `forModel`
- [x] 2.4 Tests: projection by owner, the mark survives `project` and is removed by `forModel`, threads without owners project as before

## 3. Definition and child runs

- [x] 3.1 Add `subagents` (an envelope, `{ agents }`) and the subagent options (`description`, `input`, `context`, `result`) to `define`/`Agent`; fail when a subagent is unnamed, has a name that isn't a valid tool name, or clashes with a tool or another subagent; compute `Requirements` across children; write `description` to telemetry
- [x] 3.2 Offer each subagent to the model as a `Tool.dynamic` with the input schema or `{ prompt }`; offer children no frontend tools
- [x] 3.3 Add a checkpoint wrapper that prefixes names with `sub:<toolCallId>/`, composing for nested children
- [x] 3.4 Run a subagent call in the tool phase: build the child's prompt (brief, or the parent step's prompt plus the brief), run `Agent.run` on the child, forward its events wrapped as `Subagent` events, memoise its outcome under `tool:<toolCallId>`
- [x] 3.5 Turn the child's outcome into the call's result (last text or the result conversion; failure as a failed result) and collect its entries, tagged with the owner, into the parent step's entries between the assistant entry and the tool entries
- [x] 3.6 Tests (agent level, scripted models): child runs and replies, brief and conversation prompts, failure and step limit, two concurrent children, nested child, replay after a crash runs each child handler once with the same id, an agent without subagents emits identical events

## 4. Suspension

- [x] 4.1 Add `ToolStep.Suspended`, an owner on `Agent.Approval`, and mark the spawning call on the parent's assistant entry; the parent step ends `Interrupted` with its own and its descendants' approvals
- [x] 4.2 Generalise step 0: resolve decided calls and marked calls without results concurrently, re-entering each child with its own entries; end `Interrupted` if anything waits again
- [x] 4.3 Server history: `decision` copies the request's owner onto the response; `pendingApprovals` reports the owner
- [x] 4.4 Client history: `fromHistory` keeps tagged messages as owned entries, marks an unanswered subagent call whose child's messages are present, and answers child approvals with the child's owner
- [x] 4.5 Tests under both histories: child suspends and resumes (approved, denied, cancelled), mixed parent and child approvals, child waits again, grandchild resumes through its parent, client that dropped the child's messages falls back to a failed result, `UnansweredInterrupt` covers a child's request

## 5. Server history

- [x] 5.1 `delta`: leave owned entries out of the divergence check
- [x] 5.2 `restore`/`shown`: tag owned messages with `subagentRunId`, keep child messages between the spawning call and its result, and attribute open interrupts
- [x] 5.3 Tests: client with and without child messages is not rejected, read of a thread with a subagent, read of a suspended child answered from the read's messages, `withoutReplayed` with an active run that ran a child

## 6. AG-UI projection

- [x] 6.1 `AgUi.fold`: span state per owner; `SUBAGENT_STARTED` on a child's first event; `subagentRunId` on every projected child event; close a child's spans before its closing event; `SUBAGENT_FINISHED` (success with result, suspended with the interrupt ids it owns) or `SUBAGENT_ERROR`; drop the child's terminal run events
- [x] 6.2 `approvalInterrupt` carries `subagentRunId`
- [x] 6.3 `closeOpen`: close open child spans under their owners and leave a child the resumed detached log left open to `fold`, which continues it from the earlier log (`resumed`) without a second `SUBAGENT_STARTED`, and publishes the result of a child that finished but whose result the earlier attempt never published
- [x] 6.4 Tests through `runAgUi`, every sequence through `verify`: lifecycle and attribution, interleaved children, child stream ending mid-message, suspended and resumed child (same `subagentRunId`), grandchild interrupt ids, detached run crashed mid-child and completed

## 7. Telemetry

- [x] 7.1 Nest a child's model and tool spans under the spawning call's span, named and attributed as an agent invocation; settle the design's open question on the span name
- [x] 7.2 Tests with `recordingTracer`: span tree for a child, no spans for a replayed child

## 8. Docs and example

- [x] 8.1 Update `packages/effect-agent-harness/AGENTS.md` (modules, resume rules, invariants: child checkpoints are prefixed, child entries are owned and never reach the parent prompt) and the README
- [x] 8.2 Add a subagent to the tanstack example, rebuild its cards in the hydrate from `History.restore`, render them in the page, and add manual browser checks for them to its `AGENTS.md`
- [x] 8.3 Run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` and fix every finding
- [x] 8.4 Run the tanstack example's manual browser checks 12 to 14 (needs a browser and `ANTHROPIC_API_KEY`)
