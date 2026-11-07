# effect-agent-harness

This is an experimental library that answers the question: what would it look like to have an effect native agent harness that is AG-UI compatible and has first class, pluggable extension points for 3 planes of durability:

- **Durable message history** - for recovering the full conversation state
- **Durable streaming** - for reading and reconnecting to streaming output
- **Durable compute** - for graceful handling of compute interrupts (i.e. a rolling deploy or a crashe)

## Core primitives

- **Agent** - the behavior (tools and system prompt) of the agent itself. Defined outside its runner so that it can be evaluated in isolation without runtime concerns like state, durability, etc.
  - **Plugin (todo)** - a wrapper for adding behavior to an agent (agent)(args) => agent
  - Subagents (todo) - a thin wrapper around tools that make them behave like subagents per the AG-UI spec
- **Runner** - the container that orchestrates the agent loop. This is where the Agent is decorated with runtime concerns like state, durability, etc. Choose between in-process, detached, effect workflow, or bring your own.
- **History** - how messages state is prepared for a run. Choose between client authoritative history or server authoritative history.
- **Thread** - abstract thread storage and lifecycle. Use the built ins or bring your own.
- **Checkpoint** - captures moments of the agent lifecycle that you would joirnal in a durable compute log.
- **EventLog** - Stream of AG-UI events. Use the built ins (ie SSE, in memory) or bring your own (durable streams)

All other agent harness functionality is a composition of these core primitives or effect’s core primitives:

- Compaction - Thread lifecycle / system prompt construction
- Generated media capture and display- Thread lifecycle
- Memory - tool definitions, system prompt construction, Thread lifecycle
- Model provider compatibility - delegated to Effect core
- Skills - tool definitions and system prompt construction
- ...TBD

In some cases, this may trade off “batteries included” library completeness for simplicity. That’s ok. The goal is simple ideas that avoid library sprawl while encapsulating just enough to provide a “pit success” for making agents with effect.

## Stability

⚠️ Under construction ⚠️

# Robo documentation

Build [AG-UI](https://docs.ag-ui.com) agents with [Effect](https://effect.website).

effect-agent-harness runs an agent (a model, a set of tools, a system prompt) and streams the run to any AG-UI client, such as `@ag-ui/client`'s `HttpAgent` or CopilotKit. It is built on `effect/ai`, so it works with any Effect model provider.

The agent's _behaviour_ is kept separate from _durability_. You define the agent once as a plain value. Then you choose, by providing layers, how much of the run survives a crash, a deploy or a dropped connection:

| Plane   | Service      | What it gives you                                                          |
| ------- | ------------ | -------------------------------------------------------------------------- |
| History | `History`    | Who owns the transcript: the client (default), or the server, in `Thread`. |
| Compute | `Checkpoint` | Model and tool calls are memoised, so a resumed run never repeats a tool.  |
| Stream  | `EventLog`   | A run's events are stored with cursors, so clients can reconnect.          |

The same agent runs in a unit test with none of these (in-memory or passthrough layers) and in production with all of them.

> Status: `0.0.1`, built on Effect v4 (`effect@4.0.5`). `effect/ai` and `effect/workflow` are unstable upstream, and so is this API.

## Contents

- [Quick start](#quick-start)
- [Defining an agent](#defining-an-agent)
- [Running over AG-UI](#running-over-ag-ui)
- [Histories](#histories)
- [Authentication and run context](#authentication-and-run-context)
- [Tool approvals](#tool-approvals)
- [Frontend tools](#frontend-tools)
- [Durable runs](#durable-runs)
- [Reconnecting to a run](#reconnecting-to-a-run)
- [Testing and evals](#testing-and-evals)
- [Writing your own stores](#writing-your-own-stores)
- [Module reference](#module-reference)

## Quick start

A weather agent served as an AG-UI endpoint, backed by Anthropic:

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Config, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Agent, AgUi, Checkpoint, Runner, Sse } from "effect-agent-harness";

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

// 4. An AG-UI route. An attached runner: a client disconnect cancels the run.
const runAgent = Runner.makeAttached(weather);

const AgentRoute = HttpRouter.add(
  "POST",
  "/agent",
  HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
    // `Sse.response` closes over the handler's context: the body is read after the handler has returned.
    Effect.flatMap((input) => Sse.response(Sse.encode(runAgent(input)))),
    Effect.orElseSucceed(() => HttpServerResponse.text("Invalid RunAgentInput", { status: 400 })),
  ),
  // The handler's services come from the app layer's output: merge them in rather than hide them.
).pipe(Layer.provideMerge(Layer.mergeAll(ModelLayer, ToolsLayer, Checkpoint.layerNone)));

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

`system` can be an effect. It runs once per run, before anything else, and its result is memoised (as the `system` checkpoint), so a resumed run sends the same text. It can read the run it's in through `Agent.CurrentRun` (`{ runId, threadId, props }`), and any services it uses become part of what the agent requires, including per-run ones such as the current user (see [Authentication and run context](#authentication-and-run-context)):

```ts
const agent = Agent.define({
  toolkit: Tools,
  system: Effect.gen(function* () {
    const user = yield* CurrentUser;
    return `You are helping ${user.displayName}. Today is ${new Date().toDateString()}.`;
  }),
}); // requires CurrentUser; never CurrentRun, which Agent.run provides
```

The effect's error type is `never`: handle failures inside it (fall back to a default) or let it die, which fails the run before any tool or model call.

The system prompt is the first thing in every model call, so text that changes on every run defeats prefix prompt caching across a long thread. Keep the parts that change small.

### Tools that need the run or the user

A tool handler can read services that differ per run, too. Declare them as dependencies: `Agent.CurrentRun` for the run's ids and props, or a per-run service such as `CurrentUser`:

```ts
const ListMyOrders = Tool.make("list-my-orders", {
  parameters: Schema.Struct({}),
  success: Schema.Array(Order),
  dependencies: [CurrentUser],
});

const handler = () =>
  Effect.gen(function* () {
    const user = yield* CurrentUser;
    return yield* orders.recent(user.userId);
  });
```

A dependency becomes part of what the agent requires, so an eval provides `CurrentUser` directly, and a runner builds it for each run. Services that are the same for every run (a database, an HTTP client) are better captured when the handlers' layer is built.

A run is a sequence of **steps**. Each step makes one model call. If the model asks for tools, the loop runs them (after the model call has finished) and starts the next step with their results. The run ends when one of these happens:

- the model stops calling tools;
- a tool needs approval;
- the step limit is reached (`StepLimitExceeded`).

Tool tips:

- Use `failureMode: "return"` for tools whose failures the model should see and react to. With the default `"error"`, a failing handler fails the run.
- Use `needsApproval` for tools that must not run without the user. See [Tool approvals](#tool-approvals).

## Running over AG-UI

`Runner` connects an agent to AG-UI. All runners do the same work for each run:

1. Build the per-run services from the dependencies the caller provided. See [Authentication and run context](#authentication-and-run-context).
2. Check the input against what was stored for its run id (`RunInputMismatch` if it differs).
3. Build the prompt from the run's history. By default that is the client's messages as sent; with `History.layerServer` it is the stored thread, which the run claims and loads, plus what the client may add to it. See [Histories](#histories).
4. Run the agent with the run's info (below), the client's frontend tools and its per-run services. Under the server history, each finished step is committed to the thread.
5. Emit the terminal event. Under the server history, the run's end is reported to the store (`runEnded`) and the thread released first.

AG-UI events are emitted throughout.

Pick a runner by what should happen when the client goes away:

| Runner                | A client disconnect…              | Requires                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------ |
| `Runner.makeAttached` | cancels the run (model and tools) | `Checkpoint`, model, tools, and what the per-run layer needs |
| `Runner.makeDetached` | does nothing; the run continues   | the above + `EventLog`, `Scope`                              |
| `Runner.makeWorkflow` | does nothing; an engine owns it   | the above (minus `Checkpoint`) + `WorkflowEngine`            |

None of them requires a thread store: a run's history is optional, and `History.layerServer` brings its own `Thread`.

`Runner.makeAttached` returns a plain function: nothing is captured, and each stream requires the agent's services. A route calls it inside its handler and returns `Sse.response(Sse.encode(stream))`. Because the body is read after the handler has returned, `Sse.response` closes over the handler's context, so whatever the stream still needs becomes a requirement of the handler. It also sets `text/event-stream` and `cache-control: no-cache`; `headers` and `status` are merged over them. With `effect/http`, keep those services in the app layer's output (`Layer.provideMerge`): the web handler provides them to every request, while `Layer.provide` would hide them and leave the handler asking for a context argument. For the same reason, a per-request service the route forgets to provide, such as the principal, is not reported at the route but where the web handler is built or called. On another transport, close over the context yourself (`Stream.provideContext(yield* Effect.context())`) and use `Sse.encode` and `Sse.contentType`.

Guarantees for every runner:

- **The stream never fails.** Errors arrive in-band as `RUN_ERROR`, with `code` set to the error's tag (`ModelStreamError`, `StepLimitExceeded`, `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt`, `UnansweredToolCall`, `RunInputMismatch`, `ThreadBusy`, `ThreadError`, an error from the per-run layer, a provider error such as `RateLimitError`, …).
- **Every sequence is valid AG-UI.** It starts with `RUN_STARTED` and ends with one `RUN_FINISHED` or `RUN_ERROR`. Text messages, reasoning, tool calls and steps are always closed, including when a run fails mid-message.

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
Runner.makeAttached(agent, { clientSystem: "allow" }); // default "drop"
```

`clientSystem` controls `system` / `developer` messages sent by the client, under either history. By default they are dropped, so only your `system` prompt instructs the model.

### Reasoning

Each reasoning block a model step produces streams as one span holding one message, before or between the step's text: `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`…, `REASONING_MESSAGE_END`, `REASONING_END`, all under the block's own `messageId`. That id is stable, so [`History.restore`](#reloading-a-thread) returns the block under the same id. Treat its format as opaque.

effect-agent-harness has no option for this. Reasoning appears when the model produces it, so you enable it in the provider layer:

```ts
// Without `display`, the Anthropic API returns thinking blocks with no text, so nothing streams.
// @effect/ai-anthropic's type doesn't declare it yet, hence the separate constant.
const thinking = { type: "adaptive", display: "summarized" } as const;

const ModelLayer = AnthropicLanguageModel.layer({ model: "claude-haiku-5-5", config: { thinking } });
```

Once enabled, reasoning reaches **every client**, on the stream and through `restore`, and it can hold content you wouldn't show users. To hide it, leave it off in the model layer, or filter the `REASONING_*` events by mapping the stream.

Only a block's text is sent. Provider metadata such as a signature stays on the stored parts, so the model still gets its reasoning back on later steps and runs under the server history, but no event carries it (`REASONING_ENCRYPTED_VALUE` isn't emitted). A block with no text, such as a redacted one, emits nothing. Under the client history, the client's `reasoning` messages are dropped, so reasoning doesn't return to the model between runs.

### Run info

Every run gets an `Agent.RunInfo`, which the system prompt and tools read through `Agent.CurrentRun`:

| Field      | From                                    | Trust     |
| ---------- | --------------------------------------- | --------- |
| `runId`    | the AG-UI input                         |           |
| `threadId` | the AG-UI input                         |           |
| `props`    | the input's `forwardedProps`, unchanged | untrusted |

Trusted data such as the verified principal is not run info. Whoever starts the run provides it as a service (a per-run dependency), and the agent reads it as services the runner builds per run:

```ts
runAgent(input).pipe(Stream.provideService(AuthContext, principal)); // runAgent = Runner.makeAttached(agent, …)
detached.start(input).pipe(Effect.provideService(AuthContext, principal));
start(input).pipe(Effect.provideService(AuthContext, principal)); // from Runner.makeWorkflow
```

Nothing in the AG-UI input can set a per-run dependency. See [Authentication and run context](#authentication-and-run-context).

## Histories

AG-UI has the client send its whole history with every run. Who owns that history is a deployment decision, made by providing a `History` to the run:

| History                     | The run's prompt is…                              | Use it when                                                                                             |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| client (default, no wiring) | the client's messages, as sent                    | the client owns its conversation: a chat that keeps its own state, edits and regenerates turns          |
| `History.layerServer`       | the stored thread, plus the client's new messages | the server must own the transcript: a thread shared between users or devices, or kept beyond the client |

### Client history

With nothing provided, the client owns the transcript. Its messages are converted as sent, under their own ids, and nothing is stored, claimed or released:

- user text, and `system` / `developer` messages only with `clientSystem: "allow"`;
- assistant text and tool calls. A call whose arguments aren't a JSON object, such as one cut off by a cancelled run, is dropped with its results, with a logged warning;
- `tool` messages as their call's result, decoded like a [frontend tool](#frontend-tools) result, the first per call. One whose call isn't in the history is dropped with a logged warning;
- other roles are dropped.

Edited and regenerated histories are taken as sent, and two runs on one thread may run at once. [Approvals](#tool-approvals) and [frontend calls](#frontend-tools) work from the history alone: an interrupt's id is derived from its tool call (`Agent.approvalIdFor`), so a `resume` entry answers the unanswered call it names. The run can't know what the previous run left open, so it never fails with `UnansweredInterrupt` or `UnansweredToolCall`: a call with no result and no answer is sent to the model with a failed result. Compaction is the client's concern too, since it sends everything on every run.

### Server history

Provide `History.layerServer` with a `Thread` store, keeping `Thread` in the app layer's output if a route of yours reads it ([below](#reloading-a-thread)):

```ts
Layer.mergeAll(
  ModelLayer,
  ToolsLayer,
  Checkpoint.layerNone,
  History.layerServer.pipe(Layer.provideMerge(Thread.layerMemory)),
);
```

The server owns the history, in the `Thread` store. A client like `HttpAgent` sends its whole history on every run. effect-agent-harness keeps only the **delta**, meaning the messages after the last one the store already has, and from it accepts only:

- `user` messages that have text;
- `system` / `developer` messages, and only with `clientSystem: "allow"`;
- `tool` messages answering a [frontend call](#frontend-tools) the previous run left to the client.

Assistant messages from the client are always ignored, and so are tool messages for anything but a pending frontend call, so a client cannot invent a model turn or a server tool's result.

Ids line up because the server mints them. Every assistant step and tool result is stored under the same id it was sent to the client with (`messageId` in `TEXT_MESSAGE_*` / `TOOL_CALL_RESULT`). A client message is matched against the store by that id. A `tool` message is also matched by its `toolCallId`, because some clients (TanStack AI) send tool results back under ids of their own. Client messages the store doesn't know are ignored, such as the text of a step that was cancelled before it committed.

Two histories are rejected before anything is committed or the model is called:

- **`HistoryMismatch`:** the store has entries, but none of the client's messages match them.
- **`HistoryDiverged`:** the client lacks a stored message that comes after the last one it has, because it edited or regenerated a turn, or missed a step. Appending its new messages would put them after history it doesn't have, so the run fails instead. Edits and branches aren't supported. A client that gets this should read the thread again ([below](#reloading-a-thread)). Entries the client was never shown (system entries, approval responses) don't count, and nor do the steps an earlier attempt of the same run committed.

The model prompt is the agent's system prompt followed by whatever `Thread.load` returns, unchanged. Two adjustments are made only so providers accept it:

- a stored tool call that never got a result is answered with a failed result;
- tool results are placed directly after their calls.

**One run at a time.** A thread has at most one active run, because each run reconciles the client against what it loaded and commits on top of it. The run claims the thread (`Thread.claim`) before loading it, and a run started while another is active ends at once with `RUN_ERROR` code `ThreadBusy`, without touching the thread. The claim is released after the run's last commit and before its `RUN_FINISHED` / `RUN_ERROR` is sent, so a client can start the next run as soon as it sees the last one end. `HttpAgent` already runs one run at a time per agent, so `ThreadBusy` usually means a second tab or a run that is still going in the background.

- A request-scoped run (`makeAttached`) that is cancelled releases the thread.
- A detached or workflow run that crashes keeps it: the thread stays busy until the run is resumed and ends. A durable store should expire a claim after longer than any run takes, so a crashed run that is never resumed doesn't hold its thread for ever.
- The same run claims again when it resumes, so starting the same run twice at once is not prevented.

**Compaction is up to you.** To summarise a long thread, return a summary entry from `load` in place of the history it covers. `runEnded` is called once per run that claimed the thread, after the last commit and while the run still holds the thread, however the run ended (success, approval interrupt or failure, even one before the model is called), which makes it a natural place to trigger compaction. A run rejected before claiming the thread (a failed per-run layer, `RunInputMismatch`, `ThreadBusy`) is not reported. Nor is a run that was cancelled, such as a request-scoped run whose client disconnected: it hasn't ended, and running it again finishes it.

`load` is also what each run reconciles the client against, so a compacted thread must keep:

- **the latest entries the client has seen**, with their ids. The client's new messages are those after the last one whose id `load` returns. If none of its ids are returned, the run fails with `HistoryMismatch`.
- **every assistant entry with an unanswered approval request.** `resume` answers are matched against these, and an answer to a request that isn't loaded is ignored.
- **every assistant entry with a pending frontend call**, with its tool-call parts' `options` intact (they mark the call as the client's). The client's results are matched against these, and a result for a call that isn't loaded is ignored.
- **nothing new after what the client has seen.** Write a summary as a `system` entry, or put it before the latest entries the client has seen. A user, assistant or tool entry the client never saw, placed after them, makes its next run fail with `HistoryDiverged`.

In practice: summarise older history into a system entry, and keep the tail from the last user message on.

#### Reloading a thread

A reloaded page, or another device, has no history to send. Its first run would fail with `HistoryMismatch`, and it wouldn't know which approvals are still open. `History.restore` loads a thread from `Thread` and turns it back into what its runs' events showed, for the client to restore. It makes no claim, so it can be read while a run is active:

```ts
const { messages, interrupts, pendingToolCalls } = yield * History.restore(threadId);
// messages: AG-UI messages (user, reasoning, assistant, tool), with the ids and content the events carried
// interrupts: { runId, pending } for approvals still open (as RUN_FINISHED carried them), or undefined
// pendingToolCalls: { runId, toolCallIds } for frontend calls still waiting for a result, or undefined
```

The library doesn't serve this route. Expose it as a `GET` of your own, and authorise the thread there just as you do for runs. The client sets its messages to `messages`, answers each of `interrupts.pending` with a `resume` entry in its next run, and each of `pendingToolCalls.toolCallIds` with a `tool` message. A client that sends `messages` back, with new user messages after them, is matched like one that streamed them. `messages` is AG-UI's own `Message` type, so adapt it if your client has its own, and don't assume `content` is a string. System entries and approval responses are not returned. Tool results come directly after their calls, and a step's `reasoning` messages come directly before its assistant message, even a block the model produced after its text, because that message has one `content`. A client may send `reasoning` messages back or drop them: they are never committed, and neither choice causes `HistoryMismatch` or `HistoryDiverged`. `interrupts.runId` is the run that raised them, which TanStack AI needs. It is `undefined` if the store didn't record it.

TanStack AI's `useChat` does this itself with `persistence: true`: on mount it calls `GET <chat url>?threadId=…` and expects `{ messages, interrupts, activeRun }`, with `messages` as its own `UIMessage`s. Leave its `history.pageSize` unset: with paging on, it sends only the messages it hasn't loaded from the server, which effect-agent-harness rejects with `HistoryMismatch`. The `tanstack` example serves this route.

`Thread.layerMemory` keeps threads in process memory. For production, implement the service over your database ([below](#writing-your-own-stores)).

The system prompt is never stored in the thread: the agent adds it to every model call.

### Choosing per request

The history is read from the run's context, so one runner can serve both:

```ts
const runAgent = Runner.makeAttached(agent);
// A shared thread: the server owns it.
runAgent(input).pipe(Stream.provide(History.layerServer));
// A scratch chat: the client owns it.
runAgent(input);
```

`History.layerClient` forces the client history where a server history is provided further out. A detached runner uses the history in the context it was built in, unless one is provided around `start`. A workflow uses the one in the context its `layer` is built in, and can't vary it per run, because a replayed execution has only its persisted payload: register a second workflow for the other history.

### Security model

Neither history is an authorization boundary. A client that writes the prompt can already steer the model into any tool call it could forge, so:

- **Tool handlers and per-run dependencies are the authorization boundary.** Check access in handlers, against the verified principal the route provides ([below](#authentication-and-run-context)), never against anything in the input.
- **`needsApproval` protects the user from the model**, not the server from the client. Under the client history, a client that drops a call's result from its history and approves it again runs the handler again, so make side-effecting handlers idempotent, or use the server history.
- **The history decides who owns the transcript.** Under the server history, a client can't invent a model turn or a server tool's result; under the client history, it can, and that only affects its own conversation.

## Authentication and run context

effect-agent-harness never sees the request's credentials. The route authenticates, and provides the result to the run as a service, the way any Effect dependency is provided. The agent can require that service directly, or a per-run `layer` turns it into the services the agent requires:

```ts
// What the route provides for each run: the principal it verified.
class AuthContext extends Context.Service<AuthContext, { readonly userId: string }>()("app/Auth") {}

// What the agent requires. An ordinary service: an eval provides it directly.
class CurrentUser extends Context.Service<CurrentUser, User>()("app/CurrentUser") {}

// Builds CurrentUser for each run from its AuthContext.
const CurrentUserLayer = Layer.effect(CurrentUser)(
  Effect.gen(function* () {
    const { userId } = yield* AuthContext;
    return yield* (yield* UserDirectory).get(userId);
  }),
);

const runAgent = Runner.makeAttached(agent, { layer: CurrentUserLayer });

const AgentRoute = HttpRouter.add(
  "POST",
  "/agent",
  Effect.gen(function* () {
    const principal = yield* authenticate; // verify the bearer token: signature, expiry, audience
    const input = yield* HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput);
    yield* threadOwners.authorize(input.threadId, principal); // see below
    // It closes over the handler's context, which holds UserDirectory and the rest.
    return yield* Sse.response(Sse.encode(runAgent(input).pipe(Stream.provideService(AuthContext, principal))));
  }).pipe(/* Unauthorized → 401, Forbidden → 403, decode errors → 400 */),
);
```

How it fits together:

- **The principal is a requirement of each run.** `Runner.makeAttached` captures nothing: `AuthContext` is on the stream like every other service, so a run whose `AuthContext` isn't provided fails to typecheck. If auth middleware already provided it to the route, the handler's context holds it, and closing over that context (as `sse` does) provides it. A detached or workflow runner captures its services when it's built, so it names the per-run ones instead, `dependencies: [AuthContext]`, and leaves them on `start`. An agent without per-run services adds no requirement.
- **The layer is ordinary Effect.** It reads `AuthContext` like any service, and services that depend on each other compose as layers do (a tenant from the user, say). What it needs besides, such as `UserDirectory`, stays on the stream too, provided the same way as the stores. What it provides is not required from outside.
- **It's built for every run attempt, before the thread is claimed.** A run that fails to build it ends with `RUN_ERROR` (code: the error's tag), claims nothing and isn't reported to the store. Its finalizers run when the attempt ends. It's not memoised: a resumed run builds it again, so steps not yet run see the new services. A computed system prompt is memoised (as `system`), though, so it keeps the first attempt's text.
- **You can provide the layer yourself with `makeAttached`.** Leave `layer` out and provide it on each run's stream: `runAgent(input).pipe(Stream.provide(CurrentUserLayer), Stream.provideService(AuthContext, principal))`. It's still built per run, but a failure to build it fails the stream (a broken response) instead of ending the run with `RUN_ERROR`. Detached and workflow runs need `layer`: a detached run's services must outlive the call to `start`, and a workflow rebuilds them from its persisted dependencies on every replay.
- **"Context" means two things here.** A per-run service is an entry in the run's Effect context (the services it can `yield*`). It's unrelated to the AG-UI input's own `context` field, which never reaches it.
- **Keys must be unique**, as for any Effect service: two services with the same key are one service.

Three rules:

- **Put the verified principal in a dependency, not the raw token.** A workflow's dependencies are persisted by `Runner.makeWorkflow` (and may end up in logs), and a token can expire before a resumed run reaches a tool. A tool that calls another API as the user should get credentials from a service keyed by the principal.
- **Check that the principal may use the thread.** `threadId` comes from the client, and `Thread.load` does no access control, so without a check a signed-in user can send someone else's thread id and read its history. `Thread` sees only ids, so do this in the route: claim an unknown thread for the caller, and reject one that belongs to someone else. This is also the only check runs need. The client picks `runId` too, but effect-agent-harness keys everything it stores for a run (checkpoints, the workflow execution, the event log) by thread id _and_ run id, so a run id reused on another thread finds nothing. Routes that read a run, such as an event stream, take the thread id as well and check it the same way.
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
      {
        "id": "…",
        "reason": "tool-approval",
        "toolCallId": "…",
        "message": "Approve call to send-email?",
        "responseSchema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": { "approved": { "type": "boolean" }, "reason": { "type": "string" } },
          "required": ["approved"],
          "additionalProperties": true
        }
      }
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

- **Approved** only when `status` is `"resolved"` and `payload` is an approval response (`AgUi.ApprovalResponse`, `{ approved: boolean, reason?: string }`) with `approved: true`. Anything else is a denial. `payload.reason` is passed to the model as the reason. Each approval interrupt carries this contract as its `responseSchema`, so a generic client can tell what to send.
- A `resolved` answer whose payload is not an approval response, such as `{ approve: true }` or `"yes"`, is denied, and the runner logs a warning naming the interrupt ids.
- `status: "cancelled"` is denied with reason `"cancelled"`.
- **Every open interrupt must be answered.** Under the server history, a run on the thread that leaves one out fails with `RUN_ERROR` code `UnansweredInterrupt`, and nothing it sent is committed. AG-UI 1.0 forbids treating a missing answer as a decision, and `HttpAgent` already refuses to send such a run. To move on without approving, for example when the user types a new message instead, answer each open interrupt with `status: "cancelled"` in the same run as the new message. Under the client history, an unanswered call is sent to the model with a failed result instead ([Client history](#client-history)).
- Resume entries for unknown interrupt ids are ignored.

A denied call gets the failed result `{ "type": "execution-denied", "reason": "…" }`.

If a `needsApproval` predicate fails or throws, the tool is treated as not needing approval, which matches `effect/ai`.

## Frontend tools

A client can advertise tools of its own in `RunAgentInput.tools` (AG-UI frontend tools): the agent proposes a call, and the application runs it. TanStack AI's `useChat` sends its client tools this way, and `HttpAgent` sends the ones you pass to `runAgent({ tools })`. The server needs no code for them:

- **They're offered to the model next to the agent's tools**, with the name, description and JSON Schema the client sent. If one has the same name as a server tool, the server tool is offered and the client's is ignored, with a logged warning.
- **A call to one runs nothing on the server.** The call is streamed (`TOOL_CALL_START` / `ARGS` / `END`) but gets no `TOOL_CALL_RESULT`, other calls in the same step still run, and the run ends after that step with a **success** that names the calls left to the client:

  ```json
  { "type": "RUN_FINISHED", "outcome": { "type": "success", "pendingToolCallIds": ["toolu_…"] } }
  ```

- **The client answers in its next run's `messages`**, with one `tool` message per call, keyed by `toolCallId`. `error` makes it a failed result. Content that is JSON text is stored as the parsed value, any other text as itself, and a list of content parts as its text; other parts (images, files) are dropped with a logged warning, and the call is still answered. To decline a call, answer it saying so.
- **Every pending call must be answered.** Under the server history, a run on the thread that leaves one out fails with `RUN_ERROR` code `UnansweredToolCall`, and nothing it sent is committed. A client that abandons the thread answers nothing, which is fine.
- **A step can mix kinds.** If the model calls a server tool, a frontend tool and a tool that needs approval in one step, the server call runs and the run ends with the approval interrupt. AG-UI's interrupt outcome carries no `pendingToolCallIds`, so the client finds the frontend call in the stream. The next run must carry both the `resume` entry and the `tool` message (if both are missing, `UnansweredInterrupt` is reported); the approved call then runs before the model is called with every result.

The agent marks each frontend call on its stored assistant entry (in the tool-call part's `options`, removed before the model sees it). Under the server history, only a marked call that has no result can be answered by the client, and a server call left open by a crashed run can't be. Under the client history, a result is a `tool` message like any other.

**Advertised tools are untrusted input.** Their descriptions and schemas reach the model exactly as the client sent them, like a client system message. Only accept them from clients you'd let instruct the model.

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
| `Checkpoint.layerWorkflow`     | `effect/workflow` activities (used by `Runner.makeWorkflow`).    |

A step that _failed_ is stored too, so re-running a failed run fails again the same way; retry with a new `runId`. Only work that was interrupted (a crash, a deploy, a cancelled fiber) is executed again.

Checkpoints are keyed by thread id and run id, so the same `runId` on another thread is a different run. A run id names one input: the input is memoised (as `input`), and running the same `runId` on the same thread with a different input fails with `RunInputMismatch` before anything is committed or replayed. The caller's `context` is not part of the input, so a different context isn't detected: pass the one the run was first started with.

The projected thread is memoised as well (as `prompt`), and so is a computed system prompt (as `system`). A resumed run therefore sees the same history and the same system prompt as the attempt that crashed, even if the thread was compacted or the system prompt's services changed in between.

### Detached runs

`Runner.makeDetached` decouples a run from the request that started it. `start` forks the run into the scope you give it and returns at once. The run's events go to the `EventLog`.

```ts
const Routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // HttpRouter.use provides the layer's Scope; runs live as long as the router.
    // `principal` comes from authenticating the request, as in Authentication and run context.
    const runner = yield* Runner.makeDetached(agent, { dependencies: [AuthContext], layer: CurrentUserLayer });
    yield* router.add(
      "POST",
      "/runs",
      HttpServerRequest.schemaBodyJson(AgUi.RunAgentInput).pipe(
        Effect.flatMap((input) =>
          Effect.as(
            runner.start(input).pipe(Effect.provideService(AuthContext, principal)),
            HttpServerResponse.empty({ status: 202 }),
          ),
        ),
      ),
    );
  }),
);
```

`start` reads the dependencies when it's called, so a provider around it reaches the forked run. Calling `start` again with the same input and dependencies completes a crashed attempt, building its per-run services again (the dependencies aren't stored, so provide the ones the first call had):

- if the log already ends with `RUN_FINISHED` / `RUN_ERROR`, it does nothing;
- otherwise it closes whatever the earlier attempt left open in the log and continues;
- steps replayed from the checkpoint store publish no events.

Use a durable `Checkpoint` so finished tool calls aren't repeated. Supervision is up to you, and the same run must not be started twice concurrently. Under the server history, a crashed run keeps its thread claimed, so other runs on the thread fail with `ThreadBusy` until you start it again and it ends.

### Workflow runs

To have `effect/workflow` own runs (persisted, resumed after restarts, deduplicated by thread id and run id), use `Runner.makeWorkflow`. The engine persists each run's dependencies, so a workflow's dependencies must be `Runner.RunContext`s: a service key plus the schema its value is encoded with. A `RunContext` works anywhere a plain service does, so declaring the principal this way from the start costs nothing if a runner may move to a workflow later.

```ts
// In place of the plain Context.Service in Authentication and run context.
class AuthContext extends Runner.RunContext<AuthContext>()("app/Auth", {
  schema: Schema.Struct({ userId: Schema.String }),
}) {}

const { start, executionId, workflow, layer } = Runner.makeWorkflow(agent, {
  name: "support",
  dependencies: [AuthContext],
  layer: CurrentUserLayer,
});

// Register `layer` with your engine (WorkflowEngine.layerMemory in tests,
// ClusterWorkflowEngine in production), then start runs:
yield * start(input).pipe(Effect.provideService(AuthContext, principal));
```

`name` is required. The engine registers the workflow under it, derives execution ids from it and stores it with every execution. Give each agent on an engine its own name: two workflows with the same name replace each other's registration and share execution ids. Don't rename a workflow while it has executions in flight, because they would have no handler to resume them. A workflow's history is the one in the context `layer` is built in: provide `History.layerServer` to `layer` for the server history. Agents that share a `Thread` store and `EventLog` must not share thread ids either, since both stores key by thread.

`start` reads the dependencies' services and builds the payload the engine persists: the input and, when the runner has dependencies, their values, encoded with their schemas. A value a schema rejects makes `start` die before any execution exists. `start` doesn't wait for the run; observe it through the `EventLog`. A resumed execution sees the original dependencies and builds its per-run services again from them. Starting the same run (same `threadId` and `runId`) again joins the existing execution. Resuming a suspended execution is the engine's job: `workflow.resume(yield* executionId(input))`, with the same dependencies provided, because the engine derives the id from the encoded payload.

**Upgrading from an untyped `context`:** executions persisted before dependencies were declared carry `context: unknown`, which the new payload schema may reject. Let them finish before deploying, or register the new workflow under a new `name`.

## Reconnecting to a run

The `EventLog` stores each run's AG-UI events under increasing cursors, keyed by thread id and run id. `subscribe(threadId, runId, after?)` checks `after` and then returns a stream of the stored events after it, then live events, which completes after the terminal event (at once if `after` is already at or past it). A cursor the run's log never issued, such as a malformed `Last-Event-ID`, fails `subscribe` with `InvalidCursor` before any response starts, so the route can answer 400 instead of streaming nothing. `Sse.encodeStored` turns cursors into SSE `id`s, so a browser `EventSource` reconnects with `Last-Event-ID` and gets each event exactly once:

```ts
yield *
  router.add(
    "GET",
    "/threads/:threadId/runs/:runId/events",
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const { threadId, runId } = yield* HttpRouter.schemaPathParams(
        Schema.Struct({ threadId: Schema.String, runId: Schema.String }),
      );
      const principal = yield* authenticate;
      yield* threadOwners.authorize(threadId, principal); // as for POST /agent
      const headers = yield* HttpServerRequest.schemaHeaders(
        Schema.Struct({ "last-event-id": Schema.optional(Schema.String) }),
      );
      const events = yield* log.subscribe(threadId, runId, headers["last-event-id"]);
      return yield* Sse.response(Sse.encodeStored(events));
    }).pipe(
      Effect.catchTag("InvalidCursor", (error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
      ),
    ),
  );
```

`EventLog.layerMemory` keeps logs in process memory.

## Testing and evals

The core loop doesn't depend on AG-UI or any store. `Agent.run(agent, { runId, threadId, props?, prompt })` takes the run info and an effect/ai `Prompt` (without the system prompt, which the agent adds) and emits `Agent.Event`s:

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
  Agent.run(agent, {
    runId: "eval-1",
    threadId: "eval",
    prompt: Prompt.make([{ role: "user", content: "Weather in Paris?" }]),
  }).pipe(Stream.runCollect, Effect.provide([ModelLayer, ToolsLayer, Checkpoint.layerNone]));
```

Provide an `IdGenerator` (from `effect/ai`) to make message ids deterministic.

To check how the agent behaves for different users or settings, pass the run info as literals and provide the per-run services directly. The same definition is used, and no HTTP, token or runner is involved:

```ts
Agent.run(agent, { runId: "eval-2", threadId: "eval", prompt }).pipe(
  Stream.runCollect,
  Effect.provide([
    ModelLayer,
    ToolsLayer,
    Layer.succeed(CurrentUser)({ userId: "u1", displayName: "Grace" }),
    Checkpoint.layerNone,
  ]),
);
```

To project core events onto AG-UI yourself, use `AgUi.fold({ threadId, runId })`. To check that a sequence is valid AG-UI in tests, run it through `@ag-ui/client`'s `verifyEvents`.

## Writing your own stores

Each plane is a `Context.Service`. Implement it with your store and provide it as a layer.

**Thread:** `commit` must be idempotent by entry id, because a resumed run commits the same entries again. It must store each entry it appends with the commit's `runId`, and `load` must return it: `History.restore` names the run that raised open approvals from it, and a run executed again after a crash recognises its own earlier steps by it (without it, that run fails with `HistoryDiverged`). An entry that is already stored keeps its first run. If `load` returns a compacted thread, it must keep what runs reconcile against ([Server history](#server-history)). Only `History.layerServer` uses the store. `claim` must be atomic across processes, for example a conditional update of an `active_run_id` column, and should expire.

```ts
const ThreadLive = Layer.effect(
  Thread.Thread,
  Effect.gen(function* () {
    const db = yield* Database;
    return Thread.Thread.of({
      // entries in commit order, each with the runId that appended it; [] for an unknown thread
      load: (threadId) => db.loadEntries(threadId),
      // set active_run_id when it is null, already runId, or expired; else fail with ThreadBusy
      claim: (threadId, runId) => db.claimThread(threadId, runId),
      // clear active_run_id if it is runId
      release: (threadId, runId) => db.releaseThread(threadId, runId),
      // append each entry whose id is not stored yet, in order, recording runId on it
      commit: (threadId, runId, entries) => db.appendNew(threadId, runId, entries),
      // once per run that claimed the thread, after its last commit: a hook for compaction or bookkeeping
      runEnded: (threadId, runId, outcome) => Effect.void,
    });
  }),
);
```

Entries are `{ id, message, runId? }` with `message` an effect/ai `Prompt.Message`. `Schema.encode(Messages.Entry)` gives you JSON to store. Wrap store failures in `ThreadError`.

**Checkpoint ledger:** a get/set store keyed by `(threadId, runId, name)`. The values are JSON-encoded `Exit`s. Keep all three in the key: the client picks `runId`, so it is only unique within a thread.

```ts
const LedgerLive = Layer.succeed(Checkpoint.Ledger)({
  get: (threadId, runId, name) => kv.get(JSON.stringify([threadId, runId, name])), // Effect<Option<unknown>, LedgerError>
  set: (threadId, runId, name, exit) => kv.set(JSON.stringify([threadId, runId, name]), exit),
});
const CheckpointLive = Checkpoint.layerLedger.pipe(Layer.provide(LedgerLive));
```

**Event log:** runs are keyed by `(threadId, runId)`. `append` assigns a cursor strictly greater than every earlier cursor of the run. `subscribe` must check the cursor before returning its stream (failing with `InvalidCursor` for one the run's log never issued), deliver history and then live events, each exactly once, and complete after `RUN_FINISHED` / `RUN_ERROR`, including at once when the cursor is at or past it. `read` rejects unknown cursors the same way. See `EventLog.layerMemory` for the reference behaviour (subscribe to live events _before_ reading history, then drop duplicates).

## Module reference

Everything is exported from `"effect-agent-harness"` as namespaces.

| Module       | Main exports                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`      | `define`, `run`, `Agent`, `RunInfo`, `RunInput`, `FrontendTool`, `PendingToolCall`, `CurrentRun`, `Event`, `Outcome`, `Requirements`, `isFrontendCall`, `approvalIdFor`, `StepLimitExceeded`, `ModelStreamError` |
| `AgUi`       | `RunAgentInput`, `ResumeEntry`, `FrontendTool`, `ApprovalResponse`, `decodeRunAgentInput`, `Event`, `isTerminal`, `fold`, `closeOpen`, `approvalInterrupt`, event constructors                                   |
| `Runner`     | `makeAttached`, `makeDetached`, `makeWorkflow`, `RunContext`, `Options`, `DetachedOptions`, `Requirements`, `DependencyServices`, `WorkflowOptions`, `WorkflowPayloadFields`, `RunInputMismatch`                 |
| `History`    | `History`, `layerClient`, `layerServer`; `restore`, `Restored`: reading a thread back; `HistoryMismatch`, `HistoryDiverged`, `UnansweredInterrupt`, `UnansweredToolCall`: the server history's rejections        |
| `Thread`     | `Thread`, `RunOutcome`, `ThreadError`, `ThreadBusy`, `layerMemory`                                                                                                                                               |
| `Checkpoint` | `Checkpoint`, `Ledger`, `LedgerError`, `layerNone`, `layerLedger`, `layerMemoryLedger`, `layerWorkflow`                                                                                                          |
| `EventLog`   | `EventLog`, `Stored`, `EventLogError`, `InvalidCursor`, `layerMemory`                                                                                                                                            |
| `Messages`   | `Entry`: one message of a conversation, as runs and the thread store hold it; `project`, `INCOMPLETE_TOOL_CALL_RESULT`: a run's entries as the model prompt                                                      |
| `Sse`        | `encode`, `encodeEvent`, `encodeStored`, `contentType`, `response`                                                                                                                                               |
