<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# This environment's git constraints — the layers, the table, the procedures

> **What this is.** The reference half of `claude-core.md`, *This
> environment's git constraints*: what each layer blocks, which commands
> work, and the procedures. The rules themselves are stated there, and the
> contract governs on any conflict.

Two layers, in order of authority: the **harness classifier** refuses to let me
edit my own guardrails in place (a guard change goes through a PR like any
other); and **GitHub's rulesets**, server-side, binding on **everyone who
pushes, me included**, in every shape, **to the branches they target**, and on
no other branch.

On `main`, with **no bypass actor**: block force pushes, restrict deletions,
require linear history, require a PR, require status checks, require
conversation resolution. On **all branches**, `claude/**` included: block force
pushes.

**They bind David too, and every change to `main` arrives through a pull
request** — no identity lands on `main` outside a merged PR, his and this
session's admin account included. His display-only tweaks from Replit too: the
Repl tracks `main`, so a tweak is committed there unless he branches first, and
that commit can never be pushed. When I find the Repl's `main` ahead of
GitHub's, I move those commits to a branch through the connector, push it,
realign the Repl's `main` to GitHub's, and open the PR; it merges like any
other — on green CI when he declares it Trivial. The close-out sync is where I
find it (*Close-out*, step 3). I never drop such a commit unless he says to. A
commit on `main` with no PR behind it means a ruleset has been loosened: one
line to David
([`replit-commits-reach-main-only-through-a-pr.md`](../../.agents/memory/replit-commits-reach-main-only-through-a-pr.md)).

**There is no local shell guard.** Force pushes are blocked by the rulesets,
`drizzle-kit push` by `permissions.deny`, `curl`/`wget` by the agent proxy, a
root `rm -rf` by the ephemeral container.

**I never force-push, and no flow of mine needs to.** That is a rule about me,
not a fact about the server, and it covers a repo whose rulesets are not yet
configured. It is also mechanical on every branch: `--force-with-lease` is
refused with GH013 outside `claude/**` too, which is the protection a
`prototype/<feature>` branch relies on.

**The one shape that would need a force push**: restarting a branch in place,
under the same name, before it has merged. The remedy is a new branch name and
a new PR — or, for a `prototype/<feature>` branch, a new name written into its
registry line. Everything else never rewrites history: squash-merge handles
rebasing and commit messages, rotation handles a leaked secret (a rewrite does
not unpublish it), and `git checkout -B <branch> origin/<branch>` handles a
diverged local copy.

| Command | Result |
|---|---|
| any force push, any shape, any branch | blocked by a ruleset |
| a plain push of new commits to `claude/**`, or to a `prototype/<feature>` branch ([`working-modes.md`](../../docs/ai-context/working-modes.md#the-prototype-phase-per-feature-david-2026-09-26)) | **works** — this is every flow |
| `git reset --hard` | works (cannot reach the remote) |
| `git push origin --delete <branch>` | does **not** work (proxy hangs) |
| `git checkout -B <branch> <ref>` | works — my reset primitive |

**A bad pushed commit gets a corrective commit. Never rewrite pushed
history.** Rebasing "to sit on top of main" is unnecessary — squash-merge
3-way-merges against current `main`.

- **First push of a fresh branch:** `git fetch origin main && git checkout -B
  <branch> origin/main`, apply work, push. Also how I restart a branch whose PR
  squash-merged — a plain push, since GitHub deleted the merged branch.
  GitHub's `main` needs no sweep of who committed there. **A session on a
  branch-regime prototype sweeps that branch instead**, the one place on
  GitHub direct commits still land — `git fetch origin prototype/<feature>`
  and then `git log --author="Replit Agent" --since="14 days ago" --oneline
  origin/prototype/<feature>`. **Bounded by time, never by commit count**
  (`-3` silently drops the fourth commit of a busy week). What a sweep finds
  goes into the feature's next version (*Connectors → Replit*).
- **Follow-up on an already-pushed branch:** add commits and plain-push. If the
  branch genuinely needs newly-landed `main`, **merge, never rebase**.
- **If local has diverged accidentally:** realign with `git checkout -B
  <branch> origin/<branch>` and continue; the local copy yields.

Only ever to my feature branch, never `main`. `git diff origin/main HEAD
--stat` shows the true delta.
