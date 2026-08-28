---
name: maintenance
description: Weekly repo maintenance ritual. Use when David says /maintenance or asks for the weekly maintenance pass. Triages the Dependabot PR queue (merges green minor/patch bumps, flags majors), reviews production errors (Sentry), checks CI health on main, and delivers a "what shipped this week" digest. Ops-shaped, Sonnet-tier work.
---

# Weekly maintenance

David invokes this roughly weekly (`/maintenance`). It is **ops work**, and
it runs in whatever session it was invoked in — **I do not suggest a model
switch for it.** The *Fable to explore, Opus to build* rule (David,
2026-08-28, see `CLAUDE.md`'s *Model, cost, and routing*) asks for a switch
before **product code**, which this pass never writes: its two docs-only
exceptions and its dependency merges are not building. A `/bugfix` that comes
*out* of this pass is building, and takes the tier its own classification
calls for.
Bounded, stateless pieces of the pass — a research sweep, a self-contained
lookup — are eligible for a Sonnet subagent; the triage judgements are not.

**The triage judgements are a standing dispatch BAR** under `CLAUDE.md`'s
*Whether a judgement dispatches is fixed in advance* — they run in my main
loop, settled, not pending classification.

Two earlier versions of this line were both wrong, and the second is the
instructive one. It first excluded them from *Sonnet* delegation while saying
nothing about Fable, leaving them undefined once the always-Fable rule landed.
The fix then marked them "unclassified" — but that global default treats
unclassified as **temporary**, a signal to go classify the surface in a PR, so
every weekly run would have manufactured a standing follow-up obligation for a
behaviour that is already settled. **A permanent intent must not be expressed
in a state the contract defines as transitional.** (Codex, #504 rounds 2-3.)

Why barred rather than mandated: these are continuous ops judgements over a
queue the main loop is already holding — which bump to merge, which error
matters, which trigger has fired — not a bounded verdict on packageable
material. Removing this bar is a contract change that ships in a PR.

The deliverable is one concise report at the end covering the seven areas
below. If an area has nothing to report, one line ("no open dependency
PRs") — the discipline stays visible, the report stays short.

## 1. Dependabot queue triage

1. List open PRs with the `dependencies` label
   (`mcp__github__list_pull_requests`, small batches).
2. For each PR, check CI status via a single `pull_request_read` call
   (`minimal_output: true` where possible).
3. **Grouped minor/patch PRs with green CI → squash-merge them**
   (originally the one merge I performed myself, David 2026-07-22; since
   2026-08-15 subsumed by the general self-merge rule in CLAUDE.md's
   close-out contract). If CI is red, diagnose briefly: a flaky run gets
   one re-trigger; a real incompatibility gets flagged, not merged.
4. **Major-version bumps are never auto-merged.** For each, one line in
   the report: package, old → new, why it matters (or doesn't), and my
   merge/hold recommendation. David decides.

## 2. Production errors (Sentry)

The API read needs **two** things, not one: a `SENTRY_AUTH_TOKEN` in the
environment **and** network egress to `sentry.io`. The Claude Code
environment's network policy may block the host even when the token is
present — a `403` on the proxy CONNECT tunnel is a policy denial, not a
token problem, and per the environment README it is reported, never
retried.

- **If both hold** (token present AND `sentry.io` reachable), pull the
  week's new/regressed issues for the project and summarize: top issues by
  event count, anything new since last week, anything payment- or
  auth-path-touching (those get flagged loudest).
- **Otherwise fall back to the manual path** — whether the token is
  missing, the host is blocked by network policy, or the call errors. Say
  exactly which of the three it was, then give David the one-liner ask:
  open the Sentry dashboard → Issues → sort by "New" for the last 7 days,
  and paste anything that looks alarming into the chat for triage. Never
  silently skip the section, and never retry a 403 policy denial.

**Verified working recipe (2026-07-23).** Org slug is `overhypeme`. The
token is scoped **Issue & Event: Read only** (least privilege), which is
enough for the one endpoint this section needs:

```
GET https://sentry.io/api/0/organizations/overhypeme/issues/?statsPeriod=7d&query=is:unresolved
    Authorization: Bearer $SENTRY_AUTH_TOKEN
```

Each returned issue carries `title`, `culprit`, `count`, `permalink`, and
a `shortId` whose prefix identifies the project. **A `403` from the
list-projects (`/organizations/{org}/projects/`) or org-detail
(`/organizations/{org}/`) endpoints is EXPECTED and not a failure** — those
need `org:read`, which the token intentionally lacks. Do not read that 403
as "no access" and fall back; only a failure on the issues endpoint above
triggers the manual path.

## 3. CI health on main

- Pull recent workflow runs on `main` (`mcp__github__actions_list`).
- Report: pass rate over the window, any failing or flaky jobs (same job
  failing then passing on re-run = flaky — name it), and unusually slow
  runs. A flaky test that shows up twice across maintenance runs should
  graduate to a fix task, not stay a report line.

## 4. Deferred-work backlog triage

Read [`docs/engineering/deferred-work.md`](../../../docs/engineering/deferred-work.md)
and re-check **each entry's revisit trigger**:

- **Any trigger that has fired** (a dated cutoff reached, a dependency shipped
  its fix, a recurrence count hit, a security advisory landed) → surface it to
  David as a numbered decision item in the report. Don't act on the underlying
  bump/change here — see Boundaries.
- **Newly parked items** discovered this pass (a major bump held in step 1, a
  deprecation spotted in a lockfile or CI log) → add them to the doc with the
  four-field entry template, and commit that doc change directly (docs-only,
  shipped via the single maintenance docs PR) — the one Boundaries
  exception, see below.
- If nothing fired and nothing's new, one line: "deferred-work backlog: N
  items, no triggers fired."

## 5. "What shipped" digest

- List PRs merged since the last maintenance run (default window: 7 days).
- Write it **PM-facing**: what changed in product terms, one line per PR,
  grouped as features / fixes / dependencies / infra. Not a commit log.

## 6. Documentation harvest + process health

**Step 6a — the batched Type 2 documentation harvest (David, 2026-08-20).**
This pass is where subsystem docs and Manual chapters get written. **The
window boundary is mechanical, not recalled** (Codex, #543 round 2): the
previous pass's own docs PR is the durable marker — list closed PRs whose
title starts with `docs(maintenance):` and take the latest one's merge time
as the window start. **Every completed pass produces that marker, including
a no-change pass** (Codex, #543 round 3): the pass always updates the
`Last maintenance pass:` line in `deferred-work.md`, so even a week with
nothing to harvest and nothing deferred still ships a one-line
`docs(maintenance):` PR — that line IS the boundary the next pass reads.
If no marker exists at all (first pass under this contract), fall back to
the last 7 days and say so in the report rather than presenting the
fallback as the real boundary. Run `/document` once, covering every product
feature merged in that window — its sources are the **harvest-notes comments on each
feature's workstream issue** (posted at close-out) plus the merged diffs.
Process PRs get no harvest. Type 1 learnings — anything that changes how we
work — were already persisted the moment they were learned and are not
re-harvested here.

**Step 6b — process health, pulled from the GitHub record.** There is no
ledger any more, so these are counted fresh each pass rather than read from
stored records. From the merged-PR list for the window:

- **Meta vs. product share.** How many merged PRs were product-facing versus
  process/guard/docs-about-process. This is the number that started the
  2026-08-20 review: it was running about 70% meta over three weeks.
- **Rounds per loop.** From the PRs' own review history — how many product
  loops ran, and how long each took. **Build the inventory from BOTH merged
  implementation PRs and closed `[PLAN REVIEW]` PRs in the window** (Codex,
  #543): plan-review PRs always close without merging, so a merged-only list
  silently drops every plan loop — often the longest ones — and understates
  review cost.
- **Adjudicator verdicts — both kinds** (Codex, #543 round 3). Exhaustion
  verdicts are the committed `.agents/receipts/` files (a directory read).
  Ordinary per-round verdicts never become receipts by design — they live as
  one-liners in each loop's defanged context comments and findings ledgers —
  so read them from the window's PR histories, or the count will show zero
  precisely when the judge is doing its best work (stopping loops before
  their cap). A run of `continue` verdicts would mean the adjudicator is
  being talked into extensions, which is the mechanism failing in the way it
  was built to resist.
- **Guard incidents that needed David.** Rare by design; if it isn't rare, say
  so.

**Step 6c — the "how are we doing" conversation.** Narrate the numbers in a few
plain sentences — not tables — and open the question David actually wants
answered: *are we doing better, and is there anything to improve?* Bring
anything the week's loops suggest about the process itself: a budget that keeps
being hit (a tier whose budget is wrong is a David conversation, not a silent
adjustment), a decline pattern, a ceremony that looks mismatched to its
artifact. **He is the verdict mechanism** — there is no trial window and no
automatic consequence; these numbers exist so his call is informed rather than
vibes-only. If he judges the apparatus is still costing more than it returns,
the standing recommendation on file is the delete list from the #541 review.

Below three qualifying loops, say "not yet informative" rather than dressing two
data points as a trend.

## 7. Replit commit review

Retrospective read of what Replit pushed straight to `main` this week — the
only enforcement point on that path, since nothing gates the push itself.
Full rationale in
[`replit-environment.md`](../../../docs/ai-context/replit-environment.md).

**This pass is the backstop, not the only sweep** (David, 2026-08-28). Any
session that touches `main` sweeps `Replit Agent` commits opportunistically,
so most weeks the commits here have already been read. **Sweep them again
anyway** — there is deliberately no ledger of what was already covered, on
the same reasoning that retired the review-round tally (a cache of state the
git log already holds, which drifts). Re-reading a display-only diff costs
seconds; assuming someone else read it is how one gets missed.

1. `git log --author="Replit Agent" --since="7 days ago" --oneline main`
   (adjust the window to the last maintenance run, same as section 5). Filter
   on the display name, **not** a specific email address — the repo's history
   has commits from at least two Replit bot identities that share the name
   ("Replit Agent <agent@replit.com>" and
   "Replit Agent <replit-agent@bots.noreply.replit.com>"); an exact-email
   filter would silently skip whichever one isn't currently active, and this
   step is the only retrospective check on direct-to-`main` changes —
   including migrations, auth, and payments — so a missed identity defeats
   the whole point.
2. **Skim** a change that is genuinely display-only — copy, layout, or a
   value already present in the data. No deep read needed.
3. **Actually read** anything that changes behavior, **whatever file it lives
   in**: data, logic, migrations, schema, auth, payments, or the
   visual/enrichment pipelines — full diff, not just the commit message (a
   Replit commit message is a checkpoint label, not a description to trust at
   face value; see `replit-environment.md`'s note on checkpoints vs. intent).
   **A UI file is not evidence of a display-only change.** The Visual
   Overrides regression (#582) was behavior inside the UI layer, so the older
   "skim anything UI/copy/test-only" rule would have skimmed exactly the tweak
   this step exists to catch. The boundary is display vs. behavior, never file
   location — the same one the fast lane itself uses.
4. Anything real found goes through the normal channel: a `/bugfix` PR, or a
   flagged item for David in the numbered-question list. **Never revert or
   modify Replit's work unilaterally** — this is a retrospective read, not a
   gate, and it doesn't block or delay anything.
5. One line in the report either way: "N Replit commits this week, nothing
   found" or naming what was found and what happens next.
6. **Check [`docs/handoff/`](../../../docs/handoff/README.md) for stale
   files, excluding `README.md`** — that file is the folder's own durable
   contract, not a handoff, and is expected to sit there indefinitely; only
   dated handoff files (`<date>-<from>-to-<to>-<topic>.md`) count. Anything
   older than ~7 days (`git log -1 --format=%cd <file>` per file, or
   `git log --diff-filter=A` for when it was added) is a handoff nobody
   addressed and deleted per its contract. Flag each one by name in the
   report as a numbered decision item rather than deleting it yourself — a
   stale handoff usually means the finding inside it needs David's eyes, not
   just cleanup.

If nothing landed from Replit this week, say so in one line and move on —
same discipline as the other sections.

## 8. Branch hygiene sweep

Added 2026-08-12, after a one-off audit found ~24 stale branches had
accumulated while GitHub's "Automatically delete head branches" setting was
off (David has since turned it on). With that setting enabled, a merged
PR's branch cleans up on its own — this section exists for the two shapes
it doesn't cover: **closed-but-unmerged** PR branches, and branches with
**no PR at all**.

1. `mcp__github__list_branches`, paginated. Skip `main` and any branch
   matching `plan-review/<slug>-combined` outright — that shape
   deliberately has no PR (per the plan-review-loop skill's split-loop
   close-out), so it's the one branch whose commit only the branch itself
   retains (see CLAUDE.md's *Approved-plan source* note). Never a deletion
   candidate, full stop, regardless of age.
2. For everything else, check PR state
   (`mcp__github__list_pull_requests` with `head:owner:branch`,
   `state: all`) rather than trusting the branch-list page's own PR-status
   icon — a branch can carry more than one PR over its life (verified
   2026-08-12: `claude/test-run-checklist-structure-lsxraz` alone had
   three), and the UI surfaces only one.
   - **Merged** → shouldn't exist if auto-delete is working. Report it as
     a signal the setting may have lapsed, not just a routine delete
     candidate.
   - **Closed, unmerged** → safe-to-delete candidate. Note the reason if
     the PR body states one (superseded by #N, diagnostic-only, an
     explicit "DO NOT MERGE" plan-review PR) — usually a one-line lookup
     that saves David re-deriving it.
   - **Open** → never a candidate; skip silently, no need to report active
     work every week.
   - **No PR found at all** → do **not** default to "safe." Report
     separately as *needs a look*, not *safe to delete* — a branch with
     real, unique commits and no PR is exactly the shape that turned out
     to hold unaccounted-for work in the 2026-08-12 audit
     (`claude/pr-250-merge-conflicts-8m5oqs` never had one, and its 4
     commits weren't captured anywhere else).
3. Report as a short list: branch name, its PR if any, recommended
   disposition. **I never delete a branch myself** — no tool in this
   environment reaches branch deletion (`git push --delete` hangs on this
   repo's proxy, and there is no GitHub MCP delete-branch call), so the
   list is always for David to act on via GitHub's own branch-list trash
   icon.
4. If nothing's found beyond `main`, exempt branches, and active work, one
   line: "branch hygiene: clean, N branches total, all active or exempt."

## 9. Backlog and dependency hygiene

This is the half that makes `/next` trustworthy. `/next` computes its
recommendation from backlog issues, `queue:` priorities, `Blocked by:`
markers, and Phases checklists (see
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)) —
all of which decay silently. Nothing else re-checks them, and a stale queue
produces a confidently wrong recommendation, which is worse than no
recommendation. David's standing instruction is that he can react well but
can't track state, so this step brings him a **concrete proposed diff** to
approve or amend, never an open-ended "is the backlog still right?"

1. **List both label families** — open issues carrying a `queue:` label,
   and open issues carrying a `stage:` label (`mcp__github__list_issues`,
   paginated, both label sets). Steps 3–4 below sweep `Blocked by:` chains
   and Phases checklists, and both live on `stage:` workstream issues, not
   `queue:` backlog ones — fetching only the backlog set leaves this pass
   unable to see the data it's meant to validate. For the backlog set,
   check the cheap staleness signals: has it been superseded by something
   merged since it was filed? Has its rationale been overtaken? Is it a
   duplicate of another backlog item?
2. **Re-check `queue:` priorities against the roadmap.** Anything labeled
   `queue:now` that hasn't been started in weeks is either mislabeled or
   genuinely blocked — say which. Anything in
   [`current-roadmap.md`](../../../docs/ai-context/current-roadmap.md)'s
   near-term slices with no backlog issue is a **gap**: propose opening
   one, since an item only in prose is invisible to `/next`.
3. **Sweep `Blocked by:` markers** — for each, is the named blocker still
   open? A marker pointing at a closed issue is stale and should be
   removed. Flag two shapes specifically, because both are the
   UAT-descent stack going wrong rather than working:
   - **A chain deeper than 2**, or **any blocker open longer than two
     weeks** — surface it with the park-or-continue question. Pre-launch
     the default is continue, but the call should be *prompted*, not
     silently defaulted (`workstream-tracking.md`'s escape hatch).
   - **A cycle** (A blocked by B, B transitively blocked by A) — a real
     data error that would make every item in it permanently
     non-actionable. Report it; don't guess which edge to cut.
4. **Sweep Phases checklists** — for each parent issue carrying one, does
   it match reality? A phase whose PR merged but whose checkbox is
   unticked makes `/next` recommend work that's already done.
5. **Deliver as a numbered proposed diff**, e.g. "close #431 (superseded by
   #440); drop #418 `queue:now` → `queue:later`; open a backlog issue for
   *Record the Stripe mode on every entitlement source*; remove the stale
   `Blocked by: #405` from #422." David approves, amends, or declines each
   line — **then I apply the approved ones in that same session.** Same
   posture as `/status`: proposed, confirmed, then written, never
   unattended.
6. If nothing's drifted, one line: "backlog hygiene: N queued items, M
   blocked, no drift."

## 10. Contract diet — one rule out, every pass (David, 2026-08-17)

A standing item, not a conditional one. **Each maintenance pass, exactly one
judgment-shaped rule in `CLAUDE.md` is either converted into a mechanical
check or deleted.**

The rationale is the same evidence that produced the round-budget guard: on PR
#488 the judgment-shaped stopping devices went 0-for-15 while pre-registered,
mechanically-collided conditions went 2-for-2. A contract that only grows adds
rules of the losing kind, and each one dilutes attention on the rules that
work. Length is itself a failure mode — a rule nobody can hold in mind at the
moment it applies is not a rule, it is a record of an intention.

How to run it:

1. **Pick one rule** that asks me to *notice*, *remember*, *judge*, or *stay
   vigilant* — as opposed to one that fires on an event or is enforced by a
   guard, a hook, or CI. Prefer rules that have been broken, restated, or
   tightened more than once: the tightening count is the strongest available
   signal that judgment isn't carrying it.
2. **Decide which of the two happens.** *Convert* when there is a real action
   path to hang a check on (a tool call, a commit, a hook point) — that's the
   `.claude/guard.sh` / build.yml pattern. *Delete* when there isn't one, or
   when the rule turns out to be advice rather than a contract. **Deleting is
   a legitimate outcome, not a failure to find a check** — an unenforceable
   rule that stays in the file is worse than no rule, because it reads as
   coverage.
3. **Propose, don't apply.** This is a `CLAUDE.md` edit, so it goes in the
   numbered decision list for David and lands through the normal PR path.
   Guard and permission changes stay David-merge-only per CLAUDE.md's
   close-out carve-outs.
4. **Say which rule you picked and why, every pass** — including a pass where
   the honest answer is "the best candidate this week is weak." One line. A
   silent skip is how a standing item becomes a dead one.

## Report delivery

Single message, ten short sections, worst news first. When something needs
David's decision (major bump, alarming Sentry issue, recurring flake), it
goes in a numbered question list at the end per the numbered-questions rule.
If the report is substantial, also publish it as an Artifact page — the chat
message remains the canonical copy. (CLAUDE.md's combined Artifact-delivery
paragraph this used to cite was retired; only its UAT-specific rule survives,
under *Every PR ships with a Replit test plan + a UAT*, and it doesn't cover
maintenance reports. This is now a standalone maintenance-skill rule.)

## Boundaries

- **No feature work, no refactors, no drive-by fixes** — anything
  discovered here that needs real code change becomes a flagged item for
  David, or a `/bugfix` fix (its own branch and PR per bug — bugfix mode no
  longer batches, see
  [`working-modes.md`](../../../docs/ai-context/working-modes.md#one-bug-one-branch-one-pr-david-2026-07-26))
  if he says so. Maintenance touches nothing but
  dependency merges, **with two narrow exceptions**: committing updates to
  [`docs/engineering/deferred-work.md`](../../../docs/engineering/deferred-work.md)
  (step 4) — recording a newly-parked item or updating an entry's status —
  and the batched documentation harvest (step 6a). Both are
  docs-only and zero behavior/dependency change, and both ship together in
  **one maintenance docs PR per pass** (internal tier: the automatic Codex
  pass, one triage, merge) — one PR for the whole pass, never one per
  harvested feature, per `documentation-workflow.md`'s batched delivery path. Neither is license to fix, refactor, or bump
  anything the backlog pass turns up — a fired trigger for a *major* bump
  (dependency or Action) still only ever becomes a reported decision item,
  never a direct action, per step 4 above. **Step 9's backlog hygiene is
  not a third exception** — it writes only issue labels, bodies, and
  closures, never code, and only the specific lines David approved from
  its numbered diff. An unapproved line is not applied, and "I was already
  in there" is not approval.
- **No scheduled self-wakeups — same conclusion, different reason as of
  2026-08-15.** This used to rest on the blanket no-background-check-ins
  rule. That rule is gone, replaced by the bounded contract in `CLAUDE.md`'s
  *Scheduled self-check-ins* — and that contract doesn't authorize this
  either: a weekly ritual is a recurring heartbeat, not a wait on a named
  external state, and heartbeats are the one thing it still rules out. So
  David still invokes this manually. If he later opts into a scheduled weekly
  routine, that decision changes this section — not before.
