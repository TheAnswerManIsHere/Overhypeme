# Plan — Stripe fake, read path (#566)

```plan-oracle
# Oracle — Stripe fake, read path (#566)

Agreed with David 2026-10-13 ("Go with all your recommendations"), on the scope banner of that date.

## Direction served
Make payment flows testable without touching a real Stripe account, so the membership
work (#628 Phase 10, which launch-definition.md:187 says this fake gates) ships with its
mechanical checks scripted rather than as manual UAT steps.

## Product intent (this increment)
CI and local runs boot the API server against a fake Stripe that needs no credentials.
Against it, the Billing sync, the stripe.* mirror tables, the catalog and the sync-status
strip work, `adminBillingSync.spec.ts` is wired into the suite, and its transient
"Syncing…" label race is fixed. This unblocks the 12 sync-status manual steps (PR276 UAT).

## Settled decisions
1. One plan for the driver seam and the fake. #571 (account guard, merged) owns live-account
   safety; this plan does not re-promise it.
2. The fake is hand-written and type-checked against Stripe's own types, so a new
   production Stripe call fails the build until the fake supports it. Not stripe-mock, not
   recorded fixtures.
3. The fake ships in production code, selectable at boot; payment-path product code at full
   ceremony (sensitive tier).
4. Fake selection is an explicit positive signal; misconfiguration produces a refusal, never
   a silent connection to a real account. Nothing infers safety from a key prefix or a
   connection string (lesson of the deleted assertNotProductionDb.ts, #563).

## Must not change
1. CI gets no Stripe credential, in any form.
2. #571's account-guard behaviour on the real driver: verify before mutation, fatal on
   mismatch or missing expected account id, outage degrades to "payments unavailable".
3. Production and the Repl keep reaching real Stripe exactly as today.
4. The membership derivation model (membershipState) and its tests.

## Now / next / never
- Now: driver seam + fake read path + adminBillingSync.spec wired + its label race fixed.
- Next: the event channel — refunds, chargebacks, cancellations driven through the real
  webhook handler (the 40 PR287 payment-entitlement steps); a parity harness against real
  test-mode Stripe from the Repl.
- Never: a Stripe credential in CI.

## Inherited constraints (from #568's five rounds, recorded on #566)
- Rollout ordering precedes code that requires configuration.
- A refusal inside initStripe()'s catch, or after the port binds, is not a refusal.
- A guard built from a name-matching search is blind to computed access.
- Database ownership needs a symmetric, atomic claim; unclaimed does not mean unowned.
- Mirror reads filter livemode without _account_id, so fake and real rows in one database
  produce a mixed catalog.

## Ceremony
Feature mode, sensitive tier (payments). Plan + Astra loop, Codex code review, payments
specialist review, UAT doc.
```

Status: v4, 2026-10-13 (assess-1: S1–S4; assess-2: S2; assess-3: S5 and two notes, incorporated without a further round). Tier: sensitive (payments).

## Preflight

**Increment test.** This increment makes one thing true: *the API server boots and
runs its Stripe read path — boot verification, managed-webhook registration,
backfill into the `stripe.*` mirror, the catalog API and the Billing sync with its
status strip — with no Stripe credential anywhere in the process.* Bounded by: no
payment mutation, no webhook event processing, no live mode under the fake.
Completion is recognised by a green CI run of `adminBillingSync.spec.ts` on the
dev stack, and by the refusal tests in *Testing Plan*.

**Affected-surface inventory** (run on `main` at `2811bf7`, 2026-10-13; tracked set):

- O1, every Stripe credential name or name helper outside tests —
  `git grep -nE "STRIPE_(SECRET|PUBLISHABLE|WEBHOOK|ACCOUNT)|stripe(Secret|Publishable|Account)VarFor"`
  over `artifacts/ lib/ scripts/`. Hits that **read** a credential:
  `index.ts:57-68` (boot presence log), `stripeClient.ts:43-62` (`getCredentials`,
  webhook secret), `stripeClient.ts:196` (`refuseIfThrottled`, computed),
  `stripeAccountGuard.ts:193` (expected account, computed), `admin.ts:3316-3321`
  (presence booleans for the setup checklist). The remaining hits are the name
  helpers themselves (`stripeRawClient.ts:24-35`), message text, and frontend copy.
- O2, every Stripe or StripeSync construction —
  `git grep -nE "new Stripe\(|new StripeSync|createRawStripeClient\(|stripe-replit-sync"`.
  Hits: `stripeRawClient.ts:38-39` (the one SDK construction, reached by
  `stripeClient.ts`'s factory and `stripeAccountGuard.ts:201`),
  `stripeClient.ts:246-252` (`StripeSync`), `stripeInit.ts:142` (`runMigrations`,
  database-only).
- O3, computed `process.env[...]` reads in `artifacts/api-server/src` — four hits;
  the two Stripe ones are in O1, the other two (`asyncJobs.ts:347`,
  `userImageUpload.ts:27`) read named tuning knobs. This oracle exists because a
  name search is blind to computed access (inherited constraint 3).
- O4, consumers typed against the full SDK —
  `git grep -n 'from "stripe"'` in non-test api-server code: `stripeClient.ts`,
  `entitlementVerification.ts`, `membershipPricing.ts`, `membershipRefresh.ts`,
  `webhookHandlers.ts`, `routes/stripe.ts` (type-only), `stripeRawClient.ts`
  (the construction).

The O1–O4 hit lists are the scope of the seam. Nothing outside them reads a Stripe
credential or builds a Stripe client today.

## Problem

Everything payment-shaped is untestable in CI: there is no way to run the Stripe
path without a real account, and CI may not hold a credential (TESTING.md; the
#563 reversal). The Billing sync flow, the mirror it fills and the status strip
PR #276 made visible exist only as manual UAT steps.

## Direction

Make payment flows testable without touching a real Stripe account, so #628
Phase 10 (membership) ships with its checks scripted. This increment makes the
**read path** runnable credential-free; the event channel (next) builds on the
same driver.

## Product Intent

See the oracle above, verbatim. In one line: CI and local runs boot against a fake
Stripe needing no credentials, and the Billing sync and its status strip are
proven there by `adminBillingSync.spec.ts`.

## Must Not Change

See the oracle. Added from the inventory: the existing test seam
`__setRawClientFactoryForTests` keeps working for the account-guard suites.

**One deliberate addition to the real path** (decision 12): with credentials
present, a database carrying the test marker or the fake-ownership setting is
refused before any Stripe work, on every path into it.
Every other real-driver behaviour, including all of #571's outcomes, is
unchanged.

## Settled Decisions

From the oracle (1–4), plus these taken in drafting, each mine to settle as a
technical choice serving the agreed behaviour:

5. **Selection goes through `doubleSelection.ts`**, as a `STRIPE_BACKEND` row:
   unset or `stripe` means the real driver, `fake-double` the fake. That module
   already refuses an unrecognised value everywhere and any double in a production
   boot (`REPLIT_DEPLOYMENT=1` or `NODE_ENV=production`), before other modules load.
   One selection rule for every double, as Phase 2 decided.
6. **The fake configuration cannot hold a credential.** The selector's `requires`
   refuses to boot when `STRIPE_BACKEND=fake-double` and any `STRIPE_SECRET_KEY_*`,
   `STRIPE_PUBLISHABLE_KEY_*` or `STRIPE_WEBHOOK_SECRET_*` is set. *Construct:* a
   boot refusal. So a key that leaks into a fake run stops the boot rather than
   sitting unused, and "the fake never reads a credential" holds because there is
   none in the process to read.
7. **The seam is a driver chosen once, below the guard.** The driver owns exactly
   the O1 credential reads and the O2 constructions. Everything above it — mode
   capture, the throttle, account verification, invalidation, the boot state
   machine in `stripeInit.ts` — stays one copy and runs under both drivers.
   The real driver is today's code moved, unchanged in behaviour. The env-var
   names stop being exported outside the real driver. *Checked, not prevented:* a
   test asserts the fake driver's import closure excludes the real driver module.
8. **The fake is test-mode only.** It answers live mode as *unconfigured*, so the
   existing toggle refusal applies and nothing new is needed.
9. **Sync keeps `stripe-replit-sync`'s persistence.** Under the fake, `StripeSync`
   is built with a fixed non-credential placeholder key, and its public `stripe`
   field is replaced by the fake before the build is returned. No patch to the
   library. Even if the swap were missed, the placeholder reaches no account
   (decision 6 guarantees no real key exists to fall back to).
10. **The fake implements a bounded contract, `StripeApi`.** It is built over
    Stripe's own types and selects individual methods, nested resources included
    (e.g. `checkout.sessions.create`), never whole SDK resource classes. It holds
    exactly the members called: the O4 consumers' calls, plus those the library
    makes on the read path. **Every application-facing factory exposes only
    bounded types:**
    - the client factories (`getVerifiedStripeClient`,
      `getUncachableStripeClient`) return `StripeApi`;
    - the sync factory (`getStripeSync`) returns a bounded sync interface that
      omits the library's underlying `stripe: Stripe` field, or narrows it to
      `StripeApi`.

    Any adaptation to the library's full `Stripe` field stays inside the driver.
    The O4 consumers are retyped accordingly. *Construct (compiler):* a new
    production call, through either factory, is a type error until it is added to
    `StripeApi`, and adding it is a type error in the fake until implemented. Both
    directions are demonstrated in implementation. Calls inside the compiled library are outside the compiler's
    reach, so the fake also refuses any member it does not implement, at runtime,
    with an error naming the member. *Checked:* an integration test runs the full
    boot sequence (webhook registration, `syncBackfill({object:"all"})`) against
    the fake, so a library upgrade that calls something new *on the exercised paths*
    fails CI. A clean-account boot cannot prove every conditional path inside the
    library, and the plan claims no more than that. The lockfile pins the library
    version.
11. **The fake's behaviour, by kind of call:**
    - catalog reads → a small fixed catalog: one membership-tagged product, with
      prices the pricing page's classification accepts;
    - list reads of resources it does not model → empty, which is true of an
      account with no customers;
    - webhook-endpoint calls → held in memory, so managed-webhook registration
      works. Retrieving an endpoint the fake does not hold answers as Stripe does
      (`statusCode: 404`, `code: "resource_missing"`), which is the response the
      library treats as "recreate". So a restart, which empties the fake's memory
      while `stripe._managed_webhooks` persists, re-registers cleanly instead of
      failing setup;
    - payment mutations (checkout, subscription update and cancel, customer
      create, portal, invoice preview) → an explicit refusal naming the
      event-channel increment. Never a fabricated success.
12. **Databases are partitioned between the drivers, in both directions, by
    settings written when a database is created.** No new table and no schema
    change. There are two database-level settings, read from the catalog exactly
    as `testDatabaseMarker.ts` reads its own:
    - the existing test marker, `overhype.test_database`;
    - a new fake-ownership setting, written **only** by a provisioning step that
      *creates* a database for fake runs. That step refuses an existing database
      name, so the setting can never be applied to a database that already has
      history. CI's dev-stack database is provisioned this way, so the provisioner
      owns creation of its own target: CI's service container already creates
      `overhype_test` (`build.yml:487`), so the fake database is a separate one
      the step creates, never a stamp on `overhype_test`. Locally, a script
      creates a dedicated fake database beside the existing test database and
      never converts it.

    The rules:
    - **Fake → only a database carrying both settings.** "Marked" alone does not
      establish "fresh": `scripts/setup-test-db.sh:72-75` marks pre-existing
      databases on every run. The fake-ownership setting is what establishes
      that the database was created for the fake.
    - **Real driver with credentials → only a database carrying neither
      setting.** It refuses a test-marked database and a fake-owned one.
    - **Real driver without credentials:** unchanged. CI's current unconfigured
      boot on its marked databases still works.

    **The partition is a shared prerequisite, not a boot step.** Its successful
    verification gates every path into Stripe work:
    - account verification;
    - publication of an operational client or sync, whether request-driven
      (`getVerifiedStripeClient`, `getStripeSync`) or from mode-toggle
      verification;
    - remaining initialization;
    - the background verification retry (`runStripeVerificationRetryOnce`).

    None of those can bypass it while it is unresolved. The outcomes:
    - **Confirmed mismatch before listening:** fatal. It is a deterministic
      misconfiguration, the same class as #571's missing account id.
    - **Confirmed for the first time after an indefinite boot:** payments stay
      refused, and no Stripe work proceeds on any path.
    - **Unreadable:** the existing indefinite path. Boot without payments; every
      path above refuses. A retry resolves the partition first, and only an
      allowed result permits recovery.

    A transient database error never takes production down, and never opens a
    path.

    **What this establishes, and what it does not:**
    - Among processes enforcing the rule, ownership is a static property set at
      creation, so concurrent first starts have nothing to compete for.
    - A fresh fake database has no real-Stripe history by construction (the
      creation-only setting).
    - Older processes predate the rule but contain only the real driver. They can
      reach the fake database only if someone points one at the new database by
      hand: CI's database is created per run, and the local one has a new name.
      *Open uncertainty, accepted and named:* that hand-pointing is not
      prevented.
    - Against August's design, the ownership table and its atomic claim are
      gone. Creation-time settings take their place, because a creation event
      cannot race.

    **Production impact:** one catalog read on boot and on the gated paths, using
    the same verdict cache pattern as #571's verification. A confirmed refusal is
    reachable only if the production database carries a test or fake setting,
    which would itself be the misconfiguration to stop on. This is an addition to
    the real path, and it is named under *Must Not Change*.

## Repo Context Inspected

`stripeClient.ts`, `stripeRawClient.ts`, `stripeInit.ts`, `stripeAccountGuard.ts`
(credential and construction paths); `stripeSyncRunner.ts` (`runScopedSync`,
`cleanStaleAccountData`); `stripeStorage.ts:190`; `doubleSelection.ts`;
`lib/db/src/testDatabaseMarker.ts`; `stripe-replit-sync@1.0.0` `dist/index.js`
(constructor at :536-565 builds its own SDK client from `stripeSecretKey`;
`syncBackfill` "all" at :1157-1180 walks 17 resources; the client surface it calls,
counted by `grep -oE "this\.stripe\.[a-zA-Z]+(\.[a-zA-Z]+)?"`);
`.github/workflows/build.yml` (e2e job, dev stack at :589-594, marked
`overhype_test` at :534, browser suites at :616-628 — `adminBillingSync` absent);
`artifacts/overhype-me/e2e/adminBillingSync.spec.ts`;
`docs/tests/UAT/PR276_SYNC_STATUS_VISIBLE_UAT.md` (10 steps, R1–R8);
`launch-definition.md`; #566, #571 and their history.

## Current Behavior

With no credentials, the server boots "without payments": no client, no sync, an
empty mirror. The Billing sync button therefore has nothing to sync in CI, and
`adminBillingSync.spec.ts` assumes a real test-mode account. CI never runs it.

## Source-of-Truth Analysis

- **Stripe mode:** `stripe_live_mode`, unchanged.
- **Catalog:** the `stripe.*` mirror, as today. Under the fake, it is filled by the
  same library from the fake's data, so there is no second catalog path.
- **Driver selection:** `STRIPE_BACKEND` alone, read from the environment and never
  from the database.
- **Fake data:** a fixture in code. It is the fake account's truth, never
  production's.

No new source of truth for membership, tiers or entitlements.

## Proposed Design

Decisions 5–12. Shape: `doubleSelection` resolves `STRIPE_BACKEND` → a driver module
exposing credential resolution, expected account id, raw client construction,
sync construction and credential presence → the existing mode, guard and boot
machinery calls only the driver.

## Data Model and Migration Impact

No schema change. `runMigrations` still creates the mirror tables under both
drivers. The only stored state added is the fake-ownership database setting,
written once, at creation, by the fake-database provisioning step, on databases
that step itself creates. The existing test marker is read, never written, by
application code.

## Runtime Behavior

- **Real driver:** identical to today, including every #571 outcome.
- **Fake driver, fake-owned database, no credentials:** boot verifies the fake test
  account, registers the managed webhook in memory, backfills, and listens.
  The catalog API and Billing show the fixture catalog. The sync button runs the
  real `runScopedSync` against the fake.
- **Fake driver, refusals, each before listening:**
  - production boot;
  - any Stripe credential variable set;
  - a database lacking either setting.
- **Real driver with credentials on a test-marked or fake-owned database:**
  refused before listening and before any Stripe call or write.
- **Unreadable partition:** degrades to "payments unavailable". Requests and
  retries refuse until a retry resolves it.
- **Fake driver, unrecognised `STRIPE_BACKEND` value:** refusal everywhere.
- **Under the fake, at runtime:**
  - payment mutations return a typed refusal and change no state;
  - the webhook route refuses with a typed error, processes nothing and writes
    nothing (event channel is next);
  - the live-mode toggle is refused as unconfigured.

## Admin/User UX Impact

Billing shows a persistent notice while the fake driver is active, e.g. "Fake
Stripe — no real account". An admin on a dev box must not mistake fixture data for
real test mode. It is reported through the existing setup snapshot, never
inferred in the client. The setup checklist's credential rows report the fake
driver rather than "missing". Production is unaffected: the fake cannot boot there.

## Security, Permissions, and Validation

The privilege boundary is the account: no fake configuration can reach a real
Stripe account (decisions 5, 6, 9). Fake and real Stripe data never share a
database, in either direction (decision 12). Each of those is a boot refusal, not a convention. Routes
and admin checks are unchanged. The `_test/simulate` route stays 404 in production.

## Testing Plan

Runners per `docs/tests/TESTING.md`.

**Refusals, each asserting the port is never bound** (the #571 pattern):
- production + `fake-double`;
- `fake-double` + each credential variable family;
- `fake-double` on a database lacking either setting (including a test-marked
  one without fake ownership), with no `stripe.*` writes;
- the real driver with credentials on a test-marked database, and on a fake-owned
  one, with no Stripe call and no writes;
- an unrecognised value.

**Partition recovery**, with the Stripe client and sync constructors
instrumented. Two sequences:
- unreadable at boot → a request before recovery refuses → a retry reads
  *allowed* → recovery proceeds;
- unreadable at boot → a request before recovery refuses → a retry reads
  *disallowed* → payments stay refused.

In both, no account verification, client or sync construction, or Stripe call
happens before permission is established. Covered on every gated path: request
client, sync, mode toggle and the background retry.

**Provisioning:** the fake-database step refuses an existing name.

**Equivalence:** existing real-driver behavioural assertions are preserved.
Scoped test-setup changes may supply an allowed partition result to tests of
downstream account behaviour. Those tests run against schemas inside the marked
test database (`run-test.sh:59`, `scripts/lib/test-db.sh:72`, and the full
runner's schema fallback), where the real-driver partition gate would otherwise
refuse first. The gate itself is never weakened. The partition-refusal integration
tests exercise the actual catalog reader. The affected guard tests are verified
through both targeted execution and the full runner's schema fallback.

**Fake read path, integration:**
- boot → verified test mode;
- managed webhook registered;
- mirror holds the fixture;
- catalog API returns it;
- `runScopedSync` completes;
- an unimplemented member refuses by name;
- each payment-mutation route returns its typed refusal;
- the fake driver's import closure excludes the real driver;
- **reopen:** a second boot against the same database, after the fake's memory is
  gone, completes setup again (the managed webhook is re-registered) and the
  catalog stays usable.

**Compiler, both directions** (decision 10): an unsupported call through each
application-facing factory fails typechecking, and a `StripeApi` member the fake
lacks fails typechecking. Shown once in the PR, not kept as a committed failing
file.

**Browser:** `adminBillingSync.spec.ts` in the CI dev stack with
`STRIPE_BACKEND=fake-double`:
- the success path asserts the request succeeds, the run completes and the
  fixture catalog shows;
- the transient "Syncing…" assertion lives only in the controlled scenario;
- no production delay is added;
- every other browser suite stays green on the same stack.

**PR276 acceptance set.** `PR276_SYNC_STATUS_VISIBLE_UAT.md` as of `2811bf7`
marks five items `Deferred: #566`, all citing `adminBillingSync.spec.ts`:
- step 1, the status panel is always present;
- step 5, the Plans row shows the failure;
- step 6, the failure survives a reload;
- R1, sync animates and re-enables;
- R3, the LIVE/TEST badge is correct.

Those five are what this increment completes. Each is evidenced by a named
assertion in the wired spec, and the UAT doc's `Deferred: #566` lines are
replaced by those checks. Their evidence comes in two kinds, which the PR keeps
separate:
- **R1 and R3 are real-chain evidence:** fake → library → mirror → catalog API →
  Billing.
- **Steps 5 and 6 are presentation evidence**, through the existing simulation
  route. They are described as such, not as vendor-error handling.

The other thirteen items are not this increment's:
- ten are `Deferred: #631` and stay with #631;
- R7 is already covered by `stripeModeToggle.test.ts` test 5c on the real driver,
  and stays credited there;
- steps 7 and 8 already have checks and no deferral.

No item becomes manual in this increment. (The oracle's "12 sync-status steps"
predates the document's re-disposition under #631; the five above are the
document's current assignment to #566.)

## Implementation Steps

1. Driver interface and real driver: a pure move. The existing suites must pass
   unmodified at this step, before the partition gate exists.
2. `StripeApi`, and retyping the O4 consumers.
3. The fake driver, fixture, refusals, selection row and partition prerequisite and fake-database provisioning, with their
   tests.
4. The Billing notice and the checklist's fake rows.
5. CI wiring, the spec fix and the PR276 disposition table.

## Risks and Mitigations

- **The library swap breaks on an upgrade.** Decision 10's integration test plus
  the pinned version.
- **The fake drifts from Stripe's shapes.** It is typed against Stripe's types, and
  the fixture is built from them.
- **A fake on the shared dev stack changes other suites' environment.** All suites
  must stay green on it.
- **Unit-test worker databases are per-worker clones the marker does not reach**
  (`testDatabaseMarker.ts`: "NOT copied by CREATE DATABASE ... TEMPLATE").
  Unit tests therefore inject the fake driver through a test seam rather than boot
  selection. *Open uncertainty:* whether any suite needs boot selection on a clone.
  The implementation settles it, and if one does, marking clones is raised rather
  than bypassing the gate.

## Questions for David

None expected. Scope was agreed on 2026-10-13. Two things are named for visibility
at approval:
- Decision 12 meets the symmetric-ownership constraint with creation-time
  database settings instead of August's ownership table. The one residual is an
  older process pointed at the new fake database by hand, which is not
  prevented.
- The acceptance set is the five PR276 items the UAT doc currently assigns to
  #566, not the "12" in the oracle.

## Definition of Done

- [ ] CI runs `adminBillingSync.spec.ts` green with no Stripe credential, against
      a populated fake catalog.
- [ ] Every refusal in *Runtime Behavior* has a passing test that never binds
      the port.
- [ ] Real-driver behavioural assertions pass, with partition setup scoped to
      tests of downstream account behaviour, under targeted and full runners.
- [ ] Billing visibly shows the fake driver when active.
- [ ] PR276 steps 1, 5, 6, R1 and R3 each cite a passing assertion, and the UAT
      doc's `Deferred: #566` lines are replaced.
- [ ] A reboot against the fake's existing mirror completes setup.
- [ ] Both partition-recovery sequences pass on every gated path.
- [ ] Local fake-database provisioning is documented in `TESTING.md`.
- [ ] Locally, `STRIPE_BACKEND=fake-double` on a freshly provisioned fake database
      shows the fixture catalog on the Billing page and syncs it.
