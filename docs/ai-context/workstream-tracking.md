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
for visual scanning, and a `/status-all` skill for the judgment the board can't
compute on its own (stall detection, plain-language restatement of what a
David-gate is actually asking).

## The lifecycle

Discovery → 🛑 Scope of work → Planning → 🛑 Plan approval → Coding →
Code review → Merge → Test run → 🛑 UAT → Close-out → Done

Bug-fixing mode (`/bugfix`) branches straight from Discovery to Coding,
skipping Planning and Plan approval — it still lands in Code review, Merge,
Test run, and UAT like everything else.

🛑 marks a **David-gate** — a stage only he can move past. It's the same
glyph used for the mid-task interruption banner in chat, deliberately: one
symbol means "David," everywhere, not only in conversation. **Merge stopped
being a David-gate on 2026-08-15** (the agent driving the PR merges it once
CI is green, the reviewer has converged, and every thread is resolved — see
CLAUDE.md's close-out contract), and the **scope-of-work gate** was added
the same day at the front of Planning (see
[`working-modes.md`](./working-modes.md#the-scope-of-work-gate-david-2026-08-15)).
The one exception that still holds Merge as a David-gate: a PR that widens
the agent's own guardrails or authority, which stays David-merge-only.
**Known interim mismatch:** the Project board's verbatim Status option is
still named `🛑 Merge` (the sync script maps labels onto the board's exact
option names, and renaming an option is a board-config edit only David can
make, paired with a `sync-project-fields.mjs` + fixture code change) — so
until that follow-up lands, ordinary self-merged workstreams passing
through `stage:merge` briefly display the stop glyph on the board without
meaning "needs David." The label semantics in this doc are the truth;
`waiting:david` is what actually marks the carve-out case.

## Phased features: a parent issue, one sub-issue per phase

Some features are too large for one PR — PR #293 discovered this mid-flight
and self-documented as "phase 1 of 8," with no structural place to record
what the other seven were. The design settled 2026-08-05 and is built as of
2026-08-15:

- **The parent issue carries the plan** and the checkpoints that only make
  sense once for the whole feature: 🛑 Plan approval, the whole-feature UAT
  if there is one, and close-out. It holds `mode:feature` and a **Phases
  checklist** (below).
- **Each phase is a GitHub sub-issue** of that parent (the native sub-issue
  relationship, the same one `/document` harvests use), with its own
  `stage:`/`waiting:`/`mode:` labels, its own PR carrying
  `Workstream: #<phase-issue>`, and its own merge.
- **Phases merge sequentially, never stacked.** No phase PR bases on
  another still-open phase PR. Phases don't need stacked-branch mechanics
  if they land one at a time, and this repo's force-push posture is a
  reason not to reach for them.
- **UAT is per-phase**, wherever a phase is itself product-visible — not
  one UAT deferred to the final phase, which would leave David unable to
  verify anything for weeks.
- **A phase PR's oracle section carries a scope line** naming which of the
  parent plan's sections that phase delivers and which it defers, so a
  reviewer is never left guessing whether a missing piece is
  out-of-scope-for-this-phase or silently dropped.
- **Splitting a feature into phases is proposed to David, never declared
  silently mid-build.** (His stated revisit condition: if the asking step
  becomes friction in practice.)

### The Phases checklist

The parent issue's body carries this block, immediately after its State of
Play. It is the durable record of what the whole feature owes — the thing
that lived only in PR titles and chat memory before:

```
## Phases
- [x] Phase 1 — schema + migration → #451 (merged, PR #293)
- [x] Phase 2 — ISPWS client + XML builders → #452 (merged, PR #349)
- [ ] Phase 4 — provenance capture in quarantine.ts → #455 (active)
- [ ] Phase 5 — submission worker + reconciler → not yet opened
```

Each line is one phase: a checkbox, `Phase N`, a short description, and
either its sub-issue number or the literal `not yet opened`. A phase with
no issue yet is **normal and expected** — issues are opened as phases
start, not all upfront, so the checklist is the only place a
not-yet-started phase exists at all. `/next` reads exactly this to answer
"what's the next phase of something we already started," so a phase
missing from the checklist is a phase the system will forget.

**Parent labels while phases run.** The parent sits at `stage:coding`
from the first phase opening until the last phase closes, and its
`waiting:` mirrors whoever holds the **active** phase. When no phase is
active but phases remain, the parent is `waiting:claude` — that's an
unstarted next phase, which is work, not a resting state. Once every
phase is checked off, the parent moves through its own whole-feature UAT
(if any) and close-out like any other workstream.

**Sub-issues are never double-counted.** `/status-all` already removes
every issue returned by `get_sub_issues` from its top-level set and
renders it nested under its parent; phase sub-issues inherit that
handling unchanged, and `/next` applies the same dedup.

## The State of Play block

Labels are machine-readable state; the **State of Play block** is the
human-readable narrative that makes an issue resumable **cold**, in a fresh
session with zero prior context. It's a fixed section maintained at the top
of the workstream issue's body, with these fields:

- **Stage** — mirrors the `stage:` label, spelled out.
- **Waiting on** — mirrors the `waiting:` label, spelled out.
- **Last movement** — date + one-line description of what last happened.
- **What this is** — a few sentences of orientation; what the workstream
  actually accomplishes and why.
- **Where it actually stands** — the real narrative: what's landed, what
  hasn't, anything that broke and how it was fixed. Not a checklist for its
  own sake — enough that a cold reader understands the current shape.
- **What's blocking** — if `waiting` is `david`, the actual question,
  restated in plain language from the real thread, not inferred from the
  stage name alone (the same accuracy bar `/status-all` applies). If nothing's
  blocking, say so.
- **What you need to do** — the concrete next action, or "nothing right now."
- **Artifacts** — PR numbers, branch names, key file paths, the Project link.
- **To resume** — the literal instruction for picking this back up: which
  branch/session to open, what to ask for, which model tier fits.

**Whoever changes an issue's `stage:` or `waiting:` label updates this block
in the same edit** — the two must never drift apart, since a label with a
stale narrative behind it is worse than an honest gap. That means the same
skills that own label transitions
(`plan-review-loop`, `bugfix`, `pr-watch`, `pr-docs`) own keeping this block
current at those same trigger points. There is no separate maintainer
beyond those four. (The old fifth maintainer — the `test-run-completion.yml`
Action, which owned the deletion-of-a-TEST_RUN-doc transition — is retired
with the TEST_RUN file pattern, 2026-08-15: `pr-watch`'s close-out sequence
owns that transition now.)

## Labels are the actual source of truth

The Project board's `Status`/`Waiting On`/`Mode` fields are the *display*;
the issue's labels are what's actually true. **No available tool (MCP or
REST) can read or write a Projects v2 item field directly** — confirmed
twice, independently, building the sync mechanism (PR #318) and again
confirming `/status-all` has to read labels rather than the board (PR #323). A
`.github/workflows/project-sync.yml` Action
(`scripts/sync-project-fields.mjs`) mirrors labels onto the board's fields
on every label change. Nothing else writes to the board. (The retired
`test-run-completion.yml` Action was once a deliberate exception here —
its `GITHUB_TOKEN` label writes didn't cascade to `project-sync.yml`, so
it called `syncIssue` directly; with all label writes back in agent
sessions, that exception is gone.)

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
| `pr-watch` | `stage:code-review` onward — round-by-round `waiting` toggling, `waiting:david` on escalation, `stage:test-run`/`waiting:replit` at merge when the PR's Post-merge verification section has real content (the close-out sequence then drives the checks and moves the label to `stage:uat`/`stage:close-out` once the checks pass); with "none needed" verification, the transition to `stage:uat`/`stage:close-out` still waits for the close-out sync checks (SHA match + clean worktree) to pass — never at the merge click itself, either branch |
| `pr-docs` | No stage transition of its own — confirms `mode:feature` is right on the PR this pairing rides on |
| `/document` | A harvest is a **sub-issue** of the parent workstream (GitHub's native sub-issue relationship), not a status value on the parent — it has its own branch, PR, and review loop, so it needs its own row |

**Phase ownership rides the same trigger points**, with no new maintainer:

| Moment | Who | What happens |
| --- | --- | --- |
| David approves a phased plan | `plan-review-loop` | Writes the **Phases checklist** into the parent issue, every phase listed, all `not yet opened` |
| A phase starts | `plan-review-loop` (or `bugfix`, for a phased fix) | Opens that phase's sub-issue with its own full label set, links it under the parent, updates the checklist line from `not yet opened` to the issue number |
| A phase's PR closes out | `pr-watch` | Ticks that phase's checkbox in the parent, and re-points the parent's `waiting:` at the next phase (`waiting:claude` if the next phase hasn't opened) |
| The last phase closes out | `pr-watch` | Moves the **parent** out of `stage:coding` into its whole-feature UAT or close-out |

A phase sub-issue is a workstream issue like any other — it carries the
same three label prefixes and its own State of Play block, because a phase
is exactly the unit someone resumes cold.

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
  an issue body is public even though the Project itself is private. This
  is the **canonical definition** of the disclosure check that gates
  opening a public workstream issue, referenced (not restated) by
  `plan-review-loop`, `working-modes.md`'s bugfix disclosure check, and
  `documentation-workflow.md`'s harvest-tracking section: before a
  workstream — a plan, a bug report, or a `/document` harvest — becomes a
  public issue, confirm it contains none of unpatched-vulnerability
  details, auth/authorization bypass specifics, secrets/credentials,
  payment-fraud abuse paths, private customer/commercial data, or
  embargoed-plan content. If it does, it stays off the public path — a
  draft Project item, or (for a plan specifically) the manual/private
  review path instead of a plan-review PR.
- **No hand-typed GitHub UI name (a field, an option) gets matched by exact
  string in code.** The sync script's first live run against the real board
  failed all 9 workstream syncs because the real `Waiting On` field
  (capital O, typed by hand) didn't match a hardcoded `Waiting on`. See
  [`.agents/memory/github-project-field-names-need-normalized-matching.md`](../../.agents/memory/github-project-field-names-need-normalized-matching.md).
  Match by normalized name, not exact string, for anything a human typed
  into a GitHub UI.

## `/status` and `/status-all`

Two skills, two questions (split 2026-08-05):

- **`/status-all`** (`.claude/skills/status-all/SKILL.md`) — the **fleet**
  view, and the original skill unchanged: every open workstream, grouped
  🛑 NEEDS YOU / ⚠️ STALLED / IN PROGRESS, recomputed directly from issues +
  labels + PR state (it can't read the Project board either, per the tooling
  gap above). **Read-only.** Works from any session, including a fresh
  throwaway one; that's the intended usage. See the skill file for the
  stall-detection threshold and the plain-language-blocker rule.
- **`/status`** (`.claude/skills/status/SKILL.md`) — **one session's own**
  workstream: what it's working on, which of five states it's in
  (`WORKING` / `WAITING ON YOU` / `WATCHING` / `STALLED` / `DONE`), what's
  next, and how it fits the roadmap.

**The five states are a derived presentation vocabulary — never stored.**
They are computed from the `stage:`/`waiting:` labels plus live GitHub state.
They never become labels, never become board fields, and nothing reads them
back. Labels remain the sole source of truth.

**`/status` reports; it does not write unattended.** When stored labels or the
issue's `## State of Play` block disagree with live GitHub, it says so and
**offers** to correct them — David confirms, and only then does it write.
That keeps the ownership model in the table above intact: `/status` is not a
standing background writer, it is a David-confirmed correction at a moment he
is already present for. (An unattended write-through version was designed and
rejected — it needed conflict detection and write-target authentication the
GitHub API can't cleanly provide, for a status check. See
[`decisions.md`](./decisions.md).)

**`WATCHING` may never be claimed from memory** — only after a live check in
that same invocation. A session's belief that it is watching a PR goes stale
exactly the way issue #328's did.
