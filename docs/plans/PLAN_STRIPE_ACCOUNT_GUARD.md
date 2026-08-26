# Plan: refuse to boot against the wrong Stripe account

**Workstream:** [#571](https://github.com/TheAnswerManIsHere/Overhypeme/issues/571)
**Ceremony:** feature mode — product code in the payment path. Small artifact, full plan.
**Criticality:** 80 — this is the only thing standing between a misplaced key and a mutated live
account, and the failure is silent today.

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
   and hoping the list stays complete. Verification is memoised per mode and credential, so this
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
   `try/catch` that logs *"Stripe init failed — continuing without payments"*, and `index.ts:408`
   launches it as `initStripe().catch(...)` under *"Non-blocking background tasks — failures are
   logged but never crash the server."* A refusal placed inside either is a log line. PR #568 paid
   for this lesson three times.
5. **This plan does not touch driver selection, the fake, or credential isolation.** They are
   separate increments on #566. This one is deliberately buildable and shippable alone.

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
| A misconfigured environment cannot mutate the wrong account | Verification is enforced at the single client-construction boundary in `stripeClient.ts` and refuses fatally, so no caller — boot, mode toggle, checkout or admin route — receives a client for an unverified account (settled decision 3) | Construct — revision 1's boot-only version was **overstated**, per round 1 |
| The account read used by the guard does not mutate and is authoritative | `stripe.accounts.retrieve()` on the raw client. **Not** the sync library's `getAccountId()`, which caches, falls back to a local key-hash lookup, and upserts (`stripe-replit-sync/dist/index.js:577-604`) | Construct — revision 1 asserted this of `getAccountId()` **without reading it**, which was the round-1 finding that stopped the loop |
| The refusal cannot be swallowed | It is not inside `initStripe()`'s `catch` and not behind the detached launch at `index.ts:408`; its tests assert **process startup failure**, not helper rejection | Construct |
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
| Which account is actually connected | Stripe, via **`stripe.accounts.retrieve()` on the raw client** | The authority the guard compares against. **Not** `getAccountId()`, which may answer from local state without contacting Stripe |

**No new source of truth.** The guard makes an existing declaration enforceable; it does not
introduce a second opinion about which account is correct.

## Proposed Design

**One check, moved, made required, and made fatal.**

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

The invariant: **the stored mode changes only if the target mode's account verifies.** Either
verify before the write, or roll the write back on refusal; and the response is a failure the
operator can see, naming the account mismatch. Testing-plan item 5 asserts both halves — the sync
refused *and* the stored mode unchanged *and* a non-success response — because asserting only the
refusal would pass against exactly the behavior this finding describes.

**Two failure classes, and conflating them is the trap round 1 found.**

| Situation | Outcome |
| --- | --- |
| Stripe credentials **absent or incomplete** | Unchanged from today: `getCredentials()` throws, `initStripe()` logs *"continuing without payments"*, **the server boots**. This plan does not make Stripe configuration mandatory |
| Credentials present, **expected account id absent** | **Fatal** |
| Credentials present, **account mismatched** | **Fatal**, before any mutation |
| Credentials present, **account unreadable** (Stripe unreachable, key rejected) | **Fatal** — an unverifiable account is not a verified one |

Revision 1 said only "hoist the check into an awaited phase whose failure terminates", which round
1 correctly read as turning optional Stripe configuration into a fatal boot dependency: the
straightforward implementation would terminate on the absent-credentials path too, contradicting
this plan's own Runtime Behavior. **The awaited phase runs only once credentials are present**,
and the two classes are distinguished by their origin — a credential-absence error from
`getCredentials()` is not a guard refusal and must not be treated as one.

**Placement is the load-bearing part.** The refusal runs in an awaited boot phase whose failure
terminates the process — not inside `initStripe()`'s `catch`, and not behind its detached launch.
If the ordering constraints make an in-place fix impossible, the alternative that satisfies the
same invariant is to hoist the account check out of `initStripe()` into that awaited phase and
leave the rest where it is. **What is not acceptable is a refusal that logs.**

## Data Model and Migration Impact

**None.** No schema change, no stored state, no backfill.

## Runtime Behavior

- **Correctly configured (production, and the Repl):** unchanged. One extra read at boot, then the
  same sequence.
- **Expected id absent:** refuses to boot, naming the variable to set.
- **Expected id present, account mismatched:** refuses to boot **before any Stripe mutation**,
  naming expected and actual.
- **Stripe not configured at all:** unchanged — `getCredentials()` throws as it does today and the
  server continues without payments. This plan does not make un-configured Stripe fatal; that is
  driver-selection scope on #566.

## Admin/User UX Impact

None for users. For an operator the change is visible only in the failure case, where a silent log
line becomes a server that will not start — which is the point.

## Security, Permissions, and Validation

- **Fail-closed on absence**, which is the inversion of today's behavior and the core of the fix.
- **Gate on an explicit positive signal** — the environment declares its account; the code never
  infers it from a key prefix, a hostname, or a connection string. That inference is the failure
  recorded from the deleted `assertNotProductionDb.ts`.
- **The comparison authority is Stripe itself**, reached with `stripe.accounts.retrieve()` on the
  raw client — not `getAccountId()`, and not a local guess.
- No new route, no new privilege, no new stored state.

## Testing Plan

1. **Expected id absent → process startup failure.** Not a helper rejection: a test that asserts a
   rejected promise would pass against the broken placement, which is precisely how PR #568's
   round-3 defect would have survived.
2. **Expected id present and matching → boots**, and the webhook registration and backfill still
   happen, in that order.
3. **Expected id present and mismatched → process startup failure**, *and* **no Stripe mutation
   was attempted** — the assertion that distinguishes this fix from the status quo. A test that
   only checks the refusal would pass on a check placed after line 99.
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
6. **Credentials absent → the server still boots** without payments, and does **not** terminate.
   This is the negative test for the guard's own blast radius: it proves the fix did not turn
   optional Stripe configuration into a fatal boot dependency.
7. **The guard's account read does not consult the sync library's cache or the local database** —
   asserted directly, because a passing guard built on `getAccountId()` would be indistinguishable
   from a correct one until the day it mattered. Cache-hit and cache-miss paths both exercised.
8. **Live-driver verification, outside CI** (post-merge, through the Replit connector): the Repl
   boots against its real test-mode account with the expected id set, and the account-verified path
   logs success. This is what establishes the *Must Not Change* row the claim audit marks as
   **checked** rather than proven.

Runners: `pnpm --filter @workspace/api-server test`.

## Implementation Steps

**Rollout ordering first — PR #568's round 1 found this exact hazard the hard way.**

1. **Confirm `STRIPE_ACCOUNT_ID_LIVE` is present in the production deployment's environment —
   as a pre-merge prerequisite, executed and recorded before the code can merge.** Round 1 was
   right that revision 1 pointed this at the wrong instrument: this repository's Post-merge
   verification runs *after* merge and Repl sync, so it cannot prevent the first fatal boot. The
   confirmation runs through the live-environment connector and its result is recorded on the
   implementation PR **before** merge; Post-merge verification is reserved for confirming an
   already-safe deployment.

   **The oracle lowers this risk but does not discharge it.** `git grep -nE "STRIPE_ACCOUNT_ID" --
   . ':!node_modules' ':!docs/plans' ':!.agents'` returns four hits: `index.ts:107-108` read the
   ids, and `.replit:186-187` set them under **`[userenv.shared]`** — the same section that carries
   `ALLOWED_ORIGINS` including the production origin `https://overhype.me`, which is strong evidence
   production reads that section. That is evidence, not proof, which is exactly why the live
   confirmation stays a prerequisite rather than being replaced by the file.
2. **Make the construction boundary mode-coherent first** (settled decision 3c): capture the mode
   once per construction and thread it to the expected account id and to every credential, and
   discard a completed build whose generation is no longer current. Verification added to a racy
   boundary would certify the wrong account.
2b. Add account verification at that boundary, using `stripe.accounts.retrieve()` on the raw
   client, memoised per mode and credential.
3. Make an absent expected id a refusal, and a mismatch a refusal, both fatal — while leaving the
   credentials-absent path exactly as it is today.
3b. Make a refused mode toggle leave the stored mode unchanged and report failure to the operator.
4. Ensure the boot-time refusal reaches the process: awaited, outside `initStripe()`'s `catch` and
   outside its detached launch at `index.ts:408`.
5. Tests 1–8.
6. Post-merge live verification on the Repl — confirming an already-safe deployment, not gating it.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Shipping the requirement before production has the variable** | Step 1 precedes every code step and the PR's verification section confirms it before merge. Recovery is one environment variable and a restart — no code change, no rollback |
| **The refusal is placed where it cannot refuse** | Named as the load-bearing property; tests assert process startup failure rather than helper rejection — the exact distinction that would have caught PR #568's round-3 defect |
| **A check that refuses correctly but too late** | Test 3 asserts no mutation was attempted, not merely that boot failed |
| **The matching path changes behavior** | Explicitly *checked, not prevented* in the claim audit; covered by test 2 and the post-merge live verification, and the timeout/retry bounds are named in *Must Not Change* |
| **The guard certifies an account it did not actually check** | The boundary is made mode-coherent *before* verification is added (settled decision 3c) — one captured mode for the expected id and every credential, with a generation check before publishing. Without this the guard is worse than absent, since it produces a verified-looking client for an unverified account |
| **A refused toggle leaves payments in a mode that cannot work** | The stored mode changes only if the target mode verifies; the test asserts the rollback and the operator-visible failure, not just the refusal |
| **A mutation path that does not pass through the construction boundary** | The boundary is the single construction site the #568 inventory established; the mode-toggle path — the one revision 1 missed — is a named test rather than an assumption |
| **The guard's own read mutates or answers from stale local state** | `stripe.accounts.retrieve()` on the raw client, with a test asserting the sync library's cache and key-hash lookup are not consulted |
| **The fix makes optional Stripe configuration fatal** | The two failure classes are separated explicitly, and the credentials-absent boot is a named negative test |
| **Scope creep back toward the driver seam** | Settled decision 5: this plan touches neither driver selection nor the fake, and is shippable alone |
