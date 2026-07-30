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

- **GitHub Actions still targeting Node 20 — READY, trigger fired.**
  - **What.** Every `uses:` action across `.github/workflows/*.yml`
    (exhaustively enumerated via `grep -rhoE "uses: [a-zA-Z0-9._/-]+@v[0-9]+"
    .github/workflows/*.yml`, not a partial list from memory — an earlier
    draft of this entry missed two) targeting Node 20: `actions/checkout@v4`,
    `actions/setup-node@v4`, `pnpm/action-setup@v4`,
    `actions/dependency-review-action@v4`, `actions/cache@v4`,
    `actions/upload-artifact@v4`. GitHub is deprecating Node 20 on runners and
    currently force-runs them on Node 24 with a warning.
  - **Why deferred (originally).** Warnings only — the actions still run.
    Bumping to majors purely for Node 24 support was low-value churn while no
    Node 24-native major existed yet.
  - **Update (2026-07-24).** That's no longer true — verified against each
    action's published `action.yml`: `actions/checkout` is at **v7** (Node 24
    native), `actions/setup-node`'s latest major declares `using: node24`,
    `actions/dependency-review-action`'s latest major declares
    `using: node24`, `pnpm/action-setup@v6` declares `using: node24`,
    `actions/cache@v6` declares `using: node24`, and
    `actions/upload-artifact@v6` declares `using: node24`. The trigger has
    fired for all **six**. (`github/codeql-action/analyze@v4` and
    `github/codeql-action/init@v4`, also in these workflows, are excluded —
    checked separately and already `using: node24` at the `v4` we're pinned
    to; no bump needed there. A commented-out
    `# uses: actions/setup-example@v1` in `codeql.yml` is template text, not a
    live dependency — also excluded.)
  - **Cost of waiting.** Bounded by GitHub's timeline: once the Node 20 fallback
    is removed, un-updated actions break CI. No longer just a future risk —
    the fix is available now.
  - **Revisit trigger.** None remaining on the "does a fix exist" question —
    but these are **major-version bumps**, which the `/maintenance` skill's
    own rule never auto-merges. Surface this as a **decision item** for David
    next `/maintenance` pass (package, old → new, why it matters, recommendation
    — per that skill's existing major-bump reporting format), not an
    instruction to bump unilaterally during that pass. If David approves, the
    actual bump is mechanical and self-verifying via this repo's own CI —
    but it still needs its own approved PR, the same as any other major bump.

## Infra & operational tuning

- **Async-jobs DB connection pool `max`.**
  - **What.** The fast/render/bulk lane split (PR #216, 2026-07) deliberately
    left the `pg.Pool` default `max` of 10 unraised. The
    `pexels`/`ai_meme_backfill` lanes added by variant independence
    (PR #256, 2026-07-25) bring the lanes' combined **handler** concurrency to
    exactly 10 (fast 2 + render 3 + bulk 3 + pexels 1 + ai_meme_backfill 1),
    numerically equal to the pool default.
  - **Correction (2026-07-30, PR #291).** This entry previously read that
    equality as "**zero** spare connections under simultaneous full-lane
    load." That does not follow, and the claim is withdrawn.
    `maxConcurrency` bounds concurrent **handler promises, not checked-out
    clients**: `asyncJobsTick` commits and releases the claim transaction
    *before* `mapWithConcurrency` invokes any handler, a handler awaiting an
    external provider holds no connection at all, and each outcome opens only
    a short finalize transaction. Pool occupancy is therefore bursty at
    claim/finalize boundaries, not pinned at the handler count. See
    [`architecture-map.md`](../ai-context/architecture-map.md#async-jobs-and-queues).
  - **RESOLVED 2026-07-30 by PR #288** (async-queue hardening Phase 1).
    `lib/db/src/index.ts` now sets `max` explicitly — `POOL_MAX_DEFAULT = 20`,
    overridable by `DB_POOL_MAX` — derived from measured production capacity
    (`max_connections` 450 less superuser, migration and non-worker
    allowances) rather than picked, and deliberately double the lanes'
    worst-case 10. Kept here rather than deleted because the Correction above
    is the record of a claim two documents asserted for weeks.
  - **What is still open**, and is not this item: the residual contention
    question. Worker-handler count was never a proxy for connection count, so
    neither the old ceiling's severity nor the new one's headroom has been
    *measured* under load. The revisit trigger is unchanged — pool-acquisition
    wait time or provider rate-limit errors actually showing up. See
    [`decisions.md`](../ai-context/decisions.md#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes).

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

> The other inline marker, `TODO(version-rollback)` in
> `enrichmentVersioning.ts`, is **product** work (an unbuilt feature) and is
> tracked in the roadmap's deferred list, not here.

---

## Product deferrals live elsewhere

Deferred features and product-direction bets are **not** in this doc. See
[`current-roadmap.md` → Explicitly deferred work](../ai-context/current-roadmap.md#explicitly-deferred-work).
