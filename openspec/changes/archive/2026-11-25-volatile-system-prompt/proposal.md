## Why

Some instructions change often: the current date or time, the current state of something the agent works on, context retrieved for the latest user message. Put in the system prompt, they change the first message of every model call, so each change invalidates the provider's prompt cache for the whole conversation. Put after the conversation instead, they leave everything before them cacheable.

Getting the cache to pay off also means marking where the cacheable prefix ends (Anthropic writes cache entries only at breakpoints), and only the loop builds each model call's prompt, so today a caller has no way to place those marks.

## What Changes

- An agent definition gains an optional `volatileSystem`: fixed text, or a function from the conversation the run was given to an effect producing the text (or nothing). It may read the current run and services the definition declares, like the system prompt.
- The run resolves it once, before step 0, and memoises it under the thread id and run id (checkpoint `volatile-system`), as it does a computed system prompt.
- Every model call of the run receives the resolved text as a system message placed **last**, after the conversation so far. Its value is the same for every step of the run; only its position moves as the run appends steps.
- The text is never stored: it is not part of any step's entries, of the thread, of the run's events or of a restored history. The next run resolves its own.
- A new optional service, `Agent.ModelPromptTransformer`: a function the run calls on each model call's prompt, exactly as it built it (system prompt, conversation, volatile message), with where the conversation starts and ends, the step and the agent's name; the model receives what it returns. This is how a caller places cache breakpoints (e.g. Anthropic `cacheControl` on the system message and on the last conversation message, OpenAI `promptCacheBreakpoint` on a system message or a user text part) or makes any other request-only change, with full control and nothing on the agent definition. The result reaches that model call only: never entries, events, the thread, a memo or a subagent's prompt. Without it, the prompt is sent as built.
- Documentation: the provider must support system messages after the start of the conversation (for Anthropic, `midConversationSystemMessages`; not supported by Claude Sonnet 5). A provider that doesn't moves every system message to the top, so the conversation misses the cache across runs. The README gives `ModelPromptTransformer` recipes for both providers' breakpoints, and covers why Anthropic's automatic caching stops working once `volatileSystem` is set, cache lifetimes (including Anthropic's rule that longer lifetimes come first) and OpenAI's automatic prefix caching.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-run`: the agent definition gains an optional volatile system prompt; new requirements place it last in every model call, resolved and memoised once per run and never committed or emitted, and let a caller-provided function adjust each model call's prompt for that call only.

## Impact

- `packages/effect-agent-harness/src/Agent.ts`: `Agent` and `define` gain `volatileSystem`; a new `ModelPromptTransformer` `Context.Reference` (default: the prompt unchanged) and its `ModelPromptLayout`; `run` resolves the volatile text before step 0, and `modelStep` appends the volatile message after `withSystem(forModel(prompt))`, then applies `ModelPromptTransformer` to the result.
- `packages/effect-agent-harness/AGENTS.md` and the README: the new field and service, the provider requirements, the breakpoint recipes and lifetime guidance.
- Tests in `packages/effect-agent-harness/test/`.
- No change to `Messages`, `History`, `Thread`, `AgUi`, `Runner` or the AG-UI events. Not breaking: the field and the service are optional.
