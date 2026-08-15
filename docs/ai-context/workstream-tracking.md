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
  sense once for the whole feature: 🛑 Plan approval and close-out. It
  holds `mode:feature` and a **Phases checklist** (below). There is no
  separate whole-feature UAT gate — the next bullet is why.
- **Each phase is a GitHub sub-issue** of that parent (the native sub-issue
  relationship, the same one `/document` harvests use), with its own
  `stage:`/`waiting:`/`mode:` labels, its own PR carrying
  `Workstream: #<phase-issue>`, and its own merge.
- **Phases merge sequentially, never stacked.** No phase PR bases on
  another still-open phase PR. Phases don't need stacked-branch mechanics
  if they land one at a time, and this repo's force-push posture is a
  reason not to reach for them.
- **UAT is per-phase, and that's the only UAT there is.** Wherever a phase
  is itself product-visible it ships its own UAT doc — never one deferred
  to the final phase, which would leave David unable to verify anything for
  weeks. There is no separate whole-feature UAT step layered on top: no PR
  belongs to the parent for such a doc to be named after, and per-phase
  verification already covers the feature by the time the last phase
  closes.
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
`waiting:` mirrors whoever holds the **active** phase — at every `waiting:`
toggle on the active phase's PR, not just at that phase's close-out, so the
parent never displays a stale holder mid-review. When no phase is active
but phases remain, the parent is `waiting:claude` — that's an unstarted
next phase, which is work, not a resting state. Once every phase is
checked off, the parent moves straight to `stage:close-out` — there is no
separate whole-feature UAT stage to pass through first, since per-phase UAT
already verified the feature as it shipped.

**Sub-issues are never double-counted.** `/status-all` already removes
every issue returned by `get_sub_issues` from its top-level set and
renders it nested under its parent; phase sub-issues inherit that
handling unchanged, and `/next` applies the same dedup.

## The backlog: work that's queued but hasn't started

A workstream issue tracks work that is *underway*. Work we've decided to do
but haven't started needs somewhere durable too — otherwise it lives in
roadmap prose, which drifts, and in David's memory, which he has explicitly
said not to rely on. So:

**A backlog item is an issue carrying `queue:` and `mode:` labels and no
`stage:` label.** The two prefixes are mutually exclusive and that's the
whole state machine:

- **`queue:`, no `stage:`** — decided, not started. Invisible to
  `/status-all` by construction (its Step 1 filters to issues carrying a
  `stage:` label), which is correct: the fleet view is about active work,
  and padding it with the backlog would bury the things that actually need
  someone. Don't "fix" that filter.
- **The moment work starts** — the item gains `stage:`/`waiting:` and
  **drops its `queue:` label**. It is now an ordinary workstream issue and
  every existing rule applies unchanged.

Priorities are three labels, deliberately not named P1/P2 (that collides
with Codex's severity badges):

| Label | Means |
| --- | --- |
| `queue:now` | Next up. Would start today if a session were free. |
| `queue:next` | Committed, not immediate. The normal state for approved-but-unstarted work. |
| `queue:later` | Real, wanted, no urgency. Revisit rather than schedule. |

**The issue body is where nuance lives** — why we want it, what we already
decided, what we explicitly ruled out. That's the half a roadmap bullet
loses, and the half that makes an item resumable cold months later.

**This does not replace the two prose backlogs.**
[`current-roadmap.md`](./current-roadmap.md) stays the product narrative and
[`deferred-work.md`](../engineering/deferred-work.md) stays the engineering
one. A backlog issue is what gets created when something in either becomes
a *specific, actionable unit of work* — not a mirror of every line in them.
`/maintenance`'s backlog-hygiene step is what keeps the three from drifting.

## `Blocked by: #N` — dependencies are mechanical, not remembered

Any workstream or backlog issue may carry one or more lines in its body:

```
Blocked by: #422
Blocked by: #405
```

Read with the anchored regex `^Blocked by:[ \t]*#(\d+)` (multiline,
start-of-line), exactly like the `Workstream: #N` marker and for the same
reason: an unanchored `\s*` can cross a newline and grab an unrelated `#N`
from prose several lines later, or match an example inside a quoted plan.

- **An open blocker makes an item non-actionable.** Nothing recommends it,
  nothing starts it.
- **Closing the blocker releases it mechanically** — no cleanup edit
  required for the release itself, because the marker points at an issue
  whose state is the truth. (Removing the stale line is still good hygiene;
  `/maintenance` sweeps for them.)
- **There is no inverse `Blocks:` marker.** It's derivable, and a
  bidirectional convention is one that can disagree with itself.
- **Only trust markers on issues carrying our own labels.** This repo is
  public and anyone can open an issue, but outside accounts cannot apply
  labels — so an issue with no `stage:` and no `queue:` label is not part
  of this system and its markers are ignored. Same trust posture
  `/status-all` applies to PR bodies.

## When UAT finds a bug: the descent stack

This is the shape David hits most often, and the one this whole system
exists to survive: he starts UAT on a merged feature, hits an error, and
the error turns out to be a real bug — sometimes a small one, sometimes an
entire subsystem rebuild. (PR #213's private-meme UAT is the worked
example: it surfaced what became the whole admin-permission rebuild, #405
and #422.) Pre-launch, chasing those is deliberate — we're moving from
prototype to production-ready — so the risk isn't chasing them, it's
**losing the way back to the interrupted UAT**.

The `Blocked by:` chain *is* the record of the way back — a call stack made
of issue links, which survives any session ending:

1. **On discovery**, whoever intakes the bug (bugfix mode, or feature mode
   when the rabbit hole turns out to be a rebuild) opens the new issue
   **and** adds `Blocked by: #new` to the interrupted workstream, plus one
   line in its State of Play recording **which UAT step failed**. That last
   detail is what makes resumption "resume at step 4" instead of "run the
   whole thing again."
2. **Depth is unbounded.** If the descent hits its own blocker, the chain
   nests. Nothing needs to know how deep it is.
3. **Priority propagates down the chain: an item inherits the highest rank
   of anything transitively blocked on it.** An interrupted UAT sits near
   the end of the lifecycle, so it ranks high — and that rank flows down to
   whatever is at the bottom of its chain. This is why a three-levels-deep
   permission rebuild correctly outranks starting any fresh feature:
   finishing it is what unwinds the stack back to an almost-done UAT.
4. **The stack pops mechanically.** When a blocker closes, its parent
   becomes actionable again and surfaces immediately as the top
   recommendation — "resume UAT on #213 at step 4."

**The escape hatch, because a deep stack can pin the queue for weeks.**
That's correct behavior pre-launch, but not unconditionally: if a descent
outgrows what the interrupted UAT is worth, David can park it. The marker
becomes `Parked, was blocking: #213` — which reads as prose, not as the
anchored `Blocked by:` marker, so it stops gating automatically — and the
interrupted workstream records its UAT as accepted-incomplete.
`/maintenance` flags any chain deeper than 2, or any blocker older than two
weeks, so that call gets *prompted* rather than remembered.

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
| David approves a phased plan | `plan-review-loop` | Writes the **Phases checklist** into the parent issue, every phase listed, all `not yet opened`. Never opens a phase itself — its lifecycle ends at this approval handoff and doesn't run again for phase 2 onward. |
| A phase starts (every phase, including the first) | `overhype-implementation` | Opens that phase's sub-issue with its own full label set, links it under the parent, updates the checklist line from `not yet opened` to the issue number — this is the one place phase-opening lives, so phase 1 and phase 8 work the same way |
| A phase's PR is under active review (each `waiting:` toggle) | `pr-watch` | Mirrors the same toggle onto the **parent's** `waiting:`, in the same edit — a phased parent's `waiting:` tracks whoever holds the *active* phase at every step, not just at close-out |
| A phase's PR closes out | `pr-watch` | Ticks that phase's checkbox in the parent, and re-points the parent's `waiting:` at the next phase (`waiting:claude` if the next phase hasn't opened) |
| The last phase closes out | `pr-watch` | Moves the **parent** straight to `stage:close-out` — per-phase UAT already covered verification, so there is no separate whole-feature UAT gate to enter |

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

## `/status`, `/status-all`, and `/next`

Three skills, three questions (`/status` split from `/status-all`
2026-08-05; `/next` added 2026-08-15):

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
- **`/next`** (`.claude/skills/next/SKILL.md`) — **what should we pick up
  now**, ranked. The only one of the three that takes a position rather
  than reporting state. It reads everything above plus the backlog,
  `Blocked by:` chains, and Phases checklists, ranks by **closest to done
  wins** with rank inheriting down each blocked chain, and names which
  candidates are safe to run in parallel sessions. **Read-only**, like
  `/status-all` — it recommends, it never starts work or fixes tracking.

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
