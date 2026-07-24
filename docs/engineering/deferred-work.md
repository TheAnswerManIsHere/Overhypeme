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
  - **Cost of waiting.** Low today — 0.34.5 works and has no known CVE. Grows
    if a security advisory lands on 0.34.x or we need a 0.35-only feature.
  - **Update (2026-07-24).** The typings-resolution bug is already fixed —
    sharp v0.35.1 (2026-06-11) shipped "Ensure type definitions are published
    for both ESM and CJS" ([#4537](https://github.com/lovell/sharp/issues/4537),
    per the [v0.35.1 changelog](https://sharp.pixelplumbing.com/changelog/v0.35.1/)).
    That leg of the original trigger has fired — noted here so it isn't
    re-discovered as a fresh trigger — but it isn't sufficient on its own: the
    breaking-change surface and the Node ≥ 20.9.0 floor are still real, so this
    stays parked pending a deliberate visual-pipeline upgrade. If/when we pick
    this up, target **0.35.1+**, not raw 0.35.0.
  - **Revisit trigger.** A security advisory hits 0.34.x **OR** we schedule a
    visual-pipeline dependency upgrade with UAT (Opus-tier).
  - **Update (2026-07-24, continued).** The other three bumps bundled in #243
    (drizzle-orm 0.45.2, vite 7.3.6, postcss 8.5.12) turned out **not** to be
    generic hygiene — a Dependabot triage of the repo's open alerts found they
    fix four disclosed High-severity CVEs, including a **SQL injection in
    drizzle-orm** (our direct production ORM). Split out into **PR #246**
    rather than waiting on sharp or the next Dependabot cycle.
    **Status: PR #246 open, NOT YET MERGED as of this writing — these CVEs
    are still live on `main` until it merges.** Anyone (including a
    `/maintenance` pass) reading this entry before #246 merges should treat
    drizzle-orm/vite/postcss as still outstanding, not resolved — check the
    PR's merge state, don't trust this paragraph's tense. Once merged, update
    this line to say so and drop the "not yet merged" caveat. See #246 for the
    full CVE list and verification.

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
