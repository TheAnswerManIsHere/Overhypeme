# Deferred Engineering Work

Last maintenance pass: 2026-10-12 — the `/maintenance` run updates this line
every pass (it is the durable window boundary the batched documentation
harvest reads).

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

- **sharp / esbuild bumps parked (PR #243).**
  - **Launch plan placement (David, 2026-10-13): blocking — `sharp` is upgraded in Phase 7 (the image offering), before Seed; Phase 15 confirms it landed. `esbuild` is not blocking.** Checked at `92024f3`, unchanged at `5f51f2b`: the lockfile still pins `sharp@0.34.5` (`libvips >=8.17.3`); the current release is `0.35.5` (`libvips >=8.18.7`), and the 0.35 typings bug was fixed in 0.35.1. `userImageUpload.ts` runs it on user-supplied files, so the CVEs bite from the first Seed upload. Phase 7 re-verifies renders anyway. The older `esbuild` copies arrive only through dev-time tools (`tsx`, `orval`, `wrangler`, `drizzle-kit`, `esbuild-register`), and their flaw is in the dev server, which production never runs. See
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
    `path-to-regexp`) rather than dev tooling. How it is handled (a grouped
    sweep, decided 2026-10-12) is recorded below.

- **Nothing alerts if the `rate_limit_counters` purge silently stops running.**
  - **Launch plan placement (David, 2026-10-12): not blocking — Phase 16's general stopped-job alert; Phase 14's retention policy names the table's IP addresses.** Still true at `92024f3`. The session-token half is weaker than stated below: the `sessions` table already stores the same ids in plain form (`auth.ts:139-141`), so rows left behind add only expired ids. The readable `key_raw` is used only by `purgeRateLimitCountersByPrefix`, which has no caller — dropping it is an optional tidy-up for the next rate-limiter change.
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
  - **Launch plan placement (David, 2026-10-12): blocking, Phase 3, before Soft.** Set a maximum server count (a cost number David approves), derive the pool size from the new production database's real connection limit including the `StripeSync` pool, and refuse to boot when they do not fit. Confirmed at `92024f3`: `.replit` carries no maximum, and the 398 budget was measured against the database Phase 3 replaces. `unable to verify:` whether a cap is set in Replit's deployment settings page.
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
  **Residual placed (David, 2026-10-13):** the failure counter `noteLedgerWriteFailure` writes is watched by nothing; launch Phase 16 adds an alert on it. Entry closed.
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
  `recordStage2Cost` had an uncounted failure path (see the note under the
  2026-08-18 skip-and-count decision; it went with video, as the next note
  says). Original entry kept below.
  **Launch plan review (on my recommendation, David delegated 2026-10-13): won't-do, both halves.** The backfill has nothing to fix in production: Phase 3's fresh database starts with no rows from before Release B. `recordStage2Cost` lived in `videoPipelineRunner.ts`, which Phase 4 deleted with the video pipeline (removal 2, #744; ledger `docs/retired/README.md`).

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
  - **Launch plan placement (David, 2026-10-13): blocking, Phase 15, rescoped.** Checked at `main`: the report-only policy covers the API's responses only, and the web app sends no CSP at all, so "flip to enforcing" would protect almost nothing. Phase 15 gives the web app its own policy with a report endpoint, report-only first and enforced once the reports are clean, and enforces the API's. This entry closes when Phase 15 does.
  - **Why deferred.** Flipping to enforcing before UAT confirms zero violations
    risks breaking real page loads.
  - **Cost of waiting.** CSP is observe-only until flipped — it reports but
    doesn't block.
  - **Revisit trigger.** UAT confirms zero CSP violations in Report-Only.

- **HSTS `includeSubDomains` / `preload`.**
  - **CLOSED (David, 2026-10-13).** Measured on the live site: Cloudflare already sends `max-age=63072000; includeSubDomains`, and the API adds a weaker duplicate. Phase 15 makes Cloudflare the single source and drops the API's; whether to join the preload list is decided at Phase 20. The one non-HTTPS-ready host, `www.overhype.me` (it returned a 525), now redirects to the apex with path and query kept (verified 2026-10-13).
  - **Why deferred.** Asserting these before every `*.overhype.me` subdomain is
    HTTPS-only would strand any non-HTTPS subdomain.
  - **Cost of waiting.** Slightly weaker transport guarantee at the subdomain
    edge.
  - **Revisit trigger.** All `*.overhype.me` subdomains are HTTPS.

- **`ADMIN_API_KEY` scoping + `confirm`/`limit` gates on the API-key backfill launchers.**
  - **Launch plan placement (David, 2026-10-13): blocking, Phase 15 — scope, not delete.** Checked at `main`: the key unlocks `set-password`, the backfill launchers, Stripe sync, import and job status, and is compared with `!==`. Phase 15: no password set through the key; it reaches only backfills, Stripe sync and import, each with a confirm and a limit; constant-time comparison. Whether production keeps any admin override at all is David's decision at Phase 18 ("in a live environment we need to be hyper sensitive to backdoors of any kind").
  - **Why deferred.** The backfill-launcher gates depend on the `ADMIN_API_KEY`
    scoping decision, which isn't made yet.
  - **Cost of waiting.** Backfill launchers lack a belt-and-suspenders
    confirm/limit guard (they are admin-gated already).
  - **Revisit trigger.** The `ADMIN_API_KEY` scoping decision is made — then
    wire the gates.

- **Admin field-length validation tidying.**
  - **CLOSED into the launch plan (David, 2026-10-13):** Phase 13 validates every admin input with explicit bounds.
  - **Why deferred.** Cleanup, not a live risk; validation exists, this is
    tightening bounds.
  - **Cost of waiting.** Minimal.
  - **Revisit trigger.** Next time we touch admin input validation, or a
    quarterly security pass judges it due.

- **Git-history purge of the removed prod dump.**
  - **WON'T-DO (David, 2026-10-12).** The launch plan's readiness row 5 and Phase 15 now require the exposure closed by rotation instead: sessions revoked by Phase 3's fresh database and that account's password changed. Per #217 the dump held no credentials — three sessions and one account's email and password hash — and a history rewrite cannot unpublish a file public since #165.
  - **Why deferred / won't-do-leaning.** Destructive history rewrite; **secret
    rotation is the real mitigation** and is the primary control. The purge is
    cosmetic cleanup on top of that.
  - **Cost of waiting.** None once rotation is confirmed — the dump's secrets
    are dead.
  - **Revisit trigger.** Only if rotation is ever found incomplete; otherwise
    leave as won't-do.

## Dependencies & toolchain

- **sharp 0.34.5 → 0.35.0 (and esbuild 0.27.3 → 0.28.1) — parked from PR #243.**
  - **No longer parked (David, 2026-10-13): `sharp` is upgraded in launch Phase 7, before Seed, and confirmed in Phase 15; the "accepted risk" below held only until then.** See the placement under *Security & patching*.
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
  - **Update (2026-10-12).** Dependabot is now told to skip sharp minor
    bumps (`@dependabot ignore sharp minor version` on #605, approved by David
    in the 2026-10-12 pass), so its grouped PRs stop bundling the parked
    0.35.x bump with safe patches. When the visual-pipeline upgrade is
    scheduled, lift it with `@dependabot unignore sharp` or bump sharp by
    hand.
  - **Revisit trigger (esbuild specifically).** `tsx`, `@orval/core`, or
    `wrangler` ship a release pinning esbuild ≥0.28.1, **or** we force it via
    a workspace override and verify no breakage — whichever comes first.

- **~40 lower-severity Dependabot alerts — DECIDED 2026-10-12: one grouped sweep, not individual triage.**
  - **Launch plan gate (David, 2026-10-13):** the `/maintenance` sweep stays; Phase 15's bar is `pnpm audit --prod` showing no High or Critical. Measured on `main` 2026-10-13: 0 critical, 3 high (all `sharp`, fixed in Phase 7), 17 moderate, 2 low.
  - **What.** Of the repo's 54 open Dependabot alerts as of 2026-07-24, 9 CVEs
    across 5 packages were triaged and fixed (PR #246, see above). The
    remaining ~40, mostly Moderate/Low, were never triaged individually. They
    include lodash, ws, undici, picomatch, brace-expansion, path-to-regexp,
    js-yaml, linkify-it, qs, uuid and markdown-it. Most are transitive
    ReDoS/DoS-class findings in build tooling rather than on a production
    request path.
  - **Decision.** David chose the grouped sweep (2026-10-12 `/maintenance`,
    "3. Agreed"): one grouped update, then a re-check, rather than triaging
    each alert. The sweep is `pnpm update` within the declared ranges, landed
    as one PR on green CI, followed by `pnpm audit --prod`, with the date and
    the remaining counts recorded here. Green Dependabot PRs alone do not count
    as a sweep: `.github/dependabot.yml` groups version updates only, and most
    of these alerts sit on transitive dependencies that no manifest names.
  - **Why deferred now.** Individual triage of ~40 alerts costs more than
    their exposure, since most are not on a request path. The re-check is what
    catches the ones that are.
  - **Cost of waiting.** Whatever the re-check finds, until the sweep runs.
  - **Baseline, 2026-10-12, before any sweep.** `pnpm audit --prod` reports
    critical 1, high 12, moderate 21, low 2. The Critical is `proxy-addr`
    2.0.7 on the API server's request path (`express` → `proxy-addr`,
    GHSA-jqcg-44mw-7w3h, patched ≥ 2.0.8). Three of the High rows are the
    parked sharp bump above. `pnpm audit` reads the same advisory database as
    the Dependabot alerts page but counts differently, so its numbers are the
    ones this entry tracks.
  - **First sweep, 2026-10-12 (#646).** David asked for it the same day
    because of the Critical ("Option 1"). It was a targeted in-range update of
    the packages with Critical or High production advisories (`proxy-addr`,
    `path-to-regexp`, `ws`, `form-data`, `brace-expansion`, `nanoid`), with sharp
    excluded. Afterwards `pnpm audit --prod` reports critical 0, high 3,
    moderate 17, low 2. All three High rows are the parked sharp 0.34.5 above,
    so they are not this entry's to triage.
  - **Revisit trigger.** At each `/maintenance` pass, run a sweep, then
    `pnpm audit --prod`. A High or Critical row that the sweep did not clear
    gets individual triage. Rows for a package parked elsewhere in this doc are
    excluded; today that is sharp. So does a grouped Dependabot PR that stays
    unmergeable for two passes running. Not met as of the 2026-10-12 sweep.

- **recharts v2 → v3.**
  - **Launch plan placement (on my recommendation, David delegated 2026-10-13): not blocking.** Upgraded with Phase 13's dashboard rebuild, which rewrites the charts anyway, or sooner if a security advisory lands against v2.
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
  - **Launch plan placement (on my recommendation, David delegated 2026-10-13): not blocking.** The Pexels half was deleted with Pexels in Phase 4, removal 6, so one enqueue path remains; the AI-meme half rides Phase 11's async-jobs work if it fits, otherwise it waits to be seen in Seed. Only a status label can go stale.
  - **What.** `aiMemeBackfillJobs.ts`'s `enqueueFactAiMemeBackfill` (and,
    until Phase 4 deleted it, `factPexelsJobs.ts`'s `enqueueFactPexels`) writes the
    fact's status field to `"pending"` (or a handler writes a terminal value)
    as a separate statement from the `enqueueJob` insert/dedupe call — the two
    aren't composed inside one transaction. Two related races follow: (1) a
    late enqueue landing between a handler's terminal-marker write and its
    `async_jobs` row's finalization can reset the marker back to `"pending"`
    and then dedupe onto the still-`processing` row, which never repairs it;
    (2) the deleted Pexels handler's post-success pacing sleep widened that
    same window further. In both cases the underlying `aiMemeImages`
    data is unaffected — only the status marker can go stale.
  - **Why deferred now.** Closing this needs `enqueueJob`'s dedupe-conflict
    recovery to compose inside a caller-managed transaction, which it doesn't
    support today — a real fix is a small piece of `asyncJobs.ts` transaction
    hardening, not a one-line change in either queue file.
  - **Cost of waiting.** A rare concurrent-enqueue race can leave a fact's
    AI-meme status display stuck at "pending" after the underlying job
    actually completed. No data loss; a moderator/admin can force a re-enqueue
    to clear it.
  - **Revisit trigger.** Next time `asyncJobs.ts`'s enqueue/dedupe machinery is
    touched for another reason, or this race is observed in production status
    data (not just theoretically), fold in transactional composition then.

- **Async-jobs reclaim finalize has no fencing token (PR #283).**
  - **Launch plan placement (David, 2026-10-12; fix corrected 2026-10-13): blocking, Phase 11 (spend controls), before Seed.** Still true at `92024f3`: finalize is by row id (`asyncJobs.ts:424-432`), there is no handler time limit, and there is no email idempotency key. A fencing token checked only at finalize is **not** enough. The handler's effect happens before the finalize (`asyncJobs.ts:408` runs `handler.run()`; `email.ts:289` sends inside it), so both holders have already sent or spent by the time either finalizes (Codex, #661). The fix is three parts: the running job renews its claim so a live job is never reclaimed; it checks ownership before the costly step; email sends and generation calls carry an idempotency key. Plus a handler time limit under the reclaim cutoff.
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
  - **RESOLVED — already built (Astra, #661).** Classify time already stamps the signature: `enrichmentJobs.ts` captures `currentProcessingSignatureFromConfig()` before the LLM call and writes it into the candidate, and `enrichmentVersioning.refresh.test.ts` covers a revision changing during classification. The `null` at send-back is correct, since nothing has been classified yet. Only the comment is stale (now `sendBackToReview.ts:137`); it is removed by the next PR that touches that file.
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
  - **Launch plan placement (on my recommendation, David delegated 2026-10-13): blocking, Phase 10.** The plan's reconciliation runbook must repair **both** directions — including access wrongly kept, which no admin tool can revoke today — and find a payer with no local record by reading Stripe over a time window. It runs weekly through Seed and Soft. The automated job is not blocking; its trigger is the first mismatch the runbook finds with no explaining event.
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
  - **Launch plan placement (David, 2026-10-12): not blocking — Phase 13 (admin console).** Still present on `main` (`adminConfig.ts:33-40`), but the Stripe-mode risk below no longer applies: every Stripe construction decides its mode through the strict row read, not this cache. And with no cross-instance invalidation, other instances already serve the old value for up to 60 s after a save, so the race adds no new staleness.
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

- **`getStripeSync()` is not mode-scoped or rejection-safe (found on PR #299's review, deferred by PR #308) — FIXED by the single-flight bugfix (workstream #652).**
  - **Launch plan review (David, 2026-10-12; corrected 2026-10-13): nothing to place.** Fixed on `main` by #657. The Phase 3 connection-budget work still counts the StripeSync pool, as the autoscale entry says.
  - **What it was.** Three defects in the cached `StripeSync` constructor:
    (1) no single-flight, so concurrent cache misses each built a
    `StripeSync` and its two-connection `pg.Pool`; (2) a mode flip mid-flight
    let an old-mode build publish after `invalidateStripeSync()`; (3) the
    secret key and webhook secret were read under independent mode reads.
    PR #577 closed (2) and (3) with a construction generation counter, a
    re-read of the stored mode, and `buildStripeSync(liveMode)`.
  - **The fix.** Construction is now single-flight, keyed by mode **and**
    generation: concurrent misses for the same mode share one build; a
    flight for a superseded generation or another mode is never joined. A
    rejected flight is cleared, never cached, so the next caller retries.
    Regression test: `stripeModeToggle.test.ts`, *concurrent callers on a
    cold cache share ONE construction* (it built twice before the fix).
  - **What the old "leak" wording got wrong, and what stays by design.** A
    pool is not leaked: the library's pool sets no idle options, so
    pg-pool's defaults apply (`min` 0, `idleTimeoutMillis` 10000;
    `pg-pool/index.js:90,98-99`), and a dropped instance's idle connections
    close within ten seconds. Builds the generation check rejects are ended
    at once (`discardRejectedBuild`). A cached instance that
    `invalidateStripeSync()` drops is deliberately **not** ended: a webhook
    or sync still running on it would fail mid-query, and idle release
    reclaims its connections when that work finishes.
  - **What remains, not a defect.** The toggle PATCH's setup pass and its
    full sync both run a backfill — admin-visible work, kept on purpose.

- **Three gaps PR #577 recorded for "an immediate follow-up PR" that never shipped (found in the 2026-10-12 batched harvest).**
  - **Launch plan review (2026-10-13): nothing to place.** All three are fixed on `main`: (1) by #658, (2) by the #653 follow-up, (3) by #655.
  - **What.** Recorded on workstream #571's harvest notes. Re-read against
    `main` at the harvest. None of the three has a fix in the window, but
    none was reproduced either:
    1. **(P1 as recorded) — both halves FIXED by the bugfixes that
       followed the harvest.** Diagnosis found the
       recorded case was one instance of a class: initialization completion
       was a single process-wide flag, so any switch of the active mode
       left the new account's webhook unregistered. It is now per mode, and a
       committed toggle starts setup for the new mode
       (`stripeModeToggle.test.ts`, *a mode change initializes the newly
       active mode*). **Observability half FIXED by the bugfix that
       followed (workstream #652):** the Billing summary attaches a setup
       state to a verified mode, and the panel reads *Account verified —
       Stripe setup not finished* with the failing step until the webhook
       is registered (`stripeModeToggle.test.ts`, *a verified mode whose
       setup keeps failing reads as failing on the Billing summary*).
    2. **(P2) — FIXED by the follow-up to #653.** `runStripeVerificationRetryOnce`
       made its deterministic-refusal skip on the lenient cached mode
       (`isLiveMode()`) before the strict read, so after a toggle committed
       by another instance it skipped the newly active mode until the config
       cache expired. The pass now reads the mode strictly first and skips
       only once the stored mode is known to be the refused one
       (`stripeModeToggle.test.ts`, *a refused old mode does not stop the
       retry seeing a remote switch its cache has not caught up with*).
    3. **(P2) — FIXED by #655**, with the same leak found and fixed in
       `routes.stripe` and `routes.adminStripeSync`. As recorded:
       `stripePaymentRefusal.test.ts` sets `STRIPE_SECRET_KEY_TEST`,
       `STRIPE_PUBLISHABLE_KEY_TEST` and `STRIPE_ACCOUNT_ID_TEST` in a
       `beforeEach`. The hook is already scoped inside its `describe`, which
       is the first half of the fix. Nothing restores the variables, though,
       so under the api-server runner's `--test-isolation=none` they stay set
       for every later test in the same process
       ([`node-test-top-level-hook-is-root-hook.md`](../../.agents/memory/node-test-top-level-hook-is-root-hook.md)).
  - **Why deferred.** Not deliberately deferred: the follow-up was promised in
    the harvest notes and never opened. Recorded here so the promise lives
    somewhere with an owner.
  - **Cost of waiting.** None now: all three are fixed (workstream #652).
    The entry stays as the record until the next `/maintenance` prunes it.
  - **Revisit trigger.** Before the live-mode work in launch Phase 10 (#628),
    which is the first time a mode toggle is a real operator action.

- **No CI guard against dangling `docs/plans/*` citations from code (found on PR #319's `/document` harvest review).**
  - **Reviewed (on my recommendation, David delegated 2026-10-13): not blocking.** The risk is smaller since approved plans are committed (AI-Handbook #204), so a newer citation points at a file that exists; the guard stays for the next tooling pass.
  - **What.** [`plan-doc-path-never-cite-from-code.md`](../../.agents/memory/plan-doc-path-never-cite-from-code.md)
    documents the rule — a code comment or docstring citing a
    `docs/plans/*` path points at a point-in-time record rather than a
    tracker, and for a plan from before 2026-10-12 (when approved plans
    began to be committed) at a path that never reached `main` — and records **two** confirmed occurrences (PR
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
  - **CLOSED (Launch Phase 3, increment 6, 2026-10-28): the hazard is gone.**
    It existed because a schema push rebuilt databases from `schema.ts` and
    dropped what only a migration created; no push runs anywhere now
    ([`migrations-and-backfills.md`, *How a database receives a change*](./migrations-and-backfills.md#how-a-database-receives-a-change)).
    The blocking half below was met by increment 2 (PR #772): the baseline is
    taken from a migrated database, `0112` restored the thirteen objects
    pushes had stripped, and `lib/db/src/baseline.test.ts` fails if the
    baseline lacks any object the full migration history creates. The rest of
    this entry is history.
  - **Launch plan placement (David, 2026-10-12; widened 2026-10-13): split.** **Blocking, Phase 3, before the schema baseline is cut:** the baseline must reproduce every migration-only object — the ten gaps below (declare each, or give it a reasoned exemption) **and** the seven deliberately unshadowed objects listed above (six partial indexes and `uim_source_object_path_fk`), through a raw-SQL supplement or a baseline taken from a migrated database. A baseline generated from `schema.ts` alone would open Seed without them (Codex, #661). Production is safe today (`runMigrations()` at boot), but test databases built by `push-force` already lack all seventeen. The CI guard itself is not blocking: Phase 3 if it fits, otherwise the next tooling pass. All ten gaps were confirmed still missing from `lib/db/src/schema/` at `92024f3`.
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
    - `UQ_uim_user_is_profile` (`0055`, also partial — same call as
      above). (`affiliate_clicks_source_idx` went with its table in launch
      Phase 4, removal 11, migration 0110.)
    - The **inline, auto-named CHECK** `share_intents.platform`
      (`0052:22`) — `shareIntents.ts` mentions it in a comment but
      declares no `check()` builder, so a push-built database silently
      loses the vocabulary's enforcement. (Its sibling,
      `hero_examples.artifact_type`, went with its table in removal 11.)

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

- **No CI guard against a stale hand-written count in doc/comment prose
  (found on PR #513's `/document` harvest, first recorded occurrence).**
  - **Reviewed (on my recommendation, David delegated 2026-10-13): not blocking, trigger unchanged.**
  - **What.** [`code-review.md`](code-review.md#a-count-in-prose-is-a-hand-maintained-duplicate-of-the-thing-it-counts)
    documents the pattern — a number written into a doc, comment, header, or
    PR body that summarizes a separately-maintained enumerated set (e.g.
    "four findings", "five failed attempts") is a duplicate source of truth
    in miniature, and it goes stale specifically *during the edit that's
    fixing something else*, which is the moment attention is elsewhere.
    Three instances landed in one session (2026-08-17), the sharpest inside
    the very edit that added the count that made it wrong. Nothing
    mechanical catches this today; it relies on a reviewer noticing.
  - **Why deferred now.** This repo's own rule is that a recurring failure
    pattern becomes a deterministic CI guard, not a reviewer-memory ask —
    this entry is the queued acknowledgment of that rule firing, not a
    decision to skip it. Not implemented in the PR that raised it (#513)
    because that pass is a docs-only `/document` harvest; writing and wiring
    a new guard script is a code change outside that ceremony's boundary.
    Unlike the two sibling entries below, this is the **first** recorded
    occurrence, not the third — flagged here specifically so a maintenance
    sweep can watch for a second and third instance rather than the pattern
    only living in review-guidance prose that nothing re-reads on a
    schedule.
  - **Cost of waiting.** Low today (one session, three instances, all caught
    by the same reviewer in the same pass) — but the pattern's own point is
    that it goes unnoticed precisely when attention is on something else, so
    "caught so far" isn't evidence it'll keep being caught.
  - **Shape of the fix, not yet built.** Nontrivial to do well: a naive
    regex over standalone numbers in prose would false-positive on
    configured values, dates, and thresholds that this pattern explicitly
    doesn't cover (see the "does not apply" carve-out in the code-review.md
    entry). A workable version likely needs to pair a counting word ("four
    findings", "N instances", "N attempts") with a nearby enumerated list or
    table and flag a mismatch between the stated count and the actual item
    count — closer to a doc-linting AST pass than a grep.
  - **Revisit trigger.** Next dev-infra/tooling pass, or the next time this
    exact mistake recurs a second time (matching the two-strikes-plus
    threshold the sibling CI-guard entries below used before being written
    up as backlog items).

- **`app.ts`'s `ORIGIN_EXEMPT_PATHS` can desync from `isDevAdminLoginEnabled()` in a shared process (found on PR #319's `/document` harvest review).**
  - **Reviewed (on my recommendation, David delegated 2026-10-13): not blocking.** Still present on `main` (`app.ts:41` at import, `:208` per call). Development-only and fail-closed. Fixed in launch Phase 2 if the test harness touches `app.ts`; otherwise the bugfix trigger stands.
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

- **~~The api-server test suite flaked once on `main` (observed 2026-08-15 `/maintenance`)~~ — GRADUATED to #642, 2026-10-12.**
  **Launch plan placement (on my recommendation, David delegated 2026-10-13):** #642 is closed in Phase 2, since a flaky suite is not evidence.
  The revisit trigger fired at the 2026-10-12 pass and David approved the
  `/bugfix` task the same day; #642 carries the evidence and the
  investigation. Six `Build` runs were red on `main` between 2026-08-15 and
  2026-09-03. Four failed at `Run api-server test suite` (`b2d0c30`,
  `7ad7d29`, `e183122`, `5cbd6c1`). Two failed at `Run route-load smoke suite`
  instead (`341e14b`, `b20f6d3`), which looks like the class #633 tracks.
  `main` has been green since 2026-09-03. The original entry is kept below
  for the reasoning.

  - **What.** `Build` run 31911725205 on commit `7e37cc8` (PR #451's squash —
    a metrics-record-only change touching a loop record)
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
  - **Revisit trigger.** ~~The **next `/maintenance` pass**: if the api-server
    suite has failed on `main` again since 2026-08-15, this graduates to a
    `/bugfix` task and this entry closes.~~ **Fired 2026-10-12; now #642.**

- **Workstream labels kept current by hand — contract-diet candidate, held (2026-10-12).**
  - **Reviewed (on my recommendation, David delegated 2026-10-13): not blocking, trigger unchanged.**
  - **What.** The 2026-10-12 pass found ~40 workstream issues left at
    `stage:code-review` or `stage:close-out` after their PRs merged, and closed
    them. The candidate conversion was an on-merge workflow that moves the
    issue named on a PR's `Workstream:` line.
  - **Why deferred now.** The rule lives in `workstream-tracking.md`, which is
    synced from AI-Handbook, so a conversion belongs there. The rule was
    tightened on 2026-09-25: whoever reaches close-out also closes the issue.
    Every stale issue the pass found was opened before that date; the newest
    was opened on 2026-08-29. That is the observation, not proof that no drift
    has happened since. David chose to record it as fixed rather than build
    the conversion ("Option 1", 2026-10-12).
  - **Cost of waiting.** If drift resumes, `/next` recommends finished work
    until the next pass catches it.
  - **Revisit trigger.** The next `/maintenance` pass checks the open issues
    opened after 2026-09-25, the cohort David agreed. It looks for either:
    - a pre-merge stage (`stage:code-review` and earlier) whose PR has merged;
    - `stage:close-out` with nothing outstanding (`workstream-tracking.md`,
      *Close-out is a moment, not a resting state*).

    Verification, UAT or named close-out work still open is not stale. If any
    issue is stale, bring the conversion back to David with that evidence, as
    a handbook change. If none is, close this entry as fixed. Older issues are
    outside this check, so it cannot rule out drift on them.

---

## Product deferrals live elsewhere

Deferred features and product-direction bets are **not** in this doc. See
[`current-roadmap.md` → Explicitly deferred work](../ai-context/current-roadmap.md#explicitly-deferred-work).
