/**
 * Exact AG-UI output of representative runs, through the public runners, as file snapshots. They pin down what a
 * client receives, byte for byte, so a change to how the events are produced can't change them unnoticed. Each
 * sequence is also checked by `verify`, which also rejects a leaked marker or a result sent twice. Update a snapshot only for a deliberate change to the wire.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import type { AgUiSchema } from "effect/ai";
import * as Agent from "../src/Agent.ts";
import * as Checkpoint from "../src/Checkpoint.ts";
import * as EventLog from "../src/EventLog.ts";
import * as Runner from "../src/Runner.ts";
import {
  ApprovalToolkit,
  counterIds,
  countingApprovalLayer,
  countingWeatherLayer,
  finish,
  PickFile,
  progressLayer,
  ProgressToolkit,
  reasoning,
  runAgUi,
  runInput,
  scriptedModel,
  serverStores,
  signature,
  type Step,
  text,
  toolCall,
  verify,
  WeatherToolkit,
} from "./fixtures.ts";

const user = (id: string, content: string): AgUiSchema.Message => ({ id, role: "user", content });

/** An assistant message holding one tool call, as a client holds it after the run that made the call. */
const calling = (id: string, toolCallId: string, name: string, args: unknown): AgUiSchema.Message => ({
  id,
  role: "assistant",
  toolCalls: [{ id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

const input = (runId: string, messages: ReadonlyArray<AgUiSchema.Message>, extra?: Partial<AgUiSchema.RunAgentInput>) =>
  runInput({ threadId: "t1", runId, messages, ...extra });

const snapshot = (name: string, runs: ReadonlyArray<ReadonlyArray<AgUiSchema.Event>>) =>
  Effect.promise(async () => {
    for (const events of runs) {
      await verify(events);
    }
    await expect(`${JSON.stringify(runs, null, 2)}\n`).toMatchFileSnapshot(`./__snapshots__/baseline/${name}.json`);
  });

const weatherAgent = Agent.define({ toolkit: WeatherToolkit, system: "Be helpful." });
const approvalAgent = Agent.define({ toolkit: ApprovalToolkit });
const progressAgent = Agent.define({ toolkit: ProgressToolkit });
const researcher = Agent.define({
  name: "researcher",
  description: "Looks things up",
  toolkit: WeatherToolkit,
  system: "You research.",
});
const writer = Agent.define({ name: "writer", toolkit: ApprovalToolkit, system: "You write." });
const lead = Agent.define({ name: "lead", toolkit: WeatherToolkit, subagents: { agents: [researcher] } });
const parent = Agent.define({ toolkit: WeatherToolkit, subagents: { agents: [researcher, writer, lead] } });

const weatherTurn: ReadonlyArray<Step> = [
  [...text("0", "Let me check."), ...toolCall("toolu_1", "get-weather", { location: "Paris" }), finish("tool-calls")],
  [...text("0", "It is 18°C."), finish("stop")],
];

/** Runs `inputs` one after another through the attached runner, against one scripted model, with fresh ids. */
const attached = (
  agent: Agent.Any,
  steps: ReadonlyArray<Step>,
  inputs: ReadonlyArray<AgUiSchema.RunAgentInput>,
  handlers: Layer.Layer<any> = countingWeatherLayer().layer,
) =>
  runAgUi(agent as typeof weatherAgent, inputs).pipe(
    Effect.provide([scriptedModel(steps).layer, handlers, Checkpoint.layerNone, counterIds()]),
  );

describe("baseline: attached runs", () => {
  it.effect("text only", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        weatherAgent,
        [[...text("0", "Hel", "lo"), finish("stop")]],
        [input("r1", [user("u1", "Hi")])],
      );
      yield* snapshot("text", runs);
    }),
  );

  it.effect("reasoning blocks, with and without text, then text", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        weatherAgent,
        [
          [
            ...reasoning("0", [], signature("s0")),
            ...reasoning("1", ["Think", "ing"], signature("s1")),
            ...text("2", "Done."),
            finish("stop"),
          ],
        ],
        [input("r1", [user("u1", "Hi")])],
      );
      yield* snapshot("reasoning", runs);
    }),
  );

  it.effect("a streamed tool call, its result and the reply", () =>
    Effect.gen(function* () {
      const runs = yield* attached(weatherAgent, weatherTurn, [input("r1", [user("u1", "Weather in Paris?")])]);
      yield* snapshot("tool-call", runs);
    }),
  );

  it.effect("a tool call delivered whole, and a failed result", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        weatherAgent,
        [
          [{ type: "tool-call", id: "c1", name: "get-weather", params: { location: "Nowhere" } }, finish("tool-calls")],
          [...text("0", "Unknown."), finish("stop")],
        ],
        [input("r1", [user("u1", "Weather in Nowhere?")])],
      );
      yield* snapshot("tool-failure", runs);
    }),
  );

  it.effect("tool progress, as an object and as a plain value", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        progressAgent,
        [
          [
            ...toolCall("c1", "search", { query: "q", sources: 2 }),
            ...toolCall("c2", "count", { to: 3 }),
            finish("tool-calls"),
          ],
          [...text("0", "Done."), finish("stop")],
        ],
        [input("r1", [user("u1", "Search")])],
        progressLayer().layer,
      );
      yield* snapshot("progress", runs);
    }),
  );

  it.effect("an approval interrupt, then the approving run", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        approvalAgent,
        [
          [...toolCall("c1", "send-email", { to: "a@b.c", body: "Hi" }), finish("tool-calls")],
          [...text("0", "Sent."), finish("stop")],
        ],
        [
          input("r1", [user("u1", "Email them")]),
          input("r2", [user("u1", "Email them"), calling("id-1", "c1", "send-email", { to: "a@b.c", body: "Hi" })], {
            resume: [{ interruptId: "approval:c1", status: "resolved", payload: { approved: true } }],
          }),
        ],
        countingApprovalLayer().layer,
      ).pipe(Effect.provide(serverStores));
      yield* snapshot("approval", runs);
    }),
  );

  it.effect("a frontend call next to a server call, and next to an approval", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        approvalAgent,
        [
          [
            ...toolCall("c1", "pick-file", {}),
            ...toolCall("c2", "get-weather", { location: "Paris" }),
            finish("tool-calls"),
          ],
          [
            ...toolCall("c3", "pick-file", {}),
            ...toolCall("c4", "send-email", { to: "x", body: "y" }),
            finish("tool-calls"),
          ],
        ],
        [
          input("r1", [user("u1", "Pick")], { tools: [PickFile] }),
          input("r2", [user("u2", "Pick and send")], { tools: [PickFile] }),
        ],
        countingApprovalLayer().layer,
      );
      yield* snapshot("frontend", runs);
    }),
  );

  it.effect("a subagent call", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        parent,
        [
          [...text("0", "Asking."), ...toolCall("c1", "researcher", { prompt: "Paris?" }), finish("tool-calls")],
          [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
          [...text("0", "Paris is 18°C"), finish("stop")],
          [...text("0", "It's 18°C."), finish("stop")],
        ],
        [input("r1", [user("u1", "How warm is Paris?")])],
      );
      yield* snapshot("subagent", runs);
    }),
  );

  it.effect("a nested subagent call", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        parent,
        [
          [...toolCall("c0", "lead", { prompt: "Find out about Paris" }), finish("tool-calls")],
          [...toolCall("c1", "researcher", { prompt: "Paris?" }), finish("tool-calls")],
          [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
          [...text("0", "Paris is 18°C"), finish("stop")],
          [...text("0", "Paris is mild."), finish("stop")],
          [...text("0", "It's mild."), finish("stop")],
        ],
        [input("r1", [user("u1", "How warm is Paris?")])],
      );
      yield* snapshot("nested-subagent", runs);
    }),
  );

  it.effect("a subagent waiting for approval, then resumed", () =>
    Effect.gen(function* () {
      const runs = yield* attached(
        parent,
        [
          [...toolCall("c1", "writer", { prompt: "Email them" }), finish("tool-calls")],
          [...toolCall("c2", "send-email", { to: "a@b.c", body: "Hi" }), finish("tool-calls")],
          [...text("0", "Sent it."), finish("stop")],
          [...text("0", "Done."), finish("stop")],
        ],
        [
          input("r1", [user("u1", "Email them")]),
          input("r2", [user("u1", "Email them"), calling("id-1", "c1", "writer", { prompt: "Email them" })], {
            resume: [{ interruptId: "approval:c2", status: "resolved", payload: { approved: true } }],
          }),
        ],
        Layer.mergeAll(countingWeatherLayer().layer, countingApprovalLayer().layer),
      ).pipe(Effect.provide(serverStores));
      yield* snapshot("subagent-suspended", runs);
    }),
  );

  it.effect("a model failure mid-text, and the step limit", () =>
    Effect.gen(function* () {
      const failed = yield* attached(
        weatherAgent,
        [[...text("0", "par").slice(0, 2), { type: "error", error: { message: "overloaded" } }]],
        [input("r1", [user("u1", "Hi")])],
      );
      const limited = yield* attached(
        Agent.define({ toolkit: WeatherToolkit, maxSteps: 1 }),
        [[...toolCall("c1", "get-weather", { location: "Paris" }), finish("tool-calls")]],
        [input("r1", [user("u1", "Hi")])],
      );
      yield* snapshot("failure", [...failed, ...limited]);
    }),
  );
});

describe("baseline: detached runs", () => {
  const ledger = Checkpoint.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory));
  const shared = () => Layer.mergeAll(ledger, counterIds(), serverStores, EventLog.layerMemory);

  const start = (scope: Scope.Scope, agent: Agent.Any, steps: ReadonlyArray<Step>, run: AgUiSchema.RunAgentInput) =>
    Effect.gen(function* () {
      const runner = yield* Runner.makeDetached(agent as typeof weatherAgent).pipe(
        Effect.provide([scriptedModel(steps).layer, countingWeatherLayer().layer]),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* runner.start(run);
      return runner;
    });

  const log = Effect.flatMap(EventLog.EventLog, (events) => events.read("t1", "r1"));
  const waitFor = (predicate: (event: AgUiSchema.Event) => boolean) =>
    Effect.flatMap(EventLog.EventLog, (events) =>
      Stream.unwrap(events.subscribe("t1", "r1")).pipe(
        Stream.takeUntil((s) => predicate(s.event)),
        Stream.runDrain,
      ),
    );
  const complete = Effect.flatMap(EventLog.EventLog, (events) =>
    Stream.runCollect(Stream.unwrap(events.subscribe("t1", "r1"))).pipe(Effect.map((all) => all.map((s) => s.event))),
  );

  it.effect("a run cancelled mid-text", () =>
    Effect.gen(function* () {
      const runner = yield* start(
        yield* Scope.make(),
        weatherAgent,
        [Stream.concat(Stream.fromIterable(text("0", "Hel").slice(0, 2)), Stream.never)],
        input("r1", [user("u1", "Hi")]),
      );
      yield* waitFor((event) => event.type === "TEXT_MESSAGE_CONTENT");
      yield* runner.cancel({ threadId: "t1", runId: "r1" });
      yield* snapshot("cancelled", [yield* complete]);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("a run that crashed mid-step, completed by a second attempt", () =>
    Effect.gen(function* () {
      const run = input("r1", [user("u1", "Weather in Paris?")]);
      const crashed = yield* Scope.make();
      yield* start(
        crashed,
        weatherAgent,
        [weatherTurn[0]!, Stream.concat(Stream.fromIterable(text("0", "It is").slice(0, 2)), Stream.never)],
        run,
      );
      yield* waitFor((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.messageId === "id-3");
      yield* Scope.close(crashed, Exit.void);
      yield* start(yield* Scope.make(), weatherAgent, [[...text("0", "18°C"), finish("stop")]], run);
      yield* snapshot("crash-mid-step", [yield* complete]);
    }).pipe(Effect.provide(shared())),
  );

  it.effect("a run that crashed mid-child, completed by a second attempt", () =>
    Effect.gen(function* () {
      const run = input("r1", [user("u1", "How warm is Paris?")]);
      const crashed = yield* Scope.make();
      yield* start(
        crashed,
        parent,
        [
          [...toolCall("c1", "researcher", { prompt: "Paris?" }), finish("tool-calls")],
          [...toolCall("c2", "get-weather", { location: "Paris" }), finish("tool-calls")],
          Stream.concat(Stream.fromIterable(text("0", "Paris").slice(0, 2)), Stream.never),
        ],
        run,
      );
      yield* waitFor((event) => event.type === "TEXT_MESSAGE_CONTENT");
      yield* Scope.close(crashed, Exit.void);
      expect((yield* log).length).toBeGreaterThan(0);
      yield* start(
        yield* Scope.make(),
        parent,
        [
          [...text("0", "Paris is 18°C"), finish("stop")],
          [...text("0", "It's 18°C."), finish("stop")],
        ],
        run,
      );
      yield* snapshot("crash-mid-child", [yield* complete]);
    }).pipe(Effect.provide(shared())),
  );
});
