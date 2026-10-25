import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Prompt } from "effect/ai";
import * as Thread from "../src/Thread.ts";

const user = (id: string, text: string): Thread.Entry => ({
  id,
  message: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
});

describe("Thread.Entry", () => {
  it.effect("round-trips an assistant message with a tool call", () =>
    Effect.gen(function* () {
      const entry: Thread.Entry = {
        id: "m1",
        message: Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("text", { text: "Let me check." }),
            Prompt.makePart("tool-call", {
              id: "c1",
              name: "get-weather",
              params: { location: "Paris" },
              providerExecuted: false,
            }),
          ],
        }),
      };
      const encoded = yield* Schema.encodeEffect(Thread.Entry)(entry);
      const decoded = yield* Schema.decodeUnknownEffect(Thread.Entry)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(entry);
    }),
  );

  it.effect("round-trips the run id", () =>
    Effect.gen(function* () {
      const entry: Thread.Entry = { ...user("m1", "Hi"), runId: "r1" };
      const encoded = yield* Schema.encodeEffect(Thread.Entry)(entry);
      const decoded = yield* Schema.decodeUnknownEffect(Thread.Entry)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded).toEqual(entry);
    }),
  );
});

describe("Thread.layerMemory", () => {
  it.effect("loads an unknown thread as empty", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      expect(yield* thread.load("nope")).toEqual([]);
    }).pipe(Effect.provide(Thread.layerMemory)),
  );

  it.effect("stores a repeated commit once", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      const entries = [user("a", "A"), user("b", "B")];
      yield* thread.commit("t1", "r1", entries);
      yield* thread.commit("t1", "r1", entries);
      expect(yield* thread.load("t1")).toEqual(entries.map((entry) => ({ ...entry, runId: "r1" })));
    }).pipe(Effect.provide(Thread.layerMemory)),
  );

  it.effect("records the run that appended each entry", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      const [a, b, c] = [user("a", "A"), user("b", "B"), user("c", "C")];
      yield* thread.commit("t1", "r1", [a, b]);
      yield* thread.commit("t1", "r2", [c]);
      // Recommitted by another run, an entry keeps its first run.
      yield* thread.commit("t1", "r2", [a]);
      expect((yield* thread.load("t1")).map((entry) => [entry.id, entry.runId])).toEqual([
        ["a", "r1"],
        ["b", "r1"],
        ["c", "r2"],
      ]);
    }).pipe(Effect.provide(Thread.layerMemory)),
  );

  it.effect("appends only the new entries of a partially overlapping commit", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      const [a, b, c] = [user("a", "A"), user("b", "B"), user("c", "C")];
      yield* thread.commit("t1", "r1", [a, b]);
      yield* thread.commit("t1", "r2", [b, c]);
      expect((yield* thread.load("t1")).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      yield* thread.runEnded("t1", "r2", { _tag: "Success" });
    }).pipe(Effect.provide(Thread.layerMemory)),
  );
});

describe("Thread.layerMemory claims", () => {
  it.effect("lets one run hold a thread at a time", () =>
    Effect.gen(function* () {
      const thread = yield* Thread.Thread;
      yield* thread.claim("t1", "r1");
      // The same run claims again when it resumes.
      yield* thread.claim("t1", "r1");
      expect(yield* Effect.flip(thread.claim("t1", "r2"))).toEqual(new Thread.ThreadBusy({ activeRunId: "r1" }));
      // Other threads are unaffected.
      yield* thread.claim("t2", "r2");

      // Only the active run can release.
      yield* thread.release("t1", "r2");
      expect(yield* Effect.flip(thread.claim("t1", "r2"))).toMatchObject({ _tag: "ThreadBusy" });
      yield* thread.release("t1", "r1");
      yield* thread.claim("t1", "r2");
    }).pipe(Effect.provide(Thread.layerMemory)),
  );
});
