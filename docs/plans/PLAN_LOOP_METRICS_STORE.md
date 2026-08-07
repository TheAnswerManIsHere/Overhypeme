# Plan: per-loop metrics store + a David-facing efficacy digest

Replace the single-file loop ledger's *writing* mechanism with one small JSON
file per loop, and — the part that was never built — actually deliver the
resulting insight to David.

**Scope note (David, 2026-08-07).** This is an internal tracking tool. It is
not payments, auth, or the visual pipeline. Where a simpler design is
slightly weaker, the simpler design wins: an occasional hand-resolved git
conflict or a week of missing data is an acceptable outcome here. Round 2 of
this plan's own review found a corrections-overlay system, a dissent array,
and a deterministic reconciliation protocol — all invented in round 1, all
generating further findings. They are removed. Everything below is
deliberately the boring version.

## Problem

1. **Concurrent sessions collide.** One markdown table with hand-assigned
   ordinals, written via `[LEDGER]` PRs that CI *requires* to carry every
   owed row, means two concurrent recorders are forced to overlap and fail
   each other's gates. PRs #327 and #335 hit exactly this.
2. **The guard is bigger than the thing it guards.** `check-ledger-coverage.mjs`
   is ~970 lines, almost all of it policing problems the storage design
   creates. Its own PR (#304, 61.1% self-inflicted, 7 rounds) and the
   ledger's bootstrap (#270, 64.7%, 16 rounds) are two of the four worst
   loops in the dataset.
3. **The insight never reaches David.** The answers live in a ~2,500-word
   analysis section inside a file he never opens. He found out about the row
   duplication by stumbling into it.

## Product Intent

(David, 2026-08-07 — the "lean" option, then the simplification directive.)

- Claude can give David meaningful, data-backed insight into how effective
  the review loops are, and data points to optimize them. **The insight is
  brought to him**; he does not open GitHub to read rows.
- Recording a loop doesn't collide with another session doing the same.
- Keep it simple. Match the engineering to the stakes — this is a tracking
  tool, not mission-critical infrastructure.

## Must Not Change

- **Counted, never recalled.** Mechanical figures stay `loop-metrics.mjs`-derived.
- **The obligation stays shared and cross-agent** (both Claude and Codex
  record; contract in `working-modes.md`), and **`--mcp-snapshot` keeps
  working** — it is Claude's primary path in this container, whose
  `GITHUB_TOKEN` 401s against the real API.
- **The existing ledger's contents are never edited or re-derived** — see
  "History" below.
- **The adjudication rubric** (five causes, precedence, exact
  finding-by-finding disagreement, ambiguous → self-inflicted, the
  **strictly-greater-than-20%** gate, `unmeasured` loops excluded from the
  trend, and `n/a` for a loop with no valid findings) is unchanged; only
  *when* adjudication runs changes.
- Branch protection and the PR-required flow are untouched. Plan approval
  stays explicit-only.

**Explicitly relaxed, with David's directive as the authority (2026-08-07).**
Earlier drafts listed "recorded data is append-only, never mutated" as an
invariant. **It is not one any more.** A record can be edited or deleted in
an ordinary commit, and no CI check prevents it. This is a deliberate
relaxation, not an oversight: enforcing it required the corrections-overlay
machinery that round 2 spent half its findings attacking. The residual risk —
a value changes and only git history shows it, which David does not read — is
**accepted**. Review of the PR carrying the edit is the control.

## Settled Decisions

1. **One JSON file per loop**, `.agents/metrics/loops/<pr>.json`, keyed by PR
   number. Different loops never touch the same path, so the real collision —
   two sessions recording *different* loops — disappears entirely.
2. **Record when the loop is done, not when the PR closes.** Reviews can land
   after merge — frozen-ledger rows #323 and #324 are observed cases — so
   recording at closure would persist zero rounds and zero findings. If a
   late review arrives after a record exists, re-derive and edit the record;
   that is an ordinary commit, permitted by the relaxation above.
3. **Idempotent write:** `loop-metrics.mjs --write` no-ops if a record for
   that PR exists in the working tree **or on `origin/main`** (fetched
   first), so a stale branch cannot create a second copy. Two sessions
   recording the same loop at the same instant still produces a git add/add
   conflict; a human picks one. Accepted.
4. **The `[LEDGER]` PR type is retired.** A record rides any PR. No
   carry-everything gate, no title prefix, no dedicated-PR requirement — and
   therefore no debt recursion to terminate.
5. **History stays exactly where it is.** `loop-ledger.md` is frozen as the
   historical archive, contents untouched, with a one-line header pointing at
   the new store. **There is no migration** — no conversion script, no parity
   check, no reverse migration, no re-derivation from the API.
6. **Adjudication is a deterministic sample**: run it iff `pr % 5 === 0`
   **or** `findings >= 30`. Otherwise `never-run`. A loop with no valid
   findings records `n/a` and never launches an adjudicator.
7. **The digest is the product** — `scripts/loop-report.mjs`, narrated to
   David through `/maintenance` and on demand.
8. **Nothing is enforced by a hard CI gate except record validity.** Missing
   records are reported in the digest, which David actually reads, rather
   than failing anyone's build. That removes the entire
   coverage/carrier/backstop apparatus.
9. **Derived values are never stored.** Self-inflicted share, adjudication
   percentage, and adjudication verdict are all computed from their inputs at
   read time. Two representations of one number can disagree; one cannot.
10. **PR #327 is simply closed.** All six rows it carried (#318, #319,
    #322–#325) are already on `main` — verified against `origin/main`'s
    ledger — so it has nothing left to contribute. #335 already merged
    (`6417bf2`); main is at 42 rows.

## Repo Context Inspected

- `.agents/metrics/loop-ledger.md` on `origin/main` (42 rows; #318/#319/
  #322–#325 all confirmed present; rows #323/#324 confirmed as post-merge
  review cases; the `—` preflight convention and the `n/a` / trend-exclusion
  rules in its header contract).
- `scripts/check-ledger-coverage.mjs` (~970 lines), including
  `auditLedgerDebt`'s `FIRST_ENFORCED_PR` cutoff pattern, and its test file.
- `scripts/loop-metrics.mjs` — `derive()`'s exact return object (top-level
  `pr`, `title`, `cohort`, `size`, `rounds`, `findings`, `per_round`,
  `review_interval`, `adjudication_sample`, `warnings`, coarse `state`, and a
  `judgment` block of nulls), `classifyCohort`'s `LEDGER_PATH` exclusion, and
  **`assertMcpSnapshotShape`, which requires only `number`, `title`, and
  `created_at` on the PR — no closure timestamp** (verified at
  `scripts/loop-metrics.mjs:739-746`).
- `.github/workflows/build.yml` — the two guard steps; no `fetch-depth` on
  any checkout (no longer relevant: the new guard needs no base diff).
- `package.json:17` — `check:ledger` points at the script being deleted.
- `docs/ai-context/working-modes.md` → "The loop ledger" (rubric; gate worded
  "Above 20%"; `unmeasured` excluded from the trend).
- `.claude/skills/maintenance/SKILL.md` — the existing "what shipped" digest.
- Live PR state: #335 merged as `6417bf2`; #327 still open; #337/#339/#342
  landed after.

## Current Behavior

One markdown table, hand-appended with hand-assigned ordinals, shipped only
via `[LEDGER]`-titled PRs whose CI gate requires the diff to touch nothing
else *and* to carry every row owed at open — forcing concurrent carriers to
collide. Every row is dual-classified and discarded to `unmeasured` above 20%
disagreement. No delivery mechanism to David exists.

## Source-of-Truth Analysis

- **New loops:** `.agents/metrics/loops/*.json` is the single source of truth.
  Within a record each concept has one home: identity only in top-level `pr`,
  judgment only in top-level `judgment`, and `mechanical` carries neither
  (`derive()`'s output is projected, not stored raw — it contains its own `pr`
  and a null `judgment` that would otherwise go stale).
- **Historical loops:** the frozen `loop-ledger.md` is the archive and remains
  their only source. Nothing reads it programmatically after the freeze.
- **Derived, never stored** (decision 9): self-inflicted share,
  `disagreementPct`, and the adjudication `verdict`.
- The rubric's source of truth stays `working-modes.md`.

## Proposed Design

### 1. The store

A record is one of two shapes. **Measured:**

```json
{
  "schemaVersion": 1,
  "pr": 344,
  "closedAt": "2026-08-07T18:22:10Z",
  "mechanical": {
    "title": "…", "cohort": "feature/code",
    "size": { "files": 5, "additions": 120, "deletions": 8 },
    "rounds": 3, "findings": 7,
    "perRound": [ {"round":1,"findings":4}, {"round":2,"findings":3}, {"round":3,"findings":0} ],
    "reviewInterval": { "…": "…" }, "warnings": []
  },
  "judgment": {
    "causes": { "new": 5, "prop": 1, "wrong": 1, "reRaised": 0, "invalid": 0 },
    "preOpenPreflightMin": 12,
    "breakersFired": "none"
  },
  "adjudication": { "status": "never-run" },
  "notes": "free text"
}
```

**Exempt** — an explicit schema-union branch, not a measured record with holes:

```json
{ "schemaVersion": 1, "pr": 351, "exempt": "<reason>" }
```

An exempt record satisfies the completeness gate by construction, is excluded
from every metric aggregate, and is listed as exempt in the digest's data
health. It carries no `closedAt` and no `mechanical`, and no report path may
assume it does.

Field rules:

- **`adjudication.status`** is `never-run`, `n/a` (no valid findings — see
  the churn rule below), `deferred` (with a reason), or `completed`. A
  `completed` adjudication stores **only** `population` and `disagreements`;
  `disagreementPct` and `verdict` are computed from them at read time
  (decision 9), so the four values cannot contradict each other.
- **`preOpenPreflightMin`** may be `null` with a stated reason, meaning
  *genuinely unknown* — the frozen ledger's `—` convention, e.g. a branch
  carrying unrelated earlier work. Null is distinct from a measured `0` and
  is never treated as zero. An unknown preflight does **not** make the
  judgment incomplete.
- **`closedAt`** comes from `derive()` (which currently keeps only a coarse
  `state`). Because `--mcp-snapshot` is a Must Not Change path and its shape
  assertion does not require a closure timestamp, **the snapshot contract is
  extended to carry `closed_at`/`merged_at`**, `assertMcpSnapshotShape`
  validates it, and `working-modes.md`'s snapshot instructions say how to
  obtain it.

### 2. The writer

`loop-metrics.mjs --pr N --write` (composes with `--mcp-snapshot`) derives the
mechanical half and writes the file with a `judgment: null` scaffold. It
fetches and checks `origin/main` as well as the working tree; if a record
exists in either, it prints "already recorded" and exits 0. Filename and `pr`
field are written together.

Fixing a wrong value later, or refreshing a record after a late review, is an
ordinary edit to the file, with the prior value noted in `notes` if it
matters. No overlay system.

### 3. Ceremony

1. `--write`, once the loop is actually done (decision 2). 2. Fill
`judgment`. 3. If `pr % 5 === 0` or `findings >= 30`, run the blind
adjudicator and record `population` + `disagreements`; if there are no valid
findings, record `n/a`. 4. Commit the file on whatever PR you have open.

### 4. The guard: `scripts/check-loop-metrics.mjs`

Offline, no token, no base diff, no API:

- Every `loops/*.json` parses and matches one of the two schema branches;
  filename equals `pr`; `mechanical` contains no `pr` or `judgment` key.
- The five causes sum exactly to `mechanical.findings`.
- **Every measured record has a complete `judgment`** (a null
  `preOpenPreflightMin` with a reason still counts as complete) **or an
  explicit `judgmentDeferred` reason** — so a `--write` scaffold committed
  after an interrupted session fails here rather than sitting valid-looking
  forever. An exempt record satisfies this branch by construction.
- A loop meeting the sampling predicate carries an adjudication result, an
  `n/a`, or a stated deferral.
- **A `completed` adjudication is internally consistent**: `0 <=
  disagreements <= population`, and `population` equals the full finding
  population (no sampling within a loop).
- **The frozen ledger matches a checked-in `sha256` baseline**, recorded
  after the one allowed header edit. Without a pinned baseline an offline
  check cannot tell whether the current checkout differs from the cutover
  version, so "any change fails" would not be an executable invariant.

Deleting a record isn't gated by CI (see the relaxation under Must Not
Change). Roughly 150 lines, replacing ~970. `package.json`'s `check:ledger`
is retargeted to the new script in the same PR.

### 5. The digest: `scripts/loop-report.mjs` + `/maintenance`

Reads the store and emits:

- **Volume/cost** — loops closed in the window (`--since`, default 14 days,
  keyed on `closedAt`): rounds, findings, **review time and pre-open
  preflight time reported separately, and both included in any total-cost
  figure**. Unknown preflight stays unknown; it is never summed as zero.
- **Churn** — self-inflicted share per *qualifying* loop, plus the wrong-fix
  vs. propagation split. Qualifying requires **both**: more than one
  finding-bearing round (per `perRound` — the structural-floor rule from the
  ledger's analysis, encoded rather than narrated), **and** an adjudication
  verdict that is not `unmeasured`, which the rubric requires be excluded
  from the trend. A loop whose denominator (`findings - invalid`) is zero —
  zero findings, or every finding invalid — is reported `n/a` and excluded,
  never 0% and never `NaN`.
- **Trend** — the qualifying sequence over time, always labeled with n.
- **Outliers** — the most expensive loops in the window.
- **Data health** — deferred / `never-run` / `unmeasured` / `n/a` / exempt
  counts, and **missing records**, named from a closed-PR list.
  **Completeness is scoped to post-cutover loops** via a `FIRST_RECORDED_PR`
  cutoff set at cutover (the same shape as the existing guard's
  `FIRST_ENFORCED_PR`); historical loops deliberately have no records and are
  never reported missing. Without a token it says "completeness not checked"
  rather than implying the directory is complete.

**Cold start is real and stated, not designed around.** Until several
post-cutover loops exist, churn and trend will say "n = 0/1/2 — not yet
informative," and the digest says exactly that rather than drawing a line
through two points. Volume/cost and data health work from the first record.
The frozen ledger's own analysis section remains the answer for what the
first 42 loops showed; the digest does not restate or bridge to it, and
`/maintenance` narrates the two eras separately when both are relevant.

### 6. Cohort fix

`classifyCohort` is reordered — `plan-review` → `bugfix` (the body's
`**Fix tier:**`) → code-majority → `prose/contract` — and
`.agents/metrics/loops/` joins the existing `LEDGER_PATH` exclusion, so a
docs-only PR carrying a large record isn't reclassified as `feature/code`.
The digest notes the boundary date rather than pooling across it.

## Data Model and Migration Impact

**No migration.** No database or product schema change. The frozen ledger is
edited once, in its header only. Rollback is `git revert` of the cutover PR:
the archive is intact, and at worst a few new records need re-deriving, which
`--write` does in seconds.

## Runtime Behavior

- Two sessions, different loops: two files, no conflict, ever.
- Two sessions, same loop, sequentially — including from a stale branch: the
  second no-ops against `origin/main`.
- Two sessions, same loop, simultaneously: a git add/add conflict; keep
  either copy. Accepted.
- A review lands after the PR merged: record once the loop is done, or edit
  the existing record.
- Nobody records a loop: it shows up as a missing record in the next digest.
- A sampled loop trips the gate: `unmeasured`, flagged in data health, and
  excluded from churn and trend.

## Admin/User UX Impact

No product surface changes. David's surface is the digest, in chat.

## Security, Permissions, and Validation

No new credentials. The guard needs none at all; the report uses the same
read-only PR listing already available. Nothing here is a new class of public
information — the current ledger is already public.

## Testing Plan

`node --test scripts/__tests__/<file>`, wired into `build.yml` beside the
existing script tests.

- `check-loop-metrics.test.mjs`: schema pass/fail on both branches;
  filename↔`pr` mismatch; `mechanical` containing `pr` or `judgment`;
  arithmetic pass/fail; a committed `--write` scaffold with null judgment and
  no deferral **fails**; null-with-reason preflight **passes** as complete;
  sampling boundaries (`pr % 5`, findings 29 vs 30); a no-valid-findings
  sampled PR passes with `n/a`; **contradictory `completed` adjudication
  fixtures fail** (`disagreements > population`, negative, non-full
  population); an exempt record passes completeness; frozen-ledger content
  change **and** baseline mismatch both fail.
- `loop-metrics.test.mjs` additions: `mechanicalProjection` strips `pr` and
  `judgment`; `closedAt` present including a zero-review loop; **extended MCP
  snapshot shape — `closed_at` required, and `--mcp-snapshot --write` end to
  end**; `--write` idempotency against a working-tree record **and against an
  `origin/main` record absent from a stale checkout**; cohort reordering
  (bugfix-tier PR with docs → `bugfix`; code-majority with docs →
  `feature/code`; docs-only → `prose/contract`; docs-only carrying a large
  metrics record → still `prose/contract`).
- `loop-report.test.mjs`: self-inflicted computed from causes, invalid
  excluded from the denominator, rounding; **a qualifying all-invalid loop
  reports `n/a`, not 0% or `NaN`**; `>20%` boundary (exactly 20% measured,
  smallest fraction above not) computed from `population`/`disagreements`;
  **an `unmeasured` multi-round loop is excluded from churn and trend**;
  qualifying filter uses `perRound`; `closedAt` window boundaries; preflight
  reported separately with unknown preserved as unknown; **a pre-cutover
  absent record is ignored while the first post-cutover absent loop is named
  by number**; exempt records excluded from aggregates and listed in data
  health; no-token path prints "completeness not checked"; cold-start output
  at n = 0/1/2; empty store.

## Implementation Steps

1. `loop-metrics.mjs`: `mechanicalProjection`, `closedAt`, extended MCP
   snapshot shape, `--write` (with the `origin/main` check), cohort reorder +
   store-path exclusion. Tests.
2. `check-loop-metrics.mjs` + tests; record the frozen-ledger `sha256`
   baseline; retarget `package.json`'s `check:ledger`; rewire `build.yml`;
   delete `check-ledger-coverage.mjs` + its tests.
3. `loop-report.mjs` + tests.
4. Freeze `loop-ledger.md` (header line only).
5. Update `working-modes.md` → "The loop ledger" (including the snapshot
   instructions for closure time), `CLAUDE.md`'s ledger section, and
   `/maintenance`.
6. Close PR #327 (its rows are all on `main` already).

One PR. It is small enough not to need splitting.

## Risks and Mitigations

- **Recording lapses without a hard gate.** Mitigated by the digest naming
  missing records weekly, in front of David. Accepted risk: a week of gaps.
- **Records can be edited or deleted with no CI check.** Explicitly accepted
  (see Must Not Change); PR review is the control.
- **Historical and new data live in two places, with no bridge.** Deliberate:
  converting 42 rows was the largest source of risk and complexity in the
  previous draft, for data that is already readable. `/maintenance` narrates
  the two eras separately.
- **Cold start.** The churn/trend sections say nothing useful for the first
  few loops, and say so explicitly rather than implying a trend.
- **Same-loop simultaneous write conflicts.** Accepted; hand-resolved.

## Questions for David

None.

## Definition of Done

- [ ] Two concurrent recordings of different loops merge with zero conflicts;
      recording the same loop twice in sequence is a no-op, including from a
      stale branch.
- [ ] `check-loop-metrics.mjs` green; a committed null-judgment scaffold and a
      contradictory adjudication both fail it; old guard and its tests
      deleted; `pnpm run check:ledger` works.
- [ ] `--mcp-snapshot --write` produces a schema-valid record with `closedAt`.
- [ ] `loop-report.mjs` produces the digest, names only post-cutover missing
      records, and excludes `unmeasured` loops from churn and trend;
      `/maintenance` narrates it.
- [ ] `loop-ledger.md` frozen, contents byte-identical apart from the header,
      with its `sha256` baseline recorded.
- [ ] `working-modes.md` and `CLAUDE.md` describe the new ceremony; no
      `[LEDGER]` PR requirement survives.
- [ ] PR #327 closed.
