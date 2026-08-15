---
name: maintenance
description: Weekly repo maintenance ritual. Use when David says /maintenance or asks for the weekly maintenance pass. Triages the Dependabot PR queue (merges green minor/patch bumps, flags majors), reviews production errors (Sentry), checks CI health on main, and delivers a "what shipped this week" digest. Ops-shaped, Sonnet-tier work.
---

# Weekly maintenance

David invokes this roughly weekly (`/maintenance`). It is **ops work** —
per the CLAUDE.md tier table this belongs on **Sonnet**; if the session is
on a higher tier when invoked, I say so and suggest switching before
starting, but I don't block on it.

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
  no PR ceremony needed) — the one Boundaries exception, see below.
- If nothing fired and nothing's new, one line: "deferred-work backlog: N
  items, no triggers fired."

## 5. "What shipped" digest

- List PRs merged since the last maintenance run (default window: 7 days).
- Write it **PM-facing**: what changed in product terms, one line per PR,
  grouped as features / fixes / dependencies / infra. Not a commit log.

## 6. Loop-efficacy digest — flush first, then digest, then the conversation

**Step 6a — the ledger flush (David, 2026-08-15).** Loop records are no
longer written at each loop's close; this pass is where they get created.
List the loops that reached their terminal point since the last maintenance
run (the closed-PR inventory below already covers this window), and for each
one with no record yet: run `node scripts/loop-metrics.mjs --pr <n> --write`
(or `--mcp-snapshot`, per the shared contract's mechanics in
[`working-modes.md`](../../../docs/ai-context/working-modes.md#the-loop-ledger)),
fill the judgment, run the blind adjudication where sampled, and commit the
records together as part of this pass. **There is no settling-window
skip** — `working-modes.md`'s standing rule is that terminal point (closed
or merged) is eligibility, full stop; a loop whose review lands late gets
its record re-derived and edited at a future flush, not held back from
this one. The flush runs
**before** the digest so the completeness check below runs against flushed
state — a gap it still names afterward is a real miss to fix in this same
pass, not a report line.

**Delivery route (David, 2026-08-15).** The records need an ordinary
reviewed PR to reach `main` — this repo requires a PR before merging, and
the ledger contract bans a standalone ledger-only PR the same way it
always has. Two cases: **if any of my own PRs are open**, the flush commit
rides one of them as a normal additional commit (any PR except the one a
given record measures, per the loop-ledger's own rule). **If none are
open**, this pass opens one small `docs(maintenance): weekly digest` PR
carrying the flush commit plus this week's `deferred-work.md` updates (the
other docs-only exception in Boundaries below) — reviewed by Codex like any
docs-only PR (first pass + at most one re-request, per the ceremony table),
then self-merged under the general close-out rule once ready. Never skip
straight to a direct push: that bypasses the Codex pass the ledger contract
still requires.

**Step 6b — the digest.** **Build the closed-PR inventory and pass it — this step is required, not
optional.** Since this PR retired CI's coverage gate, the digest's
`--inventory` completeness check is the *only* remaining mechanism that
notices a missing record; skipping it every week means coverage can rot
indefinitely while the report keeps saying "not checked" and nobody notices.
List closed PRs (`mcp__github__list_pull_requests`, `state: closed`,
paginated in small batches) back through `FIRST_RECORDED_PR` in
`loop-report.mjs` (read the constant rather than hardcoding it here — it moved
once already when a late `[LEDGER]` PR landed rows during the cutover) —
**not just the last maintenance window.** `missingRecords()` has no settling
window (David, 2026-08-08) — a loop closed seconds ago is eligible to be
flagged — so the risk isn't recency, it's an inventory that only covers the
last 7 days and silently drops an older gap that opened before the lookback
started; the "every closed loop has a record" line would then read as
checked when only the last week actually was. Keep
`number`/`title`/`closed_at`/`user.login` for each PR — write the array to a
scratch JSON file and pass it as `--inventory <file>`. If GitHub access
genuinely isn't available this run, say so explicitly in the report
("completeness not checked — GitHub access unavailable") rather than
silently running without `--inventory` and letting the section read as
routine.

Run `node scripts/loop-report.mjs --inventory <file>` and **narrate the
result to David in plain language** — a few sentences, not the raw tables.
The script computes; this step interprets; David decides.

**Step 6c — the "how are we doing" conversation (David, 2026-08-15).** The
narrated digest opens the weekly conversation David actually wants from the
ledger: *how are we doing, and is there anything we can improve?* Beyond
the numbers, bring anything the week's loops suggest about the process
itself — a tripwire that keeps firing, a decline pattern, a ceremony that
looks mismatched to its artifact class — as candidates, for him to engage
with or skip. This conversation is the ledger's entire delivery surface
now; a flush-and-digest with no interpretation is the measurement half
shipping without the delivery half again.

This section exists because the measurement half shipped in PR #270 and the
delivery half never did: for a year the answers sat in a file David doesn't
open, and he discovered the records were duplicating by stumbling into it.
**The digest is the product** — if it isn't narrated, the whole system is
back to where it was.

What to actually say:

- **The headline, if there is one.** Churn moving, an unusually expensive
  loop, a run of clean ones. If nothing moved, say that in one line.
- **Anything actionable.** A deferral that has been open for weeks, a loop
  whose adjudication tripped the disagreement gate, missing records piling
  up. These are named individually in the digest precisely so they can be
  acted on rather than counted.
- **Honest uncertainty.** Below three qualifying loops the digest says "not
  yet informative" — pass that through rather than dressing two data points
  as a trend. The frozen ledger withdrew two such readings already.

**Always run the digest, even on a week where nothing closed** — the
data-health and completeness checks are all-time, not windowed, and this
digest is now the only mechanism that ever notices a missing or stuck
record. A quiet week with a real deferral or a growing missing-records list
still has something to say; only the empty-volume commentary is skippable.
Say "no loops closed this week" in one line and go straight to data health,
rather than dropping the section entirely.

## 7. Replit commit review

Retrospective read of what Replit pushed straight to `main` this week — the
only enforcement point on that path, since nothing gates the push itself.
Full rationale in
[`replit-environment.md`](../../../docs/ai-context/replit-environment.md).

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
2. **Skim** anything UI/copy/test-only — no deep read needed.
3. **Actually read** anything touching a migration, schema, auth, or payment
   path — full diff, not just the commit message (a Replit commit message is
   a checkpoint label, not a description to trust at face value; see
   `replit-environment.md`'s note on checkpoints vs. intent).
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

## Report delivery

Single message, eight short sections, worst news first. When something needs
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
  and committing the loop-ledger flush records (step 6a). Both are
  docs-only, zero behavior/dependency change, no PR ceremony, and match
  the tier table's "documentation is Sonnet-always, drift is
  self-catching" rationale. Neither is license to fix, refactor, or bump
  anything the backlog pass turns up — a fired trigger for a *major* bump
  (dependency or Action) still only ever becomes a reported decision item,
  never a direct action, per step 4 above.
- **No scheduled self-wakeups.** David invokes this manually (standing
  no-background-check-ins rule). If he later opts into a scheduled weekly
  routine, that decision changes this section — not before.
