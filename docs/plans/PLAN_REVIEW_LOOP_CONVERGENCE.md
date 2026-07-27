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

**Every review round earns its place — and we can prove which ones did.**
A loop should end when rounds stop surfacing anything the artifact didn't
already contain, not when a counter is reached.

**The "4–5 rounds" figure is withdrawn as a requirement (David, 2026-07-27).**
It was his description of the order of magnitude he'd observed in the manual
paste-to-ChatGPT flow, not a specification — and round 5 established the plan
could not deliver it on a large artifact anyway. What he actually wants is
**confidence that additional rounds are genuinely useful**, plus **measurement
of whether the workflow as a whole is effective.** Round count is an output we
record, never a target we chase.

That reframes the objective usefully, because it splits rounds by what they
produce:

- A round that surfaces **new ground** told us something true about the
  artifact. It is the loop working, and it needs no defence at any count —
  PR #252's round 23 was this.
- A round that surfaces only **self-inflicted** findings corrected damage the
  previous round did. It added no information about correctness. **These are
  the rounds to bound**, and Breaker A is the bound.

So the goal is not fewer rounds. It is **a vanishing share of rounds that exist
only to repair the previous round**, with the data to show it.

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

5. **Round-count targets are withdrawn; measurement replaces them (David,
   2026-07-27).** "4–5 rounds" was an observed magnitude, not a requirement.
   What matters is that each round is useful and that the workflow's
   effectiveness is measured — not that a counter stays low.
6. **Every loop is tracked, permanently, across all four loop types (David,
   2026-07-27).** This is a standing obligation, not a calibration experiment.
   Nothing tracks anything today, so C8 is the control the others' claims
   depend on.
7. **Artifact size is bounded per PR (C9)** — approved as the structural attack
   on new-ground findings.

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
| Claude's loop mechanics (preflight, triggers, breakers, git) | `CLAUDE.md` | gains C1, C3, C4, C5, C6-trigger |
| Model-tier routing for contract revision | `CLAUDE.md` (two tier tables) | **unchanged — C7 is cut**, see C7's section |

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

**When:** before **every** reviewer trigger the artifact receives, not only the
first. That covers the pre-PR pass and any Breaker-A rewrite mid-loop (C5). The
qualifying-change list below is the only gate; where in the loop you are is not.

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

   **The search mechanism is specified, not left to the searcher.** "Search the
   whole repository" is an intent; two competent searchers executed it on this
   very concept and each missed a different site, for reasons that had nothing
   to do with diligence:

   - My round-3 pattern required a literal `2 ` and so could not match
     `CLAUDE.md:1033`'s *"2+ rounds without convergence."*
   - Codex's round-4 invocation — `rg … --glob '*.md' .` — **cannot see
     `.claude/` or `.agents/` at all**, because ripgrep skips hidden
     directories by default. It found `:1033`, which I missed, and structurally
     could not have found `.claude/skills/bugfix/SKILL.md:200` or
     `.agents/memory/`. *(Verified by running both invocations with and without
     `--hidden`.)*

   In this repository that default is disqualifying: `.claude/skills/` and
   `.agents/memory/` hold a large share of the operative rules. So C3 mandates:

   ```
   rg -n -i --hidden --glob '!.git' --glob '!artifacts' '<pattern>' .
   ```

   with the pattern written as **word-bounded alternations of stems** — stems
   rather than phrases (`converg`, not `without convergence`), and `\b`-anchored
   so a stem cannot match inside a longer word.

   **Revision 5's version of this rule was itself wrong, and the correction is
   the point.** It specified `\d\+? rounds?` with no word boundary, which
   matches `8 round` inside a Tailwind class like `min-h-8 rounded-md`. Run
   repo-wide it returns **521 hits**, almost all CSS in `artifacts/`. I
   specified that command without running it against the whole repository —
   committing the C4 violation (verify before writing) *in the act of
   specifying C3*. Codex caught it by running it.

   The corrected pattern is word-bounded and scoped past the vendored UI
   sandbox:

   ```
   rg -n -i --hidden --glob '!.git' --glob '!artifacts' \
     'non[- ]?converg|\b\d\+? rounds?\b|\brounds? without converg|bring David the diagnosis' .
   ```

   **7 hits, all classifiable.** *(Both patterns run; counts are measured, not
   estimated.)*

   Two rules follow from this, and they are the durable part:

   1. **Run the command before writing it down.** A specified-but-unrun command
      is worse than an unspecified intent, because it carries false authority.
   2. **The acceptance check classifies every hit the command returns — it never
      asserts an expected hit list.** An expected-set assertion fails the moment
      the pattern is broader than the author imagined, which is precisely the
      failure mode here. Record the exact command *and* the disposition of every
      hit in the round ledger.
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

**A Breaker-A rewrite gets a fresh-context pass before the next trigger — no
exceptions.** This closes a hole that would otherwise make Breaker A
counterproductive: C3 and C4 operate per-finding, and C1 as originally scoped
ran only *before the PR opened*, so a mid-loop rewrite — the single largest,
least-incremental change the loop ever produces — would reach the reviewer as
its first independent inspection. Two churn rounds would become the start of a
new propagation chain instead of a recovery from one, which is precisely the
failure Breaker A exists to stop. So:

- After **any** Breaker-A rewrite, on an open PR or pre-open, run the C1
  preflight over the **complete rewritten artifact** — not the rewrite's diff —
  and clear its findings before triggering review.
- The same re-run-until-clean loop and three-round bound from C1 apply. A
  rewrite that cannot reach a clean preflight in three passes is no longer a
  recovery; it goes to David with the diagnosis.
- This makes C1 a **loop-wide** obligation rather than a pre-open one. C1's
  scope text is amended accordingly, in one place, so the two rules cannot
  drift apart.

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
| `CLAUDE.md:1033` | *"2+ rounds without convergence is the signal to switch"* (the *Debugging new features* row of the tier table) | **Not a mirror — different concept.** Table-form counterpart of `:1051`; it governs **model-tier escalation**, not loop-stopping. Found by Codex in round 4; my round-3 pattern could not match `2+`. | **Leave unchanged**, classified here so the DoD's expected search result is accurate. |
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

### C7 — Explicit tier boundary *(**CUT** from this plan — kept here as the record of why)*

**Codex asked, in round 5, whether all seven controls are load-bearing. C7 is
not, and it is cut rather than defended.**

The case against it is the plan's own text. *Settled Decision 2* states model
tier is a **third-order factor** — the duplication that drove propagation was
authored on Opus. The *Counterfactual Efficacy* replay attributes **zero** of
#268's 24 self-inflicted findings to a tier boundary. The only findings C7
could plausibly touch are the two residual judgment-error wrong fixes that C4
does not catch, and I cannot give a defensible mechanism by which a stated tier
rule prevents a judgment error — only an argument that it makes one less
likely, which is not an acceptance check.

Keeping it would mean the plan carries a control justified by nothing in its
own evidence, inside a change whose entire thesis is that unjustified prose
accumulates and creates the next defect. That is the argument against C7 and I
find it stronger than my reasons for including it.

**What is actually lost:** the `CLAUDE.md` tier tables remain ambiguous about
which tier revises a cross-agent contract. That is a real ambiguity and worth
fixing — **as its own small change, on its own evidence**, not smuggled into a
convergence plan as an eighth wheel. Recorded in *Questions for David* so it is
not silently dropped.

The original proposal, preserved for that follow-up:

<details>
<summary>C7 as drafted</summary>

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

</details>

**Owner if revived: `CLAUDE.md`. Not implemented by this plan.**

### C8 — The loop ledger: track **every** loop, derive what can be derived

*(New in revision 7, at David's direction: "I want to confirm you have a
mechanism for tracking ALL activity that invokes any type of loop." **We do
not.** Nothing in this repository records a single round today — verified by
search. Every efficacy claim in this plan is therefore currently
unfalsifiable, which makes this the control the others depend on.)*

**One append-only ledger at `.agents/metrics/loop-ledger.md`**, one row per
loop, covering **all four loop types** — plan review, feature/code review,
bugfix review, and any ad-hoc thread that escalated into a reviewed change.
No calibration "window": tracking is permanent, because the question *"is the
workflow effective?"* does not expire after 30 days.

**The critical design choice: derive the objective half mechanically.** A
ledger I fill in by hand at loop close is exactly the obligation-nobody-checks
that this repo already knows decays — and my own error rate on hand-produced
numbers in this very plan (two withdrawn figures in five rounds) is the
argument against trusting it. So the row splits by who can be trusted to
produce it:

| Field | Source | Trustworthy? |
|---|---|---|
| PR number, type, artifact size (files, ±lines) | GitHub API | **Mechanical** |
| Rounds = count of `@codex review` triggers | GitHub API | **Mechanical** |
| Findings per round, severity | GitHub API (review comments) | **Mechanical** |
| First-preflight → merge/close wall-clock | GitHub API + ledger | **Mechanical** |
| Preflight passes (pre-open / post-fix / post-Breaker-A) and yield | Self-reported | Judgment |
| Per-finding cause: new ground · propagation · wrong fix | Self-reported, fixed rubric, ambiguity defaults to self-inflicted | Judgment |
| Breakers fired | Self-reported | Judgment |

**`scripts/loop-metrics.mjs` emits the mechanical half from a PR number**, so
round counts, finding counts and elapsed time are never my recollection. I
append only the judgment columns. A row missing its mechanical half is a bug
in the script; a row missing its judgment half is a loop I failed to close
out, and **both are visible as gaps in the file** rather than as silence.

**What the ledger is for — the questions it must be able to answer:**

1. What share of rounds were **self-inflicted**? (The primary metric — trending
   toward zero is the goal.)
2. Is end-to-end **cost** falling or rising as controls are added? A cohort
   whose cost rises while round count falls is a **failure** of this plan.
3. Do the controls pay for themselves — is **preflight yield** worth its cost?
4. Which **artifact sizes** produce which round counts? This is the evidence
   that decides where the size bound (C9) should actually sit.

**Owner: `.agents/metrics/loop-ledger.md` (data) + `scripts/loop-metrics.mjs`
(derivation) + `CLAUDE.md` (the obligation to append at every loop close).**

### C9 — Bound artifact size per PR

*(Approved by David, 2026-07-27, as the structural attack on new-ground
findings — the category ~21 of #268's 40 findings fell into and that nothing
else in this plan touches.)*

#268 was an 8-file contract refactor in one PR; this plan is one 700-line
document. Both produced long loops for the same reason: **a reviewer cannot
hold a large artifact in one pass, so defects surface serially across rounds
instead of together in round one.** No amount of preflight or concept-search
fixes that — it is a property of the artifact, not the process.

**The initial bound is deliberately provisional, because the ledger has not
run yet and I will not invent a threshold I cannot defend.** Starting point:
a prose/contract change touching **more than ~4 files or ~400 added lines**
gets split, or gets an explicit written justification for staying whole. C8's
data replaces this guess with a measured one — that is the first question the
ledger is built to answer.

**This is a behavior change, not just a rule**, which is why it needed David's
approval rather than mine. It costs up-front splitting work on every large
change.

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

## Counterfactual Efficacy — the 24 self-inflicted findings replayed

Until revision 4 the only quantified efficacy claim was that C1 "would have
replaced ~5 rounds." That was thematic, not derived. Replaying #268's actual
round history (`git log -1 --format=%B 4f477f3`, read round by round) gives a
per-cluster answer — **and it corrects the C1 claim rather than confirming it.**

The 24 self-inflicted findings group into 11 root-cause clusters:

| # | Round(s) | Findings | Root cause | Control | Prevented? |
|---|---|---|---|---|---|
| 1 | 3 | 4 | Tier/UAT/batch changes not propagated past the incremental diff | C3 | **Yes** — all four in non-hidden files, findable by a stem search on the changed concept. Note: the *cumulative*-diff rule already in `code-review.md` is what surfaced them, one round late. |
| 2 | 4 | 1 | One unqualified Tier B UAT line missed while the same sentence was fixed in 3 other files | C3 | **Yes** |
| 3 | 7 | 2 | Round-6 fixes reached `.claude/skills/bugfix/SKILL.md` but not the shared `working-modes.md` | C3 | **Yes — and only with `--hidden`.** The skill/contract split is the exact pairing a default `rg` cannot see both halves of. |
| 4 | 8 | 1 | Feature-mode routing summary still said "with product consequences" | C3 | **Yes** |
| 5 | 10 → 13 | 4 | The Tier C oracle block added in round 10 never propagated to 4 places describing the A/B block | C3 | **Yes** |
| 6 | 13 → 14 | 2 | Five Tier C triggers mirrored in one place only | C3 | **Yes** |
| 7 | 6, 12, 16, 17 | 5 | Scattered single propagations | C3 | **Probably** — each is mechanically findable; none is certain. |
| 8 | 10 | 1 | Round 9's wording **re-introduced the exact bug round 6 fixed** | C4 | **Yes** — the textbook C4 case: the fix contradicted a canonical clause a prior round had already settled. |
| 9 | 2, 12, 13, 17 | 4 | Other wrong fixes | C4 | **Partly** — 2 turn on re-reading a cited clause (C4 catches); 2 were judgment errors C4 does not address. |

**Total honestly attributable: ~19 of 24, with 5 marked probable rather than
certain.** The plan does not claim 24.

**Three corrections this exercise forced:**

1. **C1's benefit was misattributed.** Codex is right that C1 has no
   independently attributable count against the *self-inflicted* 24 — it runs
   before any review fix exists. What C1 plausibly catches is **original
   authoring incompleteness**, which the ledger classifies as *new ground*
   (16 findings), not rework. The Risks table's "would have replaced ~5 rounds"
   is corrected to say so.
2. **C3's mechanism, not its intent, is what does the work.** Cluster 3 is
   decisive: #268 ran a file-set grep three separate times (rounds 4, 8, and the
   self-review sweep after 13) and still missed sites, because the file set is
   not the concept scope — and a default `rg` would additionally have been blind
   to `.claude/` entirely. C3 prevents these only as specified above, with
   `--hidden`, stem alternations, and the command recorded.
3. **The strongest evidence in the whole history is for C1, from a different
   direction.** The commit titled *"Exhaustive manual sweep: fix the last Tier
   A/B-vs-C oracle ambiguity"* closed a seam that had recurred across **rounds
   10–14**. One complete-artifact pass ended what five reactive rounds could
   not. That is what C1 is, and it is a measured outcome from this repository
   rather than an argument.

**Residual risk, stated plainly:** every "Yes" above assumes the search is
executed correctly. This plan's own C3 application failed twice — round 3
(missed two operative mirrors) and round 4 (missed `CLAUDE.md:1033`). Both
failures are now traced to mechanism rather than diligence, and both are
addressed by the specified command. **Whether that is sufficient is exactly
what the calibration window measures**, which is why the primary metric is
self-inflicted share and not round count.

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
- **Permanent tracking of every loop, not a fixed calibration window
  (revised at David's direction, 2026-07-27).** Revision 6 proposed "10 loops
  or 30 days." That was wrong in two ways: it would have sampled *eligible*
  loops rather than all of them, and it would have expired — but "is the
  workflow effective?" is a standing question, not a one-off experiment.
  **C8's ledger records every loop, permanently, of all four types.** The
  fields below define the row; C8 defines who produces each field and why the
  objective half is derived mechanically rather than recalled.

  The first ~10 rows still serve as the initial read on whether the controls
  work — that is a **checkpoint, not the end of tracking.**

  **Plus end-to-end cost — because the plan can otherwise pass every metric
  while being worse.** C1 adds up to three subagent passes before the first
  trigger and another set after any Breaker-A rewrite; C3 adds a repository-wide
  search per finding; C4 adds a read-and-record step per fix. A four-round loop
  carrying all of that can cost more than #268's eighteen rounds, and nothing
  recorded above would show it. So each loop also records:

  | Field | Definition |
  |---|---|
  | Elapsed wall-clock | First preflight dispatch → convergence. Not first *review* — the preflight is part of the cost. |
  | Preflight passes | Count and findings each, split **three** ways: pre-open · **post-ordinary-fix-round** · post-Breaker-A. The middle category is the one that multiplies: C1 runs before *every* trigger, so a five-round loop incurs preflights after each fix round, not just twice. Omitting it would have made the cost model understate exactly the case most likely to be expensive. |
  | Rewrites | Count of Breaker-A rewrites and the artifact size each touched. |
  | Total tokens / tool calls | Whole loop, all subagents included. |
  | External rounds | The count the round targets refer to. |

  **Comparison rule:** cost is compared **within cohort** against that cohort's
  pre-change baseline — #268 for `prose/contract`, and the trailing median for
  the others (recorded from history at implementation time, before the first
  eligible loop runs, so the baseline cannot be chosen after the fact).
  **A cohort whose median end-to-end cost rises while its round count falls is
  a failure of this plan**, not a success, and triggers a return to David with
  the data. Round count alone is explicitly not the objective.

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

  Evaluate top-down; the first matching category wins.
- **Primary metric: self-inflicted finding share, trending toward zero.**
  **All round-count targets are withdrawn** (David, 2026-07-27) — there is no
  bugfix ≤2, code ≤3, prose ≤3, or plan-review ≤5. Round count is **recorded,
  never targeted**, because a target invites the one failure *Must Not Change*
  forbids: converging fast by finding less.

  What replaces them, matching what David actually asked for — confidence that
  additional rounds are useful:

  | Signal | Reading |
  |---|---|
  | Self-inflicted share **falling** | The controls work. |
  | Self-inflicted share **≥25%** | Churn persists; the controls are insufficient — diagnose, don't retune the number. |
  | A long loop, **nearly all new ground** | Working as designed. Not a problem at any count (PR #252). |
  | A short loop with **high self-inflicted share** | Worse than a long clean one, and a round target would have called it a success. |
  | Cost **rising** while rounds fall | A **failure** of this plan — return to David with the data. |

  The last two rows are the point: they are the cases a round target scores
  backwards.

  **The metric's unit is the finding, not the cluster — because that is the
  only unit whose baseline is verifiable.** Revision 5 tried to fix the unit
  mismatch the other way round, by re-expressing #268 as "11 self-inflicted
  clusters of 19." That number was **not reproducible**, correctly, and it is
  withdrawn rather than recomputed:

  - #268's commit history groups findings **by round**, not by root cause. The
    per-finding ledger above was built from those summaries and independently
    corroborated by Codex's own count in round 1 — **24 of 40 is verifiable.**
  - A cluster mapping is not. Producing one requires judgment calls the record
    cannot settle (round 3's four findings are four distinct concepts, not one;
    several rounds mix causes), and any denominator I derive is unfalsifiable.
    Manufacturing a third number after two were already wrong would be the
    exact failure this plan diagnoses.

  So the primary metric is **self-inflicted findings below ~25%, measured
  against #268's verified 60%.** Root-cause clusters remain the unit for
  **Breaker A's majority test only**, where the judgment is made within a
  single round against findings in front of me — not projected backwards across
  eighteen rounds of summarized history. The two units serve different purposes
  and the plan now says which is which, instead of silently converting between
  them.

  **Classification cannot be self-certified.** I both assign provenance and
  record it, and round 1 established that my own classification was wrong when
  done by estimation — so making the judgment visible does not validate it.
  The rubric and the audit:

  - **Fixed decision rubric, applied before looking at the count.** A finding is
    **propagation** if the defect existed in an operative site that a prior
    round's fix should have reached; **wrong fix** if a prior round's fix is
    itself the defect; **new ground** only if neither — including original
    authoring incompleteness. **Ambiguous cases default to self-inflicted.**
    That default is deliberate: it biases the metric *against* the plan, so
    drift cannot quietly flatter it.
  - **Independent adjudication sample.** For each calibration window, a
    fresh-context subagent — given the round history and the rubric, but **not**
    my classifications — independently classifies a random **30%** of clusters.
    Disagreement above **20%** invalidates the window's self-inflicted figure,
    which is then reported to David as unmeasured rather than as a pass.
  - Where a cluster's provenance is genuinely contested after adjudication, it
    is recorded as contested and counted as self-inflicted.

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
   trigger mechanics including the honest preflight-evidence report.
   **No tier-table changes — C7 is cut** (see its section); the two tier tables
   are left exactly as they are.
3. `.claude/skills/bugfix/SKILL.md:200` — rewrite the third operative mirror of
   the ~2-round rule to point at Breakers A/B. **This is a separate step
   because it is a separate file**: a bugfix PR is an implementation PR, so
   Breaker B's five-round threshold must reach it, and leaving this line alone
   would keep Breaker B unreachable on the bugfix path regardless of what
   `CLAUDE.md` says. It ships in the same commit as step 2 — the two are one
   concept change and must not land split across PRs.
4. **C8 — build the ledger before anything it measures.** Create
   `.agents/metrics/loop-ledger.md` (header + column contract, zero rows) and
   `scripts/loop-metrics.mjs` (takes a PR number, emits the mechanical
   columns). Add the append-at-loop-close obligation to `CLAUDE.md`.
   **This step ships first among the behavioural ones, and its own
   implementation PR is ledger row #1** — if the mechanism cannot record the
   loop that creates it, it will not record anything later either.
5. **C9 — write the artifact-size bound into `CLAUDE.md`**, with the threshold
   explicitly marked provisional and pointing at C8's data as what replaces it.
6. **Do not edit `docs/ai-context/plan-review-contract.md`.** Confirm its
   existing whole-plan re-review invariant is unchanged.
7. **Re-run C3's repository-wide pass over the two concepts this plan itself
   changes** — *"when to stop a non-converging review loop"* and *"when may I
   dispatch a subagent"* — after steps 1–3 land, classifying every hit the
   specified command returns. Step 3 exists only because the first pass was
   incomplete; this step is the check that the second pass was not.
8. `pnpm run check:docs` + `git diff --check`.
9. Run the C1 preflight against the completed artifact set **before** opening
   the implementation PR — this plan's first dogfood use.
10. Open the implementation PR with the approved-plan oracle, and **append its
    ledger row on close** — the first real data either of us has on whether any
    of this works.

**Note on C9 and this sequence:** steps 1–5 together exceed the artifact-size
bound C9 introduces. That is not an oversight — the bound applies to changes
made *after* it exists, and splitting the change that creates the rule is
circular. It is called out here so a reviewer does not read it as the plan
violating itself on day one. If David prefers, steps 1 and 4–5 can ship as two
PRs; step 1 is already established as independently shippable.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **C1 costs a subagent dispatch per qualifying PR** — now up to three per trigger, plus a set after every Breaker-A rewrite — and delays the first review. | Thresholded by the qualifying-change list. **The "would have replaced ~5 rounds" claim is withdrawn**: per *Counterfactual Efficacy*, C1 has no attributable share of #268's 24 self-inflicted findings, because it runs before any review fix exists. Its benefit is against the 16 **new-ground** findings — original authoring incompleteness — and the measured evidence for it is the exhaustive-sweep commit that closed a seam five reactive rounds could not. The calibration window's end-to-end cost fields exist to catch this risk if the benefit does not materialize. |
| **C1 could be read as reducing Codex's rigor.** | *Must Not Change* states explicitly it is author-side and is never evidence for a reviewer to do less. Not added to the reviewer contract. |
| **C5's provenance classification is my own judgment.** | Recorded per-round in the trigger comment — visible to David and Codex, auditable after the fact. Cluster counting reduces gaming via comment-splitting. |
| **Faster convergence could mean shallower review.** | Self-inflicted share, not round count, is the primary metric; shallow-but-fast fails it. |
| **This plan adds prose to already-long docs.** | Each change lands in exactly one owning file; C2 reduces net volume. |
| **The transport's reporting limit is unfixed** — no status label, verification report, or clean-round confirmation. | Accepted and already documented in both contracts. C1 partially compensates by producing a full assessment before the round. Not solvable; do not re-engineer. |
| **C2 deferral leaves 47.5% of the mechanism live.** | Open question #1 — sequencing C2 first resolves it. |
| **C3 is only as good as the searcher running it — and it has now failed three times in a row, here, in this plan.** Round 3: the inventory named one of three operative mirrors. Round 4: it missed `CLAUDE.md:1033`. Round 5: the *command I specified to fix rounds 3 and 4* returned 521 hits because a stem had no word boundary. C3's own diagnosed failure mode, reproducing inside the plan that proposes C3, three revisions running. | **This is the plan's most serious open risk and it is not fully mitigated.** What is mitigated: the C5 inventory is a classification table with dispositions, so a missing row is visible; implementation step 5 re-runs the pass after the edits land; the acceptance check now **classifies every hit rather than asserting an expected list** (asserting a list is what failed in round 5); and C3 requires the command to be **run before it is written down** — the round-5 defect was a specified-but-unrun command, which carries false authority an unspecified intent does not. What is **not** mitigated: none of that proves the *next* pattern will be right. The honest position is that C3 raises the floor and does not guarantee completeness, and the calibration window is what tests whether the floor is high enough. |

## Questions for David

1. **C2 sequencing — the one genuine decision.** The ledger shows propagation
   is 47.5% of findings and C2 is the only change that eliminates it. ChatGPT
   endorses deferring C2 to its own PR (correctly — a 6-file refactor inside
   this PR recreates the diagnosed scope problem). Those are compatible:
   **my recommendation is to sequence C2 first, as its own PR, before
   implementing the rest.** Each PR stays one coherent artifact, and C1/C3–C6
   then land against an already-de-duplicated base.
2. ~~**Round targets.**~~ **ANSWERED — David, 2026-07-27: withdrawn entirely.**
   The 4–5 figure was his description of an observed magnitude, never a
   requirement. All round-count targets are removed; round count is recorded,
   not targeted. What he wants instead: **confidence that additional rounds are
   genuinely useful**, and **measurement of whether the workflow is effective.**
3. ~~**The round target itself.**~~ **ANSWERED — David, 2026-07-27: adopt the
   recommendation.** Self-inflicted share becomes the measured objective
   (round count an output), **and** artifact size is bounded per PR — now C9.
   He added a requirement the plan did not have: **track every loop, always**,
   to confirm the workflow is optimizing the right things. That is now C8, and
   it is the control the rest depend on, because nothing in this repository
   records a single round today.
4. **The tier-table ambiguity C7 would have fixed** — which tier revises a
   cross-agent contract. C7 is cut from this plan as not load-bearing; the
   ambiguity is real and worth its own small change. Does David want it queued?
5. **C1 scope.** Recommendation (revised — ChatGPT's answer is better than
   revision 1's "prose only"): apply to plans/contracts, prose above threshold,
   **Tier B/high-risk fixes, cross-file shared code, architecture/refactor, and
   the high-risk subsystem list** — but not tiny leaf-code changes. Tests and CI
   reduce code risk but do not prove all callers, dropped requirements, or
   source-of-truth boundaries were considered.

## Definition of Done

- [ ] C6(a) and C6(b) land in `code-review.md`; C1, C3, C4, C5, C6-trigger
      land in `CLAUDE.md`; the C5 mirror rewrite also lands in
      `.claude/skills/bugfix/SKILL.md`; `plan-review-contract.md` is
      **unmodified**.
- [ ] **`CLAUDE.md`'s two tier tables are byte-identical to `main`** — C7 is
      cut, and a diff touching them means it crept back in.
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
      **Verified by running C3's specified command and classifying every hit it
      returns — not by asserting an expected hit list.** Revision 5's DoD
      claimed the search would return "exactly three survivors"; that assertion
      was false and unsatisfiable, because the pattern was broader than I
      realised. The check is now:

      1. Run the word-bounded command from C3 verbatim.
      2. **Classify every hit**, including ones this plan never anticipated
         (`CLAUDE.md:507` and `:534` are plan-review *depth* thresholds — a
         different concept from loop-stopping — and must be dispositioned, not
         assumed absent).
      3. Pass condition: **no hit is left unclassified, and no hit classified
         *operative mirror* is left unrewritten.** Not "the output equals this
         list."

      **`--hidden` is not optional** — without it the command cannot see
      `.claude/` or `.agents/`, which is how round 4's search missed two sites.
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
- [ ] **C3's search command is written into `CLAUDE.md` verbatim**, including
      `--hidden`, stem-alternation guidance, and the requirement to record the
      exact command run. An intent-only instruction does not satisfy this — two
      competent searchers already failed it on this very concept.
- [ ] **A Breaker-A rewrite cannot reach a reviewer un-preflighted.** Trace the
      path in the final prose: rewrite → complete-artifact preflight →
      clean → trigger. C1's scope says "before every reviewer trigger," stated
      once, with C5 pointing at it rather than restating the bound.
- [ ] **The calibration ledger records end-to-end cost**, and the
      cost-rose-while-rounds-fell condition is written as a **failure** of the
      plan with a defined response, not as an observation.
- [ ] **Baseline and metric share a unit.** The 58% per-cluster #268 baseline is
      recorded, and the <25% target is stated as measured against it.
- [ ] **The independent adjudication sample is specified and binding** — 30% of
      clusters, fresh-context classifier, >20% disagreement invalidates the
      window's figure rather than downgrading it.
- [ ] **`.agents/metrics/loop-ledger.md` and `scripts/loop-metrics.mjs` exist
      and work**, proven by running the script against a real merged PR and
      getting correct round/finding/elapsed numbers back. **Not proven by the
      files existing.**
- [ ] **The ledger's first row is this plan's own implementation PR**, with
      both halves filled — mechanical and judgment.
- [ ] **No round-count target survives anywhere in the changed docs.** Verified
      by concept search: no "≤2 median", "≤3 rounds", "4–5 rounds" or
      equivalent framed as a goal. Recording a count is fine; targeting one is
      the defect.
- [ ] The C9 size bound is written **with its threshold marked provisional**
      and pointing at the ledger as what replaces the guess.
- [ ] David can point at each of his three questions and see it answered in the
      merged docs.
