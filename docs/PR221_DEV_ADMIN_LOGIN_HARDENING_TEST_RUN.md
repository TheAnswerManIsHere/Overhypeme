# PR221 — dev-admin-login Hardening (C1) — TEST_RUN

Engineering checklist for Replit. This PR gates the dev-admin-login backdoor
**fail-closed**: it now mints an admin session only when
`ENABLE_DEV_ADMIN_LOGIN=true` in a **non-production** environment; otherwise the
route 404s and mints nothing. Session rotation + `returnTo` sanitization harden
the enabled path.

Sibling doc: [`PR221_DEV_ADMIN_LOGIN_HARDENING_UAT.md`](./PR221_DEV_ADMIN_LOGIN_HARDENING_UAT.md).

## Commands

From `artifacts/api-server`:

```bash
pnpm run typecheck

# The C1 hardening suite + the C7 suite (same route file)
node --import tsx/esm --test \
  src/__tests__/localAuth.devAdminLogin.security.test.ts \
  src/__tests__/localAuth.security.test.ts
```

Also typecheck the frontend (the Navbar trigger change):

```bash
cd ../overhype-me && pnpm run typecheck
```

Expected: both typechecks exit 0; the two api-server suites pass with **0
failures** (locally: 12 C1 + 5 C7). No new schema/migration.

## What the tests prove

`localAuth.devAdminLogin.security.test.ts`:

- **`isDevAdminLoginEnabled()` env matrix** — OFF with no flag; ON only with
  `ENABLE_DEV_ADMIN_LOGIN=true` in non-prod; a non-`"true"` value is OFF; and
  **OFF in production** (`NODE_ENV=production` OR `REPLIT_DEPLOYMENT=1`) even
  when the flag is set.
- **`getSafeReturnTo()`** — collapses `//evil.com`, `https://evil.com`,
  `javascript:…`, non-strings to `/`; keeps a same-origin path (+ query/hash).
- **Route end-to-end** — disabled → GET and POST **404 with no `Set-Cookie`**
  (no session minted); prod-with-flag → 404; enabled → grants (200, fresh
  session cookie) and the GET redirect target is sanitized
  (`returnTo=//evil.com/x` → `window.location.replace("/")`).

## Live verification on the running app (you own the env)

The security-critical property is "inert unless explicitly enabled." Confirm on
the real server:

```bash
# With ENABLE_DEV_ADMIN_LOGIN unset (default): the route is inert.
curl -sI  https://<host>/api/auth/dev-admin-login | head -1      # → 404
curl -sD- -o /dev/null https://<host>/api/auth/dev-admin-login | grep -i set-cookie   # → (nothing)

# Set ENABLE_DEV_ADMIN_LOGIN=true in the PREVIEW (non-prod) env and retry:
#   GET .../dev-admin-login?returnTo=/admin  → 200 HTML that sets auth_token and
#   redirects to /admin; a fresh session cookie is issued.
# A production deploy must ALWAYS 404 regardless of the flag.
```

> The dev entrypoint `scripts/dev-run.sh` sets `ENABLE_DEV_ADMIN_LOGIN=true`
> automatically, so a server started the normal dev way (and the Playwright e2e
> admin flows, which authenticate via this route) works without manual env
> setup. Only a deployed-style run needs the flag set explicitly.

Confirm the two things a headers/gate change is most likely to break:

- **Replit preview still reaches admin** when `ENABLE_DEV_ADMIN_LOGIN=true` is
  set in that env (triple-tap the wordmark → lands in `/admin`).
- **The deployed (production) app 404s** the route even if the flag is present.

## Deliberately NOT in this PR

- **No change to real login/OAuth** — only the dev backdoor is gated.
- **`security-model.md` note flip** (its ⚠️ "deliberately open" section →
  "hardened") is a docs-only change to the still-open docs PR #220, not here.
