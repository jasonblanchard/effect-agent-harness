# packages/examples/ag-ui

A runnable example: a terminal chat client (`src/index.ts`) using `@ag-ui/client`'s `HttpAgent`, talking to an effect-agent-harness agent backed by Anthropic.

- `src/server.ts`: defines the agent with `Agent.define` (weather + email tools; the system prompt is an effect naming the run's `AuthContext` and today's date), and builds the routes with `HttpRouter`, exposed as an in-process web handler (`HttpRouter.toWebHandler`). It uses the default client history, so there is no thread store: the client sends its whole history with every run, and that history is the run's. The other stores are in-memory: `Checkpoint.layerNone`, `EventLog.layerMemory`.
  - Every route authenticates the request first (`401` without the demo token) and provides the principal to the run as `AuthContext`: `POST /agent` on the run's stream (`Stream.provideService`), `POST /runs` around `start` (`Effect.provideService`).
  - `POST /agent`: request-scoped run, streamed back as SSE. The handler calls `Runner.makeAttached(assistant)`, provides `AuthContext` to the stream, and returns `Sse.response(Sse.encode(...))`, which closes over the handler's context because the body is consumed after the handler has returned. A disconnect cancels the run. The client owns the thread: its resent history is the prompt, as sent.
  - `POST /runs`: starts a detached run (`Runner.makeDetached`, with `dependencies: [AuthContext]` because a detached runner captures its services when built) and answers `202` at once.
  - `GET /threads/:threadId/runs/:runId/events`: follows a run from the event log as SSE (`Sse.response(Sse.encodeStored(...))`) with cursors as SSE ids, resuming after the request's `Last-Event-ID`.
- `src/auth.ts`: the placeholder `authenticate` (accepts only `Authorization: Bearer demo-token`) and the `AuthContext` service (the verified principal, provided per run). A real server verifies a real token, looks the user up before the run or in a per-run `layer` (see the library README), and also checks that the principal owns the thread.
- `src/agent.ts`: an `HttpAgent` that sends the demo token and whose `fetch` calls that handler directly. No network server runs, and the `effect-agent-harness.local` host is never resolved.
- `src/index.ts`: the chat loop. When a run ends with an interrupt, it asks `(y/n)` for each pending approval and runs again with `resume`. A new message sent while interrupts are still open (because answering them failed) cancels them in the same run, since AG-UI has a run answer every open interrupt.
- `src/tools/weather.tool.ts`: an example tool (Open-Meteo) with `failureMode: "return"`.
- `src/tools/email.tool.ts`: a `send-email` tool with `needsApproval: true` and `dependencies: [AuthContext]`. It only prints, naming the run's user as the sender; nothing is sent.

Run it with `pnpm --filter ag-ui dev`. It needs `ANTHROPIC_API_KEY` in the repo-root `.env`, which is gitignored. Never print, log or commit its value.

## Manual checks

This package has no tests; `pnpm tsc` and `pnpm lint` are its checks. After changing the runner or the thread handling, also run the example and check:

1. **Client-owned history:** ask "What's the weather in Paris?", then "Which city did I just ask about?". The second answer must name Paris, which the model only knows from the history the client resent.
2. **Approval, approved:** ask "Email ada@example.com saying hello". The run stops at `❓ Approve call to send-email? (y/n)`. Answer `y`: the tool prints `📧 (not really) sending ... from Demo User to ada@example.com`, its result is `{"sent":true}`, and the assistant confirms. "from Demo User" shows the route's `AuthContext` reached the tool.
3. **Approval, denied:** repeat and answer `n`: the tool does not print, its result is `{"type":"execution-denied","reason":"denied"}`, and the assistant says it could not send.

This package exists to show how to use the library, so keep it idiomatic and minimal. Changes to library behaviour belong in `packages/effect-agent-harness`, with tests there.
