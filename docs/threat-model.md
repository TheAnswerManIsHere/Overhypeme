# Overhype.me threat model

> **Consumed by Codex security review** — this is the threat-model file the
> repository's Codex security-review preferences point at, so every automated
> security pass reviews against the same, deliberately-maintained model instead
> of regenerating one per review. It is also readable context for any agent or
> human doing security work here.
>
> Companion doc: [`docs/ai-context/security-model.md`](ai-context/security-model.md)
> is the **operational spec** — the concrete auth/authorization/payment-trust
> mechanisms as built, with file-level detail. This file is the **model**: what
> we protect, from whom, across which boundaries, and where scrutiny should
> concentrate. When the two disagree, treat it as a finding (drift is a bug).
>
> This repository is **public**. Keep this file to what we protect and how the
> system is shaped — never unpatched-vulnerability specifics, secrets, or
> exploit walkthroughs.

## System overview

Overhype.me is a consumer web app that generates personalized, over-the-top
"facts" about a named person, rendered as shareable meme images and videos.
Users sign in, personalize facts, generate/render memes (AI image + video
generation), share them publicly, and can pay for a Legendary membership via
Stripe. There are **no consumer credits today** — paid rendering is gated by
membership plus server-side budget caps; a separate purchasable-credits
product is future scope only (see `product-brief.md`).

| Component | What it is |
|---|---|
| `artifacts/overhype-me` | React 19 + Vite SPA (same-origin static artifact) |
| `artifacts/api-server` | Express 5 API — auth, memes, rendering, Stripe, admin (`/api`) |
| `lib/db` | PostgreSQL + pgvector via Drizzle ORM |
| `cloudflare/og-router` | Cloudflare worker — OG unfurls + edge caching in front of public assets |
| Vendors | Stripe (billing), OpenAI (enrichment/planning/embeddings), fal.ai (image/video gen + safety scan), Resend (email), hCaptcha, Sentry, Project Arachnid (external CSAM scan), NCMEC ISPWS (legal reporting, staged rollout) |
| Hosting | Replit deployment (`REPLIT_DEPLOYMENT`), Cloudflare in front |

Auth: Google/Apple OAuth + local email/password (bcryptjs), all resolving to
**server-side opaque sessions** (`sid` cookie, Bearer fallback). There is no
client-trusted JWT, and no Replit OIDC integration — Replit is a hosting
target, not an auth provider, here.

## Assets, ranked

1. **Membership/payment integrity** — who is Legendary and the Stripe grant
   path. Money is directly attached; a grant bypass is the worst-case finding.
2. **Admin capability** — admin routes reach password resets, moderation
   overrides, bulk backfills, and engine/pricing config. Admin compromise is
   equivalent to full application compromise.
3. **User accounts and sessions** — credentials, session tokens, password-reset
   flow, OAuth linkage.
4. **Private user content** — private/owner-only memes, uploaded reference
   images of real people's faces (identity-bound rendering), and their derived
   assets. Leakage is both a privacy harm and a product-trust harm.
5. **Secrets** — Stripe keys/webhook secret, `ADMIN_API_KEY`, OpenAI/fal/Resend
   keys, session/DB credentials. Env-only, never committed.
6. **Content/moderation integrity** — the staged moderation pipeline decides
   which submitted facts reach the catalogue under the brand; bypassing it
   activates unreviewed AI content.
7. **Legal/safety moderation evidence** — `quarantined_memes`, `ncmec_reports`,
   and the restricted evidence they hold carry a statutory retention
   requirement and feed the Project Arachnid scan and staged NCMEC ISPWS
   reporting client. This is the single most sensitive stored content in the
   system; unauthorized access or a broken audit trail is a legal-exposure
   event, not just a privacy one.
8. **Availability/cost** — AI render endpoints spend real vendor money per
   call; abuse is a financial DoS even when nothing "breaks."

## Trust boundaries and entry points

- **Internet → API server (`/api`)** — the primary boundary. Anonymous and
  authenticated traffic; CSRF double-submit + origin allowlist on
  cookie-session unsafe methods; narrow DB-backed rate limits on auth
  endpoints plus a coarse per-instance global limiter.
- **Stripe → webhook endpoint** — unauthenticated-by-design entry, trust
  established solely by webhook signature verification (delegated to
  `stripe-replit-sync`). Deliberately exempt from CSRF-origin checks and the
  global limiter; everything it grants must re-verify product identity
  server-side (see payment invariants below).
- **Browser → Cloudflare worker → API** — the worker force-caches any `200`
  whose `Cache-Control` doesn't say `no-store`/`private`; it does **not**
  independently verify visibility, it trusts the origin's header. The
  boundary risk is exactly that trust: an origin handler that accidentally
  omits `no-store` on a private response gets it cached publicly at the edge.
  `Set-Cookie` leaking onto public-asset paths is the same class of risk.
  Client IP trust for rate-limiting is `CF-Connecting-IP` on the endpoints
  that use it (see the rate-limit invariant below), never raw
  `X-Forwarded-For`.
- **API server → AI vendors (OpenAI, fal.ai)** — user-influenced text and
  images flow outward into prompts and come back as content/URLs. Risks:
  prompt-injection steering generation, SSRF-shaped fetches of
  attacker-controlled URLs, and private images leaving through vendor CDNs
  without an ownership check first.
- **Admin session / `ADMIN_API_KEY` → admin routes** — a second, static-secret
  auth path (`requireAdminOrApiKey`) alongside admin sessions. Broadest
  standing credential in the system; scoping/rotating it is a tracked
  deferral.
- **Supply chain → build/runtime** — pnpm workspace with pinned
  payment-critical deps, Dependabot across all workspace manifests,
  `minimumReleaseAge` cooldown. GitHub Actions CI runs repo code on PRs.

## Threat actors

- **Anonymous internet user** — scraping private content, credential stuffing,
  abusing unauthenticated endpoints (OG shells, share surfaces, auth, webhook
  URL), burning paid AI renders.
- **Authenticated free user** — the main adversary for authorization bugs:
  IDOR on memes/objects/videos, membership-grant bypass, tier-gate evasion,
  moderation bypass, abusing another user's identity-bound images.
- **Paying member** — same as above plus refund/downgrade asymmetry games
  (keeping Legendary after cancel).
- **Malicious content author** — weaponizing user-supplied text/images:
  XSS through rendered fact text or OG shells, prompt injection into the
  enrichment/visual pipeline, uploading disallowed imagery to be laundered
  through our renderer.
- **Webhook forger** — crafting unsigned/replayed Stripe events to mint
  membership.
- **Compromised dependency or CI** — supply-chain code execution in build or
  runtime, exfiltrating env secrets.
- **Not modeled**: nation-state attackers, malicious Replit/Cloudflare/Stripe
  insiders, physical access.

## Where scrutiny concentrates (severity guidance)

Findings in these areas warrant **Critical/High** treatment and are worth
reporting even at Medium confidence:

- **Stripe surfaces** — `artifacts/api-server/src/routes/stripe.ts`, webhook
  handling, `artifacts/api-server/src/lib/membershipPricing.ts`, grant/cancel
  symmetry.
- **Auth stack** — `artifacts/api-server/src/middlewares/` (`authMiddleware`,
  `apiKeyAuth`, `tierMiddleware`), `routes/auth.ts`, `routes/localAuth.ts`
  (esp. the fail-closed `dev-admin-login` predicate), session lifecycle,
  password reset.
- **Admin surface** — `routes/admin*.ts`, anything reachable via
  `requireAdminOrApiKey`.
- **Object/media authorization** — storage ACL helpers, meme visibility
  (`canViewMeme`), any handler that resolves a storage path or slug to bytes.
  The historical bug class here is authorize-by-URL-shape instead of
  by-resolved-ownership.
- **Migrations/backfills** (`lib/db`, backfill launchers) — irreversible data
  operations.
- **The Cloudflare worker's cache decisions** — public/private classification.
- **Legal/safety moderation** — `artifacts/api-server/src/lib/moderation/`,
  `quarantined_memes`, `ncmec_reports`, and any surface that reads or exports
  that evidence.

Lower-stakes surfaces (UI components, docs, internal tooling, test helpers)
follow the repo's engineer-to-the-blast-radius principle: report real
vulnerabilities, but default severities down, not up.

## Invariants that must hold

The operational detail lives in
[`security-model.md`](ai-context/security-model.md); a violation of any of
these is a finding regardless of how it arises:

1. **Membership is granted only for a verified, Stripe-product-tagged
   membership purchase** (`overhype_membership=true`), verified at every grant
   surface (checkout, confirm, webhook) against Stripe's own product/line-item
   data — never against client input or self-set mutable metadata.
   Cancellation applies the same filter symmetrically. Fail closed.
2. **Authorization is by resolved ownership/visibility, never URL shape**, and
   routes through the shared helpers (`canAccessObjectEntity`,
   `userCanReadObject`, `canViewMeme`). **On the meme/slug surfaces**, owner-
   only content 404s (not 403s) to non-owners — no existence disclosure. Other
   owner-gated resource endpoints (e.g. `GET /memes/ai-user/image`,
   `uploadPrivateImageToFalCdn`) correctly return 403 on a failed ownership
   check; that's the intended behavior for those, not a violation of this
   invariant.
3. **`req.user` is rebuilt from the DB every request**; role/membership state
   is never trusted from the session blob or the client.
4. **`dev-admin-login` can never be enabled in production** — the
   `isDevAdminLoginEnabled()` predicate fails closed and production env wins
   over the opt-in flag.
5. **Private responses must always send `Cache-Control: no-store` (or
   `private`)** — the worker itself does not verify visibility, it force-
   caches any other `200` (see the trust-boundary note above), so this is an
   origin-side invariant, not a worker guarantee. The worker also strips
   `Set-Cookie` on public-asset paths.
6. **Secrets stay in env, with one tracked exception** — no committed env
   files, DB dumps, or keys; the narrow `.gitignore` rules stay narrow (a
   blanket `*.sql` would hide real migrations). When no
   `STRIPE_WEBHOOK_SECRET_{LIVE,TEST}` is configured for the active mode,
   `stripe-replit-sync` falls back to a managed webhook signing secret stored
   in `stripe._managed_webhooks` — so in that configuration, live webhook
   signing material lives in the database, and a DB/backup exposure carries
   that additional blast radius.
7. **A submitted fact reaches the public catalogue only through the
   moderation pipeline's single activation chokepoint** (`facts.is_active`)
   — no direct toggles around it. This governs fact-catalogue activation
   specifically; authenticated users publishing their own memes directly
   (`isPublic` defaults true in `createMemeRecord`) is normal product
   behavior, not a moderation bypass.
8. **Rate-limit identity uses `CF-Connecting-IP`-derived trust only on the
   endpoints built on `checkSharedRateLimit`** (login, registration) —
   `ipFromRequest()` there deliberately ignores spoofable
   `X-Forwarded-For`. **`createRateLimiter`/`createFactSubmitRateLimiter`
   (AI generation, fact submission) key on `req.ip` instead**, which honors
   `X-Forwarded-For` under `trust proxy`, so those limiters do not carry the
   same spoof-resistance guarantee today — tracked below, not a guarantee to
   assume when reviewing those routes.

## Accepted risks and tracked deferrals

Already known, tracked in
[`deferred-work.md`](engineering/deferred-work.md#security--patching) and the
roadmap — report regressions against them, but they are not new findings:

- `ADMIN_API_KEY` is a single static key with broad admin reach (scoping and
  rotation is the open item).
- CSP is Report-Only pending UAT; HSTS ships without preload/subdomains.
- The global rate limiter is per-instance and in-memory by design (a
  blast-radius backstop, not the narrow control).
- A historical secret exposure was remediated by rotation, not git-history
  purge.
- Admin field-length bounding and backfill `confirm`/`limit` gates are
  deferred follow-ups.
- The AI-generation and fact-submission rate limiters (`createRateLimiter`,
  `createFactSubmitRateLimiter`) key on `req.ip`, not the spoof-resistant
  `CF-Connecting-IP` path the login/registration limiters use — a caller can
  forge `X-Forwarded-For` to work around these two limits specifically.
  Financial-abuse risk (burns paid render spend), not an auth bypass. Not yet
  scheduled; report as a known gap, not a new finding, until it's fixed.

## Maintenance

Update this file when a boundary changes shape: a new entry point (route
group, webhook, worker), a new vendor in the data path, a new asset class
(e.g. user-to-user features), or a change to the auth/payment trust chain.
The quarterly `/security-review` pass should check this file for drift as its
first step.
