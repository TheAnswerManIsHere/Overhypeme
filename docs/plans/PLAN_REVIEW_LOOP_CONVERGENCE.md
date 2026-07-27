# Plan — Make review loops converge in a handful of rounds

> **Revision 2.** Incorporates Codex round 1 (6 findings) and ChatGPT's
> full-document assessment (6 required revisions). Both reviewers independently
> concluded the direction is sound and the plan was not ready as written. The
> round-1 causal percentages were wrong and are recomputed below from a
> per-finding ledger.

## Problem

PR #268 (an 8-file prose/contract change) took **18 Codex review rounds and 40
findings** to converge.

**Causal ledger — all 40 findings classified individually.** Criteria, applied
per finding, not per round:

- **New ground** — a defect that existed independent of any fix I made in a
  prior round (including incompleteness of the *original* authoring).
- **Propagation (self-inflicted)** — a defect caused by a prior round's fix
  landing in one place while another operative restatement went stale.
- **Wrong fix (self-inflicted)** — a defect where a prior round's fix was
  substantively incorrect.

| Round | Findings | New ground | Propagation | Wrong fix |
|---|---|---|---|---|
| 1 | 6 | 6 | — | — |
| 2 | 2 | 1 | — | 1 |
| 3 | 4 | — | 4 | — |
| 4 | 1 | — | 1 | — |
| 5 | 2 | 2 | — | — |
| 6 | 3 | 2 | 1 | — |
| 7 | 2 | — | 2 | — |
| 8 | 1 | — | 1 | — |
| 9 | 1 | 1 | — | — |
| 10 | 2 | — | 1 | 1 |
| 11 | 0 | — | — | — |
| 12 | 3 | 1 | 1 | 1 |
| 13 | 5 | — | 4 | 1 |
| 14 | 2 | — | 2 | — |
| 15 | 1 | 1 | — | — |
| 16 | 3 | 2 | 1 | — |
| 17 | 2 | — | 1 | 1 |
| 18 | 0 | — | — | — |
| **Total** | **40** | **16 (40%)** | **19 (47.5%)** | **5 (12.5%)** |

**Self-inflicted: 24 of 40 (60%).** Rounds 13, 16 and 17 mix causes, which is
why round-bucket estimation (the method that produced revision 1's incorrect
35/40/25) is unsound.

**The dominant single cause is propagation at 47.5%** — a fix landing in one
file while 4–6 restatements of the same rule went stale. That materially raises
the priority of C2 (see *Questions for David* #1).

The artifact also grew `108 → 373` lines in `working-modes.md`; each fix added
qualifying prose, and each clause added surface for the next inconsistency.
Round 11 came back clean and round 12 then found three issues including two P1s
— a clean round was not evidence of convergence.

## Product Intent

Bugfix, code review, and plan review each converge in a handful of rounds —
target ~4–5, not 20 — **without reducing review rigor.** The manual
paste-to-ChatGPT flow reached consensus in ~4 rounds on plans; we want that
efficiency from the automated loop.

## Must Not Change

- **Review rigor.** We remove self-inflicted churn, not lower the bar. A loop
  that converges fast by finding less has failed.
- **Only David approves.** No change to approval semantics on any loop.
- **Codex remains the independent reviewer.** The preflight in C1 is an
  author-side defect-removal pass; it is **not** evidence any reviewer may use
  to reduce rigor, and it does not replace independent review.
- **Long, genuinely-narrowing plan reviews stay legal.** PR #252 reached round
  23 still finding real bugs. No change may introduce a hard stop that would
  have killed it (see C5, which revision 1 got wrong on exactly this point).
- **The reviewer-contract boundary.** `plan-review-contract.md` is a
  cross-agent *reviewer* contract; Claude's loop mechanics live in `CLAUDE.md`
  and are deliberately not restated there. This plan must not violate that.
- The `[PLAN REVIEW]` PR stays never-merged; plan files stay off `main`.

## Settled Decisions

1. **The diagnosis is causal, not difficulty-based.** 60% of findings were
   rework, per the ledger above.
2. **Model tier is a third-order factor.** The duplication driving propagation
   was authored on Opus in round 1; Sonnet contributed the 5 wrong fixes.
3. **This plan is its own dogfood test** — it runs through the plan-review loop
   whose rules it proposes to amend, and its own round-1 review already
   demonstrated the value (both reviewers found real defects in it).
4. **Codex and ChatGPT are complementary and both are worth running on plans.**
   Round 1 evidence: Codex counted the merged history and disproved the
   percentages, which ChatGPT explicitly could not verify; ChatGPT found three
   internal-coherence defects Codex missed entirely. Diff-anchoring makes Codex
   strong on "is this claim true" and weak on "is this argument coherent."

## Repo Context Inspected

- `docs/ai-context/plan-review-contract.md` — read in full (515 lines),
  including the preamble's reviewer-contract-vs-Claude-ceremony boundary.
- `docs/engineering/code-review.md` — read in full; *Re-reviews* invariants 3
  and 5, and *Review output format*'s clean-round claim (lines 282–285).
- `CLAUDE.md` — *Automated plan review*, *Watching the PRs I open*, *Token /
  cost discipline*, and the subagent-delegation rules (line 1175).
- `working-modes.md`, `AGENTS.md`, `.agents/PLANS.md`,
  `known-failure-patterns.md`.
- PR #268: `git diff --name-only origin/main...HEAD` for the 8-file set, plus
  all 40 findings and 18 trigger comments read round by round.

## Current Behavior

**Plan review** already forbids diff-only review, explicitly:
`plan-review-contract.md:112` — *"**The diff is not the scope.** … Re-read the
complete current plan and re-verify it against the repository each round."*
Round 1 of a plan review is also a newly-added file, so its diff *is* the whole
document. Plan review is structurally the least exposed of the three.

**Code review** — *corrected from revision 1, which cherry-picked this quote.*
`code-review.md:244` invariant 5 **does** end with *"the diff is not the
scope,"* and invariant 3 already requires inspecting related callers,
invariants and tests. So code review is **not** diff-bound. The actual gap is
narrower and twofold:

1. It requires reviewing the *cumulative branch diff*; it never requires
   reading **complete current files**, which is what catches an untouched
   paragraph that now contradicts an edited one.
2. `code-review.md:282-285` states a clean structured code-review result is
   *stronger* than a clean plan-review result *"(compiling, passing tests, and
   CI back it up)."* **That is false for prose-only changes** — nothing
   compiles. Adding a prose rule without qualifying this leaves the guide
   self-contradictory.

**#268 ran through the code-review flow**, because a multi-file prose/contract
refactor is neither a single-document plan nor a code diff.

**The transport is an evidence constraint, not a reading constraint.** On #268
round 16 Codex produced a finding whose evidence came from
`docs/CODEX_GITHUB_REVIEW_WORKFLOW.md:5-8` and
`docs/ai-context/documentation-workflow.md:166-174` — **neither file is in
#268's diff** (verified). Round 15 flagged pre-existing untouched text. Codex
reads whole files; it can only *anchor* findings to changed lines.

## Source-of-Truth Analysis

| Concept | Owner today | After this plan |
|---|---|---|
| Plan-review substance | `plan-review-contract.md` | **unchanged — this plan does not edit it** |
| Code-review substance | `code-review.md` | gains the prose invariant + clean-round qualification |
| Feature/bugfix modes | `working-modes.md` | unchanged |
| Claude's loop mechanics (preflight, triggers, breakers, git, tiers) | `CLAUDE.md` | gains C1, C3, C4, C5, C6-trigger, C7 |

**No new source of truth is created, and no rule is restated across files.**
Revision 1 violated this by putting C1 in both `CLAUDE.md` and
`plan-review-contract.md`; that edit is removed.

The repo's own `known-failure-patterns.md` lists *duplicate source of truth* as
failure #1, and our contract docs violate it (the bugfix oracle fields appear
in 4 files). That is C2 — see *Questions for David* #1 for its sequencing.

## Proposed Design

### C1 — Fresh-context preflight *(renamed from "self-review")*

Before triggering a reviewer, dispatch a **subagent with no context of my
edits**. It receives the PR-body oracle and the branch, and **discovers the
relevant artifact set itself** rather than being handed a closed list. It does
not receive my round history, defenses, or intended-fix explanations. It reports
files read, searches run, contradictions found, and unresolved uncertainty.

**Applies to:** any plan or contract change; prose changes above ~3 files;
Tier B / high-risk bug fixes; cross-file shared-code changes;
architecture/refactor changes; and changes touching concurrency, persisted
data, migrations, auth/security, the visual pipeline, tokenizer/grammar, the
async queue, or generated-code owners. **Not** tiny leaf-code changes or
single-file typo fixes.

**This requires an explicit carve-out from BOTH delegation prohibitions.**
`CLAUDE.md:1173-1176` carries two rules that each independently forbid this
preflight, and exempting only the second leaves the first still contradicting
C1 at exactly the scope C1 cares about:

- **`CLAUDE.md:1173-1174`** — *"Don't delegate work I could finish in a handful
  of tool calls."* A qualifying single-file plan or contract change is often
  exactly that size, so this bullet alone would block the preflight on the very
  changes C1 targets.
- **`CLAUDE.md:1175`** — *"Don't spawn subagents to verify or double-check my
  own work."*

Both stay in force for ordinary work and gain **one named exception** covering
this preflight, written once and referenced by both bullets rather than
restated. The reason is stated with it, because it is what makes the exception
principled rather than a loophole: the preflight's entire value is the
*absence* of my context — my main loop cannot reproduce that at any size, so
"I could do it in a handful of tool calls" is not a reason to skip it here.
Cost is not the constraint the first bullet is protecting against in this case;
the second bullet's concern (redundant self-verification) does not apply either,
since a context-free reader is not redundant with me.

**Owner: `CLAUDE.md` only.** Not added to `plan-review-contract.md` — that
would violate the reviewer-contract boundary and duplicate ownership.

### C2 — Normative rules live in exactly one file

Never restate a rule; link to it. **Sequencing is now an open question for
David** (#1 below) because the ledger shows propagation — the failure C2
eliminates — is the single largest cause at 47.5%.

### C3 — Repository-wide concept-impact pass, not a file-set grep

Revision 1 said "grep the concept across the PR's file set," which is circular:
a file only enters the set once someone discovers it. Replaced with:

1. Identify the canonical rule.
2. Search the **whole repository** — exact terms, aliases, headings, linked
   consumers, known mirrored field lists.
3. **Classify each hit**: canonical definition · operative mirror/enactment ·
   summary/pointer · historical record · example · unrelated.
4. Update every **operative** hit in the same commit. **Supersede historical
   records (e.g. `decisions.md`) with an annotation — never rewrite history.**
5. Record the search terms and the disposition of relevant hits in the round
   ledger or trigger comment.

For code the equivalent is not textual grep: search callers, tests, schemas,
route contracts, generated owners, and config consumers.

**Owner: `CLAUDE.md`.**

### C4 — Verify before writing, with an observable gate

Before drafting any fix to a rule: re-read (a) the canonical statement and
(b) any document the finding cites. Every #268 round where I did this (6, 15,
17) was substantively clean; all 5 wrong fixes skipped it.

**The gate:** the round's trigger comment records **which canonical clauses
were read** (file + line) and, where the fix resolves a contradiction, the
contradiction case exercised. An instruction to the same actor who drafts the
fix is unauditable otherwise — and this repo already holds that "an obligation
nobody can check is an obligation that decays."

**Owner: `CLAUDE.md`.**

### C5 — Two distinct breakers, correctly scoped

Revision 1 had one 5-round breaker that would have killed PR #252 — the exact
loop *Must Not Change* protects. Split:

**Breaker A — self-inflicted rewrite (all loops).** Two consecutive rounds
where the majority of **root-cause finding clusters** are self-inflicted → stop
line-patching; perform one coherent rewrite or restructure before the next
trigger. This is an internal recovery action, not an escalation.

**Breaker B — escalation (implementation PRs only).** Five completed rounds
without convergence *after* any Breaker-A recovery → pause and bring David the
diagnosis and a recommendation.

**Breakers A and B together REPLACE the existing ~2-round rule — in every
place it is stated, not just its canonical one.** Leaving any mirror standing
gives an executor two operative thresholds; they stop at round 2 and Breaker B
can never fire. Revision 3 named only the canonical site, which meant this plan
failed its own C3 on C3's very first application. The full inventory, produced
by running C3's repository-wide pass over the concept *"when to stop a
non-converging review loop"* (search terms: `non-converging`, `~2 rounds`,
`two rounds`, `rounds without convergence`, `break`, `bring David the
diagnosis`):

| Site | Text | Classification | Disposition |
|---|---|---|---|
| `CLAUDE.md:880-882` | *"Break non-converging loops… after ~2 rounds without convergence, I stop and bring David the diagnosis"* | **Canonical definition** | **Rewrite** as Breakers A/B; preserve the contested-fix clause. |
| `CLAUDE.md:897-900` | *"…escalate real decisions, break after ~2 non-converging rounds"* (inside the fix-round re-review rule) | **Operative mirror** | **Rewrite** to point at Breakers A/B. Governs implementation-PR fix rounds — the exact loop Breaker B is for. |
| `.claude/skills/bugfix/SKILL.md:200` | *"Break after ~2 non-converging rounds and bring David the diagnosis."* | **Operative mirror** (a different file, so C2 will not reach it) | **Rewrite** to point at Breakers A/B. A bugfix PR is an implementation PR, so Breaker B's five rounds must reach it. |
| `CLAUDE.md:1051` | *"…mid-task if a debugging/optimization thread thrashes past ~2 rounds without converging"* | **Not a mirror — different concept.** This is the *model-tier* escalation trigger (say so out loud, suggest Opus), not a loop-stop. | **Leave unchanged**, and say so in the commit, so a later reader does not "fix" it into agreement. |
| `.agents/memory/plan-doc-path-never-cite-from-code.md:22` | *"Codex's review caught it two rounds later"* | **Historical record** | **Leave unchanged.** C3 supersedes historical records, never rewrites them. |

The mirrors at `CLAUDE.md:897-900` and `SKILL.md:200` are the operationally
dangerous ones: both sit in the *implementation-PR fix-round* path, which is
precisely Breaker B's scope, so before this correction Breaker B was unreachable
on every PR type it was written for — not merely on the one path revision 3
identified.

Why replacing it is right rather than a loosening: the old rule conflated two
different situations under one threshold, which is exactly why it never fired
on #268 (every round produced real findings, so nothing looked
"non-converging"). The split handles both properly — **churn** is caught
*earlier* and more decisively at 2 rounds by Breaker A, which mandates a
rewrite rather than more patching; **genuine slow convergence on new ground**
gets to 5 rounds before escalating, instead of being stopped at 2. Net effect
on #268 would have been an earlier intervention, not a later one.

The one clause worth preserving from the old rule: *"if a fix would be
contested"* → escalate immediately, regardless of round count. That is
orthogonal to both breakers and carries over.

**Plan-review PRs keep the existing ~20-round check-in** and minimum-3-rounds
rule. Breaker A applies; Breaker B does not.

**Counting unit: root-cause clusters, not inline comments** — one root cause
split across three comments is one cluster. Severity is retained in the ledger
so three minor self-inflicted clusters don't mask one critical new-ground one.

**Owner: `CLAUDE.md`.**

### C6 — Complete-prose-artifact review, and fix the clean-round semantics

Two edits to `code-review.md`:

**(a)** Add to *Re-reviews*, alongside the existing cumulative-diff invariant:

> **For a change whose artifact is prose** (contracts, docs, skills,
> templates), the cumulative diff is still not enough — **read the complete
> current files**, plus the canonical documents they cite or enact and the
> operative consumers a repository-wide search surfaces. In prose the defects
> live in text that did not change. This mirrors `plan-review-contract.md`'s
> *Re-reviews* invariant 1.

**(b)** Qualify *Review output format*'s clean-round claim (lines 282–285): the
compilation/tests/CI corroboration applies **to code**. For prose-only changes
an empty findings list is still the transport's clean result, but nothing
independently corroborates it.

**The qualification in `code-review.md` stays generic and names no Claude
ceremony.** Revision 3 had it branch on whether C1 ran, which was wrong on the
ownership boundary: `code-review.md:249-252` already assigns trigger mechanics
to the implementing agent and keeps only reviewer substance in the shared
guide, and a non-Claude implementing agent has no C1 at all. Branching the
shared contract on a `CLAUDE.md`-only ceremony would also make step 1
undeliverable on its own, since it would reference something step 2 has not yet
defined. So `code-review.md` says only this, in reviewer-agnostic terms:

> On a prose-only change, an empty findings list is the transport's clean
> result, but nothing independently corroborates it — there is no compiler, no
> test suite, and no CI signal behind it. What backs it instead is whatever
> outside-diff work was actually performed: the complete-current-file read
> required above, and any repository-wide consistency search. **The trigger
> comment states which of those were done**; a clean result should be read
> against that stated evidence, not against an assumed maximum.

That inverts the dependency correctly — the shared guide asks the trigger to
declare its evidence, and each implementing agent's own ceremony decides what
evidence it can offer.

**In `CLAUDE.md`**, the trigger rule then supplies Claude's side of that
declaration:

- The trigger names the known changed files **and** instructs the reviewer to
  follow their canonical references and operative consumers — the list is a
  starting point, not a closed scope.
- It states that whole-file consistency is an **additional** obligation, not
  the only lens; all normal correctness, source-of-truth, security, test and
  operational checks still apply.
- **It reports the preflight honestly.** When C1 applied, the trigger says so
  and reports its yield. When C1 was exempt (≤3 files, non-plan, non-contract),
  the trigger says the preflight did not run and names the weaker evidence set
  that remains — the complete-artifact read and the repository-wide search
  alone. A reviewer or David reading a clean result on an exempt prose PR then
  knows exactly which evidence backs it, without the shared contract ever
  having to know what a preflight is.

Mixed code/prose PRs get **both** sets of obligations.

**Owner:** `code-review.md` (reviewer standard) + `CLAUDE.md` (trigger).

### C7 — Explicit tier boundary, not "authoring tier"

"Stays on the authoring tier" is ambiguous when a contract is simultaneously
documentation (Sonnet), workflow meta (Sonnet), and architecture judgment
(Opus). State the behavior directly:

- Mechanical PR watching, status checks, and unambiguous wording fixes → Sonnet.
- A finding requiring revision of a cross-agent contract, architecture
  boundary, source-of-truth rule, approval semantics, migration policy, or
  design decision → **Opus before writing the substantive fix.**
- Once the substantive reasoning is done, routine watch mechanics may return to
  Sonnet if no active planning cycle is running.
- `[PLAN REVIEW]` stays Opus end-to-end (existing rule, unchanged).

Reconcile in **every** tier table that would otherwise route the same work to
Sonnet — *Watching the PRs I open* and *Token / cost discipline* must give one
answer.

**Owner: `CLAUDE.md`.**

## Data Model and Migration Impact

**None.** Documentation and skill files only.

## Runtime Behavior

No product runtime change. A loop after this plan:

1. Work completes → **C1 preflight** (if in scope) → fix its findings →
   **re-run the preflight on the revised artifact.** Repeat until a preflight
   returns clean, then open the PR. A preflight fix can itself introduce a
   propagation or wrong-fix defect — the two dominant causes in the ledger — so
   opening the PR straight after the first fix ships an artifact that never
   actually passed the preflight it claims to have had. **Bound: if three
   preflight rounds do not reach clean, that is Breaker A's signal — stop
   patching and rewrite the artifact coherently before opening the PR.**
2. Trigger names the artifact type; prose PRs request complete-file reads and
   instruct the reviewer to follow references beyond the named list (C6).
3. Per finding: **C4 verify + record clauses** → **C3 repo-wide impact pass** →
   fix all operative instances in one commit.
4. After each round: classify provenance by cluster (C5). **Breaker A** →
   coherent rewrite. **Breaker B** (implementation PRs only, post-recovery) →
   bring David the diagnosis. Plan reviews retain the ~20-round check-in.

Edge cases: a mixed code/prose PR gets the stricter prose obligations *plus*
the code checks. A one-file typo skips the preflight.

## Admin/User UX Impact

None — no product surface. The visible change to David: fewer rounds, and when
Breaker B fires he gets a decision request instead of silent churn.

## Security, Permissions, and Validation

None touched. Public-repo disclosure: no vulnerability detail, secrets,
customer data, or embargoed material.

## Testing Plan

- **`pnpm run check:docs`** and **`git diff --check`** must pass.
- **Record repository-wide searches** for each changed concept: whole-file/diff
  scope language, breaker language, plan-review minimum/soft-cap language,
  tier routing for contract review, preflight references.
- **Scenario validation against the final prose** — the general invariant, not
  the #268 example:
  1. Four-round plan review, all new-ground → continues normally.
  2. Two consecutive propagation rounds in a plan review → Breaker A fires,
     Breaker B does not.
  3. Five-round implementation PR → Breaker B escalation fires. **Run this on
     both implementation paths**: (a) a feature/code PR, governed by
     `CLAUDE.md`'s fix-round rule, and (b) a **bugfix PR**, governed by
     `.claude/skills/bugfix/SKILL.md`. Path (b) is the one that was blocked
     before revision 4 — the scenario passes only if neither path stops the
     loop before round five.
  4. One-file typo → no preflight.
  5. Four-file prose contract change → preflight + complete-artifact review.
  6. High-risk cross-file *code* change → preflight applies though not prose.
  7. Mixed code/prose PR → both obligation sets apply.
  8. Codex returns nothing on a prose re-review → recorded as a clean transport
     result **without** claiming compile/CI proved semantic consistency.
  9. **PR #252 replayed against C5** → Breaker B never applies (plan review);
     show whether Breaker A would have fired and why that is acceptable.
  10. **Single-file contract change small enough to inspect in a handful of
      tool calls** → the preflight still runs. This is the boundary case where
      `CLAUDE.md:1173-1174` and C1 collide; the scenario passes only if the
      carve-out resolves it without leaving either bullet self-contradictory as
      written.
  11. **Step 1 read in isolation** — `code-review.md`'s clean-round
      qualification, with step 2 assumed never to land. It must be
      comprehensible and correct to a reviewer who has never heard of C1.
- **Calibration window, not a one-PR verdict:** the next **10 eligible loops or
  30 days**, whichever yields enough observations. Record per loop: total
  rounds; new-ground / propagation / wrong-fix clusters; self-inflicted share;
  preflight findings caught before external review; severity per cluster.

  **Categories, with an explicit precedence rule** so every loop lands in
  exactly one cohort (scenario 7 is otherwise unrecordable — a mixed PR is
  simultaneously code and prose):

  1. `plan-review PR` — any `[PLAN REVIEW]` PR.
  2. `prose/contract PR` — **including mixed code/prose PRs.** Precedence goes
     to prose because that is where the obligations are stricter and where the
     measured risk lives; a mixed PR already carries both obligation sets, so
     recording it under the stricter cohort matches what was actually required
     of it. Note mixed PRs in the ledger so they can be separated later if the
     data suggests they behave differently.
  3. `bugfix PR` — a Tier A/B bugfix with no prose artifact.
  4. `feature/code PR` — everything else.

  Evaluate top-down; the first matching category wins. The ≤3-round median
  applies to a mixed PR via cohort 2.
- **Primary metric: self-inflicted cluster share below ~25%.** Round counts are
  provisional SLOs (bugfix ≤2 median, code ≤3, prose ≤3 post-preflight, plan
  review ≤5 new-ground rounds), **not gates.** Reassess when the share exceeds
  25% across the window or the median/p90 materially misses — never because one
  legitimate loop reached round four.

## Implementation Steps

1. `docs/engineering/code-review.md` — C6(a) prose invariant + C6(b)
   clean-round qualification. Highest-value single change, and it **genuinely
   ships alone**: both edits are reviewer-agnostic and reference no
   `CLAUDE.md` ceremony, so nothing here depends on step 2 landing.
2. `CLAUDE.md` — C1 preflight (including the re-run-until-clean loop) + **one
   named carve-out covering both delegation prohibitions at lines 1173-1176**,
   referenced from each bullet rather than restated; C3 repo-wide impact pass;
   C4 verify-and-record; C5 two breakers **rewriting every operative statement
   of the ~2-round rule — `CLAUDE.md:880-882` and `CLAUDE.md:897-900`** —
   rather than sitting beside them, preserving the contested-fix clause, and
   **leaving `CLAUDE.md:1051` deliberately unchanged** (tier-escalation
   trigger, a different concept) with a commit-message note saying so; C6
   trigger mechanics including the honest preflight-evidence report; C7 tier
   boundary reconciled across both tier sections.
3. `.claude/skills/bugfix/SKILL.md:200` — rewrite the third operative mirror of
   the ~2-round rule to point at Breakers A/B. **This is a separate step
   because it is a separate file**: a bugfix PR is an implementation PR, so
   Breaker B's five-round threshold must reach it, and leaving this line alone
   would keep Breaker B unreachable on the bugfix path regardless of what
   `CLAUDE.md` says. It ships in the same commit as step 2 — the two are one
   concept change and must not land split across PRs.
4. **Do not edit `docs/ai-context/plan-review-contract.md`.** Confirm its
   existing whole-plan re-review invariant is unchanged.
5. **Re-run C3's repository-wide pass over the two concepts this plan itself
   changes** — *"when to stop a non-converging review loop"* and *"when may I
   dispatch a subagent"* — after steps 1–3 land, and confirm the resulting hit
   list matches the C5 inventory table with no unclassified survivors. Step 3
   exists only because the first pass was incomplete; this step is the check
   that the second pass was not.
6. `pnpm run check:docs` + `git diff --check`.
7. Run the C1 preflight against the completed artifact set **before** opening
   the implementation PR — this plan's first dogfood use.
8. Open the implementation PR with the approved-plan oracle; record preflight
   yield and per-round provenance as calibration datapoint #1.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **C1 costs a subagent dispatch per qualifying PR** and delays the first review. | Thresholded. On #268 it would have replaced ~5 rounds. |
| **C1 could be read as reducing Codex's rigor.** | *Must Not Change* states explicitly it is author-side and is never evidence for a reviewer to do less. Not added to the reviewer contract. |
| **C5's provenance classification is my own judgment.** | Recorded per-round in the trigger comment — visible to David and Codex, auditable after the fact. Cluster counting reduces gaming via comment-splitting. |
| **Faster convergence could mean shallower review.** | Self-inflicted share, not round count, is the primary metric; shallow-but-fast fails it. |
| **This plan adds prose to already-long docs.** | Each change lands in exactly one owning file; C2 reduces net volume. |
| **The transport's reporting limit is unfixed** — no status label, verification report, or clean-round confirmation. | Accepted and already documented in both contracts. C1 partially compensates by producing a full assessment before the round. Not solvable; do not re-engineer. |
| **C2 deferral leaves 47.5% of the mechanism live.** | Open question #1 — sequencing C2 first resolves it. |
| **C3 is only as good as the searcher running it — and it already failed once, here.** Revision 3 named one of three operative mirrors of the ~2-round rule; Codex found the other two. That is C3's own diagnosed failure mode reproducing inside the plan that proposes C3. | Treated as evidence *for* C3 rather than against it — an unaided fix would have missed all three. Two structural responses: the C5 inventory is now a **classification table with dispositions**, not a prose mention, so a missing row is visible; and implementation step 5 **re-runs the concept pass after the edits land** and requires the hit list to match that table with no unclassified survivors. The DoD's grep is stated as a *verification of* the concept pass, explicitly not a substitute for it — grepping one wording is what produced the miss. |

## Questions for David

1. **C2 sequencing — the one genuine decision.** The ledger shows propagation
   is 47.5% of findings and C2 is the only change that eliminates it. ChatGPT
   endorses deferring C2 to its own PR (correctly — a 6-file refactor inside
   this PR recreates the diagnosed scope problem). Those are compatible:
   **my recommendation is to sequence C2 first, as its own PR, before
   implementing C1–C7.** Each PR stays one coherent artifact, and C1–C7 then
   land against an already-de-duplicated base.
2. **Round targets.** Recommendation: adopt as **provisional SLOs, not gates** —
   bugfix ≤2 median, code ≤3, prose ≤3 post-preflight, plan review ≤5
   new-ground rounds — with self-inflicted share <25% as the real metric.
3. **C1 scope.** Recommendation (revised — ChatGPT's answer is better than
   revision 1's "prose only"): apply to plans/contracts, prose above threshold,
   **Tier B/high-risk fixes, cross-file shared code, architecture/refactor, and
   the high-risk subsystem list** — but not tiny leaf-code changes. Tests and CI
   reduce code risk but do not prove all callers, dropped requirements, or
   source-of-truth boundaries were considered.

## Definition of Done

- [ ] C6(a) and C6(b) land in `code-review.md`; C1, C3, C4, C5, C6-trigger, C7
      land in `CLAUDE.md`; the C5 mirror rewrite also lands in
      `.claude/skills/bugfix/SKILL.md`; `plan-review-contract.md` is
      **unmodified**.
- [ ] `code-review.md`'s clean-round qualification is **reviewer-agnostic** —
      it names no `CLAUDE.md` ceremony, mentions no preflight, and reads
      correctly for a non-Claude implementing agent. Verified by reading step
      1's diff in isolation, as if step 2 never lands.
- [ ] Every rule lives in exactly one owning file — verified by a repo-wide
      search before the PR opens (C3 applied to this plan's own changes).
- [ ] The delegation carve-out is **one** exception covering **both**
      prohibitions at `CLAUDE.md:1173-1176`, referenced from each bullet rather
      than restated. Neither bullet, read alone, forbids the C1 preflight —
      including for a single-file change a handful of tool calls could cover.
- [ ] **Exactly one operative escalation threshold exists, repo-wide.** All
      three operative sites — `CLAUDE.md:880-882`, `CLAUDE.md:897-900`, and
      `.claude/skills/bugfix/SKILL.md:200` — are rewritten by Breakers A/B
      rather than left alongside them; the contested-fix clause survives.
      **Verified by running C3's concept pass, not by grepping one wording:**
      `grep -rn -iE "non-converging|~2 rounds|two rounds|rounds without conver"`
      across `*.md` returns only `CLAUDE.md:1051` (tier-escalation trigger, a
      different concept, deliberately unchanged) and
      `.agents/memory/plan-doc-path-never-cite-from-code.md:22` (historical
      record, superseded not rewritten). Any other survivor is a defect.
- [ ] **Breaker B is reachable on every PR type it governs.** Trace it on a
      bugfix PR specifically — the path that was blocked before revision 4 —
      and confirm no instruction stops the loop before round five.
- [ ] Every calibration loop lands in exactly one cohort under the precedence
      rule, including a mixed code/prose PR.
- [ ] `code-review.md` no longer claims compilation/tests/CI corroborate a
      clean result on prose-only changes.
- [ ] All eleven testing scenarios validate against the final prose, including
      the #252 replay, both implementation paths in scenario 3, and scenario 11's
      read-step-1-in-isolation check.
- [ ] `pnpm run check:docs` and `git diff --check` pass.
- [ ] The implementation PR records preflight yield and per-round provenance as
      **calibration datapoint #1** — explicitly *not* a pass/fail gate on the
      plan's validity.
- [ ] David can point at each of his three questions and see it answered in the
      merged docs.
