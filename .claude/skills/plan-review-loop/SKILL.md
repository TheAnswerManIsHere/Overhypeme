---
name: plan-review-loop
description: Use in feature-building mode once the pre-plan conversation has settled intent, or whenever a plan needs to be delivered to David for approval. Runs the planning loop in-session — Astra and I develop the plan together as peers, reading one contract, with the next action stated by me rather than derived from an assessment. No plan-review PR and no page; everything reaches David in chat, and the approved plan is committed on its feature branch. NOT for bugfix mode, which skips planning entirely.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# The in-session planning loop

Astra and I develop the plan together. The script spawns Codex CLI with the
`strongestCodex` tier in a read-only sandbox, hands it the same contract I read,
and takes back Markdown. **I hold the authoritative plan**, I argue where I
disagree, I investigate disputed facts myself, and **I state what happens next**.
Nothing parses an assessment. The plan is a file in my working tree, ignored by
git, while we develop it; at approval it is committed on the feature branch
(*Close-out*, item 4); everything David sees arrives in chat.

**The script's path differs by repository, so resolve it once per session**
rather than typing either form. The sync routes `core/X -> X`, so the file is
`core/scripts/plan-review.mjs` in KITT and `scripts/plan-review.mjs`
in every consumer:

```
P=core/scripts/plan-review.mjs; [ -f "$P" ] || P=scripts/plan-review.mjs
```

Every command below uses `$P`. Run it from the repository root.

**This is the planning loop only. The Codex GitHub review of CODE is untouched
and remains David's safety net** — every implementation PR in production phase
still gets it; a prototype-phase feature enters **this** loop for its first
version, and for a later one only when David asks in words, and gets no code
review at any version
([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-prototype-phase-per-feature-david-2026-09-26)).

## One contract, two roles

`docs/ai-context/planning-contract.md` is role-neutral and **read verbatim into
every package, by both of us**. It addresses "you" and "your counterpart" and
never says which of us holds the plan. The script's **role block** supplies
that, per role, and it is the only thing that differs between the two packages.

**Read my own copy before I start drafting**, and again whenever I have been
away from the loop. There are two forms; use the one for the stage.

**Before drafting**, once the oracle file exists — the scope-of-work gate below
writes it, and it runs before anything — and when no plan file exists yet:

```
node "$P" --kind scope --slug <slug> --oracle .agents/reviews/<slug>/oracle-<slug>.md --role claude --prompt-only
```

The oracle path is written out, not `$S`, which is assigned only in the
scope-exchange recipe below. **`$P` is the only variable any block here relies
on from another** — every other block assigns what it uses, and the recipe check
enforces it.

The assessment form needs `--plan`, so it is never the pre-draft command; the
scope form yields the same role block, contract, Worth rule and oracle with no
plan. **Returning to an existing plan**, once one is written:

```
node "$P" --kind assess --round <N> --tier <tier> --plan <file> --role claude --prompt-only
```

My copy is written to `<stem>.claude.prompt.md`, a separate file, so it never
overwrites the record of what Astra was sent.

The standards I hold the plan to and the standards Astra holds it to are the
same words, so a difference between our conclusions is one of judgement, not of
briefing. My posture differs and the role block says so: **I develop and hold
the plan; I am not a second reviewer of my own work.**

## The concern ledger

Continuity lives in `.agents/reviews/<slug>/concerns.json`, which I maintain and
the script renders. It is the one piece of state in the loop, and the honesty of
the record rests on me — nothing checks for a concern I never wrote down.

```json
[{ "id": "C1",
   "title": "Cache invalidation is unspecified",
   "raised": "assess-1",
   "source": ".agents/reviews/<slug>/round-1.md",
   "state": "open",
   "concern": "the reasoning as it was written, in full",
   "proposed": "what was proposed instead",
   "evidence": ["src/thing.ts:12"],
   "response": "what I did about it, or argued, in full",
   "david": null }]
```

**States**, and what each one means:

| State | Means |
|---|---|
| `open` | live; renders in full every exchange |
| `addressed` | the engineering concern is genuinely resolved |
| `superseded` | a revision made it moot; say why |
| `withdrawn` | whoever raised it no longer believes it, and said so |
| `settled-over-dissent` | I chose the approach after discussion while Astra maintained its recommendation. **Renders in full every exchange**, keeping both arguments prominent so new evidence has something to argue with, and **it is named in the approval ask**. Distinct from `addressed`, which means the concern was resolved rather than decided over an objection |
| `for-david` | a choice only he can make; renders in full, and blocks nothing else |
| `accepted-by-david` | he accepted the trade-off, in words |

Open, `for-david` and `settled-over-dissent` concerns render in full. The rest
render as one line naming their source, and any of them can be pulled back into
full view by naming it in a discussion — **settled is not closed**.

**Rules I keep, because no check enforces them:**

- **Every entry names its source**, so the original argument can be read rather
  than reconstructed from my summary of it. The script refuses an entry without
  one.
- **Never edit a concern's text to make it look answered.** The `response` field
  is where my answer goes; the `concern` field stays as it was written.
- **A withdrawal is written as a withdrawal**, never folded into `addressed`.
- **`accepted-by-david` is only ever written after he has said so in words.**

## The exchanges

### Before anything: the scope-of-work gate

This is what authorizes the loop to run autonomously: the direction served,
this increment's product intent, must-not-change, settled decisions, the
now/next/never calls already made and the ceremony tier, as a 🛑 NEED YOU
banner with its push notification. See
[`working-modes.md`](../../../docs/ai-context/working-modes.md#the-scope-of-work-gate-david-2026-08-15).
For a prototype's version the banner carries the short plan's four items —
the design question, the hypothesis, the surface, what it leaves out — in
place of product intent, must-not-change and settled decisions, since nothing
about a prototype is settled yet; the tier and the now/next/never calls stay.

That agreed scope **is the oracle**. Write it to a file under
`.agents/reviews/<slug>/` — the script refuses to run without one, and that
directory is the one it keeps ignored. A plan measured only against itself can
be perfectly coherent and still have dropped a requirement the intent called
for.

### The scope exchange — before the plan is written

Astra gets the oracle alone and answers one question: should this exist, and is
the boundary in the right place.

```
S=.agents/reviews/<slug>; mkdir -p "$S"   # write the oracle here, not at the root
node "$P" --kind scope --slug <slug> --oracle $S/oracle-<slug>.md
```

Short enough to run in the foreground — it reads a page, not a plan. Every later exchange is
detached.

David sees its answer **beside mine** before he says go: my own view first, in
my own words, then Astra's, then where we differ.

If it says the work should not exist, or not yet, **that is a product question
for David**, not a finding for me to absorb. Its concerns go on the ledger like
any other.

### Assessing the plan

Write the plan to `docs/plans/PLAN_<SLUG>.md` in the working tree, with the
oracle as a fenced `plan-oracle` block at its head — for a prototype's version,
the short plan `PLANS.md` describes, whose product is the questions file the
`prototype` skill names. Tell David it is drafted and
**keep going** — v1 changes anyway, and waiting buys nothing. He interjects
whenever he likes, and when what he gives is feedback on the plan, I state
my reading of it and revise, without waiting (*David's feedback on the plan*, below).

**Run it detached. An exchange outlives the tool call that starts it.**

```
S=.agents/reviews/<slug>
mkdir -p "$S"          # bash opens the redirects below BEFORE node runs
rm -f "$S/run-<N>.exit"   # a marker left by an earlier attempt reads as THIS
                          # one finishing, instantly, with the wrong status
setsid nohup bash -c 'cd "$1" && node "$1/$2" \
  --kind assess --round <N> --tier <product|sensitive|internal> \
  --plan docs/plans/PLAN_<SLUG>.md \
  > "$3/run-<N>.log" 2>&1; echo $? > "$3/run-<N>.exit"' _ "$PWD" "$P" "$S" &
```

Then wait on `run-<N>.exit` appearing — its existence is the completion signal
and its contents are the status.

**Nothing from the outer shell appears in the program text.** The program is in
single quotes with `$PWD`, `$P` and `$S` passed as arguments (`_` is `$0`, which
`bash -c` consumes). Anything interpolated into a `bash -c` string is re-parsed
by the inner shell, so a checkout path containing `$`, a backtick or a space
breaks or executes; passing values as arguments needs no escaping rule.
Quoting the interpolation is not a fix — it closes one character, not the
class. The failure's signature is an exit marker of `1` with no log.

**The marker is per round AND cleared before launch, and it needs both.**
Naming it per round stops one exchange's marker reading as another's
completion; deleting it stops a retry of the same exchange reading the previous
attempt's marker. Getting this wrong can make the agent relaunch, and two
`xhigh` processes then write the same attempt path and both promote it. An
exchange runs about ten minutes at `xhigh`, and a foreground run that gets cut
off loses the whole exchange. Absolute paths inside the `bash -c`; the working
directory does not survive into the detached child the way you expect. The rest
of the traps are in
[`codex-cli-in-container.md`](../../../.agents/memory/codex-cli-in-container.md).

**The oracle is pinned on the first exchange and checked on every one after.**
It is otherwise read from the plan file I rewrite each time, so a requirement
dropped from the plan *and* its oracle block in one rewrite would go unnoticed.
The pin is a mistake catch on a file I author, which is all the rule allows it
to be (`agents-core.md`, *Important product principles*): it is not a defence
against my changing the oracle on purpose. A deliberate change is still
possible, with `--oracle-changed "<why>"` — a requirement David changed, in
his words, or a verification method changed with the property it still
proves, which is mine to settle and record (`agent-working-rules.md`, *A reversible choice proceeds on the recommendation*) — and it is
stamped on the exchange so David reads it. Silence is what is refused.

### Discussing before revising

**A disagreement costs one question, not a round trip through the whole loop.**
No plan edit, no new round, no commit:

**Detached, like every exchange after scope** — it is the same `xhigh` process
with the same package, and a foreground run that gets cut off loses it:

```
S=.agents/reviews/<slug>; Q=$S/question-<N>-<M>.txt   # write the question to a
                                                     # file: it is long, and
                                                     # quoting it through the
                                                     # detached shell is where
                                                     # this goes wrong
rm -f "$S/discuss-<N>-<M>.exit"   # same reason as the assessment recipe above
setsid nohup bash -c 'cd "$1" && node "$1/$2" \
  --kind discuss --round <N> --discussion <M> --tier <tier> \
  --plan docs/plans/PLAN_<SLUG>.md --concerns C2,C5 \
  --question "$(cat "$4")" \
  > "$3/discuss-<N>-<M>.log" 2>&1; echo $? > "$3/discuss-<N>-<M>.exit"' _ "$PWD" "$P" "$S" "$Q" &
```

Keyed by round *and* discussion, because `<M>` restarts inside each round — the
script's own output is `round-<N>.discussion-<M>.md` — and cleared before launch,
because a retry reuses the path.

The named concerns render **in full whatever state they are in**, because a
focused question is often about something already settled. The question carries
the evidence, quoted with its origin per the load-bearing-claim rule. Everything
not asked about keeps its state — including questions waiting on David.

Use it when a revision would otherwise be built around an assumption I think is
wrong. Do not use it to relitigate something I simply dislike.

## Four things happen after every exchange, in this order

1. **Relay to David, in plain English, before the revision.** What Astra
   disagrees with, and one line per concern saying what I am doing with it. In
   product English — the outcome, never the mechanism. **This is the moment he
   can stop a revision he disagrees with, and he cannot use it if it arrives
   after the revision.** A clean exchange still gets its readout: that
   independent opinion is the thing he is otherwise reading blind without.

2. **Update the ledger — after every exchange, including one that raised
   nothing.** Every existing entry is carried forward with its reasoning intact,
   its state and my response updated where the exchange moved them, and anything
   new is added with its source. **The file exists after every exchange**,
   because continuity lives in it and the script refuses a later exchange when
   it is absent: an absent ledger reads as *forgotten*, which no check can
   distinguish from *nothing was raised*, so it is mine to answer by writing
   the file. `--no-ledger` is the escape the error names, for the case where
   earlier exchanges genuinely returned nothing and I have not written one.

   **When a discussion changes the OTHER party's position, the `response` says
   so and says why** — not just what I argued. A concern settled because Astra
   withdrew it on new evidence reads, from its state alone, exactly like one I
   talked it out of. The discussion file is named in the next assessment's
   package, so the reasoning is reachable; this keeps the ledger's own line
   honest about which way it went.

   **`[]` is only ever what the file contains while nothing has been raised in
   the loop so far** — never what an exchange writes over entries that exist.
   Overwriting a ledger with `[]` loses its reasoning silently: the script loads
   an empty array happily, and a genuinely empty ledger and an emptied one are
   the same bytes, so the instruction is the only layer that can say it.

3. **State the next action, explicitly.** Nothing in an assessment decides this.

   ````
   ```plan-action
   action: revise
   concerns: C1, C3
   note: C2 for-david, named in the approval readout; C4 withdrawn on the evidence
   ```
   ````

   The vocabulary is `investigate | scope | assess | discuss | revise |
   present-to-david`. **There is no `approve`** — approval is not something this
   loop can do.

4. **Do it.** A revision is class-level: a concern names an instance, the fix
   owes the class. Name the class in the `response` and sweep for siblings
   before revising — a plan-file concern almost always has them.

**There is no stop rule to compute and no round budget.** The loop ends when the
judgement is that nothing more is worth writing, and that judgement is mine,
stated in an action block. Nothing stops the loop for David before
the plan itself: a choice that changes intended behaviour or a user-facing consequence
no settled decision covers is written into the plan and named in the approval
readout, not asked mid-loop, and a consequence a settled decision reaches is
not asked at all (`agent-working-rules.md`, *A reversible choice proceeds on the recommendation*); a scope addition is taken as *next* and
reported, and only one the plan cannot be correct without asks; a split is
proposed in the plan he approves; and a disclosure
question is his (`workstream-tracking.md`, the canonical check). A purely
technical fork between two approaches to agreed behaviour is none of these.

**David's feedback on the plan gets my reading of it stated as its own
paragraph, and the revision with no wait for him to confirm it**
(`claude-core.md`, interaction rule 15). Feedback on a scope, on v1 or any
later version, or on the approval readout is answered by saying what I understood him to mean, in plain English, and
what I changed or will change because of it. The loop carries on, on that
reading, in the same turn: no question, no
question ID and no banner asks him to confirm it, and he corrects it if it is
wrong. The reading is its own statement at the top of the turn's last message,
after the last tool call (text written before the work reaches him
paraphrased), never folded into the revised plan. It is not the relay of
step 1, which reports Astra's concerns.

**An assessment that says it could not do the job is not a clean exchange.** If
Astra says it lacked the repository context, or could not reach something
material, that is mine to supply and re-run — never convergence.

## What never gets settled inside the loop

- **A choice that changes intended behaviour or a user-facing consequence no
  settled decision already covers.** Astra may critique the idea itself, and
  when it does, that goes into the plan as an **item in the approval
  readout, under its question ID (`claude-core.md`, interaction rule 4), carrying its view and mine side by side** — never absorbed into a
  revision, and never a separate mid-loop question; a consequence a settled
  decision reaches is settled with it, and the plan names the decision
  (`agent-working-rules.md`, *A reversible choice proceeds on the recommendation*). **A purely technical design fork is not one of
  these**: two approaches serving the same agreed behaviour are ours to settle
  (the tie-break below). A change to
  how an oracle requirement is verified, keeping the property it proves, is
  such a fork; a change to the requirement is his (same section).
- **Approval of the plan itself, and his own use of the software factory.**
  His, always — given on the readout, which is why the items above go there.
- **A scope addition.** Any revision that would introduce a new mechanism — a
  table, a role, a config domain, an endpoint — is taken as *next* and
  reported; it is a question for David only when the plan cannot be correct
  without it.

**A purely technical disagreement that survives investigation and discussion is
mine to settle**, with the reasoning recorded, and Astra is not obliged to
agree. Record it as `settled-over-dissent` and name it in the approval ask. That
state exists so the decision stays readable and can be revisited if new evidence
arrives.

## The reviewer's identity is pinned

The `strongestCodex` tier from `.agents/machinery.json`, read-only. `--model`,
`--effort` and `--sandbox` are **refused** unless `--unpinned "<why>"` is given,
and the reason is stamped on the exchange — so a loop run against a weaker peer
says so on its own record. `danger-full-access` is refused with or without it.
The pin protects the two things this design exists for: an independent peer,
and one that cannot edit what it is discussing.

## When Astra cannot run

**Sign-in is per session and never stored.** The script exits **2** when there
is none, with the device-code instructions and without running anything. The
session's first action already asked for one (`claude-core.md`, *Astra*: sign-in
is the first thing every session does); a loop that still finds
none — a restarted container, an unanswered code — gets one before the loop
starts, not mid-exchange:

1. `npm install @openai/codex` in a scratch directory; set `CODEX_BIN`.
2. `$CODEX_BIN login --device-auth </dev/null`, detached — the poller must stay
   alive to collect the token when David approves.
3. Hand David the URL and code as a 🛑 with a push notification, **in the same
   turn**: the code expires in about 15 minutes. The code goes in its own
   fenced code block so he can copy it with one tap (`claude-core.md`, *Astra*).

The bundle stays in `$CODEX_HOME` for the container's life. It is never written
to the environment block, never sent through chat, never handed over in a file.
The classifier refuses that write, and **that refusal is the rule working**.

**An exchange that produced no assessment did not happen.** The script reports
it as a FAILED dispatch and writes nothing. Do not count it, and never relay it
to David as "nothing to report".

**If Astra is unreachable**, say so as a 🛑 and stop — do not silently fall back
to assessing my own plan. The manual paste-into-ChatGPT path remains available
as the human fallback, and I say plainly when I am on it.

## Close-out

**Everything reaches David in chat. There is no page** — no Artifact, no HTML,
no link.

1. **The approval ask, in chat**, as a 🛑 ask (`claude-core.md`, interaction rule 6: a plan before it is enacted is one of the four): a short readout, then **the complete plan**.
   The readout carries what will be built and what is excluded, why the approach
   fits, how success will be recognised, the remaining uncertainty and accepted
   trade-offs, anything still needing his decision — each such question under
   its ID, the same one it carries in the plan's *Questions for David* —
   and any tie I settled over a
   dissent with its practical implication. He should not have to reconstruct the
   conversation to approve.
2. `SendUserFile` for the plan document is **on request**, not the default.
3. **Plan approval is explicit only.** Nothing else counts — not Astra's
   agreement, not an empty ledger, not a harness nudge after a tool error. When
   unsure whether I have been approved, I assume I have not. The scope gate
   authorized the loop to *develop* without check-ins, never to build.
4. **At approval, the plan is committed on its feature branch**
   (`claude-core.md` Planning rule 3). Run the canonical
   disclosure check (`workstream-tracking.md`, *Sensitive /
   disclosure-carve-out workstreams*) on the approved text. If it passes,
   take the digest (below), then `git add -f docs/plans/PLAN_<SLUG>.md` —
   `docs/plans/` ignores drafts, so the add is deliberate — commit, and push
   in the same turn, before any implementation commit. The file merges with
   the first increment's PR; later increments cite the same file, and an
   amendment David approves is committed the same way, with its new digest
   cited from then on. A branch-regime prototype's plan is committed on its
   `prototype/<feature>` branch. **A plan that fails the check** goes into
   the workstream's draft Project item — the private path that section
   names — in full, and never stays in a working tree alone. Beside the
   file, the oracle is still quoted verbatim into the implementation PR
   body — sanitized instead for a plan that failed the check, saying so and
   naming the private path (`claude-core.md` Pull requests rule 3) — and the harvest comment goes on the workstream issue (a prototype's
   version posts none, so the short plan verbatim in its PR body is its
   record — for a short plan that failed the check, the private item holds
   the full text and the PR body or, in the branch regime, the workstream
   issue carries the sanitized short plan, saying so).
5. **Exchanges run go in the workstream issue's harvest comment.** With no PR,
   that comment is the only place `/maintenance` can read planning cost from.
   A prototype's version posts no harvest comment, so its exchanges-run line
   goes in the issue's State of Play block at approval, where `/maintenance`
   reads it instead.
   A private-path workstream has no public issue, or — where it turned
   sensitive after one opened — a public issue holding only sanitized tracking
   (`workstream-tracking.md`); either way the same trail goes in the draft
   Project item's note.

**The implementation PR's `Oracle source:` line names the plan and its
digest** (`claude-core.md` Pull requests rule 4):

````markdown
Oracle source: PLAN_<SLUG>.md, sha256 <the 64-char digest>, approved by David <YYYY-MM-DD>
````

A plan that failed the disclosure check keeps the same line, digest taken at
approval, with `, private path` appended: the file is not committed, and the
digest pins the text the private item holds.

For a prototype's version the line keeps its phase form and carries the
digest beside it, and the body carries the short plan verbatim — sanitized,
saying so, for one that failed the check, with `, private path` appended to
the line as above (rules 3 and 4; the `prototype` skill's ceremony bullet):

````markdown
Oracle source: prototype phase — <feature>, <questions file>; PLAN_<SLUG>.md, sha256 <digest>, approved by David <YYYY-MM-DD>
````

**Take the digest from the plan file as it stands at the moment David approves
it** — `sha256sum docs/plans/PLAN_<SLUG>.md` — and never by copying an
exchange's `planSha256`. Agreed edits reach David without another assessment,
so the last exchange's digest can predate the plan he approved, and nothing
would catch it — nothing parses the line, and a reviewer recomputes it against
the committed file (item 4) only if they think to. A wrong digest is worse than
none, because the line claims to pin what he approved.

An exchange's `planSha256` still identifies what *that exchange* assessed, which
is a different and still useful fact.

**What the line does not establish: that David approved.** It records which
text the PR claims was approved, so a plan-backed PR cannot silently claim an
approval it never names; nothing checks it but a reviewer reading it. The real
boundary is item 3 above — an operating instruction, with nothing mechanical
gating it.

## The workstream issue

### First: make sure it exists

**A label transition needs an issue to carry it.** The loop opens no PR, so the
issue is the *only* spine this work has until an implementation PR exists. Do
this at the scope gate, before the first label below is touched:

0. **First ask whether this work may have a public issue at all.** Sensitive and
   disclosure-carve-out work — anything the canonical disclosure check names
   (`workstream-tracking.md`, *Sensitive / disclosure-carve-out workstreams*,
   referenced here and never restated) —
   **never becomes a public issue**. It is a **private draft Project item**
   instead: create or reuse that, and skip steps 2 and 3 entirely.

   **It runs before the others, not alongside them**: steps 2 and 3 both end in
   a public issue, and the title alone can carry what the carve-out protects.
   When it is unclear, treat it as sensitive and ask David. An unnecessary
   draft item costs nothing; a public issue cannot be unpublished.
1. **The issue may already exist** at `stage:planning`. Nothing to do. A
   feature just flipped from prototype phase arrives here this way: the
   `prototype` skill relabels its existing issue to `stage:planning` before
   this loop starts ([`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
   *Promotion is a real operation*), so a flip never reaches step 3. A
   **later prototype version David asked a loop for** arrives the same way:
   the `prototype` skill relabels the feature's existing issue from
   `stage:coding` to `stage:planning` / `waiting:david` before this loop
   starts, exactly as at the flip minus the registry change, so the issue is
   reused rather than duplicated. A prototype's **first version** has no
   special entry: its issue is a `queue:` item or nothing, so steps 2 and 3
   promote or open it like any feature's, and David's approval returns it to
   `stage:coding` (below).
2. **Otherwise check the backlog first**, per
   [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md).
   This may be exactly a `queue:`-labeled item David is now starting. If a
   matching backlog issue exists, **promote it** — drop `queue:`, add the full
   label set — rather than opening a second issue for the same work.
3. **Only when no backlog match exists**, open a new one with the full initial
   label set (`stage:planning`, `waiting:david`, `mode:feature`) **and** a State
   of Play block. An issue without those labels is invisible to `/status-all`
   and to the board's sync Action.

### Then: keep its labels current

- **The scope banner posts** (and at the scope exchange's hand-over) →
  `waiting:david`.
- **David agrees the scope** → `waiting:claude`, and it stays there while
  the loop runs. **There is no `waiting:codex` state**: an exchange is a local
  process I am waiting on, so I am the holder through every exchange.
- **The approval ask posts** → `waiting:david`.
- **David approves** → `stage:coding`, `waiting:claude`.

### And at approval, if the plan ships in phases: write the checklist

**This is this loop's one phase obligation, and nothing else performs it.**
`workstream-tracking.md`'s ownership table assigns the Phases checklist to this
skill by name, at exactly this moment; there is no second trigger that would
catch a miss.

At David's approval of a **phased** plan, write the **Phases checklist** into the
parent workstream issue's body, with *every* phase listed and each marked `not
yet opened`. Writing only the phases that start immediately defeats the point:
the checklist is the sole durable record of what the feature still owes, and a
phase absent from it is one `/next` cannot see.

**This loop never opens a phase sub-issue itself, for any phase, including the
first.** Its lifecycle ends at this approval handoff and does not run again for
phase 2 onward, so putting phase-opening here would work by accident for phase 1
and silently fail for every phase after it.

**A split is proposed to David, never declared silently.** The checklist is
written *after* he approves the phased shape.

## What this skill no longer does

None of these exists any more; a retired instruction that is still readable is one an agent follows, so they are not described here.

| Retired | Replaced by |
|---|---|
| The `[PLAN REVIEW]` PR, its branch, its body template, the findings ledger | A local Markdown assessment and a chat readout |
| Round counting from GitHub, the round-check receipt, the trigger guard | Exchanges are read from `.agents/reviews/<slug>/`; nothing counts them against a cap |
| `review-budget.mjs` / `review-loop-record.mjs` | Gone everywhere; `--tier` survives, naming what is downstream |
| The disclosure gate on the plan's review PR | The disclosure check at approval, before the plan is committed (*Close-out*, item 4) |
| "The plan is never published" | The plan is committed on its feature branch after the disclosure check |
| The three-round minimum, the fresh-lens stop condition, the adjudicator | The loop ends on a judgement I state |
| The JSON schema and its re-ask | Markdown, and nothing parses it |
| `convergence()` and the computed stop rule | The `plan-action` block |
| Prior findings as ids, titles and dispositions | The concern ledger, with the reasoning intact and its source named |
| Reconcile-every-prior-or-be-rejected | The ledger is mine; Astra's silence closes nothing |
| A fresh lens every round; late findings auto-downgraded | An angle when it addresses a credible gap; consequence judged whenever discovered |
| The `internal` tier's critical-flaw threshold | The Worth rule, applied to what is actually downstream |
| The Artifact page | Chat: a readout per exchange, the plan itself at approval |
| The fenced `plan-provenance` block and its parser | The PR body's `Oracle source:` line |
