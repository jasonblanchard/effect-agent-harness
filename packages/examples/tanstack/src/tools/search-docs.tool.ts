import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import type { Toolkit } from "effect/ai";

const Hit = Schema.Struct({ source: Schema.String, excerpt: Schema.String });

/**
 * A slow search over a few made-up sources. While it runs, it reports the hits
 * found so far through `ctx.preliminary`: effect-agent-harness streams each one
 * to the page as an `ACTIVITY_SNAPSHOT`, and only the final value reaches the
 * model. Progress here is a partial result, so it shares the result's type.
 */
export const SearchDocs = Tool.make("search-docs", {
  description: "Search the team's documentation sources for a topic. Slow: it reads each source in turn.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({ description: "What to search for" }),
  }),
  success: Schema.Struct({
    done: Schema.Finite,
    of: Schema.Finite,
    hits: Schema.Array(Hit),
  }),
});

const SOURCES = ["Handbook", "Runbooks", "Design notes", "Changelog", "FAQ"];

export const searchDocs = ({ query }: { readonly query: string }, ctx: Toolkit.HandlerContext<typeof SearchDocs>) =>
  Effect.gen(function* () {
    const hits: Array<typeof Hit.Type> = [];
    for (const [index, source] of SOURCES.entries()) {
      yield* Effect.sleep("700 millis");
      // Every other source "finds" something, so the card has something to show.
      if (index % 2 === 0) {
        hits.push({ source, excerpt: `${source} mentions "${query}".` });
      }
      yield* ctx.preliminary({ done: index + 1, of: SOURCES.length, hits: [...hits] });
    }
    return { done: SOURCES.length, of: SOURCES.length, hits };
  });
