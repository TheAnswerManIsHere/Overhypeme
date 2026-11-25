<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# pr-watch — keeping the workstream issue's labels current

Part of the `pr-watch` skill ([`SKILL.md`](SKILL.md)), moved here whole. Read it at
every transition it names: a PR opening, a round starting or returning, the
close-out bar being met, a merge.

## Keeping the workstream issue's labels current

Per [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
`pr-watch` owns `stage:code-review` and everything downstream of it for the
PR's workstream issue (found via `Workstream: #N` in the PR body — if it's
missing, that PR skipped the tracking convention; flag it rather than
silently leaving the workstream unlabeled — unless it is one of the phase's
registry PRs, which carry `Refs #N` by design and are never subscribed, top
of this file, or one of David's display-only Replit tweaks, which carries no
issue by design and is its own record (`agents-core.md`, *Workstream
tracking*), so it has no labels to keep, or a sync PR delivering KITT's
payload, which delivers fleet machinery rather than a workstream (the
`sync-fleet` skill)):

- **PR opens / round 1 triggers** → `stage:code-review`, `waiting:codex` — on
  a Documentation-class PR too, while its one pass waits for Codex's
  automatic pass; `waiting:claude` once that pass reports Completed, since the
  assessed pass and its batch are mine to run.
- **Codex posts findings, I start responding** → `waiting:claude`.
- **I post the next round's `@codex review` trigger** → `waiting:codex`.
- **Intended behaviour or an accepted user-facing shortfall goes to David**
  (step 3.5, in `assessments.md` — a purely technical fork is settled in the loop, never
  escalated) → `waiting:david`; `stage:code-review` stays put — the stage
  hasn't moved, but the turn has. **The review gate's waiver is asked** (step
  3: the assessors cannot run) → `waiting:david` the same way. A push that
  came before a round's assessments asks him nothing.
- **The close-out bar is met** (CLAUDE.md's *Close-out*, all three items) →
  the ready bar is met and **I merge it myself per CLAUDE.md's close-out
  contract** — re-verify live state, squash-merge, check and sync the Repl,
  verify, report — so `stage:merge` is normally a moment, not a resting
  state. A guardrail- or authority-widening PR merges the same way, with the
  latitude it grants named in the report. The PRs that do not are the ones
  whose shortfall is a product decision (step 3.5), and one whose review gate
  waits on his waiver because the assessors cannot run (step 3); no count
  and no class sends one to him.
- **The PR merges with a Post-merge verification section that has real
  content** → `stage:test-run`, `waiting:replit` — or `waiting:david` while
  a step in it that would start a paid AI run above his budget waits for his
  go-ahead (`uat-doc-format.md`, *Lanes*) — the lifecycle's own
  Test-run stage, between Merge and UAT, not a step to skip past. Per the
  `pr-docs` contract this stage is **executed inside close-out**: I
  drive the section through the connector, read the results, and on a
  clean pass move the label myself to `stage:uat`/`stage:close-out` per
  the next bullet's check, in the same close-out sequence. A failure
  keeps the workstream here while it routes through the normal channel.
  A **legacy** `docs/tests/Replit/PR<N>_..._TEST_RUN.md` doc still on `main`
  follows this same flow, plus deleting the doc on a full pass — a tiny
  deletion PR, self-merged; the label move is likewise mine, since the
  `test-run-completion.yml` Action that once made it is retired.
- **The PR merges with "none needed" verification** → `stage:uat` **only
  after the close-out sync checks pass, and only if the PR body carries a
  `## UAT` section ([`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md);
  or a legacy UAT doc still under `docs/tests/UAT/` on `main`) or one is
  actually due**. The transition moment is the verified Repl
  sync (matching SHA + clean worktree, per CLAUDE.md's close-out
  sequence), not the merge click — a failed sync would otherwise put a
  David-held UAT gate on the board for a build he can't actually reach;
  until the checks pass the workstream stays agent-held in close-out.
  On the UAT-section test: pure-docs/pure-devops PRs never have one,
  and neither does a Tier A bugfix or a Tier B bugfix whose only surface is
  internal (per `working-modes.md`'s Tier B exception): all three go
  straight to `stage:close-out` instead, since holding them at `uat` would
  be a gate with nothing to run against it (a prototype-phase PR ships none
  either, and never reaches this step — top of this file). "Has product-visible behavior"
  is *not* the test by itself — a Tier A fix can be product-visible and
  still ship no UAT section, which is what makes checking for the section
  the right test, not the behavior. **The straight-to-close-out case does not
  stop at close-out**: with no UAT owed there is nothing left to verify, so
  in the same pass I finish whatever close-out items remain, set
  `stage:done`, and close the issue as completed with a comment naming the
  PR, per
  [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md#closing-an-issue)'s
  *Closing an issue*. **When it is a product-visible fix that shipped no
  UAT section (the Tier A case), the closing comment aims David**: one line —
  where in the app to glance next time he's there, and to reopen the issue if
  the symptom persists. Still never `stage:done` at the merge click: the
  verified sync comes first, the same reason the Project's built-in
  `PR merged → Done` workflow is off.
- **Any other issue this PR completes** — named with `Closes #N` in the
  body, so GitHub closes it at merge. If the PR completes an issue whose
  number the body left out, I close it by hand at close-out, naming the PR.

**If this PR is one phase of a phased feature, every `waiting:` toggle
updates the parent too — not just close-out.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*Phased features* section, the parent's `waiting:` is supposed to mirror
whoever holds the active phase at all times. Touching it only at close-out
leaves the parent showing a stale holder for the entire review-and-merge
cycle of every phase — so **each time this section moves the phase issue's
`waiting:`** (round-by-round toggling, escalation, merge), mirror the same
value onto the parent, in the same edit, State of Play included.

**The parent's Phases checklist moves when the phase issue itself reaches
`stage:close-out` — never at merge.** This is the same distinction the
general flow above already makes for an ordinary workstream (merge is not
verified work; David's UAT is) — a phase is no different. A product-visible
phase merges into `stage:test-run`/`stage:uat` like any workstream and sits
there through David's UAT before reaching `stage:close-out`; a phase with
no UAT reaches `stage:close-out` sooner, immediately after its verification
checks, but through the same transition, not a merge-time shortcut. Ticking
the checklist at merge instead would let `/next` treat a phase as done —
and surface the next phase, or close the parent — while its own UAT is
still outstanding.

**Keep mirroring the parent's `waiting:` through this entire span**, per
the toggle rule above — that already covers the phase's `stage:uat`/
`waiting:david` transition, so the parent correctly shows "waiting on
David's UAT" for exactly as long as that's true.

**When the phase issue reaches `stage:close-out`, move the parent's
checklist**, in the same edit as the phase's own transition:

- **Tick this phase's checkbox** in the parent's checklist, replacing
  `(active)` with the merged PR number.
- **Re-point the parent's `waiting:`** at whoever holds the next phase — or
  `waiting:claude` when the next phase hasn't been opened yet, since an
  unstarted next phase is work owed, not a resting state.
- **If this was the last phase**, move the parent straight to
  `stage:close-out` and close it out in the same pass, per
  `workstream-tracking.md`'s *Closing an issue*: finish what its State of
  Play lists, set `stage:done`, and close it as completed with a comment
  naming the phase PRs. It holds at close-out only with a named remaining
  item. There is no separate whole-feature UAT gate — every
  phase already ran its own UAT wherever it was product-visible, per
  `workstream-tracking.md`'s *Phased features* section, so a UAT stage here
  would be a gate with nothing left to run against it.
- **If a phase's own UAT surfaced a bug**, that's the UAT-descent case —
  see `workstream-tracking.md`'s *When UAT finds a bug* section for the
  `Blocked by:` marker that records the way back up. The phase stays open
  (not `stage:close-out`) until that descent resolves, so the checklist
  correctly doesn't tick early.

**At the close-out of any workstream, check whether it was the target of a
`Blocked by:` marker** — one `search_issues` call, `"Blocked by: #<this
issue>" in:body`, trusted-issue filtered the same way every other marker
lookup here is. If a match comes back, that match is a parent this closure
just unblocked — but what to do about its `waiting:` depends on whether
this is the UAT-descent shape:

- **If the matched issue's State of Play records a stashed prior
  `waiting:` value** (only `bugfix`'s UAT-descent intake writes one, per
  `workstream-tracking.md`'s *When UAT finds a bug*) — **restore it**
  (normally back to `david`) and remove the now-stale `Blocked by:` line.
  Skipping this leaves the unblocked parent sitting at `waiting:claude`
  indefinitely — mechanically releasable per the `Blocked by:` contract,
  but with no open question left for anyone to notice needs restoring.
  **If that matched issue is itself a phase sub-issue, restore its
  parent's `waiting:` the same way, in the same edit** — `bugfix` mirrors
  the descent flip onto the parent at intake, so the restore has to mirror
  back the same way, or the parent is left stuck at `waiting:claude` after
  the phase itself has already recovered.
- **Otherwise** — an ordinary workstream-to-workstream dependency, or a
  blocked backlog item — **only remove the stale `Blocked by:` line.**
  Nothing stashed a prior value for these, so guessing a `waiting:` (or
  adding one to a `queue:`-only item that shouldn't carry the label at
  all) would fabricate state instead of restoring it. Their own next
  `waiting:`-touching moment sets the right value normally.

**Every transition above lands with a State of Play update in the same
edit** — the block's `Stage`/`Waiting on`/`Last movement` fields at minimum,
and `Where it actually stands`/`What's blocking` whenever there's real
narrative to add (a round's findings, an escalation's actual question, what
shipped at merge), all of it under the canonical disclosure check — on a
workstream that turned sensitive after its issue opened, the issue gets the
sanitized tracking only and the narrative goes in the draft item
(`workstream-tracking.md`). Per `workstream-tracking.md`'s ownership rule: the skill
that moves the label moves the block, in the same edit, every time.

An echo of my own comment bouncing back as a webhook event still needs the
silent live-state check like any other event, but never a label change on
its own — only real state (a new commit, a new finding, an actual merge)
moves a label.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — judge every finding under the Worth rule with both
assessments in hand, and take to David only what is his.
