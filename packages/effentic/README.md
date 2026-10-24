# effentic

Build [AG-UI](https://docs.ag-ui.com) agents with [Effect](https://effect.website).

effentic runs an agent (a model, a set of tools, a system prompt) and streams the run to any AG-UI client, such as `@ag-ui/client`'s `HttpAgent` or CopilotKit. It is built on `effect/ai`, so it works with any Effect model provider.

The agent's _behaviour_ is kept separate from _durability_. You define the agent once as a plain value. Then you choose, by providing layers, how much of the run survives a crash, a deploy or a dropped connection:

| Plane   | Service      | What it gives you                                                         |
| ------- | ------------ | ------------------------------------------------------------------------- |
| Thread  | `Thread`     | The server owns each thread's history; clients only send what is new.     |
| Compute | `Checkpoint` | Model and tool calls are memoised, so a resumed run never repeats a tool. |
| Stream  | `EventLog`   | A run's events are stored with cursors, so clients can reconnect.         |

The same agent runs in a unit test with none of these (in-memory or passthrough layers) and in production with all of them.

> Status: `0.0.1`, built on Effect v4 (`effect@4.0.5`). `effect/ai` and `effect/workflow` are unstable upstream, and so is this API.

## Contents

- [Quick start](#quick-start)
- [Defining an agent](#defining-an-agent)
- [Running over AG-UI](#running-over-ag-ui)
- [Threads](#threads)
- [Authentication and run context](#authentication-and-run-context)
- [Tool approvals](#tool-approvals)
- [Durable runs](#durable-runs)
- [Reconnecting to a run](#reconnecting-to-a-run)
- [Testing and evals](#testing-and-evals)
- [Writing your own stores](#writing-your-own-stores)
- [Module reference](#module-reference)

## Quick start

A weather agent served as an AG-UI endpoint, backed by Anthropic:

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, Effect, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Agent, AgUi, Checkpoint, Runner, Sse, Thread } from "effentic";

// 1. Tools
const GetWeather = Tool.make("get-weather", {
  description: "Get current weather for a location",
  parameters: Schema.Struct({ location: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Finite }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return", // failures go back to the model instead of ending the run
});
const Tools = Toolkit.make(GetWeather);
const ToolsLayer = Tools.toLayer({
  "get-weather": ({ location }) => Effect.succeed({ temperature: 18 }),
});

// 2. The agent: behaviour only, no provider, no stores
const weather = Agent.define({
  toolkit: Tools,
  system: "You are a friendly weather assistant.",
});

// 3. A model
const ModelLayer = AnthropicLanguageModel.layer({ model: "claude-haiku-5-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer),
);

// 4. An AG-UI route
const AgentRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const runAgent = yield* Runner.make(weather);
    yield* router.add(
      "POST",
      "/agent",
      HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
        Effect.map((input) =>
          HttpServerResponse.stream(Sse.encode(runAgent(input)).pipe(Stream.encodeText), {
            contentType: Sse.contentType,
          }),
        ),
        Effect.orElseSucceed(() => HttpServerResponse.text("Invalid RunAgentInput", { status: 400 })),
      ),
    );
  }),
).pipe(Layer.provide(Layer.mergeAll(ModelLayer, ToolsLayer, Thread.layerMemory, Checkpoint.layerNone)));

export const { handler } = HttpRouter.toWebHandler(AgentRoute);
```

On the client:

```ts
import { HttpAgent, randomUUID } from "@ag-ui/client";

const agent = new HttpAgent({ url: "http://localhost:3000/agent", threadId: "t1" });
agent.messages.push({ id: randomUUID(), role: "user", content: "Weather in Paris?" });
await agent.runAgent({}, { onTextMessageContentEvent: ({ event }) => process.stdout.write(event.delta) });
```

[`packages/examples/ag-ui`](../examples/ag-ui) is a complete, runnable version, including tool approvals and the detached routes.

## Defining an agent

```ts
const agent = Agent.define({
  toolkit: Tools, // an effect/ai Toolkit
  system: "…", // optional system prompt: text, or an effect (below)
  maxSteps: 10, // optional, a positive integer; default 10
});
```

`define` throws a `RangeError` if `maxSteps` is not a positive integer. The result is a plain value: it names no model provider and no store.

### A system prompt computed per run

`system` can be an effect. It runs once per run, before anything else, and its result is memoised (as the `system` checkpoint), so a resumed run sends the same text. It can read the run it's in through `Agent.CurrentRun`, and any services it uses become part of what the agent requires:

```ts
const agent = Agent.define({
  toolkit: Tools,
  system: Effect.gen(function* () {
    const run = yield* Agent.CurrentRun; // { runId, threadId, props, context }
    const { principal } = yield* Schema.decodeUnknownEffect(AppContext)(run.context);
    const user = yield* (yield* UserDirectory).get(principal.userId);
    return `You are helping ${user.displayName}. Today is ${new Date().toDateString()}.`;
  }).pipe(Effect.orDie),
}); // requires UserDirectory; never CurrentRun, which Agent.run provides
```

The effect's error type is `never`: handle failures inside it (fall back to a default) or let it die, which fails the run before any tool or model call.

The system prompt is the first thing in every model call, so text that changes on every run defeats prefix prompt caching across a long thread. Keep the parts that change small.

### Tools that need the run

A tool handler can read the run too. Declare `Agent.CurrentRun` as a dependency:

```ts
const ListMyOrders = Tool.make("list-my-orders", {
  parameters: Schema.Struct({}),
  success: Schema.Array(Order),
  dependencies: [Agent.CurrentRun],
});

const handler = () =>
  Effect.gen(function* () {
    const run = yield* Agent.CurrentRun;
    const { principal } = yield* Schema.decodeUnknownEffect(AppContext)(run.context);
    return yield* orders.recent(principal.userId);
  }).pipe(Effect.orDie);
```

Services that are the same for every run (a database, an HTTP client) are better captured when the handlers' layer is built.

A run is a sequence of **steps**. Each step makes one model call. If the model asks for tools, the loop runs them (after the model call has finished) and starts the next step with their results. The run ends when one of these happens:

- the model stops calling tools;
- a tool needs approval;
- the step limit is reached (`StepLimitExceeded`).

Tool tips:

- Use `failureMode: "return"` for tools whose failures the model should see and react to. With the default `"error"`, a failing handler fails the run.
- Use `needsApproval` for tools that must not run without the user. See [Tool approvals](#tool-approvals).

## Running over AG-UI

`Runner` connects an agent to AG-UI. All runners do the same work for each run:

1. Load the thread from the `Thread` store.
2. Take the new messages from the client, plus its answers to the previous run's interrupts.
3. Run the agent with the run's info (below), committing each finished step to the thread.
4. Emit AG-UI events.

Pick a runner by what should happen when the client goes away:

| Runner                | A client disconnect…              | Requires                                          |
| --------------------- | --------------------------------- | ------------------------------------------------- |
| `Runner.run` / `make` | cancels the run (model and tools) | `Thread`, `Checkpoint`, model, tools              |
| `Runner.makeDetached` | does nothing; the run continues   | the above + `EventLog`, `Scope`                   |
| `Runner.workflow`     | does nothing; an engine owns it   | the above (minus `Checkpoint`) + `WorkflowEngine` |

`Runner.make` captures the services once and returns a function whose streams need nothing, so they can be used directly as response bodies. `Runner.run` is the same, but leaves the requirements on each stream.

Guarantees for every runner:

- **The stream never fails.** Errors arrive in-band as `RUN_ERROR`, with `code` set to the error's tag (`ModelStreamError`, `StepLimitExceeded`, `HistoryMismatch`, `ThreadError`, a provider error such as `RateLimitError`, …).
- **Every sequence is valid AG-UI.** It starts with `RUN_STARTED` and ends with one `RUN_FINISHED` or `RUN_ERROR`. Text messages, tool calls and steps are always closed, including when a run fails mid-message.

What a client sees for a tool-using reply:

```
RUN_STARTED
STEP_STARTED step-1
  TEXT_MESSAGE_START / CONTENT… / END
  TOOL_CALL_START / ARGS… / END
  TOOL_CALL_RESULT
STEP_FINISHED step-1
STEP_STARTED step-2
  TEXT_MESSAGE_START / CONTENT… / END
STEP_FINISHED step-2
RUN_FINISHED { outcome: { type: "success" } }
```

`RUN_ERROR.message` carries the underlying error's message, which may include provider details. If your clients are untrusted, map the stream to rewrite it.

`Runner` takes options as a second argument:

```ts
Runner.make(agent, { clientSystem: "allow" }); // default "drop"
```

`clientSystem` controls `system` / `developer` messages sent by the client. By default they are dropped, so only your `system` prompt instructs the model.

### Run info

Every run gets an `Agent.RunInfo`, which the system prompt and tools read through `Agent.CurrentRun`:

| Field      | From                                            | Trust     |
| ---------- | ----------------------------------------------- | --------- |
| `runId`    | the AG-UI input                                 |           |
| `threadId` | the AG-UI input                                 |           |
| `props`    | the input's `forwardedProps`, unchanged         | untrusted |
| `context`  | whoever starts the run, via `Runner.RunOptions` | trusted   |

```ts
runAgent(input, { context: { principal } }); // the function Runner.make returns; Runner.run(agent)(input, …) alike
detached.start(input, { context: { principal } });
workflow.execute({ input, context: { principal } }, { discard: true });
```

Nothing in the AG-UI input can set `context`. See [Authentication and run context](#authentication-and-run-context).

## Threads

The server owns the history. A client like `HttpAgent` sends its whole history on every run. effentic keeps only the **delta**, meaning the messages after the last one whose id the store already has, and from it accepts only:

- `user` messages that have text;
- `system` / `developer` messages, and only with `clientSystem: "allow"`.

Assistant and tool messages from the client are always ignored, so a client cannot invent a model turn or a tool result. If the store has entries but the client's history shares no id with them, the run fails with `HistoryMismatch` and the model is not called.

Ids line up because the server mints them. Every assistant step and tool result is stored under the same id it was sent to the client with (`messageId` in `TEXT_MESSAGE_*` / `TOOL_CALL_RESULT`).

The model prompt is the agent's system prompt followed by whatever `Thread.load` returns, unchanged. Two adjustments are made only so providers accept it:

- a stored tool call that never got a result is answered with a failed result;
- tool results are placed directly after their calls.

**Compaction is up to you.** To summarise a long thread, return a summary entry from `load` in place of the history it covers. `runEnded` is called once per run, after the last commit, however the run ended (success, approval interrupt or failure, even one before the model is called), which makes it a natural place to trigger compaction. The one exception is a run that was cancelled, such as a request-scoped run whose client disconnected: it hasn't ended, and running it again finishes it.

`load` is also what each run reconciles the client against, so a compacted thread must keep:

- **the latest entries the client has seen**, with their ids. The client's new messages are those after the last one whose id `load` returns. If none of its ids are returned, the run fails with `HistoryMismatch`.
- **every assistant entry with an unanswered approval request.** `resume` answers are matched against these, and an answer to a request that isn't loaded is ignored.

In practice: summarise older history, and keep the tail from the last user message on.

`Thread.layerMemory` keeps threads in process memory. For production, implement the service over your database ([below](#writing-your-own-stores)).

The system prompt is never stored in the thread: the agent adds it to every model call.

## Authentication and run context

effentic never sees the request's credentials. The route authenticates, and passes the result to the runner as `context`:

```ts
yield *
  router.add(
    "POST",
    "/agent",
    Effect.gen(function* () {
      const principal = yield* authenticate; // verify the bearer token: signature, expiry, audience
      const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
      yield* threadOwners.authorize(input.threadId, principal); // see below
      return sse(Sse.encode(runAgent(input, { context: { principal } })));
    }).pipe(/* Unauthorized → 401, Forbidden → 403, decode errors → 400 */),
  );
```

Three rules:

- **Put the verified principal in `context`, not the raw token.** `context` is persisted by `Runner.workflow` (and may end up in logs), and a token can expire before a resumed run reaches a tool. A tool that calls another API as the user should get credentials from a service keyed by the principal.
- **Check that the principal may use the thread.** `threadId` comes from the client, and `Thread.load` does no access control, so without a check a signed-in user can send someone else's thread id and read its history. `Thread` sees only ids, so do this in the route: claim an unknown thread for the caller, and reject one that belongs to someone else.
- **Treat `props` as untrusted.** They are whatever the client sent. Use them to choose between values you know (a locale, a display mode), and don't paste them into the system prompt.

## Tool approvals

Mark a tool that needs the user's go-ahead:

```ts
const SendEmail = Tool.make("send-email", {
  parameters: Schema.Struct({ to: Schema.String, body: Schema.String }),
  success: Schema.Struct({ sent: Schema.Boolean }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
  needsApproval: true, // or (params, { toolCallId, messages }) => boolean | Effect<boolean>
});
```

When the model calls it, the handler does not run. Other tool calls in the same step still run. The run ends with an AG-UI **interrupt**:

```json
{
  "type": "RUN_FINISHED",
  "outcome": {
    "type": "interrupt",
    "interrupts": [
      { "id": "…", "reason": "tool-approval", "toolCallId": "…", "message": "Approve call to send-email?" }
    ]
  }
}
```

The client answers in its next run with `resume`:

```ts
await agent.runAgent(); // ends with agent.pendingInterrupts.length === 1
const [interrupt] = agent.pendingInterrupts;
await agent.runAgent({
  resume: [{ interruptId: interrupt.id, status: "resolved", payload: { approved: true } }],
});
```

The answered call is executed (or denied) before the model is called again, and the model then sees the result. The rules:

- **Approved** only when `status` is `"resolved"` and `payload.approved === true`. Anything else is a denial. `payload.reason` is passed to the model as the reason.
- `status: "cancelled"` is denied with reason `"cancelled"`.
- A pending approval the next run does not answer is denied with reason `"not answered"`, so the thread never gets stuck.
- Resume entries for unknown interrupt ids are ignored.

A denied call gets the failed result `{ "type": "execution-denied", "reason": "…" }`.

If a `needsApproval` predicate fails or throws, the tool is treated as not needing approval, which matches `effect/ai`.

## Durable runs

### Checkpoints

Every model call and every tool call in a run goes through `Checkpoint.memo`, under the names `model:<step>` and `tool:<toolCallId>`. The message and approval ids are minted inside these checkpoints as well. So if you run the same `runId` again against a durable checkpoint store:

- steps that completed are replayed from the store, with the same ids and without calling the model or the tool again;
- only the step that was in progress is executed again, with fresh ids.

| Layer                          | Use                                                              |
| ------------------------------ | ---------------------------------------------------------------- |
| `Checkpoint.layerNone`         | Tests, evals, stateless servers: always executes, never replays. |
| `Checkpoint.layerLedger`       | Your own store, via the `Checkpoint.Ledger` service.             |
| `Checkpoint.layerMemoryLedger` | An in-memory `Ledger`, for tests and local development.          |
| `Checkpoint.layerWorkflow`     | `effect/workflow` activities (used by `Runner.workflow`).        |

A step that _failed_ is stored too, so re-running a failed run fails again the same way; retry with a new `runId`. Only work that was interrupted (a crash, a deploy, a cancelled fiber) is executed again.

The projected thread is memoised as well (as `prompt`), and so is a computed system prompt (as `system`). A resumed run therefore sees the same history and the same system prompt as the attempt that crashed, even if the thread was compacted or the system prompt's services changed in between.

### Detached runs

`Runner.makeDetached` decouples a run from the request that started it. `start` forks the run into the scope you give it and returns at once. The run's events go to the `EventLog`.

```ts
const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // HttpRouter.use provides the layer's Scope; runs live as long as the router.
    // `principal` comes from authenticating the request, as in Authentication and run context.
    const runner = yield* Runner.makeDetached(agent);
    yield* router.add(
      "POST",
      "/runs",
      HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
        Effect.flatMap((input) =>
          Effect.as(runner.start(input, { context: { principal } }), HttpServerResponse.empty({ status: 202 })),
        ),
      ),
    );
  }),
);
```

Calling `start` again with the same input and context completes a crashed attempt (the context isn't stored, so pass the one the first call had):

- if the log already ends with `RUN_FINISHED` / `RUN_ERROR`, it does nothing;
- otherwise it closes whatever the earlier attempt left open in the log and continues;
- steps replayed from the checkpoint store publish no events.

Use a durable `Checkpoint` so finished tool calls aren't repeated. Supervision is up to you, and the same run must not be started twice concurrently.

### Workflow runs

To have `effect/workflow` own runs (persisted, resumed after restarts, deduplicated by `runId`), use `Runner.workflow`:

```ts
const { workflow, layer } = Runner.workflow(agent);

// Register `layer` with your engine (WorkflowEngine.layerMemory in tests,
// ClusterWorkflowEngine in production), then start runs:
yield * workflow.execute({ input, context: { principal } }, { discard: true });
```

The payload (`Runner.WorkflowPayload`: the input and the context) is what the engine persists, so a resumed execution sees the original context; the context must be JSON-encodable. Executing the same `runId` again joins the existing execution. Resuming a suspended execution is the engine's job: `workflow.resume(yield* workflow.executionId(payload))`.

## Reconnecting to a run

The `EventLog` stores each run's AG-UI events under increasing cursors. `subscribe(runId, after?)` returns the stored events after `after`, then live events, and completes after the terminal event. `Sse.encodeStored` turns cursors into SSE `id`s, so a browser `EventSource` reconnects with `Last-Event-ID` and gets each event exactly once:

```ts
yield *
  router.add(
    "GET",
    "/runs/:runId/events",
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const { runId } = yield* HttpRouter.schemaPathParams(Schema.Struct({ runId: Schema.String }));
      const headers = yield* HttpServerRequest.schemaHeaders(
        Schema.Struct({ "last-event-id": Schema.optional(Schema.String) }),
      );
      return HttpServerResponse.stream(
        Sse.encodeStored(log.subscribe(runId, headers["last-event-id"])).pipe(Stream.encodeText),
        { contentType: Sse.contentType },
      );
    }),
  );
```

`EventLog.layerMemory` keeps logs in process memory.

## Testing and evals

The core loop doesn't depend on AG-UI or any store. `Agent.run(agent)({ runId, threadId, props?, context?, prompt })` takes the run info and an effect/ai `Prompt` (without the system prompt, which the agent adds) and emits `Agent.Event`s:

| Event               | When                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `StepStarted`       | A model step begins (`step`, `messageId`).                             |
| `ModelPart`         | A streamed model part, live.                                           |
| `ToolResult`        | A tool call's result (`encodedResult`, `isFailure`).                   |
| `ApprovalRequested` | A tool call waits for approval.                                        |
| `StepFinished`      | A step ends; `entries` are the thread entries it produced.             |
| `Finished`          | The run ended: `Success`, or `Interrupted` with the pending approvals. |
| `Failed`            | The run failed (`error`, `code`). Nothing follows.                     |

Events served from the checkpoint store carry `replayed: true`.

That makes evals and unit tests straightforward: provide a model (real or scripted), the tool handlers, and `Checkpoint.layerNone`:

```ts
import { Effect, Stream } from "effect";
import { Prompt } from "effect/ai";

const events =
  yield *
  Agent.run(agent)({
    runId: "eval-1",
    threadId: "eval",
    prompt: Prompt.make([{ role: "user", content: "Weather in Paris?" }]),
  }).pipe(Stream.runCollect, Effect.provide([ModelLayer, ToolsLayer, Checkpoint.layerNone]));
```

Provide an `IdGenerator` (from `effect/ai`) to make message ids deterministic.

To check how the agent behaves for different users or settings, pass the run info as literals and provide mock services. The same definition is used, and no HTTP, token or runner is involved:

```ts
Agent.run(agent)({
  runId: "eval-2",
  threadId: "eval",
  context: { principal: { userId: "u1", tenantId: "acme" } },
  prompt,
}).pipe(
  Stream.runCollect,
  Effect.provide([
    ModelLayer,
    ToolsLayer,
    Layer.succeed(UserDirectory)({ get: () => Effect.succeed({ displayName: "Grace" }) }),
    Checkpoint.layerNone,
  ]),
);
```

To project core events onto AG-UI yourself, use `AgUi.fold({ threadId, runId })`. To check that a sequence is valid AG-UI in tests, run it through `@ag-ui/client`'s `verifyEvents`.

## Writing your own stores

Each plane is a `Context.Service`. Implement it with your store and provide it as a layer.

**Thread:** `commit` must be idempotent by entry id, because a resumed run commits the same entries again. If `load` returns a compacted thread, it must keep what runs reconcile against ([Threads](#threads)).

```ts
const ThreadLive = Layer.effect(
  Thread.Thread,
  Effect.gen(function* () {
    const db = yield* Database;
    return Thread.Thread.of({
      // entries in commit order; [] for an unknown thread
      load: (threadId) => db.loadEntries(threadId),
      // append each entry whose id is not stored yet, in order
      commit: (threadId, runId, entries) => db.appendNew(threadId, entries),
      // once per run, after its last commit: a hook for compaction or bookkeeping
      runEnded: (threadId, runId, outcome) => Effect.void,
    });
  }),
);
```

Entries are `{ id, message }` with `message` an effect/ai `Prompt.Message`. `Schema.encode(Thread.Entry)` gives you JSON to store. Wrap store failures in `ThreadError`.

**Checkpoint ledger:** a get/set store keyed by `(runId, name)`. The values are JSON-encoded `Exit`s.

```ts
const LedgerLive = Layer.succeed(Checkpoint.Ledger)({
  get: (runId, name) => kv.get(`${runId}/${name}`), // Effect<Option<unknown>, LedgerError>
  set: (runId, name, exit) => kv.set(`${runId}/${name}`, exit),
});
const CheckpointLive = Checkpoint.layerLedger.pipe(Layer.provide(LedgerLive));
```

**Event log:** `append` assigns a cursor strictly greater than every earlier cursor of the run. `subscribe` must deliver history and then live events, each exactly once, and complete after `RUN_FINISHED` / `RUN_ERROR`. See `EventLog.layerMemory` for the reference behaviour (subscribe to live events _before_ reading history, then drop duplicates).

## Module reference

Everything is exported from `"effentic"` as namespaces.

| Module       | Main exports                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Agent`      | `define`, `run`, `Agent`, `RunInfo`, `RunInput`, `CurrentRun`, `Event`, `Outcome`, `Requirements`, `StepLimitExceeded`, `ModelStreamError` |
| `AgUi`       | `RunAgentInput`, `ResumeEntry`, `decodeRunAgentInput`, `Event`, `fold`, `closeOpen`, event constructors                                    |
| `Runner`     | `run`, `make`, `makeDetached`, `workflow`, `Options`, `RunOptions`, `WorkflowPayload`                                                      |
| `Thread`     | `Thread`, `Entry`, `RunOutcome`, `ThreadError`, `layerMemory`                                                                              |
| `Checkpoint` | `Checkpoint`, `Ledger`, `LedgerError`, `layerNone`, `layerLedger`, `layerMemoryLedger`, `layerWorkflow`                                    |
| `EventLog`   | `EventLog`, `Stored`, `EventLogError`, `layerMemory`                                                                                       |
| `Messages`   | `delta`, `ingest`, `resume`, `project`, `HistoryMismatch`: the building blocks the runners use                                             |
| `Sse`        | `encode`, `encodeEvent`, `encodeStored`, `contentType`                                                                                     |
