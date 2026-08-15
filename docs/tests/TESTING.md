# Testing — the canonical reference

This is the single source of truth for how tests run in this repo: the commands,
how the test database is isolated, the production guard that keeps tests off the
live data, the CI gate, and what each environment (Replit, GitHub, Claude/Codex
sandboxes) is responsible for. If another doc disagrees with this one, this one
wins — tell whoever owns the other doc.

---

## Quick commands

```sh
# Run one (or a few) api-server test files — fast inner loop:
bash artifacts/api-server/scripts/run-test.sh src/__tests__/<file>.test.ts

# Run the full api-server suite (the authoritative DB suite):
pnpm --filter @workspace/api-server test

# Other suites:
pnpm typecheck                                   # whole-repo typecheck (no DB)
pnpm --filter @workspace/overhype-me run test    # frontend vitest (no DB)
pnpm --filter @workspace/db run test             # lib/db migration tests
```

Never run `node … --test <file>` directly. The wrapper scripts are what call the
production guard (`assert_not_production`) **and** redirect `DATABASE_URL` to a
test database — a bare `node` invocation bypasses both. So a direct run is *not*
caught by the guard (the guard never executes); it runs against whatever
`DATABASE_URL` already points at, which on Replit is the live `heliumdb` public
schema. That's the danger, and it's why you always go through `run-test.sh`
(targeted) or `pnpm … test` (full suite), which set up isolation and the guard for
you.

(Two separate failure modes, often confused: `node --test <file>` *without*
`--import tsx/esm` can't even read a `.ts` file — plain Node has no TypeScript
loader. Adding `--import tsx/esm` fixes the loader but still bypasses the
wrappers, which is the dangerous case above.)

The full-suite command runs its own `pretest`, which applies the DB schema setup
(`push-force` + `migrate`), codegen, and the api-zod build for you — so you don't
need to run those by hand for a normal full run. You *may* run them explicitly
after schema work when you want to validate that step directly:

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
```

…but don't bypass `pnpm --filter @workspace/api-server test` (which invokes
`run-tests-sharded.sh` with the right setup) for normal full-suite verification.

---

## Typecheck & codegen order

Generated API artifacts and workspace libs must be built before package-local
checks, or you get false negatives (project references to `lib/*` that don't
exist yet in a cold environment):

```sh
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm typecheck          # repo-level; prefer this for general typechecking
```

---

## Topology & roles — who trusts what?

Replit is the dev/prod trunk. GitHub is the manual sync hub for Claude/Codex work
**and** the authoritative CI gate for changes before they merge to `main` and get
pulled back into Replit. GitHub is *not* the single source of truth, and Replit is
not subordinate to it — they run the **same** suite, so a green check means the
same thing in both places.

| Environment | Role | Gate |
|---|---|---|
| Replit | Dev/prod trunk | Replit-run tests before Replit-side changes are trusted |
| GitHub | Sync hub + PR gate for Claude/Codex | Required `Build` + `Test` checks on `main` |
| Claude / Codex sandboxes | Advisory pre-checks | Report local failures clearly; defer DB-environment failures to CI |

Claude's sandbox provisions Postgres on every session. **Codex's does not** — it
boots DB-less for speed, so DB-backed tests are unavailable there by default;
see [`ai-context/codex-environment.md`](ai-context/codex-environment.md).

The practical rule: when you push a PR (Claude/Codex), GitHub CI is what must go
green before merge. When you change something directly in Replit, run the same
suite in Replit before you trust it. If the two ever disagree on the *same*
commit, that is an environment-parity bug to chase down — not a flaky test to
re-run until it passes.

---

## Isolation modes

There are two runners, and they isolate differently on purpose. This is why you
can see both `heliumdb_test` and `heliumdb_t_*`/`heliumdb_w_*` objects without any
contradiction — they belong to different runners.

**Full suite — `pnpm --filter @workspace/api-server test`** (runs
`scripts/run-tests-sharded.sh`):

- **Per-worker databases (default).** The runner builds one structure-only
  *template* database for the run (`CREATE DATABASE … TEMPLATE template0` +
  `CREATE EXTENSION vector` + the `public` DDL, structure only, + the boot-time
  engine-catalogue seed), locks it, then gives each shard its own fast
  `CREATE DATABASE … TEMPLATE` clone. Each worker runs against its **own**
  database, so global-state tests can't race each other.
- **Per-schema (fallback).** When `CREATE DATABASE` is denied, each shard instead
  gets its own isolated schema in the source DB, cloned and seeded independently.
  Same isolation guarantee, slower setup.
- Shard count auto-selects `min(nproc, 4)`.
- **No dev/prod data is copied** — only structure. Tests that need rows (facts,
  pricing, moderation state, Pexels JSON, …) must create them explicitly in the
  test or a focused factory/helper.

**Targeted — `bash artifacts/api-server/scripts/run-test.sh <file>`:**

- Uses a single **cached** `heliumdb_test` schema for speed. It re-clones that
  schema only when it's stale (fewer tables than `public`) or when you pass
  `--setup`.
- Intended for the inner loop / debugging a specific file — **not** the
  authoritative gate. The full suite is the gate.

After a migration, re-clone the targeted schema from the already-updated `public`
schema:

```sh
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
bash artifacts/api-server/scripts/run-test.sh --setup src/__tests__/<file>.test.ts
```

(`--setup` re-clones from `public`; it does not run migrations itself.)

---

## Test types

Pure-logic tests live alongside the suite (e.g. tokenizer/grammar:
`factTokenizer.test.ts`, `autoConjugatePersonSubjectVerbs.test.ts`; enrichment
resolver: `enrichmentOverridesResolver.test.ts`; taxonomy health:
`taxonomyHealth.evaluate.test.ts`). Assert **invariants**, not just the reported
example, with negative cases.

**Integration / API tests** — `artifacts/api-server/src/__tests__/*.test.ts`, run
via the runners above against Postgres + pgvector. They exercise routes + domain
logic end to end with DB-backed fixtures created in-test.

**End-to-end / route-load smoke tests** — `artifacts/overhype-me/e2e/*.spec.ts`,
run via Playwright against a **real dev stack** — not a mock. `routeLoadSmoke.spec.ts`
in particular is the regression net for the crash/reload-loop bug class (see
`known-failure-patterns.md` → "Self-retriggering recovery with no bounded exit"):
it asserts each heavy route actually renders, doesn't loop, and doesn't hit the
Sentry error boundary.

Locally (both servers already running, e.g. via Replit's workflows):

```sh
pnpm --filter @workspace/overhype-me run e2e:smoke
```

Outside Replit (CI, or a bare Claude Code environment) there's no platform
path-router splitting `/api` from the SPA, so two env-gated escape hatches in
`vite.config.ts` / `playwright.config.ts` stand in:

- `E2E_API_PROXY_TARGET` — points Vite's dev-server proxy at the api-server
  (e.g. `http://localhost:8080`). Inert when unset.
- `E2E_CHROMIUM_PATH` — pins Playwright to a system-provided Chromium binary
  instead of its managed download (needed where browser downloads are
  disabled and the pinned Playwright version may not match what's
  preinstalled). Inert when unset.

The suite authenticates via `POST /api/auth/dev-admin-login`, which looks up
a specific bootstrap admin row — seed it first with
`pnpm --filter @workspace/api-server exec tsx scripts/seed-dev-admin.ts`
(idempotent; imports the canonical email from `src/lib/auth.ts` so it can't
drift from the login route). See the `E2E Smoke` job in
`.github/workflows/build.yml` for the full sequence CI runs.

**Admin UI tests** — Frontend tests via Vitest under `artifacts/overhype-me`.
For admin surfaces, prioritize the async-status contract (per-item + aggregate
states) and preview/runtime parity where relevant.

**Async job tests** — Test the terminal state, not the enqueue. Assert
`pending → processing → done | failed` transitions and that per-item/aggregate
status is reported. The image preview bench must **not** read the production
`aiScenePrompts` cache (tests assert this) — see
`.agents/memory/image-prompt-preview-parity.md`.

**Migration / backfill tests** — Apply the migration to the local public schema,
re-clone the test schema (`run-test.sh --setup`), then run the affected tests.
Backfills should be tested for **idempotency** (run twice == once) and for
old/partial/failed/skipped/no-op rows. See
[`migrations-and-backfills.md`](./migrations-and-backfills.md).

**Regression fixtures** — When you fix a bug, add a regression case that proves
the **general** invariant. Tokenizer/grammar regressions in particular should
include `They keep`, `Sharks have`, name possessives, and the pronoun sets
exercising the changed branch.

External services (Pexels, object storage, pricing, embeddings, image/video
generation, Stripe) must be stubbed/mocked or disabled with test-mode helpers in
any of the above — no real credentials or network. See
`.agents/memory/test-db-isolation.md`, `test-schema-isolation.md`,
`test-idle-drain-timeout.md`, `running-long-test-suites.md` for isolation
gotchas.

---

## Database-name glossary

These names are easy to confuse. Only the "Safe target?" column matters for "can I
point `DATABASE_URL` here?".

| Name | Meaning | Safe target? |
|---|---|---|
| `heliumdb` | Replit **dev** database name. **Not** production — see the note below the table. | **No** — production guard refuses |
| `heliumdb_test` | On Replit: the **test database** (`TEST_DATABASE_URL` in `.replit` points here). In `run-test.sh`: the cached **schema** of the same name. | Yes |
| `overhype_test` | CI / sandbox test database | Yes |
| `heliumdb_t_*` | Full-suite template database | Temporary, runner-owned |
| `heliumdb_w_*` | Full-suite per-worker database | Temporary, runner-owned |
| `heliumdb_s_*` | Full-suite per-schema fallback worker schema | Temporary, runner-owned |

`heliumdb_test` is the one name that means two things, and that's fine: on Replit
it's the *database* that `TEST_DATABASE_URL` redirects `DATABASE_URL` to (so the
runner never touches `heliumdb`), and `run-test.sh` independently caches a *schema*
called `heliumdb_test` inside whatever database it targets. Different layer, same
label. (Note: the hyphenated `heliumdb-test` is not used anywhere — the configured
name is the underscore form.)

**Production is a separate database, not `heliumdb`.** `heliumdb` (on the
`helium` host) is **development only**. Production is `neondb`, hosted on
Neon — a different provider entirely. This table used to describe `heliumdb`
as shared between prod and dev; that stopped being true, and the guard below
now protects both databases explicitly rather than relying on that old
overlap.

---

## Production guard (safety-critical)

Both runners call `assert_not_production` before doing anything destructive. It
refuses to run when:

- `NODE_ENV` is `production` (case-insensitive); or
- the target database name is `heliumdb`, `neondb`, `production`, anything
  containing `prod`, or any name listed in `TEST_DB_PROTECTED_NAMES`; or
- the host matches a `*.neon.tech` marker or a marker in
  `TEST_DB_PROTECTED_HOSTS`.

The match on `heliumdb`/`neondb` is **exact**, which is why `heliumdb_test`,
`neondb_test`, `overhype_test`, and the temporary `heliumdb_t_*` / `heliumdb_w_*`
clones are all allowed. To run tests, point `DATABASE_URL` at the **test**
database (`heliumdb_test` on Replit — via `TEST_DATABASE_URL` — `overhype_test`
in CI/sandbox) — never at `heliumdb` or `neondb`.

`neondb` and the generic `neon.tech` host marker were added as guard defaults
(rather than relying solely on the env-var extension lists, which are unset in
every environment this guard runs in) once the dev/prod split meant `heliumdb`
no longer implied production. See
[`replit-environment.md`](../ai-context/replit-environment.md#dev-and-production-are-two-separate-databases-and-the-safety-guard-only-knows-about-one-of-them)
for the full topology.

---

## CI gate + parity contract

`.github/workflows/build.yml` defines these jobs, which run on every PR to
`main`:

- **`Classify changed paths`** — decides whether the heavy suites below can be
  skipped for a docs-only PR. Every failure path falls back to running
  everything; push-to-main skips classification entirely.
- **`Build`** — install, validate migration snapshots, the repo-health guards
  (docs accuracy, codegen drift, loop-metrics, CI-classifier and Bash-guard
  logic), and `pnpm run build` (typecheck + build). **Never** skipped.
- **`Test`** — the api-server suite against a real Postgres + pgvector service
  container, with `DATABASE_URL` set to `overhype_test`. The suite's own runner
  does all DB setup (per-worker clones); CI just supplies the database. This
  job also runs the **`@workspace/db`** suite, against a *separate*
  `overhype_db_test` database — see the job's "Prepare database" step for why
  that separation is a correctness requirement, not tidiness.
- **`Frontend Test`** — the `@workspace/overhype-me` vitest suite (jsdom; no
  server or DB).
- **`E2E Smoke`** — Playwright route-load smoke against the real dev stack
  (api-server + Vite), the regression net for the crash/reload-loop bug class.

The last three are gated by the classifier and report success when skipped.

For frontend, package/workspace-script, Vite/build-config, or build-time
environment-variable changes, reproduce the Build gate locally/sandbox-side with
`pnpm run build` when the environment can run it. Package-local typechecks are not
a substitute: the repo-level build also loads production Vite config for every
workspace package.

> Repository settings currently require PRs and require the `Build` and `Test`
> checks to pass before merging to `main`. This is configured in **GitHub
> repository settings (a ruleset), not in the workflow file** — don't go hunting
> for it in the tree. If that policy ever changes, update this document and
> `AGENTS.md` together.

Because Replit and GitHub run the same api-server suite, a green `Test` means the
same thing in both. If they disagree on the same commit, treat it as an
environment-parity bug, not a flake.

---

## Manual QA / UAT

Product-visible behavior needs a click-through check against intent (David tests
the product, not the diff). "Done" = the intended behavior can be exercised in the
app. In **feature mode**, Claude Code additionally ships paired `TEST_RUN` + `UAT`
docs per PR by default (see `CLAUDE.md` for when/naming and
[`test-run-contract.md`](test-run-contract.md) for what the `TEST_RUN` must
contain — it verifies only what Replit's live environment can verify, not what
already passed pre-merge). **In bugfix mode the pairing is conditional, not a
default** — see
[`working-modes.md`](../ai-context/working-modes.md#tier-b--elevated-fix): a
Tier A fix ships neither doc, and a Tier B fix ships a UAT only when the fix has
product-visible behavior and a TEST_RUN only when something genuinely needs
Replit's live environment. Codex should at minimum describe the manual steps to
observe the change.

---

## How to report test failures

This distinction is the whole reason this testing roadmap exists — an invalid
command was once reported as a scary red product failure. Keep these separate:

- **Valid repo-command failure** (e.g. `run-test.sh` or `pnpm … test` actually
  fails) → report it as a test failure. It may block merge.
- **Invalid command, or no test DB in the sandbox** (e.g. raw `node --test`, or a
  Claude/Codex sandbox without Postgres) → report it as an
  environment/command failure, **deferred-to-CI** — never as a product failure.
  GitHub CI has the database and is the authoritative gate.
- **Self-corrected invalid command** (typed wrong, then fixed) → do not report the
  first attempt as a failure at all.

In a final summary, always separate valid repo-command failures (which may block
merge) from invalid-command/environment failures (which must not block if the
valid command passed).

---

## Not yet in the CI gate (fast-follow)

- **`lib/redact`** — not covered by any CI job. Run it by hand
  (`pnpm --filter @workspace/redact test`) when touching that package.

Frontend vitest and the `lib/db` migration tests used to be listed here; both
are now gated (the `Frontend Test` job and the `Test` job's `@workspace/db`
step respectively) and are described in the CI section above.

---

## Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| Guard refuses; `DATABASE_URL` is `heliumdb` | Expected — that's the prod/dev DB | Point `DATABASE_URL` at `heliumdb_test` (Replit) or `overhype_test` (CI/sandbox) |
| `node --test` can't read a `.ts` file | Invalid command — plain Node has no `tsx/esm` loader | Use `run-test.sh` (targeted) or `pnpm … test` (full suite); not a test failure |
| Sandbox has no Postgres | Expected in Codex (DB-less by default); in Claude it means the SessionStart hook failed | Defer DB verification to GitHub CI; report as environment, not product, failure. For a Codex task that genuinely needs the suite, set `CODEX_SETUP_DB=1` on the environment and re-run — it cannot be fixed mid-task, since Codex has no network then |
| CI `Test` job is red | A real gate failure until proven otherwise | Read the failing test; treat as a genuine regression unless shown to be a parity/env issue |

## A note on older docs

Older PR-specific `TEST_RUN` / `UAT` docs under `docs/` are **historical
records** of what was tested at the time. For current commands and policy, follow
this document and `AGENTS.md` — not those.
