---
name: plan-review-loop
description: Use in feature-building mode once the pre-plan conversation has settled intent, or whenever a plan needs to be delivered to David for approval. Runs the planning loop in-session — Astra and I develop the plan together as peers, reading one contract, with the next action stated by me rather than derived from an assessment. No PR, no branch, no GitHub, no page; everything reaches David in chat. NOT for bugfix mode, which skips planning entirely.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# The in-session planning loop

Astra and I develop the plan together. The script spawns Codex CLI with the
`strongestCodex` tier in a read-only sandbox, hands it the same contract I read,
and takes back Markdown. **I hold the authoritative plan**, I argue where I
disagree, I investigate disputed facts myself, and **I state what happens next**.
Nothing parses an assessment. The plan is a file in my working tree that is
not pushed unless David asks for it; everything David sees arrives in chat.

**The script's path differs by repository, so resolve it once per session**
rather than typing either form. The sync routes `core/X -> X`, so the file is
`core/scripts/plan-review.mjs` in the handbook and `scripts/plan-review.mjs`
in every consumer:

```
P=core/scripts/plan-review.mjs; [ -f "$P" ] || P=scripts/plan-review.mjs
```

Every command below uses `$P`. Run it from the repository root.

**This is the planning loop only. The Codex GitHub review of CODE is untouched
and remains David's safety net** — every implementation PR still gets it.

## One contract, two roles

`docs/ai-context/planning-contract.md` is role-neutral and **read verbatim into
every package, by both of us**. It addresses "you" and "your counterpart" and
never says which of us holds the plan. The script's **role block** supplies
that, per role, and it is the only thing that differs between the two packages.

**Read my own copy before I start drafting**, and again whenever I have been
away from the loop. There are two forms, and picking the wrong one is how this
instruction used to fail.

**Before drafting**, once the oracle file exists — the scope-of-work gate below
writes it, and it runs before anything — and when no plan file exists yet:

```
node "$P" --kind scope --slug <slug> --oracle .agents/reviews/<slug>/oracle-<slug>.md --role claude --prompt-only
```

The path is written out rather than using `$S`, which is not assigned until the
scope-exchange recipe far below: an unset variable expands to nothing, so this
line used to send the script looking for an oracle at the filesystem root. **`$P`
is the only variable any block here relies on from another** — every other block
assigns what it uses, and keeping it that way is what the recipe check enforces.

**Returning to an existing plan**, once one is written:

```
node "$P" --kind assess --round <N> --tier <tier> --plan <file> --role claude --prompt-only
```

The assessment form needs `--plan`, so it cannot be the pre-draft command — a
recipe that refuses at the moment it is meant to run is a recipe that fails the
agent following it. The scope form yields the same role block, contract, Worth
rule and oracle with no plan. My copy is written to `<stem>.claude.prompt.md`, a
separate file, so it never overwrites the record of what Astra was sent.

That is not ceremony. The standards I hold the plan to and the standards Astra
holds it to are the same words, or a difference between our conclusions is a
difference of briefing rather than of judgement. My posture differs and the role
block says so: **I develop and hold the plan; I am not a second reviewer of my
own work.**

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

Unchanged, and still the thing that authorizes the loop to run autonomously: the
direction served, this increment's product intent, must-not-change, settled
decisions, the now/next/never calls already made, the ceremony tier and the
1–100 criticality, as a 🛑 NEED YOU banner with its push notification. See
[`working-modes.md`](../../../docs/ai-context/working-modes.md#the-scope-of-work-gate-david-2026-08-15).

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

Short enough to run in the foreground — it reads a page, not a plan. Every later
exchange is detached.

David sees its answer **beside mine** before he says go: my own view first, in
my own words, then Astra's, then where we differ. Cheapest place in the system
to catch "we are about to build the wrong thing", and it costs one exchange
against a document a page long.

If it says the work should not exist, or not yet, **that is a product question
for David**, not a finding for me to absorb. Its concerns go on the ledger like
any other.

### Assessing the plan

Write the plan to `docs/plans/PLAN_<SLUG>.md` in the working tree, with the
oracle as a fenced `plan-oracle` block at its head. Tell David it is drafted and
**keep going** — v1 changes anyway, and waiting buys nothing. He interjects
whenever he likes.

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

**Nothing from the outer shell appears in the program text.** That is the whole
rule, and it is why the program is in single quotes with `$PWD`, `$P` and `$S`
passed as arguments (`_` is `$0`, which `bash -c` consumes). Anything
interpolated into a `bash -c` string is program *text*, read a second time by
the inner shell — so a checkout path is re-parsed as shell. Quoting it closed
exactly one character: measured in a directory named `repo$cash`, the inner
shell expanded `$cash` to nothing, `cd` failed, `&&` short-circuited and the
script never ran; a backtick in the name executed part of the path as a command.
Loud rather than silent — the marker still gets `1`, with no log — but the loop
cannot be run from that checkout at all, and a consumer chooses its own path.

This line has now produced three findings in seven rounds: a space (#124 round
5), then `$` and a backtick (round 12). Round 5 had this same positional shape
offered by the reviewer and by Astra, and took a pair of quotes instead; the
Fable assessor, who recommended the quotes, revised that here — *"it did not
regress; it was incomplete."* Passing values as arguments needs no escaping
rule, so there is no next character.

**The marker is per round AND cleared before launch, and it needs both.** It
used to be one `run.exit` for every exchange in a slug: round 2's launch found
round 1's marker already sitting there and reported an exchange complete before
it had started. That is not hypothetical — in this loop's own live run,
`run.exit` held `0` with the *discussion's* finish time, three minutes after the
assessment it had already overwritten. Naming it per round fixes the collision
between exchanges; deleting it fixes a retry of the same one. The cost of
getting this wrong is not just a confused turn: if the agent relaunches, two
`xhigh` processes write the same attempt path and both promote it. **This is measured, not cautious**: an exchange is
~9–10 minutes at `xhigh` (522 s hand-run, 576 s scripted), which is longer than
a comfortable foreground Bash call, and a foreground run that gets cut off loses
the whole exchange. Absolute paths inside the `bash -c`; the working directory
does not survive into the detached child the way you expect. The rest of the
traps are in
[`codex-cli-in-container.md`](../../../.agents/memory/codex-cli-in-container.md).

**The oracle is pinned on the first exchange and checked on every one after.**
Without that, the oracle is read from the plan file I rewrite each time, so
deleting a requirement from the plan *and* from its oracle block would have the
next exchange measure the plan against my rewritten intent — me steering the
process through the one input nobody was watching. A deliberate change is still
possible, with `--oracle-changed "<what David agreed to change>"`, and it is
stamped on the exchange. Silence is what is refused.

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
script's own output is `round-<N>.discussion-<M>.md`, so a marker named by `<M>`
alone collides across rounds exactly as `run.exit` did. **This sentence used to
claim "a retry cannot mistake an earlier marker for this one's completion",
which was true per discussion and false per attempt**: the path was reused on a
retry, so the previous attempt's marker satisfied the wait immediately. An
overclaim beside a fix is worse than the gap, because it tells the next reader
the case is handled (Codex and both assessors, #124 round 2).

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
   it is absent. That refusal is deliberate: an absent ledger reads as
   *forgotten*, which is the one thing no check can distinguish from *nothing
   was raised*. So it is mine to answer, by writing the file. `--no-ledger` is
   the escape the error names, for the case where earlier exchanges genuinely
   returned nothing and I have not written one.

   **When a discussion changes the OTHER party's position, the `response` says
   so and says why** — not just what I argued. A concern settled because Astra
   withdrew it on new evidence reads, from its state alone, exactly like one I
   talked it out of, and the next cold reader is handed my side of an argument
   whose conclusion it cannot see. The discussion file is now named in the next
   assessment's package (round 10 `4049965628`), so the reasoning is reachable;
   this keeps the ledger's own line honest about which way it went. (Astra,
   #124 round 10.)

   **`[]` is only ever what the file contains while nothing has been raised in
   the loop so far** — never what an exchange writes over entries that exist.
   This bullet used to read "an exchange that raised nothing still writes `[]`",
   which an agent reading the bold text would follow literally: exchange 2
   raises nothing, the ledger holding exchange 1's concerns is overwritten with
   `[]`, and **the loss is silent** — the script loads an empty array happily
   and the next cold reader is told "No concerns are on the ledger yet." It
   surfaces only when a later discussion names an id and is refused, by which
   time the reasoning is gone. That is the same requirement round 7 enforced one
   entry at a time (a concern may not drop its text) failing wholesale, and the
   script cannot catch it: a genuinely empty ledger and an emptied one are the
   same bytes, so the instruction is the only layer that can say it (Codex, #124
   round 9 `4049773962`; both assessors concurred).

3. **State the next action, explicitly.** Nothing in an assessment decides this.

   ````
   ```plan-action
   action: revise
   concerns: C1, C3
   note: C2 goes to David; C4 withdrawn on the evidence
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
stated in an action block. What still stops it for David, at any point: a
choice that changes intended behaviour, scope, or an accepted user-facing
consequence; a scope addition; a split; and a disclosure question. A purely
technical fork between two approaches to agreed behaviour is not on that list.

**An assessment that says it could not do the job is not a clean exchange.** The
old loop had two status labels that computed this; now it is prose I read. If
Astra says it lacked the repository context, or could not reach something
material, that is mine to supply and re-run — never convergence.

## What never gets settled inside the loop

- **Choices that change intended behaviour, scope, or an accepted user-facing
  consequence.** Astra may critique the idea itself, and when it does, that goes
  to David as a **numbered question carrying its view and mine side by side** —
  never absorbed into a revision. **A purely technical design fork is not one of
  these**: two approaches serving the same agreed behaviour are ours to settle,
  and calling every design question David's would take back the tie-break
  granted three paragraphs below. (Astra, assessing this change: the two
  instructions contradicted each other and either could fire.)
- **Anything that changes intended behaviour, scope, or an accepted user-facing
  consequence.** His, always, including his own use of the software factory.
- **A scope addition.** Any revision that would introduce a new mechanism — a
  table, a role, a config domain, an endpoint — is a now/next/never question for
  David, defaulting to *next*.

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

The point is not that the flags are dangerous to type. It is that the two things
this design exists for — an independent peer, and one that cannot edit what it
is discussing — were both one unnoticed flag away from being lost.

## When Astra cannot run

**Sign-in is per session and never stored.** The script exits **2** when there
is none, with the device-code instructions and without running anything. Get one
before the loop starts, not mid-exchange:

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
to David as "nothing to report" — that is the exact failure the honest reporting
exists to prevent.

**If Astra is unreachable**, say so as a 🛑 and stop — do not silently fall back
to assessing my own plan. The manual paste-into-ChatGPT path remains available
as the human fallback, and I say plainly when I am on it.

## Close-out

**Everything reaches David in chat. There is no page** (David, 2026-09-18,
retiring the Artifact page of 2026-09-09). The plan loop now matches the
code-review loop, where the core already says: no page, no Artifact, no HTML, no
link.

1. **The approval ask, in chat**: a short readout, then **the complete plan**.
   The readout carries what will be built and what is excluded, why the approach
   fits, how success will be recognised, the remaining uncertainty and accepted
   trade-offs, anything still needing his decision, and any tie I settled over a
   dissent with its practical implication. He should not have to reconstruct the
   conversation to approve.
2. `SendUserFile` for the plan document is **on request**, not the default. The
   ban on it belonged to the page that replaced it.
3. **Plan approval is explicit only.** Nothing else counts — not Astra's
   agreement, not an empty ledger, not a harness nudge after a tool error. When
   unsure whether I have been approved, I assume I have not. The scope gate
   authorized the loop to *develop* without check-ins, never to build.
4. **The plan file reaches `main` only if David asks.** Otherwise it stays in
   the working tree. What survives a loop by default is the approved plan's
   oracle, quoted verbatim into the implementation PR body, plus the harvest
   comment on the workstream issue.
5. **Exchanges run go in the workstream issue's harvest comment.** With no PR,
   that comment is the only place `/maintenance` can read planning cost from.
   A private-path workstream has no public issue — its tracking is the draft
   Project item, and the same trail goes in that item's note.

**The implementation PR's `Oracle source:` line names the plan and its
digest** (`claude-core.md` Pull requests rule 4):

````markdown
Oracle source: PLAN_<SLUG>.md, sha256 <the 64-char digest>, approved by David <YYYY-MM-DD>
````

**Take the digest from the plan file as it stands at the moment David approves
it** — `sha256sum docs/plans/PLAN_<SLUG>.md` — and never by copying an
exchange's `planSha256`. Those were the same thing under the old loop, which
forced another round after every revision. They are not the same now: agreed
edits reach David without another assessment, so the last exchange's digest can
predate the plan he approved, and nothing would catch it — nothing parses the
line, and no reviewer holds the plan's bytes to recompute it. A wrong digest is
worse than none, because the line claims to pin what he approved. (Codex and
both assessors, #124 round 1.)

An exchange's `planSha256` still identifies what *that exchange* assessed, which
is a different and still useful fact.

**What the line does not establish: that David approved.** It records which
text the PR claims was approved, so a plan-backed PR cannot silently claim an
approval it never names; nothing checks it but a reviewer reading it. The real
boundary is item 3 above — an operating instruction, with nothing mechanical
gating it. (A fenced `plan-provenance` block and its parser stood here until
2026-09-25, when both were retired, #103; the block never gated approval
either, which #124 round 9 had already had to correct.)

## The workstream issue

### First: make sure it exists

**A label transition needs an issue to carry it.** The loop opens no PR, so the
issue is the *only* spine this work has until an implementation PR exists. Do
this at the scope gate, before the first label below is touched:

0. **First ask whether this work may have a public issue at all.** Sensitive and
   disclosure-carve-out work — an unpatched vulnerability, auth-bypass
   specifics, payment-fraud paths, private customer data, embargoed work —
   **never becomes a public issue**. It is a **private draft Project item**
   instead: create or reuse that, and skip steps 2 and 3 entirely.

   **Numbered zero because it runs before the others, not alongside them.**
   Steps 2 and 3 both end in a public issue, so a carve-out that reaches them
   has already lost — the title alone can carry the thing the carve-out exists
   to protect. This is the one step whose failure mode is disclosure rather than
   bad bookkeeping, so when it is unclear, treat it as sensitive and ask David.
   An unnecessary draft item costs nothing; a public issue cannot be
   unpublished.
1. **The issue may already exist** at `stage:planning`. Nothing to do.
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
- **David agrees the scope** → `waiting:claude`, and it stays there for the
  whole loop. **There is no `waiting:codex` state**: an exchange is a local
  process I am waiting on, so I am the holder throughout.
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

Deleted rather than kept as history, because a retired instruction that is still
readable is one an agent follows. Recorded here in one list so a reader of the
old loop can find each piece's fate:

| Retired | Why it existed | What replaced it |
|---|---|---|
| The `[PLAN REVIEW]` PR, its branch, its body template, the findings ledger | The reviewer was remote and diff-anchored | A local Markdown assessment and a chat readout |
| Round counting from GitHub, the round-check receipt, the trigger guard | Round state lived on GitHub | Exchanges are read from `.agents/reviews/<slug>/`; nothing counts them against a cap |
| `review-budget.mjs` / `review-loop-record.mjs` | Both were keyed to a PR number | Gone everywhere (#89 cut); `--tier` survives, naming what is downstream |
| The disclosure gate on the plan | The channel was public | The plan is never published |
| The three-round minimum, the fresh-lens stop condition, the adjudicator | A defect-only reviewer could not say *done* | The loop ends on a judgement I state |
| **The JSON schema and its re-ask** | "Every section every round" had to be enforced rather than asked | Markdown, and nothing parses it |
| **`convergence()` and the computed stop rule** | Astra's returned verdict drove the loop | The `plan-action` block |
| **Prior findings as ids, titles and dispositions** | Anchoring was the worry | The concern ledger, with the reasoning intact and its source named |
| **Reconcile-every-prior-or-be-rejected** | The stop rule read the reconciliation | The ledger is mine; Astra's silence closes nothing |
| **A fresh lens every round; late findings auto-downgraded** | Convergence measured consistency, not quality | An angle when it addresses a credible gap; consequence judged whenever discovered |
| **The `internal` tier's critical-flaw threshold** | A rubric that decided | The Worth rule, applied to what is actually downstream |
| **The Artifact page** (David, 2026-09-18) | A plan had no single URL once the PR went | Chat: a readout per exchange, the plan itself at approval |
