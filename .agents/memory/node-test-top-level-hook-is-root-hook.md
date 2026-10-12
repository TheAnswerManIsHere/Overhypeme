---
name: A file-level hook is a root hook under --test-isolation=none
description: In the api-server runner, a beforeEach/afterEach written at a test file's top level runs before every test in the process, other files included; scope hooks inside a describe and restore what they set.
---

# A file-level hook is a root hook under `--test-isolation=none`

**The gotcha.** The api-server suites run under `node --test
--test-isolation=none` (see
[`app-ts-eager-singleton-test-isolation.md`](app-ts-eager-singleton-test-isolation.md)),
so many test files share one process. In that mode, a `beforeEach` or
`afterEach` written at a file's **top level**, outside any `describe`, is a
**root hook**. It runs around every test in the process, including tests in
other files of the same shard.

**How it showed up (PR #577, harvest notes on #571).** A file-level hook that
deleted the `STRIPE_*` variables broke an unrelated suite two shards away. The
failure appears in the wrong file, so it reads as a flake.

**The fix has two halves, and one is not enough:**

1. **Scope the hook** inside a `describe`, so it runs only around that
   file's tests.
2. **Restore what the hook changed.** Scoping stops the hook running
   elsewhere, but a value it set and never put back still leaks into whatever
   runs next in the process. `clearStripeEnv()` in the Stripe guard tests
   exists for this.

**Still live at the 2026-10-12 harvest:** `stripePaymentRefusal.test.ts` sets
three `STRIPE_*_TEST` variables in a file-level `beforeEach`, and its
`afterEach` doesn't restore them. Tracked in
[`deferred-work.md`](../../docs/engineering/deferred-work.md).
