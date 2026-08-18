## GitHub Actions runs silently not starting can be a status.github.com outage, not a quota/billing problem

Diagnosing "workflow checks aren't running" (PR #334, 2026-08-06): pushes
landed on GitHub fine, but zero workflow runs were created for them — not
failed, just never created — and a few runs elsewhere in the repo sat
stuck in `queued`, flapping. The billing page showed a dollar figure close
to the included-minutes cap, which looked like confirmation of a quota
exhaustion. It wasn't: the repo is **public**, and GitHub Actions on
standard runners is free and unmetered for public repos — every metered
line on that billing page actually read **$0 used**; the dollar figure
was the *notional* value of usage, already 100%-discounted. The real
cause was a GitHub-wide Actions incident (webhook triggers throttled to
~15% throughput, jobs failing to start or timing out in queues) confirmed
on `githubstatus.com`'s incident history — it self-resolved in ~11 hours
with no action needed.

**Check `githubstatus.com`'s incident history before reasoning about
quotas/billing** when Actions runs stop appearing — the observable
symptoms (silent non-starts, stuck queues, "quota-shaped" billing numbers)
are close to indistinguishable from an actual limit being hit, and jumping
to the billing explanation first cost a full round of investigation and a
wrong explanation delivered to David before the outage was found.

**A third cause produces the same zero-runs symptom:** a `pull_request`
trigger whose `branches:` filter doesn't match the PR's base — see
[`stacked-pr-gets-no-workflow-run.md`](./stacked-pr-gets-no-workflow-run.md).
The cheap discriminator between that and an incident is **whether other PRs
are also missing runs**: a trigger mismatch is PR-specific, an incident is
not. So zero workflow runs is never itself a diagnosis, in either direction.

