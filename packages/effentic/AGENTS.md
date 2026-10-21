# packages/effentic

The library. The public API is `src/index.ts`, which re-exports each module as a namespace (`AgUi`, `Messages`, `Agent`, `Sse`). Consumers import from `"effentic"`, which resolves straight to the `.ts` sources (there's no build step).

## Modules

- `AgUi.ts`: Schemas for the subset of AG-UI `RunAgentInput` the agent reads, plus the `Event` union it emits. Decoding is deliberately lenient: unknown fields are stripped, and unknown message roles pass through so later code can ignore them.
- `Messages.ts`: `toPrompt` converts the full AG-UI history into an Effect `Prompt` on every run. The server is stateless. Unsupported roles are dropped. AG-UI tool messages don't carry a tool name, so it's recovered from the assistant tool call with the same id.
- `Agent.ts`: `run` / `make` drive the model step by step, resolve tool calls between steps, and map `Response` stream parts to AG-UI events.
- `Sse.ts`: encodes AG-UI events as SSE frames, the format `@ag-ui/client`'s `HttpAgent` expects.

## Invariants

- **The event stream never fails.** Errors (model failures, `StepLimitExceeded`, …) are emitted in-band as `RUN_ERROR`, and the stream's error type is `never`. Keep it that way.
- **Every emitted sequence must be valid AG-UI.** That means a run lifecycle (`RUN_STARTED` … `RUN_FINISHED`/`RUN_ERROR`), and text messages and tool calls that are started, then ended, never left open.
- New tools should normally use `failureMode: "return"`, so their failures go back to the model instead of ending the run.

## Tests

- Use `@effect/vitest` (`it.effect`) for anything effectful.
- `test/fixtures.ts` provides a `scriptedModel(steps)` fake `LanguageModel`. Each step is the stream for one `streamText` call, and it records the prompts it receives. It also provides part builders (`text`, `toolCall`, `finish`), a sample `WeatherToolkit`, deterministic ids (`counterIds`) and `verify`.
- **Pass every event sequence a test produces through `verify`.** It runs `@ag-ui/client`'s own sequence checks, so the tests catch streams a real client would reject.
- Don't call a real model in tests.
