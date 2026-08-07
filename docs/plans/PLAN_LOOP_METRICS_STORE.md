# Plan: per-loop metrics store, sampled adjudication, and a David-facing efficacy digest

Replaces the single-file loop ledger (`.agents/metrics/loop-ledger.md` + its
`[LEDGER]` PR type + `scripts/check-ledger-coverage.mjs`) with a design whose
storage cannot collide, whose per-loop cost is a fraction of today's, and whose
output is actually delivered to David instead of accumulating in a file he
never opens.

## Problem

Three compounding failures, all observed, none hypothetical:

1. **Concurrent sessions collide by design.** The ledger is one markdown table
   with a hand-assigned ordinal column, appended via `[LEDGER]`-titled PRs
   that CI *requires* to carry every owed row. Two concurrent `[LEDGER]` PRs
   are therefore forced to overlap, assign the same ordinals to different
   loops, and fail each other's permanence gate on merge. This is live right
   now: open PRs #327 and #335 both claim rows 24–26 with different contents,
   both duplicate #322's row, and #335 omits #319 entirely — whichever merges
   first makes the other un-mergeable.
2. **The measurement system is one of the top generators of the pathology it
   measures.** The guard (`check-ledger-coverage.mjs`, ~970 lines) exists
   almost entirely to police problems the storage design creates (carrier
   logic, backstop deferral, permanence-vs-main, stray-file/rename gates).
   Its own PR (#304) ranks fourth-worst in the ledger for self-inflicted
   share (61.1%, seven rounds hardening code written mid-loop); the ledger's
   bootstrap (#270) ranks third (64.7%, 16 rounds).
3. **The insight never reaches its consumer.** The system's purpose is to
   give David checkable answers about loop efficacy. Those answers currently
   live in a ~2,500-word analysis section inside the ledger file — David
   found out about the row duplication by stumbling into it. Meanwhile ~40%
   of rows that paid full dual-classification cost ended up `unmeasured`
   (discarded by the 20% disagreement gate), and the cohort column is
   known-broken (`.md`-presence leak), so the core cross-loop comparisons
   don't work.

## Product Intent

(David, 2026-08-07, this session — option 1 of 3, "lean.")

- The system exists **so that Claude can give David meaningful, data-backed
  insight into how effective the review process is, and data points to
  optimize it.** David never opens GitHub to read rows; the insight must be
  brought to him.
- Keep the measurement layer that has produced the real findings so far —
  mechanical counts on every loop, cause classification, self-inflicted
  share — at a fraction of today's cost.
- Recording a loop must be **idempotent and collision-free**: multiple
  sessions closing loops concurrently must never conflict, duplicate, or
  block one another.
- The engineering of storage, ceremony, and conflict rules is Claude's call,
  not David's ("You need to engineer it appropriately").

## Must Not Change

- **Counted, never recalled.** Mechanical figures (rounds, findings, hours,
  sizes) are script-derived only — `loop-metrics.mjs` remains their sole
  source. Recalled numbers were wrong 3/3 times; counted ones have all held.
- **The obligation stays shared and cross-agent** (Claude *and* Codex append;
  the normative contract stays in `docs/ai-context/working-modes.md`), and
  the `--mcp-snapshot` path remains supported for agents without a direct
  GitHub token.
- **History is preserved.** Every existing row, exemption, note, and the
  analysis prose survive verbatim — nothing is re-derived, reworded, or
  dropped. Recorded data remains append-only: a recorded loop never loses
  data, and no stored value is ever mutated in place.
- **The adjudication rubric** (the five causes, their precedence rules, the
  exact finding-by-finding disagreement definition, "ambiguous defaults to
  self-inflicted", and the **strictly-greater-than-20%** `unmeasured` gate
  for adjudicated loops) is unchanged. Only *when* blind adjudication runs
  changes.
- Branch protection on `main`, the PR-required flow, and the guard.sh /
  ruleset constraints are untouched.
- Plan approval remains explicit-only; nothing here is implemented before
  David approves.

## Settled Decisions

1. **One file per loop, keyed by PR number** —
   `.agents/metrics/loops/<pr>.json`. Different loops → different paths →
   git-mergeable with zero conflicts, always.
2. **Idempotent writes with deterministic reconciliation.**
   `loop-metrics.mjs --write` refuses to overwrite an existing record
   (working tree or `origin/main`) and exits 0 with "already recorded". For
   the genuinely simultaneous case — two sessions both starting before
   either lands — `--reconcile` merges the two copies by rule rather than
   by hand (decision 9).
3. **The `[LEDGER]` PR type is retired** (supersedes David's 2026-08-02
   dedicated-PR decision, which existed to solve problems — review noise,
   held-hostage rows — that per-file storage dissolves). A metrics file may
   ride **any** PR, or a small standalone PR when nothing is in flight.
4. **Recursion is terminated structurally, not by title.** A PR whose merged
   file list touches **only** `.agents/metrics/loops/*.json` is a
   *recorder-only* PR and owes no record of its own. This replaces the
   `[LEDGER]` title exclusion with the same structural guarantee, minus the
   prefix: it is computed from the PR's own file list, so it cannot be
   borrowed by substantive work, and clearing the last overdue loop provably
   creates no new debt.
5. **Blind adjudication becomes a deterministic calibration sample**: run it
   iff `pr % 5 === 0` **or** `findings >= 30`. Other loops record the author
   classification with adjudication status `never-run`. A loop that *meets*
   the predicate and skips adjudication is a hard CI failure unless the skip
   carries a recorded David authorization (decision 10).
6. **The digest is the product.** `scripts/loop-report.mjs` renders the
   standing questions; `/maintenance` gains a narration section so David
   hears the answers in plain language on his existing weekly ritual, and it
   can be run on demand.
7. **`loop-ledger.md` is frozen as the historical record**, with one final
   header edit; the guard fails any later PR that modifies it. Ordinals
   freeze as historical labels (existing prose that says "row 17" keeps
   resolving); new records are referenced by PR number only.
8. **The guard shrinks** to schema + arithmetic + append-only (rename-aware)
   + coverage warning + audit (`scripts/check-loop-metrics.mjs`, replacing
   `check-ledger-coverage.mjs`). Carrier logic, open-PR content inspection,
   and permanence-via-API delete with the design that required them.
9. **Nothing is ever overwritten — corrections and dissent are appended.**
   Stored values are immutable; a correction appends a `corrections[]` entry
   carrying the new value, the previous value, a reason, and an
   authorization, and readers apply corrections as an overlay. A losing
   concurrent classification is appended as a `dissent` entry rather than
   discarded — the ledger's own disclose-don't-silently-pick convention
   (rows 12 and 27 already do exactly this) made a rule.
10. **A deferral is an authorized, visible state — not a free-text escape
    hatch.** `judgmentDeferred` / `adjudicationDeferred` each require
    `authorizedBy: "david"`, a date, and a reason (the row-6/#279 precedent
    was exactly such a David decision). An unauthorized deferral fails the
    guard, and every deferred loop is re-listed in each digest's data-health
    section, so a deferral cannot quietly become permanent.
11. **The cutover PR reconciles open `[LEDGER]` PRs #327 and #335** (union of
    #318, #319, #322, #323, #324, #325), then closes both unmerged with an
    explanatory comment. Their branches persist (deletion is blocked in this
    environment, which is expected).

## Repo Context Inspected

- `.agents/metrics/loop-ledger.md` (all 576 lines: header contract, Rows
  table and every column, deferral/provenance/cohort-leak notes, the "what
  the adjudicated rows now show" analysis, exemptions table).
- `scripts/check-ledger-coverage.mjs` (all ~970 lines), including
  `parseLedger`'s actual return shape, and
  `scripts/__tests__/check-ledger-coverage.test.mjs`.
- `scripts/loop-metrics.mjs` — `derive()`'s exact return object (confirmed:
  it returns top-level `pr`, `title`, `cohort`, `size`, `rounds`,
  `findings`, `per_round`, `review_interval`, `adjudication_sample`,
  `warnings`, a coarse `state`, **and** a `judgment` block of nulls; it does
  **not** retain `closed_at`/`merged_at`), plus the `--mcp-snapshot` adapter.
- `.github/workflows/build.yml` — confirmed **no `fetch-depth` is set on any
  of the five `actions/checkout@v4` steps**, so the Build job runs a shallow
  checkout today.
- `docs/ai-context/working-modes.md` → "The loop ledger" — confirmed the gate
  is worded "Above **20% disagreement**" / ">20% gate" (strictly greater).
- `CLAUDE.md` → the ledger section, the `[LEDGER]` squash-merge
  authorization, the blind-adjudication subagent exception.
- `.claude/skills/maintenance/SKILL.md` (the existing "what shipped" digest
  section this plan extends).
- Live PR state: open PRs #327 and #335 (both branches fetched and their
  Rows-table tails diffed, confirming the ordinal collision, the duplicated
  #322 row, and #335's missing #319).

## Current Behavior

- One markdown table; every row hand-appended with a hand-assigned ordinal.
- Rows ship exclusively via `[LEDGER]`-titled PRs whose CI gate requires the
  diff to touch only the ledger file **and** to carry a row for *every* loop
  closed before the PR opened — so concurrent carriers are forced into
  textual and semantic collision.
- `check-ledger-coverage.mjs` enforces arithmetic, structural (stray files,
  renames, empty diffs), permanence vs. live `main`, coverage, and a
  push-to-main audit with carrier/backstop triggers.
- Every row's judgment half is dual-classified and discarded to `unmeasured`
  on >20% disagreement.
- Insight exists only as prose inside the ledger file; no delivery mechanism
  to David exists.

## Source-of-Truth Analysis

- **Today:** the ledger *file* is the sole source of truth; `loop-metrics.mjs`
  output is transcribed into it; the analysis prose duplicates row data in
  narrative form (a second, drift-prone copy).
- **After:** `.agents/metrics/loops/*.json` is the **single** source of truth
  for all per-loop data. `loop-ledger.md` becomes a frozen historical
  document, explicitly not consulted by any script after migration (the
  migration itself is the one-time read). `loop-report.mjs` output is a
  derived view, regenerated on demand and never stored as truth.
- **Within a record, each concept has exactly one home** (this is why
  `derive()`'s output is not stored verbatim — see design §1): identity lives
  only in the top-level `pr`, judgment lives only in the top-level
  `judgment`, and the `mechanical` block carries neither.
- The five-cause rubric's source of truth stays `working-modes.md` (shared,
  cross-agent), unchanged.

## Proposed Design

### 1. The store: `.agents/metrics/loops/<pr>.json`

```json
{
  "schemaVersion": 1,
  "pr": 322,
  "closedAt": "2026-08-05T11:02:44Z",
  "mergedAt": "2026-08-05T11:02:44Z",
  "mechanical": {
    "source": "derived",
    "title": "…", "cohort": "feature/code", "size": { "files": 5, "additions": 120, "deletions": 8 },
    "rounds": 3, "findings": 7,
    "perRound": [ { "round": 1, "findings": 4 }, { "round": 2, "findings": 3 }, { "round": 3, "findings": 0 } ],
    "perRoundSource": "derived",
    "reviewInterval": { "…": "…" },
    "warnings": []
  },
  "judgment": {
    "causes": { "new": 5, "prop": 1, "wrong": 1, "reRaised": 0, "invalid": 0 },
    "selfInflicted": "28.6%",
    "preOpenPreflightMin": 12,
    "breakersFired": "none"
  },
  "adjudication": { "status": "never-run" },
  "notes": "free text — the old row-note register, one loop's worth",
  "dissent": [],
  "corrections": []
}
```

**Identity and judgment appear exactly once.** `derive()`'s output is *not*
stored verbatim: a `mechanicalProjection()` helper strips its top-level `pr`
and its null `judgment` block and renames to the record's camelCase keys. A
schema test rejects any `mechanical` object containing `pr` or `judgment`, so
the duplicate-representation failure cannot reappear.

**Closure timestamps are first-class.** `derive()` gains `closedAt` /
`mergedAt` (mechanically sourced from the PR object, alongside the existing
coarse `state`), because the digest's windowing must work for zero-review
loops and for loops whose reviews post after merge — neither of which
`reviewInterval` can express (it is null when there are no reviews).

**Adjudication is a three-state field, never a boolean:**

- `{ "status": "never-run" }` — nobody adjudicated this loop. The historical
  default and the default for unsampled new loops.
- `{ "status": "completed", "population": N, "disagreements": n,
  "disagreementPct": x, "verdict": "measured" | "unmeasured" }` — the gate
  applies at **strictly greater than 20%**.
- `{ "status": "deferred", "reason": "…", "authorizedBy": "david",
  "date": "…" }`.

Conflating `never-run` with `completed`/`unmeasured` would rewrite "not
checked" into "checked but inconclusive" and make the digest report false
calibration failures for seven historical loops (#268, #269, #297, #318,
#319, #323, #324) that never ran adjudication at all, versus #290 which ran
it and tripped the gate at 25%.

A `judgment` may be `null` alongside an authorized `judgmentDeferred` block
(the row-6/#279 precedent, now a first-class state). An exemption is the same
file with `{ "pr": N, "exempt": "<reason>" }`.

### 2. The writer: `loop-metrics.mjs --write` / `--reconcile` / `--correct`

- `--pr N --write` (composing with `--mcp-snapshot`) derives mechanical data
  and writes `loops/<N>.json` with a `judgment: null` scaffold. Filename and
  embedded `pr` are written together, so they cannot disagree at creation.
- **Idempotency:** if the record exists in the working tree or on
  `origin/main`, print "already recorded" and exit 0.
- **`--reconcile <pr>`** handles the simultaneous case deterministically, so
  a same-loop collision is never hand-resolved: `mechanical` blocks must be
  equal (both derive from the same source); if they differ, `main`'s copy is
  kept and the difference is recorded in `corrections[]` with both values.
  For `judgment`, the **earlier-committed classification wins** and the other
  is appended to `dissent[]` with its author and commit — never discarded.
  `notes` are concatenated in commit order.
- **`--correct <pr> --field <path> --value <v> --reason <r>`** replaces the
  earlier `--force`: it appends a `corrections[]` entry
  (`{ field, previousValue, newValue, reason, authorizedBy, date }`) instead
  of mutating anything. Readers apply `corrections[]` as an overlay, so the
  literal append-only rule and the ability to fix a wrong number coexist —
  and the guard can machine-check the correction rather than having to
  choose between blocking it and trusting it.

### 3. Ceremony: recording a loop

1. `node scripts/loop-metrics.mjs --pr <N> --write` (or `--mcp-snapshot`).
2. Fill `judgment` (author classification; ambiguous → self-inflicted).
3. If `pr % 5 === 0` or `mechanical.findings >= 30`: run the blind
   adjudication subagent and record the result. Otherwise `never-run`.
4. Commit the file on **any** open PR of yours, or a small recorder-only PR.

### 4. The guard: `scripts/check-loop-metrics.mjs`

**Offline (every run, no token):** every `loops/*.json` parses and matches the
schema; filename equals the `pr` field; `mechanical` contains no `pr` or
`judgment` key; the five causes sum exactly to `mechanical.findings` when
both are measured; a loop meeting the sampling predicate carries an
adjudication result or an **authorized** deferral; any deferral carries
`authorizedBy` + date + reason.

**Diff checks (PR runs).** The workflow's Build job gains **`fetch-depth: 0`**
on its checkout — confirmed absent today, and `git diff origin/main...HEAD`
is not reliable in a shallow checkout. The guard **fails loudly** if the base
ref is unresolvable rather than skipping the check (the same
"a guard that can silently no-op is worse than none" principle the current
guard states).

- **Append-only, rename-aware.** The diff is read with
  `git diff --name-status -M`, and **both sides of every rename are
  evaluated**: a record renamed *out* of `loops/`, or *onto* another loop's
  number, is treated as a deletion of the source record and fails — a
  status-`D`-only check would miss exactly that, and filename/schema
  validation of the surviving files cannot see the vanished source path.
- A landed record may only change by filling a previously-`null` `judgment`,
  appending to `notes`, or appending a `dissent[]` / `corrections[]` entry.
  `mechanical` is immutable.
- Any change to `.agents/metrics/loop-ledger.md` fails (post-cutover).

**Coverage (token + PR context):** closed loops (floor `FIRST_ENFORCED_PR =
270`, Dependabot excluded, **recorder-only PRs excluded** per decision 4)
missing a record print a **warning**, never a failure.

**Audit (push to `main`):** a closed loop with no record after
`OVERDUE_BACKSTOP_MERGES = 2` subsequent merges **fails**. No carrier logic,
no open-PR content inspection, no deferral rules — a red audit on `main` is
the alarm, and the fix is a one-file recorder-only PR that itself owes
nothing.

Estimated size: ~250 lines + tests, replacing ~970 + tests.

### 5. The digest: `scripts/loop-report.mjs` + `/maintenance`

Reads `loops/*.json` (applying `corrections[]` overlays) and emits a markdown
digest:

- **Volume/cost** — loops closed in the window (`--since`, default 14 days,
  keyed on the stored `closedAt`), rounds, findings, review hours, totals.
- **Churn** — self-inflicted share per *qualifying* loop, plus the wrong-fix
  vs. propagation split. Qualifying means **more than one finding-bearing
  round**, computed from `mechanical.perRound` — the structural-floor rule
  from the ledger's analysis, now encoded instead of narrated.
- **Trend** — the qualifying-loop sequence over time, always labeled with n,
  never smoothed into a fake trend line.
- **Outliers** — the most expensive loops in the window and their shapes.
- **Data health** — unmeasured/`never-run`/deferred counts, **missing
  records**, and any sampled loop that tripped the >20% gate.

**Completeness needs an inventory, not just a directory.** An absent record
leaves no artifact in `loops/`, so the report takes the same paginated
closed-PR inventory the guard uses (token, or a snapshot file) to name
missing loops. **Without a token it prints "inventory unavailable —
completeness not checked"** rather than presenting the directory as complete.

`/maintenance` gains a section: run the report, then narrate it to David in
plain language (a few sentences, not raw tables), flagging anything
actionable. The script computes; the narration interprets; David decides.

### 6. Cohort classification fix (scoped, mechanical)

`classifyCohort` is reordered: `plan-review` → `bugfix` (the PR body's
`**Fix tier:**` field) → **code-majority** (changed lines in non-docs files
exceed docs lines → `feature/code`) → `prose/contract`. Historical records
keep their stored cohort (mechanical data is immutable); the digest labels
the boundary date and never pools across it silently.

### 7. Migration and cutover (one PR)

**A dedicated, exhaustive parser — not `parseLedger`.** The existing
`parseLedger` returns only PR number, findings, the five causes, and
exemption reasons; it discards the ordinal, cohort, sizes, rounds,
self-inflicted value, review hours, preflight, breakers, adjudication text,
and row notes. Reusing it could not satisfy verbatim parity once the frozen
ledger is no longer read by anything. So `scripts/migrate-loop-ledger.mjs`
ships its own **exhaustive** cell parser, and every migrated record carries:

```json
"legacy": { "ledgerRow": 24, "rawCells": { "<column>": "<cell text>", "…": "…" } }
```

— the complete original row, cell for cell, as written. That raw block is the
lossless backstop: even a mapping bug cannot destroy information, and the
reverse migration can rebuild the table from it.

**Acceptance is round-trip parity over every cell**, not PR presence and
twelve percentages: every row and exemption in the frozen ledger must produce
exactly one record, every cell must survive verbatim in `legacy.rawCells`,
every mapped field must equal its source cell, and re-rendering the table
from the store must reproduce the original file byte-for-byte modulo the
frozen header. **Any parse or parity failure aborts the migration** — there
is no partial cutover, and the PR does not open until parity passes.

**The one dimension the ledger cannot supply is `perRound`.** The old table
stores only aggregate `rounds`, which cannot distinguish a clean re-review
from a second finding-bearing round — so migrated records could not support
the report's qualifying filter, and using aggregate rounds would wrongly
include known cases such as #286. Resolution, without fabricating anything:
the migration **re-derives `perRound` from the GitHub API** for each
historical PR and stores it with `"perRoundSource": "re-derived-at-migration"`.
Re-deriving mechanical data from its original source is not a rewrite of
recorded judgment; and where the re-derived `rounds` disagrees with the
ledger's stored value, **the ledger's value is kept** in `mechanical.rounds`
and the discrepancy is recorded in `corrections[]` — never silently
overwritten. A loop that cannot be re-derived gets `perRound: null`, and the
report **excludes it from the qualifying filter by name, printing why**,
rather than guessing.

Cutover steps:

1. Run the migration; parity check must pass.
2. Convert the union of #327's and #335's rows (#318, #319, #322–#325),
   re-deriving mechanical data where the two branches disagree and recording
   the discrepancy.
3. Sweep any other pre-cutover closed loop with no row anywhere, so the first
   post-merge audit is green.
4. Freeze `loop-ledger.md`; add `fetch-depth: 0`; replace the guard; rewire
   `build.yml`.
5. Rewrite `working-modes.md` → "The loop ledger" (new ceremony; rubric and
   snapshot-completeness rules kept verbatim) and `CLAUDE.md`'s ledger
   section (the `[LEDGER]` squash-merge authorization retires with the PR
   type; the blind-adjudication subagent exception now applies to sampled
   loops).
6. Close #327 and #335 unmerged with comments linking the cutover PR.

## Data Model and Migration Impact

No database or product schema changes — this is a repo-file store.

| Old state | New record state |
|---|---|
| Measured + adjudicated row | `judgment` complete; `adjudication.status: "completed"` + verdict `measured` |
| Adjudicated, >20% disagreement (#290, #292, #298, #291) | `adjudication.status: "completed"`, `verdict: "unmeasured"`, with its disagreement figures |
| Adjudicated but populations mismatched (#287) | `status: "completed"`, `verdict: "unmeasured"`, reason recorded in `notes` |
| **Never adjudicated** (#268, #269, #297, #318, #319, #323, #324) | **`adjudication.status: "never-run"`** — distinct from the row above, never conflated |
| Mechanical-only deferral (rows 6/#279, 14/#280) | `judgment: null` + `judgmentDeferred` carrying David's recorded precedent authorization |
| `n/a — clean loop` (#284) | `judgment.selfInflicted: "n/a — clean loop"` |
| Exemption table entry | `{ "exempt": "<reason>" }` |
| Any row that fails to parse or fails parity | **hard failure — migration aborts, no partial cutover** |

Every case above additionally carries `legacy.rawCells` (the verbatim row).

**Rollback.** A plain `git revert` restores the old system only while no new
record has landed; after that, reverting would strand post-cutover loops
(absent from the restored ledger, invisible to the restored guard). So the
cutover PR ships `migrate-loop-ledger.mjs --reverse`, which renders every
record — including post-cutover ones — back into ledger rows using
`legacy.rawCells` for migrated loops and the mapping for new ones. Rollback =
revert + run `--reverse`, and it is tested with at least one post-cutover
record present.

## Runtime Behavior

- Two sessions recording **different** loops concurrently: two PRs adding two
  different files — no conflict, no ordering, no shared state.
- Two sessions recording the **same** loop, sequentially: the second
  `--write` no-ops ("already recorded").
- Two sessions recording the same loop **simultaneously** (both started
  before either landed): git reports an add/add conflict on one path;
  `--reconcile` resolves it by rule — mechanical asserted equal, earlier
  judgment wins, the later one preserved in `dissent[]`, notes concatenated.
  No hand-resolution, no silent data loss.
- A loop closes and nobody records it: PR warnings name it; after 2 merges
  the `main` audit goes red until a recorder-only PR lands — which owes
  nothing itself, so the debt terminates.
- A sampled loop trips the gate: `verdict: "unmeasured"`, surfaced in the
  next digest as a calibration flag; no CI failure.
- A loop needs a correction: `--correct` appends; the guard accepts the
  appended entry and still rejects in-place mutation.
- Edge: a Codex-run loop with only MCP access — same flow via
  `--mcp-snapshot`.

## Admin/User UX Impact

None in the product — no app surface changes. The "UX" here is David's: the
digest arrives through `/maintenance` and on demand, in chat, in plain
language. (No async product surface is involved, so `async-ui-status.md`
doesn't apply.)

## Security, Permissions, and Validation

- No new credentials; the guard's coverage half uses the same
  `pull-requests: read` token `build.yml` already grants, and makes *fewer*
  API calls (no per-candidate file fetches). `fetch-depth: 0` changes clone
  size, not permissions.
- Public-repo disclosure: loop metrics and process notes are already public
  in the current ledger; the store adds no new class of information.
- Validation: schema enforced in CI; malformed values fail loudly (the
  `countCell`-throws principle carries over — no silent coercion to
  "unmeasured").

## Testing Plan

Runner: `node --test scripts/__tests__/<file>` (the existing dependency-free
pattern, wired into `build.yml` beside the current script tests).

- `check-loop-metrics.test.mjs`: schema validation; filename↔`pr` mismatch;
  `mechanical` containing `pr` or `judgment` (must fail); arithmetic
  pass/fail/deferred/exempt; sampling predicate boundaries (`pr % 5`,
  `findings` 29 vs 30); sampled-loop-without-adjudication failure;
  **unauthorized deferral failure** and authorized-deferral pass;
  append-only diff logic — delete, mechanical mutation, legal judgment fill,
  legal `corrections[]`/`dissent[]` append; **rename fixtures: rename-out of
  `loops/`, rename-into `loops/`, and rename onto another PR number, all
  failing**; frozen-ledger touch; unresolvable base ref must fail loudly, not
  skip; coverage warning vs. audit overdue, with open PRs, Dependabot, and
  **recorder-only PRs correctly excluded**; and a test proving that clearing
  the final overdue loop leaves **no new debt**.
- `loop-metrics.test.mjs` additions: `mechanicalProjection` strips `pr` and
  `judgment`; `closedAt`/`mergedAt` derivation including a zero-review loop;
  `--write` idempotency; `--reconcile` two-branch convergence (differing
  judgment and notes → deterministic single record, dissent preserved, no
  manual conflict); `--correct` appends without mutating; cohort reordering
  (bugfix-tier PR with docs → `bugfix`; code-majority with docs →
  `feature/code`; docs-only → `prose/contract`; the historical leak case as a
  regression test).
- `migrate-loop-ledger.test.mjs`: **every-cell round-trip parity** on a
  fixture ledger covering every row-state in the matrix, including
  `legacy.rawCells` completeness and byte-for-byte table re-render;
  never-run vs. completed/unmeasured are not conflated; `perRound`
  re-derivation with a deliberate rounds disagreement (ledger value kept,
  discrepancy recorded); un-re-derivable loop → `perRound: null`;
  re-run idempotency; hard abort on an unparseable row; **`--reverse` after
  at least one post-cutover record exists**.
- `loop-report.test.mjs`: qualifying filter uses `perRound` (a
  two-engagement/one-finding-bearing-round loop like #286 is excluded;
  #308's two finding-bearing rounds qualify; `perRound: null` is excluded
  **by name**); `closedAt` window boundaries for zero-review and
  post-merge-review loops; missing-record naming from a fixture inventory;
  **no-token path prints "completeness not checked"**; `>20%` boundary
  (exactly 20% is measured; the smallest fraction above is not); unmeasured
  excluded from trend; corrections overlay applied; empty-store behavior.
- Manual QA: run the real migration and diff the parity report; run
  `loop-report.mjs` on the migrated store and check its output against the
  frozen analysis section's twelve named percentages.

## Implementation Steps

1. `mechanicalProjection`, `closedAt`/`mergedAt`, `--write`, `--reconcile`,
   `--correct`, cohort reorder, in `loop-metrics.mjs`. Tests.
2. `check-loop-metrics.mjs` + tests, and `fetch-depth: 0` in `build.yml` (the
   guard exists before any records do, so the store is never unvalidated).
3. `migrate-loop-ledger.mjs` (+ `--reverse`) + tests; run it; commit the
   store, including the #327/#335 union and the pre-cutover sweep.
4. `loop-report.mjs` + tests.
5. Freeze `loop-ledger.md`; rewire `build.yml`; delete
   `check-ledger-coverage.mjs` + its tests.
6. Contract rewrites: `working-modes.md`, `CLAUDE.md`, `/maintenance`.
7. Open the implementation PR (oracle from this plan), drive review, merge;
   then close #327/#335 with comments.

Steps 1–6 are one implementation PR — a store without its guard, or a guard
without the migration, is not a shippable intermediate state.

## Risks and Mitigations

- **Migration alters or loses historical data** — the highest-severity
  failure available to this plan. Mitigations: an exhaustive cell parser
  (not `parseLedger`), `legacy.rawCells` as a lossless backstop,
  every-cell round-trip parity with byte-for-byte table re-render, hard
  abort on any failure, and manual QA against the twelve named percentages.
- **The obligation decays without the hard carrier gate.** Mitigations: PR
  warning + 2-merge audit backstop retained; the cost of paying a debt drops
  from "open a dedicated PR carrying everything owed" to "add one file to any
  PR", attacking the actual cause of past misses; deferrals require David's
  authorization and are re-listed in every digest.
- **Sampling misses a drifting classifier between samples.** Accepted
  deliberately (option 1): 1-in-5 plus all large loops keeps a recurring
  calibration signal; trips surface in the digest; David can order full
  adjudication of any loop at any time.
- **This plan's own loop repeats the mid-loop-construction pathology** (the
  #270/#304 pattern). Mitigations: the machinery is small by design, the
  design is reviewed before any code exists, and the stopping rule applies
  (a round returning more findings than the previous one → pause and
  reassess with David).
- **Two eras of cohort labels.** Mitigation: the digest states the boundary
  date and never pools across it.

## Questions for David

None — the pre-plan conversation settled product intent (option 1), and the
remaining choices (sampling rate, backstop threshold, file format,
reconciliation semantics) are engineering calls this plan makes explicitly so
the review loop can attack them.

## Definition of Done

- [ ] Two simulated concurrent recordings of **different** loops merge with
      zero conflicts; the same loop recorded twice sequentially is a no-op;
      the simultaneous case converges via `--reconcile` with no data loss.
- [ ] Every-cell round-trip parity passes; `legacy.rawCells` present on every
      migrated record; the frozen table re-renders byte-for-byte; the twelve
      named percentages reproduce from the store.
- [ ] `never-run` and `completed/unmeasured` are distinct in the store, and
      the digest never reports a historical calibration failure for a loop
      that was never adjudicated.
- [ ] `check-loop-metrics.mjs` green on PR and `--audit` paths; rename,
      unauthorized-deferral, and recorder-only-recursion tests all pass; old
      guard deleted; `[LEDGER]` gates gone.
- [ ] `loop-report.mjs` produces the digest from the real store and names
      missing records from the inventory (or says completeness wasn't
      checked); `/maintenance` includes the narration step.
- [ ] `working-modes.md` + `CLAUDE.md` describe the new ceremony; no
      reference to appending markdown rows or `[LEDGER]` PRs survives outside
      the frozen file and historical notes.
- [ ] `--reverse` restores a working ledger with at least one post-cutover
      record included.
- [ ] #327 and #335 closed with comments; their row content present in the
      store.
- [ ] The first post-merge push-to-`main` audit is green.
