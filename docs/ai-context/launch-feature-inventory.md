# Launch feature inventory — the per-item decisions behind the launch definition

> Every feature the product had on `main` at `58f38c8` (2026-10-05), walked
> item by item with David across eleven journeys, with his decision on each.
> This is the record the [launch definition](./launch-definition.md) summarises
> and a launch phase plan reads when it needs the decision on a specific
> item. Decisions here are settled; a phase that wants to change one brings it
> to David and records the change in [`decisions.md`](./decisions.md). The
> *Recommendation* column is what was proposed before David decided; the
> **Decisions** block under each journey is what he decided.
>
> Source: a read-only sweep of the product docs, the Manual, every route and
> page, and the UAT record. 222 items across 11 journeys.

Legend for recommendations: **ship** · **ship, verify** (works on paper, no
evidence it works) · **fix for launch** · **cut** (remove entry points and
routes, delete, git keeps it) · **your call**.

## Journey A — Anonymous visitor (27 items)

| # | Feature | What it does | Evidence | Recommendation |
|---|---|---|---|---|
| A1 | Home, cold state | Teaser with a demo name until a name is typed | doc | ship, verify |
| A2 | Name personalisation | Typing a name rewrites every fact; no account | grammar tests strong; manual ch.1 | ship (core) |
| A3 | Pronoun sheet + AI pronoun suggestion | Collects or infers pronouns before warm state; `POST /ai/suggest-pronouns` is a model call per anonymous visitor | code | ship, verify the AI call is rate-limited and cheap |
| A4 | Share-link personalisation (`?displayName=&pronouns=`) | A shared link re-personalises for the recipient | doc | ship (core to the loop) |
| A5 | Hero billboard + Next Random Fact | Weighted-random top-50 pick | doc | ship, verify |
| A6 | Fact feed grid | 20 facts, newest/top, hashtag filter; no pagination | doc | ship; pagination is `next` (irrelevant at 44 facts) |
| A7 | Hashtag rail + Trending strip | Browse by tag | doc | ship, verify |
| A8 | Standalone `/hashtags` page | Dead: redirects home; page file unreachable | code | cut (delete file) |
| A9 | Fact detail page (image/video tabs, Top/Newest meme sort) | The fact page | doc; UATs | ship; video tab follows the video decision |
| A10 | Related facts | Related facts on the detail page | indirect tests only | ship, verify |
| A11 | Community memes on a fact | Public memes made for a fact | doc | ship, verify |
| A12 | Search | Substring match, newest-first, `#tag` exact | doc | ship as-is; full-text is `later` |
| A13 | Search history recording | Records signed-in users' searches; never read back | doc | your call: cut the recording (a privacy surface with no product value) or keep |
| A14 | Leaderboard `/top-facts` | All-time by Wilson score; **time-window pills and hashtag pills do nothing** | doc | your call: remove the dead pills and ship all-time (recommended), fix the pills, or cut the page |
| A15 | Activity feed `/activity` | Signed-in user's contributions + notifications (approve/reject land here) | doc | ship, verify |
| A16 | Meme permalink `/m/:slug` | Public meme page, image, download; private → 404/410 | 3 unrun UATs; #591 open (private not-found reads as an error) | ship (core); #591 your call now/next |
| A17 | Video permalink `/video/:id` | Public video page | doc | follows the video decision |
| A18 | OG preview cards | Meme permalinks only; **#592: og:image "Image not found"** | doc; bug | fix for launch (meme pages); fact-page OG is `next` |
| A19 | Fact share modal | Copy link + social popups with name/pronouns baked in; **email invite always fails in prod** (#374; allowlist is `example.com`) | doc; bug | ship; your call on the email option: remove it for launch (recommended) or fix it |
| A20 | Meme share modal (per-platform copy, share intents) | Native share / platform popups / mailto | doc | ship, verify |
| A21 | Post-create share screen | Platform list, merch teaser, download | doc | ship minus the merch teaser if merch is cut |
| A22 | Merch "Wear it" `/wear`, Zazzle export + redirect | Product preview → affiliate redirect; pickers cosmetic; **#598 broken** | doc; bug | cut: remove CTA, route, export, redirect, admin Affiliate page |
| A23 | Hero example media | Example images in the builder entry step | code only | ship (plumbing) |
| A24 | `/library` | Self-view only; no public profiles | doc | see Journey C |
| A25 | **Legal pages (Terms, Privacy)** | **Do not exist** — no route, page or link | absent | **fix for launch** — a launch gate given payments, photo uploads, email and analytics; David supplies or approves the text |
| A26 | 404 page | Not-found | code | ship |
| A27 | Orphan public endpoints: fact links (`GET/DELETE /facts/:id/links`), fact Pexels images | No doc, no known caller | code only | investigate; delete if dead |

### Decisions — Journey A (David, 2026-10-05)

- Ship list accepted as presented (A1, A2, A4, A5, A7, A9, A10, A11, A12, A15, A16, A20, A23, A26), each on the launch verification list.
- **A3** Pronoun suggestion: cost is negligible (one ~120-token utility call, `maxTokens: 64`, `ai.ts:405`); latency is the concern. **Cache by lowercased name for launch**; a common-names lookup table only if measured latency warrants. Note: runs on the utility-LLM fallback engine (no default `llm` engine configured).
- **A6** Feed is fixed at 20 text-only cards (`Home.tsx:510-513`; server honours `limit`/`offset`, `facts.ts:127`), so load is not a function of catalogue size. Reachability is: **"load more" is a launch item if launching with > ~50 facts**, else `next`.
- **A8** cut (delete `pages/Hashtags.tsx`).
- **A13** Keep search-history recording **and add it to the search screen** so users see their previous searches (launch; David's scope addition).
- **A14** Leaderboard ships all-time only; dead time/hashtag pills removed.
- **A16** Ship; **fix #591 for launch** (private-meme not-found page should read as "private", not an error).
- **A18** Fix meme OG preview (#592) for launch; fact-page OG `next`.
- **A19** **Fix share-by-email for launch** (#374, `example.com` allowlist). David: "Sharing by email is critical. Any modality for sharing should be supported because growth is what will make the site valuable."
- **A22** Merch cut, including the admin Affiliate screen.
- **A25** Confirmed: Claude drafts Terms and Privacy for David's approval; launch gate.
- **A27** Investigate the two orphan endpoints; delete if dead.
- A17, A21, A24 follow later journeys.

## Journey B — Account (26 items)

| # | Feature | What it does | Evidence | Recommendation |
|---|---|---|---|---|
| B1 | Local registration | Email + password, names, optional pronouns; logged in at once | doc | ship, verify |
| B2 | Local login | Email/password | doc | ship, verify |
| B3 | Google sign-in | OIDC with PKCE | doc | ship, verify end to end on the real domain |
| B4 | Apple sign-in | OIDC via form_post | doc | ship if it works on the real domain; Apple is the one most likely to break (certificates, return URL) — verify or cut |
| B5 | Link / unlink Google or Apple | Add or remove a provider on an existing account | code only | ship, verify |
| B6 | Replit Auth | Retired; comments remain | doc | confirm no UI remnants; delete comments |
| B7 | Logout | Ends the session | code | ship |
| B8 | Session state + entitlement map | `GET /auth/user`, `/entitlements/version` | doc | ship (plumbing) |
| B9 | Login redirect safety | Rejects off-site redirects | PR292 UAT (unrun) | ship; proof should be a CI test, not a UAT |
| B10 | Onboarding: hCaptcha (+ photo step) | One-time captcha before first submission; **OAuth sign-ups are sent here, local sign-ups are not**, yet submit 403s without it | doc | **fix for launch**: one consistent onboarding path, or verify the local path actually works |
| B11 | Email verification | Token link; verifying logs you in; **gates nothing**; OAuth users never get it set | doc | your call: keep display-only (recommended for launch friction) or make it gate submission/comments |
| B12 | Admin override verify | Admin marks verified | doc | ship |
| B13 | Password reset | Generic-response email; resets all sessions; works (tonight) | acct; tested live | ship; single-use hardening `next` |
| B14 | Set / change password | First password for OAuth users; change for others; does not log out other sessions | doc | ship; session logout on change `next` |
| B15 | Profile page | Display name, pronouns, avatar style, email, sign-in methods, subscription panel; dead "Memes" tab code | doc | ship; delete the dead tab code |
| B16 | Email change with verification | Pending email until verified | code only | ship, verify |
| B17 | Pronouns on the account | User-set pronouns personalise the site; **OAuth accounts silently default to he/him** | doc | **fix for launch**: default to they/them or ask, never assume he/him |
| B18 | Generated avatar styles | Pick a DiceBear style | code | ship |
| B19 | Custom photo avatar | Upload a photo avatar; Legendary upsell per direction | PR425 UAT steps 1–3 (manual) | ship, verify (needs a Legendary test account) |
| B20 | Notification preferences | Admin alert opt-ins | code | ship (admin-only) |
| B21 | Search history | see A13 | | decided: keep + surface |
| B22 | My uploads / AI images management | List and delete own images | code only | ship, verify |
| B23 | Spend view | The user's own generation spend | code only | ship, verify it's meaningful to a user, else hide |
| B24 | Self-service account deletion | **Does not exist**; admin-only | doc | your call: "email us to delete" in the privacy policy + admin flow for launch (recommended), self-service `next` |
| B25 | Sessions | No sliding expiry, unlimited concurrent, no "my sessions" UI | doc | ship as-is for launch |
| B26 | Admin "view as user"; dev admin login | Operator tools | PR425, PR221 UATs | ship (ops) |

### Decisions — Journey B (David, 2026-10-05)

- Ship list accepted (B1, B2, B3, B5, B7, B8, B12, B13, B14, B15, B16, B18, B19, B20, B22, B25, B26); B6 remnants removed; B9 moves to a CI test; B15 dead tab code deleted.
- **B4** Apple sign-in ships: David — "already tested and working on Overhype.me."
- **B10** Fix for launch: one onboarding path for every sign-in method (confirm local-path behaviour first).
- **B11** **Verified email gates every authenticated action** (David: "a monetization strategy for the site may be to use email lists … I would gate any action in the system against having a valid email"). Implementation notes: trust Google/Apple's verified-email claim at sign-up (the code never records it today; OAuth users would otherwise be locked out); add **marketing opt-in at sign-up, a stored consent flag, and unsubscribe on every list email** — none exist (Fact of the Day currently goes to Legendary members only, `factOfTheDay.ts:71-84`).
- **B17** Bug, fix for launch: local sign-up carries the visitor's chosen pronouns (`Login.tsx:22` → `localAuth.ts:154-160`); **OAuth sign-up drops them** and the schema default is `he/him` (`lib/db/src/schema/auth.ts:41`). Carry the stored choice through OAuth sign-up and change the default so nothing assumes "he". No new UI.
- **B23** Spend/cost controls: **own hardening phase with a plan review, launch gate.** David: "super locked down and defined before we launch so that there's no runaway cost." (Astra's gate 4 and `security-model.md:232`'s coverage caveat feed it.)
- **B24** **Build self-service account deletion before launch** (David), designed against the NCMEC retention rule: deletion must never destroy legally retained safety records (admin hard delete already preserves `ncmec_reports`); tier `sensitive`.

## Journey C — Fact submission and community (14 items)

| # | Feature | What it does | Evidence | Recommendation |
|---|---|---|---|---|
| C1 | Submit a fact | Registered user submits; lands in triage | PR242 UAT | ship (core); now behind verified email (B11) |
| C2 | AI tokenise | Plain text → `{NAME}`/pronoun template | doc | ship, verify (and confirm which tiers it's gated to) |
| C3 | Duplicate check while typing | Embedding-based warning | doc | ship, verify |
| C4 | AI hashtag suggestions | Pre-fill | doc | ship |
| C5 | Rate a fact (thumbs up/down) | Feeds the Wilson score that ranks everything | doc | ship, verify (legacy ratings table is dead — delete) |
| C6 | Post a comment | Captcha; **every comment lands pending admin approval**; no per-route rate limit | doc | your call: ship with moderation toil, or cut comments for launch |
| C7 | List comments | Approved only; authors cannot edit/delete | doc | follows C6; author delete `next` (interacts with B24) |
| C8 | Comment hearts | Toggle | doc | follows C6 |
| C9 | **Report content** | **Does not exist** (no route for facts, memes or comments) | doc | your call: minimal "Report" → admin queue for launch (recommended for a site hosting images of real people), or `next` |
| C10 | Author notifications | Activity + email on approve/reject | doc | ship, verify |
| C11 | Library tabs (Liked, Submissions, My Memes, My Images, Search History, Activity) | Self-view | doc | ship, verify each tab |
| C12 | Per-user fact image preference | Which image shows for a fact | code only | verify it's wired in UI; else delete |
| C13 | Per-user AI-meme preference | Which AI background shows | code only | verify it's wired in UI; else delete |
| C14 | Fact variants | Admin-side; queued not published | PR242/PR256 UATs | Journey I |

### Decisions — Journey C (David, 2026-10-05, partial)

- **C6** Comments: rate limit is wanted regardless. David: "important for engagement but open to feedback"; asked for research on the state of the art before deciding. Research summary and the hybrid recommendation are in the session (2026-10-05); decision pending.
- **C9** Report content: **confirmed for launch, as a takedown system**. David: "my defense against any type of litigation is that I'm the platform. Takedown is part of that." Research (copyright.gov §512 resources): the platform defence for copyright needs a **DMCA agent registered with the US Copyright Office** (renewed every 3 years), the agent's contact posted publicly (ToS), expeditious takedown on a compliant notice, notice to the poster + a counter-notice path (repost in 10–14 business days absent a court action), and an **adopted and enforced repeat-infringer termination policy**. Section 230 shields the platform from being treated as the publisher of user-supplied content for many non-IP civil claims, but it does not reach federal criminal law, communications-privacy law or the FOSTA sex-trafficking carve-outs, and it protects nothing the platform itself authors — the compliance phase gets counsel's statement of what it covers here, not this summary. Likeness/right-of-publicity claims (someone else's face uploaded) are the product-specific exposure and need a consent attestation at upload plus an "I did not consent to this image of me" report category.
- David also asked for proactive suggestions of additional functionality; the list is in the session and the accepted items are recorded under their journeys.
- Verified 2026-10-05: no "make this about you" CTA on the meme page (grep of `pages/memePage/` for make-your-own/personalise wording found none); admin Users has deactivate/delete but no suspend; local registration has no captcha (`localAuth.ts:189,202` set `captchaVerified: false`); no product analytics beyond route-visit counters.

### Decisions — Journey C, round two (David, 2026-10-05)

- **C6** Comments stay; **rebuild the comment moderation flow** as the hybrid (verified email, first-comments-held trust gate, per-account rate limit, report button, AI pre-screen wired in — `moderateComment` exists with no callers). David: "let's rebuild the comment moderation flow. I think AI can help a lot here as well."
- **C9** Takedown package confirmed; **a compliance deep-dive phase** precedes the law firm: Terms, Privacy, DMCA policy + agent registration, community guidelines, consent flows (likeness at upload, marketing at sign-up, cookies), NCMEC procedure and retention, data rights (deletion, export), age gate. David: "keep a plan and list of tasks needed to be compliant because all of the moving pieces need to be in place before I launch."
- **New phase: the loop** (personalisation, sharing, "make this about you", fact-page OG, public creator pages). David: "spend as much time as necessary building this out properly prior to launch."
- **Reactions** (🔥😂❤️🤯, one per person per item) ship; Wilson on thumbs stays the all-time ranking; a time-decayed "heat" (reactions + shares + memes made) drives Trending and the hero pick. Pending David's confirmation of the weighting approach.
- **Analytics:** GA4 is wired but build-time conditional (`index.html:52-64`, `VITE_GA_MEASUREMENT_ID`); only `affiliate_click` and `share_intent` are tracked (`artifacts/overhype-me/src/lib/analytics.ts`). Proposed: keep GA4 + add PostHog (new vendor, pending sign-off) + a defined funnel event list. Cookie/consent notice follows.
- **Email marketing:** consent/preferences in our DB; sending and list hygiene via Resend audiences/broadcasts (existing vendor); no home-built mailing engine. **Fact of the Day proposed as a free opt-in viral tool** with share + make-your-own links (pending David).
- **Content seeding phase:** David's own facts via the existing admin CSV import (→ triage, full pipeline); friends' submissions via invite as the UGC/moderation stress test. Target proposed: 150 approved facts at launch (pending).
- **Anti-bot:** proposed Cloudflare Turnstile replacing hCaptcha (existing vendor relationship via the OG worker; pending sign-off), applied at registration, submission, comments, share-by-email. Local registration currently has no captcha.
- **Account suspension:** launch. **Public creator pages:** launch unless David says `next`. **Fact-page OG:** launch ("must have").
- **Maintenance:** a **read-only mode switch** (browse/personalise stay up; writes show a short notice) instead of takedowns; migrations written backward-compatible so deploys need no window. No such switch exists today.
- **Age gate:** none exists (registration asks nothing). Proposed for launch: 13+ attestation at sign-up, 18+ for photo upload, final word in the compliance phase (pending).

### Decisions — Journey C, round three (David, 2026-10-05)

- Loop rebuild phase: agreed. Reactions + heat/Trending: agreed. **PostHog approved** (new vendor) alongside GA4; GA4 to be configured by Claude ("as useful as possible without going crazy"); one event call fans out to both.
- **Email:** keep Resend; build consent, preferences, tracking and unsubscribe around it ourselves. **Fact of the Day is CRITICAL for everyone** (free opt-in, with share + make-your-own links).
- **Seeding:** no CSV import for seeding — "I really want every fact attributable to a real user who isn't me." Invitees seed via submission. CSV import stays an admin tool, off the launch path, to be verified.
- **Turnstile replaces hCaptcha entirely** ("I hate captchas myself"), behind verified email + rate limits.
- Account suspension: launch. Public creator pages: **at launch**. Fact-page OG: launch. Read-only maintenance mode: agreed.
- **Two launches:** *soft launch* = full build behind an invite gate, **50 approved facts**, friends as first users and the real-data verification pass; *full launch* = gate off. One feature set, one readiness list, two gates. *(Superseded 2026-10-06 by the four stages in the [launch definition](./launch-definition.md): what this bullet calls "soft launch" is **Seed**; the real-data pass moved to the wider Soft launch; "full launch" is Full launch (US) then (Global).)*
- **Age gate:** agreed (13+ at sign-up, 18+ for photo upload), compliance phase has the final word. **NSFW mode is a post-launch feature**: design for it now (audience flag on facts/memes, verified-adult state, "mark adult" in moderation) without shipping it.

## Journey D — Meme creation, image (29 items)

| # | Feature | Recommendation |
|---|---|---|
| D1 | Meme Builder Wizard (only live builder) | ship (core); delete legacy `MemeStudio.tsx` / `components/MemeBuilder.tsx` (unreachable, flag pinned on) |
| D2 | Template/gradient backgrounds | ship, verify |
| D3 | Pexels stock photos | ship, verify (licence terms noted for compliance phase) |
| D4 | Photo upload (free tier), JPEG only | fix for launch: accept PNG + HEIC with server-side conversion; verify on iPhone; delete vestigial `meme_upload_photo` flag |
| D5 | Use my profile photo | ship, verify |
| D6 | Reference-photo i2i AI memes (Legendary) | ship (paid core); drain PR222/PR223 UATs |
| D7 | t2i AI memes | ship, verify |
| D8 | Render status polling | ship |
| D9 | AI gallery picker (per-fact gallery shared across users) | verify contents; restrict to generic non-photo renders if faces can appear (pending David) |
| D10 | Scene-prompt regenerate/view routes (code only) | check moderator-only; hide from users if exposed |
| D11 | Delete AI image | ship |
| D12 | AI storage cap | ship (spend phase) |
| D13 | Caption + split caption | ship; PR398 UAT = David's eyes |
| D14 | Speech/thought bubbles | moderator-only, as roadmap; no end-user exposure at launch |
| D15 | Aspect ratio toggle | ship, verify |
| D16 | Advanced options / style presets | ship, verify |
| D17 | PuLID stylise toggle (Legendary) | ship (spend phase) |
| D18 | PuLID poll/cancel | ship |
| D19 | No-face fallback modal | ship, verify |
| D20 | Save meme (daily cap, idempotency, NSFW check) | ship, verify |
| D21 | Preview/download renders; **anonymous can download stock memes** | pending David: (a) anon download, sign-up to save/share; (b) anon preview only, verified account for download/save/share (recommended); (c) open |
| D22 | Public/Private toggle, hard-coded tier check (#395) | fix for launch: read the entitlement grid |
| D23 | Guest sign-up prompt | ship |
| D24 | Upgrade modal | ship, verify |
| D25 | Meme page actions | lose merch; gain "make this about you" (loop phase) |
| D26 | Meme hearts (no `canViewMeme` check, #375) | fix for launch; folds into reactions |
| D27 | Delete own meme | ship, verify |
| D28 | Zazzle export | cut |
| D29 | Budget-reached card | ship (spend phase) |

### Decisions — Journey D (David, 2026-10-05)

- **D2** Template backgrounds: **delete** ("lame").
- **D3** Stock photos: David on the fence (violate "about me" but don't want to force uploads). Claude's proposal: delete both; free tier = the fact's moderation-approved **generic AI render** captioned with the user's name/pronouns (zero marginal cost; needs a no-render fallback and a content-sprint check); Legendary = your face in that scene. Pending David.
- **D8** → a **UX polish phase** across all user journeys, late, launch-critical ("the final polish … as close to right prior to launch as possible").
- **D12** → spend-controls phase; oracle: "I'm not venture backed and can't afford to cover user spend at scale."
- **D16** → **engine evaluation** item (latest image models compared on the same facts via the eval dashboard), then presets reviewed/tuned against the winner. Planner/compiler split is settled; the engine is not; compiler is engine-specific.
- **D17/D18** **PuLID removed everywhere** (image stylise toggle, video stage one, engine catalogue, docs, Manual) — prose-sweep, not a patch. "We're going to be using a much stronger model."
- **D24** Upgrade messaging written after Journey F defines the tier.
- **D27** **"My content"**: one place showing every upload/generation with per-item delete; B24 builds on it. Launch.
- **D14** Speech bubbles: "crucial … never finished building and testing." Scope pending: moderation-side only (recommended) vs end-user editing too.
- **D21** Option (b): anonymous preview only; download/save/share need a verified account ("part of the upsell").
- **D22, D26, D4** fix for launch. **D28** delete. D1 legacy builders deleted; vestigial flag deleted.
- **D9 / privacy model:** revisit public/private end to end — "make sure that private stuff doesn't get shared"; **only self-uploaded or self-created images are available to a user for new memes**; shared gallery = approved generic fact renders only (no faces by construction). A privacy-model review with one rule enforced in one place + tests. Launch.

## Journey E — Meme creation, video (14 items)

Video is cut from launch (scope gate) and PuLID is retired (D17). Items: builder step, start job, pipeline runner (stylise → i2v → subtitles), source modes, checkpoint screen, no-face fallback, cancel, status takeover, default-engine meta, style/look/motion catalogues + preview GIFs, advanced options, legacy sync video path (retired studio only), budget screen, limits, video permalink, six video engines. Pending David: **delete** the pipeline/legacy path/PuLID stage/video engines keeping the generic async-job framework (recommended) vs **disable** (remove entry points, refuse routes, keep code).

### Decisions — Journey D, round two (David, 2026-10-05)

- **D3** Stock photos and templates **deleted**. Direction David likes, to be designed in depth: for each approved fact, the moderation test renders are **saved as the approved "hero" options** (funny, shows the fact happening, no likeness) and offered to free users; Legendary puts the user's face in the scene. Open design points: renders needed in the builder's aspect ratios (not just the moderation ratio); fallback when a fact was approved under a render waiver; how many options per fact; storage/cost. → a design item under the loop/builder work, with a plan review.
- **D14** Speech bubbles: **finish** (moderation side; approved renders carry them).

### Decisions — Journey E (David, 2026-10-05)

- **Delete** the video pipeline, legacy one-shot path, PuLID stage and video engines; keep the generic async-job framework. "We're going to want to build the video pipeline from the ground up on top of the image pipeline." Video permalinks go with it (pre-launch data is disposable).

## Journey F — Membership and payments (22 items)

| # | Feature | Recommendation |
|---|---|---|
| F1 | Tiers `unregistered / registered / legendary` + `is_admin` | ship (derived, never assigned) |
| F2 | Pricing page — Monthly / Annual / Lifetime cards from live Stripe prices; fixed 3 slots | depends on plan decision; monthly-only collapses it to one card |
| F3 | Checkout + confirm | ship; money-rehearsal phase |
| F4 | Membership product allowlist (`overhype_membership` tag) | ship; proven at every grant surface (security-model C6) |
| F5 | Subscription panel (plan, renewal, "records haven't caught up") | ship; PR600/PR602 UATs to run |
| F6 | Switch monthly ↔ annual | cut if monthly-only |
| F7 | Cancel / reactivate | ship, verify |
| F8 | Stripe customer portal | ship, verify (default Stripe config) |
| F9 | Payment history + receipts (code only) | ship, verify |
| F10 | Lifetime "Legendary for Life" | existing purchases honoured; new sales cut if monthly-only |
| F11 | Access-revocation notice + banner | ship, verify |
| F12 | Grace window after failed payment (hourly sweep) | ship; money-rehearsal phase (doc notes a rare unset-deadline case) |
| F13 | Refund / dispute handling | ship; money-rehearsal phase; **operator-run reconciliation runbook** for undelivered webhooks (Astra gate 3) |
| F14 | Stripe webhook | ship; unmodeled events silently ignored → log them |
| F15 | Entitlement grid (`/admin/features`) | ship; single chokepoint |
| F16 | Budget / spend gate | spend-controls phase (launch gate) |
| F17 | Tester role (`is_tester`) | **doc only** — no column, no code; decide: implement or delete from docs |
| F18 | Admin comp (grant/revoke lifetime) | ship, verify |
| F19 | Test-mode entitlement leak (`livemode` column, #454) | **must-do before go-live**; David's backfill call |
| F20 | Stripe account boot guard | ship (PR577 UAT) |
| F21 | Legendary feature set at launch | define: face-in-scene AI memes, private memes, custom avatar (+ video later); Fact of the Day is now free |
| F22 | Upgrade messaging (D24) | written after F21 |

### Decisions — Journey F (David, 2026-10-05)

- **F2/F6/F10** **Monthly only at launch.** No existing purchases to honour: "Everything is test data." Annual/lifetime return post-launch.
- **F21** Legendary at launch = face-in-scene AI memes, private memes, custom photo avatar; video later; Fact of the Day free. David asked for further premium ideas (proposed in session: watermark-free downloads with free-tier branded watermark, ad-free, monthly face-render allowance, multiple saved reference photos, priority rendering, early access via beta opt-in). **The entitlement grid is the source of truth: the Legendary definition is written into `/admin/features`, not just docs.**
- **F19** `livemode` column; **all pre-existing rows treated as test-mode** ("There are no real purchases"). Moot after the fresh production build; column still required.
- **F17** `is_tester` removed from docs. David's intent: something between user and admin for testing new features into soft/full launch. Proposed: no flags for soft launch (the invite gate is the gate; the pre-launch "no rollout flags" decision stands); post-launch, a **beta opt-in overlay** in the entitlement grid (union semantics, like admin/tester) that gates features marked beta — the staged rollout the 2026 decision said would be reintroduced deliberately. Pending David.

## Journey G — Email and notifications (11 items)

| # | Feature | Recommendation |
|---|---|---|
| G1 | Verification email (+ rate-limited resend) | ship; now load-bearing (B11) |
| G2 | Email-change verification | ship, verify |
| G3 | Password reset | ship (proven live) |
| G4 | Review approved / rejected emails | ship, verify |
| G5 | Fact of the Day | **free opt-in for everyone** (decided); add share + make-your-own links; consent + unsubscribe |
| G6 | Share-by-email invite | **fix for launch** (#374) |
| G7 | Payment emails (SCA, card updated, renewal reminder) | ship; money-rehearsal phase |
| G8 | Access-revoked email | ship, verify |
| G9 | Admin notifications (opt-in) | ship, verify |
| G10 | Email outbox + retry (`/admin/email-queue`) | ship (proven tonight) |
| G11 | Resend transport | keep; audiences/broadcasts for the list |
| G+ | Welcome email after verification; marketing consent capture; unsubscribe on every list email | proposed for launch |

### Decisions — Journey F/G close (David, 2026-10-05)

- **Legendary perks for launch:** branded watermark on free downloads / clean on Legendary; monthly face-render allowance with a visible meter; multiple saved reference photos (free gets one); early access = beta overlay on. Ad-free and priority rendering go in the grid as Legendary-on rows with nothing to gate yet.
- **Beta opt-in overlay** post-launch; nothing for soft launch; `is_tester` removed from docs. Agreed.
- **Email additions for launch:** welcome email after verification, marketing consent at sign-up (privacy-policy line), unsubscribe on every list email. All three.

## Journey H — Admin console (16 routed screens, 2 dead files, helpers/tests)

| Screen | Recommendation |
|---|---|
| Dashboard | ship |
| Facts (edit, delete, resubmit, variants, import, backfills, text-edit history, overrides) | ship; CSV import stays as an admin tool off the launch path |
| Users (search, add, set password, verify, delete/reinstate, comp, membership, spend, export) | ship; **add suspension** (repeat-infringer policy) |
| Moderation (fact wizard + comment panel) | ship (core); comment panel rebuilt per C6; speech bubbles finished (D14) |
| Billing (Stripe summary, live-mode toggle, test event, sync, verification) | ship; money-rehearsal phase; live-mode toggle is a launch-day control |
| Refunds & Disputes | ship |
| Affiliate | **cut** (merch) |
| Video Styles | **cut** (video deleted) |
| Config (Budget, Limits, Email, Zazzle, Moderation, AI, Debug) | ship; **prune Zazzle keys** and any key for a cut feature |
| Engines | ship; **prune video engines + PuLID**; engine evaluation uses it |
| Taxonomy Health | ship (proven tonight) |
| Features (tier × feature grid) | ship; **becomes the Legendary definition** (F21) + beta overlay later |
| Email Queue | ship (proven tonight) |
| Queue Health | ship (proven tonight) |
| Eval dashboard | keep, admin-only; the engine-evaluation tool; Manual ch.13 still unwritten |
| Help (in-console Manual) | ship; Manual refreshed in the docs pass at the end |
| `comments.tsx`, `ai.tsx` (dead redirects) | **delete** |
| **New screens from decisions** | **Reports / takedown queue** (C9); **Invites** (the Seed gate; see the four stages in the launch definition); **Read-only mode switch**; **Safety** (`/admin/safety`, NCMEC phases — scope set in the compliance phase); consent/list counts on Dashboard |
| Cleanup stop condition (Astra) | every retained control performs its stated action; forbidden actions enforced server-side; operators can understand failure and recovery. No redesign. |

### Decisions — Journey H (David, 2026-10-05)

- Cut/prune list agreed; four new admin sections agreed (Reports/takedown, Invites, Read-only switch, Safety).
- **Dashboard: rebuild with intention, as its own planned feature.** "It was a zero shot from Replit … not helping me to easily go to one location and manage things. Moderation will be the absolute most important thing we do and it should be front and center … Operational metrics that help me ensure I know what I need to do at any given time should be surfaced." Testing-harness controls (Sentry test, route stats) almost never used → off the dashboard.
- **User-facing manual / contextual help:** derived from the admin Manual (single source of truth, re-purposed for the user audience), simple help available on every user page for self-service. The help generator (`generate:help` → `src/generated/help/`) already builds the admin help from `docs/manual/`; the user guide is a second audience from the same source. Launch.
- **Prune all unused stuff.**
- **Debug mode (`debug_mode_active`):** David believes it is useless. Code reading: a global switch that makes every `admin_config` getter prefer the row's `debug_value` (`adminConfig.ts:8-10`); reaches 5 server files; its only toggle UI lives on the dead `ai.tsx` page; `membershipTiming.ts:249-259` grew row-locking logic just to keep membership keys coherent under a flip. Claude's view: remove it (parallel config universe + global flip on a live site; the real need, trying AI settings safely, is served by the engine evaluation and per-key edit history). Removal = drop two columns + sweep; touches a payments path → migration review.

## Journey I — Moderation pipeline (22 items)

Core of the product; everything ships. Notes per item: triage queue/reject/provisional accept (ship); enrichment + overrides (ship; PR582/PR585/PR234 UATs); Visual Concept step incl. **speech bubbles finished** (D14); runtime compiled-prompt preview (ship; contract with production); test renders per scenario (ship; **saved as hero options**, D3; aspect-ratio design); reference research + source-image analysis (code only → verify used, else delete); approve for production (ship); refresh cycles + mark major update (ship); taxonomy health + bulk send-back (proven tonight); backfills (ship; **`ADMIN_API_KEY` scoping** in the security phase); comment moderation (**rebuild**, C6; dead Flagged tab goes); fact import (`/admin/import/facts` code-only → delete if dead; CSV import verified, off launch path); eval (keep); resubmit for moderation (ship); approved-text lock (ship). Proposed addition: **moderation ergonomics** — AI-assisted triage (suggested action + reason), keyboard-driven review, batch approve of renders — since moderation is "the absolute most important thing we do".

### Decisions — Journey I (David, 2026-10-05)

- **Debug mode: remove** (columns dropped, five-file sweep, migration review).
- **Moderation UI/UX rebuilt** once core functionality is locked down (ergonomics item, launch; sequenced after the pipeline changes: bubbles, hero options, comment rebuild).

## Journey J — Safety and legal (12 items)

| # | Feature | Recommendation |
|---|---|---|
| J1 | Upload/generation scanning (arachnid, falSafety, nsfw) | ship; coverage per path verified in the compliance phase, never published |
| J2 | Quarantine (restricted prefix, no read path, no UI by design) | ship; no evidence viewer, ever |
| J3 | NCMEC report stub (phases 1–3 of 8) | compliance phase decides: complete capability vs counsel-confirmed manual procedure |
| J4 | NCMEC config keys (5 reserved, write-protected) | ship |
| J5 | Evidence retention (90-day default; statute now 1 year; no purge job) | compliance phase; retention set with counsel; purge job built to match |
| J6 | Data-retention job (`POST /jobs/data-retention`) | verify what it purges; document |
| J7 | Admin user data export | ship; add a **user-facing "download my data"** (data rights) — proposed launch |
| J8 | Admin hard delete (NCMEC rows survive) | ship; self-service deletion (B24) reuses it |
| J9 | Private memes (`canViewMeme`) | privacy-model review (D9) |
| J10 | Open-redirect protection | CI test (B9) |
| J11 | Global rate limiter | ship |
| J12 | Report-a-bug (Sentry feedback widget, bottom-right) | keep for soft launch; decide at full launch (replace with Report content + support email) |
| J+ | Legal pages (A25), age gate, consent flows, DMCA agent, repeat-infringer policy, community guidelines | compliance phase deliverables |

## Journey K — Integrations and other (16 items)

| # | Feature | Recommendation |
|---|---|---|
| K1 | Zazzle affiliate | cut |
| K2 | Pexels | moderation research only (user-facing stock removed, D3); keep |
| K3 | Eval dashboard | keep (engine evaluation) |
| K4 | Engines catalogue | prune video + PuLID; winner of the engine evaluation becomes default; **set a default `llm` engine** (tonight's fallback warning) |
| K5 | Video styles | cut |
| K6 | Sentry | ship; **alerts routed to David** (email/push) as a readiness criterion |
| K7 | Cloudflare OG-router worker | ship; loop phase (OG fix) |
| K8 | Route-visit counters | delete (analytics replaces) |
| K9 | Health endpoints | ship; **external uptime check** (Sentry uptime monitors — existing vendor) |
| K10 | Background schedulers (FOTD, purges, membership) | ship; FOTD audience widened |
| K11 | Async job queue + lanes | ship (proven) |
| K12 | Storage (GCS via Replit sidecar) | keep; R2 deferred; test substitute for CI (Astra) |
| K13 | AI vendors (OpenAI, Anthropic, fal) | engine evaluation; fal pricing warm-up 429s to fix |
| K14 | hCaptcha | → Turnstile |
| K15 | AdSlot | keep behind the grid, off at launch |
| K16 | In-app Manual | ship; + user guide derivation |

### Decisions — Journeys J/K (David, 2026-10-05)

- **K2 Pexels: delete entirely.** It was a stock-image lookup run during prep as a "review tool" (`moderation-workflow.md:198-204`) and the source of user-facing stock backgrounds and the per-user fact-image preference (C12). With stock photos gone and hero renders replacing them, nothing needs it; test renders serve the moderator better. Removes a vendor and a prep job. C12/C13 preferences go with it.
- **J12** Sentry feedback widget: keep through soft launch, remove at full launch. **K6/K9** Sentry alerts to David + uptime check: agreed.
- **J7 "Download my data":** advice given (below); pending David with the geo question.
- **Future tier captured:** "Legendary Pro" — a higher tier for stronger (more expensive) image-to-image and later image-to-video models. Not for launch; design the tier enum, the grid and the Stripe product tagging so a third tier is additive. User-facing text-to-image is retired in favour of the AI "stock photo" (hero renders).
- **Geo / GDPR (advice, 2026-10-05; compliance phase confirms with counsel):** GDPR applies when services are offered to EU/UK residents regardless of where the operator is; it brings access/portability, erasure, consent, cookie consent and potentially an EU representative. Recommendation: **soft launch is invite-only (moot); full launch US-first**, EU/UK geo-blocked at Cloudflare with a polite page until GDPR readiness is deliberately built; **OFAC-sanctioned countries blocked** (Stripe refuses them anyway); Terms state the service is offered in the US. Under that policy a self-service export is not required at launch (CCPA thresholds not met); deletion stays (already decided). Pending David.
