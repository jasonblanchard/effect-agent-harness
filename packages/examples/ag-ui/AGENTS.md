# packages/examples/ag-ui

A runnable example: a terminal chat client (`src/index.ts`) using `@ag-ui/client`'s `HttpAgent`, talking to an effect-agent-harness agent backed by Anthropic.

- `src/server.ts`: defines the agent with `Agent.define` (weather + email tools; the system prompt is an effect naming the run's `AuthContext` and today's date), and builds the routes with `HttpRouter`, exposed as an in-process web handler (`HttpRouter.toWebHandler`). It uses the default client history, so there is no thread store: the client sends its whole history with every run, and that history is the run's. The other stores are in-memory: `Checkpoint.layerNone`, `EventLog.layerMemory`.
  - Every route authenticates the request first (`401` without the demo token) and provides the principal to the run as `AuthContext`: `POST /agent` on the run's stream (`Stream.provideService`), `POST /runs` around `start` (`Effect.provideService`).
  - `POST /agent`: request-scoped run, streamed back as SSE. The handler calls `Runner.makeAttached(assistant)`, provides `AuthContext` to the stream, and returns `Sse.response(Sse.encode(...))`, which closes over the handler's context because the body is consumed after the handler has returned. A disconnect cancels the run, which still ends with `RUN_FINISHED` outcome `cancelled` (nobody reads it). The client owns the thread: its resent history is the prompt, as sent.
  - `POST /runs`: starts a detached run (`Runner.makeDetached`, with `dependencies: [AuthContext]` because a detached runner captures its services when built) and answers `202` at once.
  - `POST /threads/:threadId/runs/:runId/cancel`: cancels a detached run (`detached.cancel({ threadId, runId })`), authenticated like `POST /runs`, and answers `202` at once. The run's log then ends with `RUN_FINISHED` outcome `cancelled`, so a follower of the events route sees the end. Cancelling a run that has ended does nothing. The terminal client doesn't call it, since its runs go through `POST /agent`.
  - `GET /threads/:threadId/runs/:runId/events`: follows a run from the event log as SSE (`Sse.response(Sse.encodeStored(...))`) with cursors as SSE ids, resuming after the request's `Last-Event-ID`.
- `src/auth.ts`: the placeholder `authenticate` (accepts only `Authorization: Bearer demo-token`) and the `AuthContext` service (the verified principal, provided per run). A real server verifies a real token, looks the user up before the run or in a per-run `layer` (see the library README), and also checks that the principal owns the thread.
- `src/agent.ts`: an `HttpAgent` with a new thread id per process (`chat-<uuid>`) that sends the demo token and whose `fetch` calls that handler directly. No network server runs, and the `effect-agent-harness.local` host is never resolved.
- `src/index.ts`: the chat loop. When a run ends with an interrupt, it asks `(y/n)` for each pending approval and runs again with `resume`. A new message sent while interrupts are still open (because answering them failed) cancels them in the same run, since AG-UI has a run answer every open interrupt.
- `src/tools/weather.tool.ts`: an example tool (Open-Meteo) with `failureMode: "return"`.
- `src/tools/email.tool.ts`: a `send-email` tool with `needsApproval: true` and `dependencies: [AuthContext]`. It only prints, naming the run's user as the sender; nothing is sent.

Run it with `pnpm --filter ag-ui dev`. It needs `ANTHROPIC_API_KEY` in the repo-root `.env`, which is gitignored. Never print, log or commit its value.

## Manual checks

This package has no tests; `pnpm tsc` and `pnpm lint` are its checks. After changing the runner or the thread handling, also run the example and check:

1. **Client-owned history:** ask "What's the weather in Paris?", then "Which city did I just ask about?". The second answer must name Paris, which the model only knows from the history the client resent.
2. **Approval, approved:** ask "Email ada@example.com saying hello". The run stops at `❓ Approve call to send-email? (y/n)`. Answer `y`: the tool prints `📧 (not really) sending ... from Demo User to ada@example.com`, its result is `{"sent":true}`, and the assistant confirms. "from Demo User" shows the route's `AuthContext` reached the tool.
3. **Approval, denied:** repeat and answer `n`: the tool does not print, its result is `{"type":"execution-denied","reason":"denied"}`, and the assistant says it could not send.
4. **Tracing:** with a PostHog token set, run the scripted command in "Tracing" below. In PostHog's AI observability, a new session (thread id `chat-<uuid>`, one per process) in PostHog's sessions list holds three traces named `invoke_agent assistant`, each with a latency and the person `demo`. The weather trace has two generations and an `execute_tool get-weather` span whose input and output are shown. The email interrupt trace has one generation and no tool span. The approval trace has an `execute_tool send-email` span and one generation.

## Tracing

`src/telemetry.ts` exports each run's spans to PostHog AI observability when `POSTHOG_PROJECT_TOKEN` (and optionally `POSTHOG_HOST`, default `https://us.i.posthog.com`) is set in the repo-root `.env`. Without it, nothing is exported. It uses Effect's `OtlpTracer` against PostHog's `/i/v0/ai/otel` endpoint (at most 100 spans per export), turns on `Telemetry.layerCaptureContent`, and wraps the tracer to add PostHog's own properties. Those are tool input and output, plus cache-token accounting. Sessions need no mapping: PostHog groups traces by the conventions' `gen_ai.conversation.id`. The file's comments say why each is needed. The routes give each run `Telemetry.SpanAttributes` with `posthog.distinct_id`, the principal's user id: on the stream for `POST /agent`, and through the detached runner's `layer` for `POST /runs`. The agent is named `assistant`, so each run is a trace named `invoke_agent assistant`.

`src/index.ts` also takes command-line arguments as scripted input lines (messages, then `y`/`n` answers) and exits when they run out, flushing spans on the way out:

```
pnpm --filter ag-ui dev "What's the weather in Paris?" "Email ada@example.com saying hello" y
```

This package exists to show how to use the library, so keep it idiomatic and minimal. Changes to library behaviour belong in `packages/effect-agent-harness`, with tests there.
