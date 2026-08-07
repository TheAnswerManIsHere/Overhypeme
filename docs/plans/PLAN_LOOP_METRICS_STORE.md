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

- **Counted, never recalled.** Mechanical figures stay `loop-metrics.mjs`-derived,
  and **`--write` refuses a snapshot that is not fully attested** (see §2) so
  a known-understated derivation never lands as measured data.
- **The obligation stays shared and cross-agent** (both Claude and Codex
  record; contract in `working-modes.md`), and **`--mcp-snapshot` keeps
  working** — it is Claude's primary path in this container, whose
  `GITHUB_TOKEN` 401s against the real API.
- **The existing ledger's contents are never edited or re-derived** beyond
  the single permitted header line.
- **The adjudication rubric is unchanged** — five causes, precedence, exact
  finding-by-finding disagreement, ambiguous → self-inflicted, the
  **strictly-greater-than-20%** gate, `unmeasured` excluded from the trend,
  and `n/a` when there are no valid findings. **Every adjudication that runs
  still covers the loop's full finding population.** What changes is only
  *which loops* are adjudicated (see the supersession note in step 5).
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
2. **Record at the loop's terminal point**, defined precisely as: the PR is
   closed or merged **and** no reviewer pass has landed for at least one
   full digest window (14 days), **and the record is committed on a PR other
   than the one being measured.** Reviews can land after merge — frozen-ledger
   rows #323 and #324 are observed cases — so recording at closure would
   persist zero rounds and zero findings. And a record riding its own PR
   changes that PR's diff, which can trigger a further reviewer pass *after*
   the rounds and interval were derived, leaving a record that looks valid
   while omitting the round its own addition caused. If a late review arrives
   after a record exists, re-derive and edit it — an ordinary commit under the
   relaxation above.
3. **Idempotent write, narrowly claimed:** `loop-metrics.mjs --write` no-ops
   if a record for that PR exists in the working tree **or on `origin/main`**
   (fetched first). **Any overlap before a record lands** — two sessions at
   once, or a second session starting while the first's record sits on an
   unmerged PR — is the accepted git add/add conflict case; a human keeps
   either copy. The design does not chase an authoritative open-branch
   lookup, and the Definition of Done claims no more than this.
4. **The `[LEDGER]` PR type is retired.** A record rides any PR (other than
   its own, per decision 2). No carry-everything gate, no title prefix, no
   dedicated-PR requirement — and therefore no debt recursion to terminate.
5. **History stays exactly where it is.** `loop-ledger.md` is frozen as the
   historical archive with a one-line header edit. **There is no migration.**
6. **Adjudication is a deterministic sample across loops**: run it iff
   `pr % 5 === 0` **or** `findings >= 30`. Every adjudication that runs still
   covers that loop's **full** finding population — this samples *loops*, not
   findings within a loop, which is what the 2026-07-27 decision removed
   (step 5).
7. **The digest is the product** — `scripts/loop-report.mjs`, narrated to
   David through `/maintenance` and on demand.
8. **Nothing is enforced by a hard CI gate except record validity.** Missing
   records and deferrals are reported in the digest, which David reads.
9. **Derived values are never stored.** Self-inflicted share, adjudication
   percentage, and adjudication verdict are computed from their inputs at
   read time. Two representations of one number can disagree; one cannot.
10. **PR #327 is simply closed.** All six rows it carried (#318, #319,
    #322–#325) are already on `main`. #335 already merged (`6417bf2`).

## Repo Context Inspected

- `.agents/metrics/loop-ledger.md` on `origin/main` (42 rows; #318/#319/
  #322–#325 present; #323/#324 confirmed post-merge-review cases; the `—`
  preflight convention and the `n/a` / trend-exclusion rules).
- `scripts/check-ledger-coverage.mjs` — `FIRST_ENFORCED_PR`, the paginating
  `gh` helper, and `NON_LOOP_AUTHORS` (Dependabot excluded because
  `/maintenance` merges those without a review loop, `:52-64`).
- `scripts/loop-metrics.mjs` — `derive()`'s exact return object (`pr`,
  `title`, `cohort`, `size`, `rounds`, `findings`, `per_round`,
  `review_interval`, **`adjudication_sample`**, `warnings`, coarse **`state`**,
  and a null `judgment` block); `classifyCohort`, which **has no
  code-majority rule today** — it returns `prose/contract` on any prose path;
  `assertMcpSnapshotShape` (`:739-746`), which requires only `number`,
  `title`, `created_at`; and `assertMcpSnapshotComplete`, which requires
  `complete.issueComments` **only when `issueComments` is supplied**, with
  `derive()` merely warning when it is absent.
- `.github/workflows/build.yml`; `package.json:17` (`check:ledger`).
- `docs/ai-context/working-modes.md` → "The loop ledger".
- **`docs/ai-context/decisions.md:539-577`** — the 2026-07-27 decision
  mandating the markdown ledger *and* full-population (non-sampled)
  adjudication, including its rationale and its "Revisit if" clause.
- **`docs/ai-context/current-roadmap.md:182-190`** — repeats that contract.
- **`.claude/skills/plan-review-loop/SKILL.md:323-327`** — routes reviewer-
  efficacy measurement to the old ledger path.
- `.claude/skills/maintenance/SKILL.md` — the existing "what shipped" digest.
- Live PR state: #335 merged as `6417bf2`; #327 still open.

## Current Behavior

One markdown table, hand-appended with hand-assigned ordinals, shipped only
via `[LEDGER]`-titled PRs whose CI gate requires the diff to touch nothing
else *and* to carry every row owed at open — forcing concurrent carriers to
collide. Every row is dual-classified and discarded to `unmeasured` above 20%
disagreement. No delivery mechanism to David exists.

## Source-of-Truth Analysis

- **New loops:** `.agents/metrics/loops/*.json` is the single source of truth.
  Identity lives only in top-level `pr`, judgment only in top-level
  `judgment`, and `mechanical` carries neither.
- **Historical loops:** the frozen `loop-ledger.md` is the archive and remains
  their only source. Nothing reads it programmatically after the freeze.
- **Derived, never stored:** self-inflicted share, `disagreementPct`, verdict.
- The rubric's source of truth stays `working-modes.md`; the *decision* record
  is superseded in `decisions.md` (step 5), not left contradicting this plan.

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

**`mechanical` is an allowlist, not a spread.** Exactly these keys, and no
others: `title`, `cohort`, `size`, `rounds`, `findings`, `perRound`,
`reviewInterval`, `warnings`. `mechanicalProjection()` builds that object
field by field, and the guard **rejects any unknown key**. This matters
because `derive()` also returns `adjudication_sample` and a coarse `state`; a
rest/spread implementation would persist both beside the authoritative
values, where a later refresh would leave them stale without failing any
other check.

**Adjudication state matrix.** `adjudication.status` is exactly one of:

| status | when it is correct | trend/churn treatment |
|---|---|---|
| `never-run` | the loop does **not** meet the sampling predicate and has ≥1 valid finding | **Included** — the author classification is the measurement |
| `completed` | the loop **does** meet the predicate; stores `population` + `disagreements` only | Included if the derived verdict is `measured`; **excluded** if `unmeasured` |
| `n/a` | the valid-finding denominator (`findings - invalid`) is zero — no findings, or none valid | **Excluded**, and never reported as 0% |
| `deferred` | adjudication or judgment consciously skipped, with a reason | **Excluded**, and listed individually in data health |

The guard enforces this **both ways**: a loop meeting the predicate may not
be `never-run`, and a loop not meeting it may not be `completed`. `n/a` is
accepted only when the denominator is genuinely zero. Roughly four-fifths of
loops will be `never-run`, so their inclusion is the difference between a
digest that says something and one that says almost nothing.

**Other field rules:**

- A `completed` adjudication stores **only** `population` and `disagreements`;
  `disagreementPct` and the `verdict` are computed at read time (decision 9),
  so they cannot contradict each other. The guard validates
  `0 <= disagreements <= population` and that `population` equals the loop's
  full finding count.
- **`preOpenPreflightMin`** may be `null` with a stated reason, meaning
  *genuinely unknown* — the frozen ledger's `—` convention. Null is distinct
  from a measured `0`, is never summed as zero, and does **not** make the
  judgment incomplete.
- **`closedAt`** comes from `derive()`. Because `--mcp-snapshot` is a Must Not
  Change path whose shape assertion does not require a closure timestamp, the
  snapshot contract is extended to carry `closed_at`/`merged_at`,
  `assertMcpSnapshotShape` validates it, and `working-modes.md`'s snapshot
  instructions say how to obtain it.

### 2. The writer

`loop-metrics.mjs --pr N --write` derives the mechanical half and writes the
file with a `judgment: null` scaffold. It fetches and checks `origin/main` as
well as the working tree; if a record exists in either, it prints "already
recorded" and exits 0. Filename and `pr` field are written together.

**`--write` requires a fully attested snapshot.** `assertMcpSnapshotComplete`
today requires `complete.issueComments` only when `issueComments` is present,
and `derive()` merely warns when the collection is absent — correct for
read-only derivation of older snapshots, but wrong for writing, because a
missing issue-comment collection understates exactly the clean rounds and
review time the digest then aggregates as measured. So `--write` **fails** on
a snapshot lacking a complete `issueComments` attestation. Plain derivation
keeps its current lenient behavior for backward compatibility.

Fixing a wrong value later, or refreshing after a late review, is an ordinary
edit to the file, with the prior value noted in `notes` if it matters.

### 3. Ceremony

1. `--write`, at the terminal point defined in decision 2. 2. Fill
`judgment`. 3. If `pr % 5 === 0` or `findings >= 30`, run the blind
adjudicator over the loop's full finding population and record `population` +
`disagreements`; if the valid-finding denominator is zero, record `n/a`;
otherwise `never-run`. 4. Commit the file on any open PR **except the one
being measured**.

### 4. The guard: `scripts/check-loop-metrics.mjs`

Offline, no token, no base diff, no API:

- Every `loops/*.json` parses and matches one of the two schema branches;
  filename equals `pr`; `mechanical` contains **exactly** the allowlisted keys.
- The five causes sum exactly to `mechanical.findings`.
- Every measured record has a complete `judgment` (a null
  `preOpenPreflightMin` with a reason still counts) or an explicit
  `judgmentDeferred` reason. An exempt record satisfies this by construction.
- The adjudication state matrix above, enforced in both directions, including
  the `completed` internal-consistency bounds.
- **The frozen ledger matches a checked-in `sha256` baseline**, recorded
  **after** the permitted header edit (see step 3 — recording it before the
  edit would invalidate it immediately and leave the guard permanently red).

Deleting a record isn't gated by CI (see the relaxation under Must Not
Change). Roughly 150 lines, replacing ~970. `package.json`'s `check:ledger`
is retargeted to the new script in the same PR.

### 5. The digest: `scripts/loop-report.mjs` + `/maintenance`

Reads the store and emits:

- **Volume/cost** — loops closed in the window (`--since`, default 14 days,
  keyed on `closedAt`): rounds, findings, and **review time and pre-open
  preflight time as two separate figures**. When any loop in the window has
  unknown preflight, the preflight total is reported as a **labeled
  known-cost subtotal plus a count of unknowns** ("preflight: 3.2h across 4
  loops; 2 loops unknown") — never a single number that silently treats
  unknown as zero, and never suppressed entirely. Outlier ranking uses review
  time, so an unknown-preflight loop still ranks, with its unknown noted
  rather than being dropped from the ranking.
- **Churn** — self-inflicted share per *qualifying* loop plus the wrong-fix
  vs. propagation split. Qualifying requires **both**: more than one
  finding-bearing round (per `perRound`), **and** an adjudication state whose
  matrix row above says Included.
- **Trend** — the qualifying sequence over time, always labeled with n.
- **Data health** — `never-run` / `unmeasured` / `n/a` / exempt counts;
  **every deferred loop listed individually by PR number and reason** (a
  count alone lets a deferral hide); and **missing records**.

**Completeness input, specified.** Missing records are computed against a
**fully paginated** closed-PR list (the same `Link`-header pagination the
deleted guard's `gh` helper used — truncating at one page would silently
under-report), filtered to: PR number `>= FIRST_RECORDED_PR` (the cutover
cutoff — historical loops deliberately have no records and are never reported
missing), **excluding Dependabot authors** (`NON_LOOP_AUTHORS` — `/maintenance`
merges those without a review loop, so reporting every dependency bump as a
missing loop would make the section useless), and excluding PRs that already
have a record or an exempt record. Without a token, the section prints
"inventory unavailable — completeness not checked" rather than implying the
directory is complete. A snapshot file may be supplied instead of a token.

**Cold start is real and stated.** Until several post-cutover loops exist,
churn and trend say "n = 0/1/2 — not yet informative" rather than drawing a
line through two points. Volume/cost and data health work from the first
record. The frozen ledger's analysis section remains the answer for the first
42 loops; `/maintenance` narrates the two eras separately.

### 6. Cohort fix

`classifyCohort` gains a code-majority rule it does not have today, evaluated
first-match top-down: `plan-review` → `bugfix` (the body's `**Fix tier:**`) →
**code-majority** → `prose/contract`.

**Code-majority, exactly:** for each changed file, `additions + deletions` is
its weight. Files under `.agents/metrics/` (both the frozen ledger and the
new store) contribute to **neither** side — extending the existing
`LEDGER_PATH` exclusion, so a docs-only PR carrying a large record isn't
reclassified. Of the remainder, a file is *docs* if its path ends `.md` or
sits under `docs/`; everything else is *code*. **Code weight strictly greater
than docs weight → `feature/code`; otherwise `prose/contract`** — so ties and
all-docs both land in `prose/contract`, matching today's bias. A rename
counts once, at its destination path, with its own additions/deletions.
The digest notes the boundary date rather than pooling across it.

### 7. Contract updates (step 5 in detail)

Four active sources currently mandate the old contract and must be updated in
the same PR, or agents will be reading contradictory truth:

- **`working-modes.md` → "The loop ledger"** — the new ceremony; rubric and
  snapshot-completeness rules kept verbatim, plus the closure-timestamp
  instruction for MCP snapshots.
- **`CLAUDE.md`'s ledger section** — new ceremony; the `[LEDGER]`
  squash-merge authorization retires with the PR type.
- **`.claude/skills/plan-review-loop/SKILL.md:323-327`** — repoint
  reviewer-efficacy measurement at the store and the digest.
- **`docs/ai-context/decisions.md`** — the 2026-07-27 entry decided
  full-population adjudication *and* the markdown ledger. This plan changes
  the first only in *scope of application*, so the entry gets a **new dated
  superseding decision**, not a silent edit. It must record: (a) that every
  adjudication still covers the full finding population, so the two bias
  defects that killed the original within-loop sample (an id-sort
  oversampling round 1; a round-robin silently dropping the latest rounds)
  **cannot recur** — this samples loops, not findings; (b) that the original
  entry's cost rationale ("full coverage costs tokens, not human time") is
  not the reason for the change; (c) that the actual reason is the observed
  outcome — roughly 40% of adjudicated rows landed `unmeasured` and were
  discarded — plus David's 2026-08-07 scope directive; and (d) that the
  original "Revisit if" clause (adjudicator becomes human) is unaffected and
  still stands.
- **`docs/ai-context/current-roadmap.md:182-190`** — update the summary that
  repeats the old contract.

## Data Model and Migration Impact

**No migration.** No database or product schema change. The frozen ledger is
edited once, in its header only.

**Rollback, bounded honestly.** Reverting the cutover PR is a clean, complete
rollback **only while no post-cutover record has landed**. After that, a
revert restores the old markdown system while the JSON records remain on disk
unreadable by it, and those loops become unrecorded in the restored ledger.
The plan does **not** ship an export path for that case: it is an internal
tracking tool, and the loss is a handful of loops' metrics, re-derivable by
hand from the PRs themselves. That consequence is stated here rather than
discovered later — the accepted-risk treatment, not a solved problem.

## Runtime Behavior

- Two sessions, different loops: two files, no conflict, ever.
- Two sessions, same loop, where the first record has **landed on `main`**:
  the second no-ops.
- Any overlap **before** a record lands (simultaneous, or the first still on
  an unmerged PR): git add/add conflict, keep either copy. Accepted.
- A review lands after the PR merged: the terminal point in decision 2 hasn't
  been reached yet, so no record exists to be wrong; if one does, edit it.
- Nobody records a loop: it appears as a missing record in the next digest.
- A sampled loop trips the gate: `unmeasured`, flagged, excluded from trend.

## Admin/User UX Impact

No product surface changes. David's surface is the digest, in chat.

## Security, Permissions, and Validation

No new credentials. The guard needs none; the report uses the same read-only
PR listing already available. Nothing here is a new class of public
information — the current ledger is already public.

## Testing Plan

`node --test scripts/__tests__/<file>`, wired into `build.yml`.

- `check-loop-metrics.test.mjs`: both schema branches; filename↔`pr` mismatch;
  **`mechanical` carrying `adjudication_sample` or `state` fails** (allowlist);
  arithmetic; a committed null-judgment scaffold fails; null-with-reason
  preflight passes; **state matrix both directions** — a predicate-meeting
  loop marked `never-run` fails, a non-predicate loop marked `completed`
  fails, `n/a` with a non-zero valid denominator fails; contradictory
  `completed` bounds fail; exempt passes; frozen-ledger content change and
  baseline mismatch both fail.
- `loop-metrics.test.mjs`: `mechanicalProjection` emits exactly the allowlist;
  `closedAt` including a zero-review loop; extended MCP snapshot shape;
  **`--mcp-snapshot --write` fails on a snapshot missing a complete
  `issueComments` attestation, while plain derivation still warns and
  succeeds**; `--write` idempotency against working tree and against
  `origin/main` from a stale checkout; cohort **code-majority fixtures:
  mixed, deletion-heavy, exact tie → `prose/contract`, docs-only carrying a
  large metrics record → `prose/contract`, rename counted once**.
- `loop-report.test.mjs`: self-inflicted from causes with invalid excluded;
  **`never-run` loops included in churn/trend**; `unmeasured` excluded;
  all-invalid → `n/a`; `>20%` boundary from `population`/`disagreements`;
  `closedAt` window boundaries; **mixed known/unknown preflight — subtotal
  plus unknown count, and the unknown loop still ranked**; **completeness
  with a multi-page inventory and a Dependabot PR present** (paginates fully,
  excludes the bump, names the real missing loop); pre-cutover absences
  ignored; exempt excluded from aggregates and listed; no-token disclaimer;
  cold-start at n = 0/1/2; empty store.

## Implementation Steps

1. `loop-metrics.mjs`: `mechanicalProjection` (allowlist), `closedAt`,
   extended MCP snapshot shape, `--write` (with the `origin/main` check and
   the full-attestation requirement), cohort code-majority rule + store-path
   exclusion. Tests.
2. `loop-report.mjs` + tests.
3. **Freeze `loop-ledger.md` (header edit) first, then compute and check in
   its `sha256`** — recording the digest before the edit would invalidate it
   immediately and leave the new guard red.
4. `check-loop-metrics.mjs` + tests (consuming the baseline from step 3);
   retarget `package.json`'s `check:ledger`; rewire `build.yml`; delete
   `check-ledger-coverage.mjs` + its tests.
5. Contract updates — all five sources in §7, including the superseding
   `decisions.md` entry.
6. Close PR #327 (its rows are all on `main` already).

One PR. It is small enough not to need splitting.

## Risks and Mitigations

- **Recording lapses without a hard gate.** The digest names missing records
  weekly, in front of David. Accepted: a week of gaps.
- **Records can be edited or deleted with no CI check.** Explicitly accepted;
  PR review is the control.
- **A deferral can be used to skip both judgment layers.** Accepted rather
  than gated: a self-asserted `authorizedBy` field would be authorization
  theatre (round 2 established that the guard cannot verify such a claim).
  The real control is visibility — every deferred loop is listed
  individually, by PR number and reason, in every digest, so a standing
  deferral stays in front of David until resolved.
- **Rollback after records land is lossy.** Bounded and stated above.
- **Cold start.** The digest says "not yet informative" rather than implying
  a trend.
- **Historical and new data live in two places, with no bridge.** Deliberate;
  `/maintenance` narrates the two eras separately.

## Questions for David

None blocking. One thing worth his awareness, recorded in the superseding
decision rather than as an open question: this plan reverses part of a
2026-07-27 decision whose stated rationale was that adjudication cost does
not justify sampling. That rationale addressed *within-loop* sampling, which
this plan does not reintroduce, and the new evidence (≈40% of adjudicated
rows discarded as `unmeasured`) did not exist when it was written.

## Definition of Done

- [ ] Two concurrent recordings of different loops merge with zero conflicts;
      a second `--write` no-ops when the first record has **landed on `main`**,
      including from a stale checkout. Pre-landing overlap is the accepted
      conflict case and is not claimed otherwise.
- [ ] `check-loop-metrics.mjs` green; allowlist, state-matrix (both
      directions), scaffold, and contradictory-adjudication fixtures all fail
      as intended; old guard and tests deleted; `pnpm run check:ledger` works.
- [ ] `--mcp-snapshot --write` produces a schema-valid record with `closedAt`,
      and **refuses** an unattested snapshot.
- [ ] `loop-report.mjs` includes `never-run` loops in churn/trend, excludes
      `unmeasured`, paginates the inventory, excludes Dependabot, names only
      post-cutover missing records, lists deferrals individually, and reports
      mixed known/unknown preflight without treating unknown as zero.
- [ ] `loop-ledger.md` frozen, contents byte-identical apart from the header,
      with its `sha256` recorded **after** that edit and the guard green.
- [ ] All five contract sources in §7 updated, including a dated superseding
      entry in `decisions.md`; no reference to `[LEDGER]` PRs or to
      markdown-row appending survives outside the frozen file.
- [ ] PR #327 closed.
