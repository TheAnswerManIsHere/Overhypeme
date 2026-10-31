# PLAN — Launch Phase 5: Account and identity · v7 · for approval (memes baked at save, David 2026-10-30 ~23:50)

Workstream: #795 · Parent: #628, `docs/plans/PLAN_GET_TO_LAUNCH.md` v9, Phase 5 · Planning loop: `.agents/reviews/phase5-account-identity/`

```plan-oracle
# Oracle — Launch Phase 5: Account and identity

Status: AGREED with David at the scope-of-work gate, 2026-10-30 ("1, go"), after
the pre-plan conversation of the same evening. Workstream: #795. Parent
programme: #628, `docs/plans/PLAN_GET_TO_LAUNCH.md` v9, Phase 5 (that text
governs where this one is silent).

## Direction served

`product-direction.md`, *Current product bet*: "Get to launch / stability".
Launch plan v9, Phase 5 outcome: every account has a verified email before it
acts; sign-up is consistent across methods; the data model is ready for beta and
adult content without shipping either. This is the first phase of the Product
stream; Phase 6 (the loop) depends on it for "a verified account for
download/save/share" (D21).

## Product intent of this increment

1. No account changes anything on the site before its email is verified. Any
   state-changing request by a signed-in user is refused except the recovery
   routes themselves (verify, resend verification, logout, password reset). A
   Google or Apple verified-email claim counts as verification at sign-up.
2. Every sign-in method (local, Google, Apple) runs one onboarding screen,
   once: pronouns, date of birth, marketing consent, and a Turnstile challenge
   (no Terms line until Phase 14 writes the Terms — David, 2026-10-30 23:17:
   *"no point in writing something useless now. We'll do it right once."*). A half-finished onboarding resumes where it
   stopped; existing accounts (David's production account included) are asked
   once on their next sign-in.
3. Pronouns are suggested from the first name and always changeable; an
   explicit choice is kept; when the suggestion has no answer the field is
   blank and must be chosen. The blind `he/him` column default goes, so no
   account is ever assigned pronouns without a screen having been shown.
4. Cloudflare Turnstile replaces hCaptcha at registration, fact submission,
   comments and share-by-email. hCaptcha, its package and its secret are
   retired.
5. Date of birth is required at onboarding; under 13 is refused and the date
   is not stored; 13+ and 18+ are derived from the stored date at read time,
   never stored as flags. Marketing consent and the Terms acknowledgement are
   stored with a timestamp, the wording version shown, and how consent was
   given (ticked by default, ticked by hand, declined). The marketing box is
   pre-checked for a visitor whose edge-reported country is the United States
   and unchecked for everyone else (David, 2026-10-30, pick 1 of 3).
6. "My content" lists every upload, generation and meme the user has, with
   per-item delete. Deleting **any** of them is undoable: it is hidden
   everywhere at once, moves to a "Recently deleted" section, and a purge job
   removes it for good after a restore window. (Amended by David,
   2026-10-30 ~23:13 UTC, widening the earlier "generations only": *"Photos
   that are taken at the time of upload may not be stored locally on the
   user's device. They might be using a webcam. … ALL user uploaded content
   needs to be un-deletable."*) Quarantined items never appear and cannot be
   deleted by the user.
7. Self-service account deletion is a resumable state machine: on request,
   every session is revoked, sign-in is blocked, any subscription is cancelled,
   the person's memes and uploads are hidden, and an email names the purge
   date; 14 days later a purge job completes it — media gone, the person's
   facts credited to "a former member" and kept, everything else of theirs
   deleted, safety records (`ncmec_reports`) untouched, the account row gone.
   Signing in during the window cancels the request and restores everything.
   An open Stripe dispute holds the purge until it resolves. Each stage is
   idempotent and a crash resumes at the stage that did not finish.
8. Account suspension is a stored state an admin sets: it blocks sign-in and
   every action, with the reason visible to admins only. It does not touch the
   person's catalogue content (takedown is Phase 9's path).
9. NSFW readiness, nothing shipped: an audience marker on content (general or
   adult, default general) and a verified-adult state on the account, read by
   nothing yet; a beta-overlay row in today's entitlement grid
   (`tier_feature_permissions`, edited at `/admin/features`), off for every
   tier.
10. A password change (set-password or reset) ends every other session of that
    user; a password-reset token is consumed atomically so two concurrent
    requests cannot both succeed.

## Must not change

- The child-safety boundary: `ncmec_reports` survive every deletion path; no
  admin viewer for quarantined evidence exists, ever.
- `users.membership_tier` is derived, never assigned. Deletion cancels through
  Stripe and lets `recomputeMembership` run; nothing writes the tier.
- The permission chokepoint: only `artifacts/api-server/src/lib/featureAccess.ts`
  reads the grid; product gates are `can(principal, key)`. The verified-email
  gate is an identity rail in the auth middleware, not a grid feature.
- Admin lockout stays impossible by configuration; the bootstrap admin account
  (`BOOTSTRAP_ADMIN_EMAIL`, provider-verified Google sign-in) passes the gate.
- A trigger or function ships through our migration runner (`lib/db/migrations`),
  never through Replit's publish copy (measured 2026-10-30: it copies tables
  only).
- No new external vendors; Turnstile is already approved (`launch-definition.md`).
- The dev-admin-login backdoor stays as is until Phase 15 (decisions.md,
  2026-10-21).
- Production holds exactly one account (David's) and dev keeps its content on
  `heliumdb`; neither is seeded, reset or migrated by hand.
- The settled decisions in `product-direction.md` *Decisions agents should not
  reverse without David*.
- Forward-only migrations: no already-merged migration file is edited.

## Settled decisions (pre-plan conversation, 2026-10-30)

- A deleted user's published facts persist forever, credited to "a former
  member" after purge: "that's how the system gets populated" (David). Whether a
  fact displays its author at all is Phase 6's decision (creator pages).
- Facts are never deletable by their author through any user path; account
  deletion is the one path that touches them and only changes the credit.
- The author link on facts and memes is kept as data while the account exists,
  so "follow a creator" remains buildable post-launch; it is cleared at purge.
- Date of birth required, no attestation fallback (David, pick 1).
- Deletion cooling-off: 14 days (David, pick 1).
- Undoable deletion of every user upload, generation and meme is Phase 5 scope
  on David's word (generated content first, then widened to all uploads at
  23:13: a webcam photo has no copy on the device)
  ("that's important and we should add it to the get to launch plan"), reversing
  Claude's "trash is next"; the parent plan gets a one-line amendment (v10) in
  Phase 5's first PR, which also fixes the two stale lines on the plan's second
  line that #628 already flagged. Restore window: 30 days, Claude's
  recommendation, for the approval readout.
- Marketing consent default: pre-checked for US visitors (CAN-SPAM is opt-out:
  FTC compliance guide, "you don't need to get members' consent to send them
  marketing emails"), unchecked elsewhere (CRTC FAQ on CASL: "You cannot use a
  pre-checked box to request consent"; ACMA: "Do not use pre-ticked boxes").
  Bundling consent into the Terms is ruled out.
- Pronoun inference from the name is the designed default and stays; the
  learned name→pronoun table from explicit overrides is *next*, placed beside
  Phase 6's A3 (cached AI suggestion).
- Suspension blocks the person, not the catalogue.
- Admin "deactivation" (`is_active=false`) becomes suspension; deletion is its
  own state machine. One state machine for leaving, one flag for being removed.
- Handoff-settled: bootstrap admin by email, not a stored flag; Replit's publish
  copies no triggers; the grid stays at `/admin/features` until Phase 13; no CSV
  seeding of production.

## David's answers to the plan's questions (2026-10-30 23:17 and ~23:50)

0. Memes are baked at save (~23:50, option 1 of 2), see *Now / next / never*.

1. Restore window: 30 days. 2. Deleting an account re-authenticates with the
password or a fresh provider sign-in: *"it should be HARD to do without
really meaning to, especially if there's anything that is irreversible."*
3. No Terms or Privacy text in Phase 5; Phase 14 does it right once (over
Astra's and Claude's recommendation of minimal versioned text now). 4. A
deletion request cancels the subscription at once; cancelling the deletion
restores content and whatever entitlements remain. 5. (a) *"Deleting a photo
does NOT delete any memes. Once a meme is created it exists independently
from the source photo."* (b) The one-day edge-cache residue is accepted and
stated in the copy. 6. Under-13 refused with nothing stored and nothing
destroyed; new registrations that never finish onboarding are cleaned up
after 30 days through the deletion engine. 7. A "Keep my account" button
after sign-in cancels a deletion.

## Now / next / never

- **Now:** the ten intent items.
- **Next:** Phase 14 — the Terms and Privacy pages and their acknowledgement
  (David, 23:17); Phase 6 — fact attribution display, public creator pages, the
  learned pronoun table (beside A3), the verified-account gate on
  download/save/share; Phase 9 — the comment trust gate and takedown; Phase 12 —
  unsubscribe on every list email and all sending; Phase 14 — the age law per
  territory and the privacy-policy deletion text; Phase 15 — the dev-admin-login
  redesign and `ADMIN_API_KEY` scoping; Phase 21 — GDPR's 13–16 consent age by
  country and data export.
- **Never (this phase):** shipping NSFW mode or the beta overlay; data export;
  moving the grid into code (Phase 13); any change to what a fact or meme is.
  (The earlier "or how it renders" was amended by David on 2026-10-30 ~23:50:
  a meme is **baked at save** — rendered once by the server and stored as a
  file, the recipe kept as metadata — so that, in his words, *"once the meme
  is generated it has its own life and should not be tied back to the source
  photo in any way."* Decided after Claude's research: Imgflip stores a
  permanent file; Cloudinary persists every derived image after first
  render; Canva and non-destructive editors keep a recipe for editing and
  export a flattened file for sharing; the existing `MEME_RENDER_VERSION`
  ETag proves recipe memes change appearance when the renderer changes.) (The earlier "no trash lifetime for anything other than
  generated content" was removed by David's 23:13 amendment, above.)
- **Post-launch idea recorded:** follow a creator, with alerts on new facts and
  memes.

## Ceremony

Feature-building mode, production phase, tier **sensitive** (auth). Plan →
Astra's review (`plan-review-loop`, Overhype lens) → David's approval → Opus
builds. Schema work takes `overhype-migration-review`. Every PR carries a
Codex review, Post-merge verification and a `## UAT` section. Exit evidence per
the parent plan: CI invariants for the gate, the pronoun carry and the deletion
state machine; scripted journeys for every sign-in method; David's human pass
on the onboarding feel.
```

## Problem

Today there are three sign-up doors and two half-gates. Local sign-up logs
the visitor in instantly and never sends them to onboarding; Google and Apple
sign-ups go to an hCaptcha step that local sign-ups skip
(`auth.ts:380-394`, `localAuth.ts:199-207`). Email verification gates nothing:
every server read of `emailVerifiedAt` is display-only, and an OAuth account
never gets it set (`accounts-and-auth.md`, *Email verification*). An OAuth
account is silently given `he/him` by a column default
(`lib/db/src/schema/auth.ts:42`) that `seed.ts:30` also writes at boot. There
is no self-service deletion, no "my content", no suspension distinct from
"deactivated", no consent or age record, and the password-reset token is not
atomically single-use (`localAuth.ts:400-440`). Phase 6 cannot gate
download/save/share on "a verified account" (D21) until "verified account"
means something.

## Direction

`product-direction.md`, *Get to launch / stability*; launch plan v9, Phase 5.
This increment makes true: **an account on Overhype.me is a verified,
consenting, age-known identity that can leave cleanly**, so every later
phase can gate on "verified account" and the data model is ready for beta
and adult content without shipping either.

## Product Intent

The ten items of the oracle above, verbatim.

## Must Not Change

The oracle's *Must not change*, verbatim.

## Settled Decisions

The oracle's *Settled decisions*, verbatim, plus these technical choices made
while drafting (each with its oracle where one ran):

- **S1. One gate, one rail, two shapes of write.** The verified-actor gate is
  a single middleware installed after `authMiddleware` in `app.ts`. It
  refuses (a) every unsafe-method request and (b) an inventoried list of GET
  routes that write, from a signed-in account that is not yet eligible, with
  an explicit allowlist. It is not per-route code. Inventory oracle for (a):
  `for f in artifacts/api-server/src/routes/*.ts; do grep -c "router\.\(post\|patch\|put\|delete\)(" $f; done`
  → 20 files, 117 mutating routes (admin 36, reviews 19, localAuth 8, users 6,
  stripe 6, adminEngines 6, ai 5, adminTaxonomyHealth 5, facts 4, memes 3,
  eval 3, auth 3, storage 2, render 2, jobs 2, adminImagePrompt 2,
  shareIntents 1, share 1, import 1, adminReferenceResearch 1). Inventory for
  (b), confirmed members: `GET /facts/hero` inserts into
  `user_fact_preferences` (`facts.ts:218`); the OAuth link entry points are
  GETs (`auth.ts:466-515`, `?link`). A line-window grep over-matches here
  (five false positives on a 60-line window), so Increment 3 runs the oracle
  per handler body (the route's function extent, not a window) and records
  the hit list as a Settled Decision; a GET that writes and is not on the
  list fails T1, which drives each GET with an ineligible session and
  asserts the row count did not change (Astra, round 0, C1).
- **S2. Two reasons a thing is not live, one predicate.** `memes`,
  `user_ai_images` and `upload_image_metadata` each carry `deleted_at` (the
  owner deleted it) and `purge_after`. The second reason, the owner's account
  is leaving, is **not a column on content**: the predicate joins the owner's
  active `account_deletion_requests` row (`cancelled_at IS NULL`), so a row
  written by work already in flight when the request was accepted — an
  upload whose metadata lands after moderation (`userImageUpload.ts:379`), a
  meme whose row lands after its async render (`createMemeRecord.ts:403`) —
  is hidden by the same rule with no copied state to keep right, and
  cancelling a deletion is one update to the request row (Astra, round 2,
  C4). A row is live when `deleted_at` is null and its owner has no active
  request; that test lives in one helper (`lib/contentVisibility.ts`'s
  `liveContent(table)`) that every reader uses; a reader that spells the
  predicate itself fails the review. A thing the owner deleted by hand stays
  deleted through a cancelled account deletion (Astra, round 1, C3.2). (v3–v5
  had a third marker, `source_hidden_at`; David's answer 5(a) removed the
  dependency it tracked, S16.) Reader inventory, as an aid and not a proof
  (Astra, round 1, C9): `git grep -ln "from(memesTable)\|memesTable"` →
  confirmedFactTextEdit, createMemeRecord, reactions, admin, memes, og,
  shareCopy, shareIntents, users; `git grep -ln "userAiImagesTable\|user_ai_images"`
  → imagePromptJobs, objectAccess, admin, users (the raw-SQL listing at
  `users.ts:677`). The restore window applies to **everything in My content**
  — raw uploads, derivatives, `user_ai_images` and memes alike — by David's
  23:13 amendment to oracle item 6 (a webcam photo has no copy on the
  device). One rule, one window, one purge job; an object is not touched in
  storage until its row is purged, and the purge still goes through
  preserve-before-change (S15).
- **S3. The former-member credit is a column, not a null.** `facts` gains
  `submitter_deleted_at`; the FK is nulled at purge and the column set, so a
  fact with no submitter (dev's imported rows) is distinguishable from one
  whose submitter left. Phase 6 decides what the public sees of either.
- **S4. Age is a date, derived at read; under-13 is refused, not destroyed.**
  `users.date_of_birth date`; `is13Plus`/`is18Plus` are computed in
  `authMiddleware` onto `req.user` and never stored. A date under 13 is
  refused before any write — no draft, no column — and the account is left
  as it was: unable to act, able to be deleted by its owner (a verified,
  un-onboarded account may request deletion, the one write beyond recovery
  that state allows) or by the retention rule David chooses for **new**
  registrations only (readout item 6; Astra, round 2, C8). v1 deleted the account on
  the spot; that was a product decision no one had made, and a mistyped year
  on an established account would have destroyed it (Astra, round 1, C8).
- **S5. Consent is a record.** Three columns, not a boolean:
  `marketing_consent_at`, `marketing_consent_method` (`default_checked` |
  `ticked` | `declined`), `marketing_consent_wording_version`. The default
  is decided server-side from Cloudflare's `CF-IPCountry` request header
  (Cloudflare docs, *IP geolocation*: "IP geolocation adds the CF-IPCountry
  header to all requests to your origin server"); absent header (dev, tests)
  → unchecked. **No Terms acknowledgement is recorded in Phase 5** (David,
  answer 3, over Astra's and Claude's recommendation of minimal versioned
  text now: *"no point in writing something useless now. We'll do it right
  once."*); Phase 14 adds the pages, the acknowledgement columns and the
  re-ask, which rides the same onboarding redirect.
- **S6. Turnstile first, as a vendor swap.** `lib/captcha.ts` is the one
  server verifier (`git grep -n "verifyCaptcha("` → ai.ts:345, facts.ts:515,
  share.ts:150, users.ts:781); the web has four render sites
  (FactComments.tsx:319,380; Onboard.tsx:300; SubmitFact.tsx:499). The swap
  changes the verifier and the widget and nothing else, so it ships alone
  before the onboarding redesign moves the registration challenge.
  Turnstile's documented test keys (Cloudflare docs, *Test your Turnstile
  implementation*: sitekey `1x00000000000000000000AA` with secret
  `1x0000000000000000000000000000000AA` "will always result in successful
  validation") are what CI and the production-mode e2e use; the real keys
  are production secrets.
- **S7. OAuth trusts the provider's verified claim only.** `upsertUser`
  (`auth.ts:148-207`) sets `email_verified_at = now()` when the ID token's
  `email_verified` is `true` (Google: boolean; Apple: the string `"true"`,
  per Apple's token shape, `unable to verify: Apple's current documentation
  page; the implementation reads both forms`). Any other value leaves the
  account unverified and the local verification flow applies.
- **S8. Verify, then onboard, then act.** The order is enforced by the one
  gate: an unverified account may only verify, resend, log out, reset a
  password or confirm an email change; a verified but un-onboarded account
  may additionally complete onboarding; an eligible account may act. The
  consent record is therefore always bound to a verified identity,
  which is also what proof-of-consent wants (Astra, round 0, C1; Claude
  agreed, replacing v1's onboarding-before-verification).
- **S9. Shared deletion core.** `routes/admin.ts:462-653`'s hard delete is
  factored into `lib/accountDeletion.ts` and called by both the admin route
  and the purge job, so there is one definition of "what deleting an account
  does" and `ncmec_reports` survive it by the schema (`ON DELETE SET NULL`),
  not by a check.
- **S10. The Replit-copy rule.** No Phase 5 migration relies on a function or
  trigger existing in production unless that migration creates it (Replit's
  publish copies tables only, measured 2026-10-30).
- **S11. The pronoun default lives in two places today** (schema default and
  `seed.ts:30`'s boot DDL); both go in the same migration, or the boot path
  reintroduces what the migration removed on a database where the column is
  missing.
- **S12. 18+ is enforced at every photo-upload route**, avatar and meme
  (`storage.ts`'s `upload-avatar`, `upload-meme`, `uploads`), from the
  derived `is18Plus`. The parent plan and the launch definition both say
  "18+ for photo upload"; v1 derived the value and forgot the boundary
  (Astra, round 0, C2). Date-derived adulthood and the dormant
  `adult_verified_at` stay separate.
- **S13. The live NSFW opt-in is made unavailable.** `nsfwModeEnabled` is
  removed from the profile PATCH body and the admin editor, and its consumers
  (`createMemeRecord.ts:332`, `userImageUpload.ts:238`) pass `false`; the
  column stays until a contract step. Oracle: `git grep -n
  "nsfwModeEnabled\|nsfw_mode_enabled" -- artifacts/api-server/src
  artifacts/overhype-me/src lib/db/src` → the sites above plus
  `authMiddleware.ts:111,142`, `admin.ts:257`, `users.ts:257-367`,
  `admin/users.tsx` (5 sites), the fixture allowlist. Covered by the settled
  decision that NSFW is post-launch (`launch-definition.md`, the cut list),
  so it is named, not asked (Astra, round 0, C5).
- **S14. One deletion engine, with exclusive control of destructive work.**
  `lib/accountDeletion.ts` owns every transition of
  `account_deletion_requests`; the admin route and the self-service route
  are callers. Accepting a request writes the row and revokes sessions in
  one transaction **under the admin population lock**
  (`adminLockoutGuard.ts:103`, `assertAdminPopulationSurvives`, whose
  reachable-admin predicate learns to exclude suspended and
  deletion-pending accounts), so removing access can never remove the last
  administrator; suspension takes the same lock in the same way. Hiding
  needs no further write (S2). The moment the accept commits, the engine
  kicks the non-destructive stages — cancel every cancellable subscription
  (`active`, `trialing`, `past_due`, the gap `stripe.ts:604` documents;
  retry on failure; an already-cancelled one converges), refresh the
  entitlement source, send the email — and the hourly worker is recovery
  for whatever that kick did not finish; only the destructive stage waits
  for `purge_after`. `cancel` and `enter purging` are a compare-and-set on
  `stage`, so exactly one wins. **Every destructive claim serializes with
  the account's transitions**: the content purger and the account purge
  take a per-owner advisory lock (`pg_advisory_xact_lock` on the owner id)
  and re-evaluate the live predicate and the request's state inside it
  before touching bytes, so a trash candidate selected a moment before an
  acceptance cannot destroy what a dispute hold is keeping (Astra, round 2,
  C4). "Purge now" is the same lifecycle with `purge_after = now()`,
  dispute-checked. The purge deletes the person's memes, comments, links,
  pending reviews, generations and uploads (collected by `user_id`, not only
  through memes), deletes each meme's own baked file (S16) and never the
  photo a meme was made from (`admin.ts:588-590` deletes `src.uploadKey`
  today and is not reused: that photo is its own row with its own
  lifecycle), removes their reactions and refreshes
  the surviving targets' aggregates through `reactions.ts`'s existing
  recompute. A failed object delete leaves `purging` unfinished and counted
  (Astra, rounds 1 and 2; all verified).
- **S15. Two retentions, named apart.** Removal from the live service and the
  user's restore window are this plan's; the 7-day backup of every destroyed
  object state is the 2026-10-29 decision's and is not bypassed. User copy
  says "removed from Overhype.me", never "no copy remains".
- **S16. A meme is a file from the moment it is saved.** David, 2026-10-30
  ~23:50, after research (the oracle's *Now / next / never* records the
  evidence): the server renders the meme once at save with the same
  renderer (`generateMemeBuffer`, `memeGenerator.ts:179`) and stores the
  JPEG; `GET /memes/:slug/image` serves the stored file — the route's
  existing *"legacy path: memes stored before recipe-based rendering"*
  (`memes.ts:500-512`) revived as the only path; the recipe fields
  (`imageSource`, text options, framing, aspect) stay on the row as
  metadata for Phase 6's remix and for provenance, and the source reference
  is informational only. Baking is server-side from stored inputs, never
  from the browser's canvas, so the NSFW classifier scores the bytes that
  will be served; the unused client-preview branch (`createMemeRecord.ts:315`,
  no caller in the web) goes. A one-time idempotent backfill bakes every
  existing recipe meme (dev only; production has none), recording
  `memes.baked_at`. Consequences: deleting a photo touches no meme; the
  `MEME_RENDER_VERSION` ETag becomes a plain content ETag; the media backup
  holds every meme as the user saw it. Purging a meme deletes its own file
  and never the photo it was made from (S14).
- **S17. Hidden means refused at the byte path, and the edge is named.** The
  storage read routes, `GET /memes/:slug/image` and `objectAccess.ts` consult
  the live predicate and answer 404 for a non-live object; OG and share
  surfaces already branch on `deletedAt` (`og.ts:178`) and move to the
  predicate. What no origin change reaches: a copy in a browser (1h) and the
  public copy at Cloudflare's edge (24h), which the Worker sets on every
  public 200 (`cloudflare/og-router/src/index.ts:91`) and which **new
  viewers** can be served through site images and link previews. The
  alternatives — accept and state it; a Cloudflare purge call per deleted
  object (origin-controlled, cannot touch browsers); `no-store` or
  revalidation on deletable user media (a performance cost and a transition
  period) — are David's, readout item 5b (Astra, round 1, C3).
- **S18. The Library is extended, not duplicated.** `Library.tsx:94-140`
  already lists uploads, reference images and memes with delete; the three
  routes gain cursor pagination (today: uploads `bg_display_limit_upload`=20,
  memes `.limit(100)` at `users.ts:658`, AI images `LIMIT 200` at
  `users.ts:707`, one image type) and a Recently deleted view.
- **S19. Eligibility is decided from the loaded row, never by dropping it.**
  `authMiddleware.ts:114` filters `is_active=false` and proceeds anonymously,
  so no later gate can name a reason. v3: the middleware loads the row
  regardless, attaches `req.user.eligibility` (one of `eligible |
  suspended | deletion_pending | unverified | unonboarded`), and the gate
  decides. `is_active=false` keeps exactly one meaning, the lockout guard's
  purge reservation, and suspension never writes it (v2 did; Astra, round 1,
  C1); 0117 sets the legacy deactivated rows to `suspended_at` **and back to
  `is_active=true`**, so the login paths and the admin count that still read
  the field (`auth.ts:372`, `adminIdentity.ts`) see one meaning, and
  unsuspend has nothing to undo there (Astra, round 2). The transition table (Proposed Design) says whose identity is checked
  at each entry point: ordinary sign-in, the verification link (which mints
  a session, `localAuth.ts:499-526`), the OAuth link callback (which mutates
  the pending target, `auth.ts:307`), pending-email confirmation, deletion
  cancellation, suspension.
- **S20. An unverified provider claim never attaches to an existing account.**
  `upsertUser` matches by email (`auth.ts:154`). A claim without
  `email_verified` that matches an existing account is refused with a
  message naming the other way in (password, or the verification link);
  a verified claim matching an existing unverified account verifies it,
  which is how the bootstrap administrator's account verifies itself on its
  next Google sign-in rather than through the admin override.
- **S21. A public read keeps its read.** `GET /facts/hero` answers as today
  for an ineligible account and skips its `user_fact_preferences` write
  (`facts.ts:218`, `ON CONFLICT DO UPDATE`); the same rule for any incidental
  write the per-handler inventory finds.
- **S22. Onboarding resumes from a saved draft.** `users.onboarding_draft
  jsonb` holds the form's state for a verified account between visits;
  completion requires a fresh Turnstile token (tokens are single-use and
  expire in five minutes, Cloudflare server-side validation docs). A date
  under 13 is refused before the draft is written. Pronoun precedence:
  saved draft → the account's existing choice → the visitor's preserved
  device choice (new accounts only) → the name suggestion → blank and
  required. `AuthProfileSync` (`App.tsx:80`) writes account values back to
  the browser, so a share link's pronouns can never overwrite an account's
  (Astra, round 1, C7).
- **S23. The captcha column dies in two releases.** Increment 3 stops every
  read and write of `captcha_verified` — the middleware, the session blob
  fallback, the OAuth and local-auth row reads, the bypass logic, which
  moves to `onboarding_completed_at` — while the column still exists;
  Increment 7 drops it (`migrations-and-backfills.md`, *Expand, then
  contract*; Astra, round 1, C10).
- **S24. Share-by-email gets a widget, not a swap.** `ShareModal.tsx:277`
  posts `/api/share/invite` with no token and `share.ts:150` refuses without
  one, so a challenged caller cannot share by email today. Increment 1 adds
  the widget and token transport there; the two comment variants and the
  submit and onboarding sites are swaps (Astra, round 1, C11).

## Repo Context Inspected

`artifacts/api-server/src/`: `app.ts` (middleware order 237-344), `middlewares/authMiddleware.ts`, `middlewares/tierMiddleware.ts`, `routes/auth.ts` (upsertUser 148-207, callback 370-400), `routes/localAuth.ts` (register 84-218, reset 367-440, set-password 613-670), `routes/users.ts` (me, uploads, memes, ai-images, complete-onboarding), `routes/memes.ts` (delete 605-630), `routes/facts.ts` (submitter 46-80, authorName 482-549), `routes/admin.ts` (delete 462-653, Stripe cancel 588-632), `lib/captcha.ts`, `lib/dataLifecycle.ts`, `lib/email.ts` (builders 465-835), `lib/featureAccess.ts`, `lib/mediaBackup/*`, `jobs/transientRenderPurger.ts`, `index.ts` (schedulers 147-190), `lib/seed.ts` (ensureSchema), `testing/legacyFixture/allowlist.ts`, `__tests__/routes.google.callback.test.ts`.
`lib/db/src/schema/`: `auth.ts`, `memes.ts`, `userAiImages.ts`, `facts.ts`, `featureFlags.ts`, `membershipEntitlements.ts`. `lib/db/migrations/` (0099, 0113 last), `lib/db/src/migrate.ts` policy in `docs/engineering/migrations-and-backfills.md`.
`artifacts/overhype-me/src/`: `pages/Login.tsx`, `pages/Onboard.tsx`, `pages/Library.tsx`, `pages/Profile.tsx`, `pages/admin/users.tsx`, `components/facts/FactComments.tsx`, `lib/infer-pronouns.ts`, `lib/identity.ts`; `e2e/authJourney.spec.ts`, `e2e/identityFlow.spec.ts`.
Docs: `accounts-and-auth.md`, `membership-entitlements.md`, `security-model.md` (headings), `launch-definition.md`, `launch-feature-inventory.md`, `docs/tests/TESTING.md` (*Deploy-selectable doubles*), `docs/engineering/media-backup-and-restore.md`, `decisions.md` (2026-10-29 photo preservation), `known-failure-patterns.md` (headings; *A live FK's ON DELETE SET NULL*, *Async enqueue treated as completion*, *Editing an already-merged migration*).

## Current Behavior

As *Problem* states, grounded in `accounts-and-auth.md` and the lines cited
there. Three facts the design leans on: (1) `req.user` is rebuilt from the
database on every request (`authMiddleware.ts:88-141`), so a new identity
property is one select away from every route; (2) meme soft-delete exists and
public reads already filter it in the files S2 lists; (3) the admin hard
delete is already staged with a `currentStage` tracker and a
`reserveAccountForDeletion` lock (`admin.ts:82-96`), so the state machine
extends a shape rather than inventing one.

## Source-of-Truth Analysis

| Concept | Source of truth | Second place today | After |
|---|---|---|---|
| "verified email" | `users.email_verified_at` | none (gates nothing) | the same column; the gate reads it via `req.user` |
| "onboarded" | `users.captcha_verified` + session blob fallback (`authMiddleware.ts:124`) | two | `users.onboarding_completed_at`, read from the row only; `captcha_verified` dropped in the contract step |
| pronouns default | schema default **and** `seed.ts:30` | two | neither; a null column means "not yet chosen" |
| "content not live" | `memes.deleted_at` | n/a for images, uploads | `deleted_at` on three tables plus the owner's active deletion request, behind one predicate, `liveContent`; one purge job |
| "account leaving" | admin `is_active=false` (deactivate) | conflated with suspension | the active `account_deletion_requests` row, read by the content predicate; `is_active=false` keeps only its purge-reservation meaning |
| "suspended" | `users.is_active` | shares a column with deactivation | `users.suspended_at` (+ reason, by whom); never written through `is_active` |
| consent | none | — | the three marketing-consent columns, written once per wording version; Terms are Phase 14's |
| grid feature `beta_overlay` | `feature_flags` + `tier_feature_permissions` | — | the same tables, rows inserted by migration in 0099's shape |
| a meme's image | the recipe row, rendered at every view (`memes.ts:565`) | the renderer's version, folded into the ETag | the stored file, baked once at save (S16); the recipe stays as metadata |

No new concept gets a second home. The onboarding screen reads the pronoun
suggestion from the same browser table the Login page uses
(`infer-pronouns.ts`), and the device identity store (`identity.ts`) stays
the source of a visitor's pre-sign-up choice.

## Proposed Design
**One onboarding screen, every method, after verification.** The gate's
order is S8. For a local sign-up the first screen after registering is
"check your email"; the link verifies and lands on `/onboard`. For a
provider sign-up with `email_verified` true, `/onboard` is immediate; without
it, the same email step; a claim matching an existing account follows S20.
`/onboard` is one form: pronouns (precedence per S22), date of birth (three
fields, no threshold shown), the marketing box (default from
`GET /auth/onboarding`: `{ marketingDefault, marketingWordingVersion,
pronounsSuggestion, draft }`), and a Turnstile widget (no Terms line, S5). `PUT /users/me/onboarding/draft`
saves progress (verified accounts only; a date under 13 is refused with
`UNDER_AGE` and nothing is written). `POST /users/me/onboarding` verifies a
fresh token, refuses under-13 the same way, else writes `date_of_birth`,
`pronouns`, the consent columns, `onboarding_completed_at`, clears the
draft, in one transaction. Nothing
writes `captcha_verified` any more (S23).

**Who is sent there.** The web shell redirects any signed-in account whose
`onboarding_completed_at` is null, with `returnTo` (Phase 14's Terms
version will reuse this redirect); the gate enforces the same server-side. The
OAuth `isNewUser` redirect goes. Existing accounts (dev's 26, David's) are
asked once; a stored `he/him` is shown for confirmation, never assumed.

**Eligibility and the gate.** `authMiddleware` loads the row whatever its
state (S19) and sets `req.user.eligibility`. `requireEligibleActor` runs
after it: for a signed-in request that is an unsafe method or an inventoried
mutating GET, refuse 403 with one code in precedence order
`ACCOUNT_SUSPENDED`, `DELETION_PENDING`, `EMAIL_VERIFICATION_REQUIRED`,
`ONBOARDING_REQUIRED`, `ADULT_REQUIRED` (photo-upload routes only, S12),
unless the route is on the exception list for that state. The exception
list is one exported table, state → routes. Anonymous requests are
untouched (Phase 6, D21).

| Transition | Whose state is checked | Allowed while… |
|---|---|---|
| ordinary sign-in (local, OAuth) | the account being signed into | not suspended; deletion-pending → session minted, lands on the cancel screen only |
| verification link (`/auth/verify-email`) | the token's account | not suspended, not deletion-pending; sets `email_verified_at`; mints a session only if the above hold |
| OAuth link callback (`?link`) | the pending target account (`auth.ts:307`) **and** the signed-in session | target eligible; a mismatch refuses with `link_error` |
| pending-email confirmation | the account owning the pending email | eligible |
| onboarding draft and completion | the session's account | verified, not suspended, not deletion-pending |
| deletion request | the session's account | eligible, or verified and un-onboarded; re-authenticated; under the population lock |
| deletion cancel | the session's account | deletion-pending (the one write that state allows) |
| suspend / unsuspend | the admin's session (`requireAdmin`); the target is any account | suspend under the population lock (never the last reachable admin); revokes the target's sessions |
| recovery routes (resend, logout, forgot/reset) | the session's or token's account | any state but suspended, where only logout works |

**Turnstile.** `lib/captcha.ts` posts to
`https://challenges.cloudflare.com/turnstile/v0/siteverify` with
`TURNSTILE_SECRET_KEY`; fail-closed in production without the key, skip with
a warning in dev (the existing policy, #700). The web renders Cloudflare's
widget with `VITE_TURNSTILE_SITE_KEY` at the submit, onboarding and two
comment sites, and adds it to the share modal's email path (S24).
`@hcaptcha/react-hcaptcha` and `HCAPTCHA_*` are removed.

**My content.** The Library's existing tabs list everything with cursor
pagination (S18), each item with Delete. Deleting anything — photo,
generation, derivative or meme — sets `deleted_at` and `purge_after = now()
+ window`; it appears in Recently deleted with Restore until then, and its
storage object is untouched until the purge. Deleting a photo touches no
meme, because every meme is its own file (S16); deleting a meme never
deletes the photo it was made from (S14). `POST .../restore` clears `deleted_at` inside the
window; a restored row is live if its owner has no active deletion request.
Quarantined rows (`memes.status='quarantined'`, uploads with an Arachnid
match) never appear. Every read, the storage byte path included, goes
through `liveContent` (S2, S17).

**The purge job.** `jobs/contentPurger.ts`, hourly from `index.ts` in the
transient-render purger's pattern: rows with `purge_after < now()` and
`deleted_at` set are candidates; each is claimed under its owner's advisory
lock, where the predicate and the owner's request state are re-read — an
owner with an active deletion request skips the row, leaving it to the
account branch and its dispute hold — before its objects are deleted
through preserve (the 7-day backup keeps them, S15) and the row deleted;
the window is `content.restore_window_days` in `admin_config`, default 30.
Rows with `purge_after` null (pre-existing tombstones, 0103/0106/0107's
retired content) are never selected. Idempotent: an object already gone
proceeds; a preserve refusal (503) leaves the row for the next run and is
counted.

**Account deletion.** `account_deletion_requests(user_id PK → users ON
DELETE CASCADE, requested_at, purge_after, cancelled_at, stage,
stage_updated_at, hold_reason, last_error, attempts)`; `stage` ∈
`accepted | subscription_cancelled | notified | held | purging | done`,
advancing only by compare-and-set on the previous value. `POST
/users/me/deletion` (re-authentication, readout item 2; open to an eligible
account and to a verified, un-onboarded one) runs **accept** in one
transaction under the admin population lock (S14): insert the row, delete
the person's sessions. Their content is hidden by the predicate from that
commit (S2). The engine then kicks the non-destructive stages at once —
cancel every cancellable subscription (`active`, `trialing`, `past_due`;
retry on failure; an already-cancelled one counts as done; refresh the
entitlement source and let `recomputeMembership` run) → send
`buildAccountDeletionScheduledEmail` → `notified` — and the hourly worker
(account branch) advances whatever an interrupted kick left unfinished. Signing in during the
window mints a session that the gate confines to the cancel screen
(`DELETION_PENDING`). `POST /users/me/deletion/cancel` compare-and-sets
`cancelled_at` on a row not yet `purging`, which makes the person's content
live again through the predicate (a hand-deleted or source-hidden item stays
as it was), and confirms by email; a cancelled
account's paid access is whatever its remaining entitlements derive (an
admin grant or lifetime purchase keeps Legendary; the cancelled subscription
is gone, readout item 4). Once `purge_after` has passed the worker tries the
compare-and-set `notified → purging`; a cancel that lands first wins, a
purge that lands first makes cancel return 409. Before `purging`, any
non-terminal dispute on the person's entitlement sources
(`entitlement_source_disputes`) sets `held` with the reason and retries next
run. `lib/accountDeletion.ts`'s purge then, under the owner's advisory lock
(S14): deletes owned objects via preserve (a failure leaves `purging` with
`last_error`), deletes memes, comments, links, pending reviews, uploads and
generations of the person, removes their reactions and refreshes each
surviving target's aggregates, nulls `facts.submitted_by_id` with
`submitter_deleted_at = now()`, runs the admin path's explicit deletes,
deletes the user row, lets the cascades run (`ncmec_reports.user_id` set
null by its FK). Admin Users shows the request with Cancel and Purge now;
the admin hard-delete route calls this engine (S14). The same worker opens a
request, with the ordinary 14-day window and an email, for any account
created under this onboarding flow that has not completed it 30 days after
creation and has no active request (David, answer 6); accounts created
before Increment 3 are never selected.

**Suspension.** `users.suspended_at`, `suspended_reason`, `suspended_by`.
`PATCH /admin/users/:id` gains `suspend`/`unsuspend`; suspending runs under
the admin population lock and revokes every session. Sign-in paths refuse `ACCOUNT_SUSPENDED` before minting a
session; an existing session's next write is refused by the gate; `is_active`
is not written (S19). Catalogue content is untouched.

**Hardening.** Reset: `UPDATE password_reset_tokens SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING
user_id`; proceed only on a returned row, and write the new hash and the
session revocation in the same transaction. Every password writer
(`set-password`, `reset-password`, admin `set-password` at `admin.ts:2415`,
admin create-with-password) revokes the user's other sessions with the query
reset already runs (`localAuth.ts:425-437`), keeping the caller's own `sid`
where there is one. The admin route's API-key authorization is Phase 15's.

**NSFW readiness.** `facts.audience`, `memes.audience`,
`user_ai_images.audience` (`general` | `adult`, default `general`, CHECK);
`users.adult_verified_at`. Read by nothing. The live opt-in is withdrawn
(S13). A migration inserts the `beta_overlay` feature flag and its tier
rows, all disabled, in 0099's shape, bumping the grid revision.

## Data Model and Migration Impact
Every migration is forward-only, idempotent (`IF NOT EXISTS`, `ON CONFLICT
DO NOTHING`), observable (`RAISE NOTICE` counts where rows move), right on
both runner paths (fresh baseline + migrations; long-lived dev), and named
expand or contract in its PR body. Pre-Seed latitude applies (no release is
published to users yet), but the expand/contract order is kept so the habit
is in place when it binds.

| # | Migration | Kind | Row states |
|---|---|---|---|
| 0114 | `users`: add `onboarding_completed_at`, `onboarding_draft jsonb`, `date_of_birth`, `marketing_consent_at`, `marketing_consent_method`, `marketing_consent_wording_version`; drop the `pronouns` default (and `seed.ts:30`'s DDL, S11) | expand | old rows: all new columns null → "ask at next sign-in"; `pronouns` keeps its stored value, shown for confirmation; no backfill |
| 0115 | `memes`: add `purge_after`, `baked_at`; `user_ai_images`, `upload_image_metadata`: add `deleted_at`, `purge_after`; partial indexes on the live predicate; the backfill bakes recipe memes and sets `baked_at`, idempotent | expand + backfill | pre-existing meme tombstones keep `deleted_at` with `purge_after` null: not live, not restorable, never purged (0103/0106/0107's retired content stays retired); no backfill |
| 0116 | `account_deletion_requests` table (CHECK on `stage`); `facts.submitter_deleted_at` | expand | none affected |
| 0117 | `users`: `suspended_at`, `suspended_reason`, `suspended_by`; backfill `suspended_at = updated_at, reason = 'legacy deactivation', is_active = true` where `is_active = false` and no deletion request exists | expand + backfill | dev's deactivated rows read as suspended and `is_active` returns to its one meaning (S19) |
| 0118 | `audience` columns with CHECK; `users.adult_verified_at`; `beta_overlay` grid rows | expand | none affected |
| 0119 | drop `users.captcha_verified` | contract | runs only after Increment 3's release, which reads and writes it nowhere, is the published one (S23) |

Rollback is a new forward migration (policy); a contract step is reversible
by re-adding the column null. No trigger or function is added, so S10 is
satisfied trivially; if the design review adds one, it ships in the runner
migration. The legacy fixture allowlist (`legacyFixture/allowlist.ts:182,193`)
gains the new columns as `synthetic:` entries so the fixture still scrubs
cleanly.

## Runtime Behavior
- A fresh Google sign-up with `email_verified=true`: row created verified →
  onboarding → can act. With the claim absent: the "check your email" step,
  the link, then onboarding. A claim without verification whose email
  matches an existing account: refused with the other way in named (S20).
- A local sign-up: logged in immediately (unchanged); the only thing the
  account can do is verify; the link lands on onboarding; then it can act.
- David's production account: his next Google sign-in carries a verified
  claim, which verifies the existing account (S20); then onboarding once.
- A reload mid-onboarding: the draft comes back; completion asks for a fresh
  challenge.
- Under-13: refused, nothing stored, the account stays unable to act; what
  happens to it afterwards is readout item 6.
- Deleting a generation or meme: gone from every list, page and byte path at
  once (the edge residue is item 5b); in Recently deleted for 30 days;
  restored in one click; purged by the hourly job after.
- Deleting a photo: the photo sits in Recently deleted for the window and is
  purged after it (the backup keeps it seven more days); every meme made
  from it is untouched, because a meme is its own file.
- Saving a meme: the server bakes it once and stores the file; viewing it,
  anywhere, serves that file.
- Requesting account deletion: signed out everywhere and content hidden in
  the same instant; billing is cancelled and the email sent right after, the
  hourly worker finishing either if the first attempt failed;
  signing in shows only the cancel screen; 14 days later the purge runs,
  facts stay credited "a former member" (Phase 6 decides display), an open
  dispute holds it with the reason visible to admins; a crash anywhere
  resumes from the recorded stage.
- Suspended: cannot sign in; an existing session's next write is refused;
  catalogue untouched.

## Admin/User UX Impact

Onboarding (new form; loading, validation, under-age, Turnstile failed,
saved; no Terms line), the gate screens (verify prompt with resend; suspended; cancel
deletion), My content (empty, list, Recently deleted empty/list, restore
success, purge-date copy, the "N memes will be made independent" confirmation), account deletion (confirm with password or provider re-auth, scheduled
state in Profile, cancelled), Admin Users (suspend/unsuspend with reason,
deletion request panel with Cancel / Purge now, stage and hold reason
shown). Async status: the purge job is background with no user-facing
promise beyond the date, so the two-altitude rule is satisfied by the
Recently deleted list showing each item's purge date (per item) and the
admin deletion panel showing stage and last error (aggregate). Copy follows
`overhype-design`.

## Security, Permissions, and Validation

- The gate is server-side, after `authMiddleware`, allowlist explicit and
  tested (Testing, T1). Client redirects are convenience only.
- Turnstile verified server-side on every challenged route; the token is
  single-use at Cloudflare.
- Re-authentication for deletion; the request and cancel routes are
  rate-limited by user.
- Under-13 handling stores nothing: the refusal happens before any draft,
  consent or date write, and destroys nothing (S4).
- Suspension and deletion are admin-visible only; no public surface says why
  an account is gone.
- `requireAdmin` on every admin addition; zod schemas regenerated through
  `lib/api-spec` (never a hand edit of `lib/api-zod/src/index.ts`).
- Child-safety: `ncmec_reports.user_id ON DELETE SET NULL` is the construct;
  the plan adds a test that a purge leaves the row.

## Testing Plan
Runner commands per `docs/tests/TESTING.md`. Searches are inventory aids;
each claim below is proven by driving the real path with fixtures (Astra,
round 1, C9).

- **T1 — the gate policy (CI).** The test holds its own copy of the state →
  exception table, written from this plan, and diffs it against the
  middleware's export, so a change to either is a visible decision. For each
  eligibility state it mounts the real app and drives: one representative
  route per route file with an unsafe method (403 with the state's code);
  every exception route for that state (reaches its handler); every
  inventoried mutating GET (200, and a before/after snapshot of the rows it
  writes is unchanged). Anonymous requests are asserted untouched.
- **T2 — identity transitions (CI).** For every row of the transition table
  a test drives the real entry point against an account in each state. The
  Google and Apple callback tests (`routes.google.callback.test.ts` and the
  Apple one) gain: a verified claim sets `email_verified_at`; an unverified
  claim on an existing account is refused; a visitor's preserved pronoun
  choice survives OAuth sign-up and onboarding completion unchanged; a stored
  choice survives a share link's pronouns in the browser.
- **T3 — the deletion state machine (CI, real database).** `lib/accountDeletion.ts`
  under: a crash after accept (content stays hidden, worker completes
  billing); Stripe failing then succeeding; a cancel racing the worker at
  `notified → purging` (exactly one wins, the loser sees 409 or a no-op);
  a dispute holding both the account purge and the content purger; a
  repeated request (idempotent); standalone uploads collected; `ncmec_reports`
  row survives; facts credited; reaction aggregates on surviving targets
  recomputed; a `past_due` subscription cancelled; an already-cancelled one
  converging; an upload whose metadata lands after acceptance is hidden; a
  trash candidate selected just before a dispute-held acceptance is not
  destroyed; two concurrent removals of the remaining administrators leave
  one.
- **T4 — content visibility (CI).** Fixtures in each of the two states
  (deleted, owner deletion-pending) and live; each identified listing,
  serving (`/storage/*`, `/memes/:slug/image`), rendering, OG, restore and
  reuse path is driven and asserted. A `purge_after`-null tombstone is
  neither listed in Recently deleted nor purged. A meme saved then its
  photo deleted and purged still serves byte-identical; the backfill bakes
  a recipe meme, is a no-op on re-run, and the served bytes match the
  renderer's output for that recipe; purging a meme leaves its photo.
- **T5 — Turnstile (CI).** `lib/captcha.ts` against Cloudflare's always-pass,
  always-fail and spent-token test secrets; each of the five challenged
  paths (submit, two comment variants, onboarding, share-by-email) refuses
  without a token or with a failing one in production mode and admits a
  passing one; the existing bypass entitlements still bypass.
- **T6 — scripted journeys for every sign-in method (E2E).** The
  production-mode launcher gains an OAuth issuer the way it gained the mail
  sink: through its isolated test entrypoint, never as a deploy-selectable
  double (`doubleSelection.ts:119` refuses those in production mode, by
  design). Each journey: sign up → refused until verified → verify → onboard
  (reload mid-way, draft returns) → first write succeeds. The live Google
  and Apple configuration is a Post-merge verification item, read on the
  deployed site.
- **T7 — 18+ at upload (CI).** Each photo-upload route refuses a verified,
  onboarded account whose date of birth is under 18 with `ADULT_REQUIRED`
  and admits one over 18; a date one day either side of the boundary.
- **T8 — the NSFW opt-in is gone (CI).** Profile PATCH and admin PATCH ignore
  `nsfwModeEnabled`; the classifier decision receives `false` on upload and
  meme creation whatever the column holds.
- **T9 — hardening (CI).** Two concurrent consumptions of one reset token
  yield one password change; the change and the revocation commit together
  (a failure after the hash write leaves neither); every password-writing
  path ends the user's other sessions and keeps the caller's.
- **T10 — suspension (CI).** A suspended account is refused at local login,
  at the OAuth callback, at the verification link and at the link callback;
  an existing session's next write is refused; unsuspend restores all four;
  a legacy deactivated account migrated by 0117 behaves as suspended and
  unsuspends cleanly.
- **UAT (judgement residue only):** the onboarding feel on each method; the
  wording of the consent line; the Recently deleted, photo-delete
  confirmation and cancel-deletion screens read right. Screen facts are
  assertions or captures.

## Implementation Steps
One PR per increment, each with its migration(s), tests, Post-merge
verification and `## UAT` section; the parent-plan amendment v10 rides
Increment 1's PR with this plan.

1. **Increment 1 — Turnstile for hCaptcha** (S6, S24): verifier, the four
   existing widgets swapped, the share modal's email path given its widget
   and token, env, package removal; T5. No schema.
2. **Increment 2 — Cheap hardening**: atomic reset claim with the revocation
   in the same transaction; every password writer revokes other sessions
   (the admin routes included); S7/S20's verified-claim carry and the
   unverified-claim refusal; T9. No schema.
3. **Increment 3 — Eligibility, one onboarding, the gate**: 0114; the
   middleware loads every row and derives eligibility (S19) over the states
   that exist at this increment (`unverified`, `unonboarded`, `eligible`;
   the `suspended` and `deletion_pending` branches arrive with Increments 5
   and 6, which own their tables, and legacy deactivation keeps working
   until 0117); the gate and its exception table; the transition table enforced at each entry point;
   the onboarding draft and completion routes and screen; the mutating-GET
   inventory run per handler and recorded; 18+ at upload (S12); every `captcha_verified`
   read and write removed (S23); the OAuth issuer in the isolated launcher;
   T1, T2, T6, T7; legacy fixture allowlist.
4. **Increment 4 — Memes as files, My content and undoable deletion**:
   first the bake at save, the stored-file serving path and the backfill
   (S16), then 0115; `lib/contentVisibility.ts` and every reader moved onto
   it; the Library extended with pagination and Recently deleted; the byte
   paths on the predicate (S17); the
   content purger, `content.restore_window_days`; T4.
5. **Increment 5 — Account deletion**: 0116; `lib/accountDeletion.ts` as the
   one engine with the atomic accept, the worker, the compare-and-set
   transitions and the dispute hold; the admin route rewired onto it and the
   lockout guard taught about pending deletions (S14); the request/cancel
   routes with re-authentication; the emails; admin panel; T3.
6. **Increment 6 — Suspension, NSFW readiness, the grid row**: 0117, 0118;
   admin suspend; the suspended refusals at every entry point; `audience`
   columns; the live opt-in withdrawn (S13); `beta_overlay` rows; T8, T10.
7. **Increment 7 — Contract**: 0119 once Increment 3's release is the
   published one; docs sweep (`accounts-and-auth.md`, `security-model.md`
   auth section, Manual chapter).

## Risks and Mitigations

- **Locking David out of production.** The gate refuses writes until his
  account is verified and onboarded. Mitigation: the allowlist covers
  verify/resend; the admin verify override exists; T1 proves the allowlist;
  the Post-merge verification of Increment 3 signs in as him before anything
  else.
- **A reader missed in the soft-delete class** shows a deleted image. T4 is
  class-level; the grep is the oracle, in the test.
- **Replit's publish copies tables, not functions.** No function is planned;
  S10 stands as the rule if one appears.
- **The OAuth e2e double is new infrastructure** and the largest unknown in
  Increment 3. If it proves larger than the increment, it splits out as its
  own PR ahead of 3, in the Phase 2 doubles pattern; the journeys still gate
  Phase 5's close.
- **A GET that writes, missed by the inventory,** lets an ineligible account
  change state. T1 drives every inventoried GET with a before/after state
  snapshot; the per-handler oracle is recorded as a Settled Decision in
  Increment 3, as an inventory aid rather than a proof.
- **Under-13 after sign-up** means an account row exists that cannot act
  and holds only what sign-up took. Flagged for Phase 14's counsel pass;
  item 6's retention rule bounds it; moving the date before local sign-up is
  cheap if required.
- **The bake changes the save and serve path for every meme.** The
  serving code is the revived legacy path, not new; the backfill is
  idempotent and observable; T4 compares served bytes to the renderer's
  output for the same recipe.

## Questions for David

None open. The seven asked in v4/v5 were answered on 2026-10-30 23:17, the
meme storage question at ~23:50 (bake at save, S16), all recorded in the
oracle (*David's answers*) and applied above: 30-day
window (S2); password or provider re-authentication before deletion
(Proposed Design, *Account deletion*); no Terms text in Phase 5 (S5, an
override of Astra's and Claude's recommendation, recorded with the dissent);
subscription cancelled at request, remaining entitlements survive a cancel
(S14); memes baked at save and so independent of their source (S16); the edge residue accepted
and stated in the copy (S17); under-13 refused without destruction and
never-onboarded new registrations cleaned up after 30 days through the one
engine (S4, Increment 5 adds that rule to the worker); a "Keep my account"
button cancels (Proposed Design, *Account deletion*).

## Definition of Done

- Every unsafe `/api` route refuses an unverified or un-onboarded account
  except the allowlist (T1 green), and David can act in production after
  one onboarding pass.
- A Google, an Apple and a local sign-up each reach a working account by
  the same screen (T6 green on all three).
- No account carries pronouns it was not shown (T2 green).
- hCaptcha is gone from the repository and the deploy; Turnstile stands at
  all four sites (T5 green).
- Every meme is a stored file that serves without its photo (T4 green); any
  deleted upload, generation or meme is restorable for the window and gone
  after it; a deleted account is
  hidden at once and purged after 14 days with facts kept, safety records
  intact, a dispute holding it and a cancel racing the purge resolved one
  way (T3, T4 green).
- A suspended account cannot act; the grid holds `beta_overlay` off; the
  `audience` columns exist and nothing reads them.
- A photo upload from an account under 18 is refused (T7 green); the live
  NSFW opt-in is unreachable (T8 green); one reset token yields one password
  change and every password change ends the other sessions (T9 green); a
  suspended account is refused at every entry (T10 green).
- Each PR merged under the sensitive-tier bar; the parent plan is v10; the
  phase's UAT dispositions recorded.
