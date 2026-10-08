<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The UAT document format

**One shape, so driving a run is a lookup rather than a parse (David,
2026-08-22).**

The `/uat` session walks David through a UAT doc step by step. For that to be
reliable, the driver has to know *exactly* what the steps are — and the way to
guarantee that is not a cleverer parser. It is a format we control and always
write.

**Why this document exists.** The first version of `/uat` tried to infer the
step list from whatever shape a doc happened to have. It couldn't: across the
25 docs in `docs/tests/UAT/` at the time there were six-plus conventions for
the regression section alone, eleven docs had no numbered steps of any kind,
and two review rounds found five separate ways the inference broke. Every
finding was one symptom of writing a parser for a format we own. The fix was
to define the format and regenerate every doc to it (PR #560 closed unmerged;
the redesign is what shipped).

## The rule that makes it deterministic

> **A step is any `### ` heading inside `## Steps` or `## Regression`, in
> document order. Nothing else in the file is a step.**

That is the whole contract between the author and the driver. `/uat`
enumerates steps with a heading scan bounded by those two sections, and needs
no judgment about what is "actionable." Everything else in the doc is context
for David or for me, and never produces a prompt.

Two consequences worth stating, because they are what the rule buys:

- **Coverage is countable.** "7 steps and 4 regression checks" is a fact the
  driver reads off the file, not an estimate. The acceptance roll-up in
  `/uat` quantifies over exactly this list.
- **Regression checks cannot be silently dropped.** They are steps, in the
  same list, with the same statuses. The failure that motivated this format
  — passing every feature step and declaring the run accepted while the
  regression sweep was never run — is not expressible.

## Lanes: where each step is verified (David, 2026-10-07)

**Every step names exactly one lane, and only the human lane reaches David.**
David is the slowest verifier in the system; a mechanical step that reaches
him spends his time on something a machine does better. The lane is chosen
when the step is written, not when the run starts.

| Lane | Who verifies it | When it runs | What a step in it must carry |
|---|---|---|---|
| `ci` | an automated test in the per-PR gate | every PR | `**Check:**` citing the test file (optionally `file:test name`) |
| `scripted` | a scripted proof, re-runnable on demand — an acceptance journey, a script with recorded evidence | on demand, and before the run is accepted | `**Check:**` citing the spec, script or command |
| `live` | a check against the deployed environment or a real vendor, through the live-environment connector | at run time | `**Check:**` citing the command or procedure |
| `human` | David's judgement: taste, legibility, whether it reads right, or something only his own account or device can do | in the `/uat` session | nothing extra |

**A step is `human` only when no machine can answer it.** "The banner reads
'4 of 4 done'" is not judgement; it is an assertion a test can make.
"The meme is funny and the caption is legible" is judgement. When in doubt,
the step is machine-lane and its check is written in the same PR.

**`**Deferred:** #N — <why>`** marks a step that cannot run in its lane yet
— its feature is being rebuilt, or the double its check needs does not exist
yet. It names the issue that owns it. A deferred step is **never a pass**:
`/uat` lists it as outstanding and the run cannot be Accepted while it is
the only evidence for a behaviour the PR claims. A deferred machine-lane
step may omit its `**Check:**` until it is no longer deferred.

**Three records, never merged.** The **lane** (where and how a step is
verified) lives in this doc. Whether the obligation is met now, deferred, or
retired — the **disposition** — is the `**Deferred:**` line or its absence.
The **result** (what actually ran, on which commit, with what evidence) lives
in the run record `/uat` writes, never in this doc.

## The template

```markdown
# PR #<N> — <Feature in David's words> — UAT

**Workstream:** #<issue>

<One or two short paragraphs: what changed and why he cares. If he made a
decision that a step deliberately checks, say so here so the result reads as
his decision rather than a gap.>

## Setup

- [claude] <something I do before he starts>
- [david] <something only his own session or device can do>
- [restore] <what I put back when the run ends or pauses>

## Steps

### 1. <Short imperative title>

**Do:** <the exact action — where to click, what to type>

**Expect:** <the exact observable result>

**Lane:** human

### 2. <…>

**Do:** <…>

**Expect:** <…>

**Lane:** ci

**Check:** `<path/to/the.test.ts>`

### 3. <…>

## Regression

### R1. <Short title>

**Do:** <…>

**Expect:** <…>

**Lane:** scripted

**Check:** `<path/to/acceptance.spec.ts>`

## Not bugs

- <something that looks wrong but is out of scope or intended>
```

## Rules for each part

**Title line.** `# PR #<N> — <Feature> — UAT`. The PR number is also in the
filename (`PR<N>_<FEATURE>_UAT.md`, SCREAMING_SNAKE slug), and the two must
agree.

**`## Setup`** — every line is one of exactly three tags, or `None.` on the
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

  **It must not name the value itself.** A doc is written before the run, so
  it cannot know what the live setting will be; a number written here is a
  guess, and restoring a live limit to a guessed number is worse than not
  restoring it at all. The captured value belongs in the run record, which
  is written at run time and is where `/uat` reads it back from. (This rule
  exists because the first version of this spec demanded the value, and a
  conversion duly invented one from a seed file.)

**`## Steps`** — the feature under test. One `### <n>. <title>` per step,
numbered from 1, each with exactly one **Do:**, one **Expect:** and one
**Lane:**, plus a **Check:** for a machine lane and at most one
**Deferred:**. For a machine-lane step, **Do:** and **Expect:** still say
what the check does and asserts, in words, so the doc reads the same for a
human and the check's coverage can be reviewed against it.

- **One action per step.** If a step needs "then also check", it is two steps.
  The driver presents one step per turn, so a compound step produces a
  compound answer and a muddy record.
- **`Expect:` is an oracle, not a hope.** Something he can look at and answer
  yes or no to. "The page loads correctly" is not; "a bordered table listing
  chapters 1–12, and a search box above it" is.
- **Never reference another step's state implicitly.** If step 4 needs what
  step 3 created, say so in step 4's **Do:**, because a resumed run may start
  at 4.

**`## Regression`** — what must still work, unchanged by this PR. Same shape,
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

**`## Not bugs`** — known limitations, out-of-scope oddities, anything that
looks wrong and isn't. Bullets, no steps. This is what stops David reporting
the same non-issue twice.

## What the format deliberately does not have

- **No bug-report template.** `/uat` files the bug during the run, with the
  evidence in front of it. A template was for reading the doc alone.
- **No "if something's wrong" section.** Same reason.
- **No timings, no "~4 min" annotations.** They were always guesses and they
  age badly.
- **No Parts, Tests, Sections, or any second naming scheme.** One list of
  steps and one list of regression checks. If a doc feels like it needs
  parts, it is testing two things and wants two docs.

## Who writes one

`pr-docs` — every feature-mode PR with product-visible behavior, PR-first, on
the same PR before merge, with the checks for its machine-lane steps written
in that same PR. See [`pr-docs`](../../.claude/skills/pr-docs/SKILL.md).
`/uat` **consumes** this format and never authors it.

## The guard

`node scripts/check-uat-format.mjs` enforces the structure and the lanes: a
lane per step, a backticked check for every non-deferred machine-lane step,
a cited file that exists, an owner on every deferral. It cannot tell whether
a cited check really asserts what the step expects; that stays with review.

**A UAT doc is deleted when David confirms its run is complete** (David,
2026-08-22) — by `/uat`, in the same close-out, unless it carries behavior
recorded nowhere else, which gets harvested into the Manual first. A surviving
file in `docs/tests/UAT/` therefore means the run is still owed, which is why
the format has to stay drivable for as long as the file lives.
