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

### 2. <…>

## Regression

### R1. <Short title>

**Do:** <…>

**Expect:** <…>

## Not bugs

- <something that looks wrong but is out of scope or intended>
```

## Rules for each part

**Title line.** `# PR #<N> — <Feature> — UAT`. The PR number is also in the
filename (`PR<N>_<FEATURE>_UAT.md`, SCREAMING_SNAKE slug), and the two must
agree.

**`## Setup`** — every line is one of exactly three tags, or the single word
`None.`

- **`[claude]`** — mine to execute before he starts. Seeding rows, putting
  config in a known state, confirming the Repl is synced. Anything mechanical
  that stands between him and step 1 belongs here, not in a step.
- **`[david]`** — only his own session or device can do it: signing in as
  himself, using a real phone, a live Stripe account. Keep these few; each
  one is friction he has to supply.
- **`[restore]`** — what gets put back. Required whenever a `[claude]` line
  changed live state, and it names the original value, not just the
  intention: `budget_limit_legendary_usd → 2500.00 (captured before the
  write)`.

**`## Steps`** — the feature under test. One `### <n>. <title>` per step,
numbered from 1, each with exactly one **Do:** and one **Expect:**.

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
the same PR before merge. See
[`pr-docs`](../../.claude/skills/pr-docs/SKILL.md). `/uat` **consumes** this
format and never authors it.

**David deletes a UAT doc himself when he has completed it.** A surviving file
in `docs/tests/UAT/` means the run is still owed — which is why the format has
to stay drivable for as long as the file lives.
