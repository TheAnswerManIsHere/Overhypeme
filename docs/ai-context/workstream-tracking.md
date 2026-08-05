# Workstream tracking — the board, the labels, and who updates what

> **Shared, cross-agent contract.** Codex sees `Workstream: #N` in PR bodies
> and `stage:`/`waiting:`/`mode:` labels during code review and should never
> remove or contradict them without understanding why they're there. Claude's
> enactment is spread across the skills that already have a natural trigger
> point for updating a label — `plan-review-loop`, `bugfix`, `pr-watch`,
> `pr-docs` — each of which points back here rather than restating this.

## Why this exists

David runs ~10 concurrent sessions and cannot tell where any of them stand,
or which need him, without opening each one. This closes that gap using
GitHub's own project management rather than a bespoke tracker: **one issue
per workstream**, a private Project board
([Overhype.me Workstreams](https://github.com/users/TheAnswerManIsHere/projects/1))
for visual scanning, and a `/status` skill for the judgment the board can't
compute on its own (stall detection, plain-language restatement of what a
David-gate is actually asking).

## The lifecycle

Discovery → Planning → 🛑 Plan approval → Coding → Code review → 🛑 Merge →
Test run → 🛑 UAT → Close-out → Done

Bug-fixing mode (`/bugfix`) branches straight from Discovery to Coding,
skipping Planning and Plan approval — it still lands in Code review, Merge,
Test run, and UAT like everything else.

🛑 marks a **David-gate** — a stage only he can move past. It's the same
glyph used for the mid-task interruption banner in chat, deliberately: one
symbol means "David," everywhere, not only in conversation.

## Labels are the actual source of truth

The Project board's `Status`/`Waiting On`/`Mode` fields are the *display*;
the issue's labels are what's actually true. **No available tool (MCP or
REST) can read or write a Projects v2 item field directly** — confirmed
twice, independently, building the sync mechanism (PR #318) and again
confirming `/status` has to read labels rather than the board (PR #323). A
`.github/workflows/project-sync.yml` Action
(`scripts/sync-project-fields.mjs`) mirrors labels onto the board's fields
on every label change; nothing else writes to the board, and nothing should.

Every workstream issue carries exactly one label from each of three
prefixes:

- **`stage:<slug>`** — where it is in the lifecycle above. Slugs:
  `discovery`, `planning`, `plan-approval`, `coding`, `code-review`,
  `merge`, `test-run`, `uat`, `close-out`, `done`.
- **`waiting:<who>`** — who is currently holding it: `david`, `claude`,
  `codex`, `replit`, or `ci`. This is deliberately a **field separate from
  `stage`**, not folded into it — a blocking question mid-build leaves
  `stage` at `coding` while `waiting` flips to `david`. That divergence
  *is* the moment David needs surfaced, and collapsing the two fields
  would lose it.
- **`mode:<kind>`** — `feature`, `bugfix`, `docs`, or `devops`.

Two labels sharing a prefix (e.g. two `stage:` labels on one issue) is a
real data error, not a style nit — the sync script throws rather than
guessing which one wins (`labelsToFieldValues` in
`scripts/sync-project-fields.mjs`), and any agent hand-editing labels
should apply the same discipline: fix it, don't silently pick one.

## Whose job is it to keep labels current

**Nobody has a standing background job for this.** Each skill that already
has a natural trigger point updates the labels *at that point*, as part of
work it's already doing — not as a separate reminder to go check the board:

| Skill | Owns |
| --- | --- |
| `plan-review-loop` | `waiting` toggling `claude`/`codex` each review round; `stage:plan-approval` + `waiting:david` at convergence/close-out |
| `bugfix` | Opening the workstream at `stage:coding` directly (no Planning stage), `mode:bugfix` |
| `pr-watch` | `stage:code-review` onward — round-by-round `waiting` toggling, `waiting:david` on escalation, `stage:uat`/`stage:close-out` at merge |
| `pr-docs` | No stage transition of its own — confirms `mode:feature` is right on the PR this pairing rides on |
| `/document` | A harvest is a **sub-issue** of the parent workstream (GitHub's native sub-issue relationship), not a status value on the parent — it has its own branch, PR, and review loop, so it needs its own row |

Each skill's own file carries the concrete instruction at its trigger
point; this doc is the shared vocabulary they point back to, not a
restatement.

## What must never happen

- **`Pull request merged → Done`, the Project's built-in workflow, stays
  off.** A merge is followed by Test run and UAT — the board must never
  claim work is verified before David has actually verified it. (Confirmed
  correct in practice: PR #311 merged and correctly stayed at `🛑 UAT`, not
  `Done`.)
- **`Auto-close issue` stays off**, for the same reason one step worse.
- **PR bodies say `Workstream: #N`, never `Closes #N`.** The latter would
  auto-close the issue at merge and skip UAT entirely.
- **Sensitive / disclosure-carve-out workstreams never become public
  issues.** They're draft Project items instead — this repo is public, and
  an issue body is public even though the Project itself is private. Same
  carve-out as `plan-review-loop`'s disclosure check.
- **No hand-typed GitHub UI name (a field, an option) gets matched by exact
  string in code.** The sync script's first live run against the real board
  failed all 9 workstream syncs because the real `Waiting On` field
  (capital O, typed by hand) didn't match a hardcoded `Waiting on`. See
  [`.agents/memory/github-project-field-names-need-normalized-matching.md`](../../.agents/memory/github-project-field-names-need-normalized-matching.md).
  Match by normalized name, not exact string, for anything a human typed
  into a GitHub UI.

## `/status`

A **read-only** skill (`.claude/skills/status/SKILL.md`) that recomputes
the board's view directly from issues + labels + PR state — it can't read
the Project board either, for the same tooling gap above, so it doesn't
try. Works from any session, including a fresh throwaway one; that's the
intended usage. See the skill file for the stall-detection threshold and
the plain-language-blocker rule.
