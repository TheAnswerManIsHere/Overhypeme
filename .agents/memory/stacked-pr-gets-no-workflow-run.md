## A stacked PR gets no workflow run at all — but zero runs does NOT prove that

`.github/workflows/build.yml` triggers on `pull_request` with `branches: [main]`.
That filter matches the **base** branch, so a PR stacked on another feature
branch never matches and **no workflow run is ever created for it**. Observed on
PR #490 (2026-08-17), which was based on `claude/guard-curl-url-parsing` and
went its whole life without CI until it was retargeted.

The trap is that `get_check_runs` returns `total_count: 0` — byte-identical to
CI simply not having reported yet — so the natural reading is "wait longer."

**Zero workflow runs is an AMBIGUOUS symptom, not a diagnosis.** At least two
causes produce it, and they need opposite responses:

| Cause | How to confirm | Response |
| --- | --- | --- |
| Base-branch mismatch (this note) | The PR's base is not `main`; **other** PRs in the repo are getting runs normally | Retarget to `main` |
| GitHub Actions incident | `githubstatus.com` incident history; other PRs *also* have no runs, or runs stuck `queued` | Wait; it self-resolves |

See [`github-actions-outage-mimics-quota.md`](./github-actions-outage-mimics-quota.md)
for the incident case, which cost a full round of wrong investigation on PR #334
— including a "quota-shaped" billing number that looked like confirmation and
wasn't. **Treating absence of runs as proof of a trigger mismatch would
misdiagnose that case exactly**, which is why the two notes cross-reference
rather than each claiming to be the explanation. (Codex, #505 round 1.)

The discriminator that separates them cheaply: **is this PR the only one
without runs?** A trigger mismatch is PR-specific; an incident is not.

**Consequences of the stacked case, worth knowing before stacking:**

- **The merge bar cannot be met while stacked**, because item 1 is CI green and
  there is no CI. That is the bar working, not a defect to route around.
- **Retargeting to `main` is what starts CI**, and it works because `edited` is
  in the trigger's `types` list. Verified empirically on #490 after #488 merged.
- **A local test count is not CI.** "276/276 locally" says nothing about whether
  the repo's checks ran, and on a stacked PR they provably did not.

Not a bug in `build.yml` — restricting runs to PRs targeting `main` is
deliberate. The interaction with stacking is just invisible from the PR page.
