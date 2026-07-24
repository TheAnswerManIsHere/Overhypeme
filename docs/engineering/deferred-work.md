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

> **Note / open question for David.** The roadmap's *"Security follow-ups
> (lower-risk, from the C5/C9 review)"* — CSP Report-Only → enforcing, HSTS
> `includeSubDomains`/`preload`, admin field-length tidying, `confirm`/`limit`
> gates on the API-key backfill launchers, the git-history purge of the removed
> prod dump — are **engineering** deferrals currently living in
> [`current-roadmap.md`](../ai-context/current-roadmap.md#explicitly-deferred-work)
> and detailed in
> [`security-model.md`](../ai-context/security-model.md). Per the
> engineering-vs-product split, they are candidates to migrate *here*. Left in
> place for now to avoid duplicating the security-model context and risking
> drift; migrate on David's call.

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
  - **Cost of waiting.** Low today — 0.34.5 works and has no known CVE. Grows
    if a security advisory lands on 0.34.x or we need a 0.35-only feature.
  - **Revisit trigger.** sharp ships a typings-resolution fix (watch its
    releases) **OR** a security advisory hits 0.34.x **OR** we schedule a
    visual-pipeline dependency upgrade with UAT (Opus-tier). *The safe patches
    bundled in that same PR (drizzle-orm 0.45.2, vite 7.3.x, postcss 8.5.x) are
    **not** deferred — they re-land on their own via the next Dependabot group.*

- **recharts v2 → v3.**
  - **What.** recharts is pinned at `^2.15.x` in `artifacts/overhype-me` and
    `artifacts/mockup-sandbox`. recharts 1.x/2.x are end-of-life ("no longer
    active — bump to v3," per the v3 migration guide flagged in the lockfile).
  - **Why deferred now.** v3 is a major with a migration guide; charts work
    today; not worth a migration mid-flight.
  - **Cost of waiting.** No further bugfixes or security patches on the v2 line.
  - **Revisit trigger.** Next time we do meaningful charts work, or a security
    advisory on recharts v2, or the weekly maintenance sweep judges it overdue.

- **GitHub Actions still targeting Node 20.**
  - **What.** CI actions (`actions/checkout@v4`, `actions/setup-node@v4`,
    `pnpm/action-setup@v4`, `dependency-review-action@v4`) target Node 20;
    GitHub is deprecating Node 20 on runners and currently force-runs them on
    Node 24 with a warning.
  - **Why deferred now.** Warnings only — the actions still run. Bumping to
    majors purely for Node 24 support is low-value churn right now.
  - **Cost of waiting.** Bounded by GitHub's timeline: once the Node 20 fallback
    is removed, un-updated actions break CI.
  - **Revisit trigger.** When the action maintainers ship Node 24-native
    majors, or GitHub announces a hard cutoff date — bump then.

## Code-level tech debt

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
