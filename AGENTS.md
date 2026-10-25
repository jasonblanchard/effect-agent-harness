# effentic

Effect-based AG-UI agent library. pnpm monorepo:

- `packages/effentic` — the library (`Agent`, `AgUi`, `Messages`, `Thread`, `Checkpoint`, `EventLog`, `Runner`, `Sse` modules). See its `AGENTS.md`.
- `packages/examples/ag-ui` — a runnable example wiring the library to Anthropic. See its `AGENTS.md`.
- `packages/examples/tanstack` — a browser chat (TanStack Start + TanStack AI) on an effentic backend. See its `AGENTS.md`.
- `openspec/` — spec-driven change proposals (see "Planning changes" below).

## Commands

Run from the repo root. Each one delegates to the packages via `pnpm -r --if-present run <script>`, so it runs inside each package's own scope.

| Command             | What it does                                |
| ------------------- | ------------------------------------------- |
| `pnpm tsc`          | Typecheck every package                     |
| `pnpm lint`         | Oxlint with the type-aware Effect rules     |
| `pnpm test`         | Vitest                                      |
| `pnpm format`       | oxfmt, writes packages and root-level files |
| `pnpm format:check` | oxfmt, check only                           |

Before calling work done, run `pnpm tsc && pnpm lint && pnpm test && pnpm format:check`, and fix every finding. Lint runs with `--deny-warnings`, so warnings fail too. Don't silence a lint rule without saying why. CI (`.github/workflows/ci.yml`) runs the same four commands on every push to `main` and on every pull request.

To target one package, filter by name: `pnpm --filter effentic test`. The root package is `effentic-monorepo`, so `--filter effentic` matches only the library.

## Tooling rules

- **Use pnpm only.** `npm`/`npx` fail on the `devEngines` check. Use `pnpm exec` / `pnpm dlx`.
- **Never run `tsc` against the root tsconfig.** It's a base config. Typecheck through `pnpm tsc` instead.
- **Versions are pinned on purpose.** `typescript` (catalog, `7.0.2`), `@effect/tsgo`, `oxlint` and `oxlint-tsgolint` must be versions that `@effect/tsgo` supports. The `prepare` script runs `effect-tsgo patch`, and the patch refuses unsupported versions. Before bumping any of them, check the "Supported Package Versions" table in the `@effect/tsgo` README.
- **The Effect language service plugin has `diagnostics: false`** in every tsconfig, so Effect diagnostics come only from Oxlint. Lint output is where to look for them, not `tsc`.
- **`effecttsgo/unstable-api-usage` is off** (`.oxlintrc.json`). `effect/ai` and `effect/http` are unstable by design and this project is built on them.
- **Package scripts pass the root config explicitly** (`oxlint -c ../../.oxlintrc.json`, `oxfmt -c ../../.oxfmtrc.json`), because neither tool looks in parent directories for its config. A new package must do the same, using the right relative depth.
- **Formatting:** oxfmt, 120 columns, double quotes, semicolons. Don't hand-format. Run `pnpm format`.

## Effect conventions

- Effect v4 (`effect@4.0.5`). The authoritative docs are the installed package's own guide, `node_modules/.pnpm/effect@4.0.5/node_modules/effect/CLAUDE.md`, plus its `ai-docs/`. Prefer them over memory and over web docs written for Effect v3.
- Errors are `Schema.TaggedError` classes with a brand type argument: `Schema.TaggedError<Self, { readonly brand: unique symbol }>()(...)`.
- Use `Schema.Finite` for numbers, not `Schema.Number`, unless `NaN`/`Infinity` really are valid.
- Prefer the most direct combinator. The linter suggests these, for example `Effect.orElseSucceed` over `Effect.catch(() => Effect.succeed(...))`.
- Relative imports use the `.ts` extension (`./Agent.ts`). Type-only imports use `import type`, because `verbatimModuleSyntax` is on.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Optional fields are typed `?: T | undefined` where `undefined` may be passed explicitly.

## Version control

The repo is a colocated **jj** + git repo. jj snapshots the working copy automatically, so every file written to disk, including stray build output, gets tracked in the current change. Keep generated files out of the tree. Don't use `git stash` or other index-manipulating git commands; ask before committing.

## Planning changes

Larger features go through OpenSpec (`openspec/changes/<name>/` with `proposal.md`, `design.md`, `specs/`, `tasks.md`). Use the `openspec-*` skills / `/opsx:*` commands to propose, apply and archive changes. When implementing an existing change, keep `tasks.md` checkboxes in sync with what's done.
