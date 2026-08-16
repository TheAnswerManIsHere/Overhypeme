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
  before treating a new alert on either as a real gap. **The `js/missing-rate-limiting`
  triage rule:** a route with a workload-appropriate **narrow** control CodeQL
  merely fails to recognize (checked against this repo's established
  patterns) is the false-positive case: fix by confirming the control, not by
  adding a redundant one. A route with **no narrow control** — including one
  that relies on the global rate-limiter backstop below alone — is never
  eligible for that class on consistency grounds; matching an unprotected
  sibling is not evidence of safety, since the siblings may just share the
  same latent gap, and the coarse per-instance backstop existing on every
  non-exempt `/api` route (two route/handler exemptions below) doesn't settle
  whether *this* route's own workload is cheap to hit repeatedly. Route it to
  a real cost/abuse assessment (or add a narrow control, if cheap and
  pattern-matched) instead. **This narrow-control test is specific to
  `js/missing-rate-limiting`** — a `js/missing-token-validation` (CSRF) alert
  is checked against the global double-submit CSRF middleware above instead,
  since CSRF is intentionally enforced globally rather than per-route, so the
  absence of a *narrow* control on a CSRF-flagged route is expected, not a
  signal to escalate. That memory doc also covers the **re-attribution trap**:
  restructuring `app.ts` (e.g. wrapping it in a
  factory function) shifts every line number, and GitHub's diff-based
  code-scanning UI can re-flag a byte-identical pre-existing alert as "new in
  this PR." Byte-identical flagged lines are necessary but **not sufficient**
  to dismiss it — in Express the *relative order* middleware registers in is
  often the actual security behavior, so also confirm the surrounding
  `app.use(...)` sequence is unchanged, not just the flagged line's content.
  `git diff origin/main -- artifacts/api-server/src/app.ts` is the starting
  check (there is no `app.ts` at the repo root; a bare-path diff silently
  produces an empty, falsely-reassuring result) — see the memory doc for the
  full two-part rule before assuming a fresh alert on a restructuring-only PR
  is real.
- **Global rate-limiter backstop** (`artifacts/api-server/src/lib/rateLimit.ts`'s
  `createGlobalLimiter`, mounted at `app.use("/api", ...)`): a coarse,
  `express-rate-limit`-backed, per-instance, per-IP ceiling covering **every**
  `/api` route — the first *application-level* rate limiting for
  approximately 18 of this repo's 31 route files (an upper-bound estimate,
  not an exhaustive count — see the 2026-08-04 `decisions.md` entry's
  "accepted trade-off" note for the full breakdown and why the exact number
  can only shrink, not grow, on a future audit, and has already
  been revised across five Codex review rounds). This exists specifically to satisfy CodeQL's
  `js/missing-rate-limiting` query (which only recognizes a hardcoded list of
  npm packages, not `checkSharedRateLimit`) and does **not** replace or change
  any narrow, DB-backed limiter above — it is a blast-radius backstop layered
  on top. Exactly two **route/handler** exemptions (`/api/healthz`, the
  Stripe webhook); backed by a bounded in-memory store (`BoundedMemoryStore`,
  capped and FIFO-evicted, not `checkSharedRateLimit`'s DB table), so it is
  **per-instance**, not fleet-wide. **Separately, CORS preflight (`OPTIONS`)
  requests through the *global* CORS middleware bypass the limiter ONLY for
  a no-origin or allowed-origin request** — `cors()` is registered in
  `app.ts` before
  `createGlobalLimiter()` mounts, with no `preflightContinue` override, so an
  allowed preflight is answered and ends there. A **rejected-origin**
  preflight behaves differently: `cors@2.8.6`'s dynamic-origin callback path
  calls `next(err2)` (with no error) when the origin callback returns a
  falsy value, which does **not** short-circuit the response — the request
  falls through past `cors()` unanswered and continues into
  `createGlobalLimiter`, so rejected-origin preflights ARE metered (verified
  against the installed package's source, not assumed). Don't treat "OPTIONS
  bypasses the limiter" as universally true — it depends on the origin
  decision. **This qualification is scoped to the global CORS middleware
  specifically — `/api/auth/dev-admin-login` has its own, more permissive
  bypass** when `ENABLE_DEV_ADMIN_LOGIN=true` (never in production):
  `app.ts` mounts `cors({ origin: true, credentials: true })` on that one
  path, before both the global `cors()` and `createGlobalLimiter()`, and
  `cors@2.8.6` answers OPTIONS preflights by default when
  `preflightContinue` is unset — so a dev-admin-login preflight is answered
  (and unmetered) regardless of origin, allowed or rejected, in a
  non-production preview. See the 2026-08-04 `decisions.md` entry for why an in-memory
  store was chosen over a
  DB-backed one.

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
  can't downgrade a still-active member. Everything fails closed: a
  *settled* negative — the product list was fully enumerated and none of them
  is a tagged, non-deleted membership product — is treated as non-membership.
  An *unobservable* result (a pagination or retrieval failure mid-check) is
  not decided against the customer; it retries instead of settling false, so
  a transient failure can't silently strip access from a real member.
- **The display/selection layer must apply the same filter, even though it
  isn't a grant surface.** `/api/stripe/plans` returns every active product in
  the catalog (render credits, merch, tips, ...), not just membership ones —
  so code that turns that list into "which plan should the customer see?"
  (the pricing page's `selectPlanPrices()` in
  `artifacts/overhype-me/src/pages/pricingPlans.ts`) filters to
  `overhype_membership=true` products before picking a price. Skipping this
  filter here isn't a grant-bypass risk (checkout still rejects a
  non-membership price), but it does mean the pricing page could advertise a
  plan checkout will then refuse — caught in Codex review on PR #255. See the
  decision in
  [`decisions.md`](./decisions.md#2026-07-25--stripe-plan-selection-classifies-by-each-prices-own-recurring-field-and-only-from-membership-tagged-products).

Webhook signature verification is delegated to `stripe-replit-sync` (Replit's
fork of Supabase's stripe-sync-engine); it sits in the payment-critical path and
is pinned exact + Dependabot-monitored.

## Generation spend enforcement

Distinct from the membership-grant trust above: this is the per-user **spend
ceiling** on paid generation (fal.ai image and video calls), and it is a
fail-closed control, not just a budgeting nicety — an unbounded generation path
spends real money with no upper limit.

**Two independent layers, and changes must not update only one.**
`checkBudget` (`budgetGate.ts`) is the **durable, ledger-backed per-user
ceiling** and is what the rest of this section describes. `enforceGovernance`
(`resourceGovernance.ts`) runs *first* on the synchronous image and video routes
(`routes/memes.ts`, `routes/videos.ts`) and independently rejects on
`DAILY_SPEND_CAP_EXCEEDED` / `MONTHLY_SPEND_CAP_EXCEEDED` plus request-rate,
concurrency, duration and payload caps. Its accounting is **in-memory and
per-process**, so like the global rate limiter it is a per-instance backstop
rather than a fleet-wide guarantee — see the
[decision record](./decisions.md) for that layer.

`checkBudget`'s contract, established across #409 / PR #443 / PR #474:

- **It denies when it cannot answer.** A config-read, tier-lookup, or ledger-sum
  failure throws `BudgetGateError` rather than returning `{allowed: true}`. That
  error is deliberately distinct from `BudgetExceededError`: the first is a
  retry-able 503 ("we could not tell"), the second a 429 that sends the user to
  the upgrade path ("you are over"). **Never conflate them** — telling someone
  hitting a transient database error to go buy more credit is the failure this
  split exists to prevent.
- **The gate's input is part of the gate.** Resolving the fal price can fail, and
  a call site that skips the check when it does leaves the ceiling unenforced at
  precisely the wrong moment. Every call site therefore either degrades to a
  defensible estimate and still gates, or denies. See the
  [precondition failure pattern](./known-failure-patterns.md) for the general
  shape. `scripts/check-budget-gate-unconditional.mjs` is a CI guard that walks
  the TypeScript AST and fails the build if a `checkBudget` call is ever made
  conditional on price resolution again; its known limits are documented in its
  own header, and it is a backstop rather than the control.
- **The fallback estimate prefers the persisted `engines` row over the code
  catalogue, but does use the catalogue as a fallback.** Precedence is
  persisted-exact → catalogue-exact → the maximum across both sources.
  The persisted row wins because `estimatedCostUsdPerCall` is admin-editable and
  `engines/reconcile.ts` strips `ADMIN_EDITABLE_FIELDS` from its boot update
  precisely so operator edits survive; the catalogue still supplies a value when
  the table legitimately has no row for that model, which happens (a seeded test
  database has far fewer rows than the catalogue). A model-specific figure always
  beats an aggregate, so an incomplete table cannot lower the floor. If the
  `engines` read itself **fails**, the gate denies rather than falling back —
  when the persisted values are unknown, no catalogue-derived number provably
  avoids undercutting them.
- **The admin exemption precedes the *cost* resolution and the config/ledger
  reads — not every fallible read.** `checkBudget` must first read the user row
  to know whether the caller is an admin at all, and that read sits inside the
  same fail-closed catch, so a `users`-table failure denies an admin like anyone
  else. What the exemption does guarantee is that an admin never triggers, or is
  denied by, the *proposed-cost* lookup or the downstream config/ledger reads: a
  caller whose cost is itself fallible to determine passes a **thunk**, which
  `checkBudget` invokes only after the exemption.
- **The ledger cannot tell you how a figure was arrived at.** Some rows are
  computed from fal's published rate for that endpoint; others from an
  operator-configured estimate. No column distinguishes them, and no row is a
  reconciled provider charge. Consequences for this gate: an unpriced image
  generation is not recorded at all, so across a sustained pricing outage its
  recorded spend stops growing and the ceiling is measured against a stale
  total. Which writers produce which kind of figure is **not** stated here —
  see [`deferred-work.md`](../engineering/deferred-work.md), and derive it from
  the code rather than from either doc, because that breakdown was mis-stated
  three times in one review.

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
