# Plan: refuse to boot against the wrong Stripe account

**Workstream:** [#571](https://github.com/TheAnswerManIsHere/Overhypeme/issues/571)
**Ceremony:** feature mode — product code in the payment path. Small artifact, full plan.
**Criticality:** 80 — this is the only thing standing between a misplaced key and a mutated live
account, and the failure is silent today.

> **Revision 6, after round 5 returned four findings — all upheld — and after the budget's
> mandatory stop.** The declared 5 rounds were spent; the exhaustion adjudication returned
> *escalate* (`.agents/adjudications/572-3.json`), and David granted a 2-round extension with the
> scope ruling that all four are fixed **in this increment**
> (`.agents/receipts/loop-extension-572-1.json`). All four attack the degraded-mode machinery
> revision 5 added: recovery must resume the *whole* initialization (webhook + backfill), not just
> client availability; the guard's mode read must bypass the admin-config cache, whose in-flight
> reads can republish the pre-toggle mode for ~60 seconds; the unverified state needs a live status
> channel on the Billing page; and the payment routes' shared error responder must carry a typed
> unverified error instead of flattening everything to "try again".
>
> **Revision 5, after round 4 returned four findings — all upheld — and after David decided the
> availability fork round 4's P1 correctly refused to let this plan settle on its own.** The
> decision (David, 2026-08-26): **a Stripe outage never takes the site down.** Only a *definitive*
> wrong answer is fatal at boot; an *indefinite* one — Stripe unreachable, the mode unreadable —
> boots the server without payments, refuses the payment paths, and retries on an interval until
> verification succeeds. This replaces revision 2's "an unverifiable account is not a verified one
> → fatal" row, which had quietly taken an availability position nobody asked for. The safety
> invariant never rested on fatality anyway: **no client is handed to any caller until its account
> verifies** — withholding clients is the mechanism; refusing to boot is operator visibility for
> the one case where the wrong account is *confirmed*. Also in this revision: the boot gate reads
> the mode through a failure-propagating path (round 4 found `getConfigStringRaw` silently answers
> "test" when it means "I could not tell"), verification failures are never memoised, and test 10
> gains its actual runner — the frontend suite.
>
> **Revision 4, after round 3 returned eight findings — all upheld.** None of them attacks the
> guard's shape; every one attacks a place where the plan asserted a property it had not made
> reachable. Four are about *where* the mechanism sits — the fatal check must precede
> `app.listen()`, not merely leave `initStripe()`; the pre-merge production check must exercise the
> retrieval rather than test a variable's presence; the rollback must be conditional or it races a
> concurrent toggle; a generation-rejected build must have its pool closed. Three are testing-plan
> gaps that would let a wrong implementation pass. One records the external Stripe claim at its
> version.
>
> **Revision 3, after round 2 returned three findings — all upheld.** The largest is a scope
> addition I am taking **now** rather than deferring, under the "cannot be correct without it"
> override, and flagged to David rather than absorbed: **the construction boundary this guard sits
> on is racy today**, and a guard placed on it would verify one mode and hand out a client for
> another — laundering the defect rather than catching it. Also: every normative `getAccountId()`
> reference is purged, and a refused mode toggle now rolls back instead of reporting success.
>
> **Revision 2, after round 1 returned five findings — all upheld.** Two were overstated claims
> in this plan's own audit, which tripped a pre-registered flip condition and sent the increment
> to David rather than straight to a fix; he chose to fix and continue. The largest: `getAccountId()`
> is **not** a read. Details in each section below.
>
> Split out of PR #568 after its round 5, which found this defect while reviewing a plan that
> could not have fixed it. Written under the
> [claim-oracle rule](../ai-context/working-modes.md#a-completeness-claim-carries-its-oracle-or-it-is-not-a-claim-david-2026-08-25)
> from the first draft: every completeness, inertness or unreachability claim below carries the
> oracle that establishes it or the construct that enforces it.

---

## Problem

**A Stripe secret key bound to the wrong environment variable reaches and mutates the wrong
account, and nothing stops it.**

In `artifacts/api-server/src/index.ts`, inside `initStripe()`:

| Line | What happens |
| --- | --- |
| **99** | `await stripeSync.findOrCreateManagedWebhook(webhookUrl)` — **mutates the connected account** |
| 106-108 | reads `STRIPE_ACCOUNT_ID_LIVE` / `_TEST` into `expectedAccountId` |
| **109** | `if (expectedAccountId)` — **absent means the check never runs** |
| 111-115 | on mismatch: `logger.error(...)`, then execution continues |
| **121** | `syncBackfill({ object: "all" })` starts regardless |

So a live-account key in `STRIPE_SECRET_KEY_TEST` registers a webhook on the live account and
backfills it. The comparison runs **after** the mutation, has **no teeth**, and is **skipped
entirely** when the expected id is unset.

Line 103's comment reads: *"Catches misconfigured API keys early so the wrong account is never
silently used."* **That is the property this plan delivers.** The code states it; the code does
not do it.

## Direction

No direction document covers this, and this plan does not create one — it is a single defect with
a single fix. It is the first of the increments PR #568 was split into (see
[#566](https://github.com/TheAnswerManIsHere/Overhypeme/issues/566)), and deliberately the one
that depends on none of the others.

What this increment makes true: **a server that talks to real Stripe has declared which account it
expects, and refuses to start — before touching anything — if the connected account is not that
one.**

## Product Intent

Misplacing a Stripe key produces a refusal at boot, not a mutation of the wrong account.

Stated as the acceptance case, because it is the one that matters: **a test-mode environment given
a live-account key cannot create a webhook on, or begin a backfill against, that live account.**

## Must Not Change

1. **Which account a correctly-configured environment uses.** When the connected account matches
   the expected one, behavior is bit-for-bit what it is today.
2. **Webhook registration and backfill** on that matching path — same calls, same order, same
   timeouts and retry bounds (`membershipTiming.ts` derives the entitlement-lease floor from them).
3. **The live/test mode toggle's** meaning and storage. This plan reads it; it does not change it.
4. **Entitlement derivation** in `membershipState.ts`.
5. **No database schema change**, and no new source of truth.
6. **The Repl's and production's current accounts** — this plan adds a check, never a rebinding.

## Settled Decisions

1. **The expected account id is required whenever Stripe initialises against real credentials.**
   Today's `if (expectedAccountId)` makes absence a silent skip, which is fail-open: the
   environment least likely to have configured it is the one most likely to be misconfigured.
2. **A mismatch is fatal.** Logging and continuing is what makes today's check worthless.
3. **The check is enforced where clients are constructed, not only at boot** (revision 2, after
   round 1). Revision 1 checked the mode active *at boot* and asserted that post-boot admin routes
   therefore sat behind the guard. That is false: `PATCH /admin/config/stripe_live_mode`
   (`routes/admin.ts:3024`) writes the new mode, invalidates the cached client, and immediately
   calls `runFullSync` using the **newly active credential, which boot never verified**.

   The invariant instead: **no Stripe client or sync object is handed to any caller until the
   account behind its credential has been verified against the expected id for that mode.**
   `stripeClient.ts` is the only construction site in the tracked repo, so that boundary covers
   boot, the mode toggle, checkout and the admin routes uniformly, rather than enumerating callers
   and hoping the list stays complete. **That file exports two constructors, and both are the
   boundary** — `getStripeSync()` and `getUncachableStripeClient()`, the latter used directly by
   checkout (`routes/stripe.ts`) and the admin mutation routes. Round 3 found revision 3's tests
   exercised only the first, which would have let an implementation guard sync construction, pass
   every listed test, and still hand checkout an unverified client. The invariant is about clients,
   not about the sync object. Verification is memoised per mode and credential, so this
   is one extra call per distinct credential, not per request.

3c. **The construction boundary must first be made mode-coherent — a scope addition taken *now*,
   under the "cannot be correct without it" override** (revision 3, after round 2).

   Round 2 established that the boundary is racy today, and I confirmed it in the source:
   `getStripeSync()` reads the mode at `stripeClient.ts:121`, then `buildStripeSync()` reads it
   **again** via `getStripeSecretKey()` and **again** via `getStripeWebhookSecret()` — three
   independent reads. `docs/engineering/deferred-work.md:529-565` already documents this, found on
   PR #299's review and deferred by PR #308, listing both the mixed-mode-credentials case and the
   case where an old-mode build publishes *after* `invalidateStripeSync()`.

   **A guard added to that boundary would be worse than no guard.** It would add a fourth
   independent mode read, verify the account for mode A, and hand back a client built for mode B —
   producing something that looks verified and is not. The guard would launder the defect instead
   of catching it.

   So this increment also requires: **one mode captured per construction, threaded to the expected
   account id and to every credential; and a generation check before a completed build is
   published**, so a build whose mode is no longer current is disposed rather than cached.

   **"Disposed" has to mean something specific, because the library gives it nothing to mean**
   (revision 4, after round 3). `new StripeSync(...)` constructs a `PostgresClient`, which runs
   `this.pool = new pg.Pool(config.poolConfig)` synchronously in its own constructor
   (`stripe-replit-sync/dist/index.js:34-38`, reached from `:565`). A pool therefore exists before
   any generation check can reject the build, so dropping the reference leaks it on every delayed
   toggle. And `grep -n "pool.end\|close()\|dispose"` over that file returns **nothing** — the
   library exposes no teardown at all. The only reachable disposal is its public field:
   `sync.postgresClient.pool.end()`. Naming that here rather than writing "dispose" is the point;
   an implementer told to dispose would look for a method that does not exist and drop the
   reference instead.

   Disposal of *previously cached* instances stays deferred, as before. This is disposal of a
   build this increment's own generation check creates and then rejects — a leak the increment
   introduces, not one it inherits.

   **Why now rather than next**, stated because the default is next: the guard's correctness
   depends on it. Deferring it ships a verification that can certify the wrong account. This is
   *not* a licence to take the rest of that deferred-work entry — single-flight, pool disposal and
   the rejected-promise guardrail stay deferred, and are named here so the boundary between what
   this increment takes and what it leaves is explicit.
3b. **The account is read with `stripe.accounts.retrieve()` through the raw client — never with
   the sync library's `getAccountId()`** (revision 2, after round 1). Round 1 established, and I
   confirmed at `node_modules/stripe-replit-sync/dist/index.js:577-604`, that `getAccountId()`
   returns an in-memory cached id; failing that, returns an id looked up **from the local database
   by API-key hash without contacting Stripe**; and only on a miss calls Stripe and then
   **upserts the account row and the key hash into the database**. It is therefore neither
   non-mutating nor authoritative.

   The compounding effect matters more than either flaw alone: a first mismatched boot stores the
   wrong account *against that key's hash*, so every later boot resolves it locally and never asks
   Stripe. A guard built on that helper grows quieter precisely in the case it exists to catch.
4. **The refusal must survive the swallowing paths.** `initStripe()` wraps everything in a
   `try/catch` that logs *"Stripe init failed — continuing without payments"*, and `index.ts:409`
   launches it as `initStripe().catch(...)` under *"Non-blocking background tasks — failures are
   logged but never crash the server."* A refusal placed inside either is a log line. PR #568 paid
   for this lesson three times.
5. **This plan does not touch driver selection, the fake, or credential isolation.** They are
   separate increments on #566. This one is deliberately buildable and shippable alone.
6. **The availability posture: only a definitive wrong answer is fatal** (David, 2026-08-26,
   deciding round 4's P1). Fatal at boot: a **confirmed mismatch** — Stripe answered, and the
   account behind the credential is not the declared one — and a **missing expected id with
   credentials present**, which is deterministic misconfiguration retry cannot fix. Everything
   indefinite — Stripe unreachable, a timeout, a 5xx, the mode unreadable from the config store,
   a rejected key — **boots the server without payments**: the payment paths refuse with a clear
   error, verification retries on an interval, and payments come online automatically when a retry
   verifies. A mismatch discovered *post-boot* by a retry leaves the server up: payments stay
   refused, and the error is loud. The reasoning, recorded because it inverts revision 2: the
   guard's safety never came from fatality — it comes from **no client existing until its account
   verifies** (settled decision 3). Fatality is operator signal, and it is reserved for the case
   where the wrong account is a *fact* rather than a possibility. A rejected key is grouped with
   the indefinite cases deliberately: it cannot mutate anything (every call fails), so killing the
   site over it converts a harmless misconfiguration into an outage.
7. **The mode read behind the guard must propagate failure** (revision 5, after round 4).
   `isLiveMode()` (`stripeClient.ts:7-16`) wraps `getConfigStringRaw("stripe_live_mode", "false")`
   (`adminConfig.ts:176-183`) — **two** nested swallowing layers, each answering `"test mode"` for
   both "the stored mode is test" and "the lookup failed". A gate reading its precondition through
   that path can verify the **test** account while the stored mode is **live**, then hand the
   misplaced live credential to the first post-recovery construction — certifying the wrong
   account, which settled decision 3c calls worse than no guard. The guard therefore uses a
   failure-propagating mode read; a failed read resolves to **unverified** (degrade-and-retry per
   decision 6), never to a defaulted mode. `isLiveMode()`'s swallowing behavior is unchanged for
   its other callers — this plan adds a strict read for the guard, it does not rewrite the
   lenient one.

   **Amended by round 5: the strict read also bypasses the admin-config cache.** Failure
   propagation alone is not enough, because the cache can serve a *stale success*:
   `loadAll()` (`adminConfig.ts:32-40`) has no in-flight tracking, so a read started before a
   toggle can complete after `bustConfigCache()` and repopulate the cache with **pre-write rows
   for another ~60 seconds** — documented at `deferred-work.md:500-506`, naming the
   `stripe_live_mode` bust path specifically. A post-toggle construction reading through that
   cache captures the old mode *inside the current generation*, so the generation check passes
   and the guard verifies one mode while the sync runs another. The strict read therefore selects
   the `stripe_live_mode` row **directly from the database**, touching neither `loadAll()`'s
   cache nor its TTL. One targeted query per construction (constructions are memoised); the
   general config cache and its documented single-flight fix stay deferred — this bypasses the
   cache for one key at one boundary, it does not fix the cache.
8. **Verification failures are never memoised** (revision 5, after round 4). The per-mode,
   per-credential memo caches **successes only**; a rejected verification is evicted before the
   rejection propagates. `deferred-work.md:541-546` already records this exact hazard for
   `getStripeSync()` as a forward-looking guardrail — a cached rejection would pin payments off
   until restart, defeating decision 6's retry loop, and one transient Stripe blip would become a
   permanent outage of the payment paths.

9. **A verified retry resumes the full initialization, exactly once** (revision 6, after round
   5). Revision 5 promised "payments recover automatically" and delivered it only for clients:
   `initStripe()` (`index.ts:75-127`) attempts `getStripeSync()` once, catches the refusal, and
   returns **before** `findOrCreateManagedWebhook()` and `syncBackfill()` — so a recovered retry
   would restore checkout while the managed webhook stays unregistered and the mirror tables stay
   empty until the next restart. The transition to *verified* therefore triggers the remaining
   initialization sequence — webhook registration, then backfill, same order as a clean boot —
   guarded so it runs **exactly once** whether verification succeeded at boot or on any later
   retry. Test 12 asserts the webhook registration and backfill, not merely client availability.
10. **The unverified state has a live status channel** (revision 6, after round 5). The promise
   that the Billing page "shows payments as unavailable-pending-verification" had no mechanism:
   the page fetches `/api/admin/stripe/summary` on mount and manual refresh only
   (`billing.tsx:165-180`), and neither that endpoint nor `/stripe/config` carries verification
   state today. So: the verifier exposes its state — `pending` / `verified` / `refused`, with the
   refusal reason and last-attempt timestamp, never account ids beyond what the refusal message
   already carries for the admin — as a `verification` field on the **authenticated**
   `/admin/stripe/summary` response (`admin.ts:3233`, already `requireAdmin`-gated, already
   fetched by the page); the Billing page polls it while the state is `pending` and stops when it
   settles. Test 16 proves `pending → verified` renders without a manual refresh.
### The affected-surface inventory

Class: *every path that mutates a Stripe account during boot, and every reader of the expected
account id.*

| Oracle (tracked set) | Result |
| --- | --- |
| `git grep -nE "STRIPE_ACCOUNT_ID" -- . ':!node_modules' ':!docs/plans' ':!.agents'` | **4 hits**: `.replit:186-187` set both ids under `[userenv.shared]`; `index.ts:107-108` read them. No other reader, no computed or helper-mediated access. **Scoped to exclude this document** — round 1 found revision 1's unscoped command returned nine, five of them the plan matching itself, so it was not reproducible as recorded |
| `git grep -n "findOrCreateManagedWebhook\|syncBackfill" -- '*.ts' ':!*__tests__*'` | boot mutations at `index.ts:99` and `:121`. **`syncBackfill` is also called from `routes/admin.ts:3024`, on the `stripe_live_mode` toggle, with a credential boot never verified** — revision 1 claimed these "sit behind this guard" and they did not, which is why the guard moved to the construction boundary |
| `git grep -n "stripe_live_mode" -- '*.ts' ':!*__tests__*'` | the mode is read in `stripeClient.ts:12` and five route sites, and **written** at `routes/admin.ts:3024`; every consumer obtains its client through `stripeClient.ts`, which is what makes that boundary sufficient |

**Both expected-account ids are already configured** (`.replit:186-187`), which is why the rollout
below is a confirmation rather than a migration. Values are not reproduced here; the plan needs the
variables, not their contents.

### The claim audit

| Claim | What establishes it | Status |
| --- | --- | --- |
| Exactly two sites read the expected account id, both in `index.ts` | `git grep -nE "STRIPE_ACCOUNT_ID"` → 4 hits, 2 of which are the `.replit` definitions | Oracle, run and mapped |
| Boot mutates Stripe at exactly two points | `git grep -n "findOrCreateManagedWebhook\|syncBackfill"` → `index.ts:99` and `:121`; other `syncBackfill` callers are post-boot admin routes | Oracle, run and mapped |
| A misconfigured environment cannot mutate the wrong account | Verification is enforced at the single client-construction boundary in `stripeClient.ts` and withholds the client on anything but a verified account, so no caller — boot, mode toggle, checkout or admin route — receives a client for an unverified account (settled decision 3) | Construct — revision 1's boot-only version was **overstated**, per round 1 |
| The account read used by the guard does not mutate and is authoritative | Two halves, both read at the pinned versions. **That the call is a non-mutating self-lookup:** at `stripe@20.0.0`, `accounts.retrieve()` with no id takes the branch at `node_modules/stripe/cjs/resources/Accounts.js:22-27` — `{ method: 'GET', fullPath: '/v1/account' }`. `GET` is non-mutating; `/v1/account` takes no account parameter, so it can only resolve to the account behind the presented key. **That the rejected helper is unsafe:** `stripe-replit-sync/dist/index.js:577-604`, which caches, falls back to a local key-hash lookup, and upserts | Construct — revision 1 asserted this of `getAccountId()` **without reading it**, which was the round-1 finding that stopped the loop. Round 3 then found revision 3 had recorded only the second half: the *load-bearing* half, about an external API, was carried unversioned |
| The refusal cannot be swallowed | It is not inside `initStripe()`'s `catch` and not behind the detached launch at `index.ts:409`; its tests assert **process startup failure**, not helper rejection | Construct |
| The boot gate never verifies a guessed mode | The gate reads the mode through a failure-propagating path; a failed read resolves to **unverified**, never to a default. Round 4 found the existing read (`stripeClient.ts:7-16` over `adminConfig.ts:176-183`) answers "test" through **two** nested catches for both "stored as test" and "could not tell" | Construct — with test 11 asserting no verification runs against a defaulted mode |
| A transient verification failure cannot pin payments off | The memo caches successes only; a rejection is evicted before it propagates (settled decision 8, the `deferred-work.md:541-546` guardrail). Test 12 asserts recovery without restart | Construct |
| The refusal precedes the port opening | It completes before `app.listen()` at `index.ts:303`, asserted by test 3b as *the port is never bound*. Revision 3 claimed only that it escapes `initStripe()`, which `grep -n "app.listen\|initStripe()"` shows is 106 lines too late | Construct — revision 3's version was **overstated**, per round 3 |
| Production carries the expected account id | `.replit:186-187` place both under `[userenv.shared]`, alongside the production origin — evidence, not proof, that the deployment reads them | **Checked, not prevented** — the pre-merge live confirmation is what discharges it |
| A correctly-configured environment is unaffected | **Not claimed as proven by construction.** It is *checked* — by the matching-path tests and the post-merge live verification. The guard adds a branch on the boot path, and only running it against the real accounts establishes that the matching path is unchanged | **Checked, not prevented** |

The last row is deliberate. Under the claim-oracle rule a property backed only by tests is written
as *checked*, never as *cannot* — and this one genuinely is.

## Current Behavior

`initStripe()` runs at boot, detached and swallowing. It registers the managed webhook, then
compares `getAccountId()` against the expected id **if one is set**, logging either way, then
starts a full backfill. Nothing in that sequence can prevent a mutation, and the whole function is
launched so that its failures never reach the process.

## Source-of-Truth Analysis

| Concept | Source of truth | Effect |
| --- | --- | --- |
| Which account this environment may use | **`STRIPE_ACCOUNT_ID_{LIVE,TEST}`** — already the source, currently advisory | Unchanged as a source; becomes binding |
| Which credential is read | `stripe_live_mode` config row selecting the env var | Unchanged |
| Which account is actually connected | Stripe, via **`stripe.accounts.retrieve()` on the raw client** — no argument, which at the installed `stripe@20.0.0` maps to `GET /v1/account` (`node_modules/stripe/cjs/resources/Accounts.js:22-27`) | The authority the guard compares against: a `GET`, so non-mutating, and `/v1/account` resolves to *the credential's own* account rather than one named by the caller. **Not** `getAccountId()`, which may answer from local state without contacting Stripe |

**No new source of truth.** The guard makes an existing declaration enforceable; it does not
introduce a second opinion about which account is correct.

## Proposed Design

**One check, moved, made required, and given teeth — fatal on a confirmed mismatch, degrade-and-retry on an indefinite answer (settled decision 6).**

1. **Resolve the expected account id** for the active mode, exactly as today.
2. **Refuse if it is absent**, whenever Stripe is initialising against real credentials. Absence is
   a misconfiguration, not a licence to skip.
3. **Read the connected account** with `stripe.accounts.retrieve()` on the raw client — never
   `getAccountId()`, which answers from an in-memory cache or a local key-hash lookup and upserts
   on a miss (settled decision 3b). Round 2 found revision 2 had corrected the decisions, the
   audit and the steps while leaving this section directing the implementer at the old helper —
   which would have recreated the defect verbatim.
4. **Refuse on mismatch**, terminating the process with a message naming both ids and the variable
   to correct.
5. **Only then** register the webhook and start the backfill, unchanged.

**A refused toggle must leave the previous mode active.** Round 2 found that
`PATCH /admin/config/stripe_live_mode` commits the config row first, then calls
`invalidateStripeSync()` and `getStripeSync()` inside a `try/catch` that only logs
(`routes/admin.ts:3024-3034`), and returns `res.json(updated)` regardless. With a
construction-boundary guard, a mismatched inactive credential would therefore refuse the sync while
**leaving payments switched to a mode whose every client rejects** — and the operator would see a
successful toggle.

The invariant: **the stored mode changes only if the target mode's account verifies.**

**Revision 3 offered "verify before the write, or roll it back on refusal" as equivalent
alternatives. Round 3 established they are not** — the rollback half is unsafe as written. I
confirmed the route has no compare-and-swap: the update is
`.update(adminConfigTable).set(patch).where(eq(adminConfigTable.key, key))`
(`routes/admin.ts:3000-3004`), keyed only on the config key, with no row version and no expected
prior value. So with two admins or API clients toggling concurrently: request A writes an invalid
target, request B writes a valid one and succeeds, then A's verification fails and A restores the
value it remembered — **silently undoing B's successful change.** The guard would have manufactured
the mode inconsistency it exists to prevent.

Two acceptable shapes, and the first is preferred because it has no race to reason about:

1. **Verify before the write.** The target mode's account is verified first; the config row is
   written only on success. Nothing is ever committed that has to be taken back.
2. **Conditional rollback.** If the write must come first, the restore is a compare-and-swap that
   succeeds *only while the row still holds this request's value*, and reports failure without
   writing when it does not.

Either way the response is a failure the operator can see, naming the account mismatch. Testing-plan
item 5 asserts all three halves — the sync refused, the stored mode unchanged, a non-success
response — and item 5d covers the concurrent case, which item 5 alone cannot: it exercises a single
request, and a single request never observes this defect.

**Three outcome classes, and conflating any two of them is the trap this loop kept finding** —
round 1 caught fatal-vs-absent, round 4 caught fatal-vs-indefinite.

| Situation | Outcome |
| --- | --- |
| Stripe credentials **absent or incomplete** | Unchanged from today: `getCredentials()` throws, `initStripe()` logs *"continuing without payments"*, **the server boots**. This plan does not make Stripe configuration mandatory |
| Credentials present, **expected account id absent** | **Fatal** — deterministic misconfiguration; retry cannot fix it |
| Credentials present, **account mismatched** (Stripe answered) | **Fatal**, before any mutation and before the port binds |
| Credentials present, **account indefinite** (Stripe unreachable, timeout, 5xx, key rejected, mode unreadable) | **Boots without payments** (David, 2026-08-26): payment paths refuse with a clear error, verification retries on an interval, payments come online automatically on a verified retry. A retry that later returns a *confirmed mismatch* leaves the server up — payments stay refused, loudly |

Revision 1 said only "hoist the check into an awaited phase whose failure terminates", which round
1 correctly read as turning optional Stripe configuration into a fatal boot dependency: the
straightforward implementation would terminate on the absent-credentials path too, contradicting
this plan's own Runtime Behavior. **The awaited phase runs only once credentials are present**,
and the two classes are distinguished by their origin — a credential-absence error from
`getCredentials()` is not a guard refusal and must not be treated as one.

**Placement is the load-bearing part, and round 3 found the plan had understated it.** Revision 3
said the refusal must sit outside `initStripe()`'s `catch` and outside its detached launch at
`index.ts:409`. Both are necessary and neither is sufficient: `grep -n "app.listen\|initStripe()"`
puts `app.listen(port, ...)` at **`index.ts:303`** and the detached `initStripe()` at **`:409`** —
106 lines later. A check hoisted to line 409 and awaited there still runs **after the process has
bound its port**, which means a mismatched deployment opens for traffic, can pass a health check,
and only then exits. On a platform that restarts it, that is a crash loop serving requests in
between.

So the requirement is positional and stated against the line, not the function: **the boot
verification attempt completes before `app.listen()` at `index.ts:303`.** It runs in an awaited
boot phase preceding the listen call — not inside `initStripe()`'s `catch`, not behind its detached
launch, and not merely "earlier in the file". **What is not acceptable is a refusal that logs, and
what is no longer acceptable is a refusal that arrives after the port is open.**

**The unverified state reaches paying users as a specific message, not a generic one** (revision
6, after round 5). Every payment route's `catch` calls the shared responder
`paymentErrorResponse()` with a **fixed** `clientMessage` per call site ("Unable to start
checkout. Please try again." and variants) — the thrown error's own message is logged and
discarded (`paymentErrorResponse.ts:5-31`), so during a degraded boot, checkout, portal and
subscription users would see retry advice for a condition retrying does not fix. So: the
verifier's refusal is a **typed error** carrying a client-safe message — payments temporarily
unavailable, no account ids — and the shared responder maps that type to HTTP 503 with that
message before falling back to each call site's generic string. One mapping at the boundary all
payment routes already pass through, not a per-route edit. Test 15 proves representative payment
endpoints return it during a degraded boot.

**Under settled decision 6 the awaited attempt is one attempt, bounded.** It resolves to one of
three outcomes: **verified** → listen, payments on; **confirmed mismatch** → exit, port never
bound; **indefinite** (timeout, network error, 5xx, mode unreadable) → listen, payments refused,
retry loop armed. The attempt carries an explicit timeout so a Stripe outage delays boot by at most
that bound rather than blocking it — the pre-listen placement exists so a *confirmed* mismatch
never serves traffic, and decision 6 exists so an *unconfirmed* one never blocks the site. The
post-listen retry uses the same verifier and the same memo (successes only, decision 8), so
recovery needs no restart.

Test 3b is what holds this: it asserts the **port is never bound**, rather than that the process
eventually exits. A test asserting only eventual exit passes against exactly the placement this
finding describes — which is how revision 3 would have shipped looking tested.

## Data Model and Migration Impact

**None.** No schema change, no stored state, no backfill.

## Runtime Behavior

- **Correctly configured (production, and the Repl):** unchanged. One extra bounded read at boot,
  then the same sequence.
- **Expected id absent (credentials present):** refuses to boot, naming the variable to set.
- **Expected id present, account mismatched:** refuses to boot **before any Stripe mutation and
  before the port binds**, naming expected and actual.
- **Expected id present, account indefinite** (Stripe down, timeout, key rejected, mode
  unreadable): **boots without payments.** Payment paths refuse with an error naming the
  unverified state; verification retries on an interval; payments come online automatically when a
  retry verifies. A retry returning a confirmed mismatch leaves the server up with payments
  refused, loudly (David, 2026-08-26).
- **Stripe not configured at all:** unchanged — `getCredentials()` throws as it does today and the
  server continues without payments. This plan does not make un-configured Stripe fatal; that is
  driver-selection scope on #566.

## Admin/User UX Impact

None for users. For an operator the change is visible in two failure cases.

**At boot**, a confirmed wrong account turns a silent log line into a server that will not
start — which is the point. An *indefinite* answer instead boots with payments off and retries
(settled decision 6), so a Stripe outage reads as degraded payments, never as a dead site.

**At the mode toggle, the Billing page has to be changed for the refusal to be visible at all**
(revision 4, after round 3). Revision 3 promised a response "naming the account mismatch" and
stopped at the API. I read `artifacts/overhype-me/src/pages/admin/billing.tsx:219-243`:
`toggleLiveMode()` does `if (!resp.ok) throw new Error("Failed to update")` — the response body is
**never read**, so every non-success reply, whatever it says, reaches the operator as the string
`Failed to update`. An operator seeing that has no way to tell a mismatched account from a
transient failure, and the reason they need — which key points at which account — is the whole
value of the refusal.

So the surface ships with the guard: `toggleLiveMode()` parses the error body and displays the
server's reason, falling back to the current generic string only when the body carries none. Test
10 covers it — **run by the frontend suite** (`pnpm --filter @workspace/overhype-me run test`),
which round 4 caught: the plan had recorded only the api-server runner, which cannot discover a
Vitest test under `artifacts/overhype-me`, so the promised regression would never have executed.

**The degraded state is also visible, not only the refusal** (settled decision 6 creates it): while
the server runs unverified — Stripe unreachable at boot, retries in flight — the Billing page shows
payments as unavailable-pending-verification rather than healthy. Per the async-status contract,
a state the server can be in that an operator would act on is shown, not logged. This is the ship-the-UI-surface rule applying to a refusal path rather than a
feature — a guard whose explanation dies at the fetch boundary is a guard the operator cannot
act on.

## Security, Permissions, and Validation

- **Fail-closed on absence**, which is the inversion of today's behavior and the core of the fix.
- **Gate on an explicit positive signal** — the environment declares its account; the code never
  infers it from a key prefix, a hostname, or a connection string. That inference is the failure
  recorded from the deleted `assertNotProductionDb.ts`.
- **The comparison authority is Stripe itself**, reached with `stripe.accounts.retrieve()` on the
  raw client — not `getAccountId()`, and not a local guess.
- No new route, no new privilege, no new stored state.

## Testing Plan

1. **Expected id absent (credentials present) → process startup failure.** Not a helper rejection: a test that asserts a
   rejected promise would pass against the broken placement, which is precisely how PR #568's
   round-3 defect would have survived.
2. **Expected id present and matching → boots**, and the webhook registration and backfill still
   happen, in that order.
3. **Expected id present and mismatched → process startup failure**, *and* **no Stripe mutation
   was attempted** — the assertion that distinguishes this fix from the status quo. A test that
   only checks the refusal would pass on a check placed after line 99.
3c. **Stripe unreachable at boot → the server boots**, payment paths refuse with an error naming
   the unverified state, and **no Stripe client is handed to any caller**. The bounded attempt
   means boot is delayed by at most the timeout. This is settled decision 6's positive half, and
   the assertion that matters is the withheld client — the refusing routes are its consequence.
3b. **On mismatch the port is never bound.** Asserted directly against `app.listen()`, not as
   "the process eventually exits" — `index.ts:303` binds 106 lines before the detached
   `initStripe()` at `:409`, so a refusal that is merely awaited-and-fatal still serves traffic
   first. This is the test that distinguishes the required placement from the one revision 3
   described.
4. **The refusal is not swallowed:** with `initStripe()`'s `try/catch` intact, a mismatch still
   terminates the process.
5. **The mode-toggle path is guarded, and a refusal rolls back:** with a valid credential for the
   active mode and a **mismatched** credential for the inactive one, toggling `stripe_live_mode`
   refuses to sync, **leaves the stored mode unchanged**, and returns a non-success response naming
   the mismatch. All three asserted — asserting only the refusal would pass against the behavior
   round 2 found.
5b. **The delayed mid-flight toggle**, the test `deferred-work.md:529-565` already specifies: a
   mode flip landing between a construction's mode reads must not yield a mixed-mode client, and a
   build whose generation is stale must not publish after `invalidateStripeSync()`. This is the
   test that makes the guard meaningful rather than decorative.
5c. **A valid toggle still works, end to end.** With a matching credential for the target mode,
   the PATCH **succeeds**, the new mode **is stored**, the cache is invalidated, and the full sync
   starts. Round 3 found the suite covered only refusal, so an implementation that rejects every
   toggle — or verifies, refuses to persist, and skips the sync — would have passed it. This is the
   regression test for *Must Not Change* item 3, and the only listed test that would fail if the
   guard simply broke the toggle. The oracle for the gap: `git grep -ln "stripe_live_mode"` across
   the api-server tests returns one file, `stripeWebhookSecret.test.ts`, which does not exercise
   the config toggle at all.
5d. **Concurrent toggles do not lose a valid write.** Two overlapping PATCHes — one whose target
   mode fails verification, one whose target verifies — leave the stored mode at the *valid*
   request's value, whichever order they complete in. Item 5 exercises a single request and so
   cannot see this: the defect needs a second writer to exist.
6. **Credentials absent → the server still boots** without payments, and does **not** terminate.
   This is the negative test for the guard's own blast radius: it proves the fix did not turn
   optional Stripe configuration into a fatal boot dependency.
7. **The guard's account read does not consult the sync library's cache or the local database** —
   asserted directly, because a passing guard built on `getAccountId()` would be indistinguishable
   from a correct one until the day it mattered. Cache-hit and cache-miss paths both exercised.
7b. **A mismatched credential is refused through `getUncachableStripeClient()` too, and no raw
   client reaches a mutation caller.** Tests 1–5 all reach Stripe through `getStripeSync()`, and
   test 7 can be satisfied by a shared verifier that only the sync path calls — so an
   implementation guarding sync construction alone passes every other item here while still handing
   checkout the wrong-account client. `git grep -n "getUncachableStripeClient" -- '*.ts' '*.tsx'
   ':!*__tests__*'` returns 22 references across four files: `lib/stripeClient.ts` (the export),
   `routes/stripe.ts` (checkout), `routes/admin.ts` (admin mutations) and `lib/webhookHandlers.ts`.
   This is the test that makes settled decision 3's invariant — *no Stripe client handed to any
   caller until its account is verified* — cover both exported constructors rather than one.
8. **Live-driver verification, outside CI** (post-merge, through the Replit connector): the Repl
   boots against its real test-mode account with the expected id set, and the account-verified path
   logs success. This is what establishes the *Must Not Change* row the claim audit marks as
   **checked** rather than proven.
9. **A generation-rejected build closes its pool.** A construction whose mode is stale by
   completion is not merely dropped: its `postgresClient.pool` is ended, asserted directly. The
   pool exists by then whatever the generation check decides — `PostgresClient`'s constructor runs
   `new pg.Pool(...)` synchronously (`stripe-replit-sync/dist/index.js:34-38`) — so "discarded"
   without this assertion means "leaked once per delayed toggle".
10. **The Billing page shows the server's reason.** A refused toggle whose response names the
   account mismatch renders that reason, not the hardcoded `Failed to update` that
   `billing.tsx:231` produces today for every non-success response. **Runs in the frontend
   suite** — `pnpm --filter @workspace/overhype-me run test`, per `docs/tests/TESTING.md:22` —
   as a Vitest file under `artifacts/overhype-me`; the api-server runner cannot discover it,
   which round 4 caught after revision 4 recorded only that runner.
11. **A failed mode read never verifies a guessed mode.** With `stripe_live_mode` stored as live
   and the config read failing, the boot gate performs **no** verification against test mode, hands
   out **no** client, and boots with payments refused; when the config read recovers, a retry
   verifies the **live** account and payments come online. The defaulted-mode path
   (`getConfigStringRaw(..., "false")`, two swallowing layers) is the one this test exists to
   prove unused by the guard.
12. **A transient verification failure recovers without restart — and recovery is the whole
   sequence.** Verification fails once (Stripe error), then succeeds on retry for the **same mode
   and credential**: the failure was not memoised, payments come online, the pool count did not
   grow, **and the managed webhook is registered and the backfill started, in that order** —
   exactly once across boot and retries (settled decision 9). Round 5 found the client-only
   version of this test passes against a recovery that leaves the integration dead until
   restart. The memo half is the `deferred-work.md:541-546` guardrail made a test.
13. **A post-boot confirmed mismatch does not kill the server.** A retry that returns a definite
   wrong account leaves the process up, payments refused, with a loud error naming both ids.
14. **A stale config-cache read cannot leak the old mode past a toggle.** A `loadAll()` delayed
   across the PATCH and `bustConfigCache()` completes and repopulates the cache with pre-write
   rows; the client and sync constructed after the toggle nevertheless use the **target** mode —
   because the guard's strict read went to the database, not the cache (settled decision 7 as
   amended). This is round 5's delayed-read test, and it fails against a strict read that only
   propagates failure without bypassing the cache.
15. **Payment routes name the unverified state.** During a degraded boot, representative payment
   endpoints (checkout, portal, subscription) return HTTP 503 with the typed unverified message —
   not the per-route "Please try again" strings — and no account ids. Exercised through the
   routes, so the mapping in the shared responder is proven reachable, not just present.
16. **The Billing page shows `pending → verified` without a manual refresh.** Frontend test:
   with the summary endpoint reporting `pending` then `verified`, the page's polling renders the
   transition on its own. Runs in the frontend suite with test 10.
Runners: `pnpm --filter @workspace/api-server test` for tests 1–9 and 11–15;
`pnpm --filter @workspace/overhype-me run test` for tests 10 and 16.

## Implementation Steps

**Rollout ordering first — PR #568's round 1 found this exact hazard the hard way.**

1. **Run the guard's own check against production, by hand, before the code can merge** — a
   pre-merge prerequisite executed through the live-environment connector, with its result recorded
   on the implementation PR. Round 1 established the *timing*: this repository's Post-merge
   verification runs after merge and Repl sync, so it cannot prevent a first fatal boot. Round 3
   established that revision 3 then got the *content* wrong, and the two failures compound.

   Revision 3 asked only whether `STRIPE_ACCOUNT_ID_LIVE` **exists**. But this plan makes three
   things matter, and presence answers none of them: it does not say **which mode production is
   actually in** (so it may check the live id while production runs test), it does not say the
   active secret **retrieves** the declared account (a mismatch is fatal), and it does not say the
   retrieval **succeeds at all** (an indefinite account boots without payments, per settled
   decision 6 — no longer fatal, but a production deploy that comes up with payments off is still
   an incident). A deployment could pass revision 3's prerequisite and still boot straight into a
   refused-payments state — or, on a real mismatch, fail to boot at all.

   **So the prerequisite is the guard's own comparison, run early**: read the production
   deployment's `stripe_live_mode`, call `stripe.accounts.retrieve()` with the secret for *that*
   mode, and compare the returned account id to that mode's `STRIPE_ACCOUNT_ID_*`. It must return
   an id, and it must match. Anything else stops the merge. Recorded on the implementation PR
   before merge; Post-merge verification is reserved for confirming an already-safe deployment.

   **Scoping, since the connector defaults to building:** this is read-only and diagnostic — report
   the mode, report whether the ids match, never print the secret or the account id values, and
   change nothing.

   **The oracle lowers this risk but does not discharge it.** `git grep -nE "STRIPE_ACCOUNT_ID" --
   . ':!node_modules' ':!docs/plans' ':!.agents'` returns four hits: `index.ts:107-108` read the
   ids, and `.replit:186-187` set them under **`[userenv.shared]`** — the same section that carries
   `ALLOWED_ORIGINS` including the production origin `https://overhype.me`, which is strong evidence
   production reads that section. That is evidence, not proof, which is exactly why the live
   confirmation stays a prerequisite rather than being replaced by the file.
2. **Make the construction boundary mode-coherent first** (settled decision 3c): capture the mode
   once per construction and thread it to the expected account id and to every credential, and
   discard a completed build whose generation is no longer current — **ending its
   `postgresClient.pool`**, since the library exposes no teardown of its own. Verification added to
   a racy boundary would certify the wrong account.
2b. Add account verification at that boundary, using `stripe.accounts.retrieve()` on the raw
   client, memoised per mode and credential. **Both exported constructors**: `getStripeSync()` and
   `getUncachableStripeClient()`, which checkout and the admin mutation routes use directly.
2c. Give the guard a **failure-propagating, cache-bypassing mode read** (settled decision 7 as
   amended): the `stripe_live_mode` row is selected directly from the database, never through
   `loadAll()`'s cache; a failed read resolves to unverified, never to a defaulted mode. The memo
   caches successes only (settled decision 8).
3. Make an absent expected id (credentials present) a refusal and a **confirmed** mismatch a
   refusal, both fatal — while an **indefinite** answer boots without payments, arms the retry
   loop, and surfaces the unverified state on the Billing page (settled decision 6). The
   credentials-absent path stays exactly as it is today.
3b. Make a refused mode toggle leave the stored mode unchanged — by verifying before the write, or
   by a compare-and-swap rollback — and report failure to the operator.
3c. Surface that failure on the Billing page: `toggleLiveMode()` parses the error body and displays
   the server's reason instead of the hardcoded `Failed to update`.
3d. Make the verified transition **resume the remaining initialization exactly once** (settled
   decision 9): webhook registration, then backfill, whether verification succeeded at boot or on
   a later retry.
3e. Expose the verifier's state as the `verification` field on `/admin/stripe/summary`, and poll
   it from the Billing page while pending (settled decision 10). Map the typed unverified error
   in `paymentErrorResponse` to 503 with the client-safe message.
4. **Move the boot-time verification attempt ahead of `app.listen()` at `index.ts:303`**:
   awaited, bounded by a timeout, outside `initStripe()`'s `catch`, outside its detached launch at
   `:409`, and completed before the port is bound. Three outcomes: verified → listen; confirmed
   mismatch → exit with the port never bound; indefinite → listen with payments refused and the
   retry loop armed. The listen call is the line to measure against; "outside `initStripe()`" is
   necessary and not sufficient.
5. Tests 1–16.
6. Post-merge live verification on the Repl — confirming an already-safe deployment, not gating it.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Shipping the requirement before production has the variable** | Step 1 precedes every code step and the PR's verification section confirms it before merge. Recovery is one environment variable and a restart — no code change, no rollback |
| **The refusal is placed where it cannot refuse** | Named as the load-bearing property; tests assert process startup failure rather than helper rejection — the exact distinction that would have caught PR #568's round-3 defect |
| **The refusal fires only after the port is open**, so a mismatched deployment serves traffic and crash-loops | The requirement is stated against `index.ts:303`, not against `initStripe()`; test 3b asserts the port is **never bound**, which an eventual-exit assertion does not |
| **A rollback races a concurrent toggle and reverts a valid change** | Verify-before-write is the preferred shape precisely because it has no race; a rollback, if used, is a compare-and-swap conditional on the row still holding this request's value. Test 5d exercises two overlapping writers |
| **The guard refuses and the operator cannot see why** | The reason is carried through to the Billing page rather than stopping at the API; test 10. `billing.tsx:231` discards every server error today |
| **The generation check leaks a connection pool per delayed toggle** | Disposal is named as the concrete call the library actually permits (`postgresClient.pool.end()`), not as "dispose"; test 9 asserts the pool closes |
| **The pre-merge production check passes and the first boot still fails** | The prerequisite is the guard's own comparison — mode, retrieval, and id match — rather than a presence test that answers none of the three conditions that matter — the active mode, the retrieval succeeding, and the id matching |
| **A check that refuses correctly but too late** | Test 3 asserts no mutation was attempted, not merely that boot failed |
| **The matching path changes behavior** | Explicitly *checked, not prevented* in the claim audit; covered by test 2 and the post-merge live verification, and the timeout/retry bounds are named in *Must Not Change* |
| **The guard certifies an account it did not actually check** | The boundary is made mode-coherent *before* verification is added (settled decision 3c) — one captured mode for the expected id and every credential, with a generation check before publishing. Without this the guard is worse than absent, since it produces a verified-looking client for an unverified account |
| **A refused toggle leaves payments in a mode that cannot work** | The stored mode changes only if the target mode verifies; the test asserts the rollback and the operator-visible failure, not just the refusal |
| **A mutation path that does not pass through the construction boundary** | The boundary is the single construction site the #568 inventory established, and **both** of its exported constructors are guarded; the mode-toggle path (missed by revision 1) and the raw-client path (untested in revision 3) are named tests rather than assumptions |
| **The guard's own read mutates or answers from stale local state** | `stripe.accounts.retrieve()` on the raw client, with a test asserting the sync library's cache and key-hash lookup are not consulted |
| **The fix makes optional Stripe configuration fatal** | The outcome classes are separated explicitly, and the credentials-absent boot is a named negative test |
| **A Stripe outage takes the site down** | Settled decision 6: only a confirmed mismatch (or a missing expected id with credentials present) is fatal; every indefinite answer boots without payments and retries. Tests 3c, 12 and 13 hold the three edges: outage boots, recovery needs no restart, a post-boot mismatch does not kill the process |
| **The boot gate verifies a mode it guessed** | Settled decision 7: the guard's mode read propagates failure; a failed read is *unverified*, never "test". Test 11 asserts no verification runs against a defaulted mode — round 4 found the existing read swallows failure twice |
| **One transient Stripe error pins payments off until restart** | Settled decision 8: the memo caches successes only, rejections evicted before propagating — the `deferred-work.md:541-546` guardrail. Test 12 asserts recovery |
| **The site runs payments-off indefinitely and nobody notices** | The unverified state is loud three ways: an error-level log per failed retry, the `verification` field on the admin summary with the Billing page polling it live (test 16), and payment routes returning the typed 503 rather than generic retry advice (test 15) |
| **Recovery restores checkout but not the integration** | Settled decision 9: the verified transition resumes webhook registration and backfill exactly once; test 12 asserts the sequence, not client availability alone |
| **The config cache republishes the old mode past a toggle** | The guard's strict read bypasses `loadAll()` entirely — one direct query per memoised construction (settled decision 7 as amended); test 14 delays a cache read across the toggle and asserts the target mode wins. The cache's own single-flight fix stays deferred and is unchanged |
| **Scope creep back toward the driver seam** | Settled decision 5: this plan touches neither driver selection nor the fake, and is shippable alone |
