# Plan: a Stripe driver seam that cannot reach a live account by accident

**Workstream:** [#566](https://github.com/TheAnswerManIsHere/Overhypeme/issues/566)
**Ceremony:** feature mode, full ceremony + payments specialist review.
**Criticality:** 75 — product code in the payment path, shipped to production.

> **Revision 4, after round 3 returned three findings.** From round 3 the write-gate
> rule applies: the findings went to the external adjudicator **before** anything was
> written for them, and its verdict was *continue* with no budget extension. All three
> are upheld. The largest is that revision 3's disposability construct proved the wrong
> property — an **empty** database is not a **disposable** one, and the check contradicted
> itself across restarts. Ownership replaces emptiness. Two further corrections: the
> refusal is placed where it can actually stop the process, and the live-API door gets a
> real end-to-end check, reversing a decline I made in round 1 on evidence I did not have.
>
> **Revision 3, after round 2 returned three findings and the loop stopped a second
> time — on the flip condition reserved for a third incomplete class.** David's answer
> was to change the rule rather than patch the instance: `working-modes.md` now carries
> [the claim-oracle rule](../ai-context/working-modes.md#a-completeness-claim-carries-its-oracle-or-it-is-not-a-claim-david-2026-08-25)
> — *a plan may assert that a set is complete, a behavior inert, or a state unreachable
> only when a mechanical oracle enumerates the class or a construct in the design
> enforces it.* Every such claim in this document has been audited against that rule;
> the audit is its own section below, and it found a fourth defect the reviewer had not
> yet reached. Round 2's three findings are fixed.
>
> **Revision 2, after round 1 returned ten findings and the loop stopped on a
> pre-registered flip condition.** Round 1 established that revision 1's inventory was
> incomplete in two classes and that its design was blind to two pieces of existing
> machinery. The increment was re-cut with David rather than patched. What changed:
> the fake was declared **CI-only** (as policy — revision 3 makes it a construct); the
> driver setting is **three-state**, with no implicit
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

1. **The fake runs only against a disposable database, and that is enforced rather than
   stated** (David, 2026-08-25, re-cut; enforcement added in revision 3). Revision 1 made
   fake the non-production default, which would have booted the Repl on a fake Stripe
   against `heliumdb` — the real dev database — mixing fabricated rows with the real
   test-account mirror.

   Revision 2 said "the fake is CI-only" and round 2 correctly found that nothing enforced
   it: the resolution table accepted `fake` in any non-production environment, so setting it
   on the Repl remained valid and would have produced exactly the contamination the re-cut
   claimed was unreachable. **Two conditions now gate the fake, and both are checked at
   boot:**

   **Revision 3 answered this with an emptiness check, and round 3 showed that proves the
   wrong property.** An empty database is not a disposable one: a newly provisioned or
   freshly reset persistent database passes, the fake seeds rows into it, and on the next
   restart those same rows make it *fail* — so the mechanism established neither
   disposability nor a repeatable boot. Emptiness is a property of a moment; ownership is a
   property of the database.

   **The construct is mutual, exclusive, and recorded rather than inferred:**

   - **The database records which driver owns it.** On first fake boot — with the explicit
     declaration present and the `stripe.*` mirror empty — the fake marks the database as
     fake-owned. The mark is data in the database, not a guess about its name, host, or
     connection string.
   - **The fake accepts only an empty database or one already marked fake-owned.** That is
     what makes a second boot work: seeded rows plus the mark are the expected state, not a
     violation. CI is idempotent across restarts.
   - **The live driver refuses a fake-owned database outright.** This is the half revision 3
     lacked entirely, and it is what actually protects real data: a database that has ever
     held fabricated rows can never afterwards be used against real Stripe.
   - **An explicit declaration is still required** for that first capture — a positive
     statement the environment makes, never something the code infers.

   The property this enforces is the one the decision was always about, and it is now stated
   as what the construct actually guarantees: **fake rows and real rows can never occupy the
   same database, in either order.** Nothing here inspects a value to guess whether a
   database is safe, which remains the failure recorded from the deleted
   `assertNotProductionDb.ts`.
2. **The driver setting is three-state, with no implicit default in either direction**
   (David, 2026-08-25, revising the earlier default-to-fake decision):

   | `STRIPE_DRIVER` | Outcome |
   | --- | --- |
   | unset | **Stripe does not initialise at all** — payments are off, as CI behaves today |
   | `fake` | Fake driver, **only if the disposable-database conditions below are both met**; otherwise **refuse to boot** |
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

### The claim audit (revision 3, under the claim-oracle rule)

Every load-bearing claim in this document, with what enforces it. The rule
([`working-modes.md`](../ai-context/working-modes.md#a-completeness-claim-carries-its-oracle-or-it-is-not-a-claim-david-2026-08-25))
is that a completeness, inertness, or unreachability claim must point at an oracle **run, with
its output recorded and mapped to the claim**, or at a construct **in the shipped system** —
never at another sentence in the plan, and never at a table row, which is prose in a grid.
Rows below therefore carry their oracle's actual result, not just its command.

| Claim | What enforces it | Status |
| --- | --- | --- |
| Three sites read a Stripe credential value | `git grep -n "process\.env\.STRIPE" -- '*.ts' '*.tsx' ':!*__tests__*'` → **18 hits: 4 value-reads, 14 `!!` presence checks.** Of the 4: `stripeClient.ts:35-36`, `:47-48`, `:50-51` are credentials; `index.ts:107-108` is an account id. The partition is syntactic (`!!` or not), so it needs no interpretation | Oracle, run and mapped |
| One site constructs a Stripe connection | `git grep -n "new Stripe("` → **1 hit, `stripeClient.ts:76`** | Oracle, run and mapped |
| The sync contract has twelve members | `git grep -n "SyncRunnerDriver"` → `stripeSyncRunner.ts:187`, **9 members**; plus 3 direct call sites = 12. `git grep -nE "interface [A-Z][A-Za-z]*Driver"` → **1 hit, the same interface**, so no second structurally-typed contract exists | Oracle, run and mapped — the second oracle is the one revision 2 lacked |
| No credential is readable under the fake | The fake driver module does not import the credential functions, and the CI guard fails the build on any credential read outside the live driver | Construct + guard |
| Fake rows and real rows can never occupy the same database, in either order | Recorded ownership: the fake accepts only an empty or fake-marked database and marks it on first boot; **the live driver refuses a fake-marked database** (settled decision 1). Checked in an awaited boot phase that terminates the process on failure | Construct — revision 3's emptiness check proved the wrong property and is replaced |
| The mode toggle cannot change under the fake | Writes to `stripe_live_mode` are refused while the fake driver is active | Construct — was a false "inert" claim in revision 2 |
| No external party can deliver an event under the fake | `/api/stripe/webhook` and its raw-body parser and rate-limit exemption are not registered | Construct |
| ~~No event can enter the system by any path under the fake~~ | **Nothing. The claim was false** — `/admin/stripe/test-event` (`admin.ts:3464`) calls `processEventDirectly`, which routes through the same domain switch as real webhooks | **Withdrawn and restated.** Found by this audit, before the reviewer reached it |
| The driver is selected from the environment alone, never from a database value | The CI guard asserts `bootChecks.ts`'s import closure reaches no database module, so the property survives a future import rather than resting on the file's comment asking editors to preserve it | Construct — **self-caught**: revision 3 cited the comment, which is a convention, not a mechanism |
| Production cannot boot on a non-live driver | A refusal in `bootChecks.ts`, evaluated before the database-backed module graph loads; the resolution table documents it but does not enforce it | Construct |
| The mirror-mixing defect is unreachable | Downstream of the disposability constructs above; **not** independently enforced, and it was "unreachable by convention" in revision 2 | Construct, inherited — stated as derived rather than primary |

**Two properties are deliberately *not* claimed**, because nothing here enforces them and the
rule says an unenforced property is an open uncertainty rather than a settled decision:

- **That the fake behaves as real Stripe does.** Testing Plan item 7 and production
  reconciliation narrow this; the deferred parity harness would narrow it further. It is a
  named limit, not a property.
- **That the API surface the fake implements is the complete set production will ever need.**
  The compiler makes a *future* divergence a build failure, which is a construct; it does not
  make today's enumeration provably complete, and this plan does not say it does.


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
The toggle can never select the driver, and no database value can.

**Revision 2 also claimed the toggle was "inert" under the fake. That was false**, and round 2
found it: `routes/stripe.ts:44-52` passes `isLiveMode()` into `listProductsWithPrices()` to
choose which `livemode` rows the public plans endpoint returns, and the `stripe_live_mode`
PATCH handler at `routes/admin.ts:3018-3040` calls `invalidateStripeSync()` and starts a full
resync. Flipping it under a fake driver would therefore hide the seeded catalog and kick off a
sync — the opposite of inert.

**The fix is a construct, not a broader survey: under the fake driver, writes to
`stripe_live_mode` are refused.** Enumerating every mode-dependent read and neutralising each
one is the shape of work that produced this defect in the first place — it needs the
enumeration to be complete, and nothing would prove it. Freezing the value needs only one
check, and it makes the property true rather than asserted. The claim becomes: *the toggle
cannot change while the fake driver is active, and the fake seeds rows matching its fixed
value* — which the design enforces, and which a test can check directly.

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

5. **Two refusals, in two places, because they need different things — and the second one's
   placement is load-bearing.**

   The **environment refusal** (unrecognised value; production without `live`) is pure
   `process.env` reading, so it lives in `bootChecks.ts` beside the IP-salt assertion, before
   the database-backed module graph loads. `bootChecks.ts`'s minimal import graph is
   preserved: this touches `process.env` only.

   The **ownership refusal** needs database access and therefore cannot live there. Round 3
   established that its natural home would defeat it: `initStripe()` wraps everything in a
   broad `try/catch` that logs *"Stripe init failed — continuing without payments"*, and
   `index.ts:408` launches it as `initStripe().catch(...)` under a comment reading
   *"Non-blocking background tasks — failures are logged but never crash the server."* A
   refusal placed there is not a refusal; it is a log line, and the server still becomes
   healthy while the fake proceeds.

   **The invariant, stated because nothing else would catch its loss: the ownership check
   runs in an awaited boot phase, before the server accepts connections, and its failure
   terminates the process.** It is not inside `initStripe()`'s catch and is not
   fire-and-forget. Its negative test asserts **process startup failure**, not that a helper
   function rejected — a helper that rejects into a swallowed catch is exactly the passing
   test that would have hidden this.

6. **Under the fake driver there is no *external* event ingress, and exactly one
   admin-authenticated one.** The `/api/stripe/webhook` route is not registered — along with
   its raw-body parser and rate-limit exemption, which are keyed to the same path — and this
   increment adds no control routes.

   **The precise claim matters, because revision 2's was wrong.** It said an event "cannot
   enter the system by any path." The claim audit below found that false before the reviewer
   reached it: `POST /admin/stripe/test-event` (`admin.ts:3464`) calls
   `WebhookHandlers.processEventDirectly(...)`, which its own comment describes as routing
   "through the same domain switch as real webhooks." It is gated on `requireAdmin` and on
   the mode toggle being test — both of which hold under a fake driver in CI, where
   dev-admin-login is enabled. So it is a live injection path, and settled decision 6 leaves
   it in place this round by David's decision.

   The enforceable statement is therefore: **no unauthenticated or external party can deliver
   an event under the fake driver; one admin-authenticated injection path remains, and it is
   named here rather than implied absent.** In CI that path writes to an ephemeral database
   and is a fidelity consideration, not a safety one. Bringing it behind the driver predicate
   travels with the follow-up plan's control channel.

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
- **No fake-driver configuration accepts an inbound Stripe event from an unauthenticated or
  external party.** The one admin-authenticated exception is enumerated in the design above;
  this bullet deliberately does not say "by any path", because that stronger claim is false
  and revision 2 made it.

Nothing infers safety from inspecting a key prefix, a hostname, or a connection string — the
lesson recorded from the deleted `assertNotProductionDb.ts`, which was bypassed three ways
across four review rounds. The environment must *say* which driver it wants.

### Why the persistent-database risk is enforced away, not managed

Revision 1 argued the control channel was harmless because a granted entitlement lands in an
ephemeral test database. That is true of CI and false of the Repl, which uses `heliumdb`. That
false premise reshaped the increment.

Revision 2 answered it with a policy — "the fake is CI-only" — and round 2 found that nothing
enforced the policy. Revision 3 answered it with an emptiness check, and round 3 found that
emptiness is not disposability. **Revision 4 answers it with recorded ownership** (settled
decision 1): a database is fake-owned or real, the fake refuses one it does not own, and the
live driver refuses one the fake does. Combined with settled decision 4 — no control routes
ship this increment — the exposure is closed at both ends.

Round 1's finding that `listProductsWithPrices` filters `livemode` without `_account_id`
(`stripeStorage.ts:186-200`) is therefore **unreachable by construction rather than by
convention**, and the distinction is the whole point: it needs fake rows and real rows in one
database, and ownership makes that state unreachable **in both directions** rather than only
at the moment of a fake boot. It remains a **standing constraint on the
follow-up plan**, which reintroduces the possibility the moment it lets the fake run anywhere
persistent, along with round 1's observation that the existing post-sync cleanup deletes other
accounts' catalog rows.

### The CI guard

A check failing the build if the inventory stops being true: a Stripe connection constructed
outside the live driver, or **any** `STRIPE_*` credential value read outside it. The guard
covers all three credential classes, not just the secret key — the specific gap round 1 found.

It also asserts that **`bootChecks.ts`'s import closure reaches no database module**. That
property is what keeps driver selection environment-only, and revision 3 cited the file's
comment asking editors to preserve it — a convention, which is precisely what the claim-oracle
rule rejects. One more assertion in a guard being written anyway converts it to a construct.
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
existing sync controls — they read the mirror tables and cannot tell which driver filled them.

**The Billing page needs more than an active-driver label, and revision 2's remedy was too
small.** Round 2 established that under a fake or absent driver the page still renders "Stripe
not connected", instructs the operator to set all six secrets, marks webhook-secret setup as
failed, exposes a webhook URL, and states that the endpoint is wired up correctly. Every one of
those is live-only guidance, and under this design the credentials are *intentionally* unused
and the webhook route is *intentionally* absent — so the page would be issuing instructions to
fix things that are working as designed.

The invariant, rather than a list of copy edits: **the Billing page's Stripe setup guidance
describes the driver that is actually active, and never presents a deliberately-unused
configuration as a fault.** Concretely that means the credential-presence checks, the
webhook-secret status, and the webhook-endpoint controls are live-driver surfaces — hidden or
restated under `fake` and under an absent driver — and the page says which of the three states
it is in. UI assertions cover all three states, since two of them are new and neither has ever
been rendered.

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
3. **No external event ingress under the fake:** a request to `/api/stripe/webhook` reaches no
   handler when the fake driver is active, including with a well-formed `stripe-signature`
   header, and the route's raw-body parser and rate-limit exemption are absent with it.
4. **The ownership construct, all four directions** (settled decision 1), each asserting
   **process startup failure** rather than a helper rejection — a helper that rejects into a
   swallowed catch is the passing test that would have hidden round 3's finding:
   (a) fake without the declaration on an unmarked empty database refuses;
   (b) fake on an unmarked **non-empty** database refuses;
   (c) fake on a **fake-marked** database boots — the repeatable-restart case revision 3 broke;
   (d) **live on a fake-marked database refuses** — the direction that actually protects real
   data, and the one revision 3 did not have at all.
5. **The mode toggle is frozen under the fake:** a write to `stripe_live_mode` is refused while
   the fake driver is active, and the refusal does not fire under the live driver.
6. **The CI guard's own negative test** — a deliberately planted second connection site, and a
   planted read of each of the three credential classes, must each fail it. A guard never
   observed failing is not known to work.
7. **The fake satisfies `SyncRunnerDriver`** — a type-level and behavioral check that scoped
   and full sync both run against it, which is what item 8 depends on.
8. **`adminBillingSync.spec.ts` wired into `e2e-smoke`** with `STRIPE_DRIVER=fake` — the
   existing, already-complete suite, and this increment's proof. Its known transient-label
   race is next-plan scope; if it proves flaky when wired it is left unwired, **never**
   weakened or skipped to get green.
9. **Live-driver verification, outside CI — both doors.** A bounded post-merge check on the
   Repl with `STRIPE_DRIVER=live` against real test-mode Stripe, confirming boot, correct
   account selection, managed-webhook signature handling, and backfill. It runs through the
   Replit connector at close-out and is recorded in the PR's Post-merge verification section.

   **Plus one real payment flow, driven end to end in the UAT.** Revision 3 stopped at the
   sync door and declined this; round 3 supplied the evidence that decline lacked.
   `routes/stripe.ts` reaches `getUncachableStripeClient()` at nine call sites — checkout,
   portal, receipt, confirmation, cancellation, reactivation, plan switching — and **not one
   of them is exercised by anything else in this plan.** The fake's E2E suite and the
   type-level interface checks can all stay green while the extraction breaks every
   customer-facing live operation, because the raw-client door is where the extraction
   actually moves code.

   That flow is a mutation against the test account, which is why it belongs in David's UAT
   rather than the read-only post-merge check, and it is deliberately *one* flow: enough to
   prove the raw client is constructed and used correctly after extraction, not a payment
   regression suite. Distinct from the deferred parity harness, and outside CI.
10. **Billing-page truthfulness across all three driver states** — `live`, `fake`, and absent —
    asserting that live-only setup guidance is not presented as a fault in the two states where
    the configuration is deliberately unused.

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
6. Add the ownership construct — the declaration, the fake's accept-if-empty-or-marked rule,
   the marking on first fake boot, and the live driver's refusal of a marked database — in an
   **awaited boot phase that terminates the process on failure**, outside `initStripe()`'s
   catch, with the four startup-failure tests.
7. Build the fake: the full sync surface, the API surface, mirror-table seeding, loud failure
   for unimplemented operations.
8. Refuse `stripe_live_mode` writes while the fake driver is active.
9. Make webhook-route registration conditional on the resolved driver, together with its
   raw-body parser and rate-limit exemption.
10. Add the CI guard and its negative tests, including the `bootChecks.ts` import-closure
    assertion.
11. Make the Billing page truthful in all three driver states.
12. Set `STRIPE_DRIVER=fake` and the disposability declaration in the `e2e-smoke` job, and wire
    `adminBillingSync.spec.ts`.

Steps 3–5 are separable and land production-inert; that is the seam if this is split.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Deploying the refusal before the variable is set takes production down** | Steps 1–2 precede every code step; the PR's verification section confirms both environments carry the value before merge |
| **The fake drifts from production Stripe** | The compiler pins the shape; reusing `SyncRunnerDriver` extends that to the admin sync paths; the fake speaks Stripe's own types against one pinned API version. The residual gap is named and covered by reconciliation plus the live-driver verification |
| **The fake reaches production, or a real database** | Production refuses without an explicit `live`; no default selects the fake anywhere; and recorded ownership makes the two kinds of database mutually exclusive in both directions, so a database that has held fabricated rows can never later serve real Stripe |
| **A refusal is written where it cannot refuse** | The ownership check is awaited and fatal, outside `initStripe()`'s swallowed catch and its fire-and-forget launch; its tests assert process startup failure, not helper rejection |
| **A property is asserted in prose and enforced nowhere** | The claim audit above, run under the claim-oracle rule, with each row naming its oracle or construct. This risk is not hypothetical — it produced three of round 1 and round 2's findings, and the audit caught a fourth |
| **A future call site opens a second door, or reads a credential outside the driver** | The CI guard, covering all three credential classes, with negative tests proving it fails |
| **Extraction silently changes production behavior** | Step 4 is deliberately inert and reviewed as such; timeouts and retry bounds are named in *Must Not Change* because `membershipTiming.ts` derives the lease floor from them; testing-plan item 7 verifies the live path against real test-mode Stripe |
| **The follow-up plan reintroduces what this one removed** | The account-isolation constraint, control-route authorization, and event authenticity are recorded above as named inheritances rather than left to be rediscovered |
