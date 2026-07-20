# PR215 — Application Security Headers (C5) — TEST_RUN

Engineering / automated checklist for Replit. This PR adds a `securityHeaders()`
middleware (helmet + a route-class override) mounted first in `app.ts`. It's an
**API-only** server, so the CSP governs only `/api` JSON, the OG HTML shells, and
public image bytes — never the SPA's own HTML. CSP ships **Report-Only** so
nothing breaks; the frame/HSTS policy is **env-aware**.

Sibling doc: [`PR215_SECURITY_HEADERS_UAT.md`](./PR215_SECURITY_HEADERS_UAT.md).

## Commands

From `artifacts/api-server`:

```bash
# helmet was added to dependencies — install it
pnpm install

# 1. Full typecheck gate
pnpm run typecheck

# 2. The header matrix tests (env × route-class)
node --import tsx/esm --test src/__tests__/securityHeaders.test.ts
```

Expected: `typecheck` exits 0. `securityHeaders.test.ts` → **8 pass, 0 fail**.

## Live header verification (do this on the running app — you own the env)

The unit tests boot a bare Express app; confirm the **real** server emits the
headers end-to-end. With the API running, curl one path per route class and
check the response headers:

```bash
# JSON (any API route) — expect strict report-only CSP, nosniff, no x-powered-by,
# and (in a PRODUCTION deploy) X-Frame-Options: DENY + Strict-Transport-Security.
curl -sI https://<your-host>/api/config

# OG shell — expect Content-Security-Policy-Report-Only to include
# `img-src 'self' https: data:` and Cross-Origin-Resource-Policy: cross-origin.
curl -sI https://<your-host>/api/og/m/<any-slug>

# Public meme image — expect Cross-Origin-Resource-Policy: cross-origin,
# X-Content-Type-Options: nosniff, and the existing Cache-Control intact.
curl -sI https://<your-host>/api/memes/<any-public-slug>/image
```

What to confirm:

- **Baseline on every response:** `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, **no** `X-Powered-By`, a
  `Content-Security-Policy-Report-Only` header and **no** enforcing
  `Content-Security-Policy`.
- **Production only:** `Strict-Transport-Security: max-age=15552000` (NOT
  `includeSubDomains`, NOT `preload`), and `X-Frame-Options: DENY`.
- **Replit dev preview** (env has `REPLIT_DEV_DOMAIN`, not a deploy): **NO**
  `Strict-Transport-Security`, **NO** `X-Frame-Options` — so the Replit webview
  iframe still loads the app. Verify the preview canvas still renders.
- **CORP:** `cross-origin` on `/api/og/*`, `/api/memes/*/image`,
  `/api/memes/templates/*`; `same-origin` on other JSON and on
  `/api/storage/objects/*` (private objects must stay non-embeddable).
- **No regressions:** `no-store` routes (auth/admin/checkout) still send
  `Cache-Control: no-store`; public images still send their existing
  `Cache-Control` + `Access-Control-Allow-Origin: *`; social unfurls (paste a
  public meme link into Slack/iMessage/Twitter) still render the card.

## CSP violation watch (the point of Report-Only)

Because CSP is Report-Only, browsers **log** violations to the devtools console
but do **not** block. Open the site in a browser with the console open and
exercise the OG `?noredirect=1` inspection view (`/api/og/m/<slug>?noredirect=1`)
and a few API-driven pages. Note any `[Report Only] Refused to …` messages. If
there are none after UAT, a follow-up can flip the header name from
`Content-Security-Policy-Report-Only` to `Content-Security-Policy` to enforce.

## Deliberately NOT shipped

- **No enforcing CSP yet** — Report-Only first by design; enforce after UAT
  confirms zero violations.
- **No `includeSubDomains` / `preload` on HSTS** — added only after every
  `*.overhype.me` subdomain is confirmed HTTPS (avoids locking a non-HTTPS
  subdomain out of browsers for the max-age window).
- **No CSP on the SPA document** — the SPA is a separate static origin; its
  document CSP is out of scope for this API-server change.
- **No `report-uri`/`report-to` collector** — violations surface in the browser
  console for UAT; a server-side report sink can be added later if wanted.
