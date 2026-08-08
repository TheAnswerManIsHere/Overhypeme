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
generation), share them publicly, and can pay for a Legendary membership and
render credits via Stripe.

| Component | What it is |
|---|---|
| `artifacts/overhype-me` | React 19 + Vite SPA (same-origin static artifact) |
| `artifacts/api-server` | Express 5 API — auth, memes, rendering, Stripe, admin (`/api`) |
| `lib/db` | PostgreSQL + pgvector via Drizzle ORM |
| `cloudflare/og-router` | Cloudflare worker — OG unfurls + edge caching in front of public assets |
| Vendors | Stripe (billing), OpenAI (enrichment/planning/embeddings), fal.ai (image/video gen + safety scan), Resend (email), hCaptcha, Sentry |
| Hosting | Replit deployment (`REPLIT_DEPLOYMENT`), Cloudflare in front |

Auth: Replit OIDC + Google/Apple OAuth + local email/password (bcryptjs), all
resolving to **server-side opaque sessions** (`sid` cookie, Bearer fallback).
There is no client-trusted JWT.

## Assets, ranked

1. **Membership/payment integrity** — who is Legendary, render-credit balances,
   and the Stripe grant path. Money is directly attached; a grant bypass is the
   worst-case finding.
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
   what content goes public under the brand; bypassing it publishes unreviewed
   AI content.
7. **Availability/cost** — AI render endpoints spend real vendor money per
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
- **Browser → Cloudflare worker → API** — the worker edge-caches public
  assets. The boundary risk is classification: a private response cached as
  public, or `Set-Cookie` leaking onto public-asset paths. Client IP trust is
  `CF-Connecting-IP`, never raw `X-Forwarded-For`.
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
  (keeping Legendary after cancel, credit multiplication).
- **Malicious content author** — weaponizing user-supplied text/images:
  XSS through rendered fact text or OG shells, prompt injection into the
  enrichment/visual pipeline, uploading disallowed imagery to be laundered
  through our renderer.
- **Webhook forger** — crafting unsigned/replayed Stripe events to mint
  membership or credits.
- **Compromised dependency or CI** — supply-chain code execution in build or
  runtime, exfiltrating env secrets.
- **Not modeled**: nation-state attackers, malicious Replit/Cloudflare/Stripe
  insiders, physical access.

## Where scrutiny concentrates (severity guidance)

Findings in these areas warrant **Critical/High** treatment and are worth
reporting even at Medium confidence:

- **Stripe surfaces** — `artifacts/api-server/src/routes/stripe.ts`, webhook
  handling, `artifacts/api-server/src/lib/membershipPricing.ts`, grant/cancel symmetry, credit
  accounting.
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
   `userCanReadObject`, `canViewMeme`). Owner-only content 404s (not 403s) to
   non-owners — no existence disclosure.
3. **`req.user` is rebuilt from the DB every request**; role/membership state
   is never trusted from the session blob or the client.
4. **`dev-admin-login` can never be enabled in production** — the
   `isDevAdminLoginEnabled()` predicate fails closed and production env wins
   over the opt-in flag.
5. **Private responses are never publicly/edge-cached**; the worker
   force-caches only confirmed-public 200s and strips `Set-Cookie` on
   public-asset paths.
6. **Secrets stay in env** — no committed env files, DB dumps, or keys; the
   narrow `.gitignore` rules stay narrow (a blanket `*.sql` would hide real
   migrations).
7. **Content reaches public visibility only through the moderation pipeline's
   single activation chokepoint** — no direct toggles around it.
8. **Rate-limit identity is `CF-Connecting-IP`**, never raw spoofable
   forwarding headers.

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

## Maintenance

Update this file when a boundary changes shape: a new entry point (route
group, webhook, worker), a new vendor in the data path, a new asset class
(e.g. user-to-user features), or a change to the auth/payment trust chain.
The quarterly `/security-review` pass should check this file for drift as its
first step.
