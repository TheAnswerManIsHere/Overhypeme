---
name: model-routing
description: Use when deciding or explaining a model/effort escalation beyond the tier table in CLAUDE.md, or when David asks whether a switch can be automated.
---

# Model and effort routing — the reference detail

Migrated out of `CLAUDE.md` so it loads when a routing question is actually
live. The task-shape tier table stays resident in `CLAUDE.md`, because it has
to fire at task boundaries without being invoked.

### The session model is a constant, not a dial (David, 2026-08-15)

David asked (2026-07-24) whether the Opus→Fable switch could be automated, and
(2026-08-15) whether we could stop switching models altogether — the switch-ask
was "a real blocker." Both answers come from the same verified facts:

- **Nothing can change the session model except David.** Hooks can *read* the
  active model (`SessionStart` receives a `model` field) but there is **no hook
  output, skill field, or setting that writes it**, and there is no
  `$CLAUDE_MODEL` variable.
- **So we stopped depending on him moving it.** `.claude/settings.json` pins
  **`opus`**, and the session stays there for everything: pre-plan
  conversation, planning, the plan-review loop, building, PR-watching, ops.
  **I no longer ask for a switch in any direction.** The `opusplan` default is
  retired along with its "mind the gap" caveat — that gap existed because plan
  mode was what put the session on Opus, and now nothing needs to.
- **The `model` key is read once at session start.** A change to it lands on
  the *next* session; the current one is unaffected. Worth saying out loud
  when the setting changes, so a "nothing happened" reaction doesn't read as
  a broken edit.
- **Every tier that isn't Opus is reached by subagent routing** — Fable and
  Opus upward (below), Sonnet downward (next section) — plus the advisor tool.

### Routing work *down* to Sonnet — stateless and bounded only

The 2026-08-15 change removed the downshift ask; it did **not** remove the
cost concern behind it. The replacement is subagent routing, and the boundary
is **state**, not difficulty:

- **Routable**: a documentation drafting or `/document` harvest pass, a
  codebase "how does X work" investigation, a mechanical multi-file edit from
  an already-approved plan, a bounded research sweep or reproduction. Each has
  a clean handoff and a self-contained report.
- **Not routable**: a review loop or any long-running stateful loop; anything
  whose judgment is mine under the 2026-08-15 adjudication rules; verification
  of my own work (barred by `CLAUDE.md`'s delegation caps).
- **Why PR-watching specifically was considered and rejected.** It looks like
  the ideal candidate — high volume, mostly mechanical — but it carries
  per-round state (round number, cumulative-diff rule, declines and their
  reasoning, resolved threads, finding-count and plan-growth tripwires) that a
  subagent would re-establish on every webhook event, while my main loop stays
  engaged anyway because the adjudication is mine. Plausibly *more* expensive
  than simply watching on Opus, not less. Recorded here so it isn't re-proposed
  as an obvious optimization.
- **Announce every dispatch, in both directions.** The announce-don't-sneak
  rule was written for expensive escalations; it applies just as much to a
  Sonnet dispatch, because "which tier did that work actually run on" is
  something David can't see and shouldn't have to ask.

### Effort is the second dial — but it cannot be persisted (verified 2026-08-15)

The tier table in `CLAUDE.md` is entirely about *which model*. `effort` is a separate
control for *how hard it thinks*, and it applies on Opus 5, Sonnet 5, and Fable
5 alike: `low`, `medium`, `high`, `xhigh`, `max`, defaulting to `high`. David
sets it with `/effort`; I can set it per-subagent via `effort` frontmatter, and
subagents otherwise inherit the session level.

**It is not a substitute for the retired tier gate, and this was checked rather
than assumed.** When the 2026-08-15 change was proposed, dialing effort down on
Opus looked like a cleaner cost lever than routing to Sonnet — same model, same
context, no state loss. Claude Code's settings reference says otherwise:
**there is no persistable `effort` / `reasoningEffort` key.** The nearest thing,
`alwaysThinkingEnabled`, is a boolean for *whether* extended thinking runs, not
a level. So a session-wide effort choice would still require David to type
`/effort` — swapping one blocking ask for another. Per-subagent effort remains
genuinely useful and stays in play.

This matters for quota because **Opus 5 at `low`/`medium` is unusually strong** —
Anthropic's own guidance is to start at `xhigh` for coding/agentic work and then
*sweep downward*, because effort defaults carried over from an older model are
usually wrong. So "Opus is too expensive for this" is no longer automatically
true; **Opus at `medium` is a real option that we have never tried**, and it may
beat Sonnet at `high` for less than we'd assume. **Where that now applies is the
`effort` I set on a subagent** — a routed documentation pass or research sweep
does not need `high`. It is *not* a prompt for David to type `/effort`: since
2026-08-15 I don't ask him to change session-level dials at all, which is the
whole point of the section above. (`max` applies to the current session only.
`/effort ultracode` is
not a model level — it sends `xhigh` *and* turns on workflow orchestration; it
burns tokens fast and should be a deliberate ask, never something I assume.)

### Reaching Fable 5 without a session switch

Fable 5 is enabled on David's account (confirmed 2026-07-24). It costs
**$10/$50 per million tokens against Opus 5's $5/$25**, so it is always a
deliberate escalation.

- **Subagent routing is the mechanism I control.** Subagent `model` frontmatter
  and the per-invocation `model` parameter both accept the `fable` alias (or a
  full ID). So I can hand one genuinely hard piece of work — a migration design,
  a root-cause hunt in the visual pipeline, an architecture call — to Fable while
  the session stays where it is, with **no action from David**. Resolution order
  is `CLAUDE_CODE_SUBAGENT_MODEL` → per-invocation parameter → frontmatter →
  the main conversation's model.
- **I announce it, I don't sneak it.** Because a Fable subagent spends at double
  rate without David touching anything, I say when I'm dispatching one and why,
  in the same breath as dispatching it. Silent escalation is the failure mode to
  avoid here.
- **Don't make Fable the session default.** The `best` alias resolves to Fable
  wherever it's available, which would put *every* ops-shaped turn on the most
  expensive model. `/model fable` for a deliberate Fable session is fine; `best`
  as a persisted default is not.
- **Fable falls back on its own when flagged.** Its safety classifiers are
  tuned for cyber/bio content and occasionally trip on benign security work; a
  flagged request automatically falls back to Opus rather than hard-failing.
  Worth knowing before the `/security-review` ritual, so a fallback notice
  doesn't read as a bug.

### The advisor tool: escalation Claude triggers, mid-task

The advisor is the closest thing to what David actually asked for — a stronger
model consulted *at decision points* (before committing to an approach, when an
error keeps recurring, before declaring something done) with **Claude deciding
when to call it**, not the user. It's set once via `/advisor <model>`, the
`advisorModel` setting, or `--advisor`, and toggling it does **not** invalidate
the prompt cache.

Two facts that decide how we use it today:

- **Fable is not currently available as an advisor.** Claude Code shows it as a
  dimmed `Fable 5 (temporarily unavailable)` row and rejects `/advisor fable`,
  pending a remote rollout. So the pairing David would most want —
  Sonnet or Opus main with a Fable advisor — **cannot be configured yet.** This
  is worth re-checking periodically; it is the single change that would most
  automate our escalation policy.
- **What works now is `Sonnet main + Opus advisor`**, which automates the
  *Debugging new features* row of CLAUDE.md's tier table: Sonnet handles routine work
  and escalates the hard moments without a model switch. It costs
  advisor-model tokens on top of the main model, and it is experimental.
  **David approved trialing it for review loops on 2026-08-07; that trial is
  superseded by the structural triggers below as of 2026-08-08 — do not
  suggest `/advisor opus` for a review loop.** The advisor stays live for
  the *Debugging new features* row above, which this supersession doesn't
  touch.

### Review-loop triage: the structural Opus subagent triggers (David, 2026-08-08, superseding the 2026-08-07 discretionary trigger)

The 2026-08-07 revision sanctioned a one-shot **Opus subagent** for triage
calls the driving agent judged ambiguous. The weak link was the judging:
the cheap tier had to notice its own depth was insufficient, which is
exactly the assessment a cheap tier is worst at. With the class-and-sweep
protocol in place (`working-modes.md`'s *"A finding names an instance; the
fix owes the class"*), the discretionary trigger is **superseded by three
structural ones** — each a fact about the situation, not a self-assessment:

1. **Any decline.** Before a decline posts, the Opus subagent gets the
   finding plus my refutation and argues the finding's side; the decline
   posts only if it survives. Rationale: a wrong fix or a wrong escalation
   self-corrects downstream (Codex re-reviews, David tests the product); a
   wrong decline resolves the thread and nothing catches it.
2. **Any finding with no mechanical oracle.** If the sweep protocol's
   "write a grep/ls one-liner for the class" step comes up empty, the
   finding is pure judgment by construction, and its triage verdict comes
   from the Opus subagent.
3. **Any recurrence of a swept class.** A later round re-finding a class
   that was already swept means the class was misnamed at the cheaper
   tier — the re-naming goes to the Opus subagent, and the recurrence is
   flagged in that round's record.

Unchanged from 2026-08-07: one-shot, no session switch, no action from
David, and the announce-don't-sneak rule — a subagent spending above the
session's rate gets said out loud in the same breath as dispatching it.
This is a sanctioned judgment escalation, not a verify-my-own-work
subagent (which stays barred by CLAUDE.md's delegation caps). On loops
already running at Opus (sensitive-path PRs, all plan reviews), triggers
1–2 are moot; trigger 3's round-record flag still applies.

**The `/advisor opus` review-loop trial is deprioritized by the same
change (2026-08-08):** the structural triggers cover its review-loop use
case with tighter scoping and zero cost on routine rounds, where the
advisor charges Opus tokens across the whole session. The advisor remains
the sanctioned automation for the tier table's *Debugging new features*
thrash-escalation row; it just isn't the review-loop mechanism anymore.

### Stopping-rule decisions: the adversarial Fable subagent (David, 2026-08-13)

A fourth structural trigger, above the three, and the only one that reaches
for **Fable rather than Opus** — because the failure it exists to catch has
now beaten Opus twice in one session, and both times Fable reversed it.

**Fires on the loop's judgment moments, never on its execution.** These are
facts about the situation, not self-assessments:

- a **growth tripwire** firing
- a **rising finding count**, or an **oscillation signal** (a round dominated
  by failures of the previous round's fixes)
- any **split / cap-and-implement / stop** decision
- any recommendation where a **flip condition cannot be named**, or where the
  named flip condition is **already true** (`working-modes.md`'s post-round
  adjudication)

**What gets dispatched:** my drafted decision *and* my reasoning — including
every counter-argument in my own draft, verbatim — with the subagent
prompted adversarially: *try to reverse this*. Not "review it," which
invites agreement.

**As of 2026-08-15 this pass carries the decision weight the per-round
David check-in used to.** Under the autonomy contract
(`working-modes.md`'s *post-round adjudication*), what survives the
adversarial pass *executes* — there is no banner waiting on David for
continue/cap/stop calls. The surviving decision and what it overrode go
into the loop's trail (an 👀 FYI when noteworthy, always the loop-close
report); the reserved escalations — product/design forks, scope additions,
splits, disclosure — still go to David as 🛑 banners, with this subagent's
output attached.

**Why Fable, and why only here.** A planning loop is mostly execution-shaped —
verifying findings against source, writing thread replies, editing markdown —
and Opus does that well; Fable at 2× would buy nothing across it. But the
judgment moments are perhaps 2% of a loop's tokens and carry all of its
consequence, and the failure mode there is *specifically* the one Fable
corrects: applying a rule correctly to a situation that was never read. On
PR #422 the Opus-drafted recommendation to split contained its own refutation
as an appended caveat; Fable, given the same facts, reversed it. Same session,
one round earlier: eight findings recommended for fixing, seven of them
toolchain-catchable, and the reversal again came on Fable.

**Subagent, not a session switch.** Only David can change the session model,
and making him do it at every check-in puts the burden on the person this
process exists to protect. One-shot dispatch, no action from him. The
announce-don't-sneak rule applies with force here — Fable spends at double
Opus, so dispatching it is said out loud in the same breath.

**This is a sanctioned judgment escalation, not verify-my-own-work** — the
same carve-out the three Opus triggers hold against `CLAUDE.md`'s delegation
caps, and for the same reason: its value is a perspective my main loop
provably cannot produce, which two reversals in one session establish rather
than assume.

**Dispatch it after triage but before implementing any fix, and in every
case before pushing (David, 2026-08-15, PR #453) — never after the round's
fixes are already committed and reviewed.** This is the ordering
`working-modes.md`'s post-round adjudication and `plan-review-loop` already
require, for the reason the ordering exists: a stop or cap verdict is
supposed to prevent unnecessary fix work, which a "fix first, adjudicate
after" sequence defeats before the adjudicator ever runs. Adjudicating
after the round is already pushed and reviewed compounds the same mistake
in the other direction: any gap the adjudicator finds then costs a whole
extra commit and CI round-trip, instead of folding into the round's own
commit. On PR #453 this cost one avoidable CI cycle — the adjudicator ran after round 3 had
already been pushed and reviewed, found one small real gap, and the fix
landed as a fourth commit instead of inside the third.

