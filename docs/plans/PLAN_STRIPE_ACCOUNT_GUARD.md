# Plan: refuse to boot against the wrong Stripe account

**Workstream:** [#571](https://github.com/TheAnswerManIsHere/Overhypeme/issues/571)
**Ceremony:** feature mode — product code in the payment path. Small artifact, full plan.
**Criticality:** 80 — this is the only thing standing between a misplaced key and a mutated live
account, and the failure is silent today.

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
3. **The check runs before any mutation** — before `findOrCreateManagedWebhook` and before
   `syncBackfill`. A check after a mutation is a report, not a guard.
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
| `git grep -nE "STRIPE_ACCOUNT_ID" -- . ':!node_modules'` | **4 hits**: `.replit:186-187` set both ids; `index.ts:107-108` read them. No other reader, and no computed or helper-mediated access |
| `git grep -n "findOrCreateManagedWebhook\|syncBackfill" -- '*.ts' ':!*__tests__*'` | boot mutations occur at `index.ts:99` and `index.ts:121`; `syncBackfill` also reachable from the admin sync routes, which run **after** boot and so sit behind this guard |
| `git grep -n "getAccountId" -- '*.ts' ':!*__tests__*'` | the account is readable without mutating, which is what makes a pre-mutation check possible at all |

**Both expected-account ids are already configured** (`.replit:186-187`), which is why the rollout
below is a confirmation rather than a migration. Values are not reproduced here; the plan needs the
variables, not their contents.

### The claim audit

| Claim | What establishes it | Status |
| --- | --- | --- |
| Exactly two sites read the expected account id, both in `index.ts` | `git grep -nE "STRIPE_ACCOUNT_ID"` → 4 hits, 2 of which are the `.replit` definitions | Oracle, run and mapped |
| Boot mutates Stripe at exactly two points | `git grep -n "findOrCreateManagedWebhook\|syncBackfill"` → `index.ts:99` and `:121`; other `syncBackfill` callers are post-boot admin routes | Oracle, run and mapped |
| A misconfigured environment cannot mutate the wrong account | The check is required, fatal, and ordered before both mutation points (settled decisions 1–3) | Construct |
| The refusal cannot be swallowed | It is not inside `initStripe()`'s `catch` and not behind the detached launch at `index.ts:408`; its tests assert **process startup failure**, not helper rejection | Construct |
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
| Which account is actually connected | Stripe, via `getAccountId()` | Unchanged — it is the authority the guard compares against |

**No new source of truth.** The guard makes an existing declaration enforceable; it does not
introduce a second opinion about which account is correct.

## Proposed Design

**One check, moved, made required, and made fatal.**

1. **Resolve the expected account id** for the active mode, exactly as today.
2. **Refuse if it is absent**, whenever Stripe is initialising against real credentials. Absence is
   a misconfiguration, not a licence to skip.
3. **Read the connected account** with `getAccountId()` — a read, safe to perform before any
   mutation.
4. **Refuse on mismatch**, terminating the process with a message naming both ids and the variable
   to correct.
5. **Only then** register the webhook and start the backfill, unchanged.

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
- **The comparison authority is Stripe itself** (`getAccountId()`), not a local guess.
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
5. **Live-driver verification, outside CI** (post-merge, through the Replit connector): the Repl
   boots against its real test-mode account with the expected id set, and the account-verified path
   logs success. This is what establishes the *Must Not Change* row the claim audit marks as
   **checked** rather than proven.

Runners: `pnpm --filter @workspace/api-server test`.

## Implementation Steps

**Rollout ordering first — PR #568's round 1 found this exact hazard the hard way.**

1. **Confirm `STRIPE_ACCOUNT_ID_LIVE` is present in production's environment.** The Repl already
   carries both (`.replit:186-187`); production is the one to verify, and it must be verified
   **before** the requirement ships or the first boot after merge is fatal.
2. Hoist the account check ahead of `findOrCreateManagedWebhook`, into an awaited boot phase whose
   failure terminates the process.
3. Make an absent expected id a refusal.
4. Make a mismatch a refusal.
5. Tests 1–4.
6. Post-merge live verification on the Repl.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| **Shipping the requirement before production has the variable** | Step 1 precedes every code step and the PR's verification section confirms it before merge. Recovery is one environment variable and a restart — no code change, no rollback |
| **The refusal is placed where it cannot refuse** | Named as the load-bearing property; tests assert process startup failure rather than helper rejection — the exact distinction that would have caught PR #568's round-3 defect |
| **A check that refuses correctly but too late** | Test 3 asserts no mutation was attempted, not merely that boot failed |
| **The matching path changes behavior** | Explicitly *checked, not prevented* in the claim audit; covered by test 2 and the post-merge live verification, and the timeout/retry bounds are named in *Must Not Change* |
| **Scope creep back toward the driver seam** | Settled decision 5: this plan touches neither driver selection nor the fake, and is shippable alone |
