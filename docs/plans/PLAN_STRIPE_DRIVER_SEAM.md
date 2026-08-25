# Plan: a Stripe driver seam that cannot reach a live account by accident

**Workstream:** [#566](https://github.com/TheAnswerManIsHere/Overhypeme/issues/566)
**Ceremony:** feature mode, full ceremony + payments specialist review.
**Criticality:** 75 — product code in the payment path, and the artifact is a
privilege-and-money boundary that ships to production.

---

## Problem

Nothing payment-shaped can be tested in CI, because there is no way to exercise
Stripe without touching a real Stripe account. Roughly 52 manual test steps are
blocked behind this (40 in PR287 Payments entitlements, 12 in PR276 Sync status),
which is more than every other automation opportunity in the repo combined.

The obvious fix — give CI a test-mode Stripe key — was tried on PR #563 and
reverted, and must not be re-proposed. Two independent reasons, the second of
which is the real design constraint:

1. `docs/tests/TESTING.md` requires external services including Stripe to be
   stubbed or disabled, with no real credentials and no network.
2. **The danger is at boot, not in the tests.** `artifacts/api-server/src/index.ts`
   calls `findOrCreateManagedWebhook()` and `syncBackfill({object: "all"})` during
   `initStripe()`, before any test runs. A server that starts holding a key mutates
   the account that key points at, whether or not a single test touches payments.
   The `stripe_live_mode` flag does not protect against this: it only selects
   *which environment variable is read*, so a secret misbound to a live key means
   Stripe follows the key.

Any seam that sits around test call sites is therefore insufficient. It has to sit
above boot.

## Direction

**There is no direction document for this, and this plan does not create one.**
The end state lives in issue #566: payment behavior provable in CI without a Stripe
account. Stating that explicitly rather than leaving the field blank, per the
template.

What this increment makes true: **the api-server can boot and run against a
hand-written fake Stripe, chosen explicitly from the environment, and in that
configuration no code path can read a Stripe credential.**

## Product Intent

A misconfiguration produces a refusal or an inert fake — never a silent connection
to a live account. A Stripe key that leaks into CI by any route is *unusable*,
because in a fake-driver configuration the code that reads credentials is not
reachable at all.

The second half of the prize — converting the ~52 blocked manual steps into
automated coverage — is deliberately **not** in this plan (see *Scope boundaries*).
This increment ships with one existing suite wired as its proof.

## Must Not Change

1. **Production behavior against real Stripe.** The live path keeps its current
   semantics, including the bounded request timeout and retry count that
   `membershipTiming.ts` derives the entitlement-lease floor from.
2. **Webhook signature verification on the live path.** The fake must not weaken,
   bypass, or share code with live signature verification.
3. **The entitlement derivation rules.** `membershipState.ts` and the tier
   derivation are untouched; this plan changes where Stripe *data* comes from,
   never what the app concludes from it.
4. **The live/test mode toggle** keeps its current meaning and storage.
5. **No database schema change**, and no new source of truth for membership.

## Settled Decisions

1. **A missing driver setting selects the fake, not the real Stripe** (David,
   2026-08-25). Nothing silently connects; the setting must say `live` to connect.
2. **…except in production, where the fake refuses to run** (self-review on Fable,
   accepted by David, 2026-08-25). A fake Stripe running in production would not
   stop checkout — it would hand out Legendary for free and the entitlement
   machinery would faithfully grant it. That failure is quieter and worse than an
   outage, so production must carry the explicit `live` setting or refuse to boot.
   This mirrors `devAdminLogin.ts`, where production wins over the flag.
3. **A hand-written fake**, not `stripe-mock` and not recorded fixtures (David,
   2026-08-25). Only a hand-written fake can be *driven* — a test can cause a
   refund or a chargeback — and only it can populate the mirrored tables the app
   actually reads from. A mock server is faithful in shape but cannot be made to
   emit a chargeback; recordings can only replay scenarios someone already captured
   against a real account.
4. **The test-only control channel is not registered when the driver is live**
   (David, 2026-08-25) — absent, not merely permission-gated.
5. **The control channel asks the driver whether it is fake; it does not run its own
   environment check** (self-review on Fable). One predicate, so two checks cannot
   drift apart — which is the failure class that killed the deleted
   `assertNotProductionDb.ts` guard.
6. **The driver is selected from the environment alone, never from the database.**
   A stored value must never be able to select which Stripe the server talks to.
7. **The parity harness — running the same scenarios against real test-mode Stripe
   — is deferred to the follow-up plan** (David, 2026-08-25), where there will be
   enough scenarios for it to be worth running.

### The affected-surface inventory

The class is *every path that can obtain a Stripe connection or read a Stripe
credential*. Oracles run over the tracked set (`git grep -n`), and the results are
what this plan's scope is drawn from:

| Oracle | Result |
| --- | --- |
| `git grep -n "new Stripe(" -- '*.ts' '*.tsx' '*.mjs' '*.js'` | **one** hit: `stripeClient.ts:76` |
| `git grep -nE "(import\|require).*['\"]stripe['\"]" -- '*.ts' '*.tsx'` | one **value** import (`stripeClient.ts:1`); every other hit is `import type`, erased at compile and unable to construct |
| `git grep -n "stripe-replit-sync" -- '*.ts' '*.mjs' '*.json'` | two construction/entry sites: `stripeClient.ts:107` (`StripeSync`) and `index.ts:77` (`runMigrations`) |
| `git grep -nE "STRIPE_(SECRET\|PUBLISHABLE\|WEBHOOK_SECRET\|ACCOUNT_ID)"` | exactly **one** reader of a secret *value*: `getCredentials()` in `stripeClient.ts`. Every other hit is a presence boolean (`!!`, `index.ts` boot warnings, `admin.ts` config summary, `billing.tsx` labels) or an account id, never a secret value |

Two consequences the plan depends on:

- **The connection class has exactly two members**, both already inside
  `stripeClient.ts`, plus one adjacent DB-only member (`runMigrations`, which takes
  a `databaseUrl` and performs no Stripe network I/O).
- **The credential-read class has exactly one member.** Routing that single
  function behind the live driver therefore captures 100% of secret reads. The
  safe-by-construction claim is a search result, not an assertion.

Because this is a one-time snapshot of a property that must stay true, the plan
adds a CI guard (below) so the inventory is enforced rather than remembered.

## Repo Context Inspected

- `artifacts/api-server/src/lib/stripeClient.ts` — the whole current seam.
- `artifacts/api-server/src/index.ts` — `initStripe()` boot sequence and the
  Stripe env presence warnings.
- `artifacts/api-server/src/lib/bootChecks.ts` — the pre-module-graph assertion
  precedent, and why it must stay import-ordered and DB-free.
- `artifacts/api-server/src/lib/devAdminLogin.ts` + `src/app.ts` — the fail-closed
  predicate and conditional-registration precedent this plan copies.
- `artifacts/api-server/src/lib/webhookHandlers.ts`, `stripeSyncRunner.ts`,
  `stripeStorage.ts`, `membershipState.ts`, `entitlementVerification.ts`.
- `artifacts/api-server/src/routes/admin.ts`, `routes/stripe.ts`.
- `artifacts/overhype-me/e2e/adminBillingSync.spec.ts`,
  `src/pages/admin/syncStatusSummary.ts`.
- `.github/workflows/build.yml` — the `e2e-smoke` job and its dev-stack launch.
- `docs/tests/TESTING.md`, `docs/ai-context/security-model.md`,
  `docs/ai-context/membership-entitlements.md`,
  `docs/ai-context/stripe-payments-audit-brief.md`, `working-modes.md`.

## Current Behavior

`stripeClient.ts` exposes two doors to the outside world — `getUncachableStripeClient()`
(a raw `Stripe` SDK client) and `getStripeSync()` (a `StripeSync` from
`stripe-replit-sync`) — plus credential and mode helpers. `getCredentials()` picks a
key by the `stripe_live_mode` config value and throws when the mode's key is absent.

At boot, `initStripe()` runs the sync library's migrations, builds the sync client,
registers the managed webhook against the site URL, compares the connected account
against `STRIPE_ACCOUNT_ID_*`, and kicks off a full backfill. The whole function is
wrapped in try/catch, so a missing credential is logged as *"Stripe init failed —
continuing without payments."*

**In CI today, that is exactly what happens.** The `e2e-smoke` job sets no Stripe
variables, so payments never initialise. CI is therefore already safe — and blind.
The risk does not exist yet; it arrives the moment someone tries to make CI useful.
This plan's job is to make *useful* and *safe* the same setting rather than opposed
ones.

Most of what the app reads about subscriptions, customers, prices and products comes
from the `stripe.*` mirror tables that `stripe-replit-sync` maintains in Postgres,
not from live API calls. That is what makes a hand-written fake tractable: for the
read path it has to populate tables, not impersonate a REST API.

## Source-of-Truth Analysis

| Concept | Source of truth | Effect of this plan |
| --- | --- | --- |
| Which Stripe the server talks to | **New:** the `STRIPE_DRIVER` environment variable, resolved once at boot | New concept; no existing source to conflict with |
| Which credential the live driver reads | `stripe_live_mode` config row (unchanged) | Unchanged, and now explicitly subordinate — it is only consulted by the live driver |
| Stripe object state (subscriptions, customers, prices, products) | The `stripe.*` mirror tables | Unchanged. The fake writes to the same tables the real sync writes to, so readers cannot tell which driver filled them |
| Membership tier / entitlement | `membershipState.ts` derivation | Unchanged |
| Whether the test control channel exists | The resolved driver (single predicate) | New, deliberately derived rather than independently computed |

**No new source of truth for membership is created.** The fake is a new *producer*
of data into an existing store, exactly where the real sync already writes.

The two switches and their relationship, stated because leaving it implicit is where
a future change gets confused: **the driver decides whether Stripe is real; the
live/test toggle decides which real account.** Under the fake driver the toggle is
inert. The toggle can never select the driver.

## Proposed Design

**One interface, two implementations, selected once at boot.**

1. **`StripeDriver`** — an interface covering both doors: the Stripe API surface the
   app actually uses, and the sync surface (`findOrCreateManagedWebhook`,
   `syncBackfill`, `getAccountId`, `processWebhook`).

2. **The API surface is expressed in Stripe's own SDK types**, narrowed to the
   operations in use, so the real client satisfies it by assignment and the fake is
   type-checked against Stripe's real shapes. This is what makes drift a build
   failure rather than a discovery: a new production call site must widen the
   interface, which obliges the fake to implement it, or the build breaks. Call
   sites keep calling `stripe.subscriptions.retrieve(...)` and do not change.

3. **The live driver is the only code that can read credentials.** `getCredentials()`
   becomes reachable from the live driver's construction path alone; the fake driver
   module does not import it, and the CI guard keeps it that way.

4. **The fake writes to the `stripe.*` mirror tables** so every existing reader —
   the Membership screen, the convergence strip, `syncStatusSummary` — works
   unmodified against it.

5. **Resolution is pure environment reading**, which lets the refusal live in
   `bootChecks.ts` alongside the IP-salt assertion, before the database-backed module
   graph loads. `bootChecks.ts`'s minimal import graph is preserved: driver
   resolution touches `process.env` only.

### Resolution and the refusal

`STRIPE_DRIVER` takes `live` or `fake`. Resolution is total — every input maps to a
defined outcome, and two of them are refusals:

| Environment | `STRIPE_DRIVER` | Outcome |
| --- | --- | --- |
| Production | `live` | Live driver |
| Production | unset or `fake` | **Refuse to boot** (settled decision 2) |
| Non-production | unset or `fake` | Fake driver |
| Non-production | `live` | Live driver |
| Any | unrecognised value | **Refuse to boot** |

Production is identified the same way `devAdminLogin.ts` identifies it, so the two
predicates cannot disagree about what production means.

The invariant worth stating, because nothing else would catch its loss: **there is no
input under which a fake-driver configuration reads a Stripe credential, and no input
under which an absent or unparseable setting yields a live connection.**

### The control channel

Test-only HTTP routes that let a test cause Stripe events — a refund, a dispute
opened and closed, a subscription change. Three invariants:

1. **Registered only when the resolved driver is the fake**, asked of the driver
   itself (settled decision 5). When live, the routes do not exist — a request 404s
   because there is no handler, not because a check denied it.
2. **Events enter through the real webhook handling path.** The control channel
   causes an event; `webhookHandlers.ts` translates it exactly as it would translate
   a delivered webhook. Otherwise the tests would prove the fake works rather than
   proving the app works, forfeiting the reason the channel exists.
3. **It cannot be reached in production even if the driver were somehow fake**,
   because that configuration refuses to boot first.

Why this is not a fraud path, stated so a reviewer does not have to infer it: the
channel exists only where Stripe is fake, and where Stripe is fake there is no money
and no real customer — an entitlement it grants is an entitlement in an ephemeral
test database.

### Keeping the fake honest

Three mechanisms, in increasing cost, plus one honest limit:

1. **The compiler pins the shape** (above) — the fake cannot silently fall behind the
   operations production uses.
2. **The fake speaks Stripe's own types**, with the API version read from one shared
   constant both drivers use, so an SDK upgrade that renames or removes a field
   becomes a compile error inside the fake at upgrade time.
3. **Event payloads are seeded from sanitized captures of real test-mode events**,
   then parameterised — rather than invented, which is where a plausible-but-never-sent
   field would come from.
4. **The limit:** none of this proves *real Stripe* still behaves as captured. That
   is what production reconciliation against authoritative Stripe state and David's
   UAT against real test-mode Stripe are for. CI's job is catching our regressions
   between those reality checks, not replacing them. The parity harness that would
   narrow this gap is deferred (settled decision 7).

### The CI guard

A check that fails the build if the inventory above stops being true: a Stripe
connection constructed outside the live driver, or a Stripe secret value read outside
the credential function. This is the repo's standing response to a recurring failure
pattern — a deterministic check rather than a better memory note — and it is what
converts a one-time search result into a durable property.

## Data Model and Migration Impact

**None.** No schema change, no backfill, no new tables. The `stripe.*` mirror tables
are created by `stripe-replit-sync`'s own migrations, which already run at boot and
are database-only (they take a `databaseUrl` and perform no Stripe network I/O), so
they continue to run under both drivers and the mirror tables exist either way.

## Runtime Behavior

**Production (live driver):** unchanged in every respect — same boot sequence, same
webhook registration, same backfill, same timeouts and retry bounds.

**CI and local development (fake driver):** the server boots fully. Webhook
registration and account lookup are satisfied in-process without network. The
backfill seeds a deterministic baseline into the mirror tables instead of pulling
from Stripe. Payment and membership routes work end to end against that data.

**Misconfigured production:** refuses to boot, with a message naming the variable to
set.

**Edge cases the design must answer:** an unrecognised setting value; the driver
being asked for before boot resolution has run; a live-mode toggle flipped while the
fake driver is active (inert, per the two-switch statement above); and the existing
cache invalidation path (`invalidateStripeSync`) continuing to behave under both
drivers.

## Admin/User UX Impact

No new user-facing surface, and no change to the Membership screen, the convergence
strip, or the admin billing screen — they read the mirror tables and cannot tell
which driver filled them, which is the point.

One admin-visible honesty question: the admin billing screen currently reports Stripe
env-var presence. Under the fake driver those checks describe a configuration that is
not in use. **The screen must say which driver is active** rather than presenting
credential checks as though they governed. This is the smallest change that keeps the
screen truthful; anything larger is next-plan scope.

## Security, Permissions, and Validation

- The refusal is a **boot-time assertion**, evaluated before the database-backed
  module graph, in the module that already exists for exactly this ordering reason.
- **Gate on an explicit positive signal, never on inferring danger from a value** —
  the lesson recorded from the deleted `assertNotProductionDb.ts`, which tried to
  infer safety from a connection string and was bypassed three ways across four
  review rounds. Nothing here inspects a key's prefix or a hostname to guess whether
  it is safe; the environment must *say* `live`.
- **One predicate, consulted everywhere.** Driver resolution, control-channel
  registration, and the admin screen's driver display all read the same resolved
  value — the `devAdminLogin.ts` shape, and the direct answer to the drift failure
  class.
- The control channel is **unregistered**, not merely denied, under the live driver.
- Live webhook signature verification is untouched and shares no code with the fake's
  event path.

## Testing Plan

The general invariant, not the example — with negative cases:

1. **Driver resolution matrix**, modelled on
   `localAuth.devAdminLogin.security.test.ts`: every row of the resolution table
   above, including both refusals and the unrecognised-value case.
2. **Credential unreachability:** under the fake driver, with Stripe secrets present
   in the environment, no Stripe credential is read and no connection is attempted.
   This is the plan's central claim and it gets a direct test rather than resting on
   the guard alone.
3. **The CI guard's own negative test** — a deliberately planted second connection
   site must fail it. A guard that has never been observed failing is not known to
   work.
4. **Webhook translation through the control channel:** a refund revokes entitlement;
   a dispute lost disqualifies permanently; the derivation continues to hold that a
   cancelled subscription plus a lifetime purchase stays Legendary. These exercise
   the plumbing that #562's analysis identified as having no coverage, through the
   real handler path.
5. **`adminBillingSync.spec.ts` wired into the `e2e-smoke` job** with the fake driver
   selected — the existing, already-complete suite that proves the fake is usable.
   *Its known transient-label race is explicitly next-plan scope (issue #566); if it
   proves flaky when wired, it is quarantined by not wiring it, never by weakening
   the assertion.*
6. **Production-refusal test:** a production-identified environment without the
   explicit live setting fails to boot.

Runners per `docs/tests/TESTING.md`: `pnpm --filter @workspace/api-server test` for
the suites above, and the `e2e-smoke` job's Playwright steps for the wired spec.

## Implementation Steps

1. Define the driver interface in Stripe's own types, narrowed to the operations the
   inventory found in use.
2. Extract the current behavior into the live driver, moving `getCredentials()` behind
   it. No behavior change; this step should be provably inert for production.
3. Add driver resolution and the boot refusal to `bootChecks.ts`, with the resolution
   matrix test.
4. Build the fake driver: sync surface, API surface, mirror-table seeding.
5. Add the control channel, registered off the driver predicate, routing events through
   `webhookHandlers.ts`.
6. Add the CI guard and its negative test.
7. Make the admin billing screen state the active driver.
8. Set the fake driver in the `e2e-smoke` job and wire `adminBillingSync.spec.ts`.

Steps 1–3 are separable from 4–8 and land production-inert; if the plan is to be
split for review, that is the seam.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **The fake drifts from production Stripe** | The compiler pins the shape; the fake speaks Stripe's own types against one pinned API version; payloads seeded from real captures. The residual gap is named honestly above and covered by reconciliation and UAT, with parity deferred |
| **The fake reaches production** | Production refuses to boot without an explicit `live` setting (settled decision 2) — the amendment that exists precisely because this risk's real cost is free memberships, not an outage |
| **A future call site opens a second door** | The CI guard, with a negative test proving it fails |
| **The control channel becomes reachable somewhere it shouldn't be** | Unregistered rather than denied; derived from one predicate; and unreachable in production because that configuration refuses to boot |
| **Tests pass against the fake while the app is broken against real Stripe** | Events flow through the real webhook handler path, so the translation logic under test is production's. What remains is the named limit above |
| **Extracting the live driver silently changes production behavior** | Step 2 is deliberately inert and reviewed as such; timeouts and retry bounds are called out in *Must Not Change* because `membershipTiming.ts` derives the entitlement-lease floor from them |
