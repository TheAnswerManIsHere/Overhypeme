# Deferred Engineering Work

The single, durable home for engineering, security-hygiene, and maintenance
work we have **consciously chosen not to do yet** — dependency bumps we've
parked, deprecations we're carrying, cleanup we've postponed, toolchain debt.

This doc exists so that deferred work is **visible and revisited on a
schedule**, not lost in a chat or an inline `// TODO`. It is equally a record
that a deferral was a *deliberate, reasoned decision* — an item here with a
revisit condition that hasn't fired yet is **correctly parked, not debt we're
ignoring**. We don't chase an idealized codebase; we defer on purpose and act
when the trigger says to.

**Scope: engineering only.** Deferred *product/feature* work lives in
[`current-roadmap.md`](../ai-context/current-roadmap.md#explicitly-deferred-work)
— not here. If an item is "a feature we haven't built," it belongs in the
roadmap; if it's "maintenance/security/cleanup on code we've already shipped,"
it belongs here.

## How this doc works

**Every entry carries four things** — keep them, or the list rots into a
graveyard or a guilt-trip:

1. **What** — the deferred change, in one line.
2. **Why deferred now** — the honest "not worth it yet." This is the
   anti-perfectionism guardrail: it's permission to wait.
3. **Cost of waiting** — what we're accepting, and whether it grows.
4. **Revisit trigger** — a *condition*, never "someday." A dated event, a
   dependency shipping a fix, a recurrence count, a launch gate, or a
   named ritual (weekly maintenance / quarterly security review).

**Items get on the list** from: PRs we park (like a broken Dependabot bump),
major-version bumps we hold, Codex review findings we consciously defer,
deferred `/bugfix` items that are really tech debt, and deprecations spotted
in CI or lockfiles.

**Items come off the list** when done, or when we consciously mark them
*won't-do* (with the reason). Don't delete silently — a removed entry should
be traceable to "shipped" or "decided against."

**Triage cadence — no new ritual.** The weekly
[`/maintenance`](../../.claude/skills/maintenance/SKILL.md) pass re-reads this
doc and re-checks each revisit trigger; anything that has fired gets surfaced
to David. The quarterly `/security-review` consults the **Security & patching**
section. That keeps the backlog proactive without inventing overhead.

---

## Security & patching

Proactive security and patching deferrals — bumps held for a reason, hardening
we've sequenced for later.

- **sharp / esbuild bumps parked (PR #243).** See
  [Dependencies & toolchain](#dependencies--toolchain) below — the sharp 0.35
  hold has a security dimension (we're declining a patch-eligible bump), so the
  quarterly security review should re-check whether a CVE has landed on the
  0.34.x line we're staying on.
  - **Re-checked 2026-08-16 (the auth/entitlement/spend security pass). The
    libvips CVEs still stand — the hold is NOT security-safe.** `pnpm audit`
    reports no advisory against sharp, and that is **not evidence**: `audit`
    surfaces npm-registry advisories, while sharp's exposure is inherited from
    the **libvips binary bundled inside it**, which no npm advisory covers.
    The four CVEs recorded under *Cost of waiting* above (incl.
    [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj),
    High) remain a known, accepted risk while this stays parked. The remaining
    gate is unchanged: a deliberate visual-pipeline upgrade with UAT, targeting
    0.35.1+.
  - **This entry was briefly edited to claim the opposite, which is the second
    occurrence of a pattern this repo already documents.** The first version of
    this line, in 2026-07, asserted "no known CVE" from assumption; the
    2026-08-16 version asserted "negative" from a clean `pnpm audit`. Different
    reasoning, same false conclusion, on the same dependency. See
    [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#security-relevant-dependency-claims-written-from-assumption-not-verification)
    — whose worked example *is* this line. The check that would have caught
    both is the one that pattern already prescribes: read the package's own
    GHSA/changelog, and treat a tool's silence as silence rather than as a
    negative result. **Nothing here should be re-marked "clear" without a
    libvips-version check.**
  - **Separately, `pnpm audit` on 2026-08-16 reported ~70 advisories overall.**
    Not a statement about sharp; that is the Dependabot backlog, and several
    sit on production-path packages (`express` → `body-parser`,
    `path-to-regexp`) rather than dev tooling. Triaging it is tracked below.

- **Nothing alerts if the `rate_limit_counters` purge silently stops running.**
  - **What.** `jobs/rateLimitCounterPurger.ts` reports through structured log
    lines only (matching `transientRenderPurger`, the job it was modelled on).
    If its scheduler never arms or every run starts failing, the table quietly
    resumes growing — and resumes retaining live session tokens — with no
    surface that says so.
  - **Why deferred now.** The purge itself is the fix that mattered and it
    ships in PR #369; a health surface is a second, larger change (an
    authenticated admin panel field plus the UI to show it, per the
    ship-the-surface rule), not a line of it. The grace sweep's
    `graceSweepHealth` is the model to copy when it's built.
  - **Cost of waiting.** A silent regression of exactly the bug just fixed
    would go unnoticed until someone looked at the table again — which is how
    the original gap survived as long as it did. Bounded by the fact that the
    job logs its counts on every run that deletes anything, so the signal
    exists in logs even though nothing watches it.
  - **Revisit trigger.** Next time the admin health panel is touched for
    another reason, or the first time this job is suspected of not running.

- **The autoscale connection budget is unenforced and slightly wrong (found on PR #299's review, deferred by PR #308).**
  - **What.** `.replit` selects `deploymentTarget = "autoscale"` with no
    maximum instance count, so `lib/db/src/index.ts:45-67`'s "safe up to 19
    instances" comment cannot actually fail if violated. It also omits the
    `StripeSync` pool's `max: 2` from the per-instance total, making the real
    per-instance total 22 (not 19) and the honest ceiling
    `floor(398 / 22) = 18`, not the assumed 19.
  - **Why deferred now.** Pre-existing on `main`; same provenance as the
    `adminConfig`/`getStripeSync` entries in
    [Code-level tech debt](#code-level-tech-debt) below — all five surfaced on
    the same 16-round review of the plan that became PR #308 (the fifth, the
    `rate_limit_counters` retention gap, was fixed in PR #369 and is off this
    list). Prioritized
    **first** among these five by David's 2026-08-04 ordering decision — with
    most of this API's route files having had no other rate limiting before
    PR #308's global backstop, an unbounded per-instance ceiling multiplied by
    an unbounded instance count is the one item that determines whether that
    backstop means anything fleet-wide.
  - **Cost of waiting.** The global rate-limiter's advertised per-IP ceiling
    (12,000/min) is a **per-instance** number with no fleet-wide bound — see
    the 2026-08-04 `decisions.md` entry's "accepted trade-off" note. The DB
    connection budget is also silently thinner than the code comment claims.
  - **Revisit trigger.** Either a deployment-level instance cap is configured,
    or a boot-validated instance-count input is added to derive `DB_POOL_MAX`
    correctly (including the `StripeSync` pool's connections). Should land
    before scaling autoscale usage materially.

- **`IP_HASH_SALT` production fallback — SHIPPED, off this list.** Deferred
  twice (found on PR #299's review, deferred by PR #308; trigger fired again on
  the 2026-08-16 security pass) and closed by **PR #484**:
  `assertIpSaltConfigured()` runs at boot from `index.ts` and refuses to start
  a production process whose `IP_HASH_SALT` is missing or under 16 characters.
  Recorded here rather than deleted because two other entries cite this one's
  provenance, and because the *shape* of the fix is the reusable part: the WARN
  could never have been upgraded to a runtime throw, since
  `logTransientRender` swallows its own errors by design — boot was the only
  loud moment available. Non-production keeps the dev fallback.

- **~~`recordCost` swallows a ledger-write failure~~ — SHIPPED, PR #498 (`6b3364d`).**
  A lost write is now *accepted and measured*: `noteLedgerWriteFailure` records a
  counter plus timestamp in `admin_config`. Not recovered — that was settled
  decision #4, and reconciliation remains unbuilt. Original entry kept below for
  the reasoning.

  - **What.** `budgetGate.recordCost` catches and logs at WARN, deliberately —
    it runs *after* a successful fal call, so throwing would fail a generation
    the user has already been charged compute for. The consequence is that a
    persistent ledger-write failure means spend accumulates while recorded
    spend does not, and the per-user ceiling silently stops binding. That is
    the same fail-open family as the gate skip PR #474 closed, on the
    accounting side rather than the enforcement side.
  - **Why deferred now.** It overlaps the approved `is_estimated` ledger work
    (below) — both change when and what `recordCost` writes — so doing them
    separately would touch the same function twice with the second change
    partly reverting the first's assumptions.
  - **Cost of waiting.** Higher than "sustained failure" framing suggests, and
    an earlier version of this entry understated it. **One** swallowed insert
    permanently understates the ledger — there is no retry and no backfill — so
    a single lost write is enough for a later request to pass
    `currentSpend + proposedCost <= limit` while real cumulative spend has
    crossed the ceiling. A sustained failure widens the gap; it is not a
    precondition for the fail-open. Nothing alerts on either case.
  - **Revisit trigger.** Fold into the `is_estimated` migration PR.

- **~~The cost ledger records no provenance, and an unpriced synchronous generation is not recorded at all~~ — SHIPPED, PRs #497 + #498 (`6b3364d`).**
  Both writers record on every branch, and every row written from Release B
  onward carries `is_estimated`. **Residual, still open:** rows written *before*
  Release B remain `NULL` until Release C's classification backfill, and
  `recordStage2Cost` has an uncounted failure path (see the note under the
  2026-08-18 skip-and-count decision). Original entry kept below.

  - **What.** Two related gaps, and the second is the one that is easy to get
    wrong. **(a)** On **both** synchronous paths — `aiMemePipeline` and
    `POST /videos/generate` — `recordCost` is guarded on a provider-resolved
    price, so a generation gated on a fallback estimate is written nowhere. Both
    routes gate correctly on the fallback and then decline to record it, which
    is the same asymmetry in two places: across a sustained pricing outage their
    recorded spend stops growing and the ceiling PR #474 restored is measured
    against a stale total. **Scope the fix to both writers** — an earlier version
    of this entry said "synchronous image," which would have left unpriced
    synchronous videos permanently unrecorded.
    **(b)** The ledger **mixes two different kinds of figure**, with nothing
    marking which is which. No `user_generation_costs` column flags provenance,
    and the cost columns are all `NOT NULL` — but **`job_reference_id` is
    nullable** (`recordCost` stores `?? null`), which matters below: a row with
    no reference carries no stage suffix to recover provenance from.

    **Note the distinction is NOT measured-vs-estimated.** *No* row records an
    actual provider charge: `getCachedPrice` returns an hourly-refreshed unit
    rate and `costComputation.ts` derives a cost from dimensions, count and
    duration without ever reading a billing result. The real distinction is
    **provider-resolved rate** (fal's published price for that endpoint, applied
    to the request's actual parameters) versus **operator-configured estimate**
    (the engine's `estimatedCostUsdPerCall`, or a hardcoded fallback). Both are
    computed; one tracks the provider, the other tracks our own guess.

    **Which writers produce which is deliberately NOT enumerated here.** This
    entry carried a per-writer table for two review rounds and it was wrong in a
    different way each round — stage gating, row distinguishability, and the
    measured/estimated framing itself all had to be corrected (PR #477, rounds
    1–3). A specification that unreliable is worse than none, because the
    migration would inherit its errors with more confidence than they deserve.
    **Derive it from `videoPipelineRunner.ts`, `aiMemePipeline.ts` and
    `routes/videos.ts` at build time and verify against live data.** What is
    safe to carry forward is only the shape: the async video pipeline writes
    operator-configured figures for its stylise and subtitle stages and for its
    main stage's pricing-failure path, while the synchronous paths and the main
    stage's normal path write provider-resolved ones.
  - **Why deferred now.** Closing it needs a schema column, which is Tier C
    (migration ceremony, its own PR), and it builds on the fallback path PR
    #474 introduced — so it is sequenced after that merge rather than folded
    into it.
  - **Cost of waiting.** The per-request ceiling holds; the cumulative one does
    not, for the duration of a pricing outage on either synchronous path. Cost reporting
    already overstates its own precision on the video path.
  - **Scope warning for whoever builds it.** An `is_estimated` column that
    covers only the new image-path writes would be **worse than none** — it
    would assert a provenance distinction while silently leaving the video
    pipeline's operator-configured rows, and every historical row, flagged as
    if they were provider-resolved. Note the column name itself invites the
    retired framing: `is_estimated = false` must mean *provider-resolved rate*,
    not *measured charge*, since no row is a measured charge.
  - **Historical rows are more recoverable than a first look suggests** — so
    don't default them all to `false` without checking. Two discriminators
    exist in the data and are worth investigating before deciding:
    `job_reference_id` carries a per-stage suffix **where it is present at all**
    (the column is nullable, so some rows have none), and `billing_units`
    differs sharply between the two writers on the video pipeline's main stage
    (a computed token count versus a literal `1`). **Both are leads, not
    conclusions** — confirm the current code still writes them that way,
    establish how many rows carry a null reference, and validate the
    distribution against live data before a backfill relies on either. An earlier version of this entry asserted the opposite (that those
    rows were indistinguishable), which would have discarded recoverable
    provenance permanently.
  - **A missing row is not automatically normal, and not automatically a gap.**
    Some stages legitimately don't run — the stylise stage only on the
    stylize-then-video path, the subtitle stage only after the main stage
    succeeds — so their rows are correctly absent for many healthy jobs. But
    `recordCost` swallows an insert failure (the entry above), so an
    expected row can also be missing from a perfectly healthy job. **Normality
    has to be judged from `sourceMode` and the stage/job outcome, not from row
    count**, and an expected-but-missing row is a write gap — precisely the
    accounting failure the `recordCost` item exists to track. A reconciliation
    check that treats absence as benign would ignore it.
  - **Revisit trigger.** **Approved by David 2026-08-16** — not a parked
    condition, queued work. See the decision entry in
    [`decisions.md`](../ai-context/decisions.md), which also records the open
    product question it carries (whether the two spend-display surfaces
    should include, label, or exclude estimated rows).

**Security follow-ups from the C5/C9 review.** Lower-risk hardening the
security review consciously deferred. Full context lives in
[`security-model.md`](../ai-context/security-model.md#deliberately-out-of-scope--deferred);
re-gather it when the work is scheduled.

- **CSP: Report-Only → enforcing.**
  - **Why deferred.** Flipping to enforcing before UAT confirms zero violations
    risks breaking real page loads.
  - **Cost of waiting.** CSP is observe-only until flipped — it reports but
    doesn't block.
  - **Revisit trigger.** UAT confirms zero CSP violations in Report-Only.

- **HSTS `includeSubDomains` / `preload`.**
  - **Why deferred.** Asserting these before every `*.overhype.me` subdomain is
    HTTPS-only would strand any non-HTTPS subdomain.
  - **Cost of waiting.** Slightly weaker transport guarantee at the subdomain
    edge.
  - **Revisit trigger.** All `*.overhype.me` subdomains are HTTPS.

- **`ADMIN_API_KEY` scoping + `confirm`/`limit` gates on the API-key backfill launchers.**
  - **Why deferred.** The backfill-launcher gates depend on the `ADMIN_API_KEY`
    scoping decision, which isn't made yet.
  - **Cost of waiting.** Backfill launchers lack a belt-and-suspenders
    confirm/limit guard (they are admin-gated already).
  - **Revisit trigger.** The `ADMIN_API_KEY` scoping decision is made — then
    wire the gates.

- **Admin field-length validation tidying.**
  - **Why deferred.** Cleanup, not a live risk; validation exists, this is
    tightening bounds.
  - **Cost of waiting.** Minimal.
  - **Revisit trigger.** Next time we touch admin input validation, or a
    quarterly security pass judges it due.

- **Git-history purge of the removed prod dump.**
  - **Why deferred / won't-do-leaning.** Destructive history rewrite; **secret
    rotation is the real mitigation** and is the primary control. The purge is
    cosmetic cleanup on top of that.
  - **Cost of waiting.** None once rotation is confirmed — the dump's secrets
    are dead.
  - **Revisit trigger.** Only if rotation is ever found incomplete; otherwise
    leave as won't-do.

## Dependencies & toolchain

- **sharp 0.34.5 → 0.35.0 (and esbuild 0.27.3 → 0.28.1) — parked from PR #243.**
  - **What.** A Dependabot `npm_and_yarn` group bump raising sharp to 0.35.0
    and esbuild to 0.28.1.
  - **Why deferred now.** sharp 0.35 is a 0.x "minor" but effectively a
    **major** (its release notes list ~8 `Breaking:` items). It breaks `tsc`
    with `TS7016` across all our sharp consumers — sharp repackaged its
    `exports` map and its `.d.ts` no longer resolves under our
    `moduleResolution: "bundler"`. It also raises the Node floor to
    **≥ 20.9.0**. sharp is core to the **visual pipeline** (high-risk per the
    tier table), so it deserves a deliberate upgrade with UAT, not a drive-by
    group bump. Our code does **not** call any of the removed sharp APIs
    (`failOnError`, `format.jp2k`, `paletteBitDepth`), so the break is
    packaging/typings, not API usage.
  - **Cost of waiting.** Real, not zero — sharp 0.34.5 **does** carry a known
    CVE: it inherits vulnerabilities from its bundled libvips (four CVEs incl.
    [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj),
    High), fixed by the libvips 8.18.3 bump that ships with sharp ≥0.35.0.
    sharp is a **direct** dependency (`artifacts/api-server/package.json`),
    confirmed via a Dependabot alert triage on 2026-07-24 (see
    [`decisions.md`](../ai-context/decisions.md#2026-07-24--dependabot-alert-triage-found-the-safe-patch-bumps-parked-in-pr-243-were-actually-9-disclosed-cves-including-a-sql-injection-in-the-production-orm)
    and [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md#security-relevant-dependency-claims-written-from-assumption-not-verification)
    — this line originally, and wrongly, claimed "no known CVE"). Grows if a
    further advisory lands on the 0.34.x line, or if we need a 0.35-only
    feature.
  - **Update (2026-07-24).** The typings-resolution bug is already fixed —
    sharp v0.35.1 (2026-06-11) shipped "Ensure type definitions are published
    for both ESM and CJS" ([#4537](https://github.com/lovell/sharp/issues/4537),
    per the [v0.35.1 changelog](https://sharp.pixelplumbing.com/changelog/v0.35.1/)).
    That leg of the original trigger has fired — noted here so it isn't
    re-discovered as a fresh trigger — but it isn't sufficient on its own: the
    breaking-change surface and the Node ≥ 20.9.0 floor are still real, so this
    stays parked pending a deliberate visual-pipeline upgrade. If/when we pick
    this up, target **0.35.1+**, not raw 0.35.0.
  - **Revisit trigger.** ~~A security advisory hits 0.34.x~~ — **already
    fired** (see Cost of waiting above: the libvips-inherited CVEs are a
    known, accepted risk while this stays parked, not an open trigger
    anymore). The only remaining gate: we schedule a visual-pipeline
    dependency upgrade with UAT (Opus-tier).
  - **Update (2026-07-24, continued).** The other three bumps bundled in #243
    (drizzle-orm 0.45.2, vite 7.3.6, postcss 8.5.12) turned out **not** to be
    generic hygiene — a Dependabot triage of the repo's open alerts found they
    fix four disclosed High-severity CVEs, including a **SQL injection in
    drizzle-orm** (our direct production ORM). Split out into **PR #246**
    rather than waiting on sharp or the next Dependabot cycle.
    **Status: PR #246 merged (squash commit `27277ff`).** drizzle-orm/vite/
    postcss/fast-uri are fully resolved on `main`. **esbuild is only
    *partially* resolved** — #246 patched `artifacts/api-server`'s own
    **direct** esbuild devDependency (0.28.1, closing the alert anchored to
    that manifest), but `esbuild@0.27.3` (the CVE-affected version) is still
    resolved on `main` for three transitive consumers: `tsx`, `@orval/core`,
    and `wrangler` (confirmed via `pnpm-lock.yaml`). The underlying CVE
    ([GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr))
    is specifically about esbuild's **dev-server** feature — `tsx`/`@orval/core`
    don't invoke it (pure transpile/codegen use), `wrangler dev` plausibly
    could, so that's the one instance worth more scrutiny, not just noting.
    None of these three has its own package.json declaring esbuild directly
    in this repo (all pull it in as *their own* transitive dependency), so
    there's no direct-specifier fix available the way there was for
    api-server — bumping would mean waiting on `tsx`/`@orval/core`/`wrangler`
    to bump their own esbuild pin, or a workspace override (same mechanism as
    the `fast-uri` fix in #246 — see
    [`pnpm-override-scope-and-application.md`](../../.agents/memory/pnpm-override-scope-and-application.md)
    for the gotchas that surfaces). See #246 for the full CVE list and
    verification of what **is** resolved.
  - **Revisit trigger (esbuild specifically).** `tsx`, `@orval/core`, or
    `wrangler` ship a release pinning esbuild ≥0.28.1, **or** we force it via
    a workspace override and verify no breakage — whichever comes first.

- **~40 lower-severity Dependabot alerts — not yet individually triaged. OPEN QUESTION, not closed.**
  - **What.** Of the repo's 54 open Dependabot alerts as of 2026-07-24, 9 CVEs
    across 5 packages were triaged and fixed (PR #246, see above). The
    remaining ~40 (mostly Moderate/Low) are still untriaged individually —
    lodash, ws, undici, picomatch, brace-expansion, path-to-regexp, js-yaml,
    linkify-it, qs, uuid, markdown-it, and others, mostly transitive
    ReDoS/DoS-class findings in build tooling rather than a production
    request path.
  - **Why deferred now.** The 9 confirmed, high-value CVEs (incl. a SQL
    injection in the production ORM) were prioritized first. Real severity of
    the remaining ~40 is unqualified — none has been individually checked
    against our actual exposure the way the 9 were.
  - **Cost of waiting.** Unknown until triaged — that's the open question, not
    a settled "low" like the other entries here.
  - **Revisit trigger.** Not a one-time fired condition — this is a **standing
    open question for David**: whether to triage individually (thorough, slow)
    or accept them as one grouped backlog entry with a sweep-based approach
    (`pnpm update` + re-check, opportunistic). Surface as an open decision item
    every `/maintenance` pass until David decides; once decided, replace this
    entry with the actual outcome (either N individually-triaged entries, or
    one grouped entry with its own trigger).

- **recharts v2 → v3.**
  - **What.** recharts is pinned at `^2.15.x` in `artifacts/overhype-me` and
    `artifacts/mockup-sandbox`. recharts 1.x/2.x are end-of-life ("no longer
    active — bump to v3," per the v3 migration guide flagged in the lockfile).
  - **Why deferred now.** v3 is a major with a migration guide; charts work
    today; not worth a migration mid-flight.
  - **Cost of waiting.** No further bugfixes or security patches on the v2 line.
  - **Revisit trigger.** Next time we do meaningful charts work, or a security
    advisory on recharts v2, or the weekly maintenance sweep judges it overdue.

## Code-level tech debt

- **Async-queue enqueue-side status write isn't transactional with `enqueueJob` (PR #256).**
  - **What.** `factPexelsJobs.ts`'s `enqueueFactPexels` and
    `aiMemeBackfillJobs.ts`'s `enqueueFactAiMemeBackfill` each write the
    fact's status field to `"pending"` (or a handler writes a terminal value)
    as a separate statement from the `enqueueJob` insert/dedupe call — the two
    aren't composed inside one transaction. Two related races follow: (1) a
    late enqueue landing between a handler's terminal-marker write and its
    `async_jobs` row's finalization can reset the marker back to `"pending"`
    and then dedupe onto the still-`processing` row, which never repairs it;
    (2) `factPexelsJobs.ts`'s 1s post-success pacing sleep widens that same
    window further. In both cases the underlying `pexelsImages`/`aiMemeImages`
    data is unaffected — only the status marker can go stale.
  - **Why deferred now.** Closing this needs `enqueueJob`'s dedupe-conflict
    recovery to compose inside a caller-managed transaction, which it doesn't
    support today — a real fix is a small piece of `asyncJobs.ts` transaction
    hardening, not a one-line change in either queue file.
  - **Cost of waiting.** A rare concurrent-enqueue race can leave a fact's
    Pexels/AI-meme status display stuck at "pending" after the underlying job
    actually completed. No data loss; a moderator/admin can force a re-enqueue
    to clear it.
  - **Revisit trigger.** Next time `asyncJobs.ts`'s enqueue/dedupe machinery is
    touched for another reason, or this race is observed in production status
    data (not just theoretically), fold in transactional composition then.

- **Async-jobs reclaim finalize has no fencing token (PR #283).**
  - **What.** `processClaimedJob` finalizes a job by row id alone. Stuck-row
    recovery (`RECOVER_STUCK_CUTOFF_MIN`) reclaims a row once it's been
    `processing` past the cutoff, but nothing stops the *original* holder from
    still being alive and finishing after the reclaim — both runs execute and
    whichever finalizes last silently overwrites the other. PR #283 raised the
    cutoff (10 → 30 min) as an interim mitigation that narrows the race window;
    it does not close it.
  - **Why deferred now.** The real fix — lease tokens stamped at claim time and
    checked at finalize, so a stale run's finalize is a no-op instead of an
    overwrite — is Phase 3a of the async-queue hardening plan (surfaced during
    the review on PR #282) and is sequenced after the Phase 1 health-surface
    work that makes this race observable in production.
  - **Cost of waiting.** A genuinely concurrent reclaim (autoscale boot racing
    a slow in-flight handler) still causes silent double-execution — a
    duplicate send on the `email` queue, or a corrupted status marker on
    `fact_ai_meme_backfill` — just less often now that the window is narrower.
  - **Revisit trigger.** When Phase 3a (lease tokens + fenced finalize) lands,
    this entry closes and `RECOVER_STUCK_CUTOFF_MIN` stops being load-bearing.

- **`TODO(PR3-signature)` — `artifacts/api-server/src/lib/sendBackToReview.ts:151`.**
  - **What.** Rows are re-queued with `signature: null` because per-row
    processing signatures aren't stamped at send-back time; the comment defers
    stamping "at classify time once signatures land."
  - **Why deferred now.** Depends on signature work sequenced elsewhere; a null
    signature is handled correctly today.
  - **Cost of waiting.** Low.
  - **Revisit trigger.** When classify-time signature stamping lands — wire this
    in the same pass.

- **Stripe↔local membership reconciliation — the repair path for an event that
  never arrives (PR #287).**
  - **What.** Every Stripe event we *receive* is authoritative, fenced and
    idempotent, and duplicates and out-of-order deliveries are handled. What is
    missing is the job that discovers a discrepancy nothing told us about — a
    webhook Stripe never successfully delivers across its whole retry window.
    That user's entitlement stays whatever it was until the next event for the
    same subscription or payment happens to arrive.
  - **Why it bites in one direction only.** Access wrongly *lost* is repairable
    by hand — an admin grant restores it. Access wrongly *kept* is not: admin
    grant/revoke act on admin grants, so nothing on the admin surface can mark a
    stale Stripe subscription cancelled, or a purchase refunded or
    dispute-lost. That direction is the one that costs money.
  - **Why deferred now.** It was built and then pulled from PR #287 to narrow
    the PR (David, 2026-07-30). The machinery it needs — run lease with
    heartbeat, staged apply that re-verifies at apply time, the bounded
    downgrade guard, and a durable run record at both altitudes — is
    substantially more than the grace sweep that stayed, and it accounted for a
    large share of that PR's review findings.
  - **The known hard part, unsolved.** It cannot enumerate from local rows
    alone. A first purchase whose checkout webhook never landed has *no* local
    row to scan, so a subscription-row-driven sweep examines zero sources and
    never finds the paying customer who was never granted access. Closing that
    means enumerating from Stripe, which has no natural "list everything that
    might be ours" query — a design question, not an implementation one.
  - **Cost of waiting.** Real but bounded: it requires a webhook to fail for its
    entire retry window. Stated as an accepted limitation in
    `PR287_PAYMENTS_ENTITLEMENT_MODEL_UAT.md` and in `membershipSchedules.ts`'s
    header, so it is a known gap rather than a silent one.
  - **Revisit trigger.** The first time a real membership is observed out of
    step with Stripe with no explaining event — or before scaling paid signups
    materially, whichever comes first.
  - **Sequencing.** Unblocked — PR #287 merged 2026-08-03. Available to pick
    up now, subject to the revisit trigger above.

> The other inline marker, `TODO(version-rollback)` in
> `enrichmentVersioning.ts`, is **product** work (an unbuilt feature) and is
> tracked in the roadmap's deferred list, not here.

- **`adminConfig.loadAll()` has a cache stampede and a stale-fill race (found on PR #299's review, deferred by PR #308).**
  - **What.** `adminConfig.ts:32-39` checks `_cache`, awaits the query, then
    assigns, with no in-flight promise today — concurrent callers on an empty
    or just-expired cache each issue their own query (the stampede). Worse,
    `bustConfigCache()` can clear the cache while an older read is in flight;
    that read then repopulates it with pre-write rows for another ~60 seconds,
    which affects the immediate `stripe_live_mode` cache-bust/invalidate path
    at `routes/admin.ts:2881-2897`. **Forward-looking guardrail, not a current
    symptom:** today's code has no stored in-flight promise at all, so there's
    nothing to leak on a failed query — but any single-flight fix for the
    stampede must not introduce an unlogged failure mode of its own: a stored
    promise that rejects during a transient DB failure must be cleared, not
    cached, or every later config reader would await that same rejection until
    restart — every getter falling back to its default, including
    `isLiveMode()` silently selecting **test mode** on a live deployment.
  - **Why deferred now.** Pre-existing on `main`, not caused by PR #308's
    rate-limiter work — surfaced as a side finding during the 16-round review
    of the plan that became #308, deliberately kept rather than lost with the
    code it was found in, and queued for its own `/bugfix` PR per David's
    2026-08-04 decision.
  - **Cost of waiting.** Redundant concurrent config queries under load today.
    No rejection-poisoning risk exists yet (there's no single-flight to poison)
    — that's a pitfall to avoid *when* single-flight is added, not a present
    defect.
  - **Revisit trigger.** Next `/bugfix` pass through this area, or if
    stampede-driven query load is actually observed. Fix needs a single-flight
    with a **generation counter** (so only the current generation may publish)
    and rejection cleanup built in from the start (a rejected in-flight
    promise must be cleared, not cached) — not added later as a patch.

- **`getStripeSync()` is not mode-scoped or rejection-safe (found on PR #299's review, deferred by PR #308).**
  - **What.** `stripeClient.ts:120-126` (`getStripeSync()` itself; the cached
    module-level vars and `buildStripeSync()` start at `:103-107`), three
    current defects plus one forward-looking guardrail: (1) no single-flight,
    so concurrent misses each run `buildStripeSync()`, creating extra
    `StripeSync` instances **and** extra `pg.Pool`s; (2) a `stripe_live_mode`
    flip mid-flight lets an old-mode build publish *after*
    `invalidateStripeSync()` — the flight must be generation- **and**
    mode-scoped, discarding a completion whose generation is no longer
    current; (3) `buildStripeSync()` re-reads the mode independently for the
    secret key and the webhook secret rather than using the mode captured at
    entry, so a flip landing between those reads can yield a live key paired
    with a test webhook secret or the reverse. **Forward-looking guardrail:**
    today's code has no stored in-flight promise either — `stripeSync = await
    buildStripeSync()` simply throws to the caller on failure, leaving the
    prior cached value in place — but any single-flight fix must clear a
    rejected promise rather than cache it, or every later webhook would fail
    until restart. A superseded or invalidated `StripeSync` also **leaks its
    underlying `pg.Pool`** — the installed `stripe-replit-sync@1.0.0`'s
    constructor creates a `PostgresClient`, whose constructor creates a
    `pg.Pool` — so repeated mode flips leak connections steadily; "discard" is
    the wrong verb throughout, the fix must *dispose*
    (`postgresClient.pool.end()`).
  - **Why deferred now.** Pre-existing on `main`; same review/deferral
    provenance as the `adminConfig` entry above.
  - **Cost of waiting.** Extra Postgres connections and pool churn on every
    concurrent Stripe-sync miss or live/test mode flip, worsening the
    [autoscale connection-budget problem](#security--patching) (now filed
    under Security & patching, above this section). No known production
    incident yet; the mixed-mode-credentials case (3) is the most severe if
    it fires — a live secret key paired with a test webhook secret.
  - **Revisit trigger.** Next `/bugfix` pass through Stripe sync, or the
    [autoscale connection-budget entry](#security--patching) being fixed
    first (its arithmetic assumes this leak doesn't exist). Acceptance needs
    three cases proven together: a
    delayed mid-flight mode flip, a construction failure followed by a
    successful retry, and repeated flips returning the live pool count to one.

- **No CI guard against dangling `docs/plans/*` citations from code (found on PR #319's `/document` harvest review).**
  - **What.** [`plan-doc-path-never-cite-from-code.md`](../../.agents/memory/plan-doc-path-never-cite-from-code.md)
    documents the rule — plan-review branches are never merged, so a code
    comment or docstring citing a `docs/plans/*` path is dangling from
    the moment it's written — and records **two** confirmed occurrences (PR
    #256, PR #308) despite the rule already existing after the first one.
    `scripts/check-docs-accuracy.mjs` only link/path-checks the shared docs
    set (`docs/ai-context/`, the manual, etc.); it does not scan implementation
    code comments or `.agents/memory/` for this specific pattern, so a third
    occurrence can still merge green.
  - **Why deferred now.** This repo's own rule is that a recurring failure
    pattern becomes a deterministic CI guard, not a reviewer-memory ask — this
    item is the queued acknowledgment of that rule firing, not a decision to
    skip it. Not implemented in the PR that raised it (#319) because that PR
    is a docs-only `/document` harvest; adding a new guard script + build.yml
    wiring is a code change outside that ceremony's boundary (see
    `docs/ai-context/documentation-workflow.md`'s "Docs-only" boundary).
  - **Cost of waiting.** A third dangling-citation instance stays possible
    and undetected by CI until this ships — the exact gap that let occurrence
    #2 slip through despite the rule already being documented from #1.
  - **Scope note (Codex review, PR #319, second pass).** The guard must NOT
    scan `docs/*_TEST_RUN.md`/similar historical docs — a repo-wide search
    already finds legitimate historical citations in the durable checklist
    handoff and UAT records. A guard scoped only to implementation
    code comments (`artifacts/*/src/` **and** `lib/*/src/` — this repo ships
    real implementation source under both roots, e.g. `lib/db/src` and
    `lib/api-zod/src`, either of which could carry the same dangling
    citation and merge green under an `artifacts/`-only guard) and
    `.agents/memory/` catches the actual failure mode (a docstring pointing
    readers at a plan that won't exist on `main`)
    without breaking on transient docs that are allowed to reference a
    plan-review PR they're paired with. Whitelisting after the fact, rather
    than scoping correctly from the start, would recreate exactly the kind
    of guard-vs-legitimate-content conflict this repo's other content guards
    already had to learn to avoid.
  - **Revisit trigger.** Next dev-infra/tooling pass, or the next time this
    exact mistake recurs a third time. Fix is a small regex/grep-based check
    (relative `docs/plans/*` path references appearing outside that directory
    itself), scoped to implementation code and `.agents/memory/` only, not
    `docs/` generally, added to `check-docs-accuracy.mjs` or a sibling
    script, wired into the Build job like the other content guards.
    **Second scope note (Codex review, PR #319, third pass):** a literal
    regex over `.agents/memory/` would also fail on the canonical
    rule-defining docs themselves —
    [`plan-doc-path-never-cite-from-code.md`](../../.agents/memory/plan-doc-path-never-cite-from-code.md)
    cites `docs/plans/PLAN_*.md`-shaped examples as the teaching content the
    rule is *about*, and
    [`codeql-missing-rate-limiting-csrf-false-positive.md`](../../.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md)
    links a `docs/plans/*` GitHub blob URL (a legitimate historical
    citation, deliberately not a relative path — see that doc's own note on
    why).
    **Retracted (Codex review, PR #319, fourth pass):** an earlier revision
    of this note proposed "only flag a *relative* path, not a full URL" as a
    cleaner alternative to an explicit file exemption — that does NOT work.
    `plan-doc-path-never-cite-from-code.md`'s own teaching examples
    (`docs/plans/PLAN_ASYNC_QUEUE_HARDENING*.md`,
    `docs/plans/PLAN_CODEQL_RATE_LIMITER*.md`, both verified as literal text
    in that file) are themselves bare relative paths used as historical
    prose, not URLs and not asterisk-glob placeholders — a relative-path-only
    regex would still flag them. The guard genuinely needs an **explicit
    file-level exemption** for `plan-doc-path-never-cite-from-code.md`
    specifically (its whole purpose is to name the dangling-path pattern in
    prose); the relative-vs-URL distinction only correctly resolves the
    *other* memory doc's citation, not this one. **The exemption list also
    needs `MEMORY.md`** (Codex review, PR #319, fifth pass): its own one-line
    index summary of the "never cite a `docs/plans/*` path from code" lesson
    (`MEMORY.md:23`) repeats the same bare `docs/plans/PLAN_*.md` teaching
    text, a third file the guard would need to know about before it can ship.

- **No CI guard against a migration's raw-SQL DDL missing its `schema.ts`
  shadow (found on PR #425's `/document` harvest review).**
  - **What.** [`raw-sql-migration-needs-schema-shadow.md`](../../.agents/memory/raw-sql-migration-needs-schema-shadow.md)
    documents the pattern — a migration's hand-written `CREATE INDEX`,
    `ADD CONSTRAINT`, or `CREATE SEQUENCE` with no matching `schema.ts`
    declaration is invisible to `drizzle-kit push`, which silently drops it
    on any push against an already-migrated database — and now records
    **three** confirmed occurrences across three different PRs (#242, #293,
    #425), the last of which reproduced the drop directly (two `push-force`
    runs). `pnpm --filter @workspace/db run validate-snapshots` does not
    catch either shape — not because migrations are exempt (every
    snapshotless journal entry needs its own named, reasoned exemption in
    `check-migration-snapshots.ts`, and `0099_admin_permissions_core` has
    one), but because the validator's comparison only covers tables,
    columns, and enums; it has no logic for indexes, constraints, or
    sequences at all.
  - **Why deferred now.** Same reasoning as the sibling entry below for
    dangling `docs/plans/*` citations — this repo's own rule is that a
    recurring failure pattern becomes a deterministic CI guard, not a
    reviewer-memory ask, and three strikes across three separate PRs is
    well past the point a fresh agent should be expected to catch this by
    reading the memory doc each time. Not implemented in the PR that raised
    it a third time (#425's `/document` harvest) because that pass is
    docs-only; writing and wiring a new guard script is a code change
    outside that ceremony's boundary.
  - **Cost of waiting.** A fourth instance stays possible and undetected by
    CI — each prior occurrence was caught by a human/Codex reviewer noticing
    a specific missing declaration, not by anything mechanical, so the next
    one is exactly as likely to slip through as the first three did.
  - **Shape of the fix, not yet built.** A naive version — flag every
    historical `CREATE INDEX`/`ADD CONSTRAINT`/`CREATE SEQUENCE` with no
    matching `schema.ts` declaration — breaks on real history: migration
    `0022` creates `email_outbox_pending_idx`, migrations `0037`/`0038`
    create `email_outbox_status_created_idx`, and `0063` deliberately
    `DROP`s both when generalizing the async-jobs table — neither should
    have a current shadow, and a guard comparing raw per-migration CREATEs
    against schema.ts would reject that legitimate retirement on day one.
    The guard has to walk the full migration sequence and compute each raw
    object's **terminal** state (does a later migration's `DROP
    INDEX`/`DROP CONSTRAINT`/`DROP SEQUENCE` remove it before the check
    ever runs) — and that removal isn't always an explicit DROP naming the
    object itself: `0023` adds a foreign-key constraint on
    `lifetime_entitlements`, and `0096` drops the whole
    `lifetime_entitlements` table with no separate `DROP CONSTRAINT` —
    every constraint and index scoped to a dropped table goes with it
    implicitly, so the terminal-state pass needs to fold in
    `DROP TABLE`/dropped-column removals before checking what's left, not
    just the object-specific DROP statements. Only an object that's still
    raw-SQL-created, on a table that still exists, and never explicitly or
    implicitly dropped needs a `schema.ts` shadow. **Terminal-state
    tracking alone still isn't enough**: several objects already exist on
    `main` today, live and un-dropped, that are deliberately never
    shadowed. A guard with no way to exempt a known, reasoned case would
    fail Build against the tree as it stands today, before it ever caught
    a new drift. It needs its own named `ALLOWLIST`, the identical shape
    `check-permission-chokepoint.mjs` already uses — each entry names the
    object, the migration, and why it's permanently unshadowed.

    A terminal-state pass over the full migration history (every
    `CREATE INDEX`/`ADD CONSTRAINT`/`CREATE SEQUENCE` **and every inline
    `CHECK`/`UNIQUE`/`REFERENCES` clause inside a `CREATE TABLE` or
    `ADD COLUMN` — Postgres auto-names those, and Drizzle reconciles the
    resulting objects exactly as it does explicitly-named ones, so an
    extractor that only scans `ADD CONSTRAINT` statements misses them**,
    reduced by every `DROP INDEX`/`DROP CONSTRAINT`/`DROP TABLE`,
    cross-checked against every `index()`/`uniqueIndex()`/`check()`/
    `pgSequence()`/`.references()` declaration in `lib/db/src/schema/*.ts`)
    was run for this entry. **The guard's implementer re-derives this
    inventory mechanically rather than trusting the enumeration below** —
    this entry's own review found the list incomplete twice, which is the
    strongest available evidence that a hand-maintained enumeration of it
    rots; the durable content here is the *method* and the two-way split,
    with the current results as the starting checklist.

    As of this writing the pass finds **seven** objects with an explicit,
    comment-documented reason to stay permanently unshadowed — genuine
    `ALLOWLIST` seeds:
    - **Six partial indexes**, all exempt for the same reason (the pinned
      `drizzle-kit`'s partial-index handling is brittle, per the comments
      in `facts.ts:159-160` and `imagePromptAttempts.ts:130-135`):
      `IDX_facts_eval_golden`, `IDX_ipa_eval_run_fact_created`,
      `IDX_ipa_eval_fact_run_created` (`0081`), `IDX_ipa_request_id`,
      `IDX_ipa_render_job_id` (`0065`), and `IDX_ipa_review_only`
      (`0076`).
    - **One genuinely self-referential foreign key** (`0048`):
      `uim_source_object_path_fk` (`upload_image_metadata.source_object_
      path` → its own `object_path`) — `uploadImageMetadataTable`'s
      trailing comment records that Drizzle's TS-side self-FK helper is
      brittle and isn't required for runtime queries.

    **And ten objects that are live schema-shadow gaps — real,
    reproducible exposure under this note's confirmed mechanism, each
    fixable with an ordinary declaration, so none belongs on a permanent
    allowlist.** (The two `0095` sequences, `membership_source_state_seq`
    and `membership_lease_fence_seq`, were the eleventh and twelfth — the
    PR #293 incident is precisely `push --force` dropping them — but PR
    #427 closed exactly that gap while this list was being reviewed:
    migration `0100_membership_sequence_repair` recreates them and
    `membershipEntitlements.ts` now carries matching `pgSequence()`
    declarations, which is the model fix for everything below.)
    - `uim_fact_id_fk` (`0048`) — an ordinary cross-table FK
      (`upload_image_metadata.fact_id` → `facts.id`), expressible with
      the same `.references(() => factsTable.id)` used throughout
      `memes.ts`. The self-FK brittleness reason in the adjacent comment
      covers `uim_source_object_path_fk` only; this one rode along.
    - `memes_status_check`, `quarantined_memes_source_check`,
      `ncmec_reports_match_source_check` (`0043`) — the only DB-level
      validation for `memes.status`, `quarantined_memes.source`, and
      `ncmec_reports.match_source` respectively. (Distinct columns and
      vocabularies from `0097`'s newer `submission_status`/
      `content_origin` checks, which are shadowed — these three are not
      superseded by them.)
    - `idx_memes_created_by_id_created_at` (`0051`),
      `facts_has_overrides_idx` (`0071`) — both partial indexes, so a
      cleanup pass may legitimately conclude they join the reasoned
      brittle-partial-index exemptions above instead; that's a
      case-by-case call for whoever fixes them, made with a comment
      either way.
    - `affiliate_clicks_source_idx` (`0034`), `UQ_uim_user_is_profile`
      (`0055`, also partial — same call as above).
    - The two **inline, auto-named CHECKs**: `share_intents.platform`
      (`0052:22`) and `hero_examples.artifact_type` (`0054:16`) —
      `shareIntents.ts`/`heroExamples.ts` mention them in comments but
      declare no `check()` builder, so a push-built database silently
      loses both vocabularies' enforcement.

    (`stripe_checkout_request_ledger_request_key_unique` from `0045`
    looks like a gap at first grep, but that migration renames a
    Postgres-auto-named constraint to Drizzle's exact
    `table_column_unique` convention — `.unique()` on `memberships.ts`'s
    `requestKey` generates that identical name, so it *is* shadowed.)

    The ten gaps predate this entry; fixing them (declare the missing
    shadow, or add a reasoned comment that promotes one to the allowlist)
    is separate work from writing the guard, and has to land **before**
    the guard can go green — or the implementer explicitly seeds them as
    "known gap, not yet fixed" entries so the guard's first Build run
    doesn't fail on objects it didn't cause. Either way the initial
    `ALLOWLIST` accounts for every object the re-derived inventory
    returns, split honestly between reasoned-permanent and
    known-gap-pending.

    Wire the guard into `build.yml`'s `Build` job, where
    `validate-snapshots` and both `check-permission-chokepoint*.mjs`
    guards already run — the same general shape as the chokepoint guards'
    file-scan-plus-allowlist approach but requiring cross-migration state,
    not a single-file scan.
  - **Revisit trigger.** Next dev-infra/migrations tooling pass, or the next
    time this exact mistake recurs a fourth time.

- **`app.ts`'s `ORIGIN_EXEMPT_PATHS` can desync from `isDevAdminLoginEnabled()` in a shared process (found on PR #319's `/document` harvest review).**
  - **What.** `app.ts:23-43`: `ORIGIN_EXEMPT_PATHS` is a module-level `Set`,
    conditionally gaining `/api/auth/dev-admin-login` only inside an
    `if (isDevAdminLoginEnabled())` block that runs **once at import time**.
    `createApp()` (`:107` onward) separately re-checks
    `isDevAdminLoginEnabled()` **fresh on every call** to decide whether to
    mount the permissive dev-admin CORS middleware — but the origin-check
    middleware it also registers calls `isOriginExempt()`, which reads the
    same frozen-at-import `Set`. In a shared-process caller (a test file, a
    preview helper) that imports `app.ts` before `ENABLE_DEV_ADMIN_LOGIN` is
    set and calls `createApp()` after, the permissive CORS gets mounted
    (fresh check passes) but the exemption never gets added (stale check) —
    a cross-origin dev-admin-login POST gets permissive CORS headers and is
    then rejected by the origin-check middleware anyway.
  - **Why deferred now.** Same species of import-time-env-capture bug as the
    eager-singleton fix PR #308 shipped
    ([`app-ts-eager-singleton-test-isolation.md`](../../.agents/memory/app-ts-eager-singleton-test-isolation.md)),
    but that fix targeted the app-instance singleton specifically and did not
    touch this `Set` — found by a later Codex review round on the `/document`
    harvest documenting that fix, not by PR #308 itself. Not implemented here
    because this is a docs-only harvest PR.
  - **Cost of waiting.** Narrow blast radius: only fires for a caller that
    imports `app.ts` before flipping `ENABLE_DEV_ADMIN_LOGIN`, which is
    already a non-production-only backdoor (fail-closed by design). No known
    production or CI incident.
  - **Revisit trigger.** Next `/bugfix` pass through `app.ts`, or if a
    dev-admin-login-in-tests symptom is actually observed. Fix is either
    moving `ORIGIN_EXEMPT_PATHS`'s conditional entry into `createApp()`
    itself (so it's re-evaluated per call, matching the CORS-mount check), or
    documenting the asymmetry as an intentional exception if there's a reason
    the exemption specifically must stay import-time-frozen.

- **The api-server test suite flaked once on `main` (observed 2026-08-15 `/maintenance`).**
  - **What.** `Build` run 31911725205 on commit `7e37cc8` (PR #451's squash —
    a metrics-record-only change touching `.agents/metrics/loops/443.json`)
    failed at the `Run api-server test suite` step. The two commits that
    followed it on `main` (`fac70e3`, `d8b7573`) ran the same job green with
    no fix in between, and a docs-only diff cannot break that suite, so the
    failure was not caused by the commit under test.
  - **Why deferred now.** One observation is not a pattern. The `/maintenance`
    contract's rule is that a flake **seen twice across maintenance passes**
    graduates to a fix task; chasing a single non-reproducing failure is the
    kind of speculative work the blast-radius rule exists to prevent. This
    entry exists so the second observation is *detectable* — without it, the
    next pass has nothing to compare against and the rule can never fire.
  - **Cost of waiting.** A red `main` that is not a real regression costs a
    diagnosis each time it happens and erodes the signal value of CI. Bounded
    while it stays a single occurrence; grows if it recurs, because a suite
    that fails randomly stops being evidence of anything.
  - **Revisit trigger.** The **next `/maintenance` pass**: if the api-server
    suite has failed on `main` again since 2026-08-15, this graduates to a
    `/bugfix` task and this entry closes. If the window is clean, note it and
    keep this parked one more cycle.

---

## Product deferrals live elsewhere

Deferred features and product-direction bets are **not** in this doc. See
[`current-roadmap.md` → Explicitly deferred work](../ai-context/current-roadmap.md#explicitly-deferred-work).
