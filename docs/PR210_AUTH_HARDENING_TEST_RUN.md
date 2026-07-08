# PR210 — Auth Hardening (C4/C7/C8) — TEST_RUN

Engineering/automated checklist for Replit. This is the technical safety net;
delete this file once the checklist has been run and passes. The UAT sibling
(`PR210_AUTH_HARDENING_UAT.md`) is the durable half.

## Scope

Server-only changes to the local-auth surface:
- **C4** — rate limiting on `POST /auth/local-login` (per-IP + per-email) and
  `POST /auth/register` (per-IP).
- **C8** — password reset invalidates all of a user's sessions via one indexed
  DB delete (+ jsonb fallback for legacy rows) instead of a full-table scan.
- **C7** — `POST /admin/users/set-password` minimum length 6 → 8.

No schema/migration change. No frontend change.

## Commands (run in `artifacts/api-server`)

Apply migrations as usual, then:

```bash
# 1. Typecheck — must be clean
npx tsc -b

# 2. The touched suites — expect 196 pass / 0 fail
node --import tsx/esm --test \
  src/__tests__/localAuth.security.test.ts \
  src/__tests__/routes.localAuth.test.ts \
  src/__tests__/routes.admin.auth.test.ts

# 3. Full api-server suite (sanity — no regressions)
pnpm --filter @workspace/api-server test
```

`BCRYPT_SALT_ROUNDS=4` is set by the test script; the DB connection is Replit's
to manage (do not add DATABASE_URL here).

## Expected results

- **`localAuth.security.test.ts` (new)** — 5 tests pass:
  - login throttled per-IP after the limit (429),
  - login throttled per-email across many IPs (429),
  - register throttled per-IP (429),
  - password reset deletes both a `userId`-column session and a legacy
    (jsonb-only, `userId = NULL`) session,
  - admin set-password rejects a 7-char password, accepts 8.
- **`routes.localAuth.test.ts`** — all existing tests still pass. Note the
  `makeApp` helper now injects a distinct `X-Forwarded-For` per request so the
  new per-IP limiter doesn't exhaust the shared `127.0.0.1` bucket across the
  file. If these fail with unexpected 429s, that IP-injection middleware is the
  first thing to check.
- **`routes.admin.auth.test.ts`** — unchanged, all pass.

## Behavioral checks (optional, against a running server)

- `POST /api/auth/local-login` 11× from one IP with distinct emails → the 11th
  returns **429** with `{ "error": "Too many attempts. Please try again in a few minutes." }`.
- `POST /api/auth/register` 11× from one IP → 11th returns 429.
- Trigger a password reset for a user with an active session, complete it, then
  reuse the old session cookie/bearer → it no longer authenticates.
- `POST /api/admin/users/set-password` with a 7-char password → 400
  `"password must be at least 8 characters"`.

## Gotchas

- The rate-limit counters live in `rate_limit_counters` (keyed by a hash of
  `endpoint|ip|uid|email`). If you manually hammer the endpoints during testing,
  clear rows with `key_raw LIKE 'rl|auth.local-login|%'` (and `auth.register`)
  or wait out the window.
- Thresholds are deliberately generous (IP 10/15m, email 30/15m) to avoid
  locking out a fumbling legitimate user; the edge (Cloudflare) is the
  authoritative per-IP control, this is defense-in-depth.

## Deliberately NOT shipped in this PR

- **The `dev-admin-login` backdoor (C1).** It remains OPEN by product decision
  during pre-launch. There is a prominent `SECURITY TODO` in
  `routes/localAuth.ts` at that route and a tracked pre-launch item. Do **not**
  treat the open backdoor as a regression in this PR — hardening it is scheduled
  separately before public launch.
- Session **rotation** on the email-change flow — classified as a justified
  metadata update (same principal, no privilege change), not changed here.
