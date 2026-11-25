# Plan — Launch Phase 15: Security hardening (Issue #1306)

v3, 2026-11-25 (revised after Astra's assessments 1 and 2: C1, C2, C3, C5, C6, C7). Parent: #628. Scope agreed by David 2026-11-25 (Q2: 1).

```plan-oracle
# Oracle — Launch Phase 15: Security hardening (Issue #1306)

Agreed scope of work, written at the scope-of-work gate and agreed by David 2026-11-25 (scope agreed; Q2: 1). The plan is measured against this.

## Direction served
`docs/ai-context/launch-definition.md` readiness row 5 ("must" before Seed; "green on the current head; Cloudflare re-audited" before Full US) and `docs/plans/PLAN_GET_TO_LAUNCH.md` Phase 15 (v11): *no known high finding on the launch scope before real money.* Phase 15 is in the Seed gate (Phase 18); Phase 20 (Full US) depends on "Phase 15 green on the current head".

## Product intent
1. No known High or Critical security finding on the launch scope exists when Seed opens: `/security-review` plus an offensive lane (Mythos 5.1) run against the code that will launch, every finding verified before it counts and fixed through the ordinary PR loop.
2. Every credential the product uses is rotated before Seed and the old value revoked at the vendor; the app boots and a smoke journey passes on the new set; a request signed with an old Stripe webhook secret is refused.
3. Every Cloudflare setting is audited with David against a committed record (`docs/cloudflare-configuration.md`), account-level Turnstile and the OG worker included; each setting the product depends on is proven by a check measured from outside or on the origin, never read off the dashboard.
4. David keeps an easy way into the admin screens that does not require the standard sign-in, redesigned so it is safe (David, 2026-10-21).
5. Browser-side protections are real: the web app gets its own CSP with a report endpoint (report-only first, enforced once reports are clean) and the API's CSP is enforced; HSTS is sent exactly once, by Cloudflare, and the API's duplicate is dropped.
6. The dependency gate holds: `pnpm audit --prod` shows no High or Critical; `sharp` upgraded (Phase 7's work) is confirmed.
7. Carried items are closed or explicitly accepted, never silently dropped: the tracked `artifacts/overhype-me/.env.local` classified; the Phase 3 audit boundary enforced on production or its non-enforcement accepted in words by David; #757 confirmed fixed (PR #807); session cookie and private-media caching checked on the real origin; the secrets audit done; the old dump's exposure closed by rotation.

## Must not change
- The E2E and acceptance driver's sign-in seam keeps working (CI's `E2E Smoke` stays green).
- Phase 14's geography rule, the `/unavailable` page and the Replit-address redirect keep working.
- No production data is changed by any test; the offensive lane never targets the production origin or real credentials.
- No secret value appears in the repo, a plan, a PR, an issue or chat; rotated values live only in environment settings.
- No other live lane is touched: Phase 7 / PR #1300, Issue #1302 / PR #1303, Issue #1018 (migration slot, moderation), Issue #1030's increment 4 checks.

## Settled decisions (do not reopen)
- `ADMIN_API_KEY` is deleted (#455, David 2026-11-21); its stored secret is removed, not rotated.
- HSTS from Cloudflare alone; preload is Phase 20's question.
- CSP: report-only first, enforced after clean reports.
- The old dump's exposure is closed by rotation, not a history purge (David, 2026-10-12).
- Rotation is David's hands where only he holds the vendor dashboard; Claude writes the ordered checklist with the exact place each key is set; nothing is pasted to Claude.
- The Mythos lane runs against a disposable copy only; findings pass `fp-check` before they count.
- The Cloudflare record is committed; the dashboard stays the source of truth.
- Whether production keeps *any* admin override is Phase 18's decision (David, 2026-10-13); Phase 15 does not pre-empt it.
- Pre-launch: no disclosure gating of security details (David, 2026-10-12); actual secrets are never public.
- One migration in flight at a time across lanes; claim the slot from #1018 first.

## Now / next / never
- **Now (this phase):** everything under Product intent.
- **Final analysis on frozen code (David, 2026-11-25: "Shouldn't the security hardening be done at the end of all the development work so that we're not opening new holes with new code after we've done the analysis?"):** the analysis — `/security-review`, the Mythos lane, the final `pnpm audit --prod` and the rotation — runs once, on the Seed-candidate head, after every other Seed-gating phase has merged. Any change merged after that analysis gets a delta review of what it changed before Seed opens; the result names the commit it covers. Before Full US the same holds on that head (row 5's US column).
- **Sequencing:** the security review and the Mythos lane run late, on the Seed-candidate head; credential rotation runs after every key the launch needs exists (Stripe live, PostHog) and close to Seed; long-lead items (Cloudflare audit, web CSP report-only window, admin-entry redesign, `.env.local` classification, audit-boundary probe) run early.
- **Next (not this phase):** HSTS preload (Phase 20); whether production keeps any admin override (Phase 18); the Cloudflare re-audit before Full US (Phase 20, row 5's US column).
- **Sealed origin (Q2: 1, David 2026-11-25):** placed in Phase 20, before Full US. Phase 15 records the current origin exposure accurately and never describes the origin as sealed.
- **Never:** a git-history purge; testing against production; storing a rotated secret anywhere but environment settings.

## Ceremony tier
Production phase, **sensitive** (auth, admin entry, payments' webhook secret). Full ceremony: plan, plan review, per-increment PRs with Codex review and both assessments, UAT sections where product-visible, `/security-review` at the end.
```

## Problem

Seed is the first time strangers hold accounts and real money moves. Readiness row 5 says that cannot happen while a known High finding is open. Today, on `main` at `f4271ad`:

- the API emits only a **report-only** CSP, and nothing collects the reports (`securityHeaders.ts:101-108`; no `report-uri`/`report-to` anywhere in `artifacts/api-server/src`); two API responses are executable HTML that a strict policy would break — the OAuth popup callback (`routes/auth.ts:473`) and the admin shortcut's GET page;
- the web app is served by `artifacts/overhype-me/server/serve.mjs`, which sets **no** security header at all;
- the API sends its own HSTS header in production (`securityHeaders.ts:93-95`), and since 2026-11-04 Cloudflare may send one as well;
- the dev admin shortcut mints an administrator session from a **GET** link, hands the session token to the page through an inline script (`routes/localAuth.ts:992` onward), and is exempted from the origin check and given permissive CORS while enabled (`app.ts:36-40`, `:219`);
- no credential has been rotated since the old production dump, the rotation set in the launch plan was written on 2026-10-07 and predates fal, Arachnid Shield and Turnstile, and Stripe's start-up can recreate a webhook endpoint and store its new signing secret in a database row (`stripeInit.ts:290`, `findOrCreateManagedWebhook`), and with no secret configured verification falls back to that row (C2);
- nothing on record says what each Cloudflare setting should be, which is how Issue #864 went unseen;
- the safety audit ledger's guards can be dropped by the same database role the application runs as (Phase 3, carried here by name).

## Direction

Readiness row 5, Seed column (`launch-definition.md:265`), and `PLAN_GET_TO_LAUNCH.md` Phase 15. This phase makes row 5 true on the head that opens Seed, and leaves a rule that keeps it true until Full US.

## Product Intent, Must Not Change, Settled Decisions

As the `plan-oracle` block above, verbatim. It is the oracle.

## Repo Context Inspected

`artifacts/api-server/src/lib/securityHeaders.ts`, `app.ts`, `routes/localAuth.ts`, `routes/auth.ts`, `lib/devAdminLogin.ts`, `middlewares/devPreviewGate.ts`, `lib/auth.ts` (session cookie), `lib/stripeRealDriver.ts`, `index.ts` (boot runs `runMigrations()` on line 365); `artifacts/overhype-me/server/serve.mjs`, `src/components/layout/Navbar.tsx`, `src/lib/devPreviewUnlock.ts`, `.replit-artifact/artifact.toml` (both services); `lib/db/src/index.ts` (`ncmecAuditBoundaryStatus`); `cloudflare/og-router/src/maintenance.ts`; `docs/ai-context/decisions.md` (2026-07, 2026-10-14, 2026-10-21 admin-login entries; 2026-10-07 rotation and Mythos; 2026-11-19 sealed origin); `docs/ai-context/membership-entitlements.md:130`; `docs/engineering/ncmec-audit-ledger-hardening.md`; `docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` (audit boundary); Issue #628, Issue #757 and its comment, Issue #1030, Issue #770.

**Affected-surface inventory (oracles run at `f4271ad`):**
- *Every credential the code reads:* discovery, not completeness, is the dotted search `grep -rhoE "process\.env\.[A-Z0-9_]+" artifacts lib scripts cloudflare`; it misses bracketed and computed reads — `grep -rnoE 'process\.env\[[^]]+\]'` adds `SENTRY_API_TOKEN` (`adminOperations.ts:103`), `NCMEC_ISPWS_USERNAME`/`_PASSWORD` (`ncmecClient.ts:61-62`) and Stripe's computed names (`stripeRealDriver.ts:36-90`). The completeness rule is increment 6's reconciliation, not a grep. Names found so far that the 2026-10-07 list lacks: `FAL_KEY`, `FAL_AI_API_KEY`, `FAL_BILLING_API_KEY`, `ARACHNID_SHIELD_USERNAME`/`_PASSWORD`, `TURNSTILE_SECRET_KEY`, `DEV_PREVIEW_KEY`, `RESEND_API_KEY` (beside `_DEV`/`_PROD`), and the frontend's `VITE_POSTHOG_KEY`, `VITE_SENTRY_DSN`, `VITE_TURNSTILE_SITE_KEY`, and the four bracketed names above.
- *Every response that is executable HTML:* the class is "a server response whose body runs script in the browser". Oracle: `git grep -nE "res\.(send|end)\(|text/html|<script" -- artifacts/api-server/src artifacts/overhype-me/server`, then each hit read. Known members: the OAuth popup callback (`routes/auth.ts:473`), the admin shortcut's GET page (`routes/localAuth.ts:992`), the OG shells (`og` CSP class), and the SPA's own `index.html`, which carries inline bootstrap scripts (`artifacts/overhype-me/index.html:21`). Increment 2 runs the oracle over both servers and its PR quotes the output.
- *Every way to become admin without the standard sign-in:* `git grep -nE "createSession\(" -- artifacts/api-server/src` and each caller read for an admin-minting path. Known: `dev-admin-login` only; `ADMIN_API_KEY` is gone (`routes/admin.ts:1284` is a comment).

## Current Behavior

See Problem. Two existing controls this plan builds on rather than replaces: `isDevAdminLoginEnabled()` refuses the shortcut whenever `REPLIT_DEPLOYMENT` is `1` or `NODE_ENV` is `production`, whatever the flag says; and `previewKeyAdmits()` makes a caller through the public `*.replit.dev` preview present `DEV_PREVIEW_KEY` (fail-closed when it is unset), while direct local callers (the acceptance driver, E2E) pass.

## Source-of-Truth Analysis

- **Security headers:** one builder per server. The API keeps `securityHeaders.ts`; the web app gets its own header builder in `serve.mjs`. HSTS has one source, Cloudflare; after increment 3 no server emits it.
- **Cloudflare configuration:** the dashboard is the truth; `docs/cloudflare-configuration.md` is the record a drift is measured against. It is never edited to match a dashboard drift without saying so.
- **Credentials:** environment settings (Replit Secrets per deployment, the Worker's secrets, GitHub Actions secrets) are the only stores. The one exception found is Stripe's managed-webhook row (C2): increment 4 removes it as a store of secrets in this lifecycle — endpoints are provisioned by the operator, secrets live in environment settings only, and nothing at start-up replaces an endpoint or falls back to the row.
- **Who may become admin:** `ADMIN_USER_IDS` and the bootstrap email (`lib/auth.ts`), unchanged. The shortcut grants the bootstrap admin, never a new identity.
- **CSP reports:** structured log lines (and Sentry breadcrumbs, already wired), not a new table.

## Proposed Design

Two blocks, separated by a freeze (David's frozen-code rule).

### Block A — early: the controls (increments 1–5)

Each ships on its own PR as soon as it is ready. All are reviewed again by the final analysis in Block B.

**Increment 1 — Cloudflare audit and record.** Walk every zone section and the two account-level surfaces (Turnstile; the `overhype-og-router` worker, including its daily maintenance schedule and its call to Replit's own address) with David, screen by screen; I lead, he changes. Commit `docs/cloudflare-configuration.md`: each setting's intended value and why, or "default, no dependency". Each setting the product depends on gets an outside-or-origin check, quoted in the record: `server: cloudflare` and `cf-ray` on every serving hostname; `CF-IPCountry` reaching the app; a rate-limit rule refusing past its threshold; a crawler served the OG shell; HSTS counted on the apex; a Turnstile challenge completing on `overhype.me`; the geography rule refusing a blocked country. **The origin's current exposure is recorded as it is** — Replit's address answers directly, redirected to `overhype.me` for browsers, and the Worker's maintenance call relies on that — and sealing it is named as Phase 20's (Q2: 1). Its PR carries the record and a check script, so it runs the standard loop at the `internal` tier.

**Increment 2 — Admin entry made safe, and no executable HTML the CSP cannot cover.** Invariants:
- the shortcut stays impossible in a published deployment by construction (the existing environment test), and keeps the preview key for every non-local caller;
- **no GET request mints a session**: the shortcut's executable GET page is removed; the session is minted only by a POST;
- **the shortcut loses its origin-check exemption and its permissive CORS** (`app.ts:36-40`, `:219`), so a page on another site cannot sign a browser in; local automation (same-origin, direct) and the keyed preview still pass;
- **no server-written page carries a session token**: the SPA calls the POST from the wordmark gesture. Because the Replit canvas iframe drops the cookie, this gated development route returns the session token in its JSON body as an explicit, additive response, and the SPA stores it in the existing Bearer slot (`auth_token`); normal sign-in is unchanged and never returns a token;
- David's gesture is unchanged: triple-tap the wordmark in the preview, land on `/admin`, inside the canvas iframe included;
- the acceptance driver's and E2E's POST seam is unchanged (`E2E Smoke` green).
After it, the executable-HTML oracle over both servers must show exactly: the OAuth popup callback (still needs script — increment 3 gives it its own narrow policy), the OG shells (no script), and the SPA's `index.html` (increment 3's web policy). Anything else is removed or explained in the PR.

**Increment 3 — Browser protections.** (a) The web app's server sends its own CSP, **report-only**, plus the headers it lacks today (frame, referrer, content-type options), production only where the Replit preview needs framing. (b) A report endpoint on the API: unauthenticated by necessity, so body-size-capped, rate-limited, logged as structured lines with no cookie or query string kept; both servers' policies point at it. (c) **The collector is proven before any silence counts**: a deliberate violation from the deployed site is seen arriving. (d) The API gets a third policy class for the OAuth callback document, permitting only the script that page needs (static file or per-response nonce — settled in the build); JSON and OG stay script-free. The API's policies are then **enforced**, after the Google and Apple popup journeys pass under them (fake OAuth in E2E; one real sign-in of each on the development Repl, never production, quoted). (e) HSTS: Cloudflare's contribution is established on a response from the web server, which sends no HSTS of its own today; only then is the API's header removed. Afterwards, on both web and API paths of every serving hostname: zero HSTS headers from either app server (measured on the origin) and exactly one at the edge. (f) **Enforcing the web app's CSP is a small follow-up PR** whose trigger is observable: at least 7 days of deployed traffic since (c), every report in that window either fixed or listed as browser-extension noise in the PR, **and** representative journeys run under the enforced policy on a disposable deploy before the flip — sign-up with the Turnstile challenge, Google and Apple sign-in, onboarding, making a picture, checkout to Stripe and back, the admin screens — plus a deliberately disallowed script shown blocked. Quiet days alone may never exercise those journeys.

**Increment 4 — Small carried items, one PR or a few.**
- The tracked `artifacts/overhype-me/.env.local`: classified, quoted by key name only, in the PR. If it holds only public build values (Astra read it as a public feature flag and an empty AdSense ID — `unable to verify` by me: `.env*` reads are refused in this session; the PR's reviewer or David's read settles it), it is kept and a guard fails CI if a tracked `.env*` file gains a name not on an allowlist. Anything secret-shaped is moved out and rotated in increment 6.
- **Secrets audit:** a secret scan over the full git history and the current tree (`run_secret_scanning` or `gitleaks`, whichever runs here), each hit classified; a live credential found becomes a row in increment 6, never a history rewrite.
- **#757:** confirmed fixed by PR #807 (`createMemeRecord.ts:187` refuses another member's upload; its regression test exists). Confirmation only.
- **Stripe webhook secrets (C2):** each deployed environment and Stripe mode has an explicitly identified endpoint, provisioned by the operator (David, from a step-by-step note), and an environment-held signing secret. With no configured secret, verification **refuses** rather than falling back to the managed row. Start-up never creates, re-enables or replaces an endpoint, so it cannot continue on a stale configured secret; the library stays for sync and signature checking and its tables are not dropped. The environment map keeps the separate development and production test sandboxes (`membership-entitlements.md:130`). This lands now, not at rotation, so rotation is configuration only. It touches Stripe start-up, so it is sensitive-tier and its PR waits until PR #1300 (Phase 7) has merged if that PR touches the same files.
- **The dependency gate:** CI fails on a `pnpm audit --prod` High or Critical (a new required check is a contract change; it goes through the ordinary PR path). `sharp` is read from the lockfile after Phase 7.
- **Session cookie and private media on the real origin:** `sid` measured from outside as set today — `HttpOnly; Secure; SameSite=None; Path=/` — with any narrowing a deliberate, named change rather than an assumption. Private media (C6): using an existing private asset and an existing authorised session, fetch it through Cloudflare and record the successful response's cache policy; then request the identical URL from a separate signed-out client and confirm no private bytes come back. Done separately for a private meme image (`no-store` today) and a private upload (`private, max-age=3600` today); either may be tightened, but only as a named change. Fixtures and failure cases only on disposable resources.
- **The old dump's exposure, closed with evidence:** the exposed sessions were invalidated by Phase 3's fresh database (#770's record, cited), and the affected account's password has been changed since (David confirms in words; no password or hash is shown). Neither a key rotation nor a history scan proves the second.

**Increment 5 — The audit boundary (C3).** 5a first establishes which role the **deployed** application actually connects as and what it may do (Phase 3's probe ran as the operator, so this is not yet known), by a read-only query through the connector. Then it rehearses on a disposable instance with the same platform capabilities (a throwaway Replit database; a local superuser rehearsal alone settles nothing): can the application run under a role that does **not** own the ledger, its guard function or their schemas, across a normal boot (which today runs `runMigrations()` and `ensureSchema()` on the application's connection), a migration, Stripe start-up and a subsequent publish? Result recorded with `ncmecAuditBoundaryStatus()` output quoted. **If yes**, 5b splits the roles on production; a changed deployment or migration operating model returns to David as a concrete plan amendment before 5b starts, and a migration, if needed, claims the slot from #1018. **If no**, 5b does not exist and the remaining exposure — the application's own role can disable the ledger's guards — comes to David under its own question ID, with its practical consequence, to accept in words (Phase 3's record is not acceptance). Either way row 5 does not go green with this item silent.

### The freeze

Block B starts when every other phase that gates Seed (6–14, 16, 17) has merged and the Seed-candidate head is named on #1306. From then on, **any merge to `main` before Seed opens gets a delta security review of exactly what it changed**, recorded on #1306 with the commit it covers. Fixes Block B finds are themselves such merges. Before Full US the rule repeats on that head (row 5's US column, Phase 20).

### Block B — late: the analysis (increments 6–7)

**Increment 6 — Rotation.** First the reconciliation (C5), on the frozen head: runtime credential readers — dotted, bracketed and computed environment reads, the Worker's bindings, the frontend's build inputs, CI secrets and vendor-side configuration — are reconciled against the names actually configured in each store; a configured credential no reader uses is classified for removal, not rotation. The ordered checklist is that reconciliation's output, one row per credential: where it is used (every consumer, including the Worker's copy of `CRON_SECRET` and the frontend keys that need a rebuild and republish), where it is set, whether it has an overlap window (Stripe does), and how revocation of the old value is confirmed at the vendor. David turns each key and pastes nothing to me. `ADMIN_API_KEY`'s stored secret is deleted, not rotated; `DEV_PREVIEW_KEY` is rotated in the Repl only. **Where each proof runs (C7): production is only ever read.** A sign-in creates a session and a webhook delivery writes an audit row, so end-to-end webhook processing is proven on the development Repl against its own sandbox. On production, the proof that the configured secret is the new one is a verification-only run through the connector: it signs a synthetic payload locally and checks it against the configured secret, stopping before sync or any processing, with no new endpoint added. Evidence, kept separate because none proves another: the app boots and a smoke journey passes on the new set; **a freshly timestamped event signed with the old Stripe secret only is refused, and the refusal is a signature failure** (the route also answers 400 for processing failures, so a bare 400 proves nothing; neither a mixed-signature delivery nor a stale replay counts); a fresh event signed with the new secret is accepted; each row's old value confirmed revoked at the vendor, after Stripe's overlap window has closed.

**Increment 7 — Final analysis on the frozen head.** `/security-review` on the launch scope, and the Mythos lane beside it (shape: Q3). The Mythos lane threat-models the launch surface — auth, admin entry, payments and the webhook, uploads, the report endpoint, the Worker's maintenance call — and attempts each attack **against a disposable copy only** (local checkout plus the test database, or a throwaway Repl), never `overhype.me` or a real credential. Every finding passes `fp-check` before it counts; a High or Critical is fixed through the ordinary PR loop (and then falls under the freeze rule); a Medium or lower is filed. Final `pnpm audit --prod` and the `sharp` version read on the same head. The record on #1306 names the commit, the Worker deployment and the Cloudflare record's version it covers. Row 5 goes green only then.

## Data Model and Migration Impact

None in increments 1–4, 6, 7: CSP reports are log lines, not rows. Increment 5b may need ownership changes; if so it is a migration under `overhype-migration-review`, claiming the one-at-a-time slot from #1018 before its push. The Stripe change in increment 4 stops the managed-webhook row being read for verification or written by start-up; it does not alter or drop the table (the library still owns it).

## Runtime Behavior

After Block A: browsers enforce the API's CSP, report on the web app's (then enforce); one HSTS header from Cloudflare; the admin shortcut works as before for David in the preview and not at all in a published deployment; Stripe events verify against environment secrets. After Block B: every credential is new and every old one dead; the analysis record covers the head that opens Seed.

Edge cases the increments must handle: the Replit preview iframe (no `frame-ancestors 'none'` and no frame-deny there); the Bearer fallback in the canvas; the OG router's crawler path (a separate CSP class); a CSP report flood (capped and rate-limited); a rotated frontend key needing a republish before the old one is revoked (the checklist orders it).

## Admin/User UX Impact

None visible to members if it works. David: the wordmark gesture is unchanged. Failure states to avoid, each covered by a test or check: the Google/Apple popup failing to close, the admin shortcut landing on a blank page, a payment webhook refused after rotation.

## Security, Permissions, and Validation

This whole plan. Additional invariants: the report endpoint accepts only the CSP report media types and drops anything over the cap; it never echoes input. No new admin route. No change to `requireAdmin`.

## Testing Plan

- Increment 2: tests that a GET to the shortcut mints no session; that a cross-origin POST is refused now the exemption is gone; that it is refused in a deployment environment whatever the flag; that the POST seam still signs the acceptance driver in; that only this route returns a token in its body. E2E: the wordmark gesture reaches `/admin`; the OAuth popup closes (fake OAuth, as today).
- Increment 3: header tests per route class on both servers; the collector receives a synthetic report and refuses an oversized one; after deploy, the deliberate violation is seen (quoted).
- Increment 4: the tracked-env guard fails on a planted name; CI's audit gate fails on a planted vulnerable version in a throwaway branch run; with no configured webhook secret, verification refuses even when the managed row holds one; start-up with a missing or disabled endpoint does not create one and reports the mode as not set up.
- Increments 1, 3e, 4 (cookie/media), 6: `live` checks from outside or through the connector, read-only on production and quoted; anything stateful runs on the development Repl or a disposable copy.
- UAT: David walks the gesture once in the preview after increment 2 (T-step), and the Cloudflare walk is his session in increment 1. Runner commands per `docs/tests/TESTING.md`.

## Implementation Steps

1 → 2 → 3(a–e) → 4 → 5a, roughly in that order but independent except: 3d needs 2 live; 3e needs 1's HSTS measurement; 3f needs 3c plus 7 days. Then the freeze. Then 6 → 7 (rotation first, so the analysis runs against the configuration that launches), then any fix PRs under the freeze rule.

## Risks and Mitigations

- **CSP breaks something only real traffic hits.** Report-only first, a proven collector, a measured window.
- **Rotation refuses real payments.** C2's change lands early, so no endpoint is silently replaced; old-signature refusal and new-signature acceptance are checked separately.
- **Removing the shortcut's CORS exemption breaks the canvas preview.** The token-in-body response and an E2E run inside an iframe cover it; David's T-step confirms it.
- **Block B slips because Seed-gating phases keep landing.** The freeze waits on a named head; the delta-review rule handles late merges rather than restarting the analysis.
- **The Mythos lane touches something real.** Disposable copy only, stated in the lane's brief, and no production credential in that environment.
- **The audit boundary turns out infeasible.** It goes to David in words; it never stays implicit.

## Questions for David

- **Q3 — Mythos lane shape.** 1) a Claude Code session you switch to Mythos 5.1 with `/model`, which runs the attack lane in its own session; 2) a role dispatched from my session, bound to Mythos in `.agents/machinery.json`. **Recommendation: 1.** A dispatched role inherits the safeguards of the tier that dispatches it, which is exactly what the lane exists to avoid, and a separate session keeps the attack work out of the build session's context.

(Increment 5's possible acceptance question is not asked now: it exists only if the probe says enforcement is infeasible, and then it comes as its own ask with the evidence.)

## Definition of Done

- [ ] `docs/cloudflare-configuration.md` committed; every dependent setting's check quoted; the origin's exposure recorded as unsealed.
- [ ] No GET mints a session; no server page carries a session token; only the OAuth callback runs script, under its own policy; the gesture reaches `/admin` in the preview; a deployment refuses the shortcut; `E2E Smoke` green.
- [ ] API CSP enforced with the OAuth callback's own narrow policy, both popups passing; web CSP enforced after its window and its journey run, a disallowed script shown blocked; collector proven; zero app HSTS headers and exactly one at the edge.
- [ ] `.env.local` classified; secrets scan classified; #757 confirmed; Stripe endpoints operator-provisioned with environment-only secrets and no row fallback; CI audit gate live; cookie and private-media checks quoted; the dump's closure evidenced (sessions, password).
- [ ] Audit boundary enforced on production, or its non-enforcement accepted by David in words.
- [ ] Reconciliation done on the frozen head; every row rotated or removed, old value revoked at the vendor; boot and smoke pass; a fresh old-key Stripe signature refused as a signature failure and a new-key one accepted.
- [ ] `/security-review` and the Mythos lane on the named Seed-candidate head: no open High or Critical; every later merge before Seed delta-reviewed.
