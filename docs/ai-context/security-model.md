# Security model

> Agent-facing operational spec for Overhype.me's security posture — the auth,
> authorization, payment-trust, header, and secrets boundaries. Read this before
> touching auth, object/media serving, Stripe/membership grants, the Express
> middleware stack, or anything that decides who can see or do what.
>
> Established by the security review + remediation slice (findings C1–C10,
> PRs #210, #212, #213, #214, #215, #217, #218, #221). Rationale history for the
> settled calls lives in [`decisions.md`](./decisions.md); the generalizing
> traps live in [`known-failure-patterns.md`](./known-failure-patterns.md).

## dev-admin-login backdoor (C1)

`GET/POST /api/auth/dev-admin-login` (`artifacts/api-server/src/routes/localAuth.ts`)
mints a **bootstrap-admin** session for *any* caller — the review's
highest-severity finding (unauthenticated privilege escalation). It is now
**hardened fail-closed** (PR #221) via one source-of-truth predicate,
`isDevAdminLoginEnabled()` (`devAdminLogin.ts`):

- OFF by default; opt-in only via `ENABLE_DEV_ADMIN_LOGIN=true` for a
  **non-production** preview; and **NEVER** enabled in production even if the
  flag is set (`REPLIT_DEPLOYMENT==="1" || NODE_ENV==="production"` wins).
- When disabled, `handleDevAdminLogin` returns 404 with no session/cookie (the
  authoritative request-time guard); `app.ts` also withholds the permissive
  CORS + the `ORIGIN_EXEMPT_PATHS` entry; and the Navbar triple-tap trigger
  no-ops outside a dev build (`import.meta.env.DEV`).
- The enabled path **rotates** the session (fresh sid, delete old — closes
  fixation) and sanitizes `returnTo` via `safeReturnTo.ts`.

The local dev entrypoint (`artifacts/api-server/scripts/dev-run.sh`) sets the flag, so the Replit
preview and the Playwright e2e admin flows keep working; production
(`pnpm start`, `REPLIT_DEPLOYMENT=1`) can never enable it. See the decision in
[`decisions.md`](./decisions.md).

## Authentication & sessions

- **Server-side opaque session tokens.** A `sid` cookie (with a Bearer-header
  fallback) maps to a `sessions` row; there is no client-trusted JWT. The
  Bearer-vs-cookie precedence gotcha is its own note —
  [`auth-bearer-cookie-fallback.md`](../../.agents/memory/auth-bearer-cookie-fallback.md).
- **`authMiddleware` rebuilds `req.user` from the DB every request** — admin /
  membership / captcha state is never trusted from the session blob alone.
  `req.user.isRealAdmin` / `realUserRole` are the canonical role signals;
  `requireRole` / `requireAdmin` gate on them.
- **Rate limits** (C4) on `POST /auth/local-login` and `/auth/register`, scoped
  by both **`ipFromRequest()`** (CF-Connecting-IP — the raw `X-Forwarded-For` is
  spoofable, so it is NOT used) and normalized email, via the DB-backed
  `checkSharedRateLimit`.
- **Password-reset invalidates every session for that user** (C8) in one indexed
  DELETE (`sessions.userId` = user, plus the legacy `sess -> 'user' ->> 'id'`
  JSON path for rows predating the indexed column). Admin set-password and
  registration enforce an **8-char minimum** (C7).
- **CSRF**: double-submit `csrf_token` cookie + `x-csrf-token` header on
  cookie-session unsafe methods; origin allowlist enforced except for the
  intentional `ORIGIN_EXEMPT_PATHS` (Stripe webhook, Apple form_post callback,
  route-stats, and — for now — dev-admin-login).
- **CodeQL doesn't recognize either hand-rolled control** as satisfying its
  `js/missing-rate-limiting` / `js/missing-token-validation` (CSRF) queries —
  see [`codeql-missing-rate-limiting-csrf-false-positive.md`](../../.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md)
  before treating a new alert on either as a real gap.

## Authorization — objects, media, and memes

The rule that drove the C2/C3 fixes: **authorize by resolved ownership/visibility,
never by URL shape.** Each surface routes through one shared helper so the
decision can't drift (see the "duplicate source of truth" and path-classification
traps in [`known-failure-patterns.md`](./known-failure-patterns.md)).

- **Object ACLs** — `canAccessObjectEntity({ userId, objectFile, READ })` in
  `storage.ts` is the base gate. `userCanReadObject()` layers the legacy
  `upload_image_metadata` owner fallback + ACL heal; `userOwnsAiReferenceImage()`
  gates AI-reference images by `user_ai_images` owner. The video IDOR (C2) was a
  `storagePath → getObjectEntityFile` with no ACL; `uploadPrivateImageToFalCdn`
  now classifies the URL form and authorizes each by its serving route's policy,
  failing closed with 403 **before** any download/fal upload.
- **Meme visibility** — `canViewMeme(meme, req)` = `public OR owner OR admin`
  (`memeVisibility.ts`); a null-creator private meme is admin-only (fail closed).
  **`isPublic === false` means owner-only/secret** (David's product call, C3 —
  see [`decisions.md`](./decisions.md)). Every slug-resolving surface gates on it
  *before* the `deletedAt` 410 branch, so a deleted private meme is a **404**
  (not 410) to non-owners — no existence disclosure. Surfaces: `GET /memes/:slug`
  + `/image`, the OG shell (`og.ts`), share-copy/share-intents, Zazzle
  export/redirect.
- **Non-owner response is 404, not 403** — for owner-only content, so its
  existence stays hidden. Admin-workflow routes may use 403 where existence is
  already known.

## Caching & the Cloudflare worker

Private responses must never be publicly/edge-cached. `setNoStore()` on private
meme images/objects; the `og-router` worker only force-public-caches when
`status === 200 && !isPrivate` and strips `Set-Cookie` on public-asset paths
(a `Set-Cookie` downgrades Cloudflare's `public` cache to `private` and breaks OG
unfurls). See [`architecture-map.md`](./architecture-map.md) for the worker's
place in the request path.

## Payment trust — membership grants (C6)

**Source of truth for "does paying for this grant Legendary?" is the Stripe
*product* metadata tag `overhype_membership=true`** — set in the Stripe
dashboard next to the price, so the catalog can grow (render credits, merch,
tips) without a non-membership purchase minting Legendary. See the decision in
[`decisions.md`](./decisions.md).

The non-obvious part: **the gate lives at the *grant* layer, not just checkout.**
Checkout is not the only door that flips a user to Legendary — the webhook and
the synchronous confirm endpoint are. So `artifacts/api-server/src/lib/membershipPricing.ts` is
single-sourced and enforced at **every** grant surface:

- `POST /stripe/checkout` and subscription `switch-plan`/`switch-preview` reject
  non-membership prices up front.
- The **confirm** endpoint and the **webhook** verify the actual purchased
  product before granting: subscriptions read `sub.items[].price.product`;
  one-time payments read the **Checkout Session's line items** — deliberately
  NOT the mutable `membership=true` PI metadata stamp our own checkout sets,
  because a legacy pre-allowlist session carries that stamp on a non-membership
  price and could otherwise mint Legendary across the deploy (see the
  "trust self-set metadata" trap in
  [`known-failure-patterns.md`](./known-failure-patterns.md)).
- **Cancellation is symmetric with the grant** — `handleSubscriptionCancelled`
  also checks membership, so canceling a future non-membership subscription
  can't downgrade a still-active member. Everything fails closed: anything not
  positively confirmed as a tagged, non-deleted membership product is treated as
  non-membership.

Webhook signature verification is delegated to `stripe-replit-sync` (Replit's
fork of Supabase's stripe-sync-engine); it sits in the payment-critical path and
is pinned exact + Dependabot-monitored.

## HTTP security headers (C5)

`artifacts/api-server/src/lib/securityHeaders.ts`, mounted **first** in `app.ts` so every response
(including the webhook and error paths) carries the baseline. The API server
serves only `/api` JSON, the OG HTML shells, and public image bytes — **the SPA
is a separate, same-origin static artifact** (Replit's application router / the
Vite dev server), so a CSP here governs only this server's responses and can't
break the SPA's inline scripts. Deliberate, env/route-aware choices:

- **CSP is Report-Only first** (flip to enforce after UAT); strict
  `default-src 'none'` for JSON, `img-src` added for OG shells.
- **Frame policy is env-aware** — `X-Frame-Options: DENY` + `frame-ancestors
  'none'` in production, **omitted when `REPLIT_DEV_DOMAIN` is set** because the
  app runs inside the Replit webview iframe in dev.
- **HSTS is production-only**, conservative (no `includeSubDomains`/`preload`
  until every `*.overhype.me` subdomain is confirmed HTTPS).
- **CORP is classified by visibility, not path** — `setPublicCors()`
  (`cacheHeaders.ts`) sets `cross-origin` and is called *only* after a response
  is confirmed public; private responses call `setNoStore` and keep helmet's
  `same-origin`. This is why the middleware itself never guesses CORP from a URL.
- **COOP disabled** (would sever an OAuth-popup `window.opener`); COEP off.
- Canonical prod predicate: `REPLIT_DEPLOYMENT === "1" || NODE_ENV ===
  "production"` (mirrors `siteUrl.ts`).

## Secrets & supply chain (C10)

- **Never commit env files or DB dumps.** `.gitignore` carries narrow rules
  (`/prod-backup-*.sql`, `/backups/`, `*.dump`, `.env`/`.env.*` with `*.example`
  allowed) — deliberately **not** a blanket `*.sql`, which would hide the 87 real
  Drizzle migrations. A prod `pg_dump` was committed in #165 and removed from
  HEAD in #217; the historical blob and rotation of what it exposed are handled
  out-of-band (rotation, not history-purge, is the real mitigation).
- **Dependabot** (`.github/dependabot.yml`) covers the whole pnpm workspace via
  `directories` globs (`directory: "/"` alone misses every workspace manifest —
  see [`dependabot-pnpm-workspace-directories.md`](../../.agents/memory/dependabot-pnpm-workspace-directories.md)).

## Admin surface (C9)

Admin handlers sit behind `requireAdmin`, except 9 behind `requireAdminOrApiKey`
— which accepts a **single static `ADMIN_API_KEY`** header *or* an admin session.
That static key is the broadest admin auth surface (it reaches `set-password`
and the bulk backfill launchers); **scoping/rotating it is an open item**
([`current-roadmap.md`](./current-roadmap.md)). Input validation uses the repo's
`z.object` + `safeParse` idiom (from `routes/reviews.ts`); the sweep hardened the
genuinely-risky inputs (a **path-traversal** in the video-style preview-gif
storage key — sanitized via `safeStylePreviewKey`, not rejected, so legacy ids
aren't orphaned; bulk-import size caps; the API-key `set-password` email). Lower-
risk field-length tidying and `confirm`/`limit` gates on the backfill launchers
are deferred follow-ups (the latter would break existing API-key automation).

## Deliberately out of scope / deferred

Enumerated so a later reader knows what this review did *not* do: a full auth
rewrite, live pentest, Cloudflare WAF/dashboard actions, CSP *enforcement*
(report-only first), HSTS preload/subdomains, the `ADMIN_API_KEY` scoping, the
git-history purge, and the admin field-bounding follow-up. The live list of
these deferrals is tracked in
[`docs/engineering/deferred-work.md`](../engineering/deferred-work.md#security--patching). (The C1 dev-admin-login hardening — deferred when this doc was
first written — shipped in PR #221.)
