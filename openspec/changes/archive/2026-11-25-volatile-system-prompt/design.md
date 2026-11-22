## Context

`Agent.run` builds every model call in `modelStep` as `withSystem(forModel(prompt))`: the system prompt (resolved once per run and memoised as `system`) first, then the conversation. Nothing is ever added after the conversation, and no model call carries options the stored entries don't.

See proposal.md for motivation, and the `agent-run` delta spec for the requirements.

### How the providers cache (checked 2026-11-22)

**Anthropic** (prompt-caching and mid-conversation-system-messages docs; `@effect/ai-anthropic@4.1.4`):
- The prefix is `tools`, `system`, `messages`, in that order. A change at one level invalidates it and everything after it, so editing the top-level `system` loses the whole message cache. The docs recommend appending a `{ role: "system" }` message for per-turn context instead.
- A mid-conversation system message must follow a user turn (tool results count) and then end `messages` or come right before an assistant turn. It can be last. It's supported on the 5.5 models, Opus 5 / 4.8 and the Fable and Mythos models, not on Claude Sonnet 5.
- The provider sends a non-first system message inline when `midConversationSystemMessages` holds (it assumes yes for unknown and newer model ids) and every such message is next to a user group; otherwise it moves every system message to the top-level `system`.
- **Cache entries are written only at breakpoints.** A request walks back at most 20 positions from each breakpoint and reads only entries earlier requests wrote at theirs. Automatic caching (top-level `cache_control`, which the provider passes through from its config) puts its one breakpoint on the last cacheable block, which would be the volatile message, and the docs' own volatile-last-block example ends in "no cache hit". At most 4 breakpoints per request. The default lifetime is 5 minutes, refreshed on use; 1 hour costs more.
- The provider reads a message's `options.anthropic.cacheControl` and puts it on that message's last block, for user, tool and assistant messages alike.

**OpenAI** (prompt-caching guide; `@effect/ai-openai@4.1.4`):
- Caching is automatic and matches the longest exact prefix. The guide says to put dynamic content (timestamps, user-specific content) at the end, or move it into later messages. That's this change's placement, and before GPT-5.6 it needs no breakpoint.
- The provider sends every system message in place as an input item (`developer` for reasoning models, `system` otherwise), never as top-level `instructions`. So the GPT-6.2 behaviour that adds `instructions` after the input, billed uncached, doesn't apply.
- GPT-5.6 and later accept explicit breakpoints, which the provider reads from `options.openai.promptCacheBreakpoint` on system messages and on user text and file **parts** only, not on whole messages, tool results or assistant messages.
- Cache lifetime depends on the model and organisation (in-memory or 24 h before GPT-5.6; 30 min or 12 h after).
- `effect/ai`'s `ResponseIdTracker`, if a caller provides one, sends `previous_response_id` plus only the messages after the last assistant turn, so the server keeps every earlier call's input, including earlier volatile text.

## Goals / Non-Goals

**Goals:**
- Keep the cacheable prefix of every model call as long as possible, within a run and across runs on a thread, while the volatile text changes per run.
- Give callers full control over each model call's request (where cache breakpoints go, in any provider's terms) without adding provider-shaped fields to the agent definition, since only the loop builds that request.
- Touch only `Agent.ts`: no new persistence, projection, event or protocol behaviour.

**Non-Goals:**
- Knowing any provider's options or capabilities in the library, or placing breakpoints for the caller.
- Making the feature work on providers that can't place a mid-conversation system message (no user-role fallback).
- Resolving the text per step.
- Volatile text that stays in the history (agent-authored context entries).
- Supporting `ResponseIdTracker` with a volatile system prompt.

## Decisions

### Ephemeral, not stored
The text is added to the model call only. It isn't in `StepFinished` entries, so `Thread`, `History.restore`, `delta`, `AgUi.fold` and the event log never see it, and none of them change.
*Alternative:* commit it where it was inserted, as Claude Code's reminders stay in its history. The prefix would only ever grow, but it needs a new entry kind that `restore` hides and `delta` matches, deduplication ("only when it changed"), and stale text accumulates in the context. Rejected for this change.

### Resolved once per run, memoised as `volatile-system`
Resolved right after `system`, before step 0, through `checkpoint.memo` under the name `volatile-system`, so a resumed run sends the first attempt's text and doesn't repeat retrieval. Under a subagent the name is prefixed like every other checkpoint (`sub:<toolCallId>/volatile-system`). A failure ends the run before step 0, as `system`'s does.
*Alternative:* per model call, inside the `model:<step>` body (needs no checkpoint of its own). Rejected: retrieval would run on every step of a tool loop. A caller who wants fresher text can still compute it per run in a per-run service.

### Always last: the value is fixed, the position moves
Every model call is `withSystem(forModel(prompt))` followed by one system message holding the text. Because the text is never stored, a fixed position (after the run's input) would leave a gap where the old text was in the next run's prompt, and everything after that gap would miss the cache:

```
fixed:  run 1, step 2:  S U1 V1 A1 T1
        run 2, step 1:  S U1 A1 T1 A2 U2 V2     ← differs at A1: only S U1 cached
moving: run 1, step 2:  S U1 A1 T1 V1
        run 2, step 1:  S U1 A1 T1 A2 U2 V2     ← all of the prior conversation cached
```

The tail always follows the conversation, which ends in a user message or tool results, so the Anthropic placement rule holds.

### The definition takes a function of the given prompt
```ts
readonly volatileSystem?:
  | string
  | ((input: { readonly prompt: Prompt.Prompt }) => Effect.Effect<string | undefined, never, R>)
  | undefined;
```
`prompt` is the run's `input.prompt` through `forModel` (no system prompt, no agent marks or approval parts): retrieval needs the latest user message. The effect reads `CurrentRun` and `R`, which joins `Requirements` exactly as `system`'s does. `undefined` or `""` means no message; the memo stores `""` for no text (a ledger stores JSON, which has no `undefined`), so "no text" is memoised too.
*Alternative:* `string | Effect<string, never, R>` like `system`, with the prompt added to `RunInfo`. Rejected: tool handlers and `system` would see the whole prompt through `CurrentRun`, which widens `RunInfo` for one consumer.

### `ModelPromptTransformer`: a request-only hook on each model call's prompt
```ts
export interface ModelPromptLayout {
  /** Index of the conversation's first message: 1 after the agent's system prompt, 0 without one. */
  readonly conversationStart: number;
  /** Index just after its last message: the volatile message's index, or the prompt's length without one. */
  readonly conversationEnd: number;
  readonly step: number;
  /** The agent whose model call this is, so a subagent's calls can be told apart. */
  readonly agentName: string | undefined;
}

export const ModelPromptTransformer = Context.Reference<(prompt: Prompt.Prompt, layout: ModelPromptLayout) => Prompt.Prompt>(
  "effect-agent-harness/Agent/ModelPromptTransformer",
  { defaultValue: () => (prompt) => prompt },
);
```
`modelStep` builds the call's prompt as now (`withSystem(forModel(prompt))`, then the volatile message), computes the layout, and passes `modelPrompt(built, layout)` to `streamText`. It runs inside the `model:<step>` checkpoint body, so a replayed step never calls it, and its result is used for that call only: the run keeps building from `prompt`, and entries, events, the `prompt` memo and `conversationOf` never see it. The model's span records what was actually sent, since the span transformer reads `streamText`'s prompt.

A caller provides it like any service: around the runner, or per run through `Options.layer`. The Anthropic recipe marks the system message and the message before `conversationEnd`:

```ts
Layer.succeed(Agent.ModelPromptTransformer, (prompt, { conversationStart, conversationEnd }) =>
  withOptions(prompt, [conversationStart - 1, conversationEnd - 1], { anthropic: { cacheControl: { type: "ephemeral" } } }))
```

Each model call is built from the conversation, so the conversation-end mark moves forward every step and never piles up (a stored mark would exceed Anthropic's 4 breakpoints within a few steps). The next call, three or four positions further on, reads the previous call's entry within the 20-position lookback:

```
breakpoint on the tail (automatic caching):
  step 1:  S U1 [V]◀write           step 2:  S U1 A1 T1 [V]        ← no entry at T1 or U1: miss
breakpoint on the message before conversationEnd:
  step 1:  S [U1]◀write V           step 2:  S U1 A1 [T1]◀write V  ← lookback finds U1: hit
```

The system-message mark gives a second, stable breakpoint after `tools` and `system` that survives anything breaking the moving chain (compaction, an edited message, an expired entry, a gap of more than 20 positions). On OpenAI GPT-5.6+, the same hook can put `promptCacheBreakpoint` where the provider reads it: on the system message, or on a user text part.

The hook is pure and synchronous: the layout gives it everything it needs to place marks, and a call that needs services belongs in the agent's own prompts. A throw is a defect inside the model step, so the run ends with `Failed` (and, like any failed step, stays failed on replay).

*Alternatives:*
- *`cacheBreakpoints: { afterSystem, afterConversation }` on the agent definition* (this change's earlier design): two fixed spots, provider options merged by the loop. Rejected: it puts request shaping on the definition, and message-level options can't reach OpenAI's part-level breakpoints.
- *Marking entries in `Thread.load`:* `load` runs once per run, before step 0, so its mark can't follow the conversation's end within a run (every step of a tool loop would re-send the run's output uncached); the system message isn't an entry; it exists only under the server history; and marks on stored entries reach the `prompt` memo and subagent prompts.
- *Wrapping the `LanguageModel` service:* possible today, but the wrapper can't tell where the conversation ends, and it re-implements a service to change one argument.
- *An effectful hook (`Effect<Prompt>`):* more general, but it adds a requirement channel the agent's types don't know about, for no use the layout doesn't cover. Can be added later.

### Subagents
Each agent's `volatileSystem` applies to its own model calls, and a child's resolution reads the child's prompt. The parent's tail never reaches a child: `conversationOf` reads the parent's `prompt`, which never contains it. `ModelPromptTransformer` is read from context, so a child's calls use the same hook, with the child's name in the layout: one provider usually serves the whole tree, and a caller who wants different behaviour per agent switches on `agentName`.

## Risks / Trade-offs

- [Anthropic automatic caching (top-level `cache_control`) puts its breakpoint on the volatile message, so nearly nothing is read back; it works today and silently stops working once `volatileSystem` is set] → The `volatileSystem` doc comment and the README say: with a volatile system prompt, place breakpoints through `ModelPromptTransformer` instead of automatic caching, and give the recipe.
- [`ModelPromptTransformer` can reorder or drop messages, or break call/result pairing] → It affects only the outgoing request, never the stored conversation, so a bad hook breaks that call and nothing after it. Documented as the caller's responsibility.
- [The provider can't place the message (an older model, Sonnet 5, or `midConversationSystemMessages: false`), so every system message moves to the top-level `system`, after the agent's own: `system: [stable, volatile]`] → Degraded, not lost: with a breakpoint on the system message, tools and the stable system prompt stay cached, and since the volatile text is fixed for the run, every step within a run still reads the conversation from the cache. Only across runs does the conversation miss, which is worse than automatic caching without volatile text. Document the requirement, naming Sonnet 5 (the provider assumes support for unknown ids, so a Sonnet 5 caller must turn it off).
- [A prompt that doesn't end with a user or tool message (a client history ending with an assistant turn), or a client system message placed elsewhere (`clientSystem: "allow"`), breaks the placement rule, with the same effect] → Document it. The loop can't see the provider's capabilities, so it doesn't try to detect it.
- [Cross-run hits need the next run to arrive within the cache lifetime: 5 minutes by default on Anthropic] → Document the 1-hour TTL (`{ type: "ephemeral", ttl: "1h" }`) for threads where users take longer to reply, on both breakpoints or on the system one only.
- [Anthropic requires longer-TTL breakpoints to come before shorter ones ("a 1-hour cache entry must appear before any 5-minute cache entries"); a 1-hour conversation mark after a 5-minute system mark is a cache miss, not an error, so it fails silently] → Document the rule with the recipe. The library doesn't check it: it doesn't interpret provider options.
- [`ResponseIdTracker` keeps earlier volatile text on the server: each call sends only what follows the last assistant turn, and the server's copy still holds the text earlier calls ended with] → Document that it isn't supported with `volatileSystem`. The library provides no tracker itself.
- [On GPT-5.6 and later, a breakpoint can't go on a tool result, and implicit-mode lookup positions aren't documented in detail] → Accepted: a breakpoint on the system message keeps the stable prefix cached and automatic prefix caching still applies; revisit if measurements show misses.
- [OpenAI may reject `promptCacheBreakpoint` on models before GPT-5.6, and the library can't tell which model it's talking to] → The caller's hook decides per provider and model; the README recipe says GPT-5.6+ only.
- [`prompt_cache_key` routing (OpenAI before GPT-5.6) is per request, not per agent] → `OpenAiLanguageModel.Config` is a context service the provider merges into each request, so a per-run layer can likely set `prompt_cache_key` to the thread id. Not verified; the README notes it as untested until a test covers it.
- [The text is stale for the later steps of a long run] → Accepted: that's the cost of per-run retrieval.
