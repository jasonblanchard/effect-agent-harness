# effect-agent-harness

This experimental AI agent/chat library is a set of wrappers around core Effect that is **AG-UI compatible** centered around **three planes of durability** with a separation between how **how an agent behaves** and **how it runs**.

That's a mouthful. Let's think about each:

## AG-UI compatibility

AG-UI is a... well just [go read it](https://docs.ag-ui.com/introduction).

is an open spec for how

## Three planes of durability

- **Durable message history** - for accumulating and reading the full conversation state over time. Think - returning to past chats, post-hoc analysis, etc.
- **Durable streaming** - for resumability of streaming output. Think - page refresh during a chat turn/agent run.
- **Durable execution** - for graceful handling of compute interrupts. Think - rolling deploys, server crashes, etc.

## Agent behavior vs runtime

The agent's _behavior_ is kept separate from _how it runs_. This let's you define an agent once and run it in your eval suite without worrying about how messages are streamed or stored until you need to run it on your production workload.

## Stability

⚠️ Under construction, unstable AF ⚠️

## Why Effect

First, go [read about it](https://effect.website/). I’ll wait...

⏳🥱😜

...Pretty nice, cohesive programming model and bucket of primitives with zero external dependencies, yeah?

## Why not...

- [AI SDK](https://ai-sdk.dev) or [TanStack AI](https://tanstack.com/ai) - These are complete, mature libraries. But they have a _wide_ surface area and a lot of batteries included leaving some of the core pieces of a production ready, stateful, chat experience a bit lost in the noise. This library intends to flip that - focus on the core primitives and let you bring your own batteries where you need them.
- [The core Effect AgUiServer](https://effect.website/docs/v4/api/effect/ai/AgUiServer) - Currently, this has some gaps necessary for a full, production-ready chat harness (see [Core Effect Comparison Audit](./docs/core-effect-comparison-audit.md)). This library intends to delegate as much as it can to core Effect while solving each of these gaps. Eventually, core Effect may absorb all these capabilities, at which point this library would be reduced to nothing and we 🎉 celebrate 🎉🍾🥂

## Non-goals

Here are things this library does _not_ intend to solve directly. Instead, it exposes extension points for your business logic to handle it to your needs:

- **Compaction** - Use Thread lifecycle to trigger compaction and truncation.
- **Memory** - Provide tool definitions, system prompt construction, and Thread lifecycle for orchestrating memory.
- **Model provider compatibility** - This is fully delegated to Effect.
- **Skills** - Use tool definitions and system prompt construction to load skills.
- **Code Mode** - Use tool definitions and system prompt construction. Sandboxing is left up to you.
- ...TBD

This is a deliberate trade off between completeness and simplicity.

## Core primitives

- **Agent** - the behavior (tools and system prompt) of the agent itself. Defined outside its runner so that it can be evaluated in isolation without runtime concerns like state, durability, etc. Agent implements the LLM loop with AG-UI behaviors built in.
- **Runner** - the container that orchestrates the agent loop. This is where the Agent is decorated with runtime concerns like state, durability, etc. Choose between in-process, detached, effect workflow, or bring your own.
- **History** - how messages state is prepared for a run. Choose between client authoritative history or server authoritative history.
- **Thread** - abstract thread storage and lifecycle. Use the built ins or bring your own.
- **Checkpoint** - captures moments of the agent lifecycle that you would journal in a durable compute log.
- **EventLog** - Stream of AG-UI events. Use the built ins (ie SSE, in memory) or bring your own (durable streams). TODO: This one needs to be re-named due to name collision with Effect's EventLog. These are different.

Check out the [architecture](./docs/architecture.md) docs for more details.

## Development

This project uses OpenSpec, so pretty much every major decision is documented as a spec or archived change proposal in `./openspec`.

Check the AGENTS.md steering files for more context.

## Examples

There are simple examples in the `./packages/examples` directory.

See [effect-agent-harness-example](https://github.com/jasonblanchard/effect-agent-harness-example) for a more full example running on Effect workflow with postgres storage and multi-process stream durability.

## Docs

Ye olde robots collect full, un-de-slop-ified documentation at the [robodocs](./docs/robodocs.md).
