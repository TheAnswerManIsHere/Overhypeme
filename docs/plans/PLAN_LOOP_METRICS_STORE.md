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
   measures.** The guard (`check-ledger-coverage.mjs`, ~1,000 lines) exists
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
  data.
- **The adjudication rubric** (the five causes, their precedence rules, the
  exact finding-by-finding disagreement definition, "ambiguous defaults to
  self-inflicted", the ≥20% `unmeasured` gate *for adjudicated loops*) is
  unchanged. Only *when* blind adjudication runs changes.
- Branch protection on `main`, the PR-required flow, and the guard.sh /
  ruleset constraints are untouched.
- Plan approval remains explicit-only; nothing here is implemented before
  David approves.

## Settled Decisions

1. **One file per loop, keyed by PR number** —
   `.agents/metrics/loops/<pr>.json`. Different loops → different paths →
   git-mergeable with zero conflicts, always. The same loop recorded twice →
   an add/add conflict on one path: loud, unambiguous, and safe to resolve
   by taking `main`'s copy (the gates check presence and internal
   consistency, never authorship).
2. **Idempotent writes.** `loop-metrics.mjs --write` refuses to overwrite an
   existing record (locally or on `origin/main`) and exits 0 with "already
   recorded". Running the append twice for one loop is a literal no-op.
3. **The `[LEDGER]` PR type is retired** (supersedes David's 2026-08-02
   dedicated-PR decision, which existed to solve problems — review noise,
   held-hostage rows — that per-file storage dissolves). A metrics file may
   ride **any** PR, or a small standalone PR when nothing is in flight. No
   carry-everything-owed gate; concurrent recorders are naturally disjoint.
4. **Blind adjudication becomes a deterministic calibration sample** instead
   of a per-row gate: adjudicate a loop iff `pr % 5 === 0` **or**
   `findings >= 30` (large loops dominate every conclusion drawn so far).
   All other loops record the author classification, marked
   `"adjudicated": false`. The sample keeps the drift alarm that per-row
   adjudication was providing while cutting its cost ~80%; a sampled loop
   tripping the 20% gate is flagged in the digest as classification drift.
5. **The digest is the product.** A new `scripts/loop-report.mjs` renders the
   standing questions from the store; the `/maintenance` skill gains a
   "loop-efficacy digest" section so David hears the answers in plain
   language on his existing weekly ritual, and it can be run on demand.
   `loop-ledger.md`'s successor as "the readable view" is generated output,
   not a hand-maintained file.
6. **`loop-ledger.md` is frozen as the historical record.** It gets one final
   edit — a header pointing at the new store — and the new guard fails any
   later PR that modifies it. Ordinal row numbers are thereby frozen as
   historical labels (existing prose that says "row 17" keeps resolving);
   new records are referenced by PR number only.
7. **The guard shrinks to what the new design actually needs**
   (`scripts/check-loop-metrics.mjs`, replacing `check-ledger-coverage.mjs`):
   schema + arithmetic validation, filename/`pr`-field agreement, append-only
   enforcement via `git diff` against `origin/main` (no API calls needed for
   the offline half), a coverage *warning* on PRs, and a simplified overdue
   *failure* on the push-to-`main` audit. Carrier logic, open-PR content
   inspection, stray-file/rename gates, and permanence-via-API all delete
   with the design that required them.
8. **The cutover PR reconciles open `[LEDGER]` PRs #327 and #335**: the union
   of their rows (#318, #319, #322, #323, #324, #325) is converted into the
   new store — re-deriving mechanical columns where the two branches
   disagree — and both PRs are then closed unmerged with an explanatory
   comment. Their branches persist (deletion is blocked in this
   environment, which is expected).

## Repo Context Inspected

- `.agents/metrics/loop-ledger.md` (all 576 lines: header contract, Rows
  table, deferral/provenance/cohort-leak notes, the "what the adjudicated
  rows now show" analysis, exemptions table).
- `scripts/check-ledger-coverage.mjs` (all ~970 lines), and its test file's
  existence (`scripts/__tests__/check-ledger-coverage.test.mjs`).
- `scripts/loop-metrics.mjs` (derivation model: reviewer passes, rounds,
  findings-by-round, cohort classification, `--mcp-snapshot` adapter,
  `derive()`'s JSON output, fixture/save-fixture modes).
- `.github/workflows/build.yml` (the two guard steps: PR-context coverage,
  push-to-main `--audit`; script-test steps; least-privilege permissions
  comment).
- `docs/ai-context/working-modes.md` → "The loop ledger" (the shared
  obligation, snapshot completeness rules, the adjudication rubric, the
  clean-re-review counting caveats).
- `CLAUDE.md` → "I append to the loop ledger when a loop closes", the
  `[LEDGER]` squash-merge authorization, the subagent-delegation exception
  for blind adjudication.
- `.claude/skills/maintenance/SKILL.md` (the existing "what shipped" digest
  section this plan extends).
- `docs/ai-context/workstream-tracking.md` (State of Play / labels — for the
  review ceremony itself, not the design).
- Live PR state: open PRs #327 and #335 (fetched both branches; diffed their
  Rows-table tails to confirm the ordinal collision, the duplicated #322
  row, and #335's missing #319).

## Current Behavior

- One markdown table; every row hand-appended with a hand-assigned ordinal.
- Rows ship exclusively via `[LEDGER]`-titled PRs whose CI gate requires the
  diff to touch only the ledger file **and** to carry a row for *every* loop
  closed before the PR opened — so concurrent carriers are forced into
  textual and semantic collision.
- `check-ledger-coverage.mjs` enforces: arithmetic, structural (stray files,
  renames, empty diffs), permanence vs. live `main`, coverage (owed rows),
  and a push-to-main audit with carrier/backstop triggers, open-carrier
  content inspection at `merge_commit_sha`, draft/base/staleness rules.
- Every row's judgment half is dual-classified (author + blind subagent) and
  discarded to `unmeasured` on >20% disagreement.
- Insight exists only as prose inside the ledger file; no delivery mechanism
  to David exists.

## Source-of-Truth Analysis

- **Today:** the ledger *file* is the sole source of truth for loop metrics;
  `loop-metrics.mjs` output is transcribed into it; the analysis prose
  duplicates row data in narrative form (a second, drift-prone copy).
- **After:** `.agents/metrics/loops/*.json` is the **single** source of truth
  for all per-loop data (mechanical + judgment + notes). `loop-ledger.md`
  becomes a frozen historical document — explicitly *not* consulted by any
  script after migration (the migration itself is the one-time read).
  `loop-report.mjs` output is a derived view, never stored as truth (it is
  regenerated on demand; committing it anywhere is out of scope).
  No new duplicate source is created: the digest cites, never re-states,
  stored values.
- The five-cause rubric's source of truth stays `working-modes.md` (shared,
  cross-agent), unchanged.

## Proposed Design

### 1. The store: `.agents/metrics/loops/<pr>.json`

One JSON file per closed loop, `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "pr": 322,
  "mechanical": { "...": "verbatim derive() output from loop-metrics.mjs" },
  "judgment": {
    "causes": { "new": 3, "prop": 1, "wrong": 0, "reRaised": 0, "invalid": 0 },
    "selfInflicted": "25.0%",
    "preOpenPreflightMin": 12,
    "breakersFired": "none",
    "adjudication": { "sampled": false }
  },
  "notes": "free text — the old row-note register, one loop's worth"
}
```

- `mechanical` is `derive()`'s JSON verbatim — no transcription step, so the
  copy-into-markdown error class disappears.
- A sampled loop's `adjudication` records `{ "sampled": true, "population": N,
  "disagreements": n, "disagreementPct": x, "verdict": "measured" |
  "unmeasured" }` — same rubric, same gate, same exact-pairing rule as today.
- Judgment may be `null` with a `"judgmentDeferred": "<reason>"` sibling
  (the row-6/#279 precedent, preserved as a first-class state).
- An exemption is the same file with `{ "pr": N, "exempt": "<reason>" }` —
  presence of the file is what satisfies coverage, uniformly.

### 2. The writer: `loop-metrics.mjs --write`

- `--pr N --write` (also composing with `--mcp-snapshot`) derives mechanical
  data and writes `loops/<N>.json` with a `judgment: null` scaffold for the
  closing session to fill before committing.
- **Idempotency:** if the file exists in the working tree or on
  `origin/main`, print "already recorded" and exit 0. `--force` exists for a
  deliberate, David-sanctioned correction and is the only overwrite path.
- Filename and embedded `pr` field are written together, so they cannot
  disagree at creation.

### 3. Ceremony: recording a loop

At loop close (both agents, per the updated `working-modes.md`):

1. `node scripts/loop-metrics.mjs --pr <N> --write` (or `--mcp-snapshot`).
2. Fill `judgment` (author classification; ambiguous → self-inflicted, as
   today).
3. If `pr % 5 === 0` or `mechanical.findings >= 30`: run the blind
   adjudication subagent, record its result. Otherwise mark
   `"sampled": false` and stop.
4. Commit the file **on any open PR of yours, or a small standalone PR** —
   no dedicated PR type, no title prefix, no batching requirement.

### 4. The guard: `scripts/check-loop-metrics.mjs`

Offline checks (every run, no token):

- Every `loops/*.json` parses, matches the schema, and its filename equals
  its `pr` field.
- Arithmetic: when `judgment.causes` is present and findings are measured,
  the five causes sum exactly to `mechanical.findings` (today's rule,
  unchanged).
- Sampling honesty: a loop meeting the sample predicate must carry an
  adjudication result or an explicit `"adjudicationDeferred": "<reason>"` —
  a silent skip of a sampled loop is a hard failure.

Diff checks (PR runs; via `git diff origin/main...HEAD`, no API):

- **Append-only:** deleting a `loops/*.json` fails; modifying one is allowed
  only where it fills previously-`null` judgment or appends to `notes` —
  `mechanical` is immutable once landed.
- **Frozen history:** any change to `.agents/metrics/loop-ledger.md` fails
  (post-cutover).

Coverage (token + PR context, as today's wiring provides):

- On PR runs: closed loops (same `FIRST_ENFORCED_PR = 270` floor, same
  Dependabot exclusion) missing a store file print a **warning**, never a
  failure — any PR can pay the debt, so no PR is hostage to it.
- On push-to-`main` `--audit`: a closed loop with no file after
  `OVERDUE_BACKSTOP_MERGES = 2` subsequent merges to `main` **fails**. No
  carrier logic, no open-PR content inspection, no deferral rules — if the
  audit is red, the fix is a one-file PR, and the red audit on `main` (not
  on anyone's PR) is the alarm. The `[LEDGER]`-author policy exclusion
  reduces to: nothing — there is no excluded PR type left; every closed
  loop by a non-Dependabot author owes exactly one file.

Estimated size: ~200 lines + tests, replacing ~970 + tests.

### 5. The digest: `scripts/loop-report.mjs` + `/maintenance`

`loop-report.mjs` reads `loops/*.json` and emits a markdown digest answering
the standing questions:

- **Volume/cost:** loops closed in the window (`--since <date>`, default 14
  days), with rounds, findings, review hours, and totals.
- **Churn:** self-inflicted share per qualifying loop (>1 finding-bearing
  round — the structural-floor rule from the ledger's analysis, now encoded
  in the script instead of prose), plus the wrong-fix vs. propagation split.
- **Trend:** the qualifying-loop share sequence over time, explicitly labeled
  with n, never smoothed into a fake trend line.
- **Outliers:** the most expensive loops in the window and their shapes.
- **Data health:** unmeasured/deferred counts, missing files, and — the
  calibration alarm — any sampled loop whose adjudication tripped the 20%
  gate.

`/maintenance` gains a section: run `loop-report.mjs`, then narrate the
digest to David in plain language (a few sentences, not the raw tables),
flagging anything actionable. The script computes; the narration interprets;
David decides. The digest can also be requested any time ("how's the review
process doing?").

### 6. Cohort classification fix (scoped, mechanical)

The digest's "which loop shapes are expensive" comparison is exactly what the
known `.md`-leak breaks (five different PR shapes currently share the
`prose/contract` label). `classifyCohort` in `loop-metrics.mjs` is reordered:
`plan-review` (branch/title) → `bugfix` (the PR body's `**Fix tier:**` field,
already the primary key today) → **code-majority** (changed lines in
non-`.md`/non-docs files exceed docs lines → `feature/code`) →
`prose/contract`. Historical files keep their stored cohort untouched
(mechanical data is immutable); the fix applies to new records, and the
digest labels the boundary date so cross-era cohort comparisons are honest.

### 7. Migration and cutover (one PR)

1. `scripts/migrate-loop-ledger.mjs` (kept in-repo for auditability, run
   once): parses the frozen ledger's Rows + exemptions tables — reusing
   today's `parseLedger` logic — into `loops/*.json`. Row notes → `notes`;
   `unmeasured`/deferred/`n/a — clean loop` states map to explicit fields;
   nothing is re-derived or re-judged. A parity check asserts: every row and
   exemption PR number in the old file has exactly one file, and every
   migrated cell value survives verbatim.
2. Convert the union of #327's and #335's rows (#318, #319, #322–#325).
   Where the two branches' copies of #322's row disagree, mechanical columns
   are re-derived by script and the richer judgment/notes kept (with the
   discrepancy noted in `notes`).
3. Sweep: derive + classify records for any other loop closed before
   cutover that has no row anywhere (so the first post-merge audit is green).
4. Freeze `loop-ledger.md` (header edit), replace the guard, rewire
   `build.yml` (the old guard's PR-touch-ledger failure doesn't bite: CI
   runs the *PR's own* checkout, which carries the new guard).
5. Rewrite `working-modes.md` → "The loop ledger" section (new ceremony;
   rubric and snapshot-completeness rules kept verbatim) and `CLAUDE.md`'s
   ledger section (the `[LEDGER]` squash-merge authorization is retired with
   the PR type; the blind-adjudication subagent exception now applies to
   sampled loops).
6. Close #327 and #335 unmerged with comments linking the cutover PR.

## Data Model and Migration Impact

No database or product schema changes — this is a repo-file store. The
migration's row-state matrix (old ledger row → new file):

| Old state | New file state |
|---|---|
| Fully measured + adjudicated row | `judgment` complete, `adjudication.sampled: true`, `verdict: "measured"` |
| Adjudicated, >20% disagreement (`unmeasured`) | same, `verdict: "unmeasured"` — still excluded from trend by the report |
| Author-classified, never adjudicated (#290-style) | `judgment` complete, `adjudication: { "sampled": true, "verdict": "unmeasured" }` + note (historical rows were all nominally full-population) |
| Mechanical-only deferral (rows 6, 14) | `judgment: null`, `judgmentDeferred` |
| `n/a — clean loop` (#284) | `judgment.selfInflicted: "n/a — clean loop"` |
| Exemption table entry | `{ "exempt": "<reason>" }` |
| Failed/partial migration parse | **hard failure of the migration script** — no partial cutover; the PR doesn't open until parity passes |

Idempotency: the migration script is re-runnable (skips existing files);
rollback is `git revert` of the cutover PR (the frozen ledger is untouched
except its header, so reverting restores the old system intact).

## Runtime Behavior

- Two sessions closing different loops concurrently: two PRs adding two
  different files — no conflict, no ordering, no shared state.
- Two sessions recording the *same* loop: the second writer's `--write`
  no-ops if the first has landed; if truly simultaneous, git add/add conflict
  on one path, resolved take-`main`s (or either — content derives from the
  same script over the same PR).
- A loop closes and nobody records it: PR warnings name it; after 2
  subsequent merges the `main` audit goes red until a one-file PR lands.
- A sampled loop's adjudication trips the gate: recorded as `unmeasured`,
  surfaced in the next digest as a calibration flag; no CI failure.
- Edge: a loop closed by Codex with only MCP access — same flow via
  `--mcp-snapshot`, unchanged.

## Admin/User UX Impact

None in the product — no app surface changes. The "UX" here is David's:
the digest arrives through `/maintenance` and on demand, in chat, in plain
language. (No async product UI is involved, so `async-ui-status.md` doesn't
apply.)

## Security, Permissions, and Validation

- No new credentials; the guard's coverage half uses the same
  `pull-requests: read` token `build.yml` already grants, and *fewer* API
  calls (no per-candidate file fetches).
- Public-repo disclosure: loop metrics and process notes are already public
  in the current ledger; the new store adds no new class of information.
- Validation: JSON schema enforced in CI; malformed cells fail loudly (the
  `countCell`-throws principle carries over — no silent coercion to
  "unmeasured").

## Testing Plan

Runner: `node --test scripts/__tests__/<file>` (the existing dependency-free
pattern; wired into `build.yml` alongside the current script tests).

- `check-loop-metrics.test.mjs`: schema validation (good/bad/missing fields),
  filename↔`pr` mismatch, arithmetic pass/fail/deferred/exempt, sampling
  predicate (boundary: `pr % 5`, `findings = 29/30`), sampled-loop-without-
  adjudication failure, append-only diff logic (delete, mechanical mutation,
  legal judgment fill), frozen-ledger touch, coverage warning vs. audit
  overdue (fixture PR lists — the negative case: open PRs and Dependabot
  correctly excluded).
- `loop-metrics` additions: `--write` idempotency (existing file → no-op exit
  0; `--force` overwrites), cohort reordering (bugfix-tier PR with docs →
  `bugfix`; code-majority with docs → `feature/code`; docs-only →
  `prose/contract`; the old leak case as a regression test).
- `migrate-loop-ledger.test.mjs`: parity on a fixture ledger covering every
  row-state in the matrix above; re-run idempotency; hard failure on an
  unparseable row.
- `loop-report.test.mjs`: qualifying-loop filter (structural-floor rule),
  window filtering, calibration flag, unmeasured exclusion from trend,
  empty-store behavior.
- Manual QA: run the real migration against the real ledger and diff the
  parity report; run `loop-report.mjs` on the migrated store and check its
  numbers against the frozen analysis section's twelve named percentages.

## Implementation Steps

1. Schema + `--write` mode in `loop-metrics.mjs`; cohort reorder. Tests.
2. `check-loop-metrics.mjs` + tests (guard exists before any files do, so
   the store is never unvalidated).
3. `migrate-loop-ledger.mjs` + tests; run it; commit the store (including
   the #327/#335 union and the closed-loop sweep).
4. `loop-report.mjs` + tests.
5. Freeze `loop-ledger.md`; rewire `build.yml`; delete
   `check-ledger-coverage.mjs` + its tests.
6. Contract rewrites: `working-modes.md`, `CLAUDE.md`,
   `/maintenance` SKILL.md section.
7. Open the implementation PR (oracle from this plan), drive review, merge;
   then close #327/#335 with comments.

Steps 1–6 are one implementation PR (they are one coherent cutover; a store
without its guard, or a guard without the migration, is not a shippable
intermediate state). Step 7 is the normal PR ceremony.

## Risks and Mitigations

- **Migration transcription errors** — the exact class this system exists to
  prevent. Mitigation: script-parsed from the same `parseLedger` logic CI
  trusts today, hard-failing parity check, manual QA diff against the twelve
  named percentages.
- **The obligation decays without the hard carrier gate.** Mitigation: the
  PR warning + 2-merge audit backstop is retained; the cost of paying a debt
  drops from "open a dedicated PR carrying everything owed" to "add one
  file to any PR", which attacks the actual cause of past misses (cost),
  not just their detection.
- **Sampling misses a drifting classifier between samples.** Accepted
  deliberately (option 1): 1-in-5 + all large loops keeps a recurring
  calibration signal; the digest surfaces trips; David can order a full
  adjudication of any loop at any time.
- **This plan's own loop repeats the mid-loop-construction pathology** (the
  #270/#304 pattern: building machinery and hardening it across rounds).
  Mitigation: the machinery here is small by design (~200-line guard, ~150-
  line report, schema reuse of `derive()` output), and the plan-review loop
  reviews the *design* before any code exists — plus the stopping rule
  (finding count rising round-over-round → pause and reassess with David).
- **Two eras of cohort labels.** Mitigation: the digest states the boundary
  date and never silently pools across it.

## Questions for David

None — the pre-plan conversation settled the product intent (option 1), and
the remaining choices (sampling rate, backstop threshold, file format) are
engineering calls this plan makes explicitly so the review loop can attack
them.

## Definition of Done

- [ ] Two simulated concurrent recordings (different loops) merge cleanly
      with zero conflicts; the same loop twice is a no-op.
- [ ] `loops/*.json` exists for every historical row and exemption; parity
      check passes; the twelve named percentages reproduce from the store.
- [ ] `check-loop-metrics.mjs` green in CI on PR and `--audit` paths; old
      guard deleted; `[LEDGER]` gates gone.
- [ ] `loop-report.mjs` produces the digest from the real store;
      `/maintenance` includes the narration step.
- [ ] `working-modes.md` + `CLAUDE.md` describe the new ceremony; no
      reference to appending markdown rows or `[LEDGER]` PRs survives
      outside the frozen file and historical notes.
- [ ] #327 and #335 closed with comments; their row content present in the
      store.
- [ ] The first post-merge push-to-`main` audit is green.
