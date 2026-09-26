<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->
# Reconciling prose with a landed design change: sweep, never patch

**This file is the only statement of the method.** `claude-core.md` and
[`known-failure-patterns.md`](known-failure-patterns.md) point at it; the
`prose-sweep` skill enacts it and `scripts/sweep-scope.mjs` fixes the scope.
A second copy is a second thing to drift, which is this failure one level up.

**When it runs.** A retirement: a rule replaced, a mechanism deleted, an
authority moved. A change that adds a rule without retiring one has nothing
to sweep for. **And it runs again after every batch of fixes** — each patch
seeds fresh instances of the class it patched (two of twenty-seven in the
2026-09-20 run were sentences written in the two preceding batches), so a
sweep that is not cheap enough to re-run is always one batch behind.

---

## Why patching fails, measured

AI-Handbook #96 replaced the review loop's binding-disposition and
critical-only model. The mechanism landed; the prose did not follow. Three
author-side reconciliations each declared the class closed and each missed
instances the next reader found — 4, then 3, then 3 — and a fourth pass by
four cold readers found 27 more in 13 files after the class had been closed
three times.

**The comfortable diagnosis is wrong.** The residue does not sit somewhere
unexpected. Every known miss was within a screen of an edit the author had
just made; one was a context line inside the previous sweep's own diff hunk.
Predicting *where* to look is not what was missing.

**Three things were.**

1. **A phrase list is the wrong index.** Patching hunts the face of the class
   the author has already seen, and an entire opposite face — "to
   convergence" against "one triage" — goes untouched. A phrase list built
   from what you have seen cannot contain what you are about to write.
2. **The class has several sub-shapes, and one of them carries none of the
   class's vocabulary.** For "when a loop stops": a cap; a write with no
   review after it; an artifact class selecting loop *length*; and unbounded.
   Four instances in one skill file were found only because the second shape
   was written into the brief.
3. **The author reads a stray clause of the old model as consistent, because
   they know what was meant.** That is a property of the reader, not the
   method. A further method run by the same reader has a poor prior whatever
   its shape; the author's index is their memory of what they wrote, and
   that is the index that fails.

---

## The spec: what a sweep is given

Four inputs, written before any file is opened. The script refuses a spec
missing any of them.

- **The rule** — one sentence naming what is being swept for, by meaning.
- **Its home** — the one file **and section** whose statement is
  authoritative. Everything else may only *cite* it. The script refuses a home
  with no `#section`: an anchorless home hands the readers a whole file that
  may carry several live rules, which is the exact condition the sweep exists
  to detect, installed as its starting point. **It does not check that the
  named section exists**, and that is deliberate — step 1 below is read the
  home first, and a wrong anchor is a finding every reader makes in minutes.
- **Sub-shapes, as a closed list** — the distinct forms an assertion of the
  retired rule takes, enumerated by *shape*, never by wording, with one
  example each. Expect three to six; one is always an undercount. **Two of
  them are structural rather than lexical and are the ones a first list
  omits**: the rule stated correctly but homed on a *superseded* authority,
  and the rule homed on a *live* authority that answers a different question.
  The second is the harder one — nothing in the sentence is stale, so no
  vocabulary reaches it — and a not-in-class list naming that live rule as
  out of class will clear every instance of it mechanically. A reader
  may add a shape mid-sweep, and a shape added by a reader is worth more than
  the instance that prompted it — **and it reopens the sweep**: every file
  cleared before the shape existed was cleared against the old list, so the
  spec is amended and the whole scope re-dispatched against it before the
  sweep can be called complete.
  **What reopens the sweep is a shape, not a sharper way of describing one**,
  and the test is mechanical: could a file already cleared be hiding this? A
  shape whose every instance is already in hand under the existing list
  refines a *detector* and is written into the method; a shape that makes a
  previously-cleared file newly readable reopens. Measured both ways on
  2026-09-20 — sub-shape *g* reopened the sweep, and the second pass found a
  hit inside a file the first pass had read in full and cleared, while "the
  half-fixed paragraph" produced nothing the existing list had not already
  returned and became a detector instead. Without this test the rule recurses
  forever, which is this repository's own
  [`known-failure-patterns.md`](known-failure-patterns.md) entry about a loop
  where each round finds a defect in the previous round's fix.
  **A shape of a different class does not reopen this one either**, and that
  is the harder call, because such a shape is usually real. On 2026-09-23 a
  reader named a live defect — a remedy list answering the sequence problem
  with a per-finding rule, the sequence bound unnamed — and argued it should
  reopen. It was declined for this run: the class being swept was *what scopes
  a rule*, and this is *a rule missing from a list that needed it*. Nothing
  about the passage states the scope wrongly, so no amount of sweeping for
  wrong scope statements would have been clearing it. It is a class of its
  own, with its own spec, and it was filed as one. **The test to apply is not
  "is this shape real?" but "is it a form of the thing this run is hunting?"**
- **Not-in-class, as an explicit list** — what a reader must *not* return.
  Without it, readers return the repository's entire history section. This
  list is as load-bearing as the class: it is the only part of the output that
  can detect a bad class definition, so the readers' declined candidates are
  audited against it (below), and a live mechanism the class's wording would
  catch is named here rather than left to a reader's charity.
  **An exclusion excuses an APPLICATION, never a DERIVATION**, and getting
  that backwards is how a not-in-class list swallows real hits. Measured
  2026-09-23: an exclusion read "a file applying the rule to one plainly
  qualifying artifact of its own", which is sound — but the passages it
  cleared all reasoned *"internal tier, **so** the limit bounds it"*, and
  deriving the rule from the class is precisely what the rule forbids. Two
  readers declined those passages under the exclusion as written and both
  said in their declined lists that the reasoning was the defect. That is the
  audit working, and it only works because declining is mandatory and reasoned
  rather than silent.

## The checkable property is structural, not lexical

The test that found 27: **does any file other than the rule's home make a
statement *about* the rule, rather than pointing *at* it?** A file can be
wrong by omission — state correctly what ends a loop and never name the rule
that does — and no grep finds that, because there is no wrong phrase. The
briefs the review loop's own advisors read every round were exactly that
case. So a reader's question per file is *does this statement cite the home
and agree with it?* Residue is a statement that is **uncited or disagrees**.

**The citation must be to the home's SECTION, not merely to its file**, and
that is not pedantry — it is where the 2026-09-20 run's two
highest-consequence hits lived. Both cited the right file, one with a deep
anchor link, and both named the wrong rule inside it. Any cross-check built on
grep or on link-validity passes them, which is the whole reason this is a
reader's job. Two detectors follow from it, each measured:

- **Loop-length homed on a live rule that answers something else** (sub-shape
  *g* below). The distinguishing question is never *is the cited rule live?*
  but *does the cited rule answer the question this sentence is asking?*
- **The half-fixed paragraph.** The home's correct citation has been added
  *beside* the old homing rather than replacing it, so both are live in one
  breath and a reader who stops at the bolded or parenthesised clause gets the
  superseded answer. The home *is* cited, so an author checking "did I cite
  it?" clears it.
- **The citation whose referent does not exist** — "the rule above", "as
  stated earlier" — pointing at a statement that is not there. Measured
  2026-09-23: a role brief read verbatim into every dispatch said "the
  two-review limit above", and the file's only other statement of it was
  fifty-nine lines *below*; the dispatch package never placed it ahead of the
  brief either. It reads as cited, so it suppresses the instinct to go
  looking, and it defeats a link checker completely because there is no link.
- **The citation that reaches the right section and names the wrong sub-rule
  inside it.** Same run: an enactment cited "the limit's step 3" as the
  authority for three questions step 3 does not contain. A reader who follows
  it to check finds a step saying something else, and concludes the enactment
  invented them.
- **The scope posed as a question the step gives no method for answering.**
  The gate that actually runs a rule asks "is this internal tooling?" as a
  yes/no with no test beside it, having cited the home two hundred lines
  earlier under a different rule. Every check passes — the file cites the
  home, the link resolves — and the reader executing the gate still answers
  from the directory. **A test belongs inside the branch that asks it, not
  upstream of it.**
**A correct citation does not clear a flat scope statement at a decision
point**, and that is the one place the "cites the home and agrees" clearance
has to be read narrowly. A sentence that fixes the scope by tier name — "on
internal tooling the limit is …" — states the default *as* the scope, and the
anchor beside it only helps a reader who stops to follow it. The reader this
class is about does not: the #145 run's worst instance cited the home
correctly two hundred lines earlier and the gate still answered from the
directory. So the test is where the sentence sits. An overview that routes
onward ("step 4 below is where this skill enacts it") is a citation with
context; the same words at the moment the question is answered are residue.
Measured 2026-09-23: three such sentences, each anchored, each in a file
stating the test correctly elsewhere, all three surviving two remediation
sweeps that had read past them.

Otherwise, a restatement that cites the home and agrees is a citation with
context and stays — the oracle's own words are "agrees or points at it". The fix for
residue is a citation of the home, never an *uncited* better restatement: that
is a fresh copy that will drift, and two of the 2026-09-20 hits were correct,
uncited restatements written in the preceding batch.

## Scope is the whole payload, never the files under edit

Of 13 files carrying instances, 4 were touched by the change that created the
rule; 12 instances were in files no diff-derived list would name. The scope
is therefore the whole payload by default, and **includes the directories a
docs-shaped scope misses**: `.agents/roles/**`, `.claude/agents/**`,
`.agents/memory/**`, and the root `CLAUDE.md`, `AGENTS.md` and `README.md`.
Two of the highest-consequence instances were in the role brief and the agent
definition the two assessors read verbatim on every round. The scope is
enumerated by `scripts/sweep-scope.mjs` from the tracked set, so it cannot be
narrowed by hand or by ignore rules.

**Its one boundary, stated because "the whole payload" would otherwise mislead:
the default scope is Markdown.** Agent-facing prose is not always in a `.md` —
a script can compose an instruction in a string literal — and a sweep that
reported the payload clean while such an instruction sat outside what it read
would be this repository's worst failure shape, a control that reports success
having evaluated nothing. So `--include` is matched against **everything git
tracks**, not against the Markdown filter: the filter is the default, never a
ceiling. Sweeping every script by default is the wrong default in the other
direction, since it puts comments and identifiers in front of readers hunting
prose, so reaching one is a decision the operator makes and records in the
spec. (Codex, #141 round 6.)

## Cold readers, two reading modes, each declared

A reader who did not write the new model reads against the whole list, not
the shape its section is about. Readers are fanned out by directory, each
holding no author context. A full read of everything is unaffordable, so two
modes exist and **each reader declares which it used per file**:

- **Read in full** — the rule's neighbourhood, named in the spec: every file
  where a vocabulary-free sub-shape could plausibly live, because only a full
  read can find one.
- **Swept** — opened by heading and front-matter, searched for the vocabulary
  of **every sub-shape's example** (not the class's name — at least one shape
  carries none of it) with each hit read in context, escalated to a full read
  on any hit. A swept clearance is weaker than a full read: it can miss a
  vocabulary-free shape in a file nobody expected to carry one, and the
  inventory line is what makes that weakness visible rather than silent.

The declaration (`OPENED n / READ IN FULL n / SWEPT n`, then the per-file
mode) is what lets a human distinguish a clean file from an unread one.
Without it a silent file and an unvisited file look identical.

## What a reader returns

**Per candidate:** `path:line`; the sub-shape; the sentence **verbatim**; why
a reader of that file goes wrong; and a confidence of `high`, `medium` or
`low`. Confidence survives to the report and is never thresholded away: the
2026-09-20 split was 5 high / 14 medium / 8 low, and a low-confidence hit in
an assessor brief was still worth a human's eye because the file never named
the rule. A tool that returns only `high` returns 5 of 27.

**Per reader:** the inventory declaration above, and **every declined
candidate with the exclusion that resolved it**. Declined candidates are
mandatory, not a courtesy: they are how the author audits whether the
not-in-class list is swallowing real hits.

## A decline is only good while the passage's siblings are unchanged

**A batch that fixes one position of a claim invalidates the declines on the
others**, and this is the sharpest reason the re-run is not optional. Measured
three times on 2026-09-23, in one afternoon: three passages declined in a
first run as consistent with their neighbours came back in the re-run — one at
*high* — for no reason other than that the batch had corrected the sibling
sentence. A paragraph that was one of several saying the same loose thing
becomes, after the batch, **the only one that still says it**, which is a
different and worse defect than the one declined: the file now contradicts
itself, and a reader meeting the unfixed half has the fixed half to argue
against.

So a decline is scoped to a tree, not to a sentence. Re-reading the declined
list after a batch costs nothing — the candidates are already written down —
and it is where the batch's own damage shows up first.

## After the run

The author verifies each candidate in the checkout before writing anything;
a reader's quote is a claim, not a finding. Residue is fixed by citing the
home. History — a sentence naming the retired thing *as* retired, with its
replacement — stays. The record goes in the PR body: the spec as swept, the
inventory, what was fixed, and what was declined with its exclusion, so the
next sweep is re-run rather than re-invented. Then the sweep runs again over
the batch, with the spec as amended by any shape a reader added.

**Anti-goal: this is not a phrase checker.** The class was un-greppable in 12
of 27 cases, including all three of the highest-consequence ones. Grep is a
cross-check for a reader, never the method.

**Second anti-goal, and it cost more to learn: the script does not re-check
what a reader checks anyway** (David, 2026-09-22). The tool exists for one
reason — to make a sweep one command, so it is cheap enough to re-run after
every batch. Anything beyond that competes with the readers rather than
serving them. A validator confirming the home's `#section` really existed grew
to a third of the script (GitHub's slug algorithm, Setext headings,
inline-Markdown rendering, fence tracking), absorbed five of six review rounds
on the pull request that built it, and caused two regressions of its own —
to guard against a mistake the first minute of every run already surfaces. The
payload contains no heading with a link, no `~~~` fence and no Setext heading;
every one of those cases was hypothetical, and every finding about them was
correct, which is what makes the trap hard to see from inside. **The test is
not "could this input break it?" but "what happens if it is wrong, and who
notices first?"**

---

## Worked instances

### The #96 / #134 review model (AI-Handbook #121, PR #141)

Six propositions, of which (e) and (f) were added by cold readers mid-sweep
and (e) was proposed independently by three of six:

| | Retired proposition |
|---|---|
| a | A judge whose verdict binds |
| b | A tier or artifact class that selects a strictness, rubric or threshold |
| c | A fixed reply form or length for a decline |
| d | An expected decline or fix rate |
| e | A loop bounded by a *retired* count or mechanism: the self-policed apparatus deleted 2026-08-20 (criticality gate, finding-count trend, plan-growth tripwire, oscillation diagnosis); the per-PR round budget with its receipts, extension grants, round-count cache and readiness receipt (#89 cut); and "convergence" as the exit condition |
| f | A plan review that opens a branch and a PR |

**Not in class**, and this list was missing from the first run — round 1 of
#141 found that (e) as first written would have caught live safeguards: the
six-hour stop that asks David to resume; pre-registered flip conditions;
the ship gate; no-re-request-without-a-behavioural-change; and the docs-only
depth rule, which governs what a reviewer *raises* and survived #96.

**The control.** Three instances were known before the run and withheld from
the readers. All three came back, from three different readers.

### When a review loop stops (2026-09-20, PR #141 round 2 — the tool's first run)

Spec: the write-gate rule as home — **superseded on 2026-09-19 by the
two-review limit, and that supersession is itself the next instance below**;
four sub-shapes (a cap; a write with no review after it; a class selecting
loop length; unbounded); six exclusions.
`sweep-scope.mjs` put 156 files in scope, 18 read in full, four workers.
Readers returned 33 candidates (5 high/medium-high, 14 medium, 14 low) and 90
declined with their exclusion; 20 were fixed, 13 declined. Three readers
independently named the same shape not on the list: **the rule stated
correctly but homed on a superseded authority** — `code-review.md` hung the
write-gate on "the internal tier (2026-08-21)", the ending the rule replaced;
the skill that runs the loop named no home at all. Two hits were sentences
written in this PR's previous batch. Declined as a class: the retired
vocabulary used in the negative ("is not convergence"), which asserts nothing
about the stop; and vendored in-session review templates, which are not the
PR loop.

### The two-review limit (2026-09-20, PR #141 rounds 5-6 — the method reopening itself)

`main` acquired the two-review limit mid-loop, which moved this class's home:
what ends a loop is no longer the write-gate rule but a count. So the same
class was swept again against the new home, over the merged tree, 157 files,
four readers. **#142's 27 previously-catalogued instances were withheld from
every reader** as a control, and came back independently.

The run's own findings, which is why this section exists:

- **All three of the loop's advisory documents named the wrong rule.** The
  review proxy's brief, the Fable assessor's definition and `pr-watch` each
  told their reader a loop ends under the write-gate rule, and none of the
  three named the limit anywhere. These are read verbatim into every dispatch,
  so the advisers on every round held a stopping rule the contract had
  replaced. All three sentences were written by the *previous* pass of this
  same sweep, which had homed them on the write-gate — the clearest measurement
  yet that a sweep is one batch behind by construction.
- **The change that retired convergence reintroduced it.** #140 added the
  limit and, one paragraph below its own rule, sent excluded machinery "under
  the ordinary convergence the tier it earns carries".
- **A reader added sub-shape *g*** — loop length homed on a *live* rule that
  answers something else — **and the sweep reopened.** The second pass then
  found a hit the first had cleared in a full read: the home's own section
  headed *Review loops need a stopping rule* enumerated what replaced the
  deleted apparatus and named three live rules, none of which stops a loop,
  omitting its own child subsection. That is the measurement behind the
  reopening test above.
- **A second proposed shape did not reopen it.** "The half-fixed paragraph"
  returned only instances already in hand, so it became a detector.

### What scopes the two-review limit (2026-09-23, issue #145 — the tool's first run as merged payload)

The class #141 produced and could not see. `main` scopes the limit by
consequence, with "internal tooling" as a convenient default; restatements
across the payload had turned the default into the scope. Two passes, four
cold readers each, 157 files. **#145's own catalogue was withheld from every
reader** and came back independently, which is the control holding a third
time.

- **The worst instance was the enactment, not a description.** The gate that
  actually runs the limit asked "is this internal tooling?" as a bare yes/no
  with no test beside it. A credential-rotation script answers yes from its
  directory and iteration stops on machinery the rule exempts. The file cites
  the home correctly two hundred lines earlier, under a different rule — so
  every check a tool can run passes.
- **A reader added the inverse shape and it reopened the sweep**: the limit
  stated as *universal*. Every other shape narrows it wrongly; this one widens
  it, carries none of the class's narrowing vocabulary, and was therefore
  invisible to all three vocabulary passes the first four readers ran. Its
  clearest instance was in the home file itself, forty lines from the row that
  contradicts it.
- **Two further proposed shapes did not reopen it**, on the two tests above:
  one was already caught by an existing shape, and one belonged to a different
  class and was filed as its own.
- **The exclusion list was too broad**, found by two readers independently in
  their declined lists rather than their candidates.

**What the first run got wrong, and the second constraint set fixed.** Its
file set was the issue's, not the payload's, so the two assessor briefs, the
`document` skill and `documentation-workflow.md` were never opened and all
four carried the class. Its brief enumerated propositions, not sub-shapes,
so "a write with no review after it" was never hunted. Its readers had a
binary `BORDERLINE` where a confidence band belonged. Every one of those is
now a rule above.
