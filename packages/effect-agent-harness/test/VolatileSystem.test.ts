import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import { expectTypeOf } from "vitest";
import { Prompt } from "effect/ai";
import type { AgUiSchema } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as Thread from "../src/Thread.ts";
import {
  ApprovalToolkit,
  counterIds,
  countingApprovalLayer,
  countingWeatherLayer,
  evalLayers,
  finish,
  runAgUi,
  runInput,
  scriptedModel,
  serverStores,
  type Step,
  text,
  toolCall,
  WeatherToolkit,
} from "./fixtures.ts";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const userPrompt = Prompt.make([{ role: "user", content: "What is the weather in Paris?" }]);

const oneReply: ReadonlyArray<Step> = [[...text("0", "Hi"), finish("stop")]];

const weatherTurn: ReadonlyArray<Step> = [
  [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
  [...text("0", "18°C"), finish("stop")],
];

/** Runs `agent` on a scripted model with the weather handler, returning its events and the prompts the model got. */
const runOn = (agent: Agent.Agent<typeof WeatherToolkit.tools>, steps: ReadonlyArray<Step>, prompt = userPrompt) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const events = yield* Agent.run(agent, { runId: "r1", threadId: "t1", prompt }).pipe(
      Stream.runCollect,
      Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]),
    );
    return { events: Array.from(events), prompts: model.prompts };
  });

/** Each message as its role, or as its text for a system message. */
const shape = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => (message.role === "system" ? message.content : message.role));

const lastUserText = (prompt: Prompt.Prompt) => {
  const last = prompt.content.findLast((message) => message.role === "user");
  return last?.role === "user"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : "";
};

const breakpoint = { cacheControl: { type: "ephemeral" } };

/** `message` with `options` added to its own. */
const withOptions = (message: Prompt.Message, added: Prompt.ProviderOptions): Prompt.Message => {
  const options = { ...message.options, ...added };
  switch (message.role) {
    case "system":
      return Prompt.makeMessage("system", { content: message.content, options });
    case "user":
      return Prompt.makeMessage("user", { content: message.content, options });
    case "assistant":
      return Prompt.makeMessage("assistant", { content: message.content, options });
    case "tool":
      return Prompt.makeMessage("tool", { content: message.content, options });
  }
};

/** Marks the message just before the conversation's end. */
const markConversationEnd = (prompt: Prompt.Prompt, layout: Agent.ModelPromptLayout) =>
  Prompt.fromMessages(
    prompt.content.map((message, i) =>
      i === layout.conversationEnd - 1 ? withOptions(message, { anthropic: breakpoint }) : message,
    ),
  );

const hook = (f: Context.Service.Shape<typeof Agent.ModelPromptTransformer>) =>
  Layer.succeed(Agent.ModelPromptTransformer, f);

const ledger = Layer.mergeAll(
  Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory)),
  counterIds(),
);

// -----------------------------------------------------------------------------
// Volatile system prompt
// -----------------------------------------------------------------------------

describe("Agent volatile system prompt", () => {
  it("adds what the volatile system function needs to the requirements, except CurrentRun", () => {
    class Retriever extends Context.Service<Retriever, { readonly search: (q: string) => Effect.Effect<string> }>()(
      "test/Retriever",
    ) {}
    type RequirementsOf<A> = A extends Agent.Agent<infer Tools, infer R> ? Agent.Requirements<Tools, R> : never;
    const plain = Agent.define({ toolkit: WeatherToolkit });
    const computed = Agent.define({
      toolkit: WeatherToolkit,
      system: "Be helpful.",
      volatileSystem: ({ prompt }) =>
        Effect.gen(function* () {
          const run = yield* Agent.CurrentRun;
          return `${yield* (yield* Retriever).search(lastUserText(prompt))} (${run.runId})`;
        }),
    });
    expectTypeOf<RequirementsOf<typeof computed>>().toEqualTypeOf<RequirementsOf<typeof plain> | Retriever>();
  });

  it.effect("sends fixed volatile text as the last message, after the conversation", () =>
    Effect.gen(function* () {
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: "Be helpful.",
        volatileSystem: "Today is Monday.",
      });
      const { prompts } = yield* runOn(agent, oneReply);
      expect(shape(prompts[0]!)).toEqual(["Be helpful.", "user", "Today is Monday."]);
    }),
  );

  it.effect("moves the volatile message to the end of every later step, once", () =>
    Effect.gen(function* () {
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: "Be helpful.",
        volatileSystem: "Today is Monday.",
      });
      const { prompts } = yield* runOn(agent, weatherTurn);
      expect(shape(prompts[1]!)).toEqual(["Be helpful.", "user", "assistant", "tool", "Today is Monday."]);
    }),
  );

  it.effect("computes the volatile text from the prompt the run was given", () =>
    Effect.gen(function* () {
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        volatileSystem: ({ prompt }) => Effect.succeed(`Context for: ${lastUserText(prompt)}`),
      });
      const { prompts } = yield* runOn(agent, oneReply, Prompt.make([{ role: "user", content: "weather in Paris" }]));
      expect(shape(prompts[0]!)).toEqual(["user", "Context for: weather in Paris"]);
    }),
  );

  it.effect("sends no volatile message when the function computes none or an empty text", () =>
    Effect.gen(function* () {
      for (const computed of [undefined, ""]) {
        const agent = Agent.define({
          toolkit: WeatherToolkit,
          system: "Be helpful.",
          volatileSystem: () => Effect.succeed(computed),
        });
        const { prompts } = yield* runOn(agent, oneReply);
        expect(shape(prompts[0]!)).toEqual(["Be helpful.", "user"]);
      }
    }),
  );

  it.effect("resolves the volatile text once per run", () =>
    Effect.gen(function* () {
      let resolved = 0;
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        volatileSystem: () => Effect.sync(() => `Resolution ${++resolved}.`),
      });
      const { prompts } = yield* runOn(agent, weatherTurn);
      expect(resolved).toBe(1);
      expect(prompts.map((prompt) => shape(prompt).at(-1))).toEqual(["Resolution 1.", "Resolution 1."]);
    }),
  );

  it.effect("reuses the resolved volatile text when the run is executed again", () =>
    Effect.gen(function* () {
      class WallClock extends Context.Service<WallClock, { readonly now: Effect.Effect<string> }>()("test/WallClock") {}
      let now = "09:00";
      const clock = Layer.succeed(WallClock)({ now: Effect.sync(() => now) });
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        volatileSystem: () =>
          Effect.gen(function* () {
            return `It is ${yield* (yield* WallClock).now}.`;
          }),
      });
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: Agent.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = Agent.run(agent, { runId: "r1", threadId: "t1", prompt: userPrompt });
          yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, clock]),
          );
          return model.prompts.map((prompt) => shape(prompt).at(-1));
        });

      // Attempt 1 stops (as if the process crashed) while step 1 is streaming.
      const first = yield* attempt(
        [Stream.fromIterable(text("0", "It is").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event._tag === "ModelPart" && event.step === 1,
      );
      now = "10:00";
      const second = yield* attempt(weatherTurn);

      expect(first).toEqual(["It is 09:00."]);
      expect(second).toEqual(["It is 09:00.", "It is 09:00."]);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("fails the run before any tool or model call when the volatile function dies", () =>
    Effect.gen(function* () {
      const model = scriptedModel(oneReply);
      const handlers = countingApprovalLayer();
      const events = yield* Agent.run(
        Agent.define({ toolkit: ApprovalToolkit, volatileSystem: () => Effect.die("retriever down") }),
        {
          runId: "r1",
          threadId: "t1",
          prompt: Prompt.make([
            { role: "user", content: "Email Ada" },
            {
              role: "assistant",
              content: [
                { type: "tool-call", id: "c_email", name: "send-email", params: { to: "ada@example.com", body: "Hi" } },
                { type: "tool-approval-request", approvalId: "a1", toolCallId: "c_email" },
              ],
            },
            { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] },
          ]),
        },
      ).pipe(Stream.runCollect, Effect.provide([model.layer, handlers.layer, evalLayers]));
      expect(Array.from(events).map((event) => event._tag)).toEqual(["Failed"]);
      expect(model.prompts).toEqual([]);
      expect(handlers.emails).toEqual([]);
    }),
  );

  it.effect("puts the volatile text in no entry or event", () =>
    Effect.gen(function* () {
      const agent = Agent.define({ toolkit: WeatherToolkit, volatileSystem: "Today is Monday." });
      const { events } = yield* runOn(agent, weatherTurn);
      expect(JSON.stringify(events)).not.toContain("Today is Monday.");
    }),
  );

  it.effect("sends only the current run's volatile text under the server history", () =>
    Effect.gen(function* () {
      let day = "Monday";
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        volatileSystem: () => Effect.sync(() => `Today is ${day}.`),
      });
      const model = scriptedModel([oneReply[0]!, oneReply[0]!]);
      const user = (id: string, content: string): AgUiSchema.Message => ({ id, role: "user", content });
      yield* runAgUi(agent, [runInput({ threadId: "t1", runId: "r1", messages: [user("u1", "Hello")] })]).pipe(
        Effect.provide(model.layer),
      );
      day = "Tuesday";
      yield* runAgUi(agent, [
        runInput({
          threadId: "t1",
          runId: "r2",
          messages: [user("u1", "Hello"), { id: "id-1", role: "assistant", content: "Hi" }, user("u2", "And today?")],
        }),
      ]).pipe(Effect.provide(model.layer));
      const stored = yield* Effect.flatMap(Thread.Thread, (thread) => thread.load("t1"));

      expect(shape(model.prompts[0]!)).toEqual(["user", "Today is Monday."]);
      expect(shape(model.prompts[1]!)).toEqual(["user", "assistant", "user", "Today is Tuesday."]);
      expect(JSON.stringify(stored)).not.toContain("Today is");
    }).pipe(Effect.provide([countingWeatherLayer().layer, evalLayers, serverStores])),
  );

  it.effect("applies a subagent's own volatile text to its calls only, under its prefixed checkpoint", () =>
    Effect.gen(function* () {
      const names: Array<string> = [];
      const recording = Layer.succeed(Checkpoint.Checkpoint)({
        memo: (options, effect) =>
          Effect.map(Effect.sync(() => names.push(options.name)).pipe(Effect.andThen(effect)), (value) => ({
            value,
            replayed: false,
          })),
      });
      const researcher = Agent.define({
        name: "researcher",
        description: "Looks things up",
        toolkit: WeatherToolkit,
        context: "conversation",
        volatileSystem: () => Effect.succeed("Child context."),
      });
      const parent = Agent.define({
        toolkit: WeatherToolkit,
        volatileSystem: () => Effect.succeed("Parent context."),
        subagents: { agents: [researcher] },
      });
      const model = scriptedModel(delegation);
      yield* Agent.run(parent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, recording, counterIds()]),
      );
      const [parentFirst, childFirst, childSecond, parentSecond] = model.prompts.map((prompt) => shape(prompt));

      expect([parentFirst!.at(-1), parentSecond!.at(-1)]).toEqual(["Parent context.", "Parent context."]);
      expect([childFirst!.at(-1), childSecond!.at(-1)]).toEqual(["Child context.", "Child context."]);
      expect(JSON.stringify([childFirst, childSecond])).not.toContain("Parent context.");
      expect(names).toContain("volatile-system");
      expect(names).toContain("sub:c1/volatile-system");
    }),
  );
});

/** Parent calls `researcher`, which checks the weather and replies; the parent then replies. */
const delegation: ReadonlyArray<Step> = [
  [...toolCall("c1", "researcher", { prompt: "Find the weather in Paris" }), finish("tool-calls")],
  [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
  [...text("0", "Paris is 18°C"), finish("stop")],
  [...text("0", "It's 18°C."), finish("stop")],
];

// -----------------------------------------------------------------------------
// ModelPromptTransformer
// -----------------------------------------------------------------------------

describe("Agent.ModelPromptTransformer", () => {
  it.effect("sends the same prompts as before without a volatile system prompt or a hook", () =>
    Effect.gen(function* () {
      const agent = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });
      const unhooked = yield* runOn(agent, weatherTurn);
      const hooked = yield* runOn(agent, weatherTurn).pipe(Effect.provide(hook((prompt) => prompt)));
      expect(unhooked.prompts.map(shape)).toEqual([
        ["Be helpful.", "user"],
        ["Be helpful.", "user", "assistant", "tool"],
      ]);
      expect(hooked.prompts).toEqual(unhooked.prompts);
    }),
  );

  it.effect("gives the hook the conversation's bounds, the step and the agent's name", () =>
    Effect.gen(function* () {
      const layouts: Array<Agent.ModelPromptLayout> = [];
      const record = hook((prompt, layout) => {
        layouts.push(layout);
        return prompt;
      });
      const full = Agent.define({
        name: "assistant",
        toolkit: WeatherToolkit,
        system: "Be helpful.",
        volatileSystem: "Today is Monday.",
      });
      yield* runOn(full, weatherTurn).pipe(Effect.provide(record));
      const bare = Agent.define({ toolkit: WeatherToolkit });
      yield* runOn(
        bare,
        oneReply,
        Prompt.make([
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: "Weather?" },
        ]),
      ).pipe(Effect.provide(record));

      expect(layouts).toEqual([
        { conversationStart: 1, conversationEnd: 2, step: 1, agentName: "assistant" },
        { conversationStart: 1, conversationEnd: 4, step: 2, agentName: "assistant" },
        { conversationStart: 0, conversationEnd: 3, step: 1, agentName: undefined },
      ]);
    }),
  );

  it.effect("sends the hook's marks to that model call only", () =>
    Effect.gen(function* () {
      const agent = Agent.define({
        toolkit: WeatherToolkit,
        system: "Be helpful.",
        volatileSystem: "Today is Monday.",
      });
      const { events, prompts } = yield* runOn(agent, weatherTurn).pipe(Effect.provide(hook(markConversationEnd)));
      const marked = (prompt: Prompt.Prompt) =>
        prompt.content.map((message) => message.options["anthropic"] !== undefined);

      expect(marked(prompts[0]!)).toEqual([false, true, false]);
      expect(marked(prompts[1]!)).toEqual([false, false, false, true, false]);
      expect(prompts[1]!.content[3]!.options["anthropic"]).toEqual(breakpoint);
      expect(JSON.stringify(events)).not.toContain("cacheControl");
    }),
  );

  it.effect("doesn't call the hook for a step replayed from its checkpoint", () =>
    Effect.gen(function* () {
      const steps: Array<number> = [];
      const counting = hook((prompt, layout) => {
        steps.push(layout.step);
        return prompt;
      });
      const agent = Agent.define({ toolkit: WeatherToolkit });
      const attempt = (script: ReadonlyArray<Step>, stopAfter?: (event: Agent.Event) => boolean) =>
        Effect.gen(function* () {
          steps.length = 0;
          const model = scriptedModel(script);
          const events = Agent.run(agent, { runId: "r1", threadId: "t1", prompt: userPrompt });
          yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runDrain,
            Effect.provide([model.layer, countingWeatherLayer().layer, counting]),
          );
          return [...steps];
        });

      // Attempt 1 completes step 1 and stops (as if the process crashed) while step 2 is streaming.
      const first = yield* attempt(
        [weatherTurn[0]!, Stream.fromIterable(text("0", "18").slice(0, 2)).pipe(Stream.concat(Stream.never))],
        (event) => event._tag === "ModelPart" && event.step === 2,
      );
      const second = yield* attempt([weatherTurn[1]!]);

      expect(first).toEqual([1, 2]);
      expect(second).toEqual([2]);
    }).pipe(Effect.provide(ledger)),
  );

  it.effect("calls the hook for a subagent's model calls, with its name", () =>
    Effect.gen(function* () {
      const calls: Array<string | undefined> = [];
      // Marks every message of the parent's calls, so a parent mark reaching the child would show.
      const marking = hook((prompt, layout) => {
        calls.push(layout.agentName);
        return layout.agentName === undefined
          ? Prompt.fromMessages(prompt.content.map((message) => withOptions(message, { parent: { mark: 1 } })))
          : prompt;
      });
      const researcher = Agent.define({
        name: "researcher",
        toolkit: WeatherToolkit,
        context: "conversation",
      });
      const parent = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [researcher] } });
      const model = scriptedModel(delegation);
      yield* Agent.run(parent, { runId: "r1", threadId: "t1", prompt: userPrompt }).pipe(
        Stream.runDrain,
        Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers, marking]),
      );

      expect(calls).toEqual([undefined, "researcher", "researcher", undefined]);
      expect(JSON.stringify([model.prompts[1], model.prompts[2]])).not.toContain('"parent"');
    }),
  );

  it.effect("fails the run when the hook throws", () =>
    Effect.gen(function* () {
      const { events } = yield* runOn(Agent.define({ toolkit: WeatherToolkit }), oneReply).pipe(
        Effect.provide(
          hook(() => {
            throw new Error("bad hook");
          }),
        ),
      );
      expect(events.filter((event) => event._tag === "Failed")).toHaveLength(1);
      expect(events.at(-1)?._tag).toBe("Failed");
    }),
  );
});
