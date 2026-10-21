# packages/examples/ag-ui

A runnable example: a terminal chat client (`src/index.ts`) using `@ag-ui/client`'s `HttpAgent`, talking to an effentic agent backed by Anthropic.

- `src/server.ts`: builds `POST /agent` with `HttpRouter` and exposes it as an in-process web handler (`HttpRouter.toWebHandler`).
- `src/agent.ts`: an `HttpAgent` whose `fetch` calls that handler directly. No network server runs, and the `effentic.local` host is never resolved.
- `src/tools/weather.tool.ts`: an example tool (Open-Meteo) with `failureMode: "return"`.

Run it with `pnpm --filter ag-ui dev`. It needs `ANTHROPIC_API_KEY` in the repo-root `.env`, which is gitignored. Never print, log or commit its value.

This package exists to show how to use the library, so keep it idiomatic and minimal. Changes to library behaviour belong in `packages/effentic`, with tests there. This package has no tests; `pnpm tsc` and `pnpm lint` are its checks.
