# Current Roadmap

> Short and current — near-term context, not a speculative roadmap. Keep it
> trimmed; when a slice ships, move it up to "recently merged." No invented
> deadlines. Items not verifiable from the repo are marked **Needs David
> confirmation**.
>
> *Snapshot date: 2026-07-22 (through PR #229) — the visual-enrichment cleanup
> (PR #189, #192/#198, #206), the stale-fact-refresh arc (through PR #205), the
> security remediation arc (through PR #221), the async-jobs lane split
> (PR #216), the NB2 prompt-restructure + render-pipeline hardening arc
> (PR #222–#224), and speech/thought bubble controls (PR #229) are all
> reflected below; read `git log` for anything more recent.*

## Active area of focus

The **moderation + visual-render pipeline**: making moderation faster and the
rendered memes better, plus maturing the video pipeline. This maps to the current
business goals (launch/stability + content volume & quality) and near-term
priorities (moderation speed, render/enrichment quality, video). See
[`product-direction.md`](./product-direction.md).

## Recently merged or completed work

(From recent history — read `git log` for the live picture.)

- **Membership is derived from entitlements, not assigned per-event** (PR #287,
  from the plan reviewed on the closed-unmerged
  [PR #279](https://github.com/TheAnswerManIsHere/Overhypeme/pull/279), 32
  plan-review rounds). `users.membership_tier` stops being a value fifteen
  call sites wrote by hand — each with its own idea of which other sources to
  check first — and becomes a projection derived from durable
  `membership_entitlements` rows every time something about them changes. See
  [`membership-entitlements.md`](./membership-entitlements.md) for the model
  (three source types, the W1a trust boundary, per-source leases with
  fencing, grace episodes) and the manual's
  [Payments & Membership](../manual/payments-and-membership.md) chapter for
  the product-facing behavior. Comping a membership now writes an
  `admin_grant` entitlement — actor, reason, timestamp, revocation — never a
  fake payment and never a tier field; the admin membership-tier dropdown is
  gone, not merely hidden. **Scope was narrowed mid-build** (David,
  2026-07-30): reconciliation — the job that would repair a webhook Stripe
  never successfully delivers — did not converge after four review rounds and
  was pulled into its own deferred item rather than block the settled core.
  See
  [`decisions.md`](./decisions.md#2026-07-30--reconciliation-is-deferred-out-of-the-entitlement-model-pr-the-gap-is-accepted)
  and [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt).
  **The build ran 11 further code-review rounds after the plan converged**
  (101 findings total across both loops, every one fixed or explicitly
  recorded as a gap — none silently dropped); David stopped the loop after
  round 11 rather than chasing full convergence, a deliberate call recorded
  on the PR rather than an oversight. One gap surfaced in that final round —
  entitlement sources don't record which Stripe account (live vs. test) they
  came from — is filed as pre-launch hardening below rather than fixed inline,
  since it needs a migration and a backfill-semantics decision.
- **Async-queue hardening, Phase 1: worker liveness heartbeats + the Queue
  Health surface** (PR #288, from the plan reviewed on the closed-unmerged
  PR #282). Claim/retry/dedupe/lane **scheduling** semantics are unchanged —
  this phase adds observability, not new queue behavior, though it does
  write new state (see below). Each lane's worker now publishes a heartbeat
  (`worker_lane_heartbeats`), and three new endpoints comprise the surface:
  an admin aggregate view and an unauthenticated `/api/health/queues`
  liveness probe both read the heartbeat — the aggregate view already
  reports a fleet-wide stall as JSON data (always behind a 200); the probe
  uniquely turns that same verdict into the HTTP status code itself, a
  meaningful 503 when the API process is alive but every worker has stopped
  scheduling a lane fleet-wide; a paginated
  per-item drill-down (all eleven queues, not just email) reads only
  `async_jobs`, not the heartbeat. One narrow, David-approved exception to
  "no finalize changes": `processClaimedJob` now persists the resolved
  retry ceiling at the moment a row finalizes to `failed` — the
  `abandoned_no_retry` classification itself stays derived on every read,
  never stored (see
  [`decisions.md`](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live)).
  Also closed a real gap from the five-lane expansion (PR #256, which added
  the `pexels`/`ai_meme_backfill` lanes on top of PR #216's original
  fast/render/bulk split): the shared DB pool's
  `max` is now explicit and derived (20) instead of pg's implicit default
  (10), which had left zero spare connections once all five lanes were
  simultaneously busy. See
  [`architecture-map.md`](./architecture-map.md#worker-liveness-heartbeats--the-queue-health-surface-phase-1-pr-288)
  and the manual's [Background Work](../manual/background-work.md#worker-liveness-and-the-queue-health-surface)
  chapter. **Open next:** Phases 2–4 of the same plan are not yet
  scheduled — Phase 2 (two alert channels: in-app + an out-of-band webhook
  that doesn't depend on the DB-backed email queue), Phase 3 (claim
  fencing so a rare duplicate paid call is preferred over ever losing work),
  Phase 4 (the enqueue primitive moves to `onConflictDoNothing`).
- **Loop ledger backfilled + a CI guard against future gaps** (PR #286, rows
  #285/#286 folded in later via PR #290). Between the ledger's creation
  (PR #270) and 2026-07-29 it had accrued 2 rows against 13 closed loops,
  with zero rows in the bugfix and feature/code cohorts — the
  append-when-a-loop-closes obligation had nowhere to fail, so it was
  silently skipped while every PR stayed green. Backfilled: #274, #282,
  #283, #284 (the ledger's first `bugfix`-cohort row), #285, and #286
  (this backfill's own PR). New `scripts/check-ledger-coverage.mjs`, wired
  into the Build job, fails CI when a loop that closed *before the current
  PR opened* has neither a row nor a recorded exemption — a loop closing
  while a PR is already in flight stays unenforced until the next one
  opens. Also recorded in the same window: David enabled Codex
  "Exhaustive code review" (2026-07-29), now a dated boundary in the ledger.
  **The row-by-row numbers, the self-inflicted-share trend, the cohort
  mechanics, and the pre/post-boundary analysis all live in
  [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md)
  — read there, not here.** Duplicating that analysis into this file was
  the original design of this bullet and it went stale twice across PR
  #290's own review rounds (a trend claim, a cohort explanation, and a
  boundary claim each drifted from the canonical ledger before landing);
  this bullet is deliberately kept to a shipped-slice summary from here on.
  See also [`decisions.md`](./decisions.md#2026-07-29--codex-exhaustive-code-review-on-review-trigger-stays-on-pr-open--and-the-switch-is-a-dated-boundary-in-the-ledger)
  and [`working-modes.md`](./working-modes.md#the-loop-ledger). Two things
  surfaced but deliberately left unfixed, for David to decide: the ledger's
  own `classifyCohort` routes any **non-plan-review** PR carrying a
  non-ledger markdown file to `prose/contract` (a `[PLAN REVIEW]`-titled PR
  is checked first and stays `plan-review` regardless), which is part of
  why the `feature/code` cohort is still empty (see the ledger's
  cohort-leakage note for the precise mechanism);
  and #279 ran 32 rounds, about 12 past the ~20-round soft cap meant to
  trigger a check-in, with no record of whether one happened (see the
  ledger's row 6).
- **The loop ledger: every AI-agent review loop gets a permanent, falsifiable
  row** (PR #270). Both Claude Code and Codex now append a row — mechanical
  columns machine-derived, judgment columns hand-entered and marked as such —
  every time a review loop closes, adjudicated over the **full** finding
  population (not a sample; see `decisions.md` for why the sample was
  removed). The PR's own 16-round, 34-finding loop produced its own row as
  the pipeline's first real acceptance test. See
  [`decisions.md`](./decisions.md#2026-07-27--the-loop-ledger-every-review-loop-gets-a-permanent-falsifiable-row--adjudicated-over-the-full-population-not-a-sample)
  and [`working-modes.md`](./working-modes.md#the-loop-ledger).
  **Open next step:** the ledger's designated acceptance test — a blind
  adjudication replay of PR #268's 40 findings, checked against its existing
  retrospective classification — hasn't run yet. Several other process
  controls (from the plan that produced this ledger) are parked, unbuilt, on
  the closed-unmerged PR #269; David's call was to resume them one at a time,
  informed by the ledger's own data (the `pre-open preflight` column is
  empty precisely because no control measures it yet), after that replay
  validates the rubric — not before, and not as one combined effort.
- **TEST_RUN checklist contract** (PR #263, #264). New
  [`docs/engineering/test-run-contract.md`](../engineering/test-run-contract.md)
  restructures per-PR TEST_RUN checklists around what only Replit's live
  environment can verify (migration state, post-merge repo-health gates,
  live-config behavior, scoped tests), demotes the full sharded suite to an
  explicit shared-infra-touched verdict instead of a default step, and
  requires every api-server test command route through its wrapper script
  (`run-test.sh` targeted, `run-tests-sharded.sh` full suite) rather than a
  raw `node`/`tsx` invocation that bypasses the production-DB guard. Applied to
  the 6 still-live checklists. See
  [`decisions.md`](./decisions.md#2026-07-26--test_run-checklists-are-scoped-to-what-only-replits-live-environment-can-verify).
- **Pricing page showed only one upgrade plan** (PR #255). Root cause: the
  page classified a whole Stripe *product* into monthly/annual/lifetime by
  its name (or defaulted to only its cheapest price), which collapses onto
  one bucket when a single product carries multiple price points — Stripe's
  natural "one product, several prices" dashboard setup. Fixed by classifying
  each price independently by its own `recurring` field, and (per Codex
  review on the same PR) filtering to `overhype_membership`-tagged products
  first so a future non-membership SKU can't get advertised as a Legendary
  plan. See
  [`decisions.md`](./decisions.md#2026-07-25--stripe-plan-selection-classifies-by-each-prices-own-recurring-field-and-only-from-membership-tagged-products)
  and
  [`known-failure-patterns.md`](./known-failure-patterns.md#stripe-plan-selection-classify-by-price-identity-not-product-identity).
  **Correction (2026-07-28):** this fix did not fully resolve the symptom —
  David reported it recurring, and diagnosis found an unrelated cause (a
  silently-failed Stripe sync with no visible failure state). See the newer
  decision and failure-pattern entries in "In-progress slices" below.
- **Variant independence: `parent_id` is kinship, never metadata inheritance**
  (PR #256). A variant now classifies from its own text only, owns its own
  stock/AI images (generation included, not just display), and the three
  bulk-backfill routes run through a new durable async queue (`fact_pexels` /
  `fact_ai_meme_backfill` lanes) instead of blocking the request. A bounded
  repeated-failure circuit breaker protects bulk-send-back from an unbounded
  retry loop on a persistently-failing fact. New Bulk Media Backfill admin
  panel. See
  [`decisions.md`](./decisions.md#2026-07-24--variants-are-independent-facts--parent_id-is-kinship--showhide-only-never-metadata-inheritance),
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md#variants-are-independent-facts),
  and [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).
- **Engineering deferred-work backlog + a 9-CVE dependency patch sweep**
  (PR #245, #246). New process infrastructure: a single durable backlog for
  deferred engineering/security/maintenance work
  ([`deferred-work.md`](./../engineering/deferred-work.md)), wired into the
  weekly `/maintenance` skill. Its first real use found that three "safe
  patch" dependency bumps parked in the blocked Dependabot PR #243 actually
  fixed 9 disclosed CVEs — including a SQL injection in `drizzle-orm`, the
  production ORM — and shipped them immediately rather than waiting on the
  unrelated `sharp` blocker. See
  [`decisions.md`](./decisions.md#2026-07-24--deferred-engineering-work-gets-one-durable-backlog-split-from-the-product-roadmap).
- **Fact lifecycle closed: one entrance, one exit** (PR #242 — Codex review
  converged after 11 rounds, CI green except one open policy call below; **not
  yet merged**). `facts.is_active` now defaults `false`; `activateFact` is the
  sole `is_active` false→true writer, backstopped by a DB CHECK requiring a
  non-empty Visual Concept; every ingestion path (manual submit, bulk import,
  variant creation) funnels through `createTriageReview` into Stage-1 triage;
  the admin Active toggle is deactivate-only, and a new
  `resubmit-for-moderation` route puts a deactivated fact back through the same
  review pipeline under its existing id. See
  [`decisions.md`](./decisions.md#2026-07-23--fact-lifecycle-closed-one-entrance-one-exit--activation-is-moderation-only-and-deactivation-is-reversible-through-moderation-not-a-direct-toggle),
  [`moderation-workflow.md`](./moderation-workflow.md), and
  [`moderation.md`](../manual/moderation.md).
- **Speech & thought bubble controls.** Explicit moderator-authored speech/
  thought balloons compile as a new required, dedupe-exempt prompt section
  with their own dedicated 900-char budget pool (ceiling raised 6000→6900 to
  fund it); the candidate Visual-concept generator proposes bubbles when a
  fact contains literal quoted speech, with atomic pick-then-save and a
  server-shared saveability proof; one shared `BubbleEditor` on both admin
  surfaces (PR #229). See
  [`visual-pipeline.md`](./visual-pipeline.md#speech--thought-bubbles-moderator-control-compiler-owned-language)
  and
  [`decisions.md`](./decisions.md#2026-07-22--speech--thought-bubbles-a-dedicated-900-char-budget-pool-funded-by-raising-the-prompt-ceiling-not-by-shrinking-an-existing-reserve).
- **NB2 prompt restructure + render-pipeline hardening.** Compiled prompt
  restructured into a labeled contract with the moderator Visual Concept
  verbatim + leading, single-channel style, and literal-vs-visual supporting
  text (PR #222); render identity + look-style frozen once at click time
  instead of re-resolved live by the worker, with the image-prompt identity
  reduced to a short prompt-safe name (PR #223); async render failures split
  into terminal (fail-fast, typed `error_code`) vs retryable, the moderator
  prompt budget measured through the real compiler instead of estimated
  (engine ceiling raised 4000→6000 chars), the compiler's silent
  required-content truncation retired in favor of a terminal
  `required_budget_overflow`, and the built-in style catalogue trimmed to a
  canonical ≤180-char set (PR #224). See
  [`visual-pipeline.md`](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility)
  and
  [`decisions.md`](./decisions.md#2026-07--nb2-render-pipeline-hardened-terminal-async-failures-a-measured-prompt-budget-6000-char-ceiling).
- **Security review + remediation (findings C1–C10)** — a full security pass and
  fix arc: auth hardening (login/register rate limits, password-reset session
  invalidation, min-8 password — #210), video/object IDOR (#212), private memes
  made owner-only + uncacheable (#213), Stripe membership price allowlist enforced
  at the grant layer (#214), application security headers (#215), removal of a
  committed prod DB dump + gitignore + Dependabot (#217), admin input validation
  incl. a path-traversal fix (#218), and the dev-admin-login backdoor hardened
  fail-closed (#221). The durable posture lives in
  [`security-model.md`](./security-model.md).
- **Async-jobs worker split into fast/render/bulk lanes** — fixed head-of-line
  blocking where a pure-DB admin action or a moderator-watched test render
  could queue for 30s+ behind unrelated slow/bulk work; each lane now has its
  own timer, re-entrancy guard, and concurrency bound (PR #216). See
  [`decisions.md`](./decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes)
  and [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).
- **Auto-tokenize admin Visual-Concept authoring** — moderators write plain
  English in the Visual Strategy Override; Save auto-tokenizes (reusing the
  fact-submission tokenizer) and shows the result before persisting; a role
  binding's `entity` is a plain label, never a token, enforced client-side and
  by a schema backstop (PR #206). See
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md) and
  [`visual-pipeline.md`](./visual-pipeline.md#visual-strategy-override-authoring-auto-tokenize-on-save).
- **Visual Concept leads the compiled prompt** — the compiler now leads every
  render mode with the moderator's Visual Concept (CORE SCENE); the old
  `REFERENCE INTERPRETATION` section (which could double a subject's name) is
  retired, replaced by the additive `ROLE DETAILS` section (PR #192, #198).
  See [`visual-pipeline.md`](./visual-pipeline.md#prompt-compiler).
- **`subjectFactCompatibility` never blocks rendering** — a "poor"
  subject/fact-compatibility rating stays advisory-only in every render mode;
  it no longer hard-blocks a generation (PR #189).
- **Three-step moderation (Visual Concept gate)** — split the bundled visual-review
  step into an explicit **Visual Concept** gate (`concept_review`) before any render
  spend, then **Test Renders** (`production_review`); renders force-fire on gag
  approval (PR #179). See [`moderation-workflow.md`](./moderation-workflow.md).
- **Candidate Visual Concepts** — backend + frontend 3-card picker (PRs #163, #166)
  and lowercase-token acceptance in the Visual Concept field (#167).
- **Versioned enrichment / stale-fact refresh — full arc shipped.** Core +
  send-back UI + version history + candidate editing (PRs #160, #164); manual
  ProcessingSignature/engine-revision staleness tracking + Taxonomy Health
  lens (PR #168); bulk send-back — fan the single-fact primitive out via the
  async queue, initiation only, never auto-promotes (PR #205). See
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
- **Faster moderation** — removed the slow approval preflight; instant approve,
  live "test renders" pills, reject-in-visual-review (PRs #162, #165).
- **Tokenizer grammar correctness batch** — `{NAME_POSSESSIVE}` rendering,
  sibilant `-sses` verb fix, `{NAME}`-subject object-separated coordination
  reach, retiring the never-valid "They's" render (+ backfill), and a single
  deterministic grammar pass (`applyDeterministicGrammar`) shared by every
  fact-writing route (PR #188). See
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Frontier-model visual planner + moderator-authored Visual Concept** (PR #157).
- **Enrichment field-doc popovers** + generated `ADMIN_FIELD_REFERENCE.md` (#153),
  moderation override tracking (#155), AI-suggested hashtags on submission (#150),
  tokenizer conjugation fixes (#151).

## In-progress slices

- The **"Slice 2A" visual-concept** line of work (candidate concepts) is the most
  recent active thread. **Needs David confirmation** on what's next in that slice.
- **Stripe billing legibility + multi-plan support** — plan drafted 2026-07-28,
  not yet through Codex plan-review. Phase 1 (admin-only): always render the
  sync's persisted per-resource failure state (see
  [`known-failure-patterns.md`](./known-failure-patterns.md#persisted-syncjob-failure-invisible-after-reload)),
  show which Stripe account is connected, and flag untagged/unsellable
  products. Phase 2 (customer-facing): replace `selectPlanPrices`'s fixed
  Monthly/Annual/Forever slots — which silently drop a duplicate price or an
  unusual cadence like quarterly — with a function that renders every
  membership price in the catalog. See
  [`decisions.md`](./decisions.md#2026-07-28--the-lifetime-only-upgrade-bugs-real-root-cause-was-a-silently-failed-stripe-sync-not-plan-selection-logic).
- **Overhype.me Manual — one-time chapter backfill.** David approved the plan
  on 2026-07-30 and the pass has started. Target: **12 chapters in reading
  order** (9 newly written) plus 6 new `docs/ai-context/` subsystem specs for
  the areas that had none to link into. Three chapters are already written —
  moderation, taxonomy/enrichment, and **background work** (the previous
  wording, under deferred work, listed background work as outstanding; it is
  not). `docs/manual/README.md`'s table is the live status. This entry is
  retired by the pass's final close-out PR, not before — so the roadmap never
  claims the backfill is finished while chapters are missing.

## Pre-launch hardening (must-do before go-live)

- **Record the Stripe mode on every entitlement source.** Sits here rather than
  in the deferred list because the thing that triggers it *is* a go-live action.
  Provider-backed sources in `membership_entitlements` store only the Stripe
  object id, and `loadSourceSnapshots` derives membership from every retained
  row — so a **test-mode** membership created before flipping
  `stripe_live_mode` keeps granting Legendary afterwards. A live-mode refresh
  cannot repair it either: the test object does not exist in the live account,
  so the source is permanently unverifiable rather than merely stale.
  - **Shape.** A `livemode` column on `membership_entitlements`, written from
    the retrieved Stripe object at the trust boundary, and excluded from (or
    recomputed by) the derivation when it does not match the active mode.
  - **The part that is a decision, not a mechanic.** What `livemode` should be
    for rows that predate the column. Defaulting them all to the *current* mode
    is a guess, and guessing permissively recreates the exact bug the column
    exists to prevent — so the backfill needs David's call, and the migration
    wants `/overhype-migration-review`.
  - **Sequencing.** No longer blocked — PR #287 merged and
    `membership_entitlements` exists on `main`. This is now the actual next
    prerequisite for go-live, not a dependency waiting on something else to
    ship.
  - **Exposure meanwhile.** Operator-only. No customer path reaches it, and no
    live purchase is affected. Found by Codex on PR #287 round 11 and escalated
    rather than patched in at the end of an eleven-round review loop.
- **Scope/rotate `ADMIN_API_KEY`.** A single static key grants 9 admin routes
  (incl. `set-password` and the bulk backfill launchers) without a session;
  decide whether to scope, rotate, or replace it.
- *(The dev-admin-login backdoor, C1 — the review's highest-severity finding —
  is now hardened fail-closed, PR #221. See
  [`security-model.md`](./security-model.md#dev-admin-login-backdoor-c1).)*

## Near-term planned slices

- **Moderation-speed / reviewer-toil reductions** — ergonomics of the review +
  visual-review flow. **Needs David confirmation** on specifics.
- **Render/enrichment quality** — robustness of versioned refresh and stale-render
  handling.
- **Video meme pipeline** — maturity + user-facing status/experience.

## Explicitly deferred work

> This section holds deferred **product/feature** work. Deferred
> **engineering** work — parked dependency bumps, security-hardening
> follow-ups, toolchain deprecations, code-level tech debt — lives in
> [`docs/engineering/deferred-work.md`](../engineering/deferred-work.md).

- **Speech/thought bubble follow-ups.** The runtime image-prompt planner
  proposing bubbles (only the candidate Visual-concept generator does today);
  end-user wizard exposure (moderator-only for now); `thinking_level: high`
  as a spatial-attribution lever (the engine adapter exposes it but the image
  job doesn't pass it — needs a latency/cost/both-paths evaluation first);
  post-composited/SVG bubble rendering; per-bubble placement, color, and font
  styling; a "Use scene only" partial candidate-pick action; OCR-based
  exactness scoring (PR #229).
- Broad public-growth surfaces and free→Legendary conversion optimization.
- R2 storage consolidation (images currently on Google Cloud Storage).
- New content formats beyond "facts."
- A multi-role admin permission model.
- Version rollback (archive rows exist; `TODO(version-rollback)` not wired).

## Open product questions

- **Should admin (`requireAdmin`) routes ever get rate limiting?** CodeQL
  flagged the new `resubmit-for-moderation` route (PR #242) as high-severity
  "missing rate limiting." Verified this matches ~30 existing `requireAdmin`
  routes across `admin.ts`/`reviews.ts` — none are rate-limited; the two
  rate-limiter factories in the repo are used exclusively on public/
  authenticated-user-reachable routes (fact submission, AI generation). Pending
  David's call: dismiss the alert as consistent with the existing admin trust
  boundary (session + role, not per-request throttling), or start adding rate
  limiting to admin routes as new policy.
- Should any render scenario become a **hard** approval gate (today all waivable)?
- Should any subset of a refresh (e.g. one where only non-render-affecting
  inputs moved) ever skip a human gate? Explicitly NOT decided by PR4 — bulk
  send-back only initiates; see the PR #168/#205 entry in
  [`decisions.md`](./decisions.md).
- *(Add here when a real product decision is pending — don't guess.)*
