---
name: The agent proxy blocks ALL direct api.github.com calls from bash — GitHub state comes only from MCP tools
description: Any curl/fetch to api.github.com from a Bash tool call returns 403 "GitHub access is not enabled for this session", whatever the endpoint, token or URL. A poll loop built on it does not fail — it silently returns nothing and sleeps, which looks exactly like "still waiting". Use mcp__github__* for every GitHub read.
---

# There is no bash path to the GitHub API in this environment

## The mechanic

No bash transport yields usable GitHub API data — **but the two available
transports fail for different reasons, and confusing them wastes a diagnosis.**
All four cells measured 2026-08-16:

| From Bash | No token | With `$GITHUB_TOKEN` |
| --- | --- | --- |
| **`curl`** | 403 *"GitHub access is not enabled for this session"* | 403, identical |
| **Node `fetch`** | 403 *"API rate limit exceeded for `<ip>`"* | 401 *"Bad credentials"* |

**The difference is the proxy, not GitHub.** `HTTPS_PROXY` is set
(`http://127.0.0.1:39015`); **`curl` honours it and Node 22 does not** without
`NODE_USE_ENV_PROXY`. So:

- **`curl` never leaves the box.** The agent proxy intercepts and answers with
  its own 403 — *"GitHub access is not enabled for this session"* is the proxy
  talking, not GitHub.
- **Node `fetch` goes straight to the real api.github.com**, where it is either
  an anonymous rate-limited caller or presents `GITHUB_TOKEN`, which is scoped
  to the local git proxy and is **not a GitHub API credential** — hence "Bad
  credentials".

**Read the failure to know which one you hit.** A 403 with the "not enabled"
body means the proxy stopped you. A 401 "Bad credentials" or a rate-limit 403
means you reached GitHub and the credential is wrong or absent. Neither is
fixable from bash, but only the second would ever tempt you to go hunting for a
better token — and there isn't one.

This is why `CLAUDE.md` and `scripts/loop-metrics.mjs` both say **401**: that
script uses Node `fetch`, so 401 is exactly what it sees. Those statements are
correct for their transport, and an attempt to "correct" them to 403 during
this very investigation was itself the error — caught by review, on the grounds
that the claim had been generalised past the transport actually tested.

The agent proxy
deliberately scopes GitHub access to what the GitHub MCP server's app
permissions cover, and nothing reaches the REST API outside that. This is not a
misconfiguration and **not something to route around** — stop trying alternate
raw-API paths the moment you see that message.

`GITHUB_TOKEN` / `GH_TOKEN` being present in the environment does not mean the
API is reachable. The token is proxy-scoped; the proxy is the gate.

## Why this is worse than a plain failure

A blocked call **does not look blocked** inside a shell pipeline. It returns a
short JSON error with HTTP 200-ish handling, so anything that greps it for a
field just finds nothing:

```bash
# Looks like a CI wait. Is actually a sleep with extra steps.
until [ "$(curl -sS ".../check-runs" | grep -c '"status": "in_progress"')" = "0" ]; do
  sleep 25
done
```

`grep -c` returns `0` on the error body, so this exits immediately and reports
success. Add a guard requiring `total_count` before trusting the response, and
it inverts: the guard never passes, so the loop sleeps its full duration and
reports a timeout. **Both readings are wrong, and neither mentions GitHub.**

This happened at scale on 2026-08-16: every CI-wait loop in a long session was a
pure sleep. They appeared to work because CI genuinely was green by the time
each one ended. The one that didn't ended in a silent 12-minute wait on a PR
whose checks had been green for 25 minutes — surfaced only because David asked
"are you stuck?".

**Then the diagnosis was wrong too.** The first explanation reached for was a
malformed URL (a branch name where a SHA belongs). Plausible, confidently
stated, and false — the SHA form is blocked identically. The mechanism was only
established by running both and reading the actual output.

## What to do instead

**Bash's only role in waiting is `sleep`. Truth comes from an MCP tool.**

```
sleep 120                                     # bash: the delay, nothing more
mcp__github__pull_request_read                # the actual check
  method: get_check_runs, pullNumber: <N>     # takes a PR number — no URL to get wrong
```

Repeat if still pending. Each check costs a turn, which is cheap next to sitting
on a dead loop. `get_check_runs` takes a **PR number**, so there is no SHA or
ref to mistype, and a genuine failure surfaces as a tool error rather than an
empty grep.

**Never describe a wait as having verified something it could not observe.** If
the loop only slept, say it slept.

## Scope

Proxy-level, so it holds for **any repo in this Claude Code Remote
environment**, not just this one.

Originally filed narrowly as *"the Dependabot Alerts endpoint is unavailable"*
after a security pass burned a round rediscovering it. That title was the
problem: the finding is that **the whole REST API is unreachable from bash**,
and the narrow framing meant the note was read and not applied to CI polling
months later. Renamed and generalised for that reason.

Dependabot alerts remain a worked instance — no `mcp__github__*` tool covers
`/repos/{owner}/{repo}/dependabot/alerts`, `WebFetch` hits a login wall on
authenticated GitHub pages, and the working path is asking David for
screenshots of **Security → Dependabot → Vulnerabilities**, which carry
everything a real triage needs (title, severity, alert number, package,
manifest, and any fix PR).
