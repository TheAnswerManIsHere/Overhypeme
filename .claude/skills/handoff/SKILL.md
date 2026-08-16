---
name: handoff
description: Decide whether this session's context should move to a new session, and if so make it survive the move. Use when David says /handoff, "let's start a fresh session", "should we hand this off", or when a session that finished one thing is about to start something else. First judges whether a handoff is actually needed and stops if it isn't. When it is, externalizes the session's load-bearing context onto the workstream issue and delivers a copy-pasteable prompt for the new session. NOT for durable end-of-feature learnings (that's /document) and NOT the cross-tool docs/handoff/ folder.
---

# /handoff — moving a session's context to a new session

A session accumulates context that exists nowhere else: what we settled and
why, what we ruled out, what turned out to be a dead end. Ending that session
throws it away. **This skill decides whether that matters, and when it does,
moves the context into something a cold session can read.**

Two boundaries, because the names collide:

- **`/document`** harvests learnings that outlive the *task* into the durable
  docs. `/handoff` carries the state needed to continue the *work*. A handoff
  that finds durable learnings notes that `/document` is owed — it never does
  that job itself.
- **[`docs/handoff/`](../../../docs/handoff/README.md)** is cross-*tool*
  transit (Replit can't post to GitHub threads) with a delete-when-addressed
  obligation. A Claude→Claude session handoff is not that and does not write
  there.

**This always runs in the main loop, never a subagent.** The session's own
context *is* the subject matter, and a subagent has none of it — the same
reason a `/document` harvest isn't routable.

## Step 1 — Is a handoff actually required?

Run this first, every time, before writing anything. The common case David
described is real — we finished something and are turning to something else —
but it is not automatic.

**Stay in this session if any of these is true.** First match wins:

1. **Mid-flight in a stateful ceremony** — a plan-review loop between rounds,
   a PR watch before close-out, an outstanding `@codex review`. CLAUDE.md
   already forbids routing a review loop to a cold *subagent* because round
   number, declines, tripwires and the cumulative-diff rule are running
   state; a cold *session* is the identical argument. Finish the loop.
2. **Live state no artifact can carry** — an in-flight debugging hypothesis
   chain, a background task still running, working-tree changes that are
   still being edited rather than finished.
3. **The load-bearing context fits in a few lines** — then restating it in
   the next turn is cheaper than the whole ceremony, and the ceremony is the
   more expensive mistake.

**Hand off when** the next work belongs to a **different workstream** than
the context this session holds, and none of the three above applies. That
divergence is the whole signal: context for workstream A is dead weight and
active noise while working on workstream B.

**A second, independent trigger: session cost.** A session David returns to
later re-reads its entire transcript uncached on each return — the reason the
area-work rule in CLAUDE.md exists at all. Once a transcript has grown large
and the work will span a return, handing off is cheaper than carrying it,
**even for the same workstream**. The three stay conditions still win on
conflict: finish the round, *then* hand off.

**The destination has to be named.** Sections 6 and 7 of the prompt — first
action and out of scope — cannot be written without knowing what the new
session is for. If David hasn't said, ask one numbered question before Step 2.

**Report the verdict in one line either way.** If the verdict is *stay*,
**stop there** — name in one line what I'd have carried, so David can
override, and do not build the artifact anyway. If the verdict is *hand off*,
proceed without asking; he asked for the judgement call, not a checkpoint.

## Step 2 — Readiness gate

A handoff can be *needed* and not yet *possible*. All of these must hold
before Step 4 writes anything:

- **Everything worth keeping is committed and pushed.** A new session gets a
  fresh container and a fresh clone — unpushed work does not cross, silently.
  **The default is push**, as a WIP commit if it isn't PR-ready. The one
  alternative is work this session is *deliberately abandoning*, and it is
  spent only by **enumerating** it — each file and why it isn't worth
  keeping, written into the handoff comment. "Some scratch edits will be
  lost" is not an enumeration and does not clear this gate; if the list
  can't be written, push instead.
- **Session-bound obligations are enumerated.** PR subscriptions
  (`subscribe_pr_activity` binds to *this* session) and any armed
  self-check-in or trigger do **not** transfer. Each one becomes either an
  instruction in the prompt or something this session disarms in Step 6.
  Handing off a watched PR without this is how a PR goes quiet with nobody
  watching — the PR #458 shape.
- **Any outstanding review round is named.** If `@codex review` is posted and
  unlanded, the findings will arrive in a session that never asked for them.
  Step 1 usually says *stay* for this reason; if we hand off regardless, the
  prompt must say so explicitly.

## Step 3 — Disclosure check

This repo is public and an issue body is public. Run the
[canonical disclosure check](../../../docs/ai-context/workstream-tracking.md#what-must-never-happen)
before writing to an issue. A handoff that fails it stays on the private path
— deliver the prompt in chat only and say plainly that nothing was persisted.

## Step 4 — Persist to the workstream issue

The [State of Play block](../../../docs/ai-context/workstream-tracking.md#the-state-of-play-block)
already exists to make a workstream "resumable cold, in a fresh session with
zero prior context." That is this skill's channel; don't invent a second one.

**If a workstream issue exists:** refresh the whole State of Play block
(replace that section only, preserve the rest of the body), **then** add a
handoff comment. The comment never substitutes for the block — a
free-standing comment leaves the block's resumable-state claim stale, which
is the drift `workstream-tracking.md` warns about and a mistake an earlier
handoff actually made (PR #424). `/status`, `/status-all` and any cold
reader all check the block, not the comment stream.

**If none exists** — the Discovery gap `/status-all` names — open one. First
apply the [backlog promotion rule](../../../docs/ai-context/workstream-tracking.md#the-backlog-work-thats-queued-but-hasnt-started):
search for an open `queue:` issue already describing this work and promote it
rather than opening a duplicate. Otherwise create the issue at whatever stage
the work is genuinely at (usually `stage:discovery`), `waiting:claude`, and
the right `mode:`.

**A handoff is not a lifecycle transition.** `stage:` does not change, and
`waiting:` does not change either — the holder is `claude` before and after.
Only the narrative moves.

The handoff comment is a fixed shape:

```
## Handoff — <YYYY-MM-DD>

**Handing off because** — one line.
**What just finished** — what this session completed, and where it landed.
**Settled this session — do not re-open** — each decision plus its one-line why.
**Ruled out** — each rejected alternative plus why it was rejected.
**Live state that does not cross** — unpushed work, PR subscriptions dropped,
  wakes disarmed, background tasks.
**Still open** — undecided threads, each stated as the actual question.
**Durable learnings** — where they went, or "/document owed on #N".
```

*Settled* and *Ruled out* are the two that earn their keep: without them a
cold session re-derives a closed decision and presents it as a fresh idea.

## Step 5 — Deliver the prompt

One fenced code block in chat, one per destination session. Multiple
destinations get multiple blocks — never a merged prompt, which guarantees
the new session loads context for work it isn't doing.

**Write it for a reader with zero context and no access to this
conversation.** Three authoring rules that follow from that:

- **No pointer into this transcript** — no "as we discussed", no pronoun
  whose referent is a message the new session cannot see. Absolute dates,
  issue and PR numbers only.
- **Settled decisions go inline, not behind a link.** A session that must
  click through to learn what's closed will start reasoning before it clicks.
  This is the payload; everything else can be a pointer.
- **Never assert live state — point at how to check it.** The same rule
  `docs/handoff/README.md` already established: a snapshot goes stale between
  writing the prompt and pasting it.

The block carries these seven, in order:

1. **Frame** — what this work is and where it sits in the lifecycle, in a
   sentence or two.
2. **Read first** — `issue #N`, its State of Play and the handoff comment
   dated `<date>`.
3. **Setup** — the branch and how to get on it, which PR to re-subscribe to,
   what to verify live rather than trust.
4. **Mode and tier** — feature or bugfix, the ceremony tier, and which skill
   to invoke on entry (`/status` is the safe default first move).
5. **Settled — do not re-open** — the inline list from the handoff comment.
6. **First action** — one concrete instruction, not a menu.
7. **Out of scope** — what this session is explicitly not doing, so it
   doesn't wander back into the workstream we just left.

Length is whatever those seven honestly need. A prompt that omits a settled
decision to stay short has failed at the only thing it does.

## Step 6 — Close this session's obligations

Before handing back: `unsubscribe_pr_activity` for anything this session was
watching that the new session now owns, disarm any scheduled wake, and state
in one line what this session is still on the hook for — normally nothing.
An abandoned subscription is worse than none, because it looks like coverage.

Then report: the issue written, the prompt, and the one-line verdict from
Step 1. This hands the turn back to David, so it carries a push notification
per CLAUDE.md's notification rule.

## Model tier

Runs wherever the session already is — it cannot move, since it needs this
session's context. The triage in Step 1 is the only real judgement; the rest
is mechanical.
