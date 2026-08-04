---
name: Moving a section between CLAUDE.md and a skill leaves prose cross-references stale and invisible to the link checker
description: check-docs-accuracy.mjs only validates `[text](path)` markdown links. A sentence like "see CLAUDE.md's *Automated plan review* section" that names a heading rather than linking to a file passes the checker clean even after that heading moves or is renamed — the check has nothing to verify.
---

# Moving a section between CLAUDE.md and a skill leaves prose cross-references stale and invisible to the link checker

## What happened

PR #300 migrated several CLAUDE.md sections into standalone skills
(`plan-review-loop`, `pr-watch`, `pr-docs`, `model-routing`), renaming or
removing the original headings in the process. `check-docs-accuracy.mjs`
passed clean on that PR — it only checks markdown link syntax
(`[text](path)`), and every actual `[...](...)` link in the migrated text
was either fixed or never broken.

What it couldn't see: prose sentences elsewhere in the repo that named the
*old heading* without a markdown link — "see `CLAUDE.md`'s *Automated plan
review* section," "the advisor tool (below)," "the ~20-round cap in
`CLAUDE.md`." Five separate files (`plan-review-contract.md`,
`decisions.md`, a `.agents/memory/` note, `loop-ledger.md`,
`dispatching-parallel-agents/SKILL.md`) carried references like this to
sections that had moved. All of them shipped green. The follow-up PR
(#301) that fixed them found seven such references one at a time across
several review rounds — each fix round surfaced one or two more nearby —
before switching to a repo-wide `grep` for every heading name that had
actually moved, which caught the rest in a single pass.

## What worked instead

After the migration is otherwise done, `grep -rn` the exact old heading
text (and any other prose forms of it — "the advisor tool," "the ~20-round
cap") across the whole repo, not just the files being edited. Fix every
hit found this way in the same pass, rather than waiting for review to
surface them individually. Confirm each still-resident heading you *didn't*
move is actually still there before leaving its citations alone — a
reference to a section that never moved needs no fix, and "fixing" it
would introduce a real error.

## Takeaway

`check-docs-accuracy.mjs`'s link check is a floor, not a ceiling — it only
proves markdown link syntax resolves, and has nothing to say about prose
that names a section without linking to it. Any time a heading moves,
renames, or is deleted (a doc restructure, a `CLAUDE.md`-to-skill
migration, splitting one file into several), the pre-review step is a
repo-wide grep for the *old text*, not a check that the tool passes. This
generalizes beyond `CLAUDE.md`: the same gap exists for any heading rename
in `docs/ai-context/` or `docs/engineering/` that other files cite in
prose rather than by link.
