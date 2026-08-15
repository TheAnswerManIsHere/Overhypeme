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
current at those same trigger points, plus the one automated exception:
`test-run-completion.yml` updates Stage/Waiting on/Last movement and the
What's-blocking/What-you-need-to-do sections itself, at the one transition
it owns. There is no separate maintainer beyond those five.

## Labels are the actual source of truth

The Project board's `Status`/`Waiting On`/`Mode` fields are the *display*;
the issue's labels are what's actually true. **No available tool (MCP or
REST) can read or write a Projects v2 item field directly** — confirmed
twice, independently, building the sync mechanism (PR #318) and again
confirming `/status-all` has to read labels rather than the board (PR #323). A
`.github/workflows/project-sync.yml` Action
(`scripts/sync-project-fields.mjs`) mirrors labels onto the board's fields
on every label change. One deliberate exception: `test-run-completion.yml`
(`scripts/sync-test-run-completion.mjs`) writes labels with `GITHUB_TOKEN`,
whose events GitHub does not cascade to other workflows — so
`project-sync.yml`'s own `issues:labeled` trigger would never fire from
that write — and calls `sync-project-fields.mjs`'s `syncIssue` directly
instead of relying on the event chain. Nothing else writes to the board.

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
| `pr-watch` | `stage:code-review` onward — round-by-round `waiting` toggling, `waiting:david` on escalation, `stage:test-run`/`waiting:replit` at merge when a TEST_RUN doc ships, else `stage:uat`/`stage:close-out` directly |
| `test-run-completion.yml` (`scripts/sync-test-run-completion.mjs`) | The **only** automated (non-agent) label writer here: triggers on the push that deletes a `docs/tests/Replit/PR<N>_..._TEST_RUN.md` doc and moves that PR's workstream from `stage:test-run` to `stage:uat`/`stage:close-out` itself — no agent session needs to be engaged for this one transition |
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
