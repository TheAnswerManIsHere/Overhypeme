# Plan: a Stripe driver seam that cannot reach a live account by accident

**Workstream:** [#566](https://github.com/TheAnswerManIsHere/Overhypeme/issues/566)
**Ceremony:** feature mode, full ceremony + payments specialist review.
**Criticality:** 75 — product code in the payment path, shipped to production.

> **Revision 2, after round 1 returned ten findings and the loop stopped on a
> pre-registered flip condition.** Round 1 established that revision 1's inventory was
> incomplete in two classes and that its design was blind to two pieces of existing
> machinery. The increment was re-cut with David rather than patched. What changed:
> the fake is **CI-only**; the driver setting is **three-state**, with no implicit
> default in either direction; the **control channel and all event injection are
> deferred** to the follow-up plan; and the fake implements the **complete** sync
> contract the admin routes require, not the four methods revision 1 counted.

---

## Problem

Nothing payment-shaped can be tested in CI, because there is no way to exercise Stripe
without touching a real Stripe account. Roughly 52 manual test steps are blocked behind
this — more than every other automation opportunity in the repo combined.

Giving CI a test-mode key was tried on PR #563 and reverted, and is not re-proposed.
`docs/tests/TESTING.md` forbids real credentials outright, but the binding constraint is
sharper: `index.ts`'s `initStripe()` calls `findOrCreateManagedWebhook()` and
`syncBackfill({object: "all"})` **at boot**, before any test runs. A server that starts
holding a key mutates that account whether or not a test touches payments, and the
`stripe_live_mode` flag does not help — it selects which environment variable is read, so
a secret misbound to a live key means Stripe follows the key.

Any seam around test call sites is therefore insufficient. It has to sit above boot.

## Direction

**No direction document exists for this work, and this plan does not create one.** The
end state lives in issue #566: payment behavior provable in CI without a Stripe account.

What this increment makes true: **CI can boot the real server against a hand-written fake
Stripe, and no configuration of any environment can reach a live Stripe account without
explicitly saying so.**

## Product Intent

A misconfiguration produces a refusal or an inert server — never a silent connection to a
live account, and never fake payment data written into a real database. A Stripe key that
leaks into CI is unusable, because in a fake configuration the code that reads credentials
is unreachable.

This increment ships **no new event-injection surface at all** (settled decision 4). It
proves itself by wiring one existing, already-complete suite.

## Must Not Change

1. **Production behavior against real Stripe**, including the bounded request timeout and
   retry count that `membershipTiming.ts` derives the entitlement-lease floor from.
2. **Webhook signature verification on the live path** — not weakened, bypassed, or
   shared with the fake.
3. **The entitlement derivation rules** in `membershipState.ts`. This increment changes
   where Stripe data comes from, never what the app concludes from it.
4. **The live/test mode toggle's** meaning and storage.
5. **The Repl's behavior.** It keeps using real test-mode Stripe exactly as today; the
   only change is that it must now say so explicitly.
6. **The existing `POST /admin/stripe/test-event` route and its Billing-page trigger**
   stay exactly as they are this round (settled decision 6).
7. No database schema change, and no new source of truth for membership.

## Settled Decisions

1. **The fake is CI-only** (David, 2026-08-25, re-cut). Revision 1 made fake the
   non-production default, which would have booted the Repl on a fake Stripe against
   `heliumdb` — the real dev database — mixing fabricated rows with the real test-account
   mirror. CI's database is genuinely ephemeral; the Repl's is not. Confining the fake to
   the environment we provision removes that hazard by construction rather than managing it.
2. **The driver setting is three-state, with no implicit default in either direction**
   (David, 2026-08-25, revising the earlier default-to-fake decision):

   | `STRIPE_DRIVER` | Outcome |
   | --- | --- |
   | unset | **Stripe does not initialise at all** — payments are off, as CI behaves today |
   | `fake` | Fake driver |
   | `live` | Live driver |
   | anything else | **Refuse to boot** |

   Plus: **production refuses to boot unless the value is explicitly `live`.** Both
   drivers now require an explicit positive signal, which is truer to the fail-closed
   lesson than a default in either direction. Default-to-fake bought zero-config CI, and
   under decision 1 that benefit is gone — we write CI's environment ourselves.
3. **A hand-written fake**, not `stripe-mock` and not recorded fixtures (David) — only a
   hand-written fake can populate the mirrored tables the read path uses, and only it can
   later be driven to produce events the follow-up plan needs.
4. **No control channel and no event ingress in this increment** (David, 2026-08-25,
   re-cut). The whole event-injection surface moves to the follow-up plan, where the
   blocked payment steps actually need it. Under the fake driver there is therefore **no
   way for an event to enter the system at all**: the public webhook route is not
   registered, and no control routes exist. This deletes revision 1's forged-webhook risk,
   its refund-semantics exposure, and its scope creep rather than mitigating them.
5. **The driver is selected from the environment alone, never from the database.**
6. **The existing `/admin/stripe/test-event` route is left untouched this round** (David,
   2026-08-25). It is `requireAdmin`-gated and is a tool David uses from the Billing page
   on the Repl; retiring it here would silently remove that. Migrating it behind the
   driver predicate belongs with the follow-up plan that builds the real control channel.
7. **The parity harness is deferred** to the follow-up plan (David).

### The affected-surface inventory (re-run for revision 2)

Revision 1's inventory was wrong, and the correction is the reason this document exists.
Its error was not a missed search — it was **mis-classifying its own search output**:
`getStripeWebhookSecret()` appeared in the results and was counted as harmless because the
class had been framed as "secret keys" rather than "credential values."

The class is restated to remove that judgment step: *every site that reads the **value** of
a `STRIPE_*` environment variable, and every site that constructs a Stripe connection.*

| Oracle (tracked set) | Result |
| --- | --- |
| `git grep -n "process\.env\.STRIPE" -- '*.ts' '*.tsx' ':!*__tests__*'` | 18 hits. **Four** read a value; the other fourteen are `!!` presence booleans (`index.ts` boot warnings, `admin.ts` config summary) that never expose the value |
| — of those, credential values | **three sites, all in `stripeClient.ts`**: webhook signing secret (`:35-36`), secret key (`:47-48`), publishable key (`:50-51`) |
| — of those, non-credential values | **one site**: `index.ts:107-108` reads `STRIPE_ACCOUNT_ID_{LIVE,TEST}`, an account identifier rather than a secret |
| `git grep -n "new Stripe(" -- '*.ts' '*.tsx' '*.mjs' '*.js'` | one hit, `stripeClient.ts:76` |
| `git grep -nE "(import\|require).*['\"]stripe['\"]"` | one **value** import (`stripeClient.ts:1`); all others `import type`, erased at compile |
| `git grep -n "stripe-replit-sync"` | two entry sites: `stripeClient.ts:107` (`StripeSync`), `index.ts:77` (`runMigrations`, database-only) |
| `git grep -n "SyncRunnerDriver"` | `stripeSyncRunner.ts:187` — a **nine-member** interface the admin sync routes pass `getStripeSync()` into |

**The sync surface is twelve members, not four.** Revision 1 counted call sites of the form
`sync.method(...)` and so saw only `getAccountId`, `processWebhook`, `syncBackfill` and
`findOrCreateManagedWebhook`. It missed that `/admin/stripe/sync` and `/admin/stripe/full-sync`
pass the sync object into `runScopedSync`/`runFullSync`, which require `SyncRunnerDriver`:
`getAccountId` plus `syncProducts`, `syncPrices`, `syncPlans`, `syncCustomers`,
`syncSubscriptions`, `syncInvoices`, `syncCharges`, `syncPaymentMethods`.

This matters beyond completeness: `adminBillingSync.spec.ts` — the suite this increment
nominates as its own proof — drives the Billing page's *Sync Stripe data* control, so a fake
missing those methods could not have run the one test that was supposed to demonstrate it.

**The general lesson, recorded because it is the actual defect:** an inventory whose class
definition requires a judgment call at classification time is not mechanical. The oracle must
partition its own output. Both corrections above come from restating the class so that
reading the results cannot go wrong.

## Repo Context Inspected

`stripeClient.ts` (the whole seam), `index.ts` (`initStripe`, boot warnings, account check),
`bootChecks.ts` (the pre-module-graph assertion precedent), `devAdminLogin.ts` + `app.ts`
(fail-closed predicate, conditional registration, and the webhook route's raw-body and
rate-limit exemptions), `stripeSyncRunner.ts` (`SyncRunnerDriver`), `stripeStorage.ts`
(`listProductsWithPrices` and the mirror reads), `webhookHandlers.ts`, `membershipState.ts`,
`routes/admin.ts` (sync, config-summary and test-event routes), `routes/stripe.ts`,
`e2e/adminBillingSync.spec.ts`, `.github/workflows/build.yml` (`e2e-smoke`), and
`docs/tests/TESTING.md`, `docs/ai-context/replit-environment.md`,
`docs/ai-context/membership-entitlements.md`, `docs/ai-context/security-model.md`.

## Current Behavior

`stripeClient.ts` exposes two doors — `getUncachableStripeClient()` (raw SDK) and
`getStripeSync()` (`StripeSync`) — plus the credential and mode helpers. At boot,
`initStripe()` runs the sync library's migrations, builds the sync client, registers the
managed webhook, compares the connected account against `STRIPE_ACCOUNT_ID_*`, and starts a
full backfill — all inside one try/catch that logs *"Stripe init failed — continuing without
payments."*

**In CI today that is exactly what happens:** `e2e-smoke` sets no Stripe variables, so
payments never initialise. CI is already safe, and blind. The risk arrives the moment someone
makes it useful. This plan's job is to make *useful* and *safe* the same setting.

Most subscription, customer, price and product reads come from the `stripe.*` mirror tables
that `stripe-replit-sync` maintains in Postgres, not from live API calls — which is what makes
a hand-written fake tractable: for the read path it populates tables rather than impersonating
a REST API.

## Source-of-Truth Analysis

| Concept | Source of truth | Effect |
| --- | --- | --- |
| Which Stripe the server talks to | **New:** `STRIPE_DRIVER`, resolved once at boot from the environment | New concept; nothing existing to conflict with |
| Which credential the live driver reads | `stripe_live_mode` config row | Unchanged, and now explicitly subordinate — consulted only by the live driver |
| Stripe object state | The `stripe.*` mirror tables | Unchanged. The fake writes where the real sync writes, so readers cannot tell them apart |
| Membership tier / entitlement | `membershipState.ts` derivation | Unchanged |

**No new source of truth for membership.** The fake is a new producer into an existing store.

**The two switches, stated because leaving it implicit is where a later change goes wrong:**
the driver decides whether Stripe is real; the live/test toggle decides *which real account*.
Under the fake the toggle is inert. The toggle can never select the driver, and no database
value can.

## Proposed Design

**One interface, two implementations, resolved once at boot from the environment.**

1. **`StripeDriver`** covers both doors: the Stripe API surface the app uses, and the full
   twelve-member sync surface — `SyncRunnerDriver`'s nine members plus
   `findOrCreateManagedWebhook`, `syncBackfill` and `processWebhook`. The sync half
   **reuses the existing `SyncRunnerDriver` contract** rather than declaring a second,
   narrower one; a fake that satisfies `StripeDriver` is by construction usable by
   `runScopedSync` and `runFullSync`.

2. **The API surface is expressed in Stripe's own SDK types**, narrowed to the operations in
   use, so the real client satisfies it by assignment and the fake is type-checked against
   Stripe's real shapes. Call sites do not change. This is what makes drift a build failure:
   a new production call must widen the interface, which obliges the fake to implement it.

3. **All three credential reads move behind the live driver** — secret, publishable, and
   webhook signing secret. The fake driver module imports none of them.

4. **The fake writes to the `stripe.*` mirror tables**, so the Membership screen, the
   convergence strip and `syncStatusSummary` work unmodified against it.

5. **Resolution is pure environment reading**, so the refusal lives in `bootChecks.ts`
   beside the IP-salt assertion, before the database-backed module graph loads.
   `bootChecks.ts`'s minimal import graph is preserved: this touches `process.env` only.

6. **Under the fake driver there is no event ingress.** The `/api/stripe/webhook` route is
   not registered — along with its raw-body parser and rate-limit exemption, which are keyed
   to the same path — and this increment adds no control routes. An event cannot enter the
   system by any path.

7. **Operations the fake does not implement fail loudly.** Where the increment does not
   exercise an API operation, the fake raises a clearly-labelled error rather than returning
   plausible data, so a CI run can never pass against behavior that was never built.

### Fail-closed resolution

The table in settled decision 2 is **total** — every input maps to a defined outcome, and two
are refusals. Production is identified exactly as `devAdminLogin.ts` identifies it, so the two
predicates cannot disagree about what production means.

The invariants worth stating, because nothing else would catch their loss:

- **No input causes a fake-driver configuration to read a Stripe credential.**
- **No absent or unparseable setting yields a live connection** — absence yields no Stripe
  at all, and an unrecognised value yields a refusal.
- **No fake-driver configuration accepts an inbound Stripe event.**

Nothing infers safety from inspecting a key prefix, a hostname, or a connection string — the
lesson recorded from the deleted `assertNotProductionDb.ts`, which was bypassed three ways
across four review rounds. The environment must *say* which driver it wants.

### Why the persistent-database risk is gone rather than managed

Revision 1 argued the control channel was harmless because a granted entitlement lands in an
ephemeral test database. That is true of CI and false of the Repl, which uses `heliumdb`. Under
decision 1 the fake exists only where the database really is ephemeral, and under decision 4
this increment grants no entitlements at all. Round 1's finding about `listProductsWithPrices`
filtering `livemode` without `_account_id` is therefore **not reachable by this increment** —
it needs fake rows and real rows in one database, which no supported configuration now
produces. It is recorded here as a **standing constraint on the follow-up plan**, which will
reintroduce the possibility the moment it lets the fake run anywhere persistent.

### The CI guard

A check failing the build if the inventory stops being true: a Stripe connection constructed
outside the live driver, or **any** `STRIPE_*` credential value read outside it. The guard
covers all three credential classes, not just the secret key — the specific gap round 1 found.
This is the repo's standing response to a recurring failure pattern: a deterministic check
rather than a better memory note.

### Keeping the fake honest

1. **The compiler pins the shape** — the fake cannot fall behind the operations production
   uses, and reusing `SyncRunnerDriver` means the admin sync paths are covered by the same
   guarantee.
2. **The fake speaks Stripe's own types**, with the API version read from the single constant
   both drivers use, so an SDK upgrade that renames or removes a field is a compile error
   inside the fake at upgrade time.
3. **The limit, stated rather than papered over:** none of this proves *real Stripe* still
   behaves as captured. Production reconciliation against authoritative Stripe state and the
   live-driver verification below cover that; the parity harness that would narrow it further
   is deferred.

## Data Model and Migration Impact

**None.** No schema change, no backfill, no new tables. The `stripe.*` mirror tables are
created by `stripe-replit-sync`'s own migrations, which are database-only and continue to run
under both drivers.

## Runtime Behavior

**Production (live driver):** unchanged in every respect — same boot sequence, webhook
registration, backfill, timeouts and retry bounds.

**The Repl (live driver, real test-mode Stripe):** unchanged behavior; the environment must now
carry `STRIPE_DRIVER=live`.

**CI (fake driver):** the server boots fully. Webhook registration and account lookup are
satisfied in-process without network; the backfill seeds a deterministic baseline into the
mirror tables. The admin sync screens and sync-status surfaces work end to end. No inbound
event path exists.

**Any environment with the setting absent:** Stripe does not initialise; payments are off and
the rest of the app runs — today's CI behavior, now reached deliberately rather than by a
credential lookup failing inside a try/catch.

**Misconfigured production, or any unrecognised value:** refuses to boot, naming the variable.

## Admin/User UX Impact

No change to the Membership screen, the convergence strip, or the admin billing screen's
existing controls — they read the mirror tables and cannot tell which driver filled them.

The admin billing screen currently reports Stripe env-var presence; under a fake or absent
driver those checks describe a configuration that is not in use, so **the screen must state
which driver is active**. Smallest change that keeps it truthful.

## Security, Permissions, and Validation

- The refusal is a **boot-time assertion** evaluated before the database-backed module graph,
  in the module that exists for exactly that ordering reason.
- **Gate on an explicit positive signal, never on inferring danger from a value.**
- **One predicate, consulted everywhere** — resolution, webhook-route registration, and the
  admin screen's driver display all read the same resolved value. This is the
  `devAdminLogin.ts` shape and the direct answer to the drift failure class.
- **No new privileged surface ships in this increment** (settled decision 4), so the
  entitlement-granting risk revision 1 carried does not exist here. The follow-up plan
  inherits, as named constraints: admin authorization on every control route, an
  authenticity mechanism for any fake event path, and the account-isolation question above.
- Live webhook signature verification is untouched and shares no code with the fake.

## Testing Plan

The general invariant, not the example, with negative cases:

1. **Driver resolution matrix**, modelled on `localAuth.devAdminLogin.security.test.ts`:
   every row of the table in settled decision 2, both refusals, the unset case, and the
   production-without-`live` refusal.
2. **Credential unreachability:** under the fake driver, with all six Stripe secrets present
   in the environment, no credential value is read and no connection is attempted. This is the
   plan's central claim and gets a direct test rather than resting on the guard.
3. **No event ingress under the fake:** a request to `/api/stripe/webhook` reaches no handler
   when the fake driver is active.
4. **The CI guard's own negative test** — a deliberately planted second connection site, and a
   planted read of each of the three credential classes, must each fail it. A guard never
   observed failing is not known to work.
5. **The fake satisfies `SyncRunnerDriver`** — a type-level and behavioral check that scoped
   and full sync both run against it, which is what item 6 depends on.
6. **`adminBillingSync.spec.ts` wired into `e2e-smoke`** with `STRIPE_DRIVER=fake` — the
   existing, already-complete suite, and this increment's proof. Its known transient-label
   race is next-plan scope; if it proves flaky when wired it is left unwired, **never**
   weakened or skipped to get green.
7. **Live-driver verification, outside CI:** a bounded post-merge check on the Repl with
   `STRIPE_DRIVER=live` against real test-mode Stripe, confirming boot, correct account
   selection, managed-webhook signature handling, and backfill. This is what protects the
   *Must Not Change* production invariants through the extraction, and it is distinct from
   the deferred parity harness. It runs through the Replit connector at close-out, read-only,
   and is recorded in the PR's Post-merge verification section.

Runners: `pnpm --filter @workspace/api-server test`; the `e2e-smoke` Playwright steps.

## Implementation Steps

**Rollout ordering is load-bearing, and steps 1–2 must land before the refusal ships.**
Revision 1 would have made the first production boot fatal on a variable nothing set.

1. **Set `STRIPE_DRIVER=live` in production's environment** and confirm it is present.
2. **Set `STRIPE_DRIVER=live` on the Repl** and confirm it is present.
3. Define `StripeDriver`, reusing `SyncRunnerDriver` for the sync half.
4. Extract current behavior into the live driver, moving all three credential reads behind
   it. Provably inert for production.
5. Add driver resolution and the boot refusal to `bootChecks.ts`, with the resolution matrix
   test.
6. Build the fake: the full sync surface, the API surface, mirror-table seeding, loud failure
   for unimplemented operations.
7. Make webhook-route registration conditional on the resolved driver.
8. Add the CI guard and its negative tests.
9. Make the admin billing screen state the active driver.
10. Set `STRIPE_DRIVER=fake` in the `e2e-smoke` job and wire `adminBillingSync.spec.ts`.

Steps 3–5 are separable and land production-inert; that is the seam if this is split.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Deploying the refusal before the variable is set takes production down** | Steps 1–2 precede every code step; the PR's verification section confirms both environments carry the value before merge |
| **The fake drifts from production Stripe** | The compiler pins the shape; reusing `SyncRunnerDriver` extends that to the admin sync paths; the fake speaks Stripe's own types against one pinned API version. The residual gap is named and covered by reconciliation plus the live-driver verification |
| **The fake reaches production, or a real database** | Production refuses without an explicit `live`; the fake is CI-only by decision; and no default selects it anywhere |
| **A future call site opens a second door, or reads a credential outside the driver** | The CI guard, covering all three credential classes, with negative tests proving it fails |
| **Extraction silently changes production behavior** | Step 4 is deliberately inert and reviewed as such; timeouts and retry bounds are named in *Must Not Change* because `membershipTiming.ts` derives the lease floor from them; testing-plan item 7 verifies the live path against real test-mode Stripe |
| **The follow-up plan reintroduces what this one removed** | The account-isolation constraint, control-route authorization, and event authenticity are recorded above as named inheritances rather than left to be rediscovered |
