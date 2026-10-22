<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The UAT format

**One shape, so driving a run is a lookup rather than a parse (David,
2026-08-22). One home, the pull request body, so the script has no file
lifecycle of its own (David, 2026-10-21).**

The `/uat` session walks David through a UAT script step by step. For that to
be reliable, the driver has to know *exactly* what the steps are — and the way
to guarantee that is not a cleverer parser. It is a format we control and
always write.

**Where it lives: the `## UAT` section of the PR body**, written with the
diff and reviewed with it in the same Codex pass, exactly as the Post-merge
verification section is. Until 2026-10-21 the script was a file,
`docs/tests/UAT/PR<N>_<FEATURE>_UAT.md`, and the file carried a lifecycle
the script never needed: a PR-first dance to learn the number for its name,
a deletion PR per completed run (every change to `main` arrives through a
pull request), a correction PR for a wrong `Expect`, a later PR editing
other PRs' docs to retire a `Deferred:` line, and a guard that went on
policing finished-but-undeleted docs whose cited files had since been
renamed. The `uat` skill had already stopped trusting the file as a signal
— *"a doc's presence on `main` proves its PR merged, nothing more"* — and
read the workstream's `stage:uat` label instead, which is the oracle now.
Nothing else moved: the lanes, the step shape, the run record on the
workstream issue and the verdict roll-up are unchanged. David's reasons are
the TEST_RUN file's (`pr-docs`, 2026-08-15): the script is part of the PR's
claim, and a separate near-zero-stakes artifact with its own lifecycle is
ceremony. A **legacy doc** still in a consumer's `docs/tests/UAT/` on
`main` is driven from the file and deleted when its run completes, under
the rules this format carried before; no new file is written.

**Why this document exists.** The first version of `/uat` tried to infer the
step list from whatever shape a doc happened to have. It couldn't: across the
25 docs in `docs/tests/UAT/` at the time there were six-plus conventions for
the regression section alone, eleven docs had no numbered steps of any kind,
and two review rounds found five separate ways the inference broke. Every
finding was one symptom of writing a parser for a format we own. The fix was
to define the format and regenerate every doc to it (PR #560 closed unmerged;
the redesign is what shipped).

## The rule that makes it deterministic

> **A step is any `#### ` heading inside `### Steps` or `### Regression` of
> the PR body's `## UAT` section, in document order. Nothing else in the
> body is a step.**

That is the whole contract between the author and the driver. `/uat`
enumerates steps with a heading scan bounded by those two sub-sections,
inside the one section bounded by the next `## ` heading, and needs no
judgment about what is "actionable." Everything else in the body — the
oracle, the verification section, the decisions, the framing prose inside
the section itself — is context for David or for me, and never produces a
prompt. (A legacy doc under `docs/tests/UAT/` is the same rule one heading
level up: `### ` inside `## Steps` or `## Regression`.)

Two consequences worth stating, because they are what the rule buys:

- **Coverage is countable.** "7 steps and 4 regression checks" is a fact the
  driver reads off the section, not an estimate. The acceptance roll-up in
  `/uat` quantifies over exactly this list.
- **Regression checks cannot be silently dropped.** They are steps, in the
  same list, with the same statuses. The failure that motivated this format
  — passing every feature step and declaring the run accepted while the
  regression sweep was never run — is not expressible.

## Lanes: where each step is verified (David, 2026-10-07)

**Every step names exactly one lane, and only the human lane reaches David.**
David is the slowest verifier in the system; a mechanical step that reaches
him spends his time on something a machine does better. The lane is chosen
when the step is written, not when the run starts; a `human` label over a
screen fact is an authoring error, and `/uat` runs that step itself rather than
hand it to him (the rule's home: the `uat` skill, *Where the browser
automation lives*). What an image an AI model generated shows is not a
screen fact beyond what anyone would verify the same way; the rest is
David's (*An image an AI model generated*, below).

| Lane | Who verifies it | When it runs | What a step in it must carry |
|---|---|---|---|
| `ci` | an automated test in the per-PR gate | every PR | `**Check:**` citing the test file (optionally `file:test name`) |
| `scripted` | a scripted proof, re-runnable on demand — an acceptance journey, a script with recorded evidence | on demand, and before the run is accepted | `**Check:**` citing the spec, script or command |
| `live` | a **read-only** check against the deployed environment or a real vendor, through the live-environment connector — one that would start a paid AI run is not read-only (below) | at run time | `**Check:**` citing the command or procedure; any state it needs is a Setup `[claude]` line with its `[restore]` |
| `capture` | Claude, reading an image a script captured at the commit under test — the step's result is that reading, never the script's exit status | at run time, before David starts | `**Check:**` citing the capture script, optionally `file:shot name`; an `Expect` describing the screen so it can be answered yes or no from the image alone — for an AI render, only what anyone would verify the same way (below) |
| `human` | David's judgement: taste, legibility, whether it reads right, what an image an AI model generated shows beyond what anyone would verify the same way (below), or something only his own account or device can do | in the `/uat` session | `**Judgement:**` saying what only he can judge or do, and why no machine can |

**A machine-lane check is self-contained.** It never depends on state a
human step produces, so every machine step can be resolved before David
starts. A check that can only be answered after his own action belongs to
that human step's record (read after his "yes", before recording Pass), or
the step is `human`. The rule below about one step needing what an earlier
step created is a rule for human steps.

**A step is `capture` when its answer is only in pixels** (David,
2026-10-16, Overhype.me #631 increment 8): text, placement, typography or
framing the product's own code draws into an image, a canvas preview, or
what anyone would verify the same way in a real AI render (limited below). No DOM assertion can read those, and they are
not taste, so they are neither `ci` nor `human`. The capture script proves
only that the image exists; the step passes or fails on Claude's reading of
it, clause by clause. There is no baseline image to compare against: an
`Expect` that would say "looks as it did before" is written as the screen it
should show. A capture that needs a paid vendor runs within David's
paid-run budget and asks above it (the paragraph after next), under any
tighter cap the consumer declares, and is never the `live` lane, which stays
read-only. (The run-time mechanics are the `uat` skill's, *Where the browser
automation lives*.)

**An image an AI model generated is read only for what anyone would verify
the same way** (David, 2026-10-17, Overhype.me #708: *"You should only do
fully deterministic testing such as 'does a speech bubble appear and does it
say "hello world"' … You shouldn't be making any judgements about the quality
of the content, is it funny, does it capture the essence of the joke … I'll do
all of the checking of generated imagery"*). For a real AI render, a
`capture` step's reading carries only those clauses — a speech bubble
appears and reads a given text — beside what its script asserts without
looking (the render completed, the image decodes at the size asked for).
Everything interpretive about generated content is a `human` step with its
`**Judgement:**` line, never a capture reading: whether it shows a person,
the right person or any particular thing, whether the scene fits, whether
it is funny or good, and whether its content is acceptable or safe — unless
the answer is as plain and checkable as the text in a bubble. These steps
are `human` by this rule even though a model could offer an answer, and in
doubt about such a clause the step is `human`; their `**Judgement:**` line
names the content judgement. The rule binds every check that looks at
generated content, whatever its lane — a `capture` reading, a `live` check
against a real vendor, a `scripted` journey, and a prototype's scaled machine
lanes — since David's words cover *"any tests"*: none of them judges what a
generated image shows. It narrows nothing else; text, placement, typography
and framing the product's own code draws stay `capture`.

**A paid AI run proceeds within David's budget and is reported with its
cost; above it, the run asks first** (David, 2026-10-21: *"Limit it to
$5/run and set a weekly budget of $25 just in case."*, on the irreversible
list in `agent-working-rules.md`, *A reversible choice proceeds on the
recommendation*; until then every paid run needed his go-ahead in words —
David, 2026-10-17: *"There's no point in capping the cost to a few dollars
if you're going to be running the tests hundreds of times"* — and that
sentence is why the budget is small and the week's total is counted),
whatever its lane — a `capture`, a `scripted` journey, a `live`
check, a prototype's scaled machine lanes, a Post-merge verification step,
a diagnostic reproduction on the live system. A paid AI run is a call the
check makes to a paid AI vendor (a real render, a real model call); the
review loop's own assessors are not checks and keep their own rules.
A run that would cost more than $5, or take the week past $25, asks first,
naming the paid calls and the worst-case cost; one within both proceeds, is
never run in a loop or a series that would pass the week's total, and
reports what it cost in the turn's spend line. **The week's total is read,
never remembered** (2026-10-21, after the first build report found the $25
had no record any session could read). **The $25 is one total across every
product** (David, 2026-10-22: *"$25/week is across all products."*), so there
is **one ledger for the fleet**: an open issue in the handbook's repository
(`PAID_RUN_LEDGER_REPO` in `machinery.mjs`) labelled `paid-ai-ledger`, opened
at the fleet's first paid run, and every paid run in any product adds one
comment to it — the date, the product, what ran, and what it cost, under the
disclosure check, since that repository is public. Before a paid run, every
comment from the trailing seven days is totalled, whichever product it
names; that total plus the run's worst case is what is held against $25. A
run whose cost was not recorded is counted at its worst case. A session
whose GitHub access does not reach the handbook attaches it (`add_repo`,
push access, since it writes the comment) before the run; one that still
cannot read the ledger cannot know the week's total, so the run asks first,
as one above the budget would. A spending cap the consumer
declares bounds a run below the fleet's, never above it, and a check that
would start a paid run is never read-only. It is never a `ci`
check either: CI runs on every push, so nothing could keep it inside $5 a
run or $25 a week across every product.
Checks that start no paid run carry on as their lane says.

**A step is `human` only when no machine can answer it** — or when it
judges what an image an AI model generated shows, which is always David's
(above). "The banner reads '4 of 4 done'" is not judgement; it is an
assertion a test can make. "The meme is funny and the caption is legible"
is judgement. When in doubt, the step is machine-lane and its check is
written in the same PR, except about generated content, where doubt makes
it `human`.
**The lane is read from the `Expect`'s clauses and from who can perform the
`Do`, never from the heading or the verb** (David, 2026-10-15). "Reads
well", "looks right" and "renders correctly" name the author's hope, not who
can verify it: an `Expect` that says what the screen shows — a sentence, a
status, an element, nothing overflowing a panel — is machine-lane for those
clauses, and the one clause that is judgement ("it is readable") is a
`human` step of its own; a `Do` only his own account or device can perform
keeps the step `human`, with its screen facts read after his "yes" (the
self-contained rule above). A step
whose heading is a judgement over a mechanical `Expect` is the shape that
puts a screen check in front of David (Overhype.me PR #687, steps 4 and 5,
2026-10-15); `/uat` runs such a step itself, in a real browser at the
commit under test, and records the script as wrong. The rule's home, with the
run-time mechanics, is the `uat` skill, *Where the browser automation
lives*; this paragraph is the authoring half.

**A `human` step says why, in one `**Judgement:**` line** (David,
2026-10-16): what only David can judge or do, and why no machine can — "his
own Google account on his own iPad", "whether the message is readable".
Only a `human` step carries the line. It records a claim review can test;
the guard checks it is there, never that it is true. A judgement about what an
image an AI model generated shows is never an empty `Judgement`, whatever a
model could say about it (above). A step whose honest
`Judgement` would be empty is not `human`: it moves to the machine lane its
`Expect` belongs to, rather than gaining a line written to satisfy the
guard.

**`**Deferred:** #N — <why>`** marks a step that cannot run in its lane yet
— its feature is being rebuilt, or the double its check needs does not exist
yet. It names the issue that owns it. A deferred step is **never a pass**:
`/uat` lists it as outstanding, and when it is the only evidence for a
behaviour the PR claims, the run cannot be Accepted. A deferred machine-lane
step may omit its `**Check:**`; one it does carry (partial evidence kept for
the owner) is validated like any other. The PR that lands #N replaces the line with
its runnable `**Check:**` in every script still deferring to it — an edit
of the owning PR's body, one call, said on #N — and a legacy doc the same
way, in its file. A behaviour a
*later* PR delivers has no step here at all: it belongs in the oracle's scope line, not in this section.

**Three records, never merged.** The **lane** (where and how a step is
verified) lives in the script. Whether the obligation is met now, deferred, or
retired — the **disposition** — is the `**Deferred:**` line or its absence.
The **result** (what actually ran, on which commit, with what evidence) lives
in the run record `/uat` writes on the workstream issue, never in the script.

## The template

The section sits in the PR body among the body's other sections — after the
oracle and the Post-merge verification section is the usual place — and ends
where the next `## ` heading begins.

```markdown
## UAT

<One or two short paragraphs: what changed and why he cares. If he made a
decision that a step deliberately checks, say so here so the result reads as
his decision rather than a gap.>

### Setup

- [claude] <something I do before he starts>
- [david] <something only his own session or device can do>
- [restore] <what I put back when the run ends or pauses>

### Steps

#### 1. <Short imperative title>

**Do:** <the exact action — where to click, what to type>

**Expect:** <the judgement only he can make — taste, legibility, whether it reads right, what an AI-generated image shows beyond what anyone would verify the same way>

**Lane:** human

**Judgement:** <what only he can judge or do, and why no machine can>

#### 2. <…>

**Do:** <…>

**Expect:** <the exact observable result — a screen fact is this lane's, never his (what an AI-generated image shows is not a screen fact: *Lanes*)>

**Lane:** ci

**Check:** `<path/to/the.test.ts>`

#### 3. <…>

**Do:** <…>

**Expect:** <the screen described, answerable from the image alone — the words drawn on the picture, where they sit; for an AI render, only what anyone would verify the same way (*Lanes*, *An image an AI model generated*)>

**Lane:** capture

**Check:** `<path/to/capture.spec.ts:shot name>`

#### 4. <…>

### Regression

#### R1. <Short title>

**Do:** <…>

**Expect:** <…>

**Lane:** scripted

**Check:** `<path/to/acceptance.spec.ts>`

### Not bugs

- <something that looks wrong but is out of scope or intended>
```

## Rules for each part

**The heading.** Exactly `## UAT`, once per body. The guard and the driver
match it exactly, so `## UAT run` (the run record's heading on the
workstream issue) and `## UAT notes` are not it. The PR's own number and
title identify the script; it carries neither.

**`### Setup`** — every line is one of exactly three tags, or `None.` on the
first line, optionally followed by a sentence saying why.

- **`[claude]`** — mine to execute before he starts. Seeding rows, putting
  config in a known state, confirming the Repl is synced. Anything mechanical
  that stands between him and step 1 belongs here, not in a step.
- **`[david]`** — only his own session or device can do it: signing in as
  himself, using a real phone, a live Stripe account. Keep these few; each
  one is friction he has to supply.
- **`[restore]`** — what gets put back. Required whenever a `[claude]` or
  `[david]` line changed live state — admin-gated setup is his, so its
  restore is too. It names **what** to restore and says the original was
  captured before the write: `budget_limit_legendary_usd — restore to the
  value captured before step 1's change`.

  **It must not name the value itself.** A script is written before the run, so
  it cannot know what the live setting will be; a number written here is a
  guess, and restoring a live limit to a guessed number is worse than not
  restoring it at all. The captured value belongs in the run record, which
  is written at run time and is where `/uat` reads it back from. (This rule
  exists because the first version of this spec demanded the value, and a
  conversion duly invented one from a seed file.)

**`### Steps`** — the feature under test. One `#### <n>. <title>` per step,
numbered from 1, each with exactly one **Do:**, one **Expect:** and one
**Lane:**, plus a **Check:** for a machine lane, exactly one **Judgement:**
for a `human` step and none on any other, and at most one **Deferred:**. For a machine-lane step, **Do:** and **Expect:** still say
what the check does and asserts, in words, so the script reads the same for a
human and the check's coverage can be reviewed against it.

- **One action per step.** If a step needs "then also check", it is two steps.
  The driver presents one step per turn, so a compound step produces a
  compound answer and a muddy record.
- **`Expect:` is an oracle, not a hope.** Something its lane can answer yes
  or no to. "The page loads correctly" is not; "a bordered table listing
  chapters 1–12, and a search box above it" is — and that one is a screen
  fact, so its lane is a machine's, not his (*Lanes*, above).
- **Never reference another step's state implicitly.** If step 4 needs what
  step 3 created, say so in step 4's **Do:**, because a resumed run may start
  at 4.

**`### Regression`** — what must still work, unchanged by this PR. Same shape,
IDs `R1…Rn`. These are steps in every sense that matters: they are presented,
recorded, and counted toward the verdict.

- Keep them short and cheap. They are a sweep, not a second test suite.
- Include one only if this PR could plausibly have broken it. A regression
  check nobody believes in gets skipped, and a habit of skipping is what the
  format exists to prevent.
- **A PR that genuinely couldn't break anything writes `None.`** — the same
  escape the Setup section has, and a sentence after it saying why is
  encouraged, because a bare `None.` reads as an oversight. The section stays required so its absence is
  never ambiguous, but an empty sweep is a legitimate answer and saying so
  beats padding. (Also learned the hard way: requiring a non-empty sweep made
  three conversions invent checks nobody had written.)

**`### Not bugs`** — known limitations, out-of-scope oddities, anything that
looks wrong and isn't. Bullets, no steps. This is what stops David reporting
the same non-issue twice.

## What the format deliberately does not have

- **No bug-report template.** `/uat` files the bug during the run, with the
  evidence in front of it. A template was for reading the script alone.
- **No "if something's wrong" section.** Same reason.
- **No timings, no "~4 min" annotations.** They were always guesses and they
  age badly.
- **No Parts, Tests, Sections, or any second naming scheme.** One list of
  steps and one list of regression checks. If a script feels like it needs
  parts, it is testing two things and wants two PRs.
- **No file.** The script is the PR body's `## UAT` section (above). There is
  nothing to name after the PR number, nothing to delete when the run
  completes, and nothing to keep drivable after it: a merged PR's body is
  history, and the run record on the workstream issue is where the result
  lives.

## Who writes one

`pr-docs` — every feature-mode PR with product-visible behavior **in
production phase** (a prototype-phase version ships no UAT section; its
scaled machine lanes and the owner's feedback are its verification —
[`working-modes.md`](../ai-context/working-modes.md#the-prototype-phase-per-feature-david-2026-09-26),
*What prototype phase keeps of verification*), in the PR body before the
PR opens, with the checks for its machine-lane steps written in that same
PR; a Tier B bugfix with product-visible behaviour writes one the same way
(`bugfix`, step 3). The workstream issue's State of Play names the PR as
carrying the UAT, which is where `/uat` reads the script from once the
`stage:uat` label says a run is owed — the label discovers the run, the
field locates the script. See [`pr-docs`](../../.claude/skills/pr-docs/SKILL.md).
`/uat` **consumes** this format and never authors it.

## The guard

`node scripts/check-uat-format.mjs` enforces the structure and the lanes: a
lane per step, a backticked check for every non-deferred machine-lane step,
every supplied check non-empty and backticked with any cited file existing,
deferred or not, an owner on every deferral, and exactly one non-empty
`**Judgement:**` on every `human` step and none on any other lane. It checks
formatting and file existence only — not that a named test exists in the
file, not whether a cited check really asserts what the step expects, and
not whether a `Judgement` is true; that stays with review.

**It reads the PR body.** In CI it takes the body from the `pull_request`
event payload (`GITHUB_EVENT_PATH`) and checks cited files against the
checkout; locally and in its tests, `--body-file <file>`. A run that is not
a pull request event has no body and passes, saying so; a run with no
source at all refuses, since a guard that reports success having evaluated
nothing is the worst available failure. A body with no `## UAT` section
passes: whether one is owed is `pr-docs`' and `pr-watch`'s judgement, and
a docs PR, a Tier A fix and a prototype-phase PR all owe none. **The
consumer's workflow lists `edited` among its `pull_request` trigger types**,
so an edit to the body after the last push re-runs the guard on the head
that would merge; without it the guard's last verdict is the body as of the
last push. After the merge nothing polices the section again — a merged
body is history, and the run record on the workstream issue holds what was
actually run.

**Nothing is deleted when a run completes.** Until 2026-10-21 the file was
deleted on David's confirmation, so a surviving file meant a run still owed;
the workstream's `stage:uat` label carries that state now, and `/uat`
discovers runs from it. A legacy doc still in `docs/tests/UAT/` keeps the
old rule — driven from the file, deleted by `/uat` when its run completes
— and the guard no longer reads that directory: its citations are checked
at run time, where a missing check Blocks the step.
