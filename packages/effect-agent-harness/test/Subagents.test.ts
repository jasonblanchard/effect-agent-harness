import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect";
import { expectTypeOf } from "vitest";
import { Prompt } from "effect/ai";
import type { AgUiSchema, LanguageModel, Response } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import type * as AgUi from "../src/AgUi.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as EventLog from "../src/EventLog.ts";
import * as History from "../src/History.ts";
import * as Conversions from "../src/internal/conversions.ts";
import type * as Messages from "../src/Messages.ts";
import * as Runner from "../src/Runner.ts";
import * as Thread from "../src/Thread.ts";
import {
  ApprovalToolkit,
  counterIds,
  countingApprovalLayer,
  countingWeatherLayer,
  evalLayers,
  finish,
  PickFile,
  runAgUi,
  scriptedModel,
  serverStores,
  type Step,
  text,
  toolCall,
  verify,
  WeatherToolkit,
} from "./fixtures.ts";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const researcher = Agent.define({
  name: "researcher",
  description: "Looks things up",
  toolkit: WeatherToolkit,
  system: "You research.",
});

const parent = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful.", subagents: { agents: [researcher] } });

const userPrompt = Prompt.make([{ role: "user", content: "How warm is Paris?" }]);

const child = Agent.subagentIdFor("c1");

/** Parent calls `researcher`, which checks the weather and replies; the parent then replies. */
const delegation: ReadonlyArray<Step> = [
  [...toolCall("c1", "researcher", { prompt: "Find the weather in Paris" }), finish("tool-calls")],
  [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
  [...text("0", "Paris is 18°C"), finish("stop")],
  [...text("0", "It's 18°C."), finish("stop")],
];

const runAgent = (agent: Agent.Any, steps: ReadonlyArray<Step>, input?: Partial<Agent.RunInput>) =>
  Effect.gen(function* () {
    const model = scriptedModel(steps);
    const weather = countingWeatherLayer();
    const events = yield* Agent.run(agent as typeof parent, {
      runId: "r1",
      threadId: "t1",
      prompt: userPrompt,
      ...input,
    }).pipe(Stream.runCollect, Effect.provide([model.layer, weather.layer, evalLayers]));
    return { events: Array.from(events), model, calls: weather.calls };
  });

const top = (events: ReadonlyArray<Agent.Event>) => events.filter((event) => event._tag !== "Subagent");

/** The events of the subagent `id`, unwrapped, at any depth. */
const ofSubagent = (events: ReadonlyArray<Agent.Event>, id: string): Array<Agent.Event> =>
  events.flatMap((event) =>
    event._tag !== "Subagent" ? [] : event.subagentRunId === id ? [event.event] : ofSubagent([event.event], id),
  );

const roles = (prompt: Prompt.Prompt | undefined) =>
  (prompt?.content ?? []).map((message) =>
    message.role === "system" || typeof message.content === "string"
      ? { role: message.role, text: message.content }
      : {
          role: message.role,
          parts: message.content.map((part: Prompt.Part) =>
            part.type === "text"
              ? part.text
              : part.type === "tool-call" || part.type === "tool-result"
                ? part.id
                : part.type,
          ),
        },
  );

const finishedEntries = (events: ReadonlyArray<Agent.Event>, step: number) =>
  top(events).flatMap((event) => (event._tag === "StepFinished" && event.step === step ? event.entries : []));

const owners = (entries: ReadonlyArray<Messages.Entry>) =>
  entries.map((entry) => ({ id: entry.id, role: entry.message.role, owner: entry.subagentRunId }));

const toolResultOf = (events: ReadonlyArray<Agent.Event>, toolCallId: string) =>
  top(events).find(
    (event): event is Extract<Agent.Event, { _tag: "ToolResult" }> =>
      event._tag === "ToolResult" && event.toolCallId === toolCallId,
  );

// -----------------------------------------------------------------------------
// Definition
// -----------------------------------------------------------------------------

describe("Agent.define with subagents", () => {
  it("rejects a subagent without a name", () => {
    const unnamed = Agent.define({ toolkit: WeatherToolkit });
    expect(() => Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [unnamed] } })).toThrow(RangeError);
  });

  it("rejects a subagent whose name is not a tool name", () => {
    const spaced = Agent.define({ toolkit: WeatherToolkit, name: "Research Assistant" });
    expect(() => Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [spaced] } })).toThrow(RangeError);
  });

  it("rejects a subagent named like a tool", () => {
    const clash = Agent.define({ toolkit: WeatherToolkit, name: "get-weather" });
    expect(() => Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [clash] } })).toThrow(RangeError);
  });

  it("rejects two subagents with the same name", () => {
    expect(() => Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [researcher, researcher] } })).toThrow(
      RangeError,
    );
  });

  it("accepts a free-form name at the top level", () => {
    expect(Agent.define({ toolkit: WeatherToolkit, name: "Research Assistant" }).name).toBe("Research Assistant");
  });

  it("requires the services its subagents require", () => {
    class Directory extends Context.Service<Directory, { readonly name: string }>()("test/Directory") {}
    const greeter = Agent.define({
      name: "greeter",
      toolkit: WeatherToolkit,
      system: Effect.gen(function* () {
        return `Greet ${(yield* Directory).name}.`;
      }),
    });
    const withGreeter = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [greeter] } });
    expectTypeOf<Agent.Requirements<typeof WeatherToolkit.tools, never>>().not.toExtend<Directory>();
    expectTypeOf<Directory>().toExtend<
      typeof withGreeter extends Agent.Agent<infer T, infer R> ? Agent.Requirements<T, R> : never
    >();
    expectTypeOf<LanguageModel.LanguageModel>().toExtend<
      typeof withGreeter extends Agent.Agent<infer T, infer R> ? Agent.Requirements<T, R> : never
    >();
  });
});

// -----------------------------------------------------------------------------
// Running a child
// -----------------------------------------------------------------------------

describe("Agent.run with subagents", () => {
  it.effect("offers each subagent as a tool, and the child none of the client's tools", () =>
    Effect.gen(function* () {
      const { model } = yield* runAgent(parent, delegation, { frontendTools: [PickFile] });
      const parentTools = model.tools[0]!.map((tool) => tool.name);
      expect(parentTools).toEqual(expect.arrayContaining(["get-weather", "researcher", "pick-file"]));
      const tool = model.tools[0]!.find((t) => t.name === "researcher")!;
      expect(tool.description).toBe("Looks things up");
      expect(model.tools[1]!.map((t) => t.name)).toEqual(["get-weather"]);
    }),
  );

  it.effect("runs the child on its brief and gives its reply to the parent", () =>
    Effect.gen(function* () {
      const { events, model, calls } = yield* runAgent(parent, delegation);
      expect(calls).toEqual(["Paris"]);
      expect(roles(model.prompts[1])).toEqual([
        { role: "system", text: "You research." },
        { role: "user", parts: ["Find the weather in Paris"] },
      ]);
      // The parent sees the call and the child's reply, nothing of the child's own work.
      expect(roles(model.prompts[3])).toEqual([
        { role: "system", text: "Be helpful." },
        { role: "user", parts: ["How warm is Paris?"] },
        { role: "assistant", parts: ["c1"] },
        { role: "tool", parts: ["c1"] },
      ]);
      expect(toolResultOf(events, "c1")).toMatchObject({ encodedResult: "Paris is 18°C", isFailure: false });
      expect(top(events).at(-1)).toEqual({ _tag: "Finished", outcome: { _tag: "Success", pendingToolCalls: [] } });
    }),
  );

  it.effect("wraps the child's events with its id, name and parent", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(parent, delegation);
      const step1 = top(events).find((event) => event._tag === "StepStarted" && event.step === 1);
      const wrapped = events.filter((event) => event._tag === "Subagent");
      expect(wrapped.length).toBeGreaterThan(0);
      for (const event of wrapped) {
        expect(event).toMatchObject({
          subagentRunId: child,
          name: "researcher",
          description: "Looks things up",
          parentToolCallId: "c1",
          parentMessageId: step1?._tag === "StepStarted" ? step1.messageId : "",
        });
      }
      expect(ofSubagent(events, child).map((event) => event._tag)).toEqual([
        "StepStarted",
        ...Array(4).fill("ModelPart"),
        "ModelPart",
        "ToolResult",
        "StepFinished",
        "StepStarted",
        ...Array(4).fill("ModelPart"),
        "StepFinished",
        "Finished",
      ]);
      // The child's events come before the parent's result for the call.
      const lastChild = events.findLastIndex((event) => event._tag === "Subagent");
      const result = events.findIndex((event) => event._tag === "ToolResult" && event.toolCallId === "c1");
      expect(lastChild).toBeLessThan(result);
    }),
  );

  it.effect("carries the child's entries in the parent step, between its assistant entry and its results", () =>
    Effect.gen(function* () {
      const { events } = yield* runAgent(parent, delegation);
      expect(owners(finishedEntries(events, 1))).toEqual([
        { id: expect.any(String), role: "assistant", owner: undefined },
        { id: expect.any(String), role: "assistant", owner: child },
        { id: expect.any(String), role: "tool", owner: child },
        { id: expect.any(String), role: "assistant", owner: child },
        { id: expect.any(String), role: "tool", owner: undefined },
      ]);
    }),
  );

  it.effect("gives the child the parent's conversation under the conversation mode", () =>
    Effect.gen(function* () {
      const listener = Agent.define({ ...researcher, context: "conversation", name: "researcher" });
      const withListener = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [listener] } });
      const { model } = yield* runAgent(withListener, delegation);
      expect(roles(model.prompts[1])).toEqual([
        { role: "system", text: "You research." },
        { role: "user", parts: ["How warm is Paris?"] },
        { role: "user", parts: ["Find the weather in Paris"] },
      ]);
    }),
  );

  it.effect("leaves the parent's tool calls and results out of the conversation a child is given", () =>
    Effect.gen(function* () {
      const listener = Agent.define({ ...researcher, context: "conversation", name: "researcher" });
      const withListener = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [listener] } });
      const { model } = yield* runAgent(withListener, [
        [...text("0", "Checking."), ...toolCall("c0", "get-weather", { location: "Rome" }), finish("tool-calls")],
        ...delegation,
      ]);
      expect(roles(model.prompts[2])).toEqual([
        { role: "system", text: "You research." },
        { role: "user", parts: ["How warm is Paris?"] },
        { role: "assistant", parts: ["Checking."] },
        { role: "user", parts: ["Find the weather in Paris"] },
      ]);
    }),
  );

  it.effect("gives the parent the value of the child's result conversion", () =>
    Effect.gen(function* () {
      const structured = Agent.define({
        ...researcher,
        name: "researcher",
        result: ({ text, input }) => ({ answer: text, asked: input }),
      });
      const withStructured = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [structured] } });
      const { events } = yield* runAgent(withStructured, delegation);
      expect(toolResultOf(events, "c1")?.encodedResult).toEqual({
        answer: "Paris is 18°C",
        asked: { prompt: "Find the weather in Paris" },
      });
    }),
  );

  it.effect("gives the parent a failed result when the conversion returns a value that isn't JSON", () =>
    Effect.gen(function* () {
      const odd = Agent.define({ ...researcher, name: "researcher", result: () => 1n });
      const withOdd = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [odd] } });
      const { events } = yield* runAgent(withOdd, delegation);
      expect(toolResultOf(events, "c1")).toMatchObject({
        isFailure: true,
        encodedResult: "The result of subagent researcher is not a JSON value",
      });
    }),
  );

  it.effect("briefs a child with an input schema with the input as JSON", () =>
    Effect.gen(function* () {
      const typed = Agent.define({
        ...researcher,
        name: "researcher",
        input: Schema.Struct({ city: Schema.String }),
      });
      const withTyped = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [typed] } });
      const { model } = yield* runAgent(withTyped, [
        [...toolCall("c1", "researcher", { city: "Paris" }), finish("tool-calls")],
        ...delegation.slice(1),
      ]);
      expect(roles(model.prompts[1])[1]).toEqual({ role: "user", parts: ['{"city":"Paris"}'] });
    }),
  );

  it.effect("rejects a call whose input doesn't match, as the model layer does for any tool", () =>
    Effect.gen(function* () {
      const { events, model } = yield* runAgent(parent, [
        [...toolCall("c1", "researcher", { question: "?" }), finish("tool-calls")],
      ]);
      expect(model.prompts).toHaveLength(1);
      expect(events.some((event) => event._tag === "Subagent")).toBe(false);
      expect(top(events).at(-1)).toMatchObject({ _tag: "Failed", code: "InvalidOutputError" });
    }),
  );

  it.effect("gives the parent a failed result when the child exceeds its step limit, and continues", () =>
    Effect.gen(function* () {
      const hasty = Agent.define({ ...researcher, name: "researcher", maxSteps: 1 });
      const withHasty = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [hasty] } });
      const { events, model } = yield* runAgent(withHasty, [
        delegation[0]!,
        delegation[1]!,
        [...text("0", "I couldn't find out."), finish("stop")],
      ]);
      expect(model.prompts).toHaveLength(3);
      expect(ofSubagent(events, child).at(-1)).toMatchObject({ _tag: "Failed", code: "StepLimitExceeded" });
      expect(toolResultOf(events, "c1")).toMatchObject({ isFailure: true });
      expect(String(toolResultOf(events, "c1")?.encodedResult)).toContain("Step limit exceeded");
      expect(top(events).at(-1)).toMatchObject({ _tag: "Finished", outcome: { _tag: "Success" } });
    }),
  );

  it.effect("runs two calls as two children with different ids", () =>
    Effect.gen(function* () {
      const reply = (answer: string): Step => [...text("0", answer), finish("stop")];
      const { events, model } = yield* runAgent(parent, [
        [
          ...toolCall("c1", "researcher", { prompt: "Paris?" }),
          ...toolCall("c3", "researcher", { prompt: "Rome?" }),
          finish("tool-calls"),
        ],
        reply("Same."),
        reply("Same."),
        reply("Both are mild."),
      ]);
      expect(model.prompts).toHaveLength(4);
      const ids = new Set(events.flatMap((event) => (event._tag === "Subagent" ? [event.subagentRunId] : [])));
      expect(ids).toEqual(new Set([Agent.subagentIdFor("c1"), Agent.subagentIdFor("c3")]));
      const briefs = model.prompts
        .slice(1, 3)
        .map((prompt) => roles(prompt)[1])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(briefs).toEqual([
        { role: "user", parts: ["Paris?"] },
        { role: "user", parts: ["Rome?"] },
      ]);
    }),
  );

  it.effect("runs a child's own subagent, owned by the grandchild and wrapped twice", () =>
    Effect.gen(function* () {
      const lead = Agent.define({
        name: "lead",
        toolkit: WeatherToolkit,
        system: "You lead.",
        subagents: { agents: [researcher] },
      });
      const withLead = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [lead] } });
      const { events, model, calls } = yield* runAgent(withLead, [
        [...toolCall("c0", "lead", { prompt: "Find out about Paris" }), finish("tool-calls")],
        [...toolCall("c1", "researcher", { prompt: "Find the weather in Paris" }), finish("tool-calls")],
        delegation[1]!,
        delegation[2]!,
        [...text("0", "Paris is mild."), finish("stop")],
        [...text("0", "It's mild."), finish("stop")],
      ]);
      expect(calls).toEqual(["Paris"]);
      expect(model.prompts).toHaveLength(6);
      const leadId = Agent.subagentIdFor("c0");
      const grandchild = events.find(
        (event) => event._tag === "Subagent" && event.event._tag === "Subagent",
      ) as Extract<Agent.Event, { _tag: "Subagent" }>;
      expect(grandchild).toMatchObject({ subagentRunId: leadId, event: { subagentRunId: child, name: "researcher" } });
      expect(ofSubagent(events, child).at(-1)).toMatchObject({ _tag: "Finished" });
      const entries = owners(finishedEntries(events, 1));
      expect(entries.filter((entry) => entry.owner === child)).toHaveLength(3);
      // Its call, the call's result and its reply.
      expect(entries.filter((entry) => entry.owner === leadId)).toHaveLength(3);
      expect(toolResultOf(events, "c0")?.encodedResult).toBe("Paris is mild.");
    }),
  );

  it.effect("replays a child's completed work when the run is executed again", () =>
    Effect.gen(function* () {
      const weather = countingWeatherLayer();
      const attempt = (steps: ReadonlyArray<Step>, stopAfter?: (event: Agent.Event) => boolean) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const events = Agent.run(parent, { runId: "r1", threadId: "t1", prompt: userPrompt });
          const collected = yield* (stopAfter === undefined ? events : Stream.takeUntil(events, stopAfter)).pipe(
            Stream.runCollect,
            Effect.provide([model.layer, weather.layer]),
          );
          return { events: Array.from(collected), prompts: model.prompts };
        });

      // Attempt 1 stops (as if the process crashed) while the child's second step is streaming.
      const first = yield* attempt(
        [
          delegation[0]!,
          delegation[1]!,
          Stream.fromIterable(text("0", "Paris is").slice(0, 2)).pipe(Stream.concat(Stream.never)),
        ],
        (event) => event._tag === "Subagent" && event.event._tag === "ModelPart" && event.event.step === 2,
      );
      // Attempt 2 replays the parent's step 1 and the child's step 1; the model is called for the rest.
      const second = yield* attempt([delegation[2]!, delegation[3]!]);

      expect(weather.calls).toEqual(["Paris"]);
      expect(second.prompts).toHaveLength(2);
      const replayed = ofSubagent(second.events, child).filter((event) => "step" in event && event.step === 1);
      expect(replayed.every((event) => "replayed" in event && event.replayed)).toBe(true);
      const ids = (events: ReadonlyArray<Agent.Event>) =>
        new Set(events.flatMap((event) => (event._tag === "Subagent" ? [event.subagentRunId] : [])));
      expect(ids(second.events)).toEqual(ids(first.events));
      expect(toolResultOf(second.events, "c1")?.encodedResult).toBe("Paris is 18°C");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)), counterIds()),
      ),
    ),
  );

  it.effect("emits the same events and entries as before for an agent without subagents", () =>
    Effect.gen(function* () {
      const plain = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });
      const script: ReadonlyArray<Step> = [
        [...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")],
        [...text("0", "18°C"), finish("stop")],
      ];
      const { events } = yield* runAgent(plain, script);
      expect(events.some((event) => event._tag === "Subagent")).toBe(false);
      expect(owners(finishedEntries(events, 1)).map((entry) => entry.owner)).toEqual([undefined, undefined]);
    }),
  );
});

// -----------------------------------------------------------------------------
// Suspension, through the AG-UI runner
// -----------------------------------------------------------------------------

describe("suspended subagents", () => {
  const emailer = Agent.define({
    name: "emailer",
    description: "Sends email",
    toolkit: ApprovalToolkit,
    system: "You send email.",
  });
  const boss = Agent.define({ toolkit: ApprovalToolkit, system: "You delegate.", subagents: { agents: [emailer] } });
  const lead = Agent.define({ name: "lead", toolkit: ApprovalToolkit, subagents: { agents: [emailer] } });
  const grandBoss = Agent.define({ toolkit: ApprovalToolkit, subagents: { agents: [lead] } });

  const delegate = (id = "c1", name = "emailer"): Step => [
    ...toolCall(id, name, { prompt: "Email Ada" }),
    finish("tool-calls"),
  ];
  const email = (id = "c_email", to = "ada@example.com"): Step => [
    ...toolCall(id, "send-email", { to, body: "Hi" }),
    finish("tool-calls"),
  ];
  const say = (words: string): Step => [...text("0", words), finish("stop")];

  const emailerId = Agent.subagentIdFor("c1");
  const approve = (...toolCallIds: ReadonlyArray<string>): AgUiSchema.RunAgentInput["resume"] =>
    toolCallIds.map((id) => ({
      interruptId: Agent.approvalIdFor(id),
      status: "resolved" as const,
      payload: { approved: true },
    }));

  /**
   * Run r1 under the server history, then r2 on the same thread with the messages the thread reads back
   * (changed by `messages`), under the server history or the client's.
   */
  const twoRuns = (options: {
    readonly agent: Agent.Any;
    readonly steps: ReadonlyArray<Step>;
    readonly resume?: AgUiSchema.RunAgentInput["resume"];
    readonly messages?: (restored: ReadonlyArray<AgUiSchema.Message>) => ReadonlyArray<AgUiSchema.Message>;
    readonly history?: "server" | "client";
  }) =>
    Effect.gen(function* () {
      const model = scriptedModel(options.steps);
      const handlers = countingApprovalLayer();
      const run = (input: AgUiSchema.RunAgentInput) =>
        Effect.gen(function* () {
          const events = Array.from(yield* Stream.runCollect(Runner.makeAttached(options.agent as typeof boss)(input)));
          yield* Effect.promise(() => verify(events));
          return events;
        });
      return yield* Effect.gen(function* () {
        const first = yield* run({
          tools: [],
          context: [],
          threadId: "t1",
          runId: "r1",
          messages: [{ id: "u1", role: "user", content: "Email Ada" }],
        });
        const restored = yield* History.restore("t1");
        const clientMessages = (options.messages ?? ((m) => m))(restored.messages as ReadonlyArray<AgUiSchema.Message>);
        const second = yield* run({
          tools: [],
          context: [],
          threadId: "t1",
          runId: "r2",
          messages: clientMessages,
          ...(options.resume === undefined ? {} : { resume: options.resume }),
        }).pipe(options.history === "client" ? Effect.provide(History.layerClient) : (self) => self);
        const thread = yield* Thread.Thread;
        return {
          first,
          second,
          restored,
          stored: yield* thread.load("t1"),
          prompts: model.prompts,
          emails: handlers.emails,
        };
      }).pipe(Effect.provide([model.layer, handlers.layer, evalLayers, serverStores]));
    });

  const resultOf = (events: ReadonlyArray<AgUi.Event>, toolCallId: string) =>
    events.find(
      (event): event is Extract<AgUi.Event, { type: "TOOL_CALL_RESULT" }> =>
        event.type === "TOOL_CALL_RESULT" && event.toolCallId === toolCallId,
    );

  it.effect("interrupts the parent with the child's approval, attributed to the child", () =>
    Effect.gen(function* () {
      const { first, restored, stored, emails } = yield* twoRuns({ agent: boss, steps: [delegate(), email()] });
      expect(emails).toEqual([]);
      expect(first.at(-1)).toMatchObject({
        type: "RUN_FINISHED",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: Agent.approvalIdFor("c_email"), toolCallId: "c_email", subagentRunId: emailerId }],
        },
      });
      expect(resultOf(first, "c1")).toBeUndefined();
      expect(first.find((e) => e.type === "SUBAGENT_FINISHED")).toEqual({
        type: "SUBAGENT_FINISHED",
        subagentRunId: emailerId,
        outcome: { type: "suspended", interruptIds: [Agent.approvalIdFor("c_email")] },
      });
      // The spawning call is the parent's and has no result; the child's call and request are the child's.
      const owned = stored.filter((entry) => entry.subagentRunId === emailerId);
      expect(owned.map((entry) => entry.message.role)).toEqual(["assistant"]);
      expect(restored.interrupts).toMatchObject({
        runId: "r1",
        pending: [{ id: Agent.approvalIdFor("c_email"), subagentRunId: emailerId }],
      });
    }),
  );

  for (const history of ["server", "client"] as const) {
    describe(`under the ${history} history`, () => {
      it.effect("resumes an approved child, which finishes before the parent's model is called", () =>
        Effect.gen(function* () {
          const { second, prompts, emails } = yield* twoRuns({
            agent: boss,
            steps: [delegate(), email(), say("Sent."), say("Done.")],
            resume: approve("c_email"),
            history,
          });
          expect(emails).toEqual(["ada@example.com"]);
          expect(roles(prompts[2])).toEqual([
            { role: "system", text: "You send email." },
            { role: "user", parts: ["Email Ada"] },
            { role: "assistant", parts: ["c_email"] },
            { role: "tool", parts: ["c_email"] },
          ]);
          expect(roles(prompts[3])).toEqual([
            { role: "system", text: "You delegate." },
            { role: "user", parts: ["Email Ada"] },
            { role: "assistant", parts: ["c1"] },
            { role: "tool", parts: ["c1"] },
          ]);
          expect(resultOf(second, "c1")).toMatchObject({ content: '"Sent."' });
          expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
          // The resumed child continues under the same id.
          expect(second.filter((e) => e.type.startsWith("SUBAGENT_"))).toEqual([
            expect.objectContaining({ type: "SUBAGENT_STARTED", subagentRunId: emailerId, parentToolCallId: "c1" }),
            expect.objectContaining({
              type: "SUBAGENT_FINISHED",
              subagentRunId: emailerId,
              outcome: { type: "success" },
            }),
          ]);
          expect(second.find((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "c_email")).toMatchObject({
            subagentRunId: emailerId,
          });
        }),
      );

      it.effect("resumes a child whose call was denied, and the child's model sees the reason", () =>
        Effect.gen(function* () {
          const { prompts, emails } = yield* twoRuns({
            agent: boss,
            steps: [delegate(), email(), say("Not sent."), say("Done.")],
            resume: [
              {
                interruptId: Agent.approvalIdFor("c_email"),
                status: "resolved",
                payload: { approved: false, reason: "no" },
              },
            ],
            history,
          });
          expect(emails).toEqual([]);
          expect(prompts[2]!.content.at(-1)).toMatchObject({
            role: "tool",
            content: [{ type: "tool-result", id: "c_email", result: { type: "execution-denied", reason: "no" } }],
          });
        }),
      );

      it.effect("resumes a mixed step, where the parent and its child both waited", () =>
        Effect.gen(function* () {
          const { first, second, prompts, emails } = yield* twoRuns({
            agent: boss,
            steps: [
              [
                ...toolCall("c_bob", "send-email", { to: "bob@example.com", body: "Hi" }),
                ...toolCall("c1", "emailer", { prompt: "Email Ada" }),
                finish("tool-calls"),
              ],
              email(),
              say("Sent."),
              say("Done."),
            ],
            resume: approve("c_bob", "c_email"),
            history,
          });
          expect(first.at(-1)).toMatchObject({
            outcome: {
              interrupts: [
                { id: Agent.approvalIdFor("c_bob") },
                { id: Agent.approvalIdFor("c_email"), subagentRunId: emailerId },
              ],
            },
          });
          expect([...emails].sort()).toEqual(["ada@example.com", "bob@example.com"]);
          expect(prompts).toHaveLength(4);
          expect(roles(prompts[3]).slice(-2)).toEqual([
            { role: "tool", parts: ["c_bob"] },
            { role: "tool", parts: ["c1"] },
          ]);
          expect(second.at(-1)).toMatchObject({ outcome: { type: "success" } });
        }),
      );

      it.effect("ends the run interrupted again when the resumed child asks for another approval", () =>
        Effect.gen(function* () {
          const { second, prompts, emails } = yield* twoRuns({
            agent: boss,
            steps: [delegate(), email(), email("c_email2", "bob@example.com")],
            resume: approve("c_email"),
            history,
          });
          expect(emails).toEqual(["ada@example.com"]);
          expect(prompts).toHaveLength(3);
          expect(second.at(-1)).toMatchObject({
            outcome: {
              type: "interrupt",
              interrupts: [{ id: Agent.approvalIdFor("c_email2"), subagentRunId: emailerId }],
            },
          });
        }),
      );

      it.effect("resumes a grandchild through its parent", () =>
        Effect.gen(function* () {
          const grandchild = Agent.subagentIdFor("c1");
          const { first, second, prompts, emails } = yield* twoRuns({
            agent: grandBoss,
            steps: [delegate("c0", "lead"), delegate(), email(), say("Sent."), say("Lead done."), say("Done.")],
            resume: approve("c_email"),
            history,
          });
          expect(first.at(-1)).toMatchObject({
            outcome: { interrupts: [{ id: Agent.approvalIdFor("c_email"), subagentRunId: grandchild }] },
          });
          // Only the grandchild owns the interrupt; the lead is suspended because of it.
          expect(first.filter((e) => e.type === "SUBAGENT_FINISHED")).toEqual([
            {
              type: "SUBAGENT_FINISHED",
              subagentRunId: grandchild,
              outcome: { type: "suspended", interruptIds: [Agent.approvalIdFor("c_email")] },
            },
            { type: "SUBAGENT_FINISHED", subagentRunId: Agent.subagentIdFor("c0"), outcome: { type: "suspended" } },
          ]);
          expect(emails).toEqual(["ada@example.com"]);
          expect(prompts).toHaveLength(6);
          expect(resultOf(second, "c0")).toMatchObject({ content: '"Lead done."' });
          expect(second.at(-1)).toMatchObject({ outcome: { type: "success" } });
        }),
      );
    });
  }

  /**
   * The thread as TanStack's client sends it back: each child's messages after its host's own messages and
   * results, tagged and carrying the card in `metadata.tanstack.subagent`, and an empty placeholder message
   * (`subagent:` + the child's id) for a child with no messages of its own.
   */
  const asTanStack = (restored: ReadonlyArray<AgUiSchema.Message>): ReadonlyArray<AgUiSchema.Message> => {
    const card = { tanstack: { subagent: { name: "emailer", status: "suspended" } } };
    const own = restored.filter((message) => message.subagentRunId === undefined);
    const children = restored.flatMap((message) =>
      message.subagentRunId === undefined ? [] : [{ ...message, metadata: card }],
    );
    const placeholder = {
      id: `subagent:${emailerId}`,
      role: "assistant" as const,
      subagentRunId: emailerId,
      metadata: { tanstack: { subagent: { name: "emailer", status: "suspended", placeholder: true } } },
    };
    return [...own, placeholder, ...children];
  };

  for (const history of ["server", "client"] as const) {
    it.effect(`resumes a child from the messages in TanStack's order, under the ${history} history`, () =>
      Effect.gen(function* () {
        const { second, emails } = yield* twoRuns({
          agent: boss,
          steps: [delegate(), email(), say("Sent."), say("Done.")],
          resume: approve("c_email"),
          messages: asTanStack,
          history,
        });
        expect(emails).toEqual(["ada@example.com"]);
        expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      }),
    );

    it.effect(`continues after a finished subagent turn in TanStack's order, under the ${history} history`, () =>
      Effect.gen(function* () {
        const { second, prompts } = yield* twoRuns({
          agent: boss,
          steps: [delegate(), say("Nothing to send."), say("Done."), say("Hi again.")],
          messages: (restored) => [...asTanStack(restored), { id: "u2", role: "user", content: "Thanks" }],
          history,
        });
        expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
        expect(roles(prompts[3])).toEqual([
          { role: "system", text: "You delegate." },
          { role: "user", parts: ["Email Ada"] },
          { role: "assistant", parts: ["c1"] },
          { role: "tool", parts: ["c1"] },
          { role: "assistant", parts: ["Done."] },
          { role: "user", parts: ["Thanks"] },
        ]);
      }),
    );
  }

  it.effect("fails a run that leaves the child's approval unanswered, under the server history", () =>
    Effect.gen(function* () {
      const { second, emails } = yield* twoRuns({ agent: boss, steps: [delegate(), email()] });
      expect(emails).toEqual([]);
      expect(second.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "UnansweredInterrupt" });
    }),
  );

  it.effect("answers the call with a failed result when the client dropped the child's messages", () =>
    Effect.gen(function* () {
      const { second, prompts, emails } = yield* twoRuns({
        agent: boss,
        steps: [delegate(), email(), say("It didn't work.")],
        resume: approve("c_email"),
        messages: (restored) => restored.filter((message) => message.subagentRunId === undefined),
        history: "client",
      });
      expect(emails).toEqual([]);
      expect(prompts).toHaveLength(3);
      expect(resultOf(second, "c1")).toBeUndefined();
      expect(prompts[2]!.content.at(-1)).toMatchObject({ role: "tool", content: [{ id: "c1", isFailure: true }] });
    }),
  );

  it.effect("accepts a client that keeps or drops the child's messages, under the server history", () =>
    Effect.gen(function* () {
      for (const keep of [true, false]) {
        const { second } = yield* twoRuns({
          agent: boss,
          steps: [delegate(), email(), say("Sent."), say("Done.")],
          resume: approve("c_email"),
          messages: (restored) => (keep ? restored : restored.filter((message) => message.subagentRunId === undefined)),
        });
        expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      }
    }),
  );
});

const resultOf = (events: ReadonlyArray<AgUi.Event>, toolCallId: string) =>
  events.find(
    (event): event is Extract<AgUi.Event, { type: "TOOL_CALL_RESULT" }> =>
      event.type === "TOOL_CALL_RESULT" && event.toolCallId === toolCallId,
  );

// -----------------------------------------------------------------------------
// Reading a thread with subagents
// -----------------------------------------------------------------------------

describe("History.restore with subagents", () => {
  it.effect("tags the child's messages and places them between the spawning call and its result", () =>
    Effect.gen(function* () {
      const model = scriptedModel(delegation);
      const { events, restored, rejoined } = yield* Effect.gen(function* () {
        const [events] = yield* runAgUi(parent, [
          {
            tools: [],
            context: [],
            threadId: "t1",
            runId: "r1",
            messages: [{ id: "u1", role: "user", content: "How warm is Paris?" }],
          },
        ]);
        const thread = yield* Thread.Thread;
        return {
          events: events!,
          restored: yield* History.restore("t1"),
          rejoined: Conversions.restore(yield* thread.load("t1"), "r1"),
        };
      }).pipe(Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers, serverStores]));
      expect(restored.messages.map((message) => [message.role, message.subagentRunId])).toEqual([
        ["user", undefined],
        ["assistant", undefined],
        ["assistant", child],
        ["tool", child],
        ["assistant", child],
        ["tool", undefined],
        ["assistant", undefined],
      ]);
      expect(restored.messages[1]).toMatchObject({ toolCalls: [{ id: "c1" }] });
      expect(restored.messages[5]).toMatchObject({ toolCallId: "c1", content: '"Paris is 18°C"' });
      expect(restored.messages[3]).toMatchObject({
        toolCallId: "c2",
        content: resultOf(events, "c2")?.content ?? "",
      });
      // A rejoining read leaves out everything the active run's log replays, the child's work included.
      expect(rejoined.messages.map((message) => message.id)).toEqual(["u1"]);
    }),
  );
});

// -----------------------------------------------------------------------------
// AG-UI projection
// -----------------------------------------------------------------------------

describe("AG-UI events of subagents", () => {
  const agUi = (agent: Agent.Any, steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const model = scriptedModel(steps);
      const [events] = yield* runAgUi(agent as typeof parent, [
        {
          tools: [],
          context: [],
          threadId: "t1",
          runId: "r1",
          messages: [{ id: "u1", role: "user", content: "How warm is Paris?" }],
        },
      ]).pipe(Effect.provide([model.layer, countingWeatherLayer().layer, evalLayers]));
      return events!;
    });
  const ownerOf = (event: AgUi.Event) =>
    event.type.startsWith("SUBAGENT_") ? "lifecycle" : (event as { subagentRunId?: string }).subagentRunId;
  const indexOf = (events: ReadonlyArray<AgUi.Event>, predicate: (event: AgUi.Event) => boolean) =>
    events.findIndex(predicate);

  it.effect("wraps the child's events in its lifecycle, attributed to it, before the call's result", () =>
    Effect.gen(function* () {
      const events = yield* agUi(parent, delegation);
      const call = events.find((e) => e.type === "TOOL_CALL_START" && e.toolCallId === "c1");
      const startedAt = indexOf(events, (e) => e.type === "SUBAGENT_STARTED");
      const finishedAt = indexOf(events, (e) => e.type === "SUBAGENT_FINISHED");
      const resultAt = indexOf(events, (e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "c1");
      expect(events[startedAt]).toEqual({
        type: "SUBAGENT_STARTED",
        subagentRunId: child,
        name: "researcher",
        description: "Looks things up",
        parentToolCallId: "c1",
        parentMessageId: call?.type === "TOOL_CALL_START" ? call.parentMessageId : "",
      });
      expect(indexOf(events, (e) => e.type === "TOOL_CALL_END" && e.toolCallId === "c1")).toBeLessThan(startedAt);
      expect(events[finishedAt]).toEqual({
        type: "SUBAGENT_FINISHED",
        subagentRunId: child,
        result: "Paris is 18°C",
        outcome: { type: "success" },
      });
      expect(resultAt).toBe(finishedAt + 1);
      // Everything in between is the child's, and nothing outside it is.
      expect(new Set(events.slice(startedAt + 1, finishedAt).map(ownerOf))).toEqual(new Set([child]));
      expect(
        [...events.slice(0, startedAt), ...events.slice(finishedAt + 1)].every((e) => ownerOf(e) === undefined),
      ).toBe(true);
      expect(
        events
          .filter((e) => e.type === "STEP_STARTED" && ownerOf(e) === child)
          .map((e) => e.type === "STEP_STARTED" && e.stepName),
      ).toEqual(["step-1", "step-2"]);
      expect(events.some((e) => e.type === "RUN_STARTED" && events.indexOf(e) > 0)).toBe(false);
    }),
  );

  it.effect("reports a failed child with SUBAGENT_ERROR and continues the run", () =>
    Effect.gen(function* () {
      const hasty = Agent.define({ ...researcher, name: "researcher", maxSteps: 1 });
      const withHasty = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [hasty] } });
      const events = yield* agUi(withHasty, [delegation[0]!, delegation[1]!, [...text("0", "Sorry."), finish("stop")]]);
      const errorAt = indexOf(events, (e) => e.type === "SUBAGENT_ERROR");
      expect(events[errorAt]).toMatchObject({ subagentRunId: child, code: "StepLimitExceeded" });
      expect(events[errorAt + 1]).toMatchObject({ type: "TOOL_CALL_RESULT", toolCallId: "c1" });
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
    }),
  );

  it.effect("names the enclosing subagent of a nested one", () =>
    Effect.gen(function* () {
      const lead = Agent.define({ name: "lead", toolkit: WeatherToolkit, subagents: { agents: [researcher] } });
      const withLead = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [lead] } });
      const events = yield* agUi(withLead, [
        [...toolCall("c0", "lead", { prompt: "Find out about Paris" }), finish("tool-calls")],
        [...toolCall("c1", "researcher", { prompt: "Find the weather in Paris" }), finish("tool-calls")],
        delegation[1]!,
        delegation[2]!,
        [...text("0", "Paris is mild."), finish("stop")],
        [...text("0", "It's mild."), finish("stop")],
      ]);
      const started = events.filter((e) => e.type === "SUBAGENT_STARTED");
      expect(started).toMatchObject([
        { subagentRunId: Agent.subagentIdFor("c0"), name: "lead" },
        { subagentRunId: child, name: "researcher", parentSubagentRunId: Agent.subagentIdFor("c0") },
      ]);
      expect(started[0]).not.toHaveProperty("parentSubagentRunId");
    }),
  );

  it.effect("keeps the text of two children streaming at once apart", () =>
    Effect.gen(function* () {
      // Each part yields, so the two children's streams interleave.
      const slow = (parts: ReadonlyArray<Response.StreamPartEncoded>): Step =>
        Stream.fromIterable(parts).pipe(Stream.tap(() => Effect.yieldNow));
      const events = yield* agUi(parent, [
        [
          ...toolCall("c1", "researcher", { prompt: "Paris?" }),
          ...toolCall("c3", "researcher", { prompt: "Rome?" }),
          finish("tool-calls"),
        ],
        slow([...text("0", "Paris ", "is ", "mild."), finish("stop")]),
        slow([...text("0", "Rome ", "is ", "warm."), finish("stop")]),
        [...text("0", "Both are fine."), finish("stop")],
      ]);
      const contentOwners = events.flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [ownerOf(e)] : []));
      // Interleaved: the owners change more than once.
      const switches = contentOwners.filter((owner, i) => i > 0 && owner !== contentOwners[i - 1]).length;
      expect(switches).toBeGreaterThan(1);
      for (const id of [Agent.subagentIdFor("c1"), Agent.subagentIdFor("c3")]) {
        const own = events.filter((e) => ownerOf(e) === id && e.type.startsWith("TEXT_MESSAGE_"));
        expect(own.map((e) => e.type)).toEqual([
          "TEXT_MESSAGE_START",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_END",
        ]);
      }
    }),
  );

  it.effect("leaves out a null result, which AG-UI doesn't allow", () =>
    Effect.gen(function* () {
      const silent = Agent.define({ ...researcher, name: "researcher", result: () => null });
      const withSilent = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [silent] } });
      const events = yield* agUi(withSilent, delegation);
      const finished = events.find((e) => e.type === "SUBAGENT_FINISHED");
      expect(finished).toEqual({ type: "SUBAGENT_FINISHED", subagentRunId: child, outcome: { type: "success" } });
      yield* Effect.promise(() => verify(events));
    }),
  );

  it.effect("closes the text a child left open, under the child's id, before it finishes", () =>
    Effect.gen(function* () {
      const events = yield* agUi(parent, [
        delegation[0]!,
        [{ type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "Paris is 18°C" }, finish("stop")],
        [...text("0", "It's 18°C."), finish("stop")],
      ]);
      const endAt = indexOf(events, (e) => e.type === "TEXT_MESSAGE_END" && ownerOf(e) === child);
      expect(endAt).toBeGreaterThan(-1);
      expect(endAt).toBeLessThan(indexOf(events, (e) => e.type === "SUBAGENT_FINISHED"));
    }),
  );

  it.effect("completes a detached run that crashed mid-child, continuing the subagent it started", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const weather = countingWeatherLayer();
      const start = (scope: Scope.Scope, steps: ReadonlyArray<Step>) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const runner = yield* Runner.makeDetached(parent).pipe(
            Effect.provide([model.layer, weather.layer]),
            Effect.provideService(Scope.Scope, scope),
          );
          yield* runner.start({
            tools: [],
            context: [],
            threadId: "t1",
            runId: "r1",
            messages: [{ id: "u1", role: "user", content: "How warm is Paris?" }],
          });
          return model.prompts;
        });
      // Attempt 1 stops (its scope closes, as on a crash) while the child's second step is streaming.
      const crashed = yield* Scope.make();
      yield* start(crashed, [
        delegation[0]!,
        delegation[1]!,
        Stream.fromIterable(text("0", "Paris is").slice(0, 2)).pipe(Stream.concat(Stream.never)),
      ]);
      yield* Stream.unwrap(log.subscribe("t1", "r1")).pipe(
        Stream.takeUntil((s) => s.event.type === "TEXT_MESSAGE_CONTENT" && ownerOf(s.event) === child),
        Stream.runDrain,
      );
      yield* Scope.close(crashed, Exit.void);
      const before = (yield* log.read("t1", "r1")).map((s) => s.event);
      expect(before.filter((e) => e.type === "SUBAGENT_STARTED")).toHaveLength(1);

      const prompts = yield* start(yield* Scope.make(), [delegation[2]!, delegation[3]!]);
      const all = (yield* Stream.runCollect(Stream.unwrap(log.subscribe("t1", "r1")))).map((s) => s.event);
      expect(weather.calls).toEqual(["Paris"]);
      expect(prompts).toHaveLength(2);
      expect(all.filter((e) => e.type === "SUBAGENT_STARTED")).toHaveLength(1);
      expect(all.filter((e) => e.type === "SUBAGENT_FINISHED")).toHaveLength(1);
      // The crashed attempt's open text and step are closed under the child's id.
      expect(all[before.length]).toMatchObject({ type: "TEXT_MESSAGE_END", subagentRunId: child });
      expect(all.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      yield* Effect.promise(() => verify(all));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)),
          counterIds(),
          serverStores,
          EventLog.layerMemory,
        ),
      ),
    ),
  );

  const lead = Agent.define({ name: "lead", toolkit: WeatherToolkit, subagents: { agents: [researcher] } });
  const overLead = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [lead] } });
  const stuck: Step = Stream.fromIterable(text("0", "Warm.").slice(0, 2)).pipe(Stream.concat(Stream.never));
  const besideSubagent = [
    {
      at: "the agent",
      agent: parent,
      owner: undefined,
      steps: [
        [
          ...toolCall("c_w", "get-weather", { location: "Rome" }),
          ...toolCall("c1", "researcher", { prompt: "Paris?" }),
          finish("tool-calls"),
        ],
        stuck,
      ],
      rest: [
        [...text("0", "Mild."), finish("stop")],
        [...text("0", "Both."), finish("stop")],
      ],
    },
    {
      at: "a subagent",
      agent: overLead,
      owner: Agent.subagentIdFor("c1"),
      steps: [
        [...toolCall("c1", "lead", { prompt: "Rome and Paris?" }), finish("tool-calls")],
        [
          ...toolCall("c_w", "get-weather", { location: "Rome" }),
          ...toolCall("c2", "researcher", { prompt: "Paris?" }),
          finish("tool-calls"),
        ],
        stuck,
      ],
      rest: [
        [...text("0", "Mild."), finish("stop")],
        [...text("0", "Both."), finish("stop")],
        [...text("0", "Done."), finish("stop")],
      ],
    },
  ] as const;

  for (const { at, agent, owner, steps, rest } of besideSubagent) {
    it.effect(`publishes a tool result of ${at} checkpointed beside a subagent when a crash cut the step short`, () =>
      Effect.gen(function* () {
        const log = yield* EventLog.EventLog;
        const weather = countingWeatherLayer();
        const start = (scope: Scope.Scope, script: ReadonlyArray<Step>) =>
          Effect.gen(function* () {
            const model = scriptedModel(script);
            const runner = yield* Runner.makeDetached(agent as typeof parent).pipe(
              Effect.provide([model.layer, weather.layer]),
              Effect.provideService(Scope.Scope, scope),
            );
            yield* runner.start({
              tools: [],
              context: [],
              threadId: "t1",
              runId: "r1",
              messages: [{ id: "u1", role: "user", content: "Rome and Paris?" }],
            });
          });
        // Attempt 1 stops while the subagent streams: `get-weather` has run, and its result waits for the step.
        const crashed = yield* Scope.make();
        yield* start(crashed, steps);
        yield* Stream.unwrap(log.subscribe("t1", "r1")).pipe(
          Stream.takeUntil((s) => s.event.type === "TEXT_MESSAGE_CONTENT"),
          Stream.runDrain,
        );
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        yield* Scope.close(crashed, Exit.void);
        expect(weather.calls).toEqual(["Rome"]);
        const before = (yield* log.read("t1", "r1")).map((s) => s.event);
        expect(before.some((e) => e.type === "TOOL_CALL_RESULT")).toBe(false);

        yield* start(yield* Scope.make(), rest);
        const all = (yield* Stream.runCollect(Stream.unwrap(log.subscribe("t1", "r1")))).map((s) => s.event);
        expect(weather.calls).toEqual(["Rome"]);
        const results = all.filter((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "c_w");
        expect(results).toHaveLength(1);
        expect(ownerOf(results[0]!)).toBe(owner);
        expect(all.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
        yield* Effect.promise(() => verify(all));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)),
            counterIds(),
            serverStores,
            EventLog.layerMemory,
          ),
        ),
      ),
    );
  }

  it.effect("publishes the result of a child that finished before a crash its sibling was caught in", () =>
    Effect.gen(function* () {
      const log = yield* EventLog.EventLog;
      const start = (scope: Scope.Scope, steps: ReadonlyArray<Step>) =>
        Effect.gen(function* () {
          const model = scriptedModel(steps);
          const runner = yield* Runner.makeDetached(parent).pipe(
            Effect.provide([model.layer, countingWeatherLayer().layer]),
            Effect.provideService(Scope.Scope, scope),
          );
          yield* runner.start({
            tools: [],
            context: [],
            threadId: "t1",
            runId: "r1",
            messages: [{ id: "u1", role: "user", content: "Paris and Rome?" }],
          });
        });
      // The children run at once: whichever calls the model first replies, and the other is still streaming when
      // attempt 1 stops. The finished child's result waits for its sibling's, so attempt 1 never publishes it.
      const crashed = yield* Scope.make();
      yield* start(crashed, [
        [
          ...toolCall("c1", "researcher", { prompt: "Paris?" }),
          ...toolCall("c3", "researcher", { prompt: "Rome?" }),
          finish("tool-calls"),
        ],
        [...text("0", "Mild."), finish("stop")],
        Stream.fromIterable(text("0", "Warm.").slice(0, 2)).pipe(Stream.concat(Stream.never)),
      ]);
      const contents = new Set<string | undefined>();
      yield* Stream.unwrap(log.subscribe("t1", "r1")).pipe(
        Stream.tap((s) => Effect.sync(() => s.event.type === "TEXT_MESSAGE_CONTENT" && contents.add(ownerOf(s.event)))),
        Stream.takeUntil(() => contents.size === 2),
        Stream.runDrain,
      );
      // Let the finished child's result reach its checkpoint.
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      yield* Scope.close(crashed, Exit.void);
      const before = (yield* log.read("t1", "r1")).map((s) => s.event);
      const finishedChild = before.find((e) => e.type === "TEXT_MESSAGE_END") as AgUi.Event | undefined;
      const done = finishedChild === undefined ? undefined : ownerOf(finishedChild);
      expect(done).toBeDefined();
      expect(before.filter((e) => e.type === "SUBAGENT_FINISHED" || e.type === "TOOL_CALL_RESULT")).toEqual([]);

      yield* start(yield* Scope.make(), [
        [...text("0", "Warm."), finish("stop")],
        [...text("0", "Both."), finish("stop")],
      ]);
      const all = (yield* Stream.runCollect(Stream.unwrap(log.subscribe("t1", "r1")))).map((s) => s.event);
      const finished = all.filter((e) => e.type === "SUBAGENT_FINISHED");
      expect(finished).toHaveLength(2);
      expect(finished.find((e) => e.subagentRunId === done)).toMatchObject({ result: "Mild." });
      const results = all.filter((e) => e.type === "TOOL_CALL_RESULT" && ownerOf(e) === undefined);
      expect(results.map((e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId)).toEqual(
        expect.arrayContaining(["c1", "c3"]),
      );
      expect(results).toHaveLength(2);
      expect(all.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
      yield* Effect.promise(() => verify(all));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Checkpoint.layerLedger.pipe(Layer.provide(Checkpoint.layerMemoryLedger)),
          counterIds(),
          serverStores,
          EventLog.layerMemory,
        ),
      ),
    ),
  );
});
