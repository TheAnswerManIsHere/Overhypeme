---
name: add_repo with push access can be refused by the auto-mode classifier — stop and ask David, never work around it
description: A cloud session in auto mode whose settings carry no allow rule for add_repo had its add_repo calls (push access) refused by the permission classifier, reason "Access Added As A Means". It was not a GitHub access failure. The calls succeeded after David answered and the session left auto mode. Measured once, on /sync-fleet Step 2; the same tool is called by a handoff's first step and by the paid-AI ledger write.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# `add_repo` can be refused in auto mode, and the session stops and asks

## What was measured (KITT, 2026-11-04)

`/sync-fleet` Step 2 attaches each consumer with `add_repo`,
`access: "push"`. In a session running in auto mode, whose
`.claude/settings.json` had no allow rule for `add_repo`, both calls
(Overhype.me and DojoOS) came back:

> Permission for this action was denied by the Claude Code auto mode
> classifier. Reason: [Access Added As A Means].

Nothing was wrong with GitHub access: `list_repos` listed both
repositories with `"can_push": true` in the same turn. David answered the
🛑 with *"1. Try again now."*, **and the session left auto mode**; the same
two calls then returned `"status":"appended"`. After that the session
cloned both repositories, pushed a branch to each, opened, merged and
synced a pull request in each, with no second `add_repo` — all of it with
the session out of auto mode.

## Where it applies

Every payload caller of `add_repo` with push access, in a session whose
settings carry no allow rule for it:

- `/sync-fleet` Step 2 (the measured case).
- A handoff prompt's first action, when the work is in another repository
  (the `handoff` skill, step 3). There a refusal is easy to misread as
  "the handoff pointed at something that does not exist"; it is not.
- The paid-AI ledger write, when a session's access does not reach KITT
  (`uat-doc-format.md`, *Lanes*).

**KITT's own settings carry the allow rule** since KITT PR #291 (both
spellings of `add_repo`, beside the other session tools). Whether an allow
rule pre-empts the auto-mode classifier is `unable to verify: the next
auto-mode /sync-fleet run in a KITT session started after that PR merged`.
A consumer's settings carry no such rule (the template was not changed),
so a consumer session is still in the measured condition.

## What to do

- **Expect it, and stop.** A refused attach in auto mode is the permission
  layer, not a broken sync, a broken handoff or a missing repository. Do
  not re-try it in a loop.
- **Never work around it.** Do not route the work through another session
  that already has the repository attached, and do not reach the
  repository by any other path. Getting another session to do what this
  one was refused is the same denial, laundered.
- **Ask once, as a 🛑**, naming the refused call, its quoted reason, and
  the options: switch the session out of auto mode and retry (what cleared
  it when measured); let the work wait (for `/sync-fleet`, the next sync
  carries the delta); or do it from a session that already holds the
  repository, at David's choice. Then wait for his answer.
- **If the retry is refused again after his answer**, the ask stands and
  its remaining options are the second and third. Say so on the same 🛑;
  do not try a fourth route.

## What one observation cannot settle

`unable to verify` for each, with what would settle it:

- whether David's approval alone, with the session still in auto mode,
  clears the refusal — the measured success came after the session left
  auto mode, so the two are not separated; a session that stays in auto
  mode and retries after his answer settles it;
- whether the refusal recurs every time, or only for `access: "push"` — a
  second auto-mode run, and one with `access: "read"`;
- whether a session back in auto mode is gated again on a second attach —
  never exercised.
