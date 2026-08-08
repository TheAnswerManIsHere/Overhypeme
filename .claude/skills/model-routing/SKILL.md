---
name: model-routing
description: Use when deciding or explaining a model/effort escalation beyond the tier table in CLAUDE.md, or when David asks whether a switch can be automated.
---

# Model and effort routing — the reference detail

Migrated out of `CLAUDE.md` so it loads when a routing question is actually
live. The task-shape tier table stays resident in `CLAUDE.md`, because it has
to fire at task boundaries without being invoked.

### What can and cannot switch models (settled — don't relitigate)

David asked (2026-07-24) whether the Opus→Fable switch could be automated. I
verified this against the Claude Code docs rather than guessing, and the answer
is stable enough to record so neither of us re-derives it:

- **Nothing can change the session model except David.** Hooks can *read* the
  active model (`SessionStart` receives a `model` field) but there is **no hook
  output, skill field, or setting that writes it**, and there is no
  `$CLAUDE_MODEL` variable. So the "switch me to Opus / Sonnet" ask in this file
  stays a real ask, and I keep prompting for it.
- **`opusplan` is the one automatic session-model switch**, and it is
  mode-triggered, not task-triggered: Opus during plan mode, Sonnet for
  execution. It is our session default per `.claude/settings.json`. Its blind
  spots are the pre-plan conversation and the Codex plan-review loop — see the
  "mind the gap" note in `CLAUDE.md`'s *Token / cost discipline* section.
- **Everything else routes work to a stronger model without moving the
  session**: subagents pinned to a model, and the advisor tool. Both below.

### Effort is the second dial — and we had never used it

The tier table in `CLAUDE.md` is entirely about *which model*. `effort` is a separate
control for *how hard it thinks*, and it applies on Opus 5, Sonnet 5, and Fable
5 alike: `low`, `medium`, `high`, `xhigh`, `max`, defaulting to `high`. David
sets it with `/effort`; I can set it per-subagent via `effort` frontmatter, and
subagents otherwise inherit the session level.

This matters for quota because **Opus 5 at `low`/`medium` is unusually strong** —
Anthropic's own guidance is to start at `xhigh` for coding/agentic work and then
*sweep downward*, because effort defaults carried over from an older model are
usually wrong. So "Opus is too expensive for this" is no longer automatically
true; **Opus at `medium` is a real option that we have never tried**, and it may
beat Sonnet at `high` for less than we'd assume. When a task feels
between-tiers, I now say so and suggest an effort change rather than only a
model change. (`max` applies to the current session only. `/effort ultracode` is
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
  advisor-model tokens on top of the main model, and it is experimental —
  but **David approved trialing it for review loops (2026-08-07)**, as part
  of the post-round check-in revision (see `working-modes.md`'s *The
  post-round check-in*): when a Sonnet session is about to drive a review
  loop, suggesting he set `/advisor opus` for that session is the sanctioned
  move, replacing the manual switch-to-Opus-and-back-per-round idea, which
  would have cost David two model-picker trips every round.

### Post-round check-in triage: the Opus subagent escalation (David, 2026-08-07)

The same revision approved a second, agent-controlled escalation: when the
check-in's triage judgment is itself ambiguous — propagation vs. new ground,
impossible-as-specified vs. merely hard — I dispatch a **one-shot Opus
subagent** for that call, with no session switch and no action from David.
Same announce-don't-sneak rule as the Fable dispatch above: a subagent
spending above the session's rate gets said out loud in the same breath as
dispatching it. This is a sanctioned judgment escalation, not a
verify-my-own-work subagent (which stays barred by CLAUDE.md's delegation
caps).

