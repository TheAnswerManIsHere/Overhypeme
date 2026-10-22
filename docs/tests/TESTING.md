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
pnpm --filter @workspace/overhype-me run e2e:surfaces
```

Both, because CI runs both. `e2e:smoke` is the route-load suite; `e2e:surfaces`
is the admin-surface suite drained out of the UAT documents (Queue Health and
Admin Help). They are separate scripts rather than one so a red build names
which suite broke — but a developer following this page should exercise
everything the gate does, or the local check quietly covers less than CI.

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
drift from the login route). See the `e2e-shard` job in
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

**Verifying a widened timing margin didn't gut the test.** A timing-sensitive
test (a stall ceiling, a debounce window, a poll interval) that flakes under
real CI load usually needs its margins widened, not its assertions changed —
but "it passes now" proves nothing on its own, since a margin wide enough to
also swallow the regression the test exists to catch would pass too, silently.
**Mutation-test it**: deliberately break the production code the test is
guarding (e.g. stop resetting a progress timestamp, so a zero-progress ceiling
degrades into a total-duration cap), confirm the widened test still fails on
that specific mutation with the right assertion, then revert the mutation.
That the *old*, tighter test also passed under local load is expected and is
exactly why it isn't evidence either way — the mutation check is what actually
distinguishes "still detects this specific regression" from "widened past the
point of checking anything." **Scope of what this proves:** killing the
mutant confirms the widened test still catches *that* fault; it says nothing
about whether the margins are wide enough to hold under real CI load
generally, or whether the test would catch a *different* regression than the
one mutated. Repeated CI runs are the separate evidence for reliability under
load — this technique answers "did the widening blind the test," not "is the
test flake-free now." Worked example: PR #515 widened `cliJobPoller.test.ts`'s
stall margins 8x (15ms of real headroom to 100ms) after CI failures escalated
to blocking every manual-touching docs PR, and used this technique to confirm
the poller's zero-progress invariant was still actually being asserted after
the widening.

**Every new assertion is falsified before it is trusted.** A green run says
nothing about an assertion that cannot fail. Break the thing each assertion
guards, watch its test go red **for the stated reason**, then revert. #563,
#567 and #570 drained UAT steps into CI, and their harvest notes count 13
assertions weaker than their test names in #563 and 5 vacuous ones in #567.
Review caught most of them, not a green run. The shapes that recurred:

- **The fixture is not a state the product reaches.** Grammar-invalid CSV
  rows that queue nothing whether or not the cap fires; an "absent" Visual
  Concept sent as a truthy empty scaffold; a concept-less candidate in a
  stage a concept-less candidate cannot reach. The assertion passes for a
  reason other than the one it claims.
- **"This did not happen" needs a fixture that would show a mark.**
  `fact_enrichment_versions` has no `updated_at`, so a refused write that
  matches the starting state byte for byte is undetectable. Choose a starting
  state the forbidden write would visibly destroy, and check persistence
  after each request, not once after several that can cancel out.
- **A phrase in the test name that nothing asserts** ("above the cards",
  "including ones that have never run").
- **Passing by luck of layout.** The admin console scrolls an *inner pane*,
  so `window.scrollY` is 0 whether or not a scroll happened. A heading that
  happens to sit below the fold proves a scroll only today.
- **A scope wider than the thing under test** — counting headings across
  `<main>` includes the chapter nav's own — and **a substring standing in for
  a name** (`enrichment` is inside `fact_enrichment_backfill`).
- **Playwright: inverting `toBeVisible` does not falsify it.** Both
  `toHaveCount(0)` and `toBeHidden` pass on a page that has not rendered yet.
  Break the **locator** instead, since a wrong locator is the product failure
  a visibility assertion guards.
- **A mutation only falsifies an assertion that a test actually reaches.** A
  "verified" teardown mutation came back green against a test whose loop body
  never ran.
- **A fix for one round can create the next round's vacuous assertion.**
  Making a fixture correct in #567 round 2 removed the contrast round 3's
  persistence check depended on. Re-falsify after every fixture change.

**The harness mirrors the app, or its tests measure the harness.**
`routes.admin.test.ts` once built its app with bare `express.json()` (100 KB),
below the 2 MB limit `app.ts` sets. Large-but-legal imports got a 413 before
the route's own caps ran. Copy the real middleware settings.

**A "module X must not reach Y" guard walks the TypeScript AST, not a regex
over imports.** A regex misses side-effect and dynamic imports.
`doubleSelection.test.ts` and `transientRenderLog.salt.security.test.ts` do it
properly; reuse their approach.

**A browser spec that mutates anything needs `ALLOWED_ORIGINS` off Replit.**
`parseAllowedOrigins()` (`app.ts`) reads only `ALLOWED_ORIGINS` and
`REPLIT_DEV_DOMAIN`, so on a local or CI stack the allowlist is empty and
every browser-initiated mutation gets `403 {"error":"Origin not allowed"}`.
Read-only specs and Playwright's `APIRequestContext`, which sends no `Origin`,
never hit it. Running `adminPermissions.spec.ts` locally also needs
`ENABLE_DEV_ADMIN_LOGIN=true` and the dev-admin seed. Without them every admin
test fails with a 404 from `dev-admin-login` that looks like a regression.

**A feature-grid write takes effect at once in the writing process.**
`setTierFeature()` calls `bustEntitlementCache()`, so the resolver's ~60 s
cache matters only across processes. A previewing admin always resolves as
`registered`, whatever their stored tier
([`membership-entitlements.md`](../ai-context/membership-entitlements.md)), so
a fixture keyed to `membershipTier` is wrong on the preview path.

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
as shared between prod and dev; that stopped being true. Neither database is
named anywhere in the guard below: both are refused because neither carries
the test-database marker.

---

## Ordinary test accounts and the production-mode stack

Launch Phase 2, increment 2 (#631) gives browser and API tests two things the
dev stack did not have: ordinary accounts, and a server in production mode.

**Ordinary accounts.** `artifacts/api-server/scripts/seed-e2e-test-accounts.ts`
seeds one **free** and one **paid** account, defined in
`scripts/e2e-test-accounts.json` (which the Playwright helper
`e2e/helpers/testAccounts.ts` reads too). Both have a verified email and a
password and sign in through the real `/api/auth/local-login`, never through the
dev-admin backdoor. The paid account is paid the way a real comp is — an admin
grant written by `applyAdminGrant` (entitlement row, history, derived-tier
recompute) — never by setting the tier. The password is published in this
repository, so the seed refuses any database not marked as a test database
(the rule below) and any production or deployment environment.

**The production-mode stack.** `artifacts/api-server/src/testing/productionModeLauncher.ts`
boots the real server with `NODE_ENV=production` and exactly one thing replaced:
the email transport, which writes each message as JSON to `E2E_MAIL_SINK_DIR`
instead of sending it through Resend. The replacement sits below the email
queue — the enqueue, the worker's claim and the job handler all run as in
production. It is a test-harness substitution, not a selectable double: the
deployment entrypoint (`index.ts`, the only esbuild entry) never imports
`src/testing/`, which `__tests__/testHarnessIsolation.test.ts` enforces. The
launcher refuses to start on an unmarked database, with any Resend key set, on a
real deployment, without a mail-sink directory, or when `SITE_BASE_URL` (where
email links point) is not a localhost URL.

Baseline journey 1 (`e2e/authJourney.spec.ts`) runs on that stack in the per-PR
E2E job: register through the real form, keep the Secure/SameSite=None session
cookie on a local origin, verify through the captured link, a protected action,
sign out, recover the password through the captured reset link, the old
password refused and the new one accepted, and the dev-admin login absent. CI
gives it its own database (`overhype_e2e_auth`), so the dev server's queue
worker can never claim its email. To run it locally:

```sh
createdb overhype_e2e_auth
psql postgres://overhype:overhype@localhost:5432/postgres -c "ALTER DATABASE overhype_e2e_auth SET overhype.test_database = 'yes';"
# then push-force + migrate + the E2E account seed against it
cd artifacts/api-server && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production PORT=8081 \
  DATABASE_URL=postgres://overhype:overhype@localhost:5432/overhype_e2e_auth \
  CRON_SECRET=x IP_HASH_SALT=local-auth-journey-salt-0123456789 \
  SITE_BASE_URL=http://localhost:5174 ALLOWED_ORIGINS=http://localhost:5174 \
  E2E_MAIL_SINK_DIR=/tmp/overhype-mail node --import tsx/esm src/testing/productionModeLauncher.ts
cd artifacts/overhype-me && PORT=5174 BASE_PATH=/ API_PROXY_TARGET=http://localhost:8081 pnpm exec vite
E2E_BASE_URL=http://localhost:5174 E2E_MAIL_SINK_DIR=/tmp/overhype-mail pnpm --filter @workspace/overhype-me run e2e:auth
```

The launcher's environment is constructed: it refuses any variable outside
`PRODUCTION_MODE_ENV_ALLOWLIST` (`src/testing/launchEnvironment.ts`), so a
vendor key cannot reach it. That is why the recipe uses `env -i` and `node`
rather than `pnpm exec`, which adds variables of its own.

The journey fails, rather than skipping, when `E2E_MAIL_SINK_DIR` is unset — so
a plain `playwright test` against the dev stack reports it red. Run the named
suites (`e2e:smoke`, `e2e:surfaces`, `e2e:accounts`, `e2e:auth`) instead.

---

## Deploy-selectable doubles

A double replaces a vendor at the seam the production code already crosses, and
is chosen only by an environment value that names it. The one rule, in
`artifacts/api-server/src/lib/doubleSelection.ts`, applies to every double:

- unset (or the real value) means the real backend;
- an unrecognised value refuses to boot, everywhere;
- any double named in a production boot (`NODE_ENV=production` or
  `REPLIT_DEPLOYMENT=1`) refuses to boot.

`lib/bootChecks.ts` runs the refusal before any other module loads, so the port
never opens; `__tests__/doubleSelection.test.ts` boots the real entrypoint to
prove it. A new double adds its row to `SELECTORS` there.

| Selector | Double | Needs |
|---|---|---|
| `STORAGE_BACKEND` | `local-double` — `lib/localObjectStorage.ts` | `STORAGE_DOUBLE_DIR` (absolute), plus the usual `PRIVATE_OBJECT_DIR` / `PUBLIC_OBJECT_SEARCH_PATHS` (any `/<bucket>/<prefix>`) |
| `STRIPE_BACKEND` | `fake-double` — `lib/stripeFakeDriver.ts` | **no** Stripe credential set (any `STRIPE_SECRET_KEY_*`, `STRIPE_PUBLISHABLE_KEY_*` or `STRIPE_WEBHOOK_SECRET_*` refuses the boot), and a database created for it (below) |
| `AI_BACKEND` | `recorded-double` — `lib/aiDouble/` (fal, OpenAI chat and embeddings, answered from committed recordings) | nothing — no credential |
| `AI_BACKEND` | `recorder` — the real AI clients, capturing recordings under a spending ceiling | the fal and OpenAI keys; run only by `artifacts/api-server/scripts/acceptance-run.ts` in its `--mode record` and `--mode live` (see *Re-recording* and *The acceptance run* below), never in CI |

**The storage double** keeps bytes and metadata in a local directory and
implements exactly the file operations the code uses. Everything above it — the
storage service, the ACL, the access checks — runs unchanged, so it never
serves an object the real access layer would refuse. It does not sign URLs: a
call that needs one fails visibly. Baseline journey 7's acceptance evidence is
the acceptance run's driver (below). Its browser spec (`e2e/photoUpload.spec.ts`,
`pnpm --filter @workspace/overhype-me run e2e:storage`) runs against the
runner's serve mode, which boots the same constructed acceptance server — the
local storage double, the AI double, no credential — on a fresh marked
database with the accounts seeded, and waits:

```sh
cd artifacts/api-server && DATABASE_URL=<a marked test database> pnpm exec tsx scripts/acceptance-run.ts --mode serve --port 8080
cd artifacts/overhype-me && PORT=5173 BASE_PATH=/ pnpm exec vite
E2E_BASE_URL=http://localhost:5173 pnpm --filter @workspace/overhype-me run e2e:storage
```

An upload is scanned by fal's NSFW classifier and by Arachnid before it reaches
storage. `AI_BACKEND=recorded-double` answers the classifier from a recording,
so the journey exercises it rather than skipping it; the journey uploads the
committed fixture photo whose bytes that recording was made from. Arachnid has
no double and no key in the acceptance allowlist, so it skips. The browser
spec runs outside the outbound-request detector (a browser's own traffic is
not the application's) and is not part of the acceptance run's green.

**The Stripe fake** (#566, `docs/plans/PLAN_STRIPE_FAKE.md`) is a credential-free
Stripe for the read path: account verification, managed-webhook registration,
backfill into the `stripe.*` mirror, the catalog and the Billing sync all work
against a fixed catalog (`lib/stripeFakeFixture.ts`, one membership product with
monthly, annual and lifetime prices). It is test-mode only. Payment mutations
(checkout, subscription changes, portal) and webhook processing refuse with
`StripeFakeUnsupportedError` (a typed 501 from payment routes) until the event
channel lands. The real driver is unchanged and stays the default.

It runs only on a database **created** for it. Two database-level settings
partition databases between the drivers (`lib/stripeDatabasePartition.ts`):

| Driver | May use a database carrying |
|---|---|
| fake | the test marker **and** `overhype.stripe_fake_database` |
| real, with credentials | **neither** |

A confirmed mismatch refuses the boot before the port opens; an unreadable
setting leaves payments unavailable until a retry reads it. The fake setting has
one writer, which only creates, and creates **empty** (`TEMPLATE template0`; it
refuses an existing name), so a database with real-Stripe history can never
carry it: nothing is copied from anywhere. The schema, migrations and accounts
come from the same fill every test database gets. To run locally (with
`DATABASE_URL` naming the marked test database, the proof this is a disposable
server):

```sh
pnpm --filter @workspace/db create-stripe-fake-db overhype_stripe_fake   # once; creates it empty and marked
export FAKE_DB=postgres://overhype:overhype@localhost:5432/overhype_stripe_fake
DATABASE_URL=$FAKE_DB pnpm --filter @workspace/db push-force
DATABASE_URL=$FAKE_DB pnpm --filter @workspace/db run migrate
DATABASE_URL=$FAKE_DB pnpm --filter @workspace/api-server exec tsx scripts/seed-dev-admin.ts
DATABASE_URL=$FAKE_DB pnpm --filter @workspace/api-server exec tsx scripts/seed-e2e-test-accounts.ts
cd artifacts/api-server && STRIPE_BACKEND=fake-double DATABASE_URL=$FAKE_DB \
  PORT=8080 NODE_ENV=development ENABLE_DEV_ADMIN_LOGIN=true CRON_SECRET=x \
  ALLOWED_ORIGINS=http://localhost:5173 pnpm exec tsx src/index.ts
```

To start over, drop `overhype_stripe_fake` and run the block again; an
interrupted run leaves at worst an empty database, which the next run's
"already exists" refusal names. Never point an older checkout's server at it. The Billing page shows a persistent "Fake Stripe —
no real account" notice while it is active. CI's dev stack runs on it, and
`e2e/adminBillingSync.spec.ts` (`e2e:billing`) is in the per-PR gate.

Unit tests choose the driver with `__setStripeDriverForTests`, and stub the
partition read with `__setPartitionReaderForTests` — the test databases are
never fake-owned. Suites testing real-driver account behaviour get an "allowed"
answer from `stubAccountRetriever` (`__tests__/helpers/stripeGuardHarness.ts`).

---

## The legacy fixture

Launch Phase 2, increment 5 (#631) commits a scrubbed copy of the dev
database's shapes to `artifacts/api-server/fixtures/legacy/`, so tests can
run the current code against rows older code wrote. Its README states what
was kept and what was replaced. In short:

- The live text of approved facts is kept. Rejected, pending and reported facts
  get placeholder text.
- People, emails, credentials, IP data and Stripe identifiers are synthetic.
  Sessions, auth state, unfinished jobs, child-safety records and live-mode
  payment rows never leave the source.
- Media become local placeholder images, written through the storage double
  at load. Their paths and ACLs follow the writers that produced them.
- Relationships, workflow stages and the freshness outcomes of stored renders,
  concepts and candidates are preserved.

**Loading it.** The loader refuses an unmarked database, a production
environment, and any storage backend but the local double. Load order is
fixed:

```sh
# a fresh marked test database: push-force, then migrate, then
cd artifacts/api-server && STORAGE_BACKEND=local-double STORAGE_DOUBLE_DIR=/tmp/overhype-storage \
  PRIVATE_OBJECT_DIR=/e2e-bucket/private PUBLIC_OBJECT_SEARCH_PATHS=/e2e-bucket/public \
  DATABASE_URL=<that database> pnpm exec tsx scripts/load-legacy-fixture.ts
DATABASE_URL=<that database> pnpm exec tsx scripts/seed-e2e-test-accounts.ts
# then boot with the same storage variables
```

The loader resets every sequence, restores the recorded freshness outcomes,
and re-asks the real readers; it exits non-zero if any answer differs.
`__tests__/legacyFixture.integration.test.ts` proves the scrub on a planted
source (a byte search for every planted value), the refusal, the load, and the
committed fixture booting and serving its media through the real routes. It
needs `CREATE DATABASE`, so it runs in CI's per-database shards and skips,
stating why, under the Repl's schema isolation.

**Refreshing it** runs on the Repl, never in CI, and only after a change to
the scrub rules is reviewed:

1. Classify any new table or column in `src/testing/legacyFixture/allowlist.ts`.
   `legacyFixtureAllowlist.test.ts` fails until every one is classified.
2. Run `scripts/export-legacy-fixture.ts --dry-run` against the dev database.
   Every connection is forced read-only. The rows and the freshness outcomes
   come from one snapshot, so the export can run while the dev database is in
   use. A stop names a path and a shape, never a value. Fix the rule and
   re-run until there are none.
3. Run it again with `--out` set to an empty directory outside the repository.
   Copy the files over and check each one's sha256 against the Repl's own
   listing.
4. Replace `fixtures/legacy/` whole, and update the README's counts from the
   new manifest.

---

## The acceptance run

Baseline journeys 2, 3, 4 and 7 (Phase 2, increment 6; plan
`docs/plans/PLAN_PHASE2_INC6_ACCEPTANCE.md`), on demand, never in the per-PR
gate: the **Acceptance** workflow (`.github/workflows/acceptance.yml`,
dispatched by hand, and run on a pull request that changes the acceptance
tooling) and this command run the same thing. Journeys 5 and 6 ran the legacy
meme studio's user AI generate path and were removed on 2026-10-17
(`docs/ai-context/decisions.md`, *Acceptance journeys 5 and 6 are removed with
the legacy studio*); the studio itself was deleted in launch Phase 4, and the
generate route now serves only the meme page's photo-only stylise
(`docs/ai-context/decisions.md`, *2026-10-22 · The legacy meme studio is
deleted*):

```sh
cd artifacts/api-server && DATABASE_URL=<a marked test database> \
  pnpm exec tsx scripts/acceptance-run.ts --mode acceptance [--variant fresh|fixture|both] [--report-dir <dir>]
```

Each variant gets a fresh marked database (schema push, migrations); the
fixture variant then loads the committed legacy fixture and pins the three AI
prompt rows (`fact_enrichment_system`, `fact_visual_concepts_system`,
`fact_image_prompt_system`) to the code defaults, so one recording set serves
both variants (David, 2026-10-14). The accounts are seeded, the server boots
through `src/testing/acceptanceLauncher.ts` from a constructed environment
that holds no credential, and the driver walks the journeys over HTTP. The run
is **green only when** every journey passed (a journey whose prerequisite
failed is reported `not-run`, never omitted), every image read back decoded,
no AI call went uncovered, every expected operation has a usable recorded
answer, and the outbound-request detector recorded the self-test and nothing
after it.

**The outbound-request detector** (`src/testing/acceptance/`): the whole run
— fixture load, seed, server, its workers, the driver — executes inside a
private network and mount namespace whose only interface is loopback, so no
packet can leave. Inside, NAT sends every DNS query and every non-loopback
connection to a sink that records the name it carried, and `strace` records
every outbound attempt, including one that fails before a packet exists. A
self-test at the start makes four deliberate attempts (a hostname, an IPv4
literal, an IPv6 literal, a UDP datagram) that both observers must record; a
kernel without IPv6 reports that attempt as not observable rather than
claiming it. The database is reached through a unix-socket relay. It needs
`ip` (iproute2), `iptables`, `strace` and `unshare`; it creates the namespace
unprivileged where the kernel allows it and through `sudo` where it does not.
A host that can do neither exits 90, an environment failure, never a run with
less coverage.

**Controls** prove the run can go red for each reason it claims (`--control`;
the exit code says whether the control failed in exactly the expected way):
`forbidden-request` (a caught vendor request after the self-test, named by
both observers), `render-failure` (the recorded vendor error reaches the
render job's failed state), `corrupt-source` (a stored photo replaced by
non-image bytes makes journey 4's composed image fail), and `upload-failure
--variant fixture` (the photo's upload fails, journey 7 completes on the
fail-open classifier, and the evaluator marks the upload and classification
missing).

**The report** (`acceptance-report.json` and `.md`, in `--report-dir`, which
the workflow uploads) names the commit, the recordings' listing hash, the
fixture manifest digest, each journey's outcome and evidence, each expected
operation's evidence, the detector's verdict, the prompt pins, and the
deferrals: the fixture's Pexels-only stock memes, which no acceptance journey
reads.

**The live check** runs the same journeys against the real vendors, on the
Repl only, never in CI: before each launch stage and whenever a vendor client
library is upgraded. Same-run reuse is off, so no recording stands in for a
current answer, and the report must show a usable current answer for every
expected operation, plus, over the fixture, one Pexels-only legacy meme read.
Its cap is $5 per invocation (David, 2026-10-14), separate from the recording
ceiling; more needs `--allowance-raised-by-david <YYYY-MM-DD>`. Like every paid AI run, it starts only on David's go-ahead in words for that run (`decisions.md`, 2026-10-17).

```sh
cd artifacts/api-server && DATABASE_URL=<heliumdb_test> \
  pnpm exec tsx scripts/acceptance-run.ts --mode live --variant both [--allowance <usd>]
```

The contract behind all of this, written for any product in the fleet, is
`docs/engineering/acceptance-workflow.md`.

---

## Production guard (safety-critical)

**A database is a test database only if it says so.** Test databases carry a
stored database-level setting, `overhype.test_database = 'yes'`, written once by
whatever created them: `scripts/setup-test-db.sh` for the sandbox's
`overhype_test`, the CI workflow for the databases its jobs create, and — once,
by hand — Replit's `heliumdb_test`. Production and the dev database are never
marked. The rule and its reasons live in `lib/db/src/testDatabaseMarker.ts`.

Everything destructive or test-only reads the marker and refuses without it:

- `pnpm --filter @workspace/db push-force` checks before it pushes, so the api-server
  `pretest` (which pushes before any runner starts) is covered too;
- both runners, through `assert_not_production` (which also refuses
  `NODE_ENV=production`);
- the E2E account seed and the production-mode launcher.

The marker is read from the catalog (`pg_db_role_setting`), so a connection
string carrying `options=-c overhype.test_database=yes` cannot claim it, and
`drizzle-kit push` leaves database settings alone, so it survives every schema
push. `CREATE DATABASE … TEMPLATE` does not copy it; the runners' per-worker
clones need none, since nothing checks them.

To mark a database you have just created for tests:

```sql
ALTER DATABASE <name> SET overhype.test_database = 'yes';
```

Never run that against a database you did not create for this purpose: the
marker is the whole of the protection.

**Why not database names.** This used to be a list — `heliumdb`, `neondb`,
`production`, anything containing `prod`, a `neon.tech` host marker, and two
extension variables. A name is an address, not an identity, and a blocklist
fails open on every name it has not learned: it once protected dev while
production was renamed past it. David, 2026-10-10: the marker replaced it
outright (`docs/ai-context/decisions.md`).

---

## CI gate + parity contract

`.github/workflows/build.yml` defines these jobs, which run on every PR to
`main`:

- **`Classify changed paths`** — decides whether the heavy suites below can be
  skipped for a docs-only PR. Every failure path falls back to running
  everything; push-to-main skips classification entirely.
- **`Build`** — install, validate migration snapshots, the repo-health guards
  (docs accuracy, codegen drift, manual tuning language, UAT format,
  project-sync label mapping and CI-classifier logic; the review-counting and
  Bash-guard steps went with the machinery they tested in the AI-Handbook
  cutover, and the loop-metrics ledger guard with the loop ledger,
  2026-08-20), and
  `pnpm run build` (typecheck + build). **Never** skipped.
- **`Test`** — the api-server suite against a real Postgres + pgvector service
  container, with `DATABASE_URL` set to `overhype_test`. The suite's own runner
  does all DB setup (per-worker clones); CI just supplies the database. This
  job also runs the **`@workspace/db`** suite, against a *separate*
  `overhype_db_test` database — see the job's "Prepare database" step for why
  that separation is a correctness requirement, not tidiness.
- **`Frontend Test`** — the `@workspace/overhype-me` vitest suite (jsdom; no
  server or DB).
- **`E2E Smoke`** — the Playwright suites against the real dev stack
  (api-server + Vite): route-load smoke (the regression net for the
  crash/reload-loop bug class), admin surfaces, described screens, test
  accounts, Billing sync, the production-mode account journey and the UAT
  capture set. They run as four parallel shards (`E2E Smoke (<shard>)`, the
  `e2e-shard` job), each on its own runner with its own stack and database;
  the `E2E Smoke` job is the one check that stands for all of them (#730).

The last three are gated by the classifier and report success when skipped.

For frontend, package/workspace-script, Vite/build-config, or build-time
environment-variable changes, reproduce the Build gate locally/sandbox-side with
`pnpm run build` when the environment can run it. Package-local typechecks are not
a substitute: the repo-level build also loads production Vite config for every
workspace package.

> Repository settings currently require PRs and require the `Build`, `Test`,
> `Frontend Test` and `E2E Smoke` checks to pass before merging to `main`
> (the last two added by David on 2026-10-21). This is configured in **GitHub
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
app. **A UAT doc has one mandatory shape** —
[`uat-doc-format.md`](uat-doc-format.md) — because `/uat` drives the run by
enumerating its steps, so a doc outside the format is a doc that cannot be
driven. In **feature mode**, Claude Code additionally ships paired `TEST_RUN` +
`UAT` docs per PR by default (see `CLAUDE.md` for when/naming and
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

### The AI double and its recordings

`AI_BACKEND=recorded-double` replaces the three AI clients at the seams the
code already crosses — the fal facade in `lib/falClient.ts` and the OpenAI and
embeddings adapters in `lib/aiClients.ts` — and answers every call from a
committed recording in `lib/aiDouble/recordings/`. A recording is a real
vendor response to the exact request the application sent (model, every
message, the response schema, the output options), captured once on the Repl.
A request with no recording fails with `[ai-double] no recording for …`; it
never reaches a vendor. Generated images come back as small `data:` URLs, so
the real download, probe and storage path runs with no network.
`AI_DOUBLE_FAIL=<kind>:<target>` (for example
`fal.subscribe:fal-ai/nano-banana-2`) makes that operation raise the vendor
error recorded for it.

The recordings cover the baseline the driver walks
(`src/testing/acceptance/driver.ts`: journeys 2, 3, 4 and 7, over a fresh database and
over the legacy fixture). Replaying them proves the doubles carry the real
consumers through:

```sh
cd artifacts/api-server && DATABASE_URL=<a marked test database> \
  pnpm exec tsx scripts/acceptance-run.ts --mode replay [--variant fresh|fixture|both]
# the recorded vendor error, through the real render job:
DATABASE_URL=… pnpm exec tsx scripts/acceptance-run.ts --mode replay --control render-failure
```

Each run creates a fresh test database on that server, seeds the test
accounts, boots the API with a constructed environment and local storage,
drives the baseline, and drops the database. Several AI calls are
best-effort in the product (hashtag suggestions, stock-photo keywords, the
duplicate judge), so a journey can pass over a call the recordings do not
cover; the replay therefore also fails, naming each one, when any baseline
call had no recording or was answered by a recorded vendor error it did not
ask for (only `AI_DOUBLE_FAIL` asks).

**Re-recording** (after a change to a prompt, a schema, the baseline, or a
vendor client upgrade) runs on the Repl, never in CI, under a spending
ceiling the recorder enforces before every vendor call. Like every paid AI run, it starts only on David's go-ahead in words for that run (`decisions.md`, 2026-10-17).:

```sh
cd artifacts/api-server && DATABASE_URL=<heliumdb_test> \
  pnpm exec tsx scripts/acceptance-run.ts --mode record --allowance <usd> --out /tmp/ai-recordings/recordings [--variant fresh|fixture]
```

A full re-record passes `--variant both`, so the fixture's extra request (the
duplicate judge, which only a catalogue with a near neighbour reaches) lands
in the same `--out`. `--out` must be empty, so every request reaches the current clients; the
spending ledger is written beside it and must not be left over from an
earlier run. Review the new recordings, then **replace**
`lib/aiDouble/recordings/` with them rather than adding to it, so no recording
taken against an older client survives the re-recording. The run exits
non-zero if any baseline call got no real answer: refused by the recorder (an
unpriced model, an exhausted allowance), or failed by the vendor or the network
with no response recorded (a retry that later succeeds clears it), or recorded
only as a vendor error. The two failure controls are the one exception. It also
exits non-zero if it could not record each vendor's own validation
rejection (fal's 422, OpenAI's 400) for the failure control. Every model the
baseline calls needs its published price in `OPENAI_PRICES`
(`lib/aiDouble/recorder.ts`), including the default utility model a fresh
database gets from `lib/engines/openai-general.ts`.

**Topping up** — when only some requests are new (a run that stopped
part-way, or one new call) — copies the committed recordings into an
otherwise empty `--out` and adds `--resume`: requests already held are
answered from disk at no cost (the two failure controls included, when
the directory already holds their expected rejections), the run pays only
for the rest and reports how many it reused. Use it only when the vendor clients have not changed
since those recordings were taken; after a client upgrade, record afresh.
