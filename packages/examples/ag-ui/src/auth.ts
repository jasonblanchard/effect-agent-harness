import { Context, Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/http";

export const Principal = Schema.Struct({ userId: Schema.String, name: Schema.String });
export type Principal = typeof Principal.Type;

/** The principal the route verified, which the routes provide to each run. */
export class AuthContext extends Context.Service<AuthContext, Principal>()("ag-ui/Auth") {}

/** Who the run acts for. The system prompt and the email tool require it. */
export class CurrentUser extends Context.Service<CurrentUser, Principal>()("ag-ui/CurrentUser") {}

/**
 * Builds `CurrentUser` for each run from its `AuthContext`. A real server
 * might look the user up here; this one takes the principal as it is.
 */
export const CurrentUserLayer = Layer.effect(CurrentUser)(AuthContext);

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
