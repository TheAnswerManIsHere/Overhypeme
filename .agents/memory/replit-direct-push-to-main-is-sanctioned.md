---
name: a Replit Agent commit on main is sanctioned policy, not an incident — read replit-environment.md before reacting to one
description: Why a session escalated a routine David-originated Replit commit as a production and history risk, when both the direct-push path and its retrospective sweep had been settled policy in the repo for weeks.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Escalating a Replit commit that policy already covered

## What happened

David asked (2026-08-28) whether using Replit Agent for small UI tweaks during
UAT was a reasonable shortcut. He had just had it add `Review #{r.id}` to the
admin Moderation list — one line, display-only. The session checked the Repl's
git state, found the commit sitting on the Repl's local `main` ahead of
`origin/main`, and raised it to him as a 🛑 blocking ask built on two claims:

1. That the change risked reaching **production**, and
2. That **GitHub's ruleset would refuse the push**, leaving the work stranded.

Both were wrong, and the repo already said so:

- `replit-environment.md` § *The push path has no external gate, and that's
  accepted* records that Replit pushes directly to `main` by design, with no
  PR and no Codex review, **settled by David on 2026-08-09**, with an explicit
  "do not propose gating this path."
- The same doc's § *The one thing that IS ours* already specified the
  retrospective sweep the session went on to "propose" — including the
  skim-UI/read-migrations split and the author-name filter — and
  `/maintenance` step 7 already implemented it.
- The ruleset does not restrict David: branch protections constrain the agent,
  not the repo owner. The push succeeded the moment he clicked Sync.
- Production is `neondb` on Neon, reached only by an explicit `publish_app`
  from the Repl. A commit on GitHub `main` reaches **nothing** on its own —
  GitHub → Repl has no auto-sync, and Publish snapshots the Repl's worktree.

The escalation cost David two round-trips and asked him to re-decide something
he had already settled.

## The generalizing rule

**Before escalating anything about Replit's behavior, read
`docs/ai-context/replit-environment.md`.** It is the cross-agent record of what
that path is *allowed* to do, and it exists precisely because Replit's access
looks alarming when measured against the agent's own constraints. A
`Replit Agent` commit on `main` is the documented normal case.

The generalizing shape, beyond Replit: **an agent's own guardrails are not the
user's guardrails.** The pipeline (branch → PR → Codex → merge) binds Claude
Code because Claude Code's unreviewed changes are the risk it was built to
contain. David owns the repo and the product; the same action from him is a
decision, not a bypass. Reading a constraint on oneself as a constraint on
everyone turns settled policy into a false alarm.

And on the specific mechanism: **"production" in this repo is never a git
ref.** Do not reason about production from what is on `main`.

## Why this is easy to miss

- The evidence looked genuinely alarming in isolation — a bot-authored commit,
  on `main`, ahead of origin, with no PR — and every one of those facts was
  true. The error was in what they *meant*, which lived in a doc, not in git.
- CLAUDE.md's Replit section reads as restrictive at a glance ("never build
  product features through the connector", "I don't launder my own unreviewed
  patch through Replit") and it is easy to over-apply. Its own escape clause is
  one clause later: **"A sanctioned live repair has to be David-originated."**
  David originating the change is the whole distinction.
- The 🛑 banner protocol makes escalation feel like the safe default. It isn't
  free: a blocking ask on settled policy spends David's attention and asks him
  to re-litigate his own decision. Checking the doc first costs one `Read`.

## Where the policy lives

The fast lane David settled in this same conversation now lives in
[`replit-environment.md`](../../docs/ai-context/replit-environment.md) §
*The fast lane* — display-only tweaks are his to make directly; the boundary is
display vs. behavior, not small vs. big. The sweep that covers them is in the
same file's retrospective-read section and `/maintenance` step 7.
