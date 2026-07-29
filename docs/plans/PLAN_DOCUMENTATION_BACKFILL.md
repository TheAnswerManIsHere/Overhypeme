# Plan — Overhype.me Manual: the one-time documentation backfill

> **Status:** plan under review. Not approved. Not started.
>
> Scope in one line: bring the [Overhype.me Manual](../manual/README.md) to full
> first-version coverage — 12 chapters, 9 of them newly written — write the 5
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
2. **Write the 5 missing specs** rather than letting new chapters carry deep
   detail themselves. Rejected alternative: self-contained chapters — faster,
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
  (18 public pages), `artifacts/overhype-me/src/pages/admin/` (16 admin
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

No new source of truth is created. Each of the 5 new specs opens with an
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

So the plan now **de-forks** rather than preserving it, and the direction is
migrate-then-reduce so nothing is lost:

1. Relocate chapter-only facts (poll intervals, the never-auto-retried
   `ai_meme_backfill` rationale) **into** `architecture-map.md`.
2. Reduce the chapter's "The machinery" section to product-level narrative —
   *why* independent lanes exist, what kind of work each is for, why one durable
   table beats an in-memory queue — with a link for the enumerated mechanics.
3. Verify the reduced chapter still reads as narrative, not as a stub.

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

**Chapters (8).** ✅ = already written.

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

**New specs (5):** `docs/ai-context/accounts-and-auth.md`,
`payments-and-membership.md`, `community-and-engagement.md`,
`public-site-and-sharing.md`, `video-pipeline.md`. Each is added to `AGENTS.md`
routing in its own PR (documentation-workflow Step 2's "a brand-new context doc
was created" row).

#### Every route module and public page, assigned

The original "coverage map" was area-level, which let a whole interaction loop
fall through it — Codex enumerated all 31 route modules and found ratings,
comments, comment hearts, and the activity feed assigned to nothing (F3;
verified at `facts.ts` `POST /facts/:factId/rating`, `GET|POST
/facts/:factId/comments`, `POST /comments/:id/heart`, and `reviews.ts` `GET
/activity-feed` + `POST /activity-feed/mark-read`). The fix is to assign at
**module** granularity so the coverage claim can be checked mechanically.

| Route module | Home |
| --- | --- |
| `facts.ts` (submission, publish) | `content-lifecycle.md` |
| `facts.ts` (rating, comments, comment hearts) | `community-and-engagement.md` |
| `reviews.ts` (review gates) | `moderation.md` |
| `reviews.ts` (`/activity-feed`, `/activity-feed/mark-read`) | `community-and-engagement.md` |
| `import.ts` (API-key bulk fact import) | `content-lifecycle.md` (a second entrance) |
| `ai.ts` (tokenize, suggest-hashtags, check-duplicate) | `content-lifecycle.md` + `personalization-and-grammar.md` |
| `render.ts`, `adminImagePrompt.ts` | `visual-pipeline.md` |
| `memes.ts`, `videos.ts`, `videoJobs.ts`, `pulidJobs.ts` | `meme-and-video-studio.md` |
| `storage.ts` (upload URLs, public/private object serving) | **section in `meme-and-video-studio.md`** ("where media lives and how it's served"), linking `security-model.md` for object authorization |
| `stripe.ts` | `payments-and-membership.md` |
| `auth.ts`, `localAuth.ts`, `users.ts` | `accounts-and-auth.md` |
| `hashtags.ts`, `og.ts`, `share.ts`, `shareCopy.ts`, `shareIntents.ts`, `heroExamples.ts` | `public-site-and-sharing.md` |
| `affiliate.ts` | section in `public-site-and-sharing.md` (merch) |
| `admin.ts`, `adminEngines.ts`, `adminReferenceResearch.ts`, `eval.ts` | `admin-console.md` |
| `adminTaxonomyHealth.ts` | `taxonomy-and-enrichment.md` (+ admin surface in `admin-console.md`) |
| `jobs.ts` | `background-work.md` |
| `health.ts`, `routeStats.ts` | **none — explicit non-goal** (decision 10) |
| `index.ts` | none — route mounting, not a surface |

Public pages map the same way: `Home`/`Search`/`TopFacts`/`Hashtags`/`Profile`/
`WearIt` → public-site; `FactDetail` (comments) / `ActivityFeed` → community;
`Library` (its `liked`/`submitted`/`history` tabs → community, its
`images`/`memes` tabs → studio); `SubmitFact` → content-lifecycle;
`Login`/`ForgotPassword`/`ResetPassword`/`VerifyEmail`/`Onboard` → accounts;
`Pricing` → payments; `MemePage`/`VideoPage` → studio (+ public-site for the
share surface); admin pages → `admin-console.md` except the three that belong to
their subsystem chapter (`moderation`, `taxonomy-health`, `videoStyles`).

**Sub-chapter areas — named, so "full coverage" is checkable:**

| Area | Home | Why there |
| --- | --- | --- |
| Merch / Zazzle affiliate (`WearIt.tsx`, `affiliate.ts`) | section in `public-site-and-sharing.md` | A public surface + outbound monetization path, not a subsystem. |
| Media storage & delivery (`storage.ts`, GCS, signed/public object paths) | section in `meme-and-video-studio.md` | Product-visible (memes load; private memes are access-controlled) but not chapter-sized; authorization stays in `security-model.md`. |
| Email queue mechanics | additive section in `background-work.md` | An `async_jobs` lane consumer; that chapter owns lane narrative. |
| Email Queue **admin surface** | section in `admin-console.md` | Surface vs. mechanics split, matching the two-layer pattern. |
| Eval dashboard (`eval.ts`, `evalDashboard.tsx`) | section in `admin-console.md` | An admin surface. |
| Comment **moderation** admin surface (`admin/comments.tsx`) | section in `admin-console.md`, cross-linked from `community-and-engagement.md` | The engagement chapter owns what comments *are*; the admin chapter owns the surface that moderates them. |
| Legal/safety moderation (`quarantined_memes`, `ncmec_reports`, `lib/moderation/`) | additive section in `moderation.md`, **in its own PR** | `architecture-map.md` establishes two separate moderation systems; the chapter documents only content-quality review today. Split out of the studio PR per F6 so a chapter repair doesn't share an unrelated PR's review boundary. |

### The verification method (the load-bearing part)

David chose verify-against-code, so the method is explicit and identical for
every chapter and spec:

1. **Draft, then inventory.** After drafting, extract every factual claim
   (behavioral, structural, numeric) into a per-chapter checklist in the
   scratchpad. Prose is not reviewed for truth in place; a claim list is.
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
3. **Three dispositions for an ungroundable claim:** drop it; keep it marked
   **Needs David confirmation** (per the README's style rule); or — if it is a
   *rationale* claim rather than a behavioral one — cite the `decisions.md`
   entry that settles it. Rationale is grounded by the decision record, not by
   code.
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
   Step 5). Instead each PR body carries a short **verification note**: what was
   grounded and against what, what is marked Needs David confirmation, and what
   drift was corrected. An obligation with no evidence trail decays.
7. **When a real defect would make the chapter misleading — the disposition
   ladder** (added in round 1, F5). Step 3's "drop the ungroundable claim" had a
   hole: a chapter could omit a defect-affected behavior and still be counted
   complete. It cannot. Exactly one of these applies, and which one is recorded
   in the PR body:

   1. **Document the real behavior as a known limitation** — the default. It
      goes in the chapter's *Boundaries & known limitations* section, linking the
      finding, and the code fix is filed as a report item for David. The chapter
      counts as complete.
   2. **Only if documenting it would disclose an exploitable specific** in this
      public repo: the chapter ships without that claim **and its TOC row is
      marked partial — pending fix**, with the gap taken to David privately. The
      chapter does **not** count as complete.
   3. **Never** silently drop the claim and count the chapter done.

   The payments chapter is the concrete case, and it resolves to disposition 1:
   `stripe-payments-audit-findings.md:82-129` documents that a transient webhook
   failure can leave a customer **paid but never granted membership** (the
   common checkout-redirect path self-recovers via
   `POST /stripe/checkout/confirm`; a closed tab does not). A current-state
   payments chapter cannot omit that. Disclosure is not a concern here because
   that finding is **already committed publicly on `main`** — writing it as a
   known limitation adds no new disclosure.

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
- **PR 7 (payments) depends on PR 6 (accounts)** — tier semantics build on
  account truth. My own plan said so while also claiming independence.
- **PR 12 (close-out) depends on PRs 0–11**, because retiring the roadmap entry
  announces the backfill is finished.
- Everything else is genuinely parallel and may land in any order.

<!-- -->

- **PR 0 — Foundation (no prose claims).** Restructure `docs/manual/README.md`'s
  TOC to the final 12-chapter map (unwritten ones listed *not yet written*), fix
  its stale "no substantive chapters exist yet" line, correct
  `current-roadmap.md`'s deferred entry (background work is written; drop the
  resolved **Needs David confirmation** on timing — but **do not retire the
  entry**, that is PR 12), and add `"docs/manual"` to `LIBRARY_DIRS` with the
  negative test below.
- **PR 1 — De-fork the async-lane truth.** Migrate chapter-only lane facts into
  `architecture-map.md`, then reduce `background-work.md`'s machinery section to
  narrative + link (see *Source-of-Truth Analysis*). Lands before any new
  chapter so the no-two-homes bar is true when the rest is measured against it.
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
- **PR 11 — `moderation.md` legal/safety section.** Its own PR, split out of the
  studio PR so an existing-chapter repair doesn't share an unrelated PR's
  review and failure boundary.
- **PR 12 — Close-out.** Retire the roadmap's backfill entry and move it to
  recently-merged; append anything deliberately deferred to
  `docs/engineering/deferred-work.md`. **Only after PRs 0–11 have landed.**

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
- **Forking truth** — 5 new specs overlapping `security-model.md` and the Stripe
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
      sections, **plus the 3 existing** carrying their specified edits
      (`background-work` de-forked, `moderation` + `taxonomy-and-enrichment`
      with their additive sections). Counted this way because "8 chapters exist"
      could pass with 3 old + 5 new (round 1, F7).
- [ ] **5 new specs** exist in `docs/ai-context/` and are routed from
      `AGENTS.md`.
- [ ] No chapter's TOC row is left marked *partial — pending fix* without David
      having been told why (method step 7, disposition 2).
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
