---
name: run the EXISTING security regression suite for any route you touch, not just your new test
description: Why validating only the new/nearby test suites for a route change misses a pre-existing security regression test that asserts the route's exact response, and green-lights a CI break.
---

# Run a route's existing security regression suite when you modify it

## What happened

During the admin input-validation sweep (C9, PR #218), `POST
/admin/users/set-password` was rewritten to validate its body with a zod schema,
which changed the 400 body from the specific `"password must be at least 8
characters"` to a generic `"Invalid input"`. Locally I ran the *new* validation
test plus the admin-auth suite — both green — and pushed. CI went red: a
**pre-existing** C7 regression in `localAuth.security.test.ts` (from an earlier
PR) asserts `res.body.error` matches `/at least 8/` on that same endpoint, and my
message change broke it. Codex flagged it as a P1 before I'd finished diagnosing
the CI log.

## The generalizing rule

**When you change a route that has security-relevant behavior, run every test
suite that exercises *that route*, not just the suite nearest your diff.** A
security regression test often lives in a `*.security.test.ts` named for the
*finding* (`localAuth.security`), not for the route file you're editing
(`admin.ts` / `routes.admin.auth`), so it won't be in the obvious neighborhood.
Before pushing a change to an endpoint, grep for the route path across
`src/__tests__/` and run each hit:

```bash
grep -rl "admin/users/set-password" artifacts/api-server/src/__tests__/
```

Changing a validation **message** (not just logic) is enough to break a test that
asserts the wording — treat error-string changes on security endpoints as
behavior changes with test coverage, and preserve the specific messages unless
you deliberately migrate every assertion.

## Why this is easy to miss

- The break is in a suite named for a *finding*, not for the file you edited, so
  "run the tests near my change" skips it.
- Typecheck and the new/nearby suites all pass — nothing local signals the miss
  until CI (or a reviewer) runs the full sharded suite.
- It's a *message* diff, not a logic diff, so it doesn't feel like a
  behavior change.

## Overhype specifics

The fix (PR #218, commit reverting to explicit message-specific checks + inline
email validation) is described in
[`security-model.md`](../../docs/ai-context/security-model.md#authentication--sessions).
The repo runs `node --test` sharded; a single suite is
`node --import tsx/esm --test src/__tests__/<file>.test.ts`.
