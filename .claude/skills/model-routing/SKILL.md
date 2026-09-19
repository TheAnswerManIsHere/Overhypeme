---
name: model-routing
description: Use when deciding or explaining a model/effort escalation beyond the tier table in CLAUDE.md, or when David asks whether a switch can be automated.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Model and effort routing — the reference detail

Migrated out of `CLAUDE.md` so it loads when a routing question is actually
live. The task-shape tier table stays resident in `CLAUDE.md`, because it has
to fire at task boundaries without being invoked.

### Fable to explore, Opus to build (David, 2026-08-28)

**This supersedes the constant-tier rule recorded below.** David runs **Fable**
deliberately for exploring possibilities and discussing how and why we do
things; **when the work turns to building, the session moves to Opus**, and
naming that boundary is mine rather than his to remember. The ask is
**mandatory before product code** and deliberately not required for continued
discussion, planning, or a docs/process edit. Staying on Fable to build needs a
really compelling reason — David saying so is one; my own "this looks small" is
not.

The mechanical facts in the section below did **not** change, and they are why
the rule is phrased as an *ask*: nothing except David can move the session
model, so "switch to Opus" is not an action I can take. What changed is the
conclusion drawn from those facts. The 2026-08-15 reasoning was that since he
had to move it by hand, we should stop depending on him moving it at all — one
tier for a whole session. That no longer matches how he works: the thinking
half of a session and the building half want different tiers, and putting the
boundary on me to *name* is what makes it survive a long conversation, since
the transition to building is visible to me and invisible to a PM mid-thought.

Full rule, including the maintenance exemption: `CLAUDE.md`'s *Model, cost, and
routing*.

### Superseded — the session model is a constant, not a dial (David, 2026-08-15)

> Retained for its verified mechanics, which still hold. Its **conclusion** —
> "I no longer ask for a switch in any direction" — is superseded by the
> section above; read the switch-ask statements here as history.

David asked (2026-07-24) whether the Opus→Fable switch could be automated, and
(2026-08-15) whether we could stop switching models altogether — the switch-ask
was "a real blocker." Both answers come from the same verified facts:

- **Nothing can change the session model except David.** Hooks can *read* the
  active model (`SessionStart` receives a `model` field) but there is **no hook
  output, skill field, or setting that writes it**, and there is no
  `$CLAUDE_MODEL` variable.
- **So we stopped depending on him moving it.** `.claude/settings.json` pins
  **`opus`**, and the **web/builder** session stays there for everything:
  pre-plan conversation, planning, the plan-review loop, building,
  PR-watching, ops. **Two environments are NOT covered and must be checked,
  never assumed:** an in-Repl session, which a gitignored
  `settings.local.json` pins to `sonnet` and which outranks the project file
  (see [`replit-environment.md`](../../../docs/ai-context/replit-environment.md)),
  and any session still running under the old `opusplan` value until it
  restarts. Before work this contract reserves to Opus, verify the tier
  actually in play — the rule and its consequences are in `CLAUDE.md`.
  **I no longer ask for a switch in any direction** — save one narrow
  exception: a session genuinely below Opus that reaches Opus-reserved
  *execution* (migration, Tier B fix, security review, dev-infra), where
  routing a judgement doesn't satisfy the reservation and I ask David to run
  it from an Opus session (see `CLAUDE.md`'s tier guard). The `opusplan` default is
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

- **Routable**: documentation **drafting from an already-complete handoff**, a
  codebase "how does X work" investigation, a mechanical multi-file edit from
  an already-approved plan, a bounded research sweep or reproduction. Each has
  a clean handoff and a self-contained report.
- **NOT routable — a `/document` harvest.** An earlier version of this line
  said "a documentation drafting or `/document` harvest pass," which was
  wrong and is the entry an agent would actually reach for when making this
  exact decision. The harvest's first source is the *build session's* own
  decisions and rejected alternatives, which a subagent does not inherit, so
  a cold worker drops precisely what the ceremony exists to capture. **The
  harvest is a standing dispatch BAR** — pre-registered here and in
  `CLAUDE.md`, not a call made at dispatch time — because its work is
  enumeration from memory, and no dispatch package can carry what has not
  been noticed yet.

  The run/don't-run **judgement** that used to dispatch here is **gone**
  (David, 2026-08-20): the harvest is batched at `/maintenance` and every
  close-out posts harvest notes, so there is no per-merge decision left to
  judge.
- **Not routable**: a review loop or any long-running stateful loop; anything
  whose judgment is mine under the standing dispatch bars; verification of my
  own work (barred by `CLAUDE.md`'s delegation caps).
- **Why PR-watching specifically was considered and rejected.** It looks like
  the ideal candidate — high volume, mostly mechanical — but it carries
  per-round state (round number, cumulative-diff rule, declines and their
  reasoning, resolved threads) that a subagent would re-establish on every
  webhook event, while my main loop stays engaged anyway. Plausibly *more*
  expensive than simply watching on Opus, not less. **What USED to be
  dispatched is the per-round judgement itself** — one `review-loop-adjudicator`
  reading a script-generated record rather than this session's context, which
  was the whole point: the value is a reader that did not produce the
  conclusions, not the presence of a worker. The #89 cut removed that agent and
  #96 rebuilds it; the reasoning is recorded here so the *watching* half isn't
  re-proposed as an obvious optimization meanwhile.
- **Announce every dispatch, in both directions.** The announce-don't-sneak
  rule was written for expensive escalations; it applies just as much to a
  Sonnet dispatch, because "which tier did that work actually run on" is
  something David can't see and shouldn't have to ask.

### Effort is the second dial, and it CAN be persisted (corrected 2026-08-15)

The tier table in `CLAUDE.md` is entirely about *which model*. `effort` is a separate
control for *how hard it thinks*, and it applies on Opus 5, Sonnet 5, and Fable
5 alike: `low`, `medium`, `high`, `xhigh`, `max`, defaulting to `high`. David
sets it with `/effort`; I can set it per-subagent via `effort` frontmatter, and
subagents otherwise inherit the session level.

**It IS a viable session-wide cost lever, and the story of getting this wrong
is worth keeping.** When the 2026-08-15 tier change was proposed, dialing
effort down on Opus looked like a cleaner lever than routing to Sonnet — same
model, same context, no state loss. I checked, concluded **no persistable
effort setting existed**, and wrote that into `CLAUDE.md`, `decisions.md` and
PR #458 as verified fact. It was wrong: I read the **settings docs page**,
which omits the key, and treated its silence as absence.

The **settings JSON schema** carries it:

```json
"effortLevel": { "enum": ["low", "medium", "high", "xhigh"] }
```

— *"Persisted effort level for supported models."*

Two durable lessons:

1. **For any settings question, read the schema, not the docs page.** The docs
   page is a curated subset and can omit keys entirely. A docs-page absence is
   not evidence of non-existence; a schema absence is much closer to it. The
   failure mode is specifically one-directional — the docs page will never
   invent a key, but it will silently hide one, which is exactly what makes
   "I checked and it doesn't exist" the dangerous conclusion to draw from it.
2. **`model: opus` + `effortLevel` is a real, ask-free cost dial.** It needs no
   `/effort` typing from David and no model switch, which makes it the *first*
   thing to reach for when Opus-everywhere gets expensive — ahead of
   re-litigating the tier gate. `max` is session-only (absent from the enum);
   per-subagent `effort` is unaffected and stays in play.

This matters for quota because **Opus 5 at `low`/`medium` is unusually strong** —
Anthropic's own guidance is to start at `xhigh` for coding/agentic work and then
*sweep downward*, because effort defaults carried over from an older model are
usually wrong. So "Opus is too expensive for this" is no longer automatically
true; **Opus at `medium` is a real option that we have never tried**, and it may
beat Sonnet at `high` for less than we'd assume. **Where that now applies is the
`effort` I set on a subagent** — a routed documentation pass or research sweep
does not need `high`. It is *not* a prompt for David to type `/effort`: the
**one** session-level dial I ask him to move is the model, at the build
boundary (*Fable to explore, Opus to build*, above), and `effortLevel` is not
it. (`max` applies to the current session only.
`/effort ultracode` is
not a model level — it sends `xhigh` *and* turns on workflow orchestration; it
burns tokens fast and should be a deliberate ask, never something I assume.)

### Reaching Fable 5 without a session switch

Fable 5 is enabled on David's account (confirmed 2026-07-24). It costs
**$10/$50 per million tokens against Opus 5's $5/$25**, so it is always a
deliberate escalation.

- **Subagent routing is the mechanism I control.** So I can hand one genuinely
  hard piece of work — a migration design, a root-cause hunt in the visual
  pipeline, an architecture call — to Fable while the session stays where it is,
  with **no action from David**.
  **The two layers take different values, and this bullet used to say they take
  the same ones** (AI-Handbook #131 round 2, where the Fable assessor found the
  sentence contradicting the measured table below it, in the same file):
  the **per-invocation `model` parameter takes an alias only** — the Agent
  tool declares it as an enum of `sonnet`, `opus`, `haiku`, `fable`, and
  David's 2026-09-18 probe of `best` was refused at input validation with
  exactly that value list — while a **definition's `model:` frontmatter also
  takes a full id**, which is what makes a stale id fail closed with a 404.
  Resolution order is **per-invocation parameter → frontmatter →
  `CLAUDE_CODE_SUBAGENT_MODEL` → the main conversation's model**; this bullet
  had the first three in the wrong order, which mattered because it put the
  environment variable above the argument every dispatch actually passes.
  **Two live instructions that contradict each other means either can fire**,
  so an obsolete one is a defect rather than archaeology.
- **I announce it, I don't sneak it.** Because a Fable subagent spends at double
  rate without David touching anything, I say when I'm dispatching one and why,
  in the same breath as dispatching it. Silent escalation is the failure mode to
  avoid here.
- **Don't make Fable the session default, and don't propose a Fable session
  at all (updated 2026-08-15).** The `best` alias resolves to Fable wherever
  it's available, which would put *every* ops-shaped turn on the most
  expensive model, so it is not a valid persisted default. This bullet used
  to add that "`/model fable` for a deliberate Fable session is fine" — and as
  of **2026-08-28 that is true again from David's side**: he runs Fable
  sessions deliberately for exploration and design conversation, which is the
  intended use, not a misconfiguration to flag. Two things still hold. **I**
  don't propose moving a session *to* Fable — the only switch I ask for is
  **to Opus at the build boundary** (*Fable to explore, Opus to build*, above).
  And the `best` alias is still not a valid persisted default, for the reason
  given: it would put every ops-shaped turn on the most expensive model.
  Reaching Fable for one hard piece of work *without* touching the session is
  still the subagent route described here.
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
- **`Sonnet main + Opus advisor` is retired — the configuration no longer
  exists (2026-08-15).** It used to be the live automation for the tier
  table's *Debugging new features* row: Sonnet handling routine work and
  escalating hard moments without a switch. That row now keeps diagnosis in
  the Opus main loop, and the session is never on Sonnet in the first
  place, so recommending `/advisor opus` would be both redundant (Opus
  advising Opus) and a user-operated configuration ask of exactly the kind
  this change removed. **Do not suggest it** — for review loops (already
  superseded 2026-08-08 by the structural triggers below) or for debugging.
  The advisor as a *mechanism* stays interesting if Fable ever becomes
  available as one; see the bullet above.

### Every dispatched judgement runs on the strongest available model (David, 2026-08-17; mechanism updated 2026-09-06)

**Every judgement subagent dispatches at the strongest tier available — no
exceptions, no tier judgement at the dispatch site.** David's instruction:
*for judgements, I want the strongest possible model.* This supersedes the
Opus/Fable split that used to run through the two sections below, where
triggers 1–3 went to Opus and the stopping-rule trigger went to Fable.

**The tier is named in one place: `.agents/machinery.json`'s `models` block** —
`strongestClaude` and `strongestCodex`, each mapping to a full model id and an
effort. So the instruction survives a change of which model is strongest as a
one-value edit. A tier must resolve to a FULL model id, never an alias — a
dispatch stamps the id it asked for against the id that answered, and an alias
cannot be compared.

**A Claude subagent is bound in two places, and it needs both** (#126,
2026-09-18): the role's own definition declares `model:` and `effort:`, and the
dispatch still resolves the tier and passes `model:` on the call.

The resolution order, measured rather than quoted — sixteen real dispatches,
each row read from the harness's own per-turn record of the subagent and not
from what the subagent said about itself:

| Given | What answered |
|---|---|
| nothing | the session's model |
| argument `fable` | `claude-fable-5-1` |
| frontmatter `model: opus` | `claude-opus-5` |
| frontmatter `model: opus`, argument `sonnet` | `claude-sonnet-5` |
| frontmatter `model: claude-nonexistent-9` | hard failure, HTTP 404 |
| frontmatter `effort: max` | ran at `max`; `low` on the same question spent 151 output tokens against 3,862 |

So **the argument outranks the frontmatter, and the frontmatter outranks the
session** — which is what makes two places safe rather than duplicative. Each
covers the other's failure:

- **The frontmatter covers a forgotten argument.** That is not hypothetical:
  seven consecutive #124 rounds dispatched the translator without it and every
  one ran as the session. An instruction that has to be recalled is one this
  repository has now watched fail six times.
- **The argument covers a stale definition.** Definitions are cached, and an
  edit to a loaded one can be served in its old form (measured 2026-09-16), so
  a dispatch relying on frontmatter alone has a window where it silently
  inherits. It also carries a consumer's own pin, which a synced definition
  cannot.
- **Frontmatter is the ONLY route for effort.** The Agent tool takes no effort
  argument. Before #126 the pin's `xhigh` reached nothing and every #124
  translation ran at the session's `high`.

**The declarations are derived from the pin, never typed.**
`node scripts/check-agent-models.mjs` fails when a `fable-*` definition
disagrees with `models.strongestClaude`, and `--fix` rewrites it from there, so
David's one-line edit propagates. It runs in the handbook's CI and not in a
consumer's: a consumer receives the definitions carrying THIS repository's pin
and must not edit a synced file, so a check shipped to them would be
permanently red with no fix available. What reaches a consumer's own tier is
the dispatch argument.

This paragraph used to say the opposite — that the tier is named in the role's
own definition and "the dispatch passes no per-invocation `model`". Then it was
corrected to the mirror image: pass the argument, and **no agent definition in
this payload carries a `model:` field**. Both halves were right about the
mechanism and wrong about the conclusion, because each read "the argument
outranks the frontmatter" as a reason to have only one of them.

**A stale id fails closed.** A retired model in the frontmatter is a 404 and a
terminated agent, never a quiet substitution — which is the argument for the
full id over the alias `fable`, since an alias keeps working while the pin
rots.

**What is disclosed and what is observed, said exactly.** The dispatch states
what it asked for in the header of whatever it posts; the role states what it
is *running as*, on its own `_Running as:_` line — which on a review
assessment sits under the ship gate, not above it, since line 1 is the gate.
They sit adjacent and a disagreement is
a visible warning — David, 2026-09-18: *"any model call must report loudly if
the requested model doesn't match the used model. Not a blocker; a highly
visible warning."*

**Each fact carries the label of how it got there, and only Astra's says
"requested".** Astra is handed a full id and an effort per call, so the word is
literal there. A Claude subagent is handed the family **alias** and no effort
at all, so its header reads `expected <pin id> · instructed alias <alias> ·
definition effort <effort>`, with the declared model added where it disagrees
with the pin:

- **`expected`** — the pin, which is what the self-report is compared against.
  Comparing against the family would conceal version drift.
- **`instructed alias`** — the alias the recipe sends, derived from the pin.
  An instruction, never an observation: the script that prints the header does
  not make the call and receives no record of it, so it cannot know the
  argument was passed. Without this fact at all, a pin that has drifted from
  the alias reads as the platform substituting a model, which points the
  diagnosis at the one cause nobody can fix instead of at a one-line pin edit.
- **`definition …`** — what the role's file *declares*, as read when the comment
  is rendered. Never "applies": definitions are cached, so the file on disk may
  not be the one that answered.

*(This paragraph twice said something the code had stopped doing — first that
the model is "genuinely requested", which stopped being true when the alias was
named, and before that that the header "adds the pin's value where it
disagrees", which round 2 removed. Each time the sentence survived the change it
described. That is the defect this skill's own rule names: two live instructions
that contradict each other mean either can fire.)*

The reporting side has its own limit, measured on AI-Handbook #131 rounds 1–3:
the assessor answered `at unable to name` every time, because its context shows
reasoning effort as a number (`80`) rather than a named level. **An effort
nobody can name is a limit to state once, not a mismatch to raise every round.**

The used model is a self-report, deliberately. The harness does record the
serving model per turn independently of the subagent, so reading it is
possible; David ruled on 2026-09-19 that it is not worth building — small blast
radius, easily recoverable, no meaningful harm, and the self-report gives
essentially all of the tracking value. So **no line here claims a match it
measured**: what was asked for beside "running as Z", and never "ran on X".

Two limits that remain, stated rather than solved. A **content refusal** can
fall Claude back to Opus mid-task, and a self-report is the only thing that
would show it — it is the one recorded cause of an answer from a *different*
family, which is why `chatReport` names it there and names pin drift only when
the families match. (A spent weekly allowance is not the same shape: measured
2026-09-18, it returns HTTP 429 and terminates the agent rather than
substituting anything, so it is loud already and never reaches that line.) And on the Codex side there is no such report at all: the CLI
exposes the model only request-side, so Astra's header says what was asked for
and claims nothing about what served it.

**What made the old split wrong is not that Opus was too weak — it is that
the split asked the wrong question.** It sorted triggers by how consequential
they looked, which is a self-assessment of exactly the kind the structural
triggers exist to eliminate. A decline that resolves a thread nothing
downstream catches is not obviously cheaper than a stop decision, and
deciding which deserves the stronger model is one more judgement made by the
context that is already suspect. Routing every dispatched judgement to one
tier removes the question.

The cost note that justified the split still holds and now argues the other
way: judgement moments are perhaps 2% of a loop's tokens and carry all of its
consequence, so paying 2× on 2% is cheap for the thing the whole apparatus
exists to get right.

**Two properties, not one.** The triggers were always about an *independent
challenge from a context that did not produce the conclusion*, and that is
still the load-bearing property — a same-tier subagent supplies it. Fable now
adds the second: the strongest available reader. Neither substitutes for the
other, so a dispatch that reuses my own reasoning is not rescued by being on
Fable.

### The review-loop dispatch triggers are RETIRED (2026-08-20, PR #543)

Two sections lived here — the three structural adjudication triggers
(any decline, any oracle-less finding, any swept-class recurrence) and the
adversarial stopping-rule subagent. **Both were superseded by the single
per-round judge** in `CLAUDE.md`'s *Review loops*; that judge was removed by
the #89 cut, and #96 replaced it with **two independent assessments per round
that advise rather than bind**. Reinstating the old per-finding and
per-decline dispatches on top of them would re-create the parallel
self-refereeing the #541 review deleted (Codex, #543 round 3) — a round is
covered by the two assessments, not by more dispatches.

What survives from those sections, because it is about dispatch hygiene rather
than dispatch law: announce every dispatch out loud (the assessors' tier
spends well above Opus); a dispatch that reuses my own reasoning is not rescued
by the tier; and the assessments run after triage but before fixes are
implemented, so a decline can still prevent unnecessary fix work.
