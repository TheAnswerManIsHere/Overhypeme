# Cloudflare configuration — the record

What Cloudflare is set to for `overhype.me`, why, and how each setting the
product depends on was proven. Written in launch Phase 15, increment 1
(Issue #1306; plan `docs/plans/PLAN_PHASE15_SECURITY_HARDENING.md`, Block A).
**The dashboard stays the source of truth**; this file is the record it is
checked against.

- **Audited:** 2026-11-26, read in full through Cloudflare's API with a
  read-only token, then changed through the API (the changes are listed
  under *Changes made on 2026-11-26*).
- **Re-check:** `node scripts/check-cloudflare.mjs` from anywhere for the
  outside checks; with a Cloudflare API token it also compares the settings,
  rules, worker and Web Analytics site against this record. In a Claude cloud
  session with the token saved as a network secret:
  `NODE_USE_ENV_PROXY=1 CLOUDFLARE_API_TOKEN=proxy-injected node scripts/check-cloudflare.mjs`.
  Add `--burst` to test the rate limit live: paced GETs to a render path until
  Cloudflare refuses, then one request per path spelling inside the block. It
  locks the caller out of the render paths for 10 seconds, and it writes nothing
  to production (a GET reaches no render handler). A failure means Cloudflare drifted or this
  file is stale; fix whichever is wrong.
- **Next audit:** before Full US (Phase 20, launch-definition readiness row 5).

Each section lists the settings that matter. **"Default, no dependency"**
means the setting is at Cloudflare's default and nothing in the product relies
on its value.

## Account

| Item | Value | Why |
| --- | --- | --- |
| Account | `975a348dc75f2f3849507caefab3862e`, one member (David, Super Administrator) | — |
| Two-factor sign-in | On (`/user` → `two_factor_authentication_enabled: true`) | Whoever holds the account controls the site, its traffic and its email. |
| Plan | **Free Website** | It limits what can be configured: rate limiting is 1 rule, a 10-second period and a 10-second block. |

## Zone overview

`overhype.me`, zone `759edc0f6744c981b16d648f1a9ffa12`: status `active`, type
`full` (Cloudflare is the authoritative DNS); name servers
`kami.ns.cloudflare.com` and `miles.ns.cloudflare.com`.

## DNS

| Record | Content | Proxied | Why |
| --- | --- | --- | --- |
| `A overhype.me` | `34.111.179.208` | yes | Replit's deployment. Proxied, so visitors reach Cloudflare's addresses, never this one. |
| `CNAME www` | `overhype.me` | yes | Redirected to the apex by a rule (below). |
| `CNAME _domainconnect` | `_domainconnect.gd.domaincontrol.com` | yes | Left over from the registrar (GoDaddy's Domain Connect). No dependency. |
| `MX overhype.me` ×3 | `route1/2/3.mx.cloudflare.net` | no | Cloudflare Email Routing (below). |
| `MX send` | `feedback-smtp.us-east-1.amazonses.com` | no | Resend's bounce handling for outgoing mail. |
| `TXT overhype.me` | SPF `v=spf1 include:_spf.mx.cloudflare.net include:resend.com include:amazonses.com ~all` | no | Allows Cloudflare's forwarding and Resend to send as the domain. |
| `TXT _dmarc` | `v=DMARC1; p=reject; adkim=s; aspf=r; rua=mailto:dmarc_rua@overhype.me;` | no | Mail failing alignment is rejected. |
| `TXT cf2024-1._domainkey`, `resend._domainkey` | DKIM public keys | no | Signing for Email Routing and Resend. |
| `TXT send` | `v=spf1 include:dc-fd741b8612._spfm.send.overhype.me ~all` | no | Resend's sending subdomain. |
| `TXT overhype.me` | `replit-verify=…`, `google-site-verification=…`, `projectarachnid-verification=…` | no | Ownership proofs for Replit (custom domain), Google Search Console and Project Arachnid. |

- **DNSSEC: disabled.** Recorded as a gap; see *Gaps*.
- **CAA: none.** Recorded as a gap; see *Gaps*.

## SSL/TLS

| Setting | Value | Why |
| --- | --- | --- |
| Encryption mode (`ssl`) | **Full (strict)** | Cloudflare checks Replit's certificate. |
| Edge certificate | Universal, Let's Encrypt, `overhype.me` and `*.overhype.me`, 90 days, active | — |
| Minimum TLS version | **1.2** (changed from 1.0) | TLS 1.0 and 1.1 are obsolete; only very old browsers used them. |
| TLS 1.3 | on | — |
| Always Use HTTPS | **on** (changed from off) | Cloudflare redirects plain http itself, not relying on the origin to do it. |
| Automatic HTTPS Rewrites | on | Default, no dependency. |
| HSTS (`security_header`) | **off** | Replit's front end already sends `max-age=63072000; includeSubDomains` on every response, measured on `overhypeme.replit.app` itself. Turning Cloudflare's on would send two. See *HSTS* below. |
| Authenticated origin pulls | off | Recorded with the origin exposure; Phase 20's. |
| 0-RTT | off | Default, no dependency. |
| Opportunistic encryption, post-quantum key exchange, ECH | on | Default, no dependency. |

### HSTS

Measured 2026-11-26 (curl, through Cloudflare):

```
overhype.me /            strict-transport-security: max-age=63072000; includeSubDomains
overhype.me /api/healthz strict-transport-security: max-age=63072000; includeSubDomains
                         strict-transport-security: max-age=15552000
overhypeme.replit.app /  strict-transport-security: max-age=63072000; includeSubDomains   (server: Google Frontend)
```

The two-year header is **Replit's**, not Cloudflare's. The second header on
the API path is the API's own (helmet's default), which increment 3e removes.
The plan's settled decision reads "HSTS from Cloudflare alone", which assumed
the edge's header was Cloudflare's. Increment 3e takes that to David with the
measurement: keep Replit's as the one header, or have Cloudflare strip the
origin's and send its own.

## Security

| Setting | Value | Why |
| --- | --- | --- |
| Custom WAF rules | **none** | The country rule is a redirect rule (below), not a WAF rule. |
| Managed rules | Cloudflare Managed Free Ruleset, Normalization, DDoS L7 (all Cloudflare-managed) | Default, no dependency. |
| Rate limiting rules | **one: `RL-RENDER burst`** (created 2026-11-26) | See *Rate limiting*. |
| Security level | medium | Default, no dependency. |
| Browser Integrity Check | on | Default. Stripe's webhook calls send a normal user agent, so they pass. |
| Challenge passage | 1800 s | Default, no dependency. |
| Bot Fight Mode | off | Turnstile does the human check where one is needed; Bot Fight Mode would challenge Stripe's and the crawlers' requests. |
| AI crawlers | training: disallow; Cloudflare-managed `robots.txt` with content signals (`search=yes,ai-train=no,use=reference`) | No dependency in the product. |
| IP access rules, user-agent rules | none | — |

### Rate limiting

One rule, all the Free plan allows (`http_ratelimit` phase, rule
`d322a6ccefd341eca0f048444fafe352`):

- **Expression:** `(lower(http.request.uri.path) in {"/api/render-preview" "/api/render-preview/" "/api/render-download" "/api/render-download/"})`
- **Why every spelling:** the API's router is case-insensitive and ignores a trailing slash, so `/api/Render-Download/` reaches the same handler. (Capitals in the prefix, `/API/…`, do not: Replit sends `/api` to the API by a case-sensitive prefix, and `/API/…` lands on the web app.) The first version of the rule matched only the two exact paths; it was widened the same day (PR #1329's review).
- **Counting:** per IP (and Cloudflare data centre). **10 requests per 10 seconds**, then **block for 10 seconds**.
- **Response:** Cloudflare's own 429 (`error code: 1015`, `retry-after: 10`). The Free plan cannot set a custom body.

The hourly rules `docs/cloudflare-rate-limits.md` used to describe (30/hour
and 10/hour) **were never created**: the phase had no entrypoint ruleset when
it was read on 2026-11-26. The Free plan could not have held them. This rule is
a burst cap only. **Next:** a per-account limit in the app for the two
render endpoints (both are signed-in only), recorded on Issue #1306.

## Rules

Dynamic redirect rules (`http_request_dynamic_redirect` phase), in order:

1. **`Redirect from WWW to root`**: `(http.request.full_uri wildcard r"https://www.*")` → 301 to the same path on `https://overhype.me`. (The query string is not preserved.)
2. **`Block Unapproved Countries`**, the geography rule (Phase 14, increment 3; `decisions.md`, 2026-11-19): `ip.src.country` in the EEA (the 27 EU states, their outermost regions with their own codes `AX GF GP MF MQ RE YT`, and `IS LI NO`), `GB`, and `CU IR KP`, or Ukraine regions `43 40 14 09` (Crimea, Sevastopol, Donetsk, Luhansk), and the path not starting `/unavailable` → **302 to `https://overhype.me/unavailable`**. It applies to every path, the API included.

- Page rules, configuration rules, cache rules, origin rules, transform rules: none.

## Caching and speed

| Setting | Value | Why |
| --- | --- | --- |
| Cache level | aggressive (standard) | Default. API responses are `private`; meme images and OG shells are cached by the worker's cookie strip (below). |
| Browser cache TTL | 14400 s | Default, no dependency. |
| Rocket Loader | off | It rewrites script tags; the web CSP would refuse it. |
| Development mode | off | — |
| Brotli, HTTP/2, HTTP/3 | on | Default, no dependency. |
| Minify, Polish, Mirage, Early Hints | off | Default, no dependency. |

## Network

| Setting | Value | Why |
| --- | --- | --- |
| IP geolocation (`CF-IPCountry`) | **on** | The onboarding screen pre-ticks the marketing box only for a visitor Cloudflare places in the US (`artifacts/api-server/src/routes/onboarding.ts`, `marketingDefaultFor`). |
| WebSockets | on | Default, no dependency. |
| IPv6 | on | — |
| Pseudo IPv4, True-Client-IP | off | Default, no dependency. The app reads `CF-Connecting-IP` (`docs/cloudflare-rate-limits.md`). |
| Max upload | 100 MB | Default; above the app's own upload limits. |
| Proxy read timeout | 125 s | Cloudflare's wait for the origin. The daily maintenance call avoids it (below). |

## Scrape Shield

| Setting | Value | Why |
| --- | --- | --- |
| Email Address Obfuscation | **off** (changed from on) | It injects a script into pages with an address in them, which the web CSP would refuse once enforced (increment 3f). |
| Server-side excludes | on | Default, no dependency. |
| Hotlink protection | off | Shared meme images must load anywhere. |

## Workers: `overhype-og-router`

Source `cloudflare/og-router/`, last deployed 2026-11-20.

- **Routes:** `overhype.me/m/*` (a crawler gets the OG shell from `/api/og/m/:slug`, a person gets the app), `overhype.me/api/memes/*` and `overhype.me/api/og/*` (strip Google's `GAESA` cookie so the edge can cache images and shells; `docs/cloudflare-gaesa-og-fix.md`).
- **Schedule:** `23 9 * * *`. Once a day the worker POSTs `MAINTENANCE_URL` = `https://overhypeme.replit.app/api/jobs/maintenance` with the `CRON_SECRET` secret in `x-cron-secret`. It calls Replit's own address on purpose, so the country rule and Cloudflare's origin timeout do not apply. That relies on the origin exposure below.
- **Bindings:** `CRON_SECRET` (secret text), `MAINTENANCE_URL` (plain text).
- **Observability:** logs on and persisted. Query strings are not redacted; the worker's routes carry no secrets in them.

## Turnstile (account level)

Widget **"Overhype.me"**: mode **managed**, domains `overhype.me`,
`www.overhype.me` and the development Repl's address
(`1f4dceef-…spock.replit.dev`), so the dev preview can show the challenge.
Pre-clearance off, Bot Fight Mode off. Used on onboarding, support, fact
submission, comments and the share dialog
(`artifacts/overhype-me/src/components/ui/Turnstile.tsx`).

## Web Analytics (account level)

Site `354a9ae61c79431595900785ad2c27ae` for `overhype.me`: **automatic
setup off and the site disabled** (changed 2026-11-26). Until then it injected
`static.cloudflareinsights.com/beacon.min.js` into every page, the one script
the web CSP reported. Nothing depends on it: PostHog and Google Analytics
measure traffic, and the privacy policy does not list it.

## Email Routing

On, status `ready`. Mail to `support@`, `privacy@`, `legal@`, `copyright@`
and `dmarc_rua@overhype.me` is forwarded, each to one verified destination
(not recorded here). The catch-all rule exists and is **disabled**, so other
addresses are rejected. Replies go out through Resend (DNS above).

## Zaraz

Configured with **no tools**, so nothing is injected. No dependency.

## The origin's exposure, recorded as it is

Replit's own address, `overhypeme.replit.app`, answers directly, without
Cloudflare:

```
https://overhypeme.replit.app/            HTTP/2 308  location: https://overhype.me/   server: Google Frontend
https://overhypeme.replit.app/api/healthz HTTP/2 200                                   server: Google Frontend
```

A browser that lands there is sent to `overhype.me`. **The API answers
directly**, without the country rule, the rate limit, or Cloudflare's other
protections, and the worker's daily maintenance call relies on that. The
origin is **not sealed**. Sealing it is Phase 20's (Q2: 1).

## Outside-or-origin checks, quoted

Each setting the product depends on, proven from outside or on the origin
(2026-11-26, from a US address unless noted):

| Dependency | Check | Result |
| --- | --- | --- |
| Every serving hostname goes through Cloudflare | `curl -sI` on `overhype.me/`, `overhype.me/api/healthz`, `www.overhype.me/` | `server: cloudflare` and a `cf-ray` on each; `www` → `301 location: https://overhype.me/…` |
| Plain http is redirected at the edge | `curl -sI http://overhype.me/` | `HTTP/1.1 301`, `location: https://overhype.me/`, `server: cloudflare` |
| TLS 1.1 refused | `curl --tls-max 1.1 https://overhype.me/` | exit 35 (handshake refused); with TLS 1.2: 200 |
| `CF-IPCountry` reaches the app | the edge's own view: `/cdn-cgi/trace` → `loc=US`; at the app, a signed-in `GET /api/auth/onboarding` reading `marketingDefault: true` from the US | edge proven; the app read is part of David's signed-in walk on the real origin (Issue #1306) |
| The rate-limit rule refuses past its threshold, on every path spelling | `node scripts/check-cloudflare.mjs --burst`: GETs to `/api/render-download` every 250 ms until refused, then `/api/render-preview`, `/api/render-preview/`, `/api/render-download`, `/api/render-download/`, `/api/Render-Download` inside the block | each refused with Cloudflare's 429 (`retry-after: 10`; body `error code: 1015` to curl, Cloudflare's error-1015 page to Node); `check:cloudflare: Cloudflare matches docs/cloudflare-configuration.md.` |
| A crawler is served the OG shell | `curl -A "Twitterbot/1.0" https://overhype.me/m/<slug>` | the shell (`<meta property="og:site_name" …>`); a Chrome user agent gets the app (`<title>Overhype.me</title>`, 200) |
| HSTS counted on the apex | see *HSTS* | web path 1 (Replit's); API path 2 until 3e |
| A Turnstile challenge completes on `overhype.me` | the support page in a real browser | David's browser; a headless browser here cannot reach `challenges.cloudflare.com` (Issue #1306) |
| The geography rule refuses a blocked country | `https://overhype.me/?geo-probe=gb` fetched from a UK address (Firecrawl, `location: GB`) | final URL `https://overhype.me/unavailable`, 200, "Overhype.me isn't available where you are" |
| No Cloudflare script in the page | a browser-like `GET /`, `/unavailable`, `/privacy` | no `cloudflareinsights` and no `email-decode` (after the changes) |

## Changes made on 2026-11-26

Each was made through the API, verified by reading it back and from outside,
and is undone by setting the old value again.

| Change | Before | After |
| --- | --- | --- |
| Web Analytics beacon | auto-install on, site enabled | auto-install off, site disabled |
| Minimum TLS version | 1.0 | 1.2 |
| Always Use HTTPS | off | on |
| Email Address Obfuscation | on | off |
| Rate limiting | no rule | `RL-RENDER burst` |

## Gaps, recorded and not changed

- **DNSSEC is off.** Turning it on needs a DS record at the registrar, and a
  mistake there takes the whole domain offline. Phase 20's origin work.
- **No CAA record.** A record naming only Cloudflare's certificate authorities
  could block Replit's own certificate for the domain. Phase 20, with the origin.
- **The origin is not sealed** (above). Phase 20.
- **The render endpoints have only a burst cap**, not an hourly one. Next: an
  app-side per-account limit.
