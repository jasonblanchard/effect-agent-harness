## 1. Definition and service

- [x] 1.1 Add `volatileSystem` (`string | ((input: { prompt }) => Effect<string | undefined, never, R>) | undefined`) to `Agent` and to `define`'s options, with doc comments stating the provider requirement, that the text is never stored, and that breakpoints go through `ModelPromptTransformer`, not automatic caching
- [x] 1.2 Check that a computed `volatileSystem`'s `R` joins the agent's `R` and so `Requirements`, as `system`'s does (type-level test or a typecheck of a test agent)
- [x] 1.3 Add `ModelPromptLayout` (`conversationStart`, `conversationEnd`, `step`, `agentName`) and `ModelPromptTransformer`, a `Context.Reference` whose default returns the prompt unchanged, with doc comments: request-only, never stored, not called for replayed steps, inherited by subagents, a throw fails the run; the Anthropic breakpoint example

## 2. Run

- [x] 2.1 In `run`, resolve `volatileSystem` right after `system`, before step 0: fixed text as is, a function through `checkpoint.memo` named `volatile-system` (success `Schema.String`, with no text memoised as `""`, since a ledger stores JSON), given `forModel(input.prompt)`
- [x] 2.2 In `modelStep`, append one system message holding the text after `withSystem(forModel(prompt))`, skipping it for `undefined` or `""`
- [x] 2.3 In `modelStep`, inside the checkpoint body, compute the layout and pass `modelPrompt(built, layout)` to `streamText`; read `ModelPromptTransformer` once per run
- [x] 2.4 Confirm neither the volatile text nor the hook's result reaches an entry, event, the `prompt` memo or a subagent prompt (no change expected to `StepFinished`, `cancelStep`, `conversationOf`)

## 3. Tests

- [x] 3.1 Fixed text: the model call is system, user, volatile system (`scriptedModel` recorded prompts)
- [x] 3.2 Two steps with a tool call: the second call ends with the tool result then the volatile message, which appears once
- [x] 3.3 Computed from the given prompt's last user message; computed `undefined` and `""` send no message
- [x] 3.4 Resolved once per run across two steps; re-executed run with a ledger-backed checkpoint and a moved clock sends the first attempt's text
- [x] 3.5 Resolution dies: one `Failed` event, no model call, no handler run
- [x] 3.6 Never stored or emitted: no entry or event holds the text; under the server history a second run's calls hold only its own text
- [x] 3.7 A subagent's own `volatileSystem` applies to its calls (under its prefixed checkpoint), and the parent's never reaches the child
- [x] 3.8 An agent without `volatileSystem`, run without `ModelPromptTransformer`, sends the same prompts as before
- [x] 3.9 `ModelPromptTransformer` layout: conversation bounds with and without a system prompt and volatile text; `step` and `agentName` as expected
- [x] 3.10 `ModelPromptTransformer` marks: options added before `conversationEnd` reach the model; in a two-step run they're on the tool result only in the second call, the user message keeps only its own options, and no entry or event carries them
- [x] 3.11 `ModelPromptTransformer` and replay: interrupted during step 2 and re-executed against a shared ledger, the hook is called for step 2 only
- [x] 3.12 `ModelPromptTransformer` and subagents: called for the child's model calls with the child's name; the parent's hooked prompt never reaches the child
- [x] 3.13 `ModelPromptTransformer` throws: one `Failed` event

## 4. Docs

- [x] 4.1 README: a "Volatile system prompt" section next to "A system prompt computed per run": when to use it, per-run resolution, the provider requirement (Anthropic `midConversationSystemMessages`, off by default for 4.5 and older and unsupported on Sonnet 5; otherwise every system message moves to the top: tools, the system prompt and, within a run, the conversation stay cached, but across runs the conversation misses), and the placement caveat (a prompt ending with an assistant turn, client system messages)
- [x] 4.2 README, caching with `ModelPromptTransformer`: the Anthropic recipe (system message and message before `conversationEnd`), why automatic caching (top-level `cache_control`) stops working once `volatileSystem` is set, the 5-minute default and the 1-hour TTL, Anthropic's TTL order rule (the system mark's TTL at least the conversation mark's, or the call silently misses), the OpenAI GPT-5.6+ recipe (`promptCacheBreakpoint` on the system message or a user text part), OpenAI's automatic prefix caching (no breakpoint needed before GPT-5.6), setting `prompt_cache_key` per thread through a per-run `OpenAiLanguageModel.Config` layer (marked untested unless a test covers it), and that `ResponseIdTracker` isn't supported with `volatileSystem`
- [x] 4.3 `packages/effect-agent-harness/AGENTS.md`: describe `volatileSystem` and `ModelPromptTransformer` in the `Agent.ts` entry (resolved once, memoised as `volatile-system`, appended last in every model call; the hook applied inside the model checkpoint to the request only, inherited by subagents; neither in entries, events or memos) and the volatile text in the "Run context" resume rule

## 5. Verify

- [x] 5.1 `pnpm tsc && pnpm lint && pnpm test && pnpm format:check` passes
- [x] 5.2 `openspec validate volatile-system-prompt --strict` passes
