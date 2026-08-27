# `docs/handoff/` — cross-tool coordination, always ephemeral

This folder exists because Replit, Codex, and Claude Code have no shared
channel except the repo itself. Replit doesn't participate in GitHub PR
threads — it only pushes commits — so a file here is the only reliable way
for it to hand context to whoever picks up next. Everything in this folder is
**in-flight communication, not documentation.** The location is the signal:
if a file is in `docs/handoff/`, it is not yet addressed by definition, and
it does not belong here once it is.

## The lifecycle

1. **A tool writes a handoff** when it stops mid-task and needs to pass
   context to whichever tool (or David) picks the work up next — what ran,
   what was found, where it stopped, what's still open.
2. **The next reader deletes it in the same change that addresses every
   issue in it.** Deleting is not losing the findings — it's the forcing
   function that makes you route each one to where it actually belongs:
   - A wrong or stale instruction in a checklist → fix the checklist
     itself (e.g. a `docs/tests/Replit/PR<N>_..._TEST_RUN.md`).
   - A durable, generalizing lesson → the relevant `docs/ai-context/` file
     (a gotcha that will recur belongs in
     [`known-failure-patterns.md`](../ai-context/known-failure-patterns.md)).
   - A settled call → [`decisions.md`](../ai-context/decisions.md).
   - Anything still open → a question to David, or a real tracked issue —
     never a paragraph left sitting in a handoff file.
3. **A finding that survives only because the handoff file is still in the
   repo has not been addressed.** If nothing in a handoff belongs anywhere
   durable, that's the signal it was pure transit and deleting it costs
   nothing.

This is the same rule the `TEST_RUN` checklist sibling docs follow (see
[`test-run-contract.md`](../tests/test-run-contract.md)) — it just
used to live only in that file, under a Replit-specific heading, before this
folder existed to make the ephemerality the default rather than something
you had to already know to look for.

## Naming

`<date>-<from>-to-<to>-<topic>.md`, e.g.
`2026-08-09-replit-to-claude-checklist-run.md`. Sender and intended recipient
should be legible from the filename alone, without opening the file.

## Writing one: describe state, don't snapshot it

A handoff that asserts "these changes are uncommitted" goes stale the moment
the writer's next auto-save checkpoint fires — which is exactly what
happened on 2026-08-09 (see `known-failure-patterns.md` if that entry has
been added, or `replit-environment.md`'s note on checkpoints vs. intent).
Point at how to check current state instead of asserting a snapshot of it:
"see `git log --author=\"Replit Agent\"` for what's landed since," not "X, Y,
Z are uncommitted."

## Disclosure check — this repo is public

A closed-unmerged PR and a deleted file both stay in public git history
forever. Before writing anything here, run the
[canonical disclosure check](../ai-context/workstream-tracking.md#what-must-never-happen)
— the same gate `plan-review-loop`, `working-modes.md`'s bugfix disclosure
check, and `documentation-workflow.md`'s harvest-tracking section all
reference rather than restate. This file does the same: it is not a second,
narrower definition of what's excludable.

**Describe a live database row's shape and the problem with it — don't
paste its actual contents.** The 2026-08-09 handoff that motivated this
folder quoted real `ncmec_reports` row values (id, request metadata,
timestamps) directly into a public commit; harmless that time because the
rows were test artifacts, but the next handoff written mid-incident about
auth, payments, or moderation might not have that luck. If a handoff would
fail the disclosure check, it does not go in this folder — it stays on the
manual/private path, same carve-out `plan-review-loop` uses for a plan that
can't go through the public channel.

## Not to be confused with Claude's `/handoff` skill

The name collides, the job doesn't. **This folder is cross-*tool* transit** —
it exists because Replit and Codex have no shared channel with anyone except
the repo. **`/handoff`** (`.claude/skills/handoff/SKILL.md`) moves one Claude
Code *session's* context to a fresh Claude Code session, and its channel is
the workstream issue's State of Play block plus a handoff comment — never a
file here. A session handoff carries no delete-when-addressed obligation and
has a live reader by construction, so both of this folder's defining
properties are absent. If you are reaching for a file here to hand context
between two Claude sessions, that's the wrong artifact.

## What this folder is not

Not a place for durable docs (those go in `docs/ai-context/` or
`docs/engineering/`), not a second `docs/tests/Replit/PR<N>_*_TEST_RUN.md`/
`docs/tests/UAT/PR<N>_*_UAT.md` pair
(those have their own contract), and not a queue — a handoff with no
current reader is a stalled handoff, which `/maintenance` flags (see its
Replit-commit-review section) rather than something anyone should poll for.
