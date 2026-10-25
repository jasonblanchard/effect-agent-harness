# packages/examples/ag-ui

A runnable example: a terminal chat client (`src/index.ts`) using `@ag-ui/client`'s `HttpAgent`, talking to an effentic agent backed by Anthropic.

- `src/server.ts`: defines the agent with `Agent.define` (weather + email tools; the system prompt is an effect naming the run's `CurrentUser` and today's date), and builds the routes with `HttpRouter`, exposed as an in-process web handler (`HttpRouter.toWebHandler`). Stores are in-memory: `Thread.layerMemory`, `Checkpoint.layerNone`, `EventLog.layerMemory`.
  - Every route authenticates the request first (`401` without the demo token). Both runners declare `dependencies: [AuthContext]` and `layer: CurrentUserLayer`, so each run requires `AuthContext`; `POST /agent` provides it to the run's stream (`Stream.provideService`) and `POST /runs` around `start` (`Effect.provideService`), and each run gets its own `CurrentUser`.
  - `POST /agent`: request-scoped run (`Runner.make`), streamed back as SSE. A disconnect cancels the run. The server owns the thread; the client's resent history is reduced to its delta.
  - `POST /runs`: starts a detached run (`Runner.makeDetached`) and answers `202` at once.
  - `GET /threads/:threadId/runs/:runId/events`: follows a run from the event log as SSE with cursors as SSE ids, resuming after the request's `Last-Event-ID`.
- `src/auth.ts`: the placeholder `authenticate` (accepts only `Authorization: Bearer demo-token`), the `AuthContext` service (the verified principal, provided per run), the `CurrentUser` service, and `CurrentUserLayer`, which builds `CurrentUser` from `AuthContext` for each run. A real server verifies a real token, may look the user up in that layer, and also checks that the principal owns the thread.
- `src/agent.ts`: an `HttpAgent` that sends the demo token and whose `fetch` calls that handler directly. No network server runs, and the `effentic.local` host is never resolved.
- `src/index.ts`: the chat loop. When a run ends with an interrupt, it asks `(y/n)` for each pending approval and runs again with `resume`. A new message sent while interrupts are still open (because answering them failed) cancels them in the same run, since the server rejects a run that leaves one unanswered.
- `src/tools/weather.tool.ts`: an example tool (Open-Meteo) with `failureMode: "return"`.
- `src/tools/email.tool.ts`: a `send-email` tool with `needsApproval: true` and `dependencies: [CurrentUser]`. It only prints, naming the run's user as the sender; nothing is sent.

Run it with `pnpm --filter ag-ui dev`. It needs `ANTHROPIC_API_KEY` in the repo-root `.env`, which is gitignored. Never print, log or commit its value.

## Manual checks

This package has no tests; `pnpm tsc` and `pnpm lint` are its checks. After changing the runner or the thread handling, also run the example and check:

1. **Server-owned history:** ask "What's the weather in Paris?", then "Which city did I just ask about?". The second answer must name Paris, which the model only knows from the stored first turn.
2. **Approval, approved:** ask "Email ada@example.com saying hello". The run stops at `❓ Approve call to send-email? (y/n)`. Answer `y`: the tool prints `📧 (not really) sending ... from Demo User to ada@example.com`, its result is `{"sent":true}`, and the assistant confirms. "from Demo User" shows the route's `AuthContext` reached the tool as `CurrentUser`.
3. **Approval, denied:** repeat and answer `n`: the tool does not print, its result is `{"type":"execution-denied","reason":"denied"}`, and the assistant says it could not send.

This package exists to show how to use the library, so keep it idiomatic and minimal. Changes to library behaviour belong in `packages/effentic`, with tests there.
