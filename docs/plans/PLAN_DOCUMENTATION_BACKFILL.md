# Plan — Overhype.me Manual: the one-time documentation backfill

> **Status:** plan under review. Not approved. Not started.
>
> Scope in one line: bring the [Overhype.me Manual](../manual/README.md) to full
> first-version coverage — 12 chapters, 9 of them newly written — write the 6
> missing `docs/ai-context/`
> subsystem specs those chapters need to link into, and put `docs/manual/`
> behind the existing docs-accuracy merge gate.

## Problem

The manual is a charter plus 3 chapters. Its own README says so: "No
substantive chapters exist yet" is now wrong (three do), and the planned-chapter
table lists 4 unwritten chapters against 7 planned areas. Three concrete
symptoms:

1. **Coverage.** `content-lifecycle.md`, `visual-pipeline.md`,
   `personalization-and-grammar.md`, and `admin-console.md` are planned and
   unwritten. Beyond those, the planned table predates several shipped areas
   entirely: **payments/membership, accounts & auth, the public site + sharing
   loop, and the meme/video studio have no chapter and no planned chapter.** The
   manual is silent on payments and auth — the two areas where a wrong
   assumption is most expensive.
2. **No spec to link into.** A chapter is required to link deep spec into
   `docs/ai-context/`, never restate it (`docs/manual/README.md`, "How this
   manual relates to `docs/ai-context/`"). That contract is satisfiable for the
   4 planned chapters and **not** for the new areas: there is no payments spec
   (only two Stripe *audit* docs), no accounts/auth subsystem spec (only
   `security-model.md`, which is audit-shaped posture), no public-site spec, and
   **no video-pipeline spec at all** — `grep` for `videoPipeline`/`kling` across
   `docs/ai-context/` hits only the map, brief, direction, roadmap, and glossary.
3. **The manual is not gated.** `scripts/check-docs-accuracy.mjs` runs its link
   and path checks over `LIBRARY_DIRS = ["docs/ai-context", "docs/engineering"]`
   plus `AGENTS.md`/`.agents/PLANS.md`. **`docs/manual/` is in neither list**, so
   a chapter may cite a repo path or a relative link that does not exist and
   still merge. The repo's own stated principle — "a confidently-wrong doc is
   worse than no doc" — is unenforced for exactly the docs a human reads without
   opening the code.

Also stale and in scope to fix: `current-roadmap.md`'s deferred entry lists
**background work** among "the remaining already-built areas" needing a
chapter, but `docs/manual/background-work.md` exists and the README's TOC marks
it written.

## Product Intent

David asked to run the backfill and settled its scope in the pre-plan
conversation: bring the manual to **full first-version coverage of the
product**, not just finish the 4 chapters the old table planned. Where a new
chapter has no spec to link into, **write the missing spec** rather than letting
the chapter carry the detail — the two-layer design (narrative over spec, one
canonical home per fact) is preserved, not bent to save effort. Every factual
claim is **verified against the code**, not inherited from the existing
`docs/ai-context/` prose. Chapters land **one per PR** so each gets its own
review and David reads them one at a time.

## Must Not Change

- **The two-layer, no-fork design.** `docs/ai-context/` stays the operational
  spec; `docs/manual/` stays narrative. Each fact keeps exactly one canonical
  home; the other side links. No chapter restates spec wholesale, and no new
  spec restates `security-model.md`'s trust-boundary content.
- **Generated docs stay generated.** `ADMIN_FIELD_REFERENCE.md` is never
  hand-edited; the `admin-console.md` chapter links to it.
- **The 3 written chapters** (`moderation.md`, `taxonomy-and-enrichment.md`,
  `background-work.md`) are not rewritten. They take **additive sections** and
  **drift corrections** only — with **one deliberate exception**:
  `background-work.md` takes a **de-duplication** edit, because it already forks
  the async-lane truth (Codex round 1, F1). No fact is deleted by that edit —
  facts that live *only* in the chapter today (e.g. the 2s/5s poll intervals)
  are **relocated** into the spec first, then replaced by a link.
- **No product behavior changes, and no product code changes.** The only
  non-markdown file this plan touches is `scripts/check-docs-accuracy.mjs`
  (one array literal).
- **The chapter quality bar** — no skeletal chapters. A chapter file appears
  only with real present-tense content across the template's five sections.
- **`docs/manual/README.md`'s TOC stays truthful after every PR**, so the pass
  can stop at any point without leaving the manual self-contradictory.
- Chapters describe the system **as it is now**; no changelog sections
  accumulate (history stays in `decisions.md` + git).

## Settled Decisions

1. **Coverage: 9 new chapters** — the 4 planned, plus payments/membership,
   accounts & auth, public site + sharing, the meme/video studio (David chose
   this over finishing only the 4 planned), **and community & engagement**
   (ratings, comments, comment hearts, the activity feed — added in round 1;
   see decision 9).
2. **Write the 6 missing specs** rather than letting new chapters carry deep
   detail themselves (5 chapter specs + `legal-safety-moderation.md`, added in
   round 4 — see decision 12). Rejected alternative: self-contained chapters — faster,
   but forks truth, which is the exact failure the two-layer design exists to
   prevent.
3. **Verify every claim against code**, accepting that this surfaces drift in
   existing `docs/ai-context/` docs which must then be corrected. Rejected
   alternative: trust the specs — much faster, but silently inherits drift, and
   documentation drift cannot be caught by product testing because docs have no
   runtime behavior.
4. **One PR per chapter.** Rejected alternative: a single ~3,000-line prose PR —
   Codex reviews prose poorly at that size and David would read the whole manual
   in one sitting.
5. **Areas smaller than a chapter become sections of a host chapter, not
   chapters** — named explicitly in *Coverage map* below, so "full coverage"
   is falsifiable rather than a claim.
6. **`docs/manual/` joins the docs-accuracy gate** (both checks, via
   `LIBRARY_DIRS`), landing before the chapters it governs.
7. **Single plan-review PR, not a step-10 split.** The pass looks multi-part but
   is one workstream with one method and one dependency chain (spec → chapter);
   the CI change is a one-line array edit, not an independent subsystem.
8. **Branch deviation, recorded deliberately:** this plan rides the
   session's designated branch `claude/documentation-backfill-plan-162efo`
   instead of a `plan-review/<slug>` branch, because the session's branch
   contract names that branch explicitly. Every functional property of the
   plan-review loop is preserved — never merged, never reused for
   implementation, plan committed at `docs/plans/PLAN_<SLUG>.md`, stable
   forwardable URL, resolvable commit sha for the eventual
   *Approved-plan source* line.
9. **Community & engagement is its own chapter, with its own spec** (round 1,
   F3). Ratings, comments, comment hearts, and the activity feed are a core
   free-tier interaction loop per `product-brief.md`, have their own routes,
   pages, DB tables, and an admin moderation surface — and **no** existing
   manual chapter so much as mentions comments (verified: `grep -il comment
   docs/manual/` returns nothing). Chapter-sized, not section-sized, so by
   decision 2 it gets a spec too — bringing the new-spec count to 5.
10. **Operations & observability is an explicit non-goal, not an omission.**
    `health.ts`, `routeStats.ts`, Sentry (`docs/SENTRY.md`), the Cloudflare
    rate-limit and OG-cookie notes (`docs/cloudflare-rate-limits.md`,
    `docs/cloudflare-gaesa-og-fix.md`), and `scripts/dev-supervisor.sh` are
    operational tooling, not product narrative, and they already have homes.
    The manual gets **no** ops chapter; the non-goal is stated with pointers so
    the exclusion is a decision on the record. **This is the one place I chose
    exclusion over coverage — David can overrule and it becomes a 10th
    chapter.**
11. **Close-out is its own final PR** (round 1, F6): retiring the roadmap's
    backfill entry can only land after every chapter has, or the roadmap
    reports the backfill complete while chapters are missing.

## Repo Context Inspected

- **The manual and its charter:** `docs/manual/README.md` (audience, chapter
  template, quality bar, TOC), and all three written chapters —
  `docs/manual/moderation.md` (read in full, as the depth/tone calibration
  target), `docs/manual/taxonomy-and-enrichment.md`,
  `docs/manual/background-work.md`.
- **The governing contract:** `docs/ai-context/documentation-workflow.md`
  (harvest → route → chapter → cross-check → commit; the docs-only boundary;
  the routing table).
- **Existing specs, for what already has a canonical home:**
  `docs/ai-context/architecture-map.md` (read in full),
  `docs/ai-context/product-brief.md` (read in full),
  `docs/ai-context/security-model.md` (section headings — `C1` dev-admin-login,
  Authentication & sessions, Authorization, Caching & the CF worker, `C6`
  payment trust, `C5` headers, `C10` secrets, `C9` admin surface),
  `docs/ai-context/visual-pipeline.md` (section headings, 523 lines),
  `docs/ai-context/current-roadmap.md` (deferred-work section, lines 225–260).
- **Gap confirmation by search**, not assumption: `grep -rln` over
  `docs/ai-context/` for video-pipeline, payments/membership, auth, and
  public-site terms — results in *Problem* above.
- **The gate:** `scripts/check-docs-accuracy.mjs` (its `LIBRARY_DIRS` /
  `LIBRARY_EXTRA` / `LINK_ONLY_*` lists and the reasoning comments) and its
  invocation in `.github/workflows/build.yml`.
- **Code surface inventory, to size each area:**
  `artifacts/api-server/src/routes/` (31 route modules — including `videos.ts`,
  `videoJobs.ts`, `pulidJobs.ts`, `share.ts`, `shareCopy.ts`, `shareIntents.ts`,
  `og.ts`, `memes.ts`, `stripe.ts`, `auth.ts`, `localAuth.ts`, `eval.ts`,
  `affiliate.ts`, `heroExamples.ts`), `artifacts/overhype-me/src/pages/`
  (**19** public pages — the plan said 18 until round 4 caught the omitted
  catch-all `not-found.tsx`), `artifacts/overhype-me/src/pages/admin/` (16 admin
  surfaces + their tests).
- **One assumption tested rather than asserted:** added `"docs/manual"` to
  `LIBRARY_DIRS` and ran the gate — **passes** (`114 files, all relative links
  resolve and all cited repo paths exist`, exit 0). The three existing chapters
  are already clean, so PR 0 is genuinely a one-line change with no chapter
  repairs hiding behind it. Working tree restored afterward.

## Current Behavior

- The manual holds a charter plus 3 chapters; its README claims none exist and
  plans 7. Chapters are grown by `/document` at the end of a feature, with this
  one-time backfill tracked as deferred work.
- 4 planned chapters are unwritten; 4 shipped areas have no planned chapter.
- 4 subsystem areas have no `docs/ai-context/` spec (payments, accounts/auth,
  public site/sharing, video pipeline).
- CI checks links and cited paths across `docs/ai-context/` +
  `docs/engineering/` + `AGENTS.md` + `.agents/PLANS.md`; `docs/manual/` is
  unchecked.
- `current-roadmap.md`'s backfill entry is stale on background work and carries
  a **Needs David confirmation** on timing that this plan resolves (he is
  kicking it off now).

## Source-of-Truth Analysis

The whole risk of this plan is **creating a second home for a fact**. Ownership,
stated per contested concept, with the losing side reduced to a link:

| Concept | Canonical home (unchanged) | The new doc's role |
| --- | --- | --- |
| Authentication & session mechanics, rate limits, reset-invalidation, password bounds, CSRF, `dev-admin-login` (C1), admin posture (C9) | `security-model.md` | New `accounts-and-auth.md` owns **user-facing account journeys only** — see the fact-level split below, which replaces the too-vague "posture vs. shape" wording (round 1, F2). |
| Payment trust — how a membership grant is authorized (C6) | `security-model.md` | New `payments-and-membership.md` spec covers plan shapes, tier semantics, webhook/lifecycle flow, budget gates; **links** to C6 for trust. |
| The Stripe audit trail (findings, their severities, remediation state) | `stripe-payments-audit-brief.md`, `stripe-payments-audit-findings.md` | Audit artifacts stay historical; the new spec is **current-state** truth and links them. It does not absorb or restate findings. |
| Image render pipeline: Visual Concept, planner, compiler, render modes, frozen inputs | `visual-pipeline.md` | New `video-pipeline.md` covers the **video** stages only (identity stylization → i2v → caption burn-in) and links `visual-pipeline.md` for anything image-side. |
| Async lanes, `async_jobs` fields/statuses, queue→lane assignments, concurrency bounds, retry/dedupe semantics | **`architecture-map.md` alone** (corrected in round 1, F1 — see below) | `background-work.md` keeps *why lanes exist and what each is for in product terms* and links for the enumerated mechanics. Other chapters link; nothing re-lists lanes. |
| Two-altitude async status rule | `async-ui-status.md` | Linked from chapters that describe a status surface. |
| Admin field-level truth | `ADMIN_FIELD_REFERENCE.md` (**generated**) | `admin-console.md` chapter links it; never restates or hand-edits it. |
| Term definitions | `glossary.md` | Chapters use the terms and link; new terms coined during the pass get added there, not defined inline. |
| Rationale / why a decision is settled | `decisions.md` | Chapters' "Why it works this way" sections **cite** entries; they don't re-argue them. |
| Pricing numbers | **Stripe, at runtime** (`pricingPlans.ts` fetches live) | Docs describe plan *shapes* (monthly / annual / one-time lifetime) and state that prices are Stripe-owned. **No price numbers in any doc** — that would be a guaranteed-drift second source. (Resolved without asking David; the repo answers it.) |

No new source of truth is created. Each of the 6 new specs opens with an
explicit "what lives here vs. what lives elsewhere" header so the boundary is
enforced by the document itself, not just by this plan.

### An existing fork this plan must fix, not preserve (round 1, F1)

Codex was right and my original claim ("no lane table is duplicated") was false
about the **present** state. Verified: `background-work.md:51-88` already
restates the `async_jobs` field list, the `pending → processing → done | failed`
statuses, all five lane names with their assignments, concurrency behavior, the
`registerJobHandler(queue, handler, { lane })` registration line, and retry
semantics — the same facts as `architecture-map.md:90-127`. Two homes, already.
Worse, the two copies have **already diverged**: the per-lane poll intervals
(2s / 5s) exist **only** in the chapter, not in the spec.

So the plan now **de-forks** rather than preserving it. The ordering is
migrate-then-reduce, and — corrected in round 2 — the migration list is
**derived, never enumerated from memory**:

1. **Pre-edit fact inventory (a hard gate, before either file is touched).**
   Enumerate **every** claim in the chapter's machinery section and map each one
   to exactly one disposition: **relocate** (spec-only fact the chapter
   currently owns), **retain as narrative** (product-level "why," stays in the
   chapter), or **replace with link** (mechanics the spec already owns). The
   completed mapping is PR 1's verification evidence and goes in its body.
2. Apply the relocations to `architecture-map.md` **first**.
3. Only then reduce the chapter's machinery section per the mapping.
4. Confirm the reduced chapter still satisfies all five template sections — a
   de-fork must not turn a written chapter into a stub, which would violate the
   manual's own quality bar.

**Why the inventory must come first, in the plan's own words rather than as a
process nicety:** round 2 disproved my round-1 list. I had named two
chapter-only facts (poll intervals, the never-auto-retried `ai_meme_backfill`
rationale); Codex found a third I had missed — the chapter's crash-reclaim
guarantee at `background-work.md:87-88` ("a crash mid-run leaves a row safely
reclaimable rather than stuck forever"), which I then verified appears **nowhere**
in `docs/ai-context/` (`grep -rn -iE "reclaim" docs/ai-context/` returns
nothing). A *post*-edit claim inventory structurally cannot catch this, because
deleted prose leaves nothing to inventory. So the inventory is a precondition,
and any enumerated list in this plan is an example, not the source of truth.

This lands as its own PR **before** any new chapter, so the no-two-homes
Definition of Done is true when the rest of the pass is measured against it.

### Fact-level auth ownership (round 1, F2)

"Subsystem shape vs. posture" was too vague to implement — verified against
`security-model.md:36-61`, which owns concrete *behavior*, not just posture
(opaque `sid` + Bearer fallback, per-request `req.user` rebuild, C4 login/register
rate limits, C8 reset-invalidates-every-session, C7 8-char minimum, CSRF
double-submit + origin allowlist). Ownership is therefore assigned per fact:

| Fact | Owner |
| --- | --- |
| Which sign-in methods exist and what a user does to use each | `accounts-and-auth.md` |
| Account lifecycle states (registered → verified → member) and how a user moves between them | `accounts-and-auth.md` |
| Email-verification and password-reset **journeys** (the steps, screens, and states a user sees) | `accounts-and-auth.md` |
| Onboarding (captcha step, photo step) and profile/identity fields | `accounts-and-auth.md` |
| How an account links to a membership tier (`unregistered \| registered \| legendary`) | `accounts-and-auth.md`, linking `payments-and-membership.md` for tier grants |
| Session mechanics: opaque tokens, cookie/Bearer precedence, per-request identity rebuild | `security-model.md` |
| Login/register rate limits (C4) and how they're scoped | `security-model.md` |
| Password-reset **session invalidation** (C8) and password bounds (C7) | `security-model.md` |
| CSRF, origin allowlist, `ORIGIN_EXEMPT_PATHS` | `security-model.md` |
| `dev-admin-login` fail-closed guard (C1), admin surface posture (C9) | `security-model.md` |

**The rule that makes this implementable:** where a journey has a security
constraint, the accounts spec states the *step* and links the *constraint*.
Worked example — password reset: `accounts-and-auth.md` says a user requests a
reset, receives an emailed link, and sets a new password; it then links
`security-model.md` for "every existing session is invalidated" and the 8-char
minimum. Neither doc restates the other, and no auth fact has two maintenance
homes.

## Proposed Design

### Coverage map — every area gets exactly one home

**Chapters (12).** ✅ = already written. (Round 4: this heading said 8 while the
table below listed 12 — the count is now derived from the table, not restated.)

| Chapter | Status after this pass | Spec it links into |
| --- | --- | --- |
| `content-lifecycle.md` | new | `moderation-workflow.md`, `taxonomy-and-enrichment.md`, `architecture-map.md` (all exist) |
| `moderation.md` | ✅ + one additive section | `moderation-workflow.md` |
| `visual-pipeline.md` | new | `visual-pipeline.md` (exists) |
| `taxonomy-and-enrichment.md` | ✅ unchanged (drift corrections only) | `taxonomy-and-enrichment.md` |
| `personalization-and-grammar.md` | new | `token-rendering-and-grammar.md` (exists) |
| `admin-console.md` | new | `ADMIN_FIELD_REFERENCE.md` (generated) + per-surface specs |
| `background-work.md` | ✅ + one additive section | `architecture-map.md`, `async-ui-status.md` |
| `accounts-and-auth.md` | new | **new spec** + `security-model.md` |
| `payments-and-membership.md` | new | **new spec** + `security-model.md` C6 |
| `community-and-engagement.md` | new (round 1, F3) | **new spec** |
| `public-site-and-sharing.md` | new | **new spec** |
| `meme-and-video-studio.md` | new | **new spec** (`video-pipeline.md`) + `visual-pipeline.md` |

That is **12 chapter files** when the pass completes: **9 newly written** (the 4
originally planned + 4 new areas + community & engagement) and **3 existing**
(one de-forked, two taking additive sections).

**New specs (6):** `docs/ai-context/accounts-and-auth.md`,
`payments-and-membership.md`, `community-and-engagement.md`,
`public-site-and-sharing.md`, `video-pipeline.md`, and
`legal-safety-moderation.md` (round 4, R4-12). Each is added to `AGENTS.md`
routing in its own PR (documentation-workflow Step 2's "a brand-new context doc
was created" row).

#### How coverage is derived — a rule, not a pre-computed table (round 4)

**Round 1 added a hand-written route-module → chapter table here. Round 4
disproved it, and David chose to remove it rather than rebuild it.** The table
was meant to make "full coverage" mechanically checkable; what it actually was
is an unverified transcription of the API surface, written from a directory
listing rather than from reading endpoints. Three errors Codex confirmed in it:

- The user submission endpoint is `POST /facts/submit-review` at
  `reviews.ts:131` — the table assigned submission to `facts.ts`.
- `facts.ts:347` owns `POST /facts/:factId/share`, a sharing endpoint filed
  under content-lifecycle.
- `memes.ts` holds **23** endpoints spanning meme hearts (community), Zazzle
  export/redirect (merch), and admin-only prompt routes — assigned wholesale to
  the studio chapter.

Module-level assignment is also the wrong *granularity*: mixed route files can
be fully "ticked" while a behavior inside them goes undocumented. And the
correct mapping is precisely what writing each chapter produces as a verified
by-product, so pre-computing it here duplicates the work in its least reliable
form.

**The rule that replaces the table:**

1. **Coverage is derived per chapter, at endpoint/behavior granularity, and
   verified against code** — never assigned wholesale by module. A mixed module
   is split by behavior across the chapters that own those behaviors.
2. **The derivation is evidence, not prose.** Each chapter PR's claim table
   (method step 1) lists the endpoints, pages, and behaviors that chapter
   covers, each with its grounding source. That is where the mapping lives,
   verified, rather than in this plan, asserted.
3. **The completeness check is a sweep, run once at close-out (PR 12):**
   enumerate every route module, every endpoint within it, and every page under
   `artifacts/overhype-me/src/pages/`, and confirm each appears in exactly one
   chapter's claim table or in the exclusions below. **That sweep is the
   Definition-of-Done coverage check** — mechanical, run against the code, and
   not satisfiable by a table I wrote in advance.

**Exclusions — the only things allowed to appear in no chapter**, named here
because an exclusion must be a decision rather than an omission:

| Excluded | Why |
| --- | --- |
| `health.ts`, `routeStats.ts` | Operational tooling, not product narrative (decision 10); pointed at from the README's "Outside this manual" section. |
| `index.ts` | Route mounting, not a surface. |
| `pages/not-found.tsx` | **Assigned, not excluded** (round 4): it is a shipped public surface — the catch-all route at `App.tsx:406` — and belongs to `public-site-and-sharing.md`. Listed here only because the plan previously counted 18 pages when the repo has 19. |

Anything else that the close-out sweep finds unassigned is a coverage hole, not
a judgment call, and blocks PR 12 the same way a partial chapter does.

**Sub-chapter areas — named, so the derivation has fixed anchors:**
**Sub-chapter areas — named, so "full coverage" is checkable:**

| Area | Home | Why there |
| --- | --- | --- |
| Merch / Zazzle affiliate (`WearIt.tsx`, `affiliate.ts`) | section in `public-site-and-sharing.md` | A public surface + outbound monetization path, not a subsystem. |
| Media storage & delivery (`storage.ts`, GCS, signed/public object paths) | section in `meme-and-video-studio.md` | Product-visible (memes load; private memes are access-controlled) but not chapter-sized; authorization stays in `security-model.md`. |
| Email queue mechanics | additive section in `background-work.md` | An `async_jobs` lane consumer; that chapter owns lane narrative. |
| Email Queue **admin surface** | section in `admin-console.md` | Surface vs. mechanics split, matching the two-layer pattern. |
| Eval dashboard (`eval.ts`, `evalDashboard.tsx`) | section in `admin-console.md` | An admin surface. |
| Comment **moderation** admin surface — `pages/admin/moderation.tsx` | section in `admin-console.md`, cross-linked from `community-and-engagement.md` | The engagement chapter owns what comments *are*; the admin chapter owns the surface that moderates them. **Round 4 correction:** the plan previously named `pages/admin/comments.tsx`, which is **not routed** — `App.tsx:382` sends `/admin/comments` through `AdminModerationRedirect` and the file is imported nowhere. Documenting it would have described a screen no user reaches. The dead file itself is a **report item for David**, not a drive-by deletion (docs-only boundary). |
| Legal/safety moderation (`quarantined_memes`, `ncmec_reports`, `lib/moderation/`) | additive section in `moderation.md`, **in its own PR** | `architecture-map.md` establishes two separate moderation systems; the chapter documents only content-quality review today. Split out of the studio PR per F6 so a chapter repair doesn't share an unrelated PR's review boundary. |

### Reading order — the manual is a walkthrough, not 12 essays (round 3)

The coverage map above is organized for *checkability*, and round 3 caught what
that costs: nothing in the plan said what order a **reader** meets these
chapters in, so a cold executor could satisfy every filename and five-heading
check and still ship twelve isolated subsystem essays. The Definition of Done
promises a front-to-back walkthrough; that has to be specified, not hoped for.

`product-brief.md` already supplies the spine — **personalize → submit →
moderate & enrich → render → share → the next visitor personalizes.** The TOC
ships in that order, not in coverage-map order:

| # | Chapter | Where it sits in the loop |
| --- | --- | --- |
| — | **Orientation** (in `README.md`, not a chapter) | The core loop in one page, and how to read the manual |
| 1 | `personalization-and-grammar.md` | **Personalize** — the thing a visitor does first, and the product's foundation |
| 2 | `content-lifecycle.md` | **Submit** — a fact's journey begins; the two entrances |
| 3 | `moderation.md` ✅ | **Moderate** — the three human gates |
| 4 | `taxonomy-and-enrichment.md` ✅ | **Enrich** — classification and versioned refresh |
| 5 | `visual-pipeline.md` | **Render (authoring side)** — how a moderator's Visual Concept becomes an image |
| 6 | `meme-and-video-studio.md` | **Render (reader side)** — what an end user makes, free vs. Legendary |
| 7 | `public-site-and-sharing.md` | **Share** — the surfaces the meme escapes through, and the loop closing |
| 8 | `community-and-engagement.md` | What returning visitors do once inside the loop |
| 9 | `accounts-and-auth.md` | Who the reader is |
| 10 | `payments-and-membership.md` | What they pay for, and what that unlocks |
| 11 | `admin-console.md` | The operator's view of everything above |
| 12 | `background-work.md` ✅ | The machinery underneath it all |

Chapters 1–7 follow the loop; 8–10 are the reader's own relationship to the
product; 11–12 are the machinery, last because a reader doesn't need them to
understand the product. Each chapter ends by pointing at the next, so
front-to-back actually reads as a sequence.

**How "point at the next chapter" survives parallel landing and the link gate
(round 4, R4-9).** These two rules collided: chapters must point forward, PR 0
puts `docs/manual/` under a gate that fails on unresolved links, and PRs 2–11
may land in any order — so PR 4's chapter pointing directly at a file PR 10
creates would either break CI or ship a broken promise. Same problem for the
auth chapter (PR 6) linking the payments spec (PR 7). The resolution:

1. **A forward pointer targets the README's reading-order entry, not the file**,
   until that file exists. The README always exists from PR 0, so the link
   always resolves and the gate stays green.
2. **Each chapter PR backfills its predecessor's pointer** to the direct file
   link as part of landing — a one-line edit, listed in that PR's scope.
3. The interim pointer is **truthful, not a placeholder**: it reads as "next:
   *&lt;chapter&gt;* — not yet written," which is exactly what the TOC says.

This adds no dependency edges — any landing order stays legal — which is why it
beats encoding "PR 4 depends on PR 10."

**The visual-pipeline ↔ studio boundary, stated explicitly** because round 3 was
right that "separate chapters" alone leaves an executor guessing and invites
overlap:

**Corrected in round 4 — my first attempt at this boundary was factually
wrong.** I split it as authoring-time/moderator-facing (ch. 5) vs.
use-time/end-user-facing (ch. 6). `visual-pipeline.md:61-77` disproves that: a
render's identity and style are frozen **"at the moment the user clicks
generate,"** and that machinery is explicitly wired into the user-facing
`/memes/ai/:factId/generate-v2` and the generic `/generate` branch. The image
pipeline is **shared** between moderation renders and end-user generation, so an
actor-based split would have forced an executor either to omit the production
path from ch. 5 or to duplicate its mechanics in ch. 6. The boundary is
therefore drawn by **subject matter, not by actor**:

- **`visual-pipeline.md` (ch. 5) owns the shared image-generation machinery**,
  whichever path invokes it: the Visual Concept as the authoritative scene, the
  frontier planner, the prompt compiler, render modes, frozen identity/style
  inputs and their reproducibility guarantee, readable-text policy. It covers
  both the moderation render path and the user-generation path, and notes where
  they differ (moderation/eval renders use fixed sample identities and the
  `reviewRenderSubject` mechanism rather than live style).
- **`meme-and-video-studio.md` (ch. 6) owns the end-user experience around that
  machinery**: the meme/video builder controls, photo memes (free) vs. AI image
  and video memes (Legendary), the tier gates, the video-specific stages, and
  where media lives and how it's served. It **links** ch. 5 for how an image is
  produced rather than restating any of it.
- The one-line test for an executor: *if it is true regardless of who triggered
  the render, it belongs to ch. 5.*

### The verification method (the load-bearing part)

David chose verify-against-code, so the method is explicit and identical for
every chapter and spec:

1. **Draft, then inventory — and the inventory is a durable artifact, not a
   scratchpad note** (corrected in round 3). After drafting, extract every
   factual claim (behavioral, structural, numeric) into a table of
   **claim → disposition → grounding source**. Prose is not reviewed for truth
   in place; a claim list is.

   **The complete table is posted in the PR body**, one row per claim, not
   summarized. A grouped note like "routes grounded against API code" is exactly
   what makes a skipped or rubber-stamped claim undetectable, so it does not
   satisfy this. Two consequences worth stating because they're what make the
   table auditable later:

   - The `Verified against <sha>` line in each chapter (step 8) also names the
     PR that carries its table — `Verified against <sha> (<date>) · claim
     inventory in PR #<N>` — so the repo points at the evidence. A reviewer, or
     a fresh agent doing close-out, can trace any claim to its enforcement
     source without access to my session.
   - This replaces the old "short verification note" in step 6, which promised
     less than the *Risks* section promised reviewers. That inconsistency was
     real; the full table resolves it in favor of the stronger obligation.
2. **Ground each claim against whatever actually enforces it — the grounding
   source depends on the claim's type, not on a global precedence** (corrected
   in round 1, F4; the original ordering let a test outrank a `CHECK`
   constraint, and a route-level guard masquerade as a universal invariant):

   | Claim type | What grounds it |
   | --- | --- |
   | "the system refuses X" / any **invariant** | The enforcement point that actually governs in production: the DB constraint if one exists, otherwise the guard in the executable path — **and** a check that no other writer bypasses it. |
   | "behavior B happens when A" | The executable runtime path, end to end (route → lib → DB). |
   | "the UI shows S in state T" | The component/state code for that surface. |
   | A numeric or configured value | The constant/config source — or, for a vendor-owned value, the runtime fetch (never a copied number). |
   | "why it works this way" (rationale) | The `decisions.md` entry that settles it. |

   **Tests are corroboration, never the sole ground for a claim** — a test can
   encode intended or mocked behavior. **Schemas ground only what they actually
   enforce**: a nullable column does not prove a field is required. An existing
   `docs/ai-context/` doc is never a ground on its own — that is exactly the
   drift-inheritance David rejected.

   Worked example, using a claim already live in `moderation.md` ("the database
   itself refuses to store an active fact without one"): grounding it means
   inspecting the constraint — `facts_active_requires_concept`, added VALID in
   `lib/db/migrations/0092_fact_lifecycle_phase2_backfill_check.sql` — not a
   test that happens to assert it. Worth recording *why* this example is in the
   plan: my first search for that constraint produced a **false negative**, and
   a less careful pass would have "found drift" in a chapter that is in fact
   correct. Claim-specific grounding has to include "look again before
   concluding the enforcement doesn't exist."
3. **Three dispositions for an ungroundable claim:** drop it; mark it **Needs
   David confirmation**; or — if it is a *rationale* claim rather than a
   behavioral one — cite the `decisions.md` entry that settles it. Rationale is
   grounded by the decision record, not by code.

   **"Needs David confirmation" is a draft state, not a shippable one
   (corrected in round 4, R4-7).** I had it as a terminal disposition and the
   DoD accepted it, which contradicts
   `documentation-workflow.md`'s rule to stop before committing a claim that
   needs product judgment and ask David — and would have let a "complete"
   first-version manual carry unresolved product assertions. So the marker may
   live in a draft, but **before that chapter's TOC row flips to *written***,
   every such claim must be either (a) confirmed by David, (b) dropped, or
   (c) explicitly excluded through his revised coverage. Any still-open marker
   blocks the row from flipping, and therefore blocks PR 12 by the same
   close-out gate that catches *partial — pending fix*.
4. **Drift found in `docs/ai-context/`** → correct the spec in the same PR (it
   is the canonical home) and list the correction in the PR body. **Hard cap:**
   if the drift turns out to be a *code* defect rather than a doc error, it is a
   **report item for David** (bugfix mode, separately) — never a drive-by code
   change inside a docs pass. That is `documentation-workflow.md`'s docs-only
   boundary and this plan does not relax it.
5. **External claims** (Stripe subscription/webhook semantics, fal.ai or OpenAI
   model behavior) are verified by me against **current vendor docs** at write
   time, with source + version/date recorded in the spec — not from model
   memory. This lands mainly in `payments-and-membership.md` and
   `video-pipeline.md`.
6. **Per-PR evidence.** Docs PRs ship no TEST_RUN/UAT (documentation-workflow
   Step 5). Instead each PR body carries **the full claim table from step 1**
   (every claim, its disposition, its grounding source), plus what is marked
   Needs David confirmation, what drift was corrected, and which disposition
   rung (step 7) applied. An obligation with no evidence trail decays — and a
   *summarized* trail is not an evidence trail (round 3).
7. **When a real defect would make the chapter misleading — the disposition
   ladder** (added in round 1, F5). Step 3's "drop the ungroundable claim" had a
   hole: a chapter could omit a defect-affected behavior and still be counted
   complete. It cannot. Exactly one of these applies, and which one is recorded
   in the PR body:

   **Rung 0 — private triage first, before *any* public artifact exists
   (added in round 4, R4-1).** This ladder previously ran straight to a public
   outcome, while method steps 1 and 6 require the full claim table — including
   each claim, its grounding source, and the rung applied — to appear in a
   **public** PR body. Those two rules together were self-defeating: rung 2
   correctly omits a sensitive claim from the chapter, and then the PR body
   publishes the claim and the exact file that grounds it. Rung 1 was worse — it
   publishes an unremediated weakness by design. So:

   - The moment grounding the auth, payments, admin, or legal/safety surfaces
     surfaces a **previously undisclosed** missing guard, static-key reach,
     fraud path, or bypass, **stop before writing either the chapter text or the
     claim-table row**, and take it to David privately.
   - David's call decides the rung. Nothing about that finding is written to a
     public artifact before then.
   - **Rung-2 evidence is redacted, never omitted:** the claim table still gets
     a row, carrying an opaque reference (`security-hold-<n>` — area and date
     only, no mechanism, no file path) plus the rung. Auditability is preserved
     — a reviewer can see that a claim exists and was withheld — without the
     row becoming the disclosure.
   - A finding **already public on `main`** (like the payments case below)
     skips triage and goes straight to rung 1; the test is *previously
     undisclosed*, not *security-adjacent*.

   1. **Document the real behavior as a known limitation** — the default for
      anything already public or non-exploitable. It goes in the chapter's
      *Boundaries & known limitations* section, linking the finding, and the code
      fix is filed as a report item for David. The chapter counts as complete.
   2. **Only if documenting it would disclose an exploitable specific** in this
      public repo: the chapter ships without that claim **and its TOC row is
      marked partial — pending fix**, the claim table carries the redacted row
      above, and the gap goes to David privately. The chapter does **not** count
      as complete.
   3. **Never** silently drop the claim and count the chapter done.

   *(The payments case below resolves to disposition 1. Note also the close-out
   gate in *Implementation Steps*: a rung-2 chapter blocks PR 12 outright.)*

   The payments chapter is the concrete case, and it resolves to disposition 1:
   `stripe-payments-audit-findings.md:82-129` documents that a transient webhook
   failure can leave a customer **paid but never granted membership** (the
   common checkout-redirect path self-recovers via
   `POST /stripe/checkout/confirm`; a closed tab does not). A current-state
   payments chapter cannot omit that. Disclosure is not a concern here because
   that finding is **already committed publicly on `main`** — writing it as a
   known limitation adds no new disclosure.

8. **Chapters are re-grounded against intervening merges, not verified once**
   (added in round 2). A 13-PR pass runs while `main` keeps moving: a chapter
   verified at PR 2 can be falsified by an unrelated feature merging before
   PR 12, and CI cannot catch it — `scripts/check-docs-accuracy.mjs` validates
   link targets and the existence of path-shaped backticks, **not behavioral
   claims**, so green CI is silent on a chapter that has become wrong. So:

   1. **Every chapter records its grounding baseline durably, in the chapter
      itself** — a single closing line, `Verified against <sha> (<date>) · claim
      inventory in PR #<N>`. It is overwritten, never appended to, so it is a
      current-state fact rather than a changelog (which the manual's charter
      forbids). It doubles as something genuinely useful to a reader: how
      current this chapter is, and where its evidence lives.
   2. **Before PR 12, sweep every chapter by re-running the inventory — not by
      diffing the paths the chapter happens to cite** (corrected in round 3).
      Citation-scoped diffing has a hole big enough to matter: per
      `docs/manual/README.md`, a chapter cites **only stable, high-value entry
      points** and is explicitly *not* a code map, so a **newly added** writer,
      route, or caller — precisely the thing most likely to break a documented
      invariant — was never cited at the baseline and would never enter a
      citation-scoped diff. Instead, for each chapter:

      - **Re-derive the enforcement set** the way initial grounding did: for an
        invariant claim, re-enumerate **every writer** to the relevant
        table/field (not just the one the chapter names) and confirm the
        constraint or guard still governs all of them; for a behavior claim,
        re-enumerate the **current** route/handler set for that surface.
      - **Re-derive UI claims from the frontend, claim-type-specifically**
        (added in round 4, R4-8 — the sweep was backend-only while method step 2
        grounds UI claims in component/state code, so a changed React page,
        route, hook, or state transition could falsify a documented UI claim
        without ever entering the sweep). For every "the UI shows S in state T"
        claim, re-enumerate the owning page/component/state surface and confirm
        the state still exists and still renders as described. This matters most
        for `admin-console`, `public-site-and-sharing`, `accounts-and-auth`,
        `community-and-engagement`, and `meme-and-video-studio`, which are
        largely UI chapters.
      - **Diff the whole owning subsystem** between baseline and `main` — on the
        backend `artifacts/api-server/src/routes/`, the relevant `src/lib/`
        subtree, `lib/db/src/schema/`, and new migrations; **and on the frontend**
        `artifacts/overhype-me/src/pages/` (incl. `pages/admin/`), the owning
        `src/components/` subtree, and `App.tsx` routing — not only the files
        cited.
      - Re-ground anything that moved, and update the chapter plus its baseline
        line.
   3. **Repeat the sweep if PR 12's base advances** before it merges. Close-out
      evidence must cover every intervening merge, not just the tree each
      chapter PR saw.

   **This is already live rather than hypothetical:** while this plan was under
   review, `main` gained `fix(async-jobs): stop autoscale scale-ups reclaiming
   live jobs` (`6b545dde`) — which touches the async-jobs *reclaim* behavior,
   i.e. exactly the crash-reclaim guarantee the PR 1 de-fork must migrate. The
   de-fork therefore grounds that fact against post-`6b545dde` code, not against
   what the chapter says today.

   In-repo baselines are deliberate: PR bodies are not in the repository, so a
   baseline recorded only there would be undiscoverable at close-out. Using each
   file's last-touching commit instead was rejected — a later typo fix would
   silently advance the baseline and make the sweep skip real drift.

### The gate change

`scripts/check-docs-accuracy.mjs`: add `"docs/manual"` to `LIBRARY_DIRS` — both
the link check and the path check, deliberately, because chapters cite "stable,
high-value code entry points" and a wrong path in a human-facing chapter is the
worst case the gate exists to prevent. Verified passing against today's tree.

## Data Model and Migration Impact

**None.** No schema, no stored data, no migration, no backfill of rows. The word
"backfill" here refers to writing documents. Nothing to make idempotent and
nothing to roll back beyond `git revert`.

## Runtime Behavior

**No runtime behavior changes.** The only executable change is one array literal
in a CI script, which widens what the Build job checks. Edge case worth naming:
if a future chapter cites a path that later moves, CI now **fails the PR that
moves it** — intended, and the same contract `docs/ai-context/` already lives
under.

## Admin/User UX Impact

**None** — no UI, no copy, no async surface, no moderation implications. The
"UX" affected is a reader's: David and future collaborators get 12 chapters
instead of 3.

Per `agent-working-rules.md`'s ship-the-UI-surface exception, this pass has no
product-visible behavior, so it ships **verification notes in PR bodies** in
place of TEST_RUN/UAT docs.

## Security, Permissions, and Validation

No routes, guards, or validation schemas change. Two security-adjacent
obligations this plan does carry:

- **Public-repo disclosure discipline applies to the new docs, not just to this
  plan.** The `accounts-and-auth`, `payments-and-membership`, and
  `admin-console` chapters describe areas where a careless sentence could
  disclose an exploitable specific. Each of those chapters/specs describes
  **design and behavior**, and defers to `security-model.md` for posture; none
  documents an unremediated weakness, a bypass recipe, or a fraud-enabling
  path. If drafting one surfaces such a detail, it goes to David privately
  instead of into the doc — the same carve-out that governs plans.
- `security-model.md`'s existing content is **not** relocated into the new
  specs (see *Source-of-Truth Analysis*), so nothing security-relevant becomes
  harder to find or ends up maintained in two places.

## Testing Plan

Docs have no runtime behavior, so "testing" is the gate plus the claim
verification:

- `node scripts/check-docs-accuracy.mjs` — must pass on every PR, and from PR 0
  onward it covers `docs/manual/`. This is the automated general invariant
  (every link resolves, every cited repo path exists), not a spot check.
- `pnpm run check:docs` — the same gate via the package script, run locally
  before each push.
- The per-chapter **claim inventory** (method step 1–3) is the substantive
  verification, with its result summarized in the PR body.
- **Negative case for the gate itself, once:** in PR 0, confirm the widened gate
  actually fails on a bad manual link/path (introduce one locally, see it fail,
  revert) — otherwise "we added it to the array" is unproven and could silently
  cover nothing.
- No test-suite runs are needed beyond CI's own, since no product code changes.
  CI (`Build` + `Test`) remains the authoritative gate.

## Implementation Steps

**13 PRs, and they are not all independent** — the original "every later PR is
independent" claim was false (round 1, F6). The real graph:

- **PR 0 blocks everything** (it establishes the TOC shape and the gate).
- **PR 1 (the async-lane de-fork) blocks PRs 2–11.** Added in round 2: the
  de-fork section and PR 1's own entry both said it must land before any new
  chapter, but this graph omitted the edge and said everything else was
  parallel — so an executor following the graph could land PR 2 first and
  measure it against still-duplicated lane truth. Every ordering constraint
  stated in the steps is now represented here.
- **PR 7 (payments) depends on PR 6 (accounts)** — tier semantics build on
  account truth. My own plan said so while also claiming independence.
- **PR 12 (close-out) depends on PRs 0–11 having landed *and* on zero chapters
  sitting at *partial — pending fix*** (see the close-out gate below).
- Everything else is genuinely parallel and may land in any order.

**The close-out gate (round 2).** "PRs 0–11 landed" is not sufficient for PR 12.
A rung-2 chapter (disposition ladder, method step 7) does not count as complete,
so while any TOC row reads *partial — pending fix*, PR 12 is **blocked** — it
cannot retire the roadmap entry and declare the manual complete. Notifying David
does not clear it. Exactly one of these unblocks it:

1. The underlying code fix lands and the omitted claim is grounded and written
   (the row flips to written), or
2. **David explicitly revises the promised coverage** — in which case PR 12's
   roadmap entry says the manual is complete **except** that area, naming it,
   rather than claiming full coverage.

<!-- -->

- **PR 0 — Foundation.** Restructure `docs/manual/README.md`'s TOC to the final
  12 chapters **in reading order** (unwritten ones listed *not yet written*),
  fix its stale "no substantive chapters exist yet" line, correct
  `current-roadmap.md`'s deferred entry (background work is written; drop the
  resolved **Needs David confirmation** on timing — but **do not retire the
  entry**, that is PR 12), and add `"docs/manual"` to `LIBRARY_DIRS` with the
  negative test below. Two additions from round 3, both of which have to live in
  the **shipped** README rather than only in this plan (which never reaches
  `main`):

  - **The orientation section** — the core loop in one page plus "how to read
    this manual," so the reading order is navigable rather than implicit in row
    order.
  - **An "Outside this manual" section** naming what deliberately lives
    elsewhere and linking it: operations and diagnostics
    (`docs/SENTRY.md`, `health.ts`/`routeStats.ts`), edge/CDN behavior
    (`docs/cloudflare-rate-limits.md`, `docs/cloudflare-gaesa-og-fix.md`), local
    dev tooling (`scripts/dev-supervisor.sh`), the agent-facing spec layer
    (`docs/ai-context/`), and the generated
    [Admin Field Reference](../ADMIN_FIELD_REFERENCE.md). Without this, the
    delivered README claims full coverage while giving a new collaborator no
    hint that diagnostics and deployment material exists at all — the exclusion
    decision would die with this plan-review PR. This is the *navigational*
    half of decision 10; it does not reverse the decision.

  PR 0 is still the "no prose claims" PR: the orientation text restates the
  core loop from `product-brief.md` and links it, and the outside-this-manual
  list is pointers only.
- **PR 1 — De-fork the async-lane truth, and add the email-queue section.**
  Migrate chapter-only lane facts into `architecture-map.md`, then reduce
  `background-work.md`'s machinery section to narrative + link (see
  *Source-of-Truth Analysis*). **Also lands that chapter's email-queue-mechanics
  additive section** — round 4 (R4-3) caught that the coverage map and the DoD
  both require it while no PR in the list actually performed it (PR 5 covers the
  distinct *admin surface*), so an executor could land PRs 0–11 and discover the
  omission only at close-out. It rides here because this is the only PR that
  edits that chapter. Lands before any new chapter so the no-two-homes bar is
  true when the rest is measured against it.
- **PR 2 — `content-lifecycle.md`.** Spec exists. First new chapter, so it
  calibrates the verification method and the review rhythm on strong-spec ground.
- **PR 3 — `personalization-and-grammar.md`.** Spec exists.
- **PR 4 — `visual-pipeline.md`** chapter. Spec exists (523 lines) — the chapter
  must resist restating it.
- **PR 5 — `admin-console.md`** (+ eval-dashboard, Email-Queue-surface, and
  comment-moderation-surface sections). Links the generated field reference.
- **PR 6 — `accounts-and-auth.md`**: new spec + chapter + `AGENTS.md` routing.
- **PR 7 — `payments-and-membership.md`**: new spec + chapter + routing.
  **Depends on PR 6.** Carries the disposition-1 known limitation (method step 7).
- **PR 8 — `community-and-engagement.md`**: new spec + chapter + routing.
- **PR 9 — `public-site-and-sharing.md`**: new spec + chapter (+ merch/affiliate
  section) + routing.
- **PR 10 — `meme-and-video-studio.md`**: new `video-pipeline.md` spec + chapter
  + routing, plus the media-storage-and-delivery section.
- **PR 11 — Existing-chapter edits.** Two things, both touching already-written
  chapters, split out of the studio PR so a chapter repair doesn't share an
  unrelated PR's review and failure boundary:
  - **`moderation.md`'s legal/safety section + its new spec
    `docs/ai-context/legal-safety-moderation.md`** (round 4, R4-12). The section
    was previously the one piece of new narrative with **no spec to link into** —
    `moderation-workflow.md` covers the separate content-quality system and
    `architecture-map.md` offers only a one-line pointer, so a non-skeletal
    section would have had to duplicate code-level truth or invent it. That
    violated decision 2 applied to itself. The spec covers classifier decisions,
    quarantine, evidence retention, and the NCMEC-reporting path, and **names
    which evasion-sensitive details stay private** — a scanner's exact
    thresholds and bypass-relevant specifics are rung-0 material, triaged with
    David before anything is written.
  - **`taxonomy-and-enrichment.md`'s baseline line + any drift corrections**
    (round 4, R4-2). It is the one chapter the DoD requires a
    `Verified against <sha> · claim inventory in PR #<N>` line for while no PR
    owned it, because its coverage-map row is "drift corrections only." This PR
    is its owner.
- **PR 12 — Close-out.** Runs the pre-close-out re-grounding sweep (method
  step 8) and the coverage sweep (the derivation rule's step 3); retires the
  roadmap's backfill entry and moves it to recently-merged; appends anything
  deliberately deferred to `docs/engineering/deferred-work.md`. **Only after
  PRs 0–11 have landed, and only with zero chapters at *partial — pending fix*
  and zero unresolved *Needs David confirmation* markers.**

  **This PR carries the sweep's re-grounding evidence for all 12 chapters**
  (round 4, R4-2 — the plan required close-out inventories without saying where
  they live). That does not violate one-chapter-per-PR: it publishes *deltas*
  from a single sweep, not twelve new chapters, and any chapter whose re-grounding
  turns out to need real rewriting gets its own follow-up PR instead of being
  buried here.

**Stopping early stays safe, with the distinction F6 exposed:** every PR leaves
the **TOC** truthful (unwritten chapters read *not yet written*), and the
**roadmap** keeps saying the backfill is in progress until PR 12 — so an
abandoned pass never reports itself complete.

Each PR: chapter (+ spec) + TOC row flipped to written + `AGENTS.md` routing if
a spec was added, in one commit; `/simplify` is not applicable to prose, but the
consolidation instinct is — no revision-history narration inside chapters.

## Risks and Mitigations

- **Drift discovery balloons the scope** (most likely risk, and the direct cost
  of David's verify decision). *Mitigation:* doc drift is corrected in place;
  code defects become report items, never drive-by fixes. If one chapter's drift
  is large enough to be its own workstream, I stop and bring it to David rather
  than absorbing it into a docs PR.
- **Forking truth** — 6 new specs overlapping `security-model.md` and the Stripe
  audit docs. *Mitigation:* the ownership table above, plus a
  "what lives here vs. elsewhere" header in each new spec so the boundary is
  self-enforcing.
- **Shallow review of prose at volume.** *Mitigation:* each PR's review request
  names that chapter's claim set and asks Codex to challenge **factual
  accuracy against the code**, not prose style — and the per-PR verification
  note gives it something falsifiable to attack.
- **Manual/spec contradiction after edits.** *Mitigation:* documentation-workflow
  Step 4's cross-check per PR, plus the now-enforced link/path gate.
- **A price or model name gets written down and immediately drifts.**
  *Mitigation:* the no-numbers rule in *Source-of-Truth Analysis*; vendor-owned
  values are described by shape and attributed to their runtime source.
- **Volume fatigue** (~3,000 lines of verified prose across 13 PRs). *Mitigation:* per-PR
  delivery with a truthful TOC after each, so stopping early leaves a coherent
  manual rather than a half-declared one.

## Non-goals

- **No `decisions.md` anchor validation** in the gate (today's check verifies the
  file resolves, not the `#anchor`). Several existing links are anchorless.
  Real, cheap-ish, and out of scope — it goes to
  `docs/engineering/deferred-work.md` instead of growing this pass.
- No regeneration or hand-editing of `ADMIN_FIELD_REFERENCE.md`.
- No wholesale rewrite of the 3 existing chapters.
- No chapters for areas outside the 12 — the sub-chapter areas are placed in the
  coverage map instead.
- **No operations/observability chapter** (decision 10). `health.ts`,
  `routeStats.ts`, Sentry, the Cloudflare rate-limit/OG-cookie notes, and
  `scripts/dev-supervisor.sh` are operational tooling rather than product
  narrative, and each already has a home (`docs/SENTRY.md`,
  `docs/cloudflare-rate-limits.md`, `docs/cloudflare-gaesa-og-fix.md`,
  `docs/ai-context/architecture-map.md`). Stated as a decision so the exclusion
  is on the record rather than looking like something the coverage sweep missed
  — and it is the one call in this plan I'd most expect David to overrule.
- No product code changes; no TEST_RUN/UAT docs; no `docs/plans/` file reaching
  `main` unless David asks to keep this one.

## Questions for David

**None.** The four scope questions were settled in the pre-plan conversation
(see *Settled Decisions*). Two things I resolved from the repo instead of
asking, recorded so the choice is visible: **(a)** no price numbers in any doc,
because `pricingPlans.ts` fetches plans live from Stripe and a written number
would be a second, drifting source of truth; **(b)** the accounts subsystem gets
its own spec rather than an extension of `security-model.md`, because that doc
is audit-shaped posture (findings `C1`/`C5`/`C6`/`C9`/`C10`) and absorbing
subsystem narrative into it would blur what it is for.

## Definition of Done

- [ ] **12 chapter files** exist in `docs/manual/`: the **9 newly written**
      (`content-lifecycle`, `visual-pipeline`, `personalization-and-grammar`,
      `admin-console`, `accounts-and-auth`, `payments-and-membership`,
      `community-and-engagement`, `public-site-and-sharing`,
      `meme-and-video-studio`), each with real content across all five template
      sections, **plus the 3 existing** carrying exactly the edits the coverage
      map assigns them — corrected in round 3, because this list previously
      contradicted the map and would have had an executor writing unplanned
      taxonomy prose while skipping required email-queue coverage:
      - `background-work.md` — **both** its de-fork (PR 1) **and** its
        email-queue-mechanics additive section.
      - `moderation.md` — its legal/safety additive section (PR 11).
      - `taxonomy-and-enrichment.md` — **drift corrections only**; no additive
        section is planned for it, and adding one is out of scope.

      Enumerated rather than counted because "8 chapters exist" could pass with
      3 old + 5 new (round 1, F7).
- [ ] **The manual reads front-to-back as a walkthrough**, not as 12 isolated
      essays: the README carries the orientation section and its TOC is in
      reading order, each chapter points at the next, and the
      visual-pipeline (authoring-time) / studio (use-time) boundary holds with
      neither restating the other (round 3).
- [ ] **The README's "Outside this manual" section exists** and links the
      operational, edge, dev-tooling, spec-layer, and generated-reference homes —
      so the ops exclusion is navigable after this plan-review PR closes.
- [ ] **6 new specs** exist in `docs/ai-context/` and are routed from
      `AGENTS.md` (the 5 chapter specs + `legal-safety-moderation.md`).
- [ ] **Zero TOC rows read *partial — pending fix*** — and if one does, PR 12 is
      blocked, not merely accompanied by a notification (round 2: telling David
      was previously enough, which reopened the same completion loophole F5
      identified). Cleared only by the fix landing and the claim being grounded,
      or by David explicitly revising the promised coverage so close-out names
      the excluded area instead of claiming full coverage.
- [ ] **Every chapter carries a `Verified against <sha> (<date>) · claim
      inventory in PR #<N>` line**, and the pre-close-out re-grounding sweep
      (method step 8) has been run against current `main` — **by re-deriving each
      chapter's enforcement set and diffing its whole owning subsystem**, not by
      diffing only the paths the chapter cites (round 3) — including a re-run if
      PR 12's base advanced.
- [ ] **Every PR body carries its chapter's full claim table** (claim →
      disposition → grounding source), not a grouped summary, so any claimed
      verification is traceable without my session (round 3).
- [ ] **PR 1's pre-edit fact inventory exists** and shows a disposition
      (relocate / retain as narrative / replace with link) for every claim in
      `background-work.md`'s machinery section, with the reduced chapter still
      satisfying all five template sections.
- [ ] `docs/manual/README.md`'s TOC matches reality — every row's status is
      correct, no row claims a file that does not exist and none omits one.
- [ ] `docs/manual/` is in `LIBRARY_DIRS`; `node scripts/check-docs-accuracy.mjs`
      passes, and was demonstrated to fail on a bad manual link/path.
- [ ] Every chapter/spec claim is grounded per the method, or explicitly marked
      **Needs David confirmation**; each PR body carries its verification note.
- [ ] No fact has two homes: each new spec's boundary header is present and
      `security-model.md` / the Stripe audit docs / `ADMIN_FIELD_REFERENCE.md`
      were not restated.
- [ ] `current-roadmap.md`'s backfill deferred entry is retired; anything
      deliberately deferred is in `docs/engineering/deferred-work.md`.
- [ ] CI green on every PR.
- [ ] **Exercisable in the product:** the deliverable *is* the reading
      experience — David can open `docs/manual/README.md` and walk the whole
      system, every TOC link resolving, without opening the code.

## Findings ledger

Maintained by me across review rounds — each finding, its status, and the lens
each round applied. Codex's transport posts defect findings only, so Resolved
vs. Superseded is my classification from my own fix history; silence on a named
item means "not still open," not automatically "resolved."

**Round 1 — lens: coverage completeness + source-of-truth integrity.**
7 findings (5×P1, 2×P2), all Required Revision, against commit `ab163d4`.
Every one verified against the repo before acting; none rebutted.

| # | Round | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| F1 | 1 | Async lanes have two canonical homes already (`background-work.md:51-88` vs `architecture-map.md:90-127`); the plan claimed no duplication and would have preserved the fork | P1 | **Resolved** — spec owns lanes; added a migrate-then-reduce de-fork PR (PR 1); found the copies had *already* diverged on poll intervals |
| F2 | 1 | "Posture vs. subsystem shape" too vague to implement; `security-model.md:36-61` owns concrete auth behavior | P1 | **Resolved** — replaced with a 10-row fact-level ownership table + the state-the-step/link-the-constraint rule |
| F3 | 1 | Community engagement (ratings, comments, hearts, activity feed) assigned to no chapter or section | P1 | **Resolved** — new chapter + spec (decision 9); coverage map rebuilt at route-module granularity |
| F4 | 1 | Global grounding precedence let a test outrank a `CHECK` constraint | P1 | **Resolved** — replaced with claim-type-specific grounding; tests demoted to corroboration |
| F5 | 1 | No disposition for a defect that makes a chapter misleading; DoD could pass on a silently dropped claim | P1 | **Resolved** — added the 3-rung disposition ladder + DoD item; payments case resolves to rung 1 |
| F6 | 1 | "Every later PR is independent" false (PR 7→6; close-out→all); moderation fix rode the studio PR | P2 | **Resolved** — explicit dependency graph, close-out split to PR 12, moderation split to PR 11 |
| F7 | 1 | DoD said "8 chapters exist" but the target is 12 files — could pass with 3 old + 5 new | P2 | **Resolved** — DoD now enumerates all 12 by name |
| S1 | 1 (self) | `health.ts` / `routeStats.ts` / Sentry / CF notes assigned nowhere — found by my own route sweep, not by Codex | — | **Resolved as explicit non-goal** (decision 10), flagged to David to overrule |
| S2 | 1 (self) | `storage.ts` (media upload + public/private object serving) assigned nowhere | — | **Resolved** — named section in `meme-and-video-studio.md`, authz stays in `security-model.md` |

**Round 2 — lens: execution-time durability + the two mechanisms round 1
created.** 4 findings (3×P1, 1×P2) against `7695bba`; three were
*Reconciliation — Still Open* re-openings of F1, F5, F6 rather than new ground,
which is the loop working as intended. All verified; none rebutted.

| # | Round | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| F1b | 2 | **F1 still open:** migrate-then-reduce named only *some* chapter-only facts, and a *post*-edit inventory cannot detect deleted prose. Codex found a third fact I had missed — the crash-reclaim guarantee at `background-work.md:87-88`, verified absent from all of `docs/ai-context/` | P1 | **Resolved** — the fact inventory is now a **pre-edit hard gate** mapping every machinery claim to relocate / retain / link, and the plan states that its own enumerated lists are examples, not the source of truth |
| F5b | 2 | **F5 still open:** the DoD let a *partial — pending fix* row persist on notification alone, and PR 12 keyed only on "PRs 0–11 landed" — so close-out could still declare a complete manual with a defect-affected behavior omitted | P1 | **Resolved** — added an explicit close-out gate: any partial row **blocks PR 12**, cleared only by the fix landing or by David revising the promised coverage so close-out names the exclusion |
| R2-3 | 2 | **New:** chapters are verified once, so a chapter grounded at PR 2 can be falsified by an unrelated merge before PR 12, and CI can't catch it (the gate checks links/paths, not behavior) | P1 | **Resolved** — method step 8: an in-chapter `Verified against <sha>` baseline, a pre-close-out re-grounding sweep, and a re-run if PR 12's base advances |
| F6b | 2 | **F6 still open:** the dependency graph omitted the `PR 2–11 → PR 1` edge that the steps stated twice — an executor following the graph could land a chapter before the de-fork | P2 | **Resolved** — edge added; graph now represents every ordering constraint stated in the steps |

**Round 3 — lens: cold-start executability + whether the promised artifact is
actually a good manual.** 5 findings (3×P1, 2×P2) against `558dc10`. One
re-opened R2-3; four were new, and two of them (R3-3, R3-5) are the first
findings in this loop about **reader value** rather than process. All verified;
none rebutted.

| # | Round | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| R2-3b | 3 | **R2-3 still open:** the sweep was scoped to each chapter's *cited* paths, but `docs/manual/README.md` deliberately limits citations to a few stable entry points — so a **newly added** writer/route/caller, the likeliest thing to break a documented invariant, would never enter the sweep | P1 | **Resolved** — the sweep now **re-derives the enforcement set** (every writer to the field, the current handler set) and diffs the **whole owning subsystem**, not the cited files |
| R3-2 | 3 | The only complete claim inventory lived in a scratchpad; the PR body kept a summary — making the promised verification unauditable, and contradicting the *Risks* section's promise to give reviewers the claim set | P1 | **Resolved** — the full claim → disposition → source table goes in every PR body, and each chapter's baseline line names the PR carrying it |
| R3-3 | 3 | **No reader-first sequence.** PR 0 only installed a TOC; ordering came from the coverage map. A cold executor could pass every filename and heading check and ship 12 isolated subsystem essays, with the visual-pipeline/studio boundary unspecified | P1 | **Resolved** — added a reading-order section following `product-brief.md`'s core loop, an orientation section in the shipped README, an explicit authoring-time vs. use-time boundary, and a front-to-back DoD item |
| R3-4 | 3 | The DoD's per-file criteria contradicted the coverage map — it demanded an additive taxonomy section (map says drift corrections only) and described background-work as only de-forked (map also assigns it the email-queue section) | P2 | **Resolved** — per-file criteria now match the map exactly |
| R3-5 | 3 | The ops exclusion existed only in this plan, which never reaches `main` — so the shipped README would claim full coverage with no pointer to where diagnostics/deployment material lives | P2 | **Resolved** — PR 0 adds an "Outside this manual" section to the shipped README; the decision survives this PR's closure |

**Round 4 — lens: public-repo disclosure risk + internal consistency after
three rounds of edits.** **12 findings** (6×P1, 6×P2) against `0ce2c85` — up
from 5, with three *Still Open* reconciliations. All verified against the repo;
none rebutted. **David was consulted before revising** (see below), because the
findings pointed at the plan's shape rather than its details.

| # | Round | Finding | Severity | Status |
| --- | --- | --- | --- | --- |
| R4-1 | 4 | The round-3 transparency fix collided with the disclosure carve-out: the full claim table goes in a **public** PR body, so rung 2 would publish the very claim and source the chapter withheld, and rung 1 publishes an unremediated weakness by design | P1 | **Resolved** — added **rung 0**: private triage with David before any public artifact, and rung-2 evidence becomes a redacted `security-hold-<n>` row rather than an omission |
| R4-11 | 4 | Module-level coverage assignment is neither exhaustive nor correct: submission is `reviews.ts:131` not `facts.ts`; `facts.ts:347` owns a share endpoint; `memes.ts` holds 23 endpoints spanning community, merch, and admin | P1 | **Superseded** — David chose to **delete** the hand-written table rather than rebuild it. Coverage is now derived per chapter at endpoint granularity, verified in the claim table, with a mechanical close-out sweep as the completeness check |
| R4-6 | 4 | **R3-3 still open:** the authoring-time/use-time chapter split is contradicted by `visual-pipeline.md:61-77` — render inputs freeze when *the user* clicks generate, wired into user-facing generate routes. The image pipeline is shared | P1 | **Resolved** — boundary redrawn by subject matter: ch. 5 owns the shared machinery whichever path invokes it; ch. 6 owns end-user controls, tier gates, and media journey |
| R4-2 | 4 | **R3-2 still open:** no PR owned `taxonomy-and-enrichment.md`, yet the DoD requires its baseline to name the PR carrying its claim table; close-out inventories had no home either | P1 | **Resolved** — PR 11 becomes "existing-chapter edits" and owns taxonomy; PR 12 explicitly carries the sweep's re-grounding evidence |
| R4-8 | 4 | **R2-3b still open:** the sweep re-derives only DB writers and route/handler sets, so a changed React page, route, hook, or state transition could falsify a UI claim without entering it | P1 | **Resolved** — added claim-type-specific frontend re-derivation and frontend subtree diffing |
| R4-9 | 4 | Chapters must point at the next chapter, but the gate rejects unresolved links and PRs 2–11 land in any order — so a forward pointer would break CI or ship a broken promise | P1 | **Resolved** — forward pointers target the README reading-order entry until the file exists; each PR backfills its predecessor's direct link. Adds no dependency edges |
| R4-12 | 4 | The legal/safety section was the one piece of new narrative with **no spec to link into** — decision 2 not applied to itself | P1 | **Resolved** — new 6th spec `legal-safety-moderation.md`, assigned to PR 11, with evasion-sensitive details routed through rung 0 |
| R4-7 | 4 | **Needs David confirmation** was a terminal disposition the DoD accepted, contradicting `documentation-workflow.md` and letting a "complete" manual carry unresolved product assertions | P2 | **Resolved** — draft-only state; must be confirmed, dropped, or excluded before a TOC row flips to written, and it blocks close-out |
| R4-3 | 4 | The email-queue section was required by the coverage map and DoD but performed by no PR in the list | P2 | **Resolved** — explicitly added to PR 1, the only PR that edits that chapter |
| R4-5 | 4 | `pages/admin/comments.tsx` is **not routed** (`App.tsx:382` redirects to the moderation panel; the file is imported nowhere) — the plan named a dead screen as a coverage target | P2 | **Resolved** — row now names `pages/admin/moderation.tsx`; the dead file is a report item for David, not a drive-by deletion |
| R4-4 | 4 | The coverage-map heading still said "Chapters (8)" above a 12-row table | P2 | **Resolved** — count derived from the table |
| R4-10 | 4 | `pages/not-found.tsx` (the catch-all at `App.tsx:406`) was unassigned; the plan counted 18 pages where the repo has 19 | P2 | **Resolved** — assigned to `public-site-and-sharing.md`, and named in the exclusions table as explicitly *not* excluded |

**Still open: 0.** Rounds completed: 4.

### What round 4 changed about the plan's shape, not just its content

Findings went 7 → 4 → 5 → **12**, and they clustered on one section: the
pre-computed route-module coverage map added in round 1. That section was
supposed to make coverage checkable; instead it was an unverified transcription
of the API surface that was wrong in specifics and generated most of each
round's findings, while every fix to it created new surface for the next round.

**David's call (option 1 of three I put to him): trim the plan rather than keep
grinding.** The map is deleted; coverage is derived per chapter, verified
against code as part of the work, and checked mechanically once at close-out.
The parts of the plan that have survived contact unchanged — the verification
method, the de-fork, the sequencing and close-out gates, the reading order, the
disclosure discipline — stay. One confirming round follows.
