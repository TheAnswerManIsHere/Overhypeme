---
name: CodeQL doesn't recognize this repo's hand-rolled rate-limit/CSRF controls
description: js/missing-rate-limiting and js/missing-token-validation flag routes protected by checkSharedRateLimit or the double-submit CSRF cookie, because CodeQL's model only recognizes known npm packages.
---

# CodeQL flags custom rate-limiting/CSRF as "missing" even when it's present

CodeQL's default query suite includes `js/missing-rate-limiting` and
`js/missing-token-validation` (CSRF). Both appear to be built to recognize
**specific known npm packages** as satisfying the check (`express-rate-limit`,
`rate-limiter-flexible`, `csurf`, etc.) — not arbitrary custom code that
provides the same protection. This repo's actual controls are hand-rolled:

- **Rate limiting:** `checkSharedRateLimit` (`artifacts/api-server/src/lib/sharedRateLimiter.ts`),
  a DB-backed window counter. Some routes call it directly as the first
  statement in the handler; others go through `createRateLimiter`
  (`artifacts/api-server/src/lib/rateLimit.ts`), which wraps it as real
  Express middleware registered in the router chain (e.g. `ai.ts`'s
  `requireRateLimit`). Both shapes exist in this repo — the distinction
  doesn't matter to CodeQL either way (see below).
- **CSRF:** a double-submit `csrf_token` cookie + `x-csrf-token` header check,
  registered as global `app.use()` middleware in `app.ts` (see
  [`security-model.md`](../../docs/ai-context/security-model.md)).

CodeQL's `js/missing-rate-limiting` model doesn't key off "is this Express
middleware" — it keys off recognizing the *import* as one of a hardcoded list
of known packages (`express-rate-limit`, `express-brute`, `express-limiter`,
`rate-limiter-flexible`, `@fastify/rate-limit`). Confirmed empirically: a
route registered as genuine middleware via `createRateLimiter` still gets
flagged, because the underlying call is `checkSharedRateLimit`, not one of
those five packages. So neither shape — inline call or real middleware —
matches what CodeQL's query is looking for, and it flags routes protected by
either as vulnerable.

**Confirmed on PR #256:** adding `checkSharedRateLimit` to
`/admin/taxonomy-health/job-status` (matching the exact established pattern
already used unflagged elsewhere in `facts.ts`/`localAuth.ts` — those routes
just weren't in that PR's diff) did **not** clear the `js/missing-rate-limiting`
alert on that line; a fresh alert re-fired on the same line on the very next
push containing the fix. Separately, David spotted a `js/missing-token-validation`
("Missing CSRF middleware") alert on `app.ts`'s `cookieParser()` line —
verified via the GitHub Security tab to be **first detected 3 days before
PR #256 even existed**, i.e. pre-existing on `main`, not introduced by any
diff — and the CSRF protection sits a few lines below the flagged line in the
same file. Same class of false positive as the rate-limiting one, though not
independently confirmed by clearing it (David dismisses these manually; the
agent has no tool access to GitHub's code-scanning-alert dismissal API).

**Confirmed a second time on PR #288:** the same alert re-fired identically on
two new `/admin/queue-health*` routes after `checkSharedRateLimit` was applied
to them, on the next push containing the fix — same shape as PR #256, no new
information. Two independent confirmations is enough to stop treating this as
a one-off and start treating a fresh alert on an already-protected route as
the expected, not the surprising, outcome.

**A third, related variant confirmed on PR #287:** the alert fired on
`GET /admin/membership/grace-sweep`, a brand-new route with **no rate-limit
call of any kind** — not even the "protected but unrecognized" shape above.
This route's real control is `requireAdmin` alone, which is this file's
actual established convention: of the ~50 other `requireAdmin`-only routes
already on `main` in `admin.ts`, none call `checkSharedRateLimit` either, and
none are flagged (they're baseline code, not in the diff). So the alert fires
purely because the route is *new*, not because it is *less* protected than
its siblings — adding a redundant rate limit here alone, while the other 50
stay bare, would be inconsistent scanner-appeasement rather than closing a
real gap. Same disposition as the other two: flagged for David, not
self-dismissed.

**Rule:** when a new CodeQL alert of either kind appears on a route/file that
already uses `checkSharedRateLimit` or sits behind the global CSRF middleware,
**investigate before "fixing"** — confirm the real control is present (check
this repo's established patterns above) rather than reflexively adding a
second, redundant, inconsistent control (e.g. `express-rate-limit` bolted onto
one route) just to satisfy the scanner's pattern-matcher. Once confirmed as a
false positive, it needs a human with repo-admin access to dismiss it in
GitHub's Security → Code scanning tab (mark "false positive") — no available
MCP/GitHub tool can do this from the agent side.
