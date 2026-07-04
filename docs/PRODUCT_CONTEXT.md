# Overhype.me — Product Context

> **Audience:** AI coding agents (Codex, Replit) and any engineer new to the
> product. This document is the shared mental model — *what* Overhype.me is,
> *who* it serves, and *what we're trying to achieve* — so that feature work is
> pointed at the right outcomes before a line of code is written.
>
> For *how to build/verify* in this repo (setup, typecheck order, test runner,
> the CI gate), see [`AGENTS.md`](../AGENTS.md) and
> [`docs/TESTING.md`](./TESTING.md). This file is the **product** half; those are
> the **engineering** half. Keep them in sync — when product intent changes, edit
> this file.

---

## Product summary

**Overhype.me is a community-driven, personalized "facts" database that turns
an exaggerated Chuck-Norris-style boast into an image or video meme starring
*you*.** A fact is stored once as a tokenized template — e.g.
`When {NAME} {laughs|laugh}, the earth cries.` — and rendered on the fly with any
name and pronoun set, so the same fact reads naturally about "David" (he/him),
"Alex" (they/them), or anyone else. Type your name on the homepage and every
fact on the site instantly becomes about you; no account required to browse.

The product is a loop: **a visitor personalizes facts → submits their own →
the fact is moderated and enriched → it gets rendered into a shareable image or
video meme → the meme drives new visitors back in.** Free users get photo memes
(their own face composited onto scenes); **Legendary** subscribers unlock
AI-generated images of themselves in impossible scenarios and AI video memes.
Around that core sit the usual community surfaces — a leaderboard, search,
hashtags, ratings, comments, and user profiles — plus Stripe billing and
print-on-demand merch.

Under the hood it is a pnpm/TypeScript monorepo: an Express 5 API
(`artifacts/api-server`), a React + Vite frontend (`artifacts/overhype-me`),
PostgreSQL + `pgvector` via Drizzle ORM (`lib/db`), and OpenAPI/Orval-generated
API clients (`lib/api-client-react`, `lib/api-zod`). Heavy lifting is done by
external models — OpenAI (tokenization, enrichment classification, embeddings),
fal.ai (image + video generation, safety), Stripe (billing) — orchestrated
through a durable async job queue.

---

## Core users

**Public users (the audience):**

- **Cold visitors** — arrive with no name set (often from a shared meme link).
  The homepage shows a teaser fact rendered with a demo name and an inline
  name-capture ("Type your name and every fact becomes about you"). Mobile gets a
  full-screen hero and a pronoun-onboarding bottom sheet that infers pronouns
  from the name. Name is stored on-device; still no account.
- **Warm visitors** — have a name set. They browse a personalized feed, shuffle
  random facts, and follow hashtags — all without an account.
- **Registered users** — signed up (Replit OIDC, Google/Apple OAuth, or local
  email+password). Can submit facts, comment, vote, build **photo** memes of
  themselves, and track their submissions in an activity feed.
- **Legendary members** — paying subscribers. Unlock the per-render paid
  surfaces: **AI image memes** (their face in impossible scenes) and **AI video
  memes**. "Legendary for Life" is a one-time lifetime purchase.

**Internal users (the operators):**

- **Admins** — today, effectively David (founder) wearing every operational hat.
  A single `is_admin` role gates the whole Admin panel (see *Admin user types*).
  Admins moderate submitted facts and comments, tune the AI enrichment/render
  pipeline, manage users and billing, and monitor data quality.
- **AI agents (Codex, Replit)** — the technical safety net. Codex reviews PRs and
  is increasingly expected to build features; Replit runs the engineering test
  checklists and owns the database connection. David verifies product behavior;
  the agents verify the code.

---

## Business goals

*What we care most about right now (David's current priorities):*

1. **Get to launch / stability.** This is a pre-launch product. The top priority
   is reducing regressions and hardening the end-to-end pipeline so it's ready
   for a real public launch. This is why new features ship **on-by-default with
   no rollout flags** (see *Product principles* / *Non-goals*): the bar is
   "confidently correct," not "toggleable."
2. **Content volume & quality.** Get more approved facts live, faster, and make
   sure the rendered memes actually *land the joke*. That means reducing manual
   moderation toil and raising the quality of the enrichment → render pipeline so
   the image matches the fact's mechanism. A large catalogue of great-rendering
   facts is the fuel the whole viral loop runs on.

Everything Codex builds should serve one of these two. Growth surfaces and
free→Legendary conversion matter, but they come *after* the product is stable and
the content pipeline reliably produces memes worth sharing.

---

## Admin panel purpose

The Admin panel (`/admin/*`, React under `artifacts/overhype-me/src/pages/admin/`,
API under `/api/admin/*` guarded by `requireAdmin`) is the **operator console**
for running the product. Its most important job is the **content pipeline**:
turning a raw user submission into a live, well-rendering fact. Everything else
(users, billing, config, data-quality) supports that or keeps the business
running.

The workflows that matter most, in priority order:

1. **Moderation** — review submitted facts and comments; the single highest-volume
   admin activity.
2. **Enrichment & visual review** — tune how a fact is classified and rendered so
   the meme lands the joke.
3. **Taxonomy Health** — monitor and repair data quality across the enrichment
   layer (the reference implementation for async status; see *Product principles*).
4. **Engines / AI / Video Styles config** — configure which models render images
   and video and how.
5. **Users & Billing** — manage accounts, tiers, subscriptions, refunds/disputes.

Guiding principle: **internal tools favor speed and legibility over visual
polish.** The panel exists to let an operator act quickly and see exactly what's
happening — not to be pretty.

---

## Admin user types

**There is exactly one admin role today** — a single `is_admin` boolean, not a
tiered permission system. `deriveUserRole(tier, isAdmin)` collapses membership
tier + admin flag into one `UserRole`, and `is_admin` wins. A user is treated as
admin if their DB `is_admin` flag is set, their id is in the `ADMIN_USER_IDS`
env var, or their email matches the bootstrap address. (There is also a session
"drop admin mode" toggle so a real admin can browse as a normal user.)

So the "founder / support / moderation / ops / finance" personas are **hats one
admin wears**, not separate accounts or scoped roles:

| Hat | What they do in the panel | Screens |
| --- | --- | --- |
| **Founder / product** | Sets policy, configures AI/render behavior, watches the dashboard | Dashboard, Configuration, AI Settings, Features |
| **Moderation** | Reviews submitted facts & comments, runs visual review | Moderation, Comments |
| **Content/render ops** | Tunes enrichment, curates visual concepts, monitors data quality | Facts, Enrichment Editor, Taxonomy Health, Engines, Video Styles |
| **Finance** | Manages plans, syncs Stripe, handles refunds/disputes | Billing, Refunds & Disputes, Users |
| **Growth/ops** | Watches affiliate click-throughs, email queue | Affiliate, Email Queue |

Do **not** invent a multi-role admin permission model unless David explicitly
asks for one. Note that the **user-facing** tiers (`unregistered | registered |
legendary`) are billing/entitlement levels, *not* admin roles.

---

## Critical workflows

### 1. Review submitted facts (the two-gate moderation queue)
`pages/admin/moderation.tsx`; lifecycle source of truth in
`lib/api-zod/src/moderationWorkflow.ts`. Submissions land in `pending_reviews`
(never directly in `facts`) and move through a **cost-gated** lifecycle:

- **`triage_pending` ("Needs first pass")** — cheap human triage *before* any paid
  AI/image work. Reject outright, or "provisionally approve," which creates an
  **inactive staging fact** and kicks off enrichment + Pexels image prep.
- **`prep_pending` → `prep_failed`** — the async prep jobs run (retry or reject on
  failure).
- **`production_review` ("Step 2")** — the expensive review: the moderator tunes
  the enrichment, inspects the compiled runtime prompt and **test-render memes**,
  then production-approves (flips the staging fact **active/live**, embeds it,
  notifies the submitter) or rejects.

A separate **refresh cycle** re-reviews already-live facts via a *candidate*
enrichment version — the live fact stays published until the candidate is
promoted. The Moderation sidebar item carries a red pending badge (pending fact
reviews + pending comments).

### 2. Moderate comments
`pages/admin/comments.tsx` (reached from within Moderation). Two tabs — **Pending**
(awaiting approval) and **Flagged** (auto/user-flagged with a reason). Approve,
reject with a note, or delete; each links back to its parent fact.

### 3. Tune enrichment & visual rendering
`components/admin/EnrichmentEditor.tsx` (+ `fieldDocs/`), embedded in Moderation
Step 2 and in Admin → Facts. Edits the fact's structured visual taxonomy across
three groups: **AI Visual Classification** (the 11-archetype "joke mechanism",
subtype, depiction style, difficulty, Overhype fit, adult-mode compatibility,
render modifiers, hashtags, confidence), **Visual Strategy Override**
(moderator-authored core scene / "Visual concept", subject depiction, required/
forbidden details, composition, policy overrides), and **References & Scene
Entities**. Render-affecting edits flip test renders **stale**, prompting a
re-run. Field help is generated from the `fieldDocs/` registry into
[`docs/ADMIN_FIELD_REFERENCE.md`](./ADMIN_FIELD_REFERENCE.md) (CI-checked).

### 4. Manage users
`pages/admin/users.tsx`. Search/paginate users; edit profile fields; toggle
`is_admin`, captcha, NSFW mode; set membership tier; set a per-user monthly
generation-spend override; grant lifetime membership; view subscription/spend
history with Stripe deep-links; deactivate/delete.

### 5. Investigate billing / refunds / disputes
`pages/admin/billing.tsx` + `pages/admin/refundsDisputes.tsx`. Billing manages
Stripe products/prices/plans and runs a live per-resource **Stripe backfill/sync**
(products, prices, plans, customers, subscriptions, invoices, charges, payment
methods). Refunds & Disputes is a filterable ledger of refund/dispute events from
`membership_history`, colour-coded, with Stripe dashboard deep-links.

### 6. Configure AI / rendering / engine behavior
`pages/admin/engines.tsx` (authoritative), `ai.tsx`, `config.tsx`,
`videoStyles.tsx`. **Engines** is the catalogue of image/video/utility/LLM models
(provider, endpoint, tier requirement, allowed durations/resolutions/aspect
ratios/modes, cost & runtime estimates, per-model params). **AI Settings /
Configuration** center on a global **Standard vs. Debug** config toggle. **Video
Styles** edits the motion/animation preset catalogue.

### 7. Monitor taxonomy / data quality
`pages/admin/taxonomy-health.tsx` (+ `taxonomyHealthCards.ts`). Filter cards
summarize counts of facts that are Healthy / Missing enrichment / Invalid /
Needs admin review / Stale version / Projection mismatch / refs-need-research /
entities-need-review / Low confidence. Two remediation actions per card, each with
a safety label: **Re-enrich** (re-runs the classifier — *costs model calls*, skips
admin-edited rows) and **Repair projections** (rewrites derived columns from
stored JSON — *safe/instant*).

### 8. Bulk import facts
`pages/admin/facts.tsx` doubles as the bulk-import surface (JSON / CSV / lines) and
per-fact CRUD: edit text, variant relationships, active flag, vote counts; trigger
re-embedding / re-enrichment; open the Enrichment Editor; "send back to review."

---

## Current pain points

Known frustrations, fragile spots, and manual toil — the things worth fixing.

**Manual / human-in-the-loop toil (biggest lever):**
- Moderation is heavily manual: a multi-step review wizard, per-fact visual review
  with test renders, moderator-authored/curated visual concepts, and taxonomy-health
  cards whose "remediation" is literally instructions to open a fact and re-enrich.
  This is the toil that "moderation speed & tooling" (a near-term priority) targets.
- Operational escape-hatch scripts (`scripts/`): a committed "resubmit facts for
  review" script, admin Stripe-sync, admin taxonomy actions.

**Fragile engineering surfaces:**
- **Migration tooling is broken:** `drizzle-kit generate` fails on a malformed
  snapshot, so new migrations rely on a `SNAPSHOT_EXEMPT_TAGS` workaround and
  hand-written idempotent `ADD COLUMN IF NOT EXISTS`. Treat migrations carefully.
- **Build/typecheck toil:** consumer typechecks can read stale `lib` build output;
  always run the codegen + `typecheck:libs` order in `AGENTS.md` first. Recent
  churn fighting Vite/React-19 dev-server crashes.
- **Test-suite instability:** history of flaky tests and a removed "time limit
  wrapper"; the isolated runners in `AGENTS.md`/`docs/TESTING.md` are the source of
  truth for running tests correctly.
- **Storage divergence:** the stated intent is Cloudflare R2, but images actually
  persist to Google Cloud Storage via the Replit sidecar; R2 consolidation is
  unfinished (`docs/cloudflare-rate-limits.md`).
- **OG/social cards:** a Google-infra `GAESA` cookie breaks X/Twitter OG images;
  only fixable at the Cloudflare layer (`docs/cloudflare-gaesa-og-fix.md`).
- **Sentry confusion:** telemetry spreads across three Sentry tabs; most "Sentry
  broken" reports are looking in the wrong place (`docs/SENTRY.md`).

**Unfinished / stubbed (grep `TODO`):**
- Enrichment **signature stamping** not implemented (`enrichmentJobs.ts`,
  `sendBackToReview.ts`).
- **Version rollback** archive rows exist but aren't wired
  (`enrichmentVersioning.ts`).
- **Stripe webhooks:** some SCA/renewal emails can't send when invoice URL/email/
  amount are missing (`webhookHandlers.ts`).
- **Meme social share** flow is a stub in the meme builder ("for now just signal
  completion").
- **Gradient backgrounds** are being phased out in favor of stock photos.

---

## Product principles

The rules that make a change "right" here. Several are codified in
[`CLAUDE.md`](../CLAUDE.md); this restates the ones that matter to *any* agent
building features.

1. **Ship the surface in the same change.** If a change has any user-, admin-, or
   tester-visible behavior, the UI to exercise it ships with the backend. A schema
   column with no control, or an endpoint with no button, is not done. Conversely,
   don't ship dead UI with no backend.
2. **Async work must show its status at two altitudes.** Anything queued/batched/
   long-running must report **per-item** state (`queued → working → done / failed /
   skipped / still-running`, with a spinner and a terminal icon, right where the
   user is looking) **and** an aggregate tally ("Enriched 7 of 25 · 2 failed · 3
   running"). A single global spinner is a bug. "Skipped" and "still running" are
   first-class states. Never impose a UI timeout on a legitimately long job — poll
   (~1s) until every item is terminal. **Taxonomy Health
   (`useTaxonomyHealthActions.ts`) is the reference implementation** — copy its
   pattern (poll by job id, per-scope state) rather than inventing a new channel.
3. **Moderation decisions must be auditable.** Reviews, rejections, overrides, and
   version changes are recorded, not silently mutated. Enrichment keeps an
   immutable AI baseline (`enrichmentAiDerived`) separate from override layers and
   history; render/taxonomy staleness is *derived* from a content hash, never
   guessed. Preserve this — don't collapse audit trails.
4. **Avoid destructive actions without confirmation.** Data-lifecycle deletion is
   two-phase (soft → hard) with anonymization holds. Guard anything irreversible.
5. **Don't expose private user data unless the workflow needs it.** Admin surfaces
   show what's needed to do the job; don't widen data exposure casually.
6. **Internal tools: speed over polish.** Make admin surfaces fast and legible, not
   pretty. (The public frontend is the opposite — it follows the `overhype-design`
   brand system.)
7. **No rollout-flag gating pre-launch.** New features are on-by-default. Do not
   hide behavior behind an admin toggle or `enable_*` env var David has to flip
   during UAT. If a change feels too risky to ship un-flagged, make it smaller and
   more confidently correct instead. (True kill-switches for externally destructive
   actions are the only exception.) See *Non-goals*.
8. **Ask about product intent; decide the small stuff.** Naming, file layout, error
   handling, library choice, test approach — decide silently, the bot reviewers
   backstop you. Anything about *what the product should do* — UX behavior, spec
   ambiguity, feature scope, schema shapes with product consequences — ask before
   guessing. When a "bug fix" is really a behavior change, that's feature work: ask.
9. **Verify against intent, end to end.** "Done" means the intended behavior can be
   exercised in the product — not that types compile. Drive the actual flow.

---

## Near-term priorities

The areas where feature energy should go next (David's current focus):

1. **Moderation speed & tooling.** Cut the manual toil in the two-gate review +
   visual-review flow: faster approve, better queue ergonomics, smoother
   taxonomy-health remediation. Every minute saved per fact compounds across the
   whole catalogue.
2. **Render / enrichment quality.** Make the memes land the joke: sharper archetype
   classification, better visual-strategy authoring, robust versioned-enrichment
   refresh, and clean handling of stale renders.
3. **Video meme pipeline.** Mature the multi-stage PuLID → image-to-video (Kling) →
   caption pipeline and — critically — its user-facing status/experience (which
   must follow the two-altitude async-status principle).

These serve the two business goals: better tooling + quality = more good content
live faster (goal 2), and a hardened pipeline = closer to launch (goal 1).

Lower priority for now (real, but after the above): public growth surfaces
(leaderboard/search/sharing/OG), and free→Legendary conversion UX.

---

## Long-term vision

**A user-generated meme platform at scale** — a creator-driven, viral engine for
personalized content. The name-and-pronoun tokenization plus the AI visual
pipeline is the differentiator; over time the product should lean into creator
tooling, frictionless sharing, and the network effects of a large, high-quality,
personalizable catalogue. Today's careful, moderator-heavy pipeline is how we
guarantee quality *while small*; the long-term arc is to scale that quality bar
up as volume grows — increasingly assisted by AI (Codex building features, AI
assisting moderation/enrichment) rather than purely by hand.

---

## Glossary

Product-specific terms, grounded in the schema (`lib/db/src/schema/`) and domain
logic (`artifacts/api-server/src/lib/`).

- **Fact** — the core content entity: an exaggerated, personalizable statement
  stored as a **tokenized template** (`facts` table, `text` column). Not stored
  per-name; rendered on demand.
- **Personalization tokens** — the closed set a template may use: `{NAME}`,
  pronoun tokens (`{SUBJ} {OBJ} {POSS} {POSS_PRO} {REFL}` + capitalized variants),
  and verb-conjugation pairs like `{laughs|laugh}` (applied only when the person is
  the verb's subject). Tokenization policy in `factTokenizer.ts`; grammar in
  `templateGrammar.ts`.
- **Rendering (a fact)** — substituting tokens with a given name + pronoun set to
  produce natural text, with the name highlighted in fire-orange
  (`lib/render-fact.ts`). Distinct from *image* rendering.
- **Staging fact** — a fact row with `isActive = false`: prepped (enrichment,
  images) but not yet published. Production approval flips it `isActive = true`
  (live). There is no status enum on `facts`; **published = an active row exists.**
- **Moderation / review** — the human approval workflow. Submissions live in
  `pending_reviews` with a coarse `review_status` (`pending|approved|rejected`) and
  a fine-grained `review_workflow_stage` (`triage_pending → prep_pending →
  production_review → production_approved`, plus rejection stages). Cost-gated:
  cheap human triage precedes any paid AI work.
- **Enrichment** — the AI classification layer: durable structured visual-taxonomy
  metadata for a fact (archetype, subtype, modifiers, entities, references, adult
  suitability, hashtags, confidence). *Not* an image prompt. Stored as `enrichment`
  (effective = baseline + overrides), `enrichmentAiDerived` (immutable AI
  baseline), and `enrichmentOverrides` (manual layers). See
  [`docs/ADMIN_FIELD_REFERENCE.md`](./ADMIN_FIELD_REFERENCE.md).
- **Archetype (joke mechanism)** — the single most important classification: one of
  **11** values (e.g. `superhuman_physical_feat`, `object_logic_impossibility`,
  `temporal_causality_inversion`) describing *how the joke works*, not its topic.
  Each has a hand-authored visual strategy; getting it wrong sends the renderer
  down the wrong path.
- **Visual concept / core scene** — the moderator-authored "describe the picture"
  scene that drives image generation (a recent addition; candidate concepts can be
  AI-drafted as a 3-card picker the moderator edits).
- **Render / render scenario** — how a fact becomes an image. A *render scenario* is
  one required render variant a moderator approves at production review (e.g.
  `generic_t2i`, `i2i_male_default`). Each attempt is a durable row in
  `image_prompt_attempts` (generation mode, subject render mode, enrichment
  snapshot, engine-neutral plan, compiled prompt, image path). Pipeline in
  `factImagePipeline.ts` + `imagePrompt/`.
- **Stale render** — a render whose inputs have changed. Presentation state is
  **derived at read time, never persisted**: a `reviewRenderInputHash` (sha256 of
  render-affecting inputs + version constants) is compared to an attempt's stored
  hash; mismatch = "stale," prompting a re-run.
- **Engine / engine catalogue** — any generative model the platform can call
  (`kind` ∈ `image | video | utility | llm`). Defined **code-first** in
  `lib/engines/` and reconciled into the `engines` table at boot; code owns
  capabilities/param schema, admin owns `isActive`/`isDefault`/pricing. Adding an
  engine = a new file + a row.
- **Taxonomy health** — data-quality monitoring for the enrichment layer.
  `evaluateFactTaxonomyHealth` (pure, no IO) flags facts whose enrichment is stale
  (older `classificationPromptVersion`), low-confidence (`< 0.75`), missing/invalid,
  needs admin review, or whose promoted columns drifted from the JSON. Versioned
  refresh history in `fact_enrichment_versions` (`candidate | promoted | superseded
  | rejected`).
- **Meme** — the rendered artifact (`memes` table): a fact rendered to an image (or
  video), with frozen name/pronoun text, a permalink slug, heart count, and its own
  safety `status` (`live | quarantined | rejected`). Free = photo memes (your face
  composited); Legendary = AI image/video memes.
- **Video meme** — an `artifactType='video'` meme produced by a multi-stage pipeline
  (`video_jobs`, `videoPipelineRunner.ts`): PuLID stylization → image-to-video (e.g.
  Kling v3) → caption burn-in.
- **Duplicate detection** — near-duplicate flagging via a 384-dim OpenAI
  `text-embedding-3-small` embedding stored in `facts.embedding` (`pgvector`).
  On submission a candidate match + similarity is recorded on the review; the
  moderator decides.
- **Async jobs / job queue** — the durable `async_jobs` table: a `queue`
  discriminator (email, enrichment, `fact_pexels`, `image_prompt_generation`,
  `image_generation`, …), JSON payload, `dedupeKey`, retry bookkeeping, status
  `pending → processing → done | failed`. A polling worker dispatches to registered
  handlers. This is what powers the two-altitude status UIs.
- **Content-quality moderation vs. legal/safety moderation** — two *separate*
  systems. Quality review = `pending_reviews` + the review workflow. Legal/safety =
  `quarantined_memes` / `ncmec_reports` ledgers and runtime scanners
  (`lib/moderation/`: arachnid, fal safety, NSFW classifier, NCMEC).
- **Membership tier** — user entitlement level: `unregistered | registered |
  legendary`. Legendary unlocks paid per-render surfaces. "Legendary for Life" =
  a one-time lifetime entitlement. Separate from `is_admin`.
- **Reactions / ratings** — polymorphic `reactions` (`targetType` fact|meme|comment
  × `reactionType` up|down|heart), superseding the legacy `ratings` table. Writes
  keep denormalized counters on the target.
- **Leaderboard / Wilson score** — ranking is driven by `facts.wilsonScore` (a
  Wilson confidence bound on up/down votes), plus score / comment / share counts.
- **Activity feed** — per-user event log (`fact_submitted`, `fact_approved`,
  `vote_cast`, …) that surfaces submission/approval status back to the user.
- **Budget gate** — server-side USD spend cap on generation (`budgetGate.ts`), not a
  user-facing credit balance. There are **no consumer "credits"**; cost is gated by
  tier + spend caps.

---

## Non-goals

Things to avoid or postpone (David's current stance):

- **No rollout-flag gating pre-launch.** Do not add feature flags, admin toggles,
  or `enable_*` env vars that gate new user-visible behavior. Ship on-by-default.
  (True kill-switches for externally destructive actions are the only exception.)
  Post-launch we'll reintroduce staged rollouts deliberately.
- **No new external vendors.** Build within the current stack — OpenAI, fal.ai,
  Stripe, Google Cloud Storage, Resend, Cloudflare, hCaptcha. Do not introduce a
  new third-party dependency or paid service without a strong reason and David's
  sign-off; each new vendor is new cost, new credentials, and new failure modes to
  stub in tests.
- **No multi-role admin permission system** (yet). One `is_admin` role is
  sufficient; don't build role scoping unless asked.
- **Don't over-polish internal tools.** Admin surfaces should be fast and legible,
  not visually refined. Spend polish budget on the public product.

Lower-priority-but-not-forbidden (fine to touch when it serves a business goal,
but not where to spend energy right now): broad public-growth features, new
content formats beyond "facts," and net-new monetization mechanics.

---

*Last updated: 2026-07-04. When product intent shifts — new goals, a launch, a
pivot in priorities — update this file so the agents building the product stay
pointed at the right outcomes.*
