# PR #671 — A fake Stripe for testing, and real Stripe left as it was — UAT

**Workstream:** #566

CI and local runs can now use a fake Stripe that needs no key and cannot reach
any real Stripe account. Against it the Billing sync, the plans list and the
sync-status strip all work, so the Billing sync browser test runs on every PR
for the first time. The Repl and production keep using real Stripe. The one
change on that side is a new safety refusal: real Stripe keys never touch a test
or fake database.

Almost everything here is checked by machines. What is left for you is one look
at the Repl's Billing page, confirming it behaves exactly as before.

## Setup

- [claude] Confirm the Repl is synced to this PR's merge commit, and that the
  post-merge verification checks in the PR body passed.

## Steps

### 1. On a fake-Stripe environment, Billing says so and shows the fake plans

**Do:** Open Admin → Billing on a server running the fake Stripe.

**Expect:** A blue "Fake Stripe — no real account" notice sits under the Stripe
Mode card. The plans list shows "Legendary (fake)" with monthly, annual and
lifetime prices, and "Sync Stripe data" runs to a green "Sync complete".

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminBillingSync.spec.ts:the fake fixture product should be listed`

### 2. The fake refuses to start in production, or beside a real Stripe key

**Do:** Boot the server with the fake selected, once as production and once
with a Stripe key set.

**Expect:** Both refuse before the server ever accepts a connection.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/doubleSelection.test.ts:exits when the fake Stripe is named beside a real Stripe credential`

### 3. The fake refuses a database that was not created for it

**Do:** Boot the server with the fake selected, pointed at an ordinary test
database.

**Expect:** It refuses before the server ever accepts a connection, saying the
database was not created for the fake.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeBootPlacement.test.ts:#566 — the fake Stripe on a database not created for it`

### 4. Real Stripe keys refuse a test or fake database

**Do:** Start real Stripe, with keys, against a test database and against a fake
one.

**Expect:** Both refuse before any Stripe call. While the database's settings
cannot be read, payments stay unavailable on every path until a retry reads
them.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeFakeDriver.test.ts:the real driver with credentials on a database carrying neither setting verifies as before`

### 5. On the Repl, Billing behaves exactly as before

**Do:** On the Repl, open Admin → Billing and click "Sync Stripe data".

**Expect:** There is no "Fake Stripe" notice. The mode badge shows the mode you
expect, the plans are your real test-mode plans, and the sync finishes with a
green summary, as it did before this change.

**Lane:** human

## Regression

### R1. The account guard from #571 is unchanged

**Do:** Run the account-guard suite.

**Expect:** A wrong-account key still refuses before any change, a missing
account id still refuses, and an outage still degrades to "payments
unavailable".

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/stripeAccountGuard.test.ts`

### R2. The Repl's database is on real Stripe's side of the split

**Do:** Read the Repl database's two settings (post-merge check 1 in the PR body).

**Expect:** Neither the test marker nor the fake-ownership setting is present.

**Lane:** live

**Check:** `lib/db/src/testDatabaseMarker.ts:DATABASE_PARTITION_SETTINGS_SQL`, run read-only against the Repl's `DATABASE_URL` through the connector (PR #671's post-merge check 1)

### R3. Checkout and the payment routes still behave as before on real Stripe

**Do:** Run the Stripe route suite.

**Expect:** Every existing checkout, portal and confirmation case passes.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.stripe.test.ts`

## Not bugs

- Payments, the customer portal and webhook processing refuse on the fake Stripe.
  Money moving on the fake is the next increment (the event channel), not this one.
- The fake Stripe cannot run on the Repl or in production. That is by design;
  this UAT checks it from CI.
