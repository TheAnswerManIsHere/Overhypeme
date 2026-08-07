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
  record; contract in `working-modes.md`), and `--mcp-snapshot` keeps working.
- **The existing ledger's contents are never edited or re-derived** — see
  "History" below.
- **The adjudication rubric** (five causes, precedence, exact
  finding-by-finding disagreement, ambiguous → self-inflicted, the
  **strictly-greater-than-20%** gate) is unchanged; only *when* adjudication
  runs changes.
- Branch protection and the PR-required flow are untouched. Plan approval
  stays explicit-only.

## Settled Decisions

1. **One JSON file per loop**, `.agents/metrics/loops/<pr>.json`, keyed by PR
   number. Different loops never touch the same path, so the real collision —
   two sessions recording *different* loops — disappears entirely.
2. **Idempotent write:** `loop-metrics.mjs --write` no-ops if the record
   already exists. Two sessions recording *the same* loop at the same instant
   produces an ordinary git add/add conflict; a human picks one. That case has
   never occurred outside the carry-everything gate this plan removes, and it
   does not warrant a protocol.
3. **The `[LEDGER]` PR type is retired.** A record rides any PR. No
   carry-everything gate, no title prefix, no dedicated-PR requirement — and
   therefore no debt recursion to terminate.
4. **History stays exactly where it is.** `loop-ledger.md` is frozen as the
   historical archive, contents untouched, with a one-line header pointing at
   the new store. **There is no migration** — no conversion script, no parity
   check, no reverse migration, no re-derivation from the API. The old rows
   remain readable exactly as written; the digest covers the new store, and
   the frozen file's own analysis section remains the record of what the first
   42 loops showed.
5. **Adjudication is a deterministic sample**, not a per-loop gate: run it iff
   `pr % 5 === 0` **or** `findings >= 30`. Otherwise the record says
   `never-run`. A zero-finding loop records `n/a — clean loop` and never
   launches an adjudicator, matching the existing rubric.
6. **The digest is the product** — `scripts/loop-report.mjs`, narrated to
   David through `/maintenance` and on demand.
7. **Nothing is enforced by a hard CI gate except record validity.** Missing
   records are reported in the digest, which David actually reads, rather than
   failing anyone's build. That is a better feedback loop than a red check
   nobody looks at, and it removes the entire coverage/carrier/backstop
   apparatus.
8. **PR #327 is simply closed.** All six rows it carried (#318, #319, #322–#325)
   are already on `main` — verified against `origin/main`'s ledger — so it has
   nothing left to contribute. #335 already merged (`6417bf2`); main is at 42
   rows.

## Repo Context Inspected

- `.agents/metrics/loop-ledger.md` on `origin/main` (42 rows; confirmed
  #318/#319/#322/#323/#324/#325 all present).
- `scripts/check-ledger-coverage.mjs` (~970 lines) and its test file.
- `scripts/loop-metrics.mjs` — `derive()`'s exact return object (top-level
  `pr`, `title`, `cohort`, `size`, `rounds`, `findings`, `per_round`,
  `review_interval`, `adjudication_sample`, `warnings`, coarse `state`, and a
  `judgment` block of nulls), `classifyCohort`'s existing `LEDGER_PATH`
  exclusion, and the `--mcp-snapshot` adapter.
- `.github/workflows/build.yml` — the two guard steps; confirmed no
  `fetch-depth` on any checkout (relevant only because this plan no longer
  needs a base diff — see the guard section).
- `package.json:17` — `check:ledger` still points at the script being deleted.
- `docs/ai-context/working-modes.md` → "The loop ledger" (rubric; gate worded
  "Above 20%").
- `.claude/skills/maintenance/SKILL.md` — the existing "what shipped" digest.
- Live PR state: #335 merged as `6417bf2`; #327 still open; #337/#339/#342
  landed after.

## Current Behavior

One markdown table, hand-appended with hand-assigned ordinals, shipped only
via `[LEDGER]`-titled PRs whose CI gate requires the diff to touch nothing else
*and* to carry every row owed at open — forcing concurrent carriers to collide.
Every row is dual-classified and discarded to `unmeasured` above 20%
disagreement. No delivery mechanism to David exists.

## Source-of-Truth Analysis

- **New loops:** `.agents/metrics/loops/*.json` is the single source of truth.
  Within a record each concept has one home: identity only in top-level `pr`,
  judgment only in top-level `judgment`, and `mechanical` carries neither
  (`derive()`'s output is projected, not stored raw — it contains its own `pr`
  and a null `judgment` that would otherwise go stale).
- **Historical loops:** the frozen `loop-ledger.md` is the archive and remains
  their only source. Nothing reads it programmatically after the freeze.
- **Derived, never stored:** self-inflicted share is computed at report time
  from the cause counts, not stored alongside them — two representations of
  one number can disagree.
- The rubric's source of truth stays `working-modes.md`.

## Proposed Design

### 1. The store

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

`adjudication.status` is one of `never-run`, `completed` (with `population`,
`disagreements`, `disagreementPct`, `verdict: "measured" | "unmeasured"` at the
>20% line), `n/a — clean loop` (zero findings), or `deferred` (with a reason).
An exemption is `{ "pr": N, "exempt": "<reason>" }`. `derive()` gains
`closedAt` (it currently keeps only a coarse `state`), which the report windows
on.

### 2. The writer

`loop-metrics.mjs --pr N --write` (composes with `--mcp-snapshot`) derives the
mechanical half and writes the file with a `judgment: null` scaffold. If the
record already exists, it prints "already recorded" and exits 0. Filename and
`pr` field are written together.

Fixing a wrong value later is an ordinary edit to the file, with the previous
value noted in `notes` if it matters. No overlay system.

### 3. Ceremony

1. `--write`. 2. Fill `judgment`. 3. If `pr % 5 === 0` or `findings >= 30`,
run the blind adjudicator and record the result; if `findings === 0`, record
`n/a — clean loop`. 4. Commit the file on whatever PR you have open.

### 4. The guard: `scripts/check-loop-metrics.mjs`

Offline, no token, no base diff, no API:

- Every `loops/*.json` parses and matches the schema; filename equals `pr`;
  `mechanical` contains no `pr` or `judgment` key.
- The five causes sum exactly to `mechanical.findings` when both are present.
- **Every record has a complete `judgment` or an explicit `judgmentDeferred`
  reason** — a `--write` scaffold that was committed after an interrupted
  session fails here rather than sitting valid-looking forever.
- A loop meeting the sampling predicate carries an adjudication result, an
  `n/a — clean loop`, or a stated deferral.
- Any change to `.agents/metrics/loop-ledger.md` fails (post-freeze).

Deleting a record isn't gated by CI — it would show up in review, and the file
is in git history regardless. Roughly 150 lines, replacing ~970.

`package.json`'s `check:ledger` is retargeted to the new script in the same PR.

### 5. The digest: `scripts/loop-report.mjs` + `/maintenance`

Reads the store and emits:

- **Volume/cost** — loops closed in the window (`--since`, default 14 days,
  keyed on `closedAt`): rounds, findings, review hours, totals.
- **Churn** — self-inflicted share (computed from causes) per *qualifying*
  loop, meaning more than one finding-bearing round per `perRound` — the
  structural-floor rule from the ledger's analysis, encoded rather than
  narrated — plus the wrong-fix vs. propagation split.
- **Trend** — the qualifying sequence over time, always labeled with n.
- **Outliers** — the most expensive loops in the window.
- **Data health** — deferred/`never-run`/`unmeasured` counts, any sampled loop
  that tripped the >20% gate, and **missing records**, named from a closed-PR
  list. Without a token it says "completeness not checked" rather than
  implying the directory is complete.

`/maintenance` runs it and narrates the result to David in plain language —
a few sentences, not tables. The script computes; the narration interprets.

### 6. Cohort fix

`classifyCohort` is reordered — `plan-review` → `bugfix` (the body's
`**Fix tier:**`) → code-majority → `prose/contract` — and
`.agents/metrics/loops/` joins the existing `LEDGER_PATH` exclusion, so a
docs-only PR carrying a large record isn't reclassified as `feature/code`.
The digest notes the boundary date rather than pooling across it.

## Data Model and Migration Impact

**No migration.** No database or product schema change. The frozen ledger is
edited once, in its header only. Rollback is `git revert` of the cutover PR:
the archive is intact, and at worst a few new records need re-deriving from
the API, which `--write` does in seconds.

## Runtime Behavior

- Two sessions, different loops: two files, no conflict, ever.
- Two sessions, same loop, sequentially: the second no-ops.
- Two sessions, same loop, simultaneously: a git add/add conflict; keep either
  copy. Accepted.
- Nobody records a loop: it shows up as a missing record in the next digest.
- A sampled loop trips the gate: recorded `unmeasured`, flagged in the digest.

## Admin/User UX Impact

No product surface changes. David's surface is the digest, in chat.

## Security, Permissions, and Validation

No new credentials. The guard needs none at all; the report uses the same
read-only PR listing already available. Nothing here is a new class of public
information — the current ledger is already public.

## Testing Plan

`node --test scripts/__tests__/<file>`, wired into `build.yml` beside the
existing script tests.

- `check-loop-metrics.test.mjs`: schema pass/fail; filename↔`pr` mismatch;
  `mechanical` containing `pr` or `judgment`; arithmetic pass/fail; a
  committed `--write` scaffold with null judgment and no deferral **fails**;
  sampling predicate boundaries (`pr % 5`, findings 29 vs 30); a zero-finding
  sampled PR passes with `n/a — clean loop`; frozen-ledger edit fails.
- `loop-metrics.test.mjs` additions: `mechanicalProjection` strips `pr` and
  `judgment`; `closedAt` present including a zero-review loop; `--write`
  idempotency; cohort reordering (bugfix-tier PR with docs → `bugfix`;
  code-majority with docs → `feature/code`; docs-only → `prose/contract`;
  docs-only carrying a large metrics record → still `prose/contract`).
- `loop-report.test.mjs`: self-inflicted computed from causes (including the
  invalid-excluded denominator and rounding); qualifying filter uses
  `perRound` (a one-finding-bearing-round loop excluded, a two-round one
  included); `closedAt` window boundaries; missing records named from a
  fixture list; no-token path prints "completeness not checked"; exactly-20%
  is measured and the smallest fraction above is not; empty store.

## Implementation Steps

1. `loop-metrics.mjs`: `mechanicalProjection`, `closedAt`, `--write`, cohort
   reorder + store-path exclusion. Tests.
2. `check-loop-metrics.mjs` + tests; retarget `package.json`'s `check:ledger`;
   rewire `build.yml`; delete `check-ledger-coverage.mjs` + its tests.
3. `loop-report.mjs` + tests.
4. Freeze `loop-ledger.md` (header line only).
5. Update `working-modes.md` → "The loop ledger", `CLAUDE.md`'s ledger
   section, and `/maintenance`.
6. Close PR #327 (its rows are all on `main` already).

One PR. It is small enough not to need splitting.

## Risks and Mitigations

- **Recording lapses without a hard gate.** Mitigated by the digest naming
  missing records weekly, in front of David. Accepted risk: a week of gaps.
  This is a tracking tool.
- **Historical and new data live in two places.** Deliberate: converting 42
  rows was the single largest source of risk and complexity in the previous
  draft, for data that is already readable. The frozen file's own analysis
  section remains the historical answer; the digest covers what comes next.
- **Same-loop simultaneous write conflicts.** Accepted; hand-resolved.

## Questions for David

None.

## Definition of Done

- [ ] Two concurrent recordings of different loops merge with zero conflicts;
      recording the same loop twice in sequence is a no-op.
- [ ] `check-loop-metrics.mjs` green; a committed null-judgment scaffold
      fails it; old guard and its tests deleted; `pnpm run check:ledger` works.
- [ ] `loop-report.mjs` produces the digest; `/maintenance` narrates it.
- [ ] `loop-ledger.md` frozen, contents byte-identical apart from the header.
- [ ] `working-modes.md` and `CLAUDE.md` describe the new ceremony; no
      `[LEDGER]` PR requirement survives.
- [ ] PR #327 closed.
