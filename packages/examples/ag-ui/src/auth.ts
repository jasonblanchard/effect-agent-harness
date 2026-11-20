import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

export const Principal = Schema.Struct({ userId: Schema.String, name: Schema.String });
export type Principal = typeof Principal.Type;

/**
 * The principal the request was authenticated as, which the routes provide to
 * each run. The system prompt and the email tool require it, like any other
 * service.
 */
export class AuthContext extends Context.Service<AuthContext, Principal>()("ag-ui/Auth") {}

/** The only token this example accepts; `src/agent.ts` sends it. A real server verifies a JWT or asks its identity provider. */
export const DEMO_TOKEN = "demo-token";

export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * Authenticates every endpoint it is attached to from `Authorization: Bearer <token>`, and provides the principal,
 * never the token, as `AuthContext`. A request without the demo token gets `401` before its handler runs.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: AuthContext; requires: never }
>()("ag-ui/Authentication", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}

export const AuthenticationLayer = Layer.succeed(
  Authentication,
  Authentication.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === DEMO_TOKEN
        ? Effect.provideService(httpEffect, AuthContext, { userId: "demo", name: "Demo User" })
        : Effect.fail(new Unauthorized()),
  }),
);
