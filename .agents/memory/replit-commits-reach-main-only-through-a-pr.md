---
name: Replit commits reach main only through a pull request — a commit on main with no PR behind it means a ruleset was loosened
description: The sanctioned direct-push lane from Replit to main was retired on 2026-10-03 when David removed every ruleset's bypass; what the old lane taught that still holds, and what replaced it.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Replit commits reach `main` only through a pull request

## The rule now

Every change to `main` arrives through a merged pull request — David's
display-only tweaks from Replit included (David, 2026-10-03: *"Yes,
everything goes through a pull request."*). He removed the Admin bypass from
every ruleset in every repo, so the rulesets bind every identity: his, and a
cloud session's, which pushes as his admin account. The rule's home is
`claude-core.md`, *This environment's git constraints*.

Two `main`s, two meanings. A commit on **GitHub's** `main` with no PR behind
it is not a lane to sweep: it means a ruleset has been loosened, and that is
one line to David. A commit on the **Repl's** `main` that GitHub lacks is the
ordinary case — the Repl tracks `main`, so a tweak lands there unless David
branches first — and it is moved to a pushed branch through the connector, the
Repl's `main` realigned to GitHub's, and the branch opened as a PR, never
dropped unless David says to. The close-out sync's `git status
-sb` is where it shows up (David, 2026-10-03).

## What it replaced

From 2026-08-09 to 2026-10-03, David's own pushes to `main` from Replit's Git
pane landed by design, with no PR and no review, and a retrospective sweep of
`Replit Agent` commits — per session and in `/maintenance` — was the only read
they got. A session in that period escalated one such commit as a production
risk and predicted the ruleset would refuse his push; both were wrong,
because the ruleset then exempted the repo owner. That incident is why this
note existed. Its lesson about the owner's exemption no longer applies:
there is no exemption.

## What still holds

- **"Production" is never a git ref.** Production is reached only by an
  explicit `publish_app` from the Repl; a commit on GitHub `main` reaches
  nothing on its own, and the Repl syncs only when asked. Do not reason about
  production from what is on `main`.
- **Read the rulesets before predicting a push.** Whether a push will land is
  a fact about the ruleset's current configuration, readable from the
  repository's rulesets, never an inference from who is pushing.
- **The one place on GitHub direct commits still land** is a branch-regime
  `prototype/<feature>` branch, which opens no PR; its sweep is in the same
  home, `claude-core.md`, *This environment's git constraints*.
