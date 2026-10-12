# PLAN — Get to launch (parent programme) · v2

Workstream: #628 · Planning loop: `.agents/reviews/get-to-launch/` · Never pushed unless David asks.

```plan-oracle
# Oracle — Get to launch (parent programme plan)

Status: AGREED with David at the scope-of-work gate, 2026-10-05, after an
item-by-item walk of all 222 inventoried features (`docs/plans/LAUNCH_FEATURE_INVENTORY.md`
in the planning session's working tree holds every per-item decision). Pinned
from here; a deliberate change is stamped with `--oracle-changed`.

**Amended 2026-10-05 (David), recorded with `--oracle-changed`:** (1) four
launch stages — Seed → Soft launch → Full launch (US) → Full launch (Global);
(2) the Stripe evidence split replaces the literal live-mode rehearsal (S7);
(3) the full readiness bar holds before Seed (S6); (4) the verification build
is a prerequisite to every product phase; (5) a named exception to the
factory freeze for handbook work a launch phase needs and a second app would
need identically.

## Direction served

`product-direction.md`, *Current product bet*: Overhype.me is pre-launch and
the first thing that matters is **"Get to launch / stability"**; growth and
conversion come after. Two reversals of written direction are David's,
recorded here: **video is deferred** (the direction called it launch-critical)
and **Open Graph previews are launch-critical** (the direction called sharing
polish deferrable).

## Product intent of this increment

One approved, phased plan that (1) defines launch in checkable terms — the
feature set, the explicit cuts, and a readiness list a go/no-go is read
against — and (2) sequences the work that makes the definition true, as
phases each small enough to plan, build, review and verify on their own.
David approves the scope once (done), makes the remaining decisions in
batches at phase boundaries, and judges outcomes rather than driving steps.
He is "by far the slowest part" of the system; the plan minimises his time
and cognitive load.

## Four launch stages, one feature set

- **Seed:** the full launch build on a **fresh production database**, behind
  an invite gate on registration and participation (public meme pages and
  previews stay public — S1). A small trusted group submits facts **and makes
  memes from them** ("part of the testing to see how their submitted facts
  end up looking"); David moderates every fact through the full pipeline.
  Target **50 approved facts**, every one submitted by a real user who is not
  David (no CSV seeding). **The full readiness bar holds before Seed** (S6,
  David: "There's no reason to seed prior"): security review with no open
  highs, the operational safety path usable, spend controls demonstrated,
  the admin console finished, every compliance page and consent flow live.
- **Soft launch:** a wider invited group uses the whole loop; the real-data
  verification pass runs here; friends exercise test-mode payments.
- **Full launch (US):** gate off; live Stripe (per the S7 evidence split:
  every adverse event proven in test mode, the live configuration verified on
  the deployed site, genuine payments observed under the launch watch);
  US-first geography with EU/UK and OFAC-sanctioned countries blocked, proven
  at the deployment edge (S8); Terms state the service is offered in the US.
- **Full launch (Global):** GDPR readiness (data export, cookie consent, the
  EU-representative question, vendor data-processing terms) lands and the
  geography blocks come off region by region.

## Verification is a prerequisite, and devops serves more than one app

Phase 2 (the scripted verification lanes, acceptance workflow, test doubles,
legacy fixture, lane-tagged UAT docs) completes **before any product phase
starts**, so every later phase ships with its mechanical checks scripted and
David's share of a UAT is the human residue. The factory freeze has one
named exception: handbook work a launch phase needs *and* a second app would
need identically is in scope and lands in the handbook, not as Overhype-only
code.

## Launch scope — what ships

**The loop (rebuilt properly, as much time as it needs):** name/pronoun
personalisation; share-link personalisation; **"make this about you" on every
shared meme page** (absent today); share by every modality including email
(#374 fixed); working Open Graph previews for meme pages (#592) **and fact
pages**; public creator pages; reactions (🔥😂❤️🤯, one per person per item)
with a time-decayed "heat" driving Trending and the hero pick while Wilson on
thumbs stays the all-time ranking; "load more" on the feed if launching with
more than ~50 facts; search with the user's own history shown on the search
screen; leaderboard all-time only (dead pills removed).

**Account:** local, Google and Apple sign-in (Apple already verified
working); provider linking; password reset; email change with verification;
**verified email gates every authenticated action** (provider-verified emails
count); one onboarding path for every sign-in method; pronouns chosen on the
device carried through OAuth sign-up, default never "he/him"; generated
avatars; custom photo avatar (Legendary); "My content" (every upload and
generation listed, per-item delete); **self-service account deletion** that
never destroys legally retained safety records; age gate (13+ at sign-up, 18+
for photo upload; compliance phase has the final word); Cloudflare Turnstile
replacing hCaptcha at registration, submission, comments and share-by-email;
marketing consent at sign-up; account suspension.

**Facts and community:** submission; AI tokenising, duplicate check, hashtag
suggestions; thumbs rating; **comments rebuilt** as the hybrid (verified
email, first-comments-held trust gate, per-account rate limit, report button,
AI pre-screen wired in, AI-assisted moderation); report/takedown on facts,
memes and comments; author notifications; library tabs.

**Image memes:** the builder wizard (legacy builders deleted); free tier =
**the fact's moderation-approved hero renders** (test renders saved as the
approved options; aspect ratios and the waiver fallback to be designed), no
templates, no stock photos, no user-facing text-to-image; Legendary = **your
face in the scene**; photo upload accepting PNG and HEIC; caption and split
caption; speech bubbles **finished** on the moderation side; style presets
reviewed against the winning engine; private memes read from the entitlement
grid (#395 fixed); hearts respect visibility (#375 fixed); only a user's own
uploads or creations are offered to them; anonymous visitors preview only —
download, save and share need a verified account; budget-reached states.

**Membership (monthly only at launch; no existing purchases):** Legendary =
face-in-scene AI memes, private memes, custom avatar, branded watermark
removed (free downloads carry one), monthly face-render allowance with a
visible meter, multiple saved reference photos, early access (beta overlay
on). Ad-free and priority rendering are grid rows with nothing to gate yet.
**The entitlement grid is the definition.** Checkout, confirm, cancel,
reactivate, portal, payment history, grace window, refunds and disputes,
`livemode` on entitlements with all pre-existing rows treated as test-mode,
an operator-run reconciliation runbook, the Stripe account boot guard.
"Legendary Pro" (stronger models at higher cost) is a future tier; keep the
tier list, grid and Stripe tagging additive.

**Email (Resend; consent, preferences, tracking and unsubscribe built around
it):** verification, email change, password reset, approve/reject notices,
payment notices, access-revoked notice, admin notifications, welcome email,
**Fact of the Day free for every opted-in user** with share and make-your-own
links, unsubscribe on every list email, share-by-email invite.

**Admin console:** Dashboard **rebuilt with intention** as an operations home
(moderation front and centre; the counts David must act on; testing-harness
controls removed); Facts; Users (+ suspension); Moderation (pipeline intact;
**UI/UX rebuilt** once core functionality is locked; AI-assisted triage,
keyboard review, batch render approval); Billing; Refunds & Disputes; Config
(Zazzle keys and Debug mode removed); Engines (video and PuLID removed; a
default text engine set); Taxonomy Health; Features; Email Queue; Queue
Health; Eval dashboard (admin-only, the engine-evaluation tool); Help, plus a
**user-facing help/guide derived from the same Manual source** on every user
page; new: **Reports/takedown queue, Invites, Read-only mode switch, Safety**.

**Safety and legal (the compliance phase, before the law firm):** Terms,
Privacy, DMCA policy and agent registration (David registers), repeat-infringer
policy, community guidelines, likeness consent at upload, marketing and cookie
consent, NCMEC reporting path (complete the capability or a counsel-confirmed
manual procedure), evidence retention per statute with a purge job, data
rights (deletion now; export deferred to GDPR readiness), geography policy.

**Analytics and ops:** GA4 (configured, measurement ID set) + **PostHog**
(approved) fed by one event call and a defined funnel event list; Sentry
alerts routed to David and a Sentry uptime check; read-only maintenance mode
instead of takedowns; migrations backward-compatible so deploys need no
window.

## Cut, deleted or deferred

Video (pipeline, legacy path, PuLID stage and video engines **deleted**;
rebuilt post-launch on the image pipeline); PuLID everywhere; annual and
lifetime as new sales; Zazzle/merch and the Affiliate screen; Video Styles;
templates; stock photos and **Pexels entirely**; the standalone hashtags page;
dead admin files; Debug mode; route-visit counters; the tester role (docs);
search-history recording stays (David); eval dashboard stays admin-only; NSFW
mode is post-launch (design the audience flag and verified-adult state now,
ship nothing); beta opt-in overlay post-launch; Legendary Pro post-launch;
data export post-launch; public growth surfaces beyond the loop; R2; new
content formats; multi-role RBAC; new vendors beyond PostHog and Turnstile.

## Must not change

- The decisions in `product-direction.md` *Decisions agents should not
  reverse without David* (Visual Concept authoritative; planner/compiler
  split — the engine behind the compiler may change, the split may not; no
  blanket text ban; staged cost-gated moderation; AI baseline vs human
  overrides; `facts.*` as enrichment truth; on-by-default with no rollout
  flags **pre-launch**; two permission rails and union overlays).
- The child-safety boundary: no admin viewer for quarantined evidence, ever.
- The 2026-08-28 disposable-production decision with its four excluded row
  classes and its inversion at launch.
- Codex review and the write-gate on every product PR; UAT per phase.
- No new external vendors without David (PostHog and Turnstile are approved).

## Settled, carried into the plan

- The four-lane verification model (CI gate for invariants; scripted proof
  with evidence; live; human). Only the first enters the per-PR gate;
  everything else re-runnable is on demand. Each remaining UAT step maps to
  one of four dispositions (automated assertion / recorded environment check
  / launch acceptance journey / deferred with its feature); a deferred step
  is not a pass. Ordinary free and paid test accounts, never admin-only
  evidence for paid paths.
- Dev DB preserved as a sanitised legacy fixture; production built fresh from
  code as a launch rehearsal (a schema baseline is needed: migration 0001
  presumes existing tables); backup **and media** restore rehearsed.
- Spend/cost controls hardened as their own phase and launch gate ("no
  runaway cost; I can't afford to cover user spend at scale").
- Engine evaluation (latest image models on the same facts via the eval
  dashboard) picks the default engine; presets tuned after.
- A factory freeze during launch work; `/maintenance` continues.
- Process correction: the between-tool-calls-are-summarised memory note does
  not hold in this client; asks are written once, after tool calls.

## Readiness criteria (checkable; each launch reads them)

1. Scope approved; every route and admin screen is in it or removed.
2. Production database built from code alone, rehearsed; backup + media
   restore rehearsed with recovery time recorded.
3. Stripe monthly lifecycle and every adverse event (failed payment, cancel,
   refund, dispute, duplicate/out-of-order webhook, interrupted processing)
   proven **in test mode** with the reconciliation runbook demonstrated;
   retained test purchases shown unable to grant live benefits after the
   mode switch; the live account, price, credentials, webhook and boot guard
   verified on the deployed site; genuine live payments observed under the
   launch watch (S7 — accepted limitation: no adverse outcome occurs against
   real money before the first real customer). `livemode` recorded; unused
   CI Stripe secrets removed.
4. Spend controls demonstrated under concurrency, pricing failure, restart
   and ledger-write failure; a launch capacity and an emergency stop.
5. `/security-review` on the launch scope with no open highs; `ADMIN_API_KEY`
   scoped or gone; `sharp` upgraded or mitigated; CSP enforcing; HSTS
   complete; dependencies triaged; prod dump purged from history.
6. Every in-scope UAT step has a disposition; manual residue fits an
   afternoon; the real-data pass has run on the Repl.
7. Compliance package in place (Terms, Privacy, DMCA agent registered,
   consent flows, age gate, NCMEC path, retention, geography).
8. Alerts reach David; uptime check live; read-only mode works; rollback
   written.
9. UX polish pass completed across every user journey; David accepts the
   catalogue and a representative render sample.
10. Launch runbook with a go/no-go that reads this list per stage: Seed,
    Soft, Full (US), Full (Global).

## Ceremony and stakes

Tier **product**; criticality **85/100**. Phases touching migrations, auth,
payments, safety or the review loop add the specialist review.
```

## 1. What this plan is

The parent plan for launching Overhype.me. It does three things: fixes the
launch definition (scope and readiness criteria, already agreed in the oracle),
breaks the work into **phases small enough to plan, build, review and verify
on their own**, and sequences them with their dependencies, the decisions each
one batches for David, and the evidence that finishes it. Each phase that
touches product code gets its own plan and its own planning loop; this
document is the map, not the territory.

**What it is not:** a cleanup pass or a feature spec. Per-item decisions live
in `docs/plans/LAUNCH_FEATURE_INVENTORY.md`; a phase plan reads them.

## 2. How to read the phases

Each phase carries: **Outcome** (what is true when it is done), **Scope**
(what it owns, by inventory id where useful), **Depends on**, **David's
batch** (decisions reserved for him, asked once at that phase's approval),
**Exit evidence** (observable; what the phase's UAT/CI proves), **Tier**
(`product` / `sensitive` / `internal`) and **Lane** (which can run in
parallel). Verification follows the four-lane model: a CI test for an
invariant, a scripted proof with evidence, a live check, or David's judgement
— and only the human and live residue reaches him.

**Phase 2 (verification) is a prerequisite: it completes before any product
phase starts.** Then three streams run in parallel: *Foundations* (3, 4),
*Product* (5–9), *Operations and money* (10–16). *Polish and the four launch
stages* (17–21: polish, Seed, Soft, Full US, Full Global) close.

**The full readiness bar holds before Seed** (S6): the security review with
no open highs, the operational safety path usable, spend controls
demonstrated, the admin console finished, every compliance page and consent
flow live. Seed users submit facts and make memes from them, so photos,
memes and sharing are all real from the first day.

## 3. Phases

### Phase 1 — Define launch (docs)

- **Outcome:** `product-direction.md`, `current-roadmap.md` and a new
  `docs/ai-context/launch-definition.md` carry the launch scope, the cuts, the
  readiness criteria with their soft/full and payment-mode columns, and the
  per-item decisions; the UAT backlog (#562) is re-dispositioned against the
  scope (deferred steps marked deferred, never passed).
- **Scope:** docs only. Also: `is_tester` removed from the docs; video and
  OG-preview reversals recorded in `decisions.md` with David's words.
- **Depends on:** this plan's approval.
- **David's batch:** none (all decisions already made).
- **Exit evidence:** Documentation-class PR merged; `/next` shows the
  phased parent with every phase listed.
- **Tier:** internal (Documentation class). **Lane:** first.

### Phase 2 — Test infrastructure

- **Outcome:** mechanical verification is scripted; David's share of any UAT
  is the human residue only.
- **Scope:** the Playwright sandbox spike (approved) and CI lanes; an
  on-demand acceptance workflow separate from the PR gate; a
  **production-configuration auth smoke** (register, sign in, recover through
  the real entry points, not the dev-admin login); AI test doubles for
  enrichment and image generation at the provider seam; the Stripe stub
  (#566, plan to be approved); the **sanitised legacy fixture** from the dev
  snapshot (scrub design first); lane tags in `uat-doc-format.md` enforced
  by the checker; `pr-docs`/`uat` skills updated; ordinary free and paid test
  accounts as fixtures (never admin-only evidence for paid paths); every
  remaining backlog step mapped to one of the four dispositions.
- **Depends on:** Phase 1.
- **David's batch:** the fixture privacy call (what is scrubbed); the #566
  plan.
- **Exit evidence:** the backlog table shows a disposition per step; the
  acceptance workflow runs green on demand; a production-config auth journey
  passes in CI; the Stripe stub plan is approved and merged.
- **Tier:** internal, except the Stripe stub (sensitive: payments seam).
  **Lane:** prerequisite — first after Phase 1; product phases start only
  when it is done. Handbook-shaped parts (lane tags, the acceptance
  workflow, the readiness table as a reusable artefact) land in the
  handbook so a second app inherits them (the one named freeze exception).

### Phase 3 — Data and environments (prerequisite of the soft launch — S2)

- **Outcome:** production can be built from code alone, upgraded, and
  restored; the dev database survives as a fixture; the soft launch opens on
  a fresh production database before any real user contributes.
- **Scope:** snapshot dev (private); a **schema baseline** (migration 0001
  presumes existing tables; CI's push-then-migrate route proves nothing
  here); bootstrap from code: extensions, roles, baseline, migration ledger,
  configuration seeds, the admin bootstrap, DB protections; a diff of config
  tables against a freshly seeded DB → every gap becomes a seed or
  migration; upgrade proof on the legacy fixture; **backup and media restore
  rehearsed** with recovery time and data-loss bound recorded; the
  four-excluded-classes procedure (sessions purged, non-terminal jobs
  drained, safety records inventoried, live Stripe obligations verified)
  applied before production is replaced; the Repl's dev DB rebuilt from
  code; a non-Replit storage test substitute for CI (Astra); backward-
  compatible migration policy written.
- **Depends on:** Phase 1; the fixture scrub design from Phase 2.
- **David's batch:** the production reset moment (a calendar decision);
  anything the config diff finds that lives nowhere else.
- **Exit evidence:** a clean environment boots from code and passes the
  acceptance workflow; the fixture upgrades cleanly; a restore into an
  isolated target succeeds for DB and media with times recorded; the
  excluded-classes checklist is signed off per run.
- **Tier:** sensitive (migrations; `overhype-migration-review`). **Lane:**
  Foundations; **must complete before Seed (Phase 18) opens**.

### Phase 4 — Cut and prune

- **Outcome:** every cut feature is gone from UI, routes, jobs, config,
  engines, docs and Manual; nothing reachable promises deferred
  functionality.
- **Scope (one PR per removal, in this order):** video pipeline, legacy
  one-shot video, video engines and styles, video permalinks (E); PuLID
  everywhere (prose-sweep); merch/Zazzle, affiliate screen and routes (A22,
  K1); templates, stock photos, **Pexels entirely**, the per-user image
  preferences (D2, D3, K2, C12/C13); legacy builders and vestigial flag
  (D1, D4); standalone hashtags page, dead admin files, dead profile tab
  (A8, H); Debug mode (two columns + five-file sweep; migration review
  because of the payments path); route-visit counters (K8); dead leaderboard
  pills (A14); orphan endpoints after verification (A27, I); Zazzle config
  keys; `moderateComment` stays (Phase 9 wires it).
- **Depends on:** Phase 1.
- **David's batch:** none.
- **Exit evidence:** route and page inventory re-run shows no cut item; CI
  green; Manual and docs swept.
- **Tier:** internal, except Debug mode (sensitive). **Lane:** Foundations.

### Phase 5 — Account and identity

- **Outcome:** every account has a verified email before it acts; sign-up is
  consistent across methods; the data model is ready for beta and adult
  content without shipping either.
- **Scope:** verified-email gate on every authenticated action (B11) with
  provider-verified claims trusted at sign-up; one onboarding path (B10);
  pronouns carried through OAuth sign-up and the `he/him` default removed
  (B17); Turnstile replacing hCaptcha at registration, submission, comments
  and share-by-email (K14); age gate (13+ / 18+ for photo upload, pending
  Phase 14); marketing consent at sign-up with a stored flag; **"My
  content"** (D27, B22); **staged, resumable self-service deletion** that
  refuses to complete while a Stripe obligation is unresolved and preserves
  safety records (B24, S5); account suspension (H); audience flag and
  verified-adult state (NSFW-ready, nothing shipped); beta-overlay row in
  the grid (off); Replit Auth remnants removed; password-change session
  logout and single-use reset tokens as cheap hardening.
- **Depends on:** Phase 1; Phase 2's production-config auth smoke for proof.
- **David's batch:** the user-visible fate of a deleted user's published
  facts and memes (S5); the consent wording.
- **Exit evidence:** CI invariants for the gate, the pronoun carry and the
  deletion state machine; scripted journeys for every sign-in method;
  David's human pass on the onboarding feel.
- **Tier:** sensitive (auth). **Lane:** Product.

### Phase 6 — The loop (as much time as it needs)

- **Outcome:** a shared meme brings the next person in, and that person can
  make it about themselves in one tap.
- **Scope:** **"Make this about you"** on every meme page (A25-new); OG
  previews fixed for memes (#592) and added for fact pages; share by every
  modality with the email invite fixed (#374); public creator pages;
  reactions with heat/Trending and the hero pick (Wilson stays all-time);
  "load more" if > ~50 facts; search history on the search screen (A13);
  #591 private not-found copy; **privacy-model review** with one rule
  enforced in one place and tests across permalinks, previews, hearts,
  galleries, listings, library and share copy (#395, #375, D9); pronoun
  suggestion cached (A3).
- **Depends on:** Phase 5 (verified account for download/save/share, D21).
- **David's batch:** reaction set and heat weighting sign-off; creator-page
  contents.
- **Exit evidence:** a scripted share→make-it-mine→sign-up journey; OG cards
  verified with a crawler fixture **and by a deployed check that retrieves
  the OG shell and its advertised image through the real domain** (S8); the
  privacy rule's CI suite; David's human pass on the loop end to end.
- **Tier:** product. **Lane:** Product.

### Phase 7 — The image offering

- **Outcome:** free users get the fact's approved hero options; Legendary
  users get their face in the scene; only a user's own images are ever
  offered to them.
- **Scope:** the **publication model** (S3): approved moderation renders
  become published fact assets, distinct from a user's own uploads and
  generations, carried through the wizard, preview/save/render, library,
  refresh and deletion; aspect-ratio strategy (render at approval vs render
  on demand and cache); the waived/missing-hero experience; PNG + HEIC upload
  (D4); anonymous preview-only, verified account for download/save/share
  (D21); branded watermark on free downloads; speech bubbles finished on the
  moderation side (D14); private-meme gating read from the grid (#395);
  style presets tuned **after** Phase 8.
- **Depends on:** Phase 5 (gating), Phase 4 (templates/stock/Pexels gone);
  presets wait for Phase 8.
- **David's batch:** aspect-ratio approach; the no-hero fallback; number of
  hero options per fact; watermark design.
- **Exit evidence:** CI invariants on the asset boundary; scripted builder
  journeys for free and Legendary test accounts; PR398's caption checks and
  a representative render sample as David's human pass.
- **Tier:** product (visual-pipeline skill). **Lane:** Product.

### Phase 8 — Engine evaluation

- **Outcome:** the default image engine is the best current model on this
  product's own facts, chosen from evidence, with presets tuned to it.
- **Scope:** extend the eval runner to run candidate engines (today it
  evaluates the current pipeline and the worker hard-codes Nano Banana 2 —
  S3); candidate engines in the catalogue behind bands; a comparison on the
  same facts and scenarios; compiler work for the winner (the
  planner/compiler split is kept); default `llm` engine set (K4); fal pricing
  warm-up fixed (K13); presets reviewed and tuned.
- **Depends on:** Phase 4 (catalogue pruned); Phase 11's accounting for
  evaluation spend.
- **David's batch:** the winner, from a side-by-side he judges.
- **Exit evidence:** eval runs recorded per engine; David's pick recorded in
  `decisions.md`; presets re-reviewed against the winner.
- **Tier:** product. **Lane:** Product, after 7's asset model.

### Phase 9 — Community and takedown

- **Outcome:** comments cost David time only when reported or new; anyone
  can report anything; the platform defence's machinery exists.
- **Scope:** comments rebuilt (C6): verified email, first-N-held trust gate,
  per-account rate limit, `moderateComment` wired as the pre-screen, AI-
  assisted review; **report/takedown**: report button with categories on
  facts, memes and comments, admin Reports queue, DMCA notice and
  counter-notice flow, repeat-infringer counter feeding suspension,
  likeness-consent attestation at upload and the "image of me" category
  (C9); comment author delete (ties to deletion).
- **Depends on:** Phase 5 (gate, suspension); Phase 14 for the policy text.
- **David's batch:** trust-gate N; report categories; the takedown SLA he
  commits to in the Terms.
- **Exit evidence:** CI for the gate and rate limit; a scripted report →
  queue → action → notice journey; David's human pass on the comment and
  report experience.
- **Tier:** sensitive (abuse surface). **Lane:** Product.

### Phase 10 — Membership and money

- **Outcome:** one monthly plan, the Legendary definition in the grid, every
  grant surface correct in both Stripe modes, and a repair path an operator
  can run.
- **Scope:** monthly-only pricing page (F2); Legendary rows in the grid
  (face-in-scene, private memes, custom avatar, watermark-free, render
  allowance + meter, multiple reference photos, early access; ad-free and
  priority as inert rows); `livemode` column with pre-existing rows as test
  (#454); upgrade messaging (D24); webhook logs ignored event types; the
  **operator-run reconciliation runbook** for undelivered webhooks (Astra
  gate 3); tier list and Stripe tagging kept additive for Legendary Pro;
  remove the unused CI Stripe secrets.
- **Depends on:** Phase 5; Phase 2's Stripe stub for CI proof.
- **David's batch:** price; allowance number; messaging copy.
- **Exit evidence (S7 split):** CI on grant surfaces via the stub; the
  monthly lifecycle and every adverse event (failed payment, cancel, refund,
  dispute, duplicate/out-of-order webhook, interrupted processing) proven
  **in test mode** with the reconciliation runbook demonstrated; retained
  test purchases shown unable to grant live benefits after the mode switch.
  Live configuration verification and the genuine-payment watch belong to
  Phase 20.
- **Tier:** sensitive (payments). **Lane:** Operations and money.

### Phase 11 — Spend controls (launch gate — S4)

- **Outcome:** the service cannot spend more than David decides, under any
  failure, and he can stop it in one action.
- **Scope:** inventory of every provider-call path (user generation,
  moderation prep and renders, evaluation, backfills, pronoun suggestion,
  tokenising); a reservation-aware gate (today's gate sums recorded spend
  only); **no admin exemption on the service ceiling** (admins exempt from
  per-account allowance only, if at all); durable accounting replacing the
  in-memory governance maps; the async image worker brought under the
  gate/ledger; a service-wide ceiling and an **emergency stop** (read-only
  mode for spend); alerts at thresholds; the per-account allowance meter as
  a benefit (Phase 10 shows it).
- **Depends on:** Phase 4 (fewer paths).
- **David's batch:** the ceilings (daily/monthly service-wide, per tier);
  what the emergency stop refuses.
- **Exit evidence:** bounded exposure demonstrated under simultaneous
  requests, retries, restart, unavailable pricing and failed accounting
  (scripted); the stop exercised live.
- **Tier:** sensitive. **Lane:** Operations and money; **gate for Seed (18)**.

### Phase 12 — Email and the list

- **Outcome:** every email is consented, unsubscribable and attributable;
  Fact of the Day reaches everyone who opted in.
- **Scope:** consent and preference model in our DB; Resend audiences kept
  in sync; unsubscribe on every list email; welcome email after
  verification; Fact of the Day free for opted-in users with share and
  make-it-mine links (G5); share-by-email invite fixed (with Phase 6);
  bounce/complaint handling; list and consent counts for the dashboard.
- **Depends on:** Phase 5 (consent capture).
- **David's batch:** send cadence and the welcome copy.
- **Exit evidence:** scripted proof of consent → send → unsubscribe; a real
  delivery to David's inbox; the live check in the soft launch.
- **Tier:** product. **Lane:** Operations and money.

### Phase 13 — Admin console

- **Outcome:** one place tells David what to do now; moderation is fast;
  users can self-serve help.
- **Scope:** **Dashboard rebuilt** as an operations home (its own plan);
  **moderation UI/UX rebuilt** once Phases 7 and 9 have settled the pipeline,
  with AI-assisted triage, keyboard review and batch render approval; new
  screens: Reports (with 9), Invites (for 18), Read-only switch (with 16),
  Safety (scope from 14); user-facing help derived from the Manual source
  via the existing generator, surfaced on every user page; Manual refreshed.
- **Depends on:** Phases 7, 9, 14 for content; 16 for the switch.
- **David's batch:** the dashboard's to-do list and metrics (asked once with
  a mock-up).
- **Exit evidence:** David runs a morning's moderation from the dashboard
  alone; help panels verified on every user page.
- **Tier:** product (admin). **Lane:** Operations and money; **in the Seed gate** (David moderates every seed fact from it).

### Phase 14 — Compliance

- **Outcome:** the platform defence is real and a law firm reviews a
  complete package rather than a blank page.
- **Scope:** a full research pass (its own session) → Terms, Privacy, DMCA
  policy and agent details for David to register, repeat-infringer policy,
  community guidelines, consent copy (likeness, marketing, cookies, age),
  the NCMEC decision (complete the capability vs counsel-confirmed manual
  procedure) and retention per statute with a purge job, geography policy
  (US-first, EU/UK and OFAC blocks at Cloudflare, **with an inventory of
  every public origin and a bypass test proving the rule cannot be skipped
  via the Replit origin — S8**), data-rights handling (deletion now; export
  and the rest of GDPR readiness in Phase 21), the Safety screen's scope;
  then counsel.
- **Depends on:** Phase 1; informs 5, 9, 13.
- **David's batch:** the NCMEC path; retention; anything counsel returns.
- **Exit evidence:** pages live and linked; agent registered (David); counsel
  sign-off recorded.
- **Tier:** sensitive (legal-safety). **Lane:** Operations and money, early; **in the Seed gate**.

### Phase 15 — Security hardening

- **Outcome:** no known high finding on the launch scope before real money.
- **Scope:** `ADMIN_API_KEY` scoped or removed (#455); `sharp` upgraded with
  render verification; CSP enforcing after observation; HSTS complete;
  Dependabot triaged by exposure; secrets audit; git-history purge of the
  removed dump; session cookie and private-media caching checks on the real
  origin; then `/security-review`.
- **Depends on:** Phase 4 (smaller surface).
- **David's batch:** `ADMIN_API_KEY` fate (scope vs delete).
- **Exit evidence:** `/security-review` report with no open highs; each item
  verified on the deployed origin.
- **Tier:** sensitive. **Lane:** Operations and money; **gate for Seed (18)** — no open highs before any real account exists.

### Phase 16 — Analytics and operations

- **Outcome:** David can see the funnel, hear about failures, and pause
  writes without a takedown.
- **Scope:** GA4 configured (measurement ID in the deployment) and PostHog
  added, both fed by one event call; the funnel event list; cookie notice
  hook for Phase 14; Sentry alerts to David and a Sentry uptime check;
  **read-only mode**; deploy and migration policy for zero-window releases;
  the API-restart investigation from 2026-10-04 closed.
- **Depends on:** Phase 1.
- **David's batch:** none beyond the approved vendors.
- **Exit evidence:** funnel visible in PostHog from a scripted journey; an
  alert received on a forced error; read-only mode exercised live.
- **Tier:** internal/product. **Lane:** Operations and money, early.

### Phase 17 — UX polish pass

- **Outcome:** every user journey feels finished; the final polish is as
  close to right as it can be before launch.
- **Scope:** a journey-by-journey review with the design skill, prioritised
  by David's walk-through; render-progress experience (D8); upgrade moments;
  empty states; error messages that say what to do next.
- **Depends on:** Phases 5–9, 12.
- **David's batch:** the walk-through itself (his judgement is the work).
- **Exit evidence:** David's acceptance per journey.
- **Tier:** product. **Lane:** closing.

### Phase 18 — Seed

- **Outcome:** a small trusted group is submitting facts and making memes
  from them on a fresh production database, behind an invite gate; David is
  moderating every fact through the full pipeline from the rebuilt console.
- **Scope:** invite gate on registration and participation (public meme
  pages and previews stay public — S1); the Invites screen; the production
  reset executed (Phase 3); **the full readiness bar checked** (rows 1, 2, 4,
  5, 6-dispositions, 7, 8, 9; row 3 in test mode); go/no-go; the content push
  to **50 approved facts** by invited users; the moderation stress test;
  seed users making and sharing memes (photos, likeness consent, reports all
  real from day one); the Sentry feedback widget stays.
- **Depends on:** 2–17 complete except Phase 10's live-mode items.
- **David's batch:** the invite list; go/no-go.
- **Exit evidence:** 50 approved facts; every seed fact rendered and at least
  one meme made from it; what Seed taught us, each item dispositioned.
- **Tier:** product. **Lane:** closing.

### Phase 19 — Soft launch

- **Outcome:** a wider invited group uses the whole loop; the real-data
  verification pass has run on production.
- **Scope:** wider invitations; the real-data pass (every live-lane UAT step
  run on the real database); friends exercising test-mode payments through
  the full lifecycle; reactions, comments and reports under real use;
  the lessons list dispositioned; readiness rows re-checked.
- **Depends on:** Phase 18 and its lessons.
- **David's batch:** the wider invite list; go/no-go.
- **Exit evidence:** the real-data pass recorded; test-mode lifecycle
  evidence complete (S7); nothing in the lessons list left undispositioned.
- **Tier:** product. **Lane:** closing.

### Phase 20 — Full launch (US)

- **Outcome:** the gate is off, money is real, the site is watched, and only
  the US (and nowhere sanctioned) is served.
- **Scope:** live Stripe configuration verified on the deployed site
  (account, monthly price, credentials, webhook, boot guard); retained test
  purchases proven unable to grant live benefits; geography blocks on with
  the origin-bypass proof (S8); marketing list at scale; Sentry widget
  removed; readiness rows re-checked in their full-launch column; go/no-go;
  publish; the launch watch observing the first genuine payments; rollback.
- **Depends on:** Phase 19; Phase 15 green on the current head.
- **David's batch:** go/no-go; the date.
- **Exit evidence:** every readiness row green in the US column; the first
  week's incidents handled from the dashboard; first genuine payments and
  their entitlements observed and recorded.
- **Tier:** product. **Lane:** closing.

### Phase 21 — Full launch (Global)

- **Outcome:** the service is offered outside the US with the obligations
  that brings met deliberately.
- **Scope:** GDPR readiness — self-service data export, cookie consent, the
  EU-representative question, vendor data-processing terms, Privacy Policy
  additions — with counsel; geography blocks lifted region by region; any
  per-region payment or tax configuration in Stripe.
- **Depends on:** Phase 20; counsel.
- **David's batch:** which regions, in what order; the EU-representative
  decision.
- **Exit evidence:** the GDPR checklist signed off by counsel; a block
  lifted and verified at the edge per region.
- **Tier:** sensitive (legal). **Lane:** closing.

## 4. Readiness criteria, by stage

The full bar holds before Seed (S6). Later columns show what is *added* at
each stage; nothing earlier is relaxed. A requirement awaiting execution
stays visibly outstanding and never becomes an earlier stage's pass.

| # | Criterion | Seed | Soft | Full (US) | Full (Global) | Payment mode |
|---|---|---|---|---|---|---|
| 1 | Scope approved; every route/screen in it or removed | must | — | — | — | — |
| 2 | Production built from code; backup + media restore rehearsed | must | — | re-verified | — | — |
| 3 | Stripe lifecycle + adverse events proven (S7 split) | test-mode proof complete | friends' test-mode use | live config verified; genuine payments watched | per-region config | per column |
| 4 | Spend controls demonstrated; emergency stop exercised | must | — | re-verified live | — | — |
| 5 | Security review, no open highs | must | — | green on current head | — | — |
| 6 | UAT dispositions complete; real-data pass | dispositions | real-data pass done | — | — | — |
| 7 | Compliance package live; safety path usable; DMCA agent registered | must | — | counsel signed | GDPR checklist signed | — |
| 8 | Alerts, uptime, read-only mode, rollback | must | — | — | — | — |
| 9 | UX polish accepted; catalogue and render sample accepted | must | post-Seed fixes | post-Soft fixes | — | — |
| 10 | Runbook and go/no-go read against this table | Seed go/no-go | Soft go/no-go | US go/no-go | Global go/no-go | — |

## 5. Dependency summary

```
1 Define → 2 Verification (prerequisite; nothing product starts before it)
├─ Foundations: 3 Data & envs ∥ 4 Cut & prune
├─ Product:     5 Account → 6 Loop → 7 Image → 8 Engine ; 9 Community
├─ Ops & money: 14 Compliance ∥ 16 Analytics/ops ∥ 10 Membership → 11 Spend ; 12 Email ; 15 Security ; 13 Admin
└─ Closing:     17 Polish → 18 Seed (full bar: 3, 11, 13, 14, 15 and every product phase)
                           → 19 Soft launch → 20 Full launch (US) → 21 Full launch (Global)
```

## 6. David's decision batches (when each is asked)

- **Phase 2:** fixture scrub scope; #566 plan.
- **Phase 3:** production reset moment; unseedable config found.
- **Phase 5:** fate of a deleted user's contributions; consent wording.
- **Phase 6:** reactions/heat weighting; creator-page contents.
- **Phase 7:** aspect ratios; no-hero fallback; options per fact; watermark.
- **Phase 8:** the engine winner.
- **Phase 9:** trust-gate N; report categories; takedown SLA.
- **Phase 10:** price; allowance; messaging.
- **Phase 11:** ceilings; what the stop refuses.
- **Phase 12:** cadence; welcome copy.
- **Phase 13:** dashboard contents (from a mock-up).
- **Phase 14:** NCMEC path; retention; counsel's returns.
- **Phase 15:** `ADMIN_API_KEY` fate.
- **Phase 18–21:** invite lists; go/no-go per stage; the US date; the Global region order and the EU-representative decision.

## 7. Risks and accepted trade-offs

- **Length.** Twenty-one phases is honest, not padded; the alternative is
  phases too big to review. The factory freeze keeps capacity on them, with
  one named exception: handbook work a launch phase needs and a second app
  would need identically.
- **Seed is not a shortcut.** Holding the full bar before Seed (David, S6)
  means the first real user arrives late and safe rather than early and
  exposed; the cost is calendar, deliberately accepted.
- **Live payments are observed, not rehearsed** (S7): the first adverse
  outcome against real money happens with a real customer, under watch,
  with a demonstrated repair path.
- **Real-data blind spot** is closed by Phase 3's fixture and Phase 18's
  pass, not by CI.
- **Engine churn.** Phase 8 may change the compiler; the split is kept.
- **Legal residual.** Phase 14 reduces exposure; counsel owns the last word.
- **Spend.** Phase 11 is a gate because a solo founder cannot absorb a
  runaway bill; the evidence bar is deliberately high.

## 8. Out of scope (post-launch)

Video on the image pipeline; Legendary Pro; NSFW mode; beta overlay rollout;
annual/lifetime; public growth surfaces beyond the loop; R2; new content
formats. (Data export and GDPR readiness are now Phase 21, not out of scope.)
