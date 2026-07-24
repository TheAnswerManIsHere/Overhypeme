---
name: This environment has no tool/API access to GitHub's Dependabot Alerts endpoint
description: No GitHub MCP tool exposes /repos/{owner}/{repo}/dependabot/alerts; a direct REST call via the session's own GITHUB_TOKEN through the agent proxy is deliberately blocked (403, not a misconfiguration). Screenshots from the user are the working path.
---

# No programmatic access to Dependabot alerts in this environment

## What happened

Needed to triage all open Dependabot security alerts (distinct from open
Dependabot *PRs*, which are a strict subset — GitHub doesn't open a PR for
every alert, e.g. transitive deps without a direct fix). Checked every
available avenue:

- `mcp__github__*` tools: cover PRs, issues, code search, Actions, secret
  scanning — **no `list_dependabot_alerts` or equivalent.**
- `list_issues` / `list_pull_requests`: alerts aren't issues; only one
  Dependabot PR was open, covering a fraction of the actual alert count
  (54 alerts vs. 1 open PR).
- `WebFetch` on the GitHub Security UI: explicitly documented as unreliable
  for authenticated GitHub pages (returns a login wall, not content).
- Direct REST call using the session's own `$GITHUB_TOKEN`/`$GH_TOKEN`
  against `api.github.com/repos/{owner}/{repo}/dependabot/alerts`: returned
  **403** with body
  `{"message":"GitHub access is not enabled for this session. An org admin
  must connect the Claude GitHub App for this organization."}` — this is the
  agent proxy deliberately scoping GitHub access to the specific endpoints
  the GitHub MCP server's app permissions cover. **Not a bug to route
  around** — stop trying alternate raw-API paths once you hit this.

## What actually worked

Asked the user to open **Security → Dependabot → Vulnerabilities** in the
GitHub UI themselves and share screenshots. The Read tool renders images
fine, and GitHub's alert list UI carries everything needed for a real
triage: title, severity badge, alert number, source package + ecosystem,
manifest file, and (when Dependabot already computed a fix) a link to the
PR that would close it. Cross-referencing package names against the repo's
own `pnpm-lock.yaml` (direct vs. transitive, current resolved version) turned
screenshots into an actionable, grounded triage.

## Takeaway

Don't spend a round re-discovering this from scratch in a future security
pass in this repo (or likely any repo in this same Claude Code Remote
environment, since the gate is proxy-level, not repo-specific). Go straight
to asking the user for the Dependabot alerts list/screenshots rather than
hunting for a tool or API path that doesn't exist here.
