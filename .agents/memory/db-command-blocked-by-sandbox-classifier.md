---
name: `pnpm --filter @workspace/db push-force` blocked by the sandbox's auto-mode classifier
description: Even with a session-provisioned test DB running, the drizzle-kit push-force command was denied by the Claude Code auto-mode permission classifier as a category, not a one-off. Rely on equivalent CI evidence instead of fighting it.
---

# Local DB-schema-push command blocked, even with a working test DB

## What happened

While verifying a `drizzle-orm` version bump (PR #246, patching a SQL-injection
CVE), tried to run the repo's documented DB-backed test setup —
`pnpm --filter @workspace/db push-force` — to push schema to the
session-start-hook-provisioned test Postgres DB before running the API test
suite. The command was denied outright by the environment's auto-mode
permission classifier:

> "Permission for this action was denied by the Claude Code auto mode
> classifier... If you believe this capability is essential to complete the
> user's request, STOP and explain to the user what you were trying to do and
> why you need this permission."

This happened despite the test DB genuinely existing and being reachable
(the session-start hook logs confirmed `postgres://overhype:overhype@localhost:5432/overhype_test`
was ready) — the block is on the *command shape* (a schema-mutating
`push-force`), not on DB availability.

## What worked instead

Did not fight the denial or look for a workaround. Leaned on **equivalent,
already-available evidence**: the exact dependency versions being verified
(`drizzle-orm@0.45.2`, `vite@7.3.6`) had already been resolved in a sibling
PR (#243) whose own CI had run the full `Test` / `Frontend Test` / `E2E Smoke`
suite green against those same versions. Combined with a clean local
`typecheck:libs` + `pnpm run build`, that was strong enough grounding to ship
— and the PR's own CI re-verified everything for real on push anyway, which
is the authoritative check regardless.

## Takeaway

If a DB-mutating local command gets denied here, don't retry variants or
look for a bypass. Check whether equivalent verification already exists
(a sibling PR's CI, a prior green run against the same inputs) before
concluding local verification is impossible — and remember the real CI run
on push is always the backstop.
