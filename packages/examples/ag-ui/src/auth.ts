import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { Agent } from "effentic";

export const Principal = Schema.Struct({ userId: Schema.String, name: Schema.String });
export type Principal = typeof Principal.Type;

/** What the routes pass to the runner as `context`, and what the agent reads back from `Agent.CurrentRun`. */
export const AppContext = Schema.Struct({ principal: Principal });

/** The only token this example accepts; `src/agent.ts` sends it. A real server verifies a JWT or asks its identity provider. */
export const DEMO_TOKEN = "demo-token";

export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  {},
) {}

/** Reads `Authorization: Bearer <token>` and returns the principal it belongs to. */
export const authenticate = Effect.gen(function* () {
  const { authorization } = yield* HttpServerRequest.schemaHeaders(
    Schema.Struct({ authorization: Schema.String }),
  ).pipe(Effect.mapError(() => new Unauthorized()));
  if (authorization !== `Bearer ${DEMO_TOKEN}`) {
    return yield* new Unauthorized();
  }
  return { userId: "demo", name: "Demo User" } satisfies Principal;
});

/** The principal of the run in progress. The routes always set it, so a missing one is a bug. */
export const currentPrincipal = Effect.gen(function* () {
  const run = yield* Agent.CurrentRun;
  const { principal } = yield* Schema.decodeUnknownEffect(AppContext)(run.context);
  return principal;
}).pipe(Effect.orDie);
