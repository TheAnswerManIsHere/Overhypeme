---
name: maintenance
description: Weekly repo maintenance ritual. Use when David says /maintenance or asks for the weekly maintenance pass. Triages the Dependabot PR queue (merges green minor/patch bumps, flags majors), reviews production errors (Sentry), checks CI health on main, and delivers a "what shipped this week" digest. Ops-shaped, Sonnet-tier work.
---

# Weekly maintenance

David invokes this roughly weekly (`/maintenance`). It is **ops work** —
per the CLAUDE.md tier table this belongs on **Sonnet**; if the session is
on a higher tier when invoked, I say so and suggest switching before
starting, but I don't block on it.

The deliverable is one concise report at the end covering the five areas
below. If an area has nothing to report, one line ("no open dependency
PRs") — the discipline stays visible, the report stays short.

## 1. Dependabot queue triage

1. List open PRs with the `dependencies` label
   (`mcp__github__list_pull_requests`, small batches).
2. For each PR, check CI status via a single `pull_request_read` call
   (`minimal_output: true` where possible).
3. **Grouped minor/patch PRs with green CI → squash-merge them**
   (standing authorization, David 2026-07-22 — this is the one merge I
   perform myself; everything else in the repo stays David-merges-only).
   If CI is red, diagnose briefly: a flaky run gets one re-trigger; a real
   incompatibility gets flagged, not merged.
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

## Report delivery

Single message, five short sections, worst news first. When something needs
David's decision (major bump, alarming Sentry issue, recurring flake), it
goes in a numbered question list at the end per the numbered-questions rule.
If the report is substantial, also publish it as an Artifact page (per the
CLAUDE.md artifact-delivery preference) — the chat message remains the
canonical copy.

## Boundaries

- **No feature work, no refactors, no drive-by fixes** — anything
  discovered here that needs real code change becomes a flagged item for
  David, or a `/bugfix` batch if he says so. Maintenance touches nothing but
  dependency merges, **with one narrow exception**: committing updates to
  [`docs/engineering/deferred-work.md`](../../../docs/engineering/deferred-work.md)
  (step 4) — recording a newly-parked item or updating an entry's status.
  That's docs-only, zero behavior/dependency change, no PR ceremony, and
  matches the tier table's "documentation is Sonnet-always, drift is
  self-catching" rationale. It is **not** license to fix, refactor, or bump
  anything the backlog pass turns up — a fired trigger for a *major* bump
  (dependency or Action) still only ever becomes a reported decision item,
  never a direct action, per step 4 above.
- **No scheduled self-wakeups.** David invokes this manually (standing
  no-background-check-ins rule). If he later opts into a scheduled weekly
  routine, that decision changes this section — not before.
