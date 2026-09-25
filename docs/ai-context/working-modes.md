<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Working Modes: feature (default) vs. bugfix

> The canonical, cross-agent statement of the two workflows David uses. **The
> ceremony in force is always visible — announced or declared, never silent**
> (see *How each agent enters / exits a mode* below). This applies to Codex,
> Claude, and any agent. (Claude Code layers extra ceremony on top per
> [`CLAUDE.md`](../../CLAUDE.md) and its `/bugfix` skill; the *distinction* below
> is the shared truth.)

There are two modes. The default is **feature mode**. **Bugfix mode** fixes a
bug without the planning ceremony — it drops the plan and the plan-review
loop, **not** the verification, and it tiers its remaining ceremony to what
the fix actually turns out to touch. How a request enters it — routed by
shape (Claude) or declared in the prompt (Codex) — is *How each agent
enters / exits a mode* below.

## Feature mode (default)

The full workflow for building or changing product functionality. In this mode:

1. **Inspect the repo first** (read the relevant `docs/ai-context/*`).
2. **Plan before implementing, and get David's explicit approval** before you
   build — see the plan-before-implementation rule in
   [`agent-working-rules.md`](./agent-working-rules.md) and the template in
   [`../../.agents/PLANS.md`](../../.agents/PLANS.md). Do not start the build on an
   unapproved non-trivial plan.
3. **Build it fully, end to end** (backend + the UI surface to exercise it + tests
   + any doc updates).
4. **Tests prove the general invariant**, not just the reported example.
5. **Open a PR** for review.

Any "let's build / add / change X", a behavior change, or a **database**
schema change is feature mode — **not** gated on product consequence: a
non-trivial database schema change of any kind (see *Tier C* below) needs a
plan and David's approval before anything runs. A database schema change is
feature mode by default; it stays out of the full plan only if it's genuinely
trivial, in which case it runs migration ceremony directly per Tier C. (This
is the *database* schema — migrations and table structure — not **generated
API-validation schemas**, which have their own explicit Tier B routing; see
*Tier C* below. A repo that generates such schemas names them in its overlay.)

### Feature-mode ceremony scales to blast radius, not to phrasing (David, 2026-08-05)

**The trigger for feature mode is a phrase ("let's build X"). The amount of
ceremony it earns is decided by the artifact, not the phrase.** Getting this
backwards is what produced PR #333: a request to build a `/status` skill —
two markdown files — went through the full plan + convergence loop and reached
**six review rounds and a 660-line plan** before anyone asked whether the
ceremony fit the thing being built.

The deciding question is the one already used for model routing in
[`CLAUDE.md`](../../CLAUDE.md): **if this goes subtly wrong, will code review or
David's product-testing catch it before it does damage?** Where the answer is
"immediately and obviously," heavy ceremony buys nothing and actively costs —
every round of adversarial review on a low-risk artifact generates new surface
to review.

**What this table selects is planning ceremony and review depth. It does not
select how long a review loop runs** — that is the two-review limit, below,
which applies to internal tooling whatever its row — **and which asks
"internal" of the change, by its consequences and recoverability, rather than
by row or directory**, so a change to a skill, contract or script governing
approvals, publication, credentials or destructive operations is weighed on
that wherever it appears in this table.

| Artifact class | Planning ceremony and review depth | Why |
| --- | --- | --- |
| **Transient, single-use process docs** — handoff docs, one-off run notes, legacy TEST_RUN checklists (the TEST_RUN file itself is retired as of 2026-08-15 — new PRs carry a *Post-merge verification* PR-body section reviewed with the diff, per [`test-run-contract.md`](../tests/test-run-contract.md); this row still governs the legacy files while they run out), anything deleted after one execution | **No plan document. No plan-review loop.** Review *depth* is the docs-only light bar in [`code-review.md`](../engineering/code-review.md). How long iteration runs is **not** this row's to say — that is the two-review limit below, and this column used to claim "one triage and the loop ends there — no re-request", which let a commit merge that no review had read. | Criticality ≈ 1 on a 1–100 scale (David, 2026-08-08) — **conditional on the TEST_RUN read-only contract** ([`test-run-contract.md`](../tests/test-run-contract.md)): these docs may not instruct suite re-runs or live-state mutations, which is exactly what keeps their worst case at "one confused run by one person, immediately self-catching." A finding that a doc *breaks* that contract — an instruction that could touch live state — is a glaring issue and is worth writing for. A P1 badge on anything else describes the finding's internal severity, not this artifact's blast radius. |
| **Agent-facing markdown** — skills, `docs/ai-context/`, `docs/engineering/`, contracts, prompts | **No plan document, no plan-review loop** — write the real file and ship it. Iteration is bounded by the two-review limit below, not by this row — and that limit asks its question of the change, by consequence and recoverability, so a change to a contract or prompt in this class that governs approvals, publication, credentials or destructive operations is weighed on that. | Self-catching: it's wrong the first time someone runs it, and a fix is one commit. Nothing is irreversible. |
| **Product code** | Today's full feature ceremony — plan, review, approval. (Outside the two-review limit, which bounds internal tooling; that does not make "to convergence" its stop, which is a name this repo retired.) | Codex's review is a real net, but a subtly wrong behavior can reach users. |
| **Migrations, backfills, auth, payments, and any subsystem the overlay marks sensitive** | Full ceremony **plus** the relevant specialist review. | Often irreversible, and a subtly-wrong result isn't visible until the damage is done. |

For the floor tier, say so in the PR body's *What & why* ("transient checklist,
deleted after one run"), so the reviewer and any later reader can calibrate from
the same line. **It says what the artifact is, never how many reviews it
gets** — that line used to promise "findings triaged once, no re-review", which
is a commitment to the reviewer that a changed head would go unread.
Review *depth* on any docs-only PR is governed by
[`code-review.md`](../engineering/code-review.md#documentation-only-prs-get-a-light-review-david-2026-08-08),
which is that rule's only statement, and the review request states its bar
explicitly. Depth is what a reviewer *raises*; what is worth writing for once
raised is the Worth rule ([`review-judgment.md`](review-judgment.md)), and no
tier or artifact class predetermines that answer.

**A plan document is for work whose *approach* could be wrong in a way David
can't see from the result.** A skill file's approach is legible from the file
itself, so the file *is* the plan — write it and review the real artifact
rather than reviewing a description of it.

**When the class is genuinely unclear, ask** — one numbered question at intake,
before any plan is written. Do not default to the heavier path "to be safe":
this failure mode has a real cost and it is the one that has actually happened.

### Directions and plans are different artifacts (David, 2026-08-11)

The ceremony table above answers *how much* review an artifact earns. This
answers **what the artifact is** — and getting it wrong is what let PR #404's
plan grow from 877 to roughly 1,370 lines **during its own review**, across
three rounds that ran 24 → 14 → 21 findings.

- A **direction** states an end state: "one screen governs everything an
  account may do." It is **totalising by nature** — that is its job — and it
  carries the product decisions that constrain every increment beneath it. It
  lives with the other shared context docs in `docs/ai-context/`, is reviewed
  for soundness **without being iterated on the way a plan is**, and is updated
  as later discoveries land. **"Reviewed once" meant not looping on an end
  state; it never meant a corrected direction escapes review.** If that review
  finds a soundness defect and the direction is changed, the changed head is
  reviewed like any other — the write-gate's no-unreviewed-commit invariant
  applies here as everywhere, and the two-review limit applies here on its
  own terms ([below](#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)): it bounds internal tooling, so not product code,
  and it asks "internal" of the change by its consequence and recoverability,
  weighing a change to machinery governing approvals, publication, credentials
  or destructive operations on what that change does. (This read "the two-review limit … applies here as
  everywhere" until 2026-09-23 — the limit called universal, forty lines below
  the table row that puts product code outside it — and its first replacement
  then exempted that machinery as a category, #148.) (Codex, #140 round 2,
  finding the third one-pass path.)
- A **plan** builds **one bounded increment** toward a direction and **cites
  the direction it serves**. Its intent sentence says what *this increment*
  makes true — never what the end state is.
- **The plan-review loop only ever runs on an increment, never on a
  direction.** A direction has no implementation to be wrong about, so
  adversarial review of one produces specification rather than correction.
  **This does not exclude round 0**, the scope gate's second opinion (David,
  2026-09-09): round 0 reviews *this increment's agreed scope* before its plan
  is written, which is the increment's own oracle rather than the standing
  direction — so it is inside this rule, not an exception to it. Reading the
  sentence as "never before a plan exists" would skip the loop's cheapest
  round, which is the one that catches building the wrong thing at all.
  (This is about the plan
  loop specifically — it says nothing about code-review loops on implementation
  PRs, feature or bugfix, which keep running exactly as described elsewhere in
  this doc and in the `bugfix` skill.)

**Why the split is load-bearing.** PR #404's Product Intent was David's own
totalising sentence — "any and all permissions… exclusively… one source of
truth." Stated as the intent of a *single plan*, a universal quantifier makes
every subsequent discovery in-scope **by definition**. When review surfaced
the per-user override contradiction, the intent said it belonged. When it
surfaced engine access, the intent said that belonged too. The document had no
way to say "true, and *next*" — only "true, so *in*." The intent was not
wrong; it was a direction wearing a plan's clothes.

**A discovery has three destinations, not two: in-scope, rejected, and next
plan.** The third one is what was missing. The scope that broke PR #404 came
from genuine discoveries the pre-plan sweep and the review loop are *designed*
to surface — they did not exist at intake to be decomposed away, so
"decompose harder up front" would not have helped. Somewhere to put a
mid-flight discovery would have.

Worth stating plainly, because it decides what to fix and what to leave alone:
across all 59 findings in that loop, **not one overturned a decision from the
pre-plan conversation.** Union semantics, the two rails, the bootstrap
carve-out, preview-drops-to-registered — all held under adversarial review.
The front of the process worked. The artifact fed to it contained three
projects.

**A direction that duplicates or contradicts an existing canonical doc is not
a new artifact — it's a routing bug.** The repo's product direction
already exists and already declares itself the winning source for current
direction and settled decisions; most subsystems already have a canonical
`docs/ai-context/<subsystem>.md`. Writing a direction means updating the
matching existing doc (adding or revising its end-state statement), never
standing up a parallel file — the single-canonical-home rule in
[`documentation-workflow.md`](./documentation-workflow.md#step-2--route-each-learning-to-its-one-canonical-home)
governs directions exactly as it governs any other learning. A direction earns
a genuinely new file only when no existing doc owns its area, and a new file
gets added to `AGENTS.md`'s routing per that same rule — it does not get to
skip the step just because it's the "totalising" artifact type.

**A direction is subject to the same public-disclosure check a plan is, before
it is committed — not after.** A totalising end-state statement can itself
contain unpatched-vulnerability details, an auth-bypass shape, or an
abuse/fraud path — and a direction is published where a plan now is not. A plan
reviewed in-session is never committed and never pushed, so it has nothing to
screen for publication; a direction that updates a canonical
`docs/ai-context/` doc goes live on `main` directly. Run the canonical
disclosure check —
[`workstream-tracking.md`](./workstream-tracking.md#what-must-never-happen)'s
definition, the one every other disclosure gate in this repo references rather
than restates — before committing a direction; a direction that fails it takes
the same private/manual path a disclosure-carve-out workstream would.

### The increment test

**Establish what the increment makes true, what bounds it, and how completion
will be recognised** (#124, 2026-09-18, replacing the categorical form below).
Universal wording — "all", "every", "everything", "any and all", "exclusively" —
can describe a bounded requirement holding across many affected paths, or an end
state spanning several increments. **Determine which it describes; the wording
alone does not decide.** Where the intent makes additional work belong merely
because the eventual direction needs it, surface the boundary question before
detailed planning: write or update the direction, then cut the first increment
out of it. Don't narrow the requester's words to make a test pass — the
totalising sentence stays intact in the direction, which is exactly where it
belongs — and don't split work that is one coherent change merely because its
sentence needed the word "every".

**Why this replaced a categorical rule.** It used to read "a universal
quantifier in the intent sentence *means* you're holding a direction", and the
planning contract's scope assessment now says the opposite: phases, breadth and
universal wording do not automatically require a split. A rule and its contract
disagreeing on the entry path is worse than either, and the categorical form is
the one that lost.

**Attributed to the change rather than to David**, deliberately. He approved a
planning contract that entails this, and never ruled on this wording — so a
`(David, ...)` stamp here would put his name on a consequence someone else
derived, which is exactly the kind of claim a later session cannot check and
will not think to question. The rule stands on the contradiction above, not on
whose initials are next to it.

**A *Phases* section that separates independently shippable pieces is a reason
to consider separate plans, not a verdict.** Assess whether separation reduces
uncertainty, simplifies verification, or delivers useful outcomes sooner,
against the dependencies and the cost of intermediate states. The distinction is **independent
deliverability**, not the mere presence of ordered steps — a single increment
can legitimately need an ordered migrate → rollout → verify sequence, and that
is not a split signal. It's a split signal when a phase could ship, be
correct, and be verified **on its own**, without a later phase landing (PR
#404 had three phases before round 1, each a separable subsystem: resolver,
metered limits, engine bands). `AGENTS.md`'s planning steps ("propose a
phased plan") describe this ordered-steps case, not the split case, and are
not in tension with this test once read that way.

**Narrowing to one increment is a stated decision, not a silent scope
drop.** [`agent-working-rules.md`](./agent-working-rules.md#pre-plan-intent-is-the-source-of-truth)'s
pre-plan-intent rule carries the exception directly: narrowing to increment A
is not the failure it catches, provided B is named in the plan's cited
direction rather than silently absent.

### The affected-surface inventory (David, 2026-08-13)

**Run this before Problem/Direction are drafted, not after — it's what tells
you whether the increment you're about to cut is the right one.** Any change
that touches a *pattern* rather than a single call site — a permission shape,
a data-derivation rule, a naming convention, anything with plausible siblings
— gets a mechanical inventory before the plan's scope is written down, using
the same discipline the class-sweep protocol already requires at fix time
(*"A finding names an instance; the fix owes the class"*, below): name the
class, write a mechanical oracle that finds every instance, run it, and scope
the plan against the actual hit list — not a recalled one.

**The requirement is a property of the oracle, not a command: its corpus
must be the tracked set.** The inventory asks *what does this repository
contain*, and "the tracked set" is that question's definition — so any search
whose corpus is narrower or wider answers a different question and reports a
hit count the plan should not be scoped against. `git grep -n '<pattern>'` is
the example that satisfies it. **Deliberately only one** — the previous
version offered `git ls-files` "piped into whatever you like" as an
equivalent, and that pipeline searches the *filename stream*, not file
contents: `git ls-files | rg <pattern>` returns **no hits** for a pattern
present in five tracked files. An example offered to illustrate the property
must itself satisfy the property, and a second example is a second chance to
get that wrong.

**This is stated as a property because six successive rounds of stating it as
a command failed** — each fix correcting the previous invocation's symptom and
leaving the class untouched. What each alternative gets wrong, stated as the
**difference from the tracked set** rather than as a hit count:

| invocation | what it gets wrong |
|---|---|
| `grep -rn` from the root | **over**-counts — walks `.git`, `node_modules`, and generated output, so N includes non-source copies |
| bare `rg -n` | **under**-counts — skips hidden directories, so a heading present only in `.agents/PLANS.md` is invisible to it, and `.agents/`/`.github/` are where this repo's process sources live |
| `rg -n --hidden` | the `grep -rn` problem returns: `.git` is back in the corpus |
| `rg -n --hidden --glob '!.git'` | **under**-counts — ripgrep honours VCS ignore rules, so it misses the tracked-but-gitignored `artifacts/overhype-me/.env.local` that `git grep -l` finds |
| `git ls-files \| rg` | searches **filenames**, not contents — no hits for a pattern that exists only inside files |

**No totals appear in that table, and that is the fix rather than a style
choice.** Earlier versions quoted probe strings and stated counts like "returns
zero files" — and each was **false at its own commit**, because writing the
probe into this file made this file a hit. A count is a property of the tree at
an instant; a *delta* ("misses this tracked file that `git grep` finds") and a
*mechanism* ("honours ignore rules") stay true as the tree changes. Cite the
delta and the mechanism; never the total.

A filesystem walker (`ls`, `find`, `grep -r`, `rg`) answers a question about
the *disk*; use one only when that is genuinely what you mean. An oracle that
silently skips a tracked file is the false-completeness failure below,
arriving through the tool rather than the prose.

**This is the same move, moved earlier.** The class-sweep protocol exists
because a reviewer's cited instance is never guaranteed to be every instance.
Running that discovery step at *plan entry* instead of waiting for review to
find the gaps one round at a time is strictly cheaper — the search costs
seconds; a review round costs a full loop iteration. PR #425 is the origin
case in both directions at once: the plan moved the tier-derived permission
gates it *already knew about*, and the CI guard built mid-loop (round 1)
would have produced the complete inventory in about two seconds if it had
existed at plan-entry instead of being invented three review rounds in. Three
rounds of findings were substantially the enumeration this section would have
front-loaded.

**What this is not**: an argument for enumerating call sites *inside the plan
document* — the specification test right below still says the compiler
should enumerate typed call sites, not the prose. The inventory here is a
**discovery step that determines scope**, whose *initial* run comes before
drafting and which is re-run whenever the class, oracle, or scope moves (see
below); its
output is "these N files match the pattern, so the plan covers all N" (or
explicitly phases/defers some of them), not a list pasted into the plan for a
reviewer to check off. A raw-SQL / untyped-writer surface — exactly the
carve-out the specification test names below — is where this matters most:
the compiler cannot enumerate those sites at review time, so if the inventory
didn't find them at plan time, nothing will until production.

**Bugfix mode gets the identical discipline at diagnosis, not planning**
— per-bug step 5 (*Establish the blast radius*) below is this same inventory,
oracle-backed, scaled to one bug's call graph instead of a repo-wide pattern.

**Some classes cannot be mechanized at all, and that is a recorded outcome
rather than a dead end.** A semantic class with no searchable signature — a
data-derivation rule is the obvious example, and it is one of this section's
own triggers — has no oracle that finds every instance, however the regex is
written. The class-sweep protocol below already handles exactly this at fix
time (*"If the finding genuinely cannot be mechanized (a pure design/semantics
finding), the reply says so — that inability is itself a signal, and it routes
the finding to the driving agent's judgment-escalation triggers"*), and the
same escape applies here: **record that the class cannot be mechanized, and
route the scope call to judgment/escalation.** What is forbidden is the third
option — running a nominal search that does not actually find every instance and
then claiming inventory-backed scope. That is worse than skipping the step,
because it launders false completeness into the plan's scope, which is the
precise failure this section exists to prevent.

**Re-run the oracle whenever the class, the oracle, or the scope changes, and
once against the final revision.** The inventory is a pre-drafting step, not a
one-time one: if drafting or review refines the affected class or adds an
in-scope mechanism, a hit list produced for the earlier, narrower class is a
**recalled** inventory wearing a mechanical one's authority — which is the
failure this whole section exists to prevent, arriving through staleness
instead of through scope.

**If the inventory is expensive or the pattern's boundary is genuinely
fuzzy, say so** — "inventoried via `git grep -n <pattern>`, N hits, list attached;
M borderline cases excluded because <reason>" — rather than skipping it
silently. An inventory that ran and found nothing new is worth stating too,
since a reviewer otherwise has no way to tell "there was nothing to find"
from "this was never done."

**Where that statement goes differs by mode, and the destination field has to
exist in the mode being addressed** — checked, not assumed:

| mode | field | where |
|---|---|---|
| feature | **Settled Decisions** | `.agents/PLANS.md`, and the PR body's feature block |
| bugfix, Tier A/B | **Blast radius** | the bugfix oracle — *what else calls this / shares this path, and what you checked* |
| bugfix, Tier C | **Why this is trivial** | the Tier C block, which deliberately carries none of the Tier A/B fields |

Tier C lands there rather than getting a field of its own for a reason worth
stating: a Tier C classification already asserts there is no pattern surface
to inventory, so the inventory statement *is* part of the triviality argument.
And it is self-checking — **an inventory that turns out expensive or fuzzy on
a Tier C fix is evidence the tier is wrong**, not an exception to be recorded
and moved past.

Naming a field a mode does not have is not a wording slip: it leaves the
exception unrecordable, or drags the fix into a ceremony that mode exists to
skip. Both failures shipped in this section's first two drafts.

### A completeness claim carries its oracle, or it is not a claim (David, 2026-08-25)

**A plan may assert that a set is complete, that a behavior is inert, or that a
state is unreachable only when one of two things holds: a mechanical oracle
enumerates the class, or a construct in the design enforces the property.
Prose is neither.** Where neither is available, the property is written as an
open uncertainty and does not become a Settled Decision.

This is the affected-surface inventory's rule generalised past inventories. The
inventory section already requires a mechanical oracle for a *pattern being
changed*; this extends the same requirement to every load-bearing property a
plan states about the world — because those are what a reviewer, and later an
implementer, take as given without re-deriving.

**The evidence is PR #568, which produced the same failure three rounds
running** — and the third instance is why this is a rule rather than a note:

| Claim | Basis | Outcome |
| --- | --- | --- |
| "The credential class has exactly one member" | asserted from a search whose output was mis-read | wrong — three members |
| "The sync surface is four methods" | asserted from call sites | wrong — twelve, via an interface satisfied by assignment rather than by an explicit call |
| "The fake is CI-only" / "the toggle is inert under fake" | asserted in prose, enforced nowhere | wrong — the design permitted exactly what the document forbade |

The plan had already *recorded* the round-1 lesson in its own text — "an
inventory whose class definition requires a judgment call at classification
time is not mechanical" — and then made two further unbacked claims on the same
page. **Writing a lesson down is not a control.** A rule that only fires when
recalled will not fire; this one fires against an artifact, at the moment a
sentence claiming completeness is written.

**The operational test, applied to any such sentence: *where is this
enforced?*** A satisfying answer points at one of exactly two things, and both
have a failure mode the rule has to name, because the plan that prompted this
rule hit both.

**An oracle — run, recorded, and reconciled.** *Naming* a search is not
carrying one. The first row of the table above had an oracle: it was run, and
its output was misread, because the class it searched for still needed a human
judgment to sort the results. So the requirement is three things, not one: the
oracle is **executed against the revision under review**, its **actual output
is recorded** in the plan, and the plan **states how that output maps to the
claim** — which hits it counts, which it excludes, and why the partition needs
no interpretation. An oracle whose results a careful reader could sort two
different ways has not established anything.

**A construct — in the implementation, not in the plan.** A construct is a
predicate, a type, a schema constraint, or a runtime refusal that will exist in
the shipped system and make the violation impossible. **A table in a plan is
not a construct.** That distinction is the whole third row of the table above:
revision 2 of the Stripe plan carried a resolution table whose row read
`| fake | Fake driver |`, and "the fake is CI-only" was true nowhere except in
the surrounding prose. A table earns the claim only when each row names the
concrete mechanism that enforces it — and then the row is judged by that
mechanism, never by being tabular. Formatting is not enforcement.

An unsatisfying answer points at another sentence in the plan. If the answer is
a sentence, either add the construct or downgrade the claim.

**This rule does not license implementation detail in a plan, and does not
collide with the specification test below.** The two govern different
questions. The specification test governs *what a plan says*: leave out
anything the compiler, the test suite, or diff review would catch. This rule
governs *whether a property may be stated as settled at all*. Satisfying it
takes one clause naming the mechanism — "refused at boot when the mirror is
non-empty" — not the code that implements it. A plan that starts describing the
assertion has stopped satisfying this rule and started violating the other one.

**But "a check enforces it" is not a free pass, and a test is not a construct.**
A construct *prevents* the state; a test *detects* it, after the fact and only
if someone writes it. So a claim whose only backing is a future test is not
settled by naming that test — it is written as **checked**, not as *cannot*,
and the plan says which it has. The difference is not pedantry: "the fake
cannot reach a real database" and "a test would catch the fake reaching a real
database" license completely different downstream reasoning, and it was the
first that this repo's Stripe plan kept asserting on the strength of the second.

The two paths therefore answer different questions, and neither substitutes for
the other:

- **The oracle path is for claims about what the repository contains today** —
  and must be run today, with the output recorded and mapped. A search that
  will be run later establishes nothing now.
- **The construct path is for claims about the system being built** — and the
  named mechanism must be one that makes the violation impossible when it
  exists: a predicate, a type, a schema constraint, a runtime refusal. A guard
  that fails the build qualifies for claims about repository contents, because
  it stops the violating state from landing; it says nothing about runtime.

Everything else — a test, a review step, a convention, a comment asking future
editors to be careful — supports "we would find out", never "it cannot happen".

**"Unsupported by convention" is not "unreachable by construction," and the gap
between them is where these defects live.** A property that holds only because
nobody has yet set the variable, run the command, or clicked the toggle is a
habit, not an invariant, and a plan that calls it an invariant has mis-stated
its own safety. When the distinction is genuinely load-bearing — a safety
property, a security boundary — say which of the two you have.

**Why this is cheap to comply with.** Most completeness claims in a plan are
not load-bearing and can simply be dropped to ordinary description. The rule
bites only on the ones a reviewer would rely on, which is precisely the set
worth the cost of an oracle. And an oracle written at plan time costs seconds;
the same gap found at review time costs a round, and found after merge costs
whatever the property was protecting.

### A plan specifies invariants, not implementation (David, 2026-08-12)

**The test, applied to any line you are about to write into a plan: if the
plan never mentioned this, what would catch it?** If the answer is the
compiler, the test suite, or a code reviewer looking at the diff, the line is
costing review rounds to find what the toolchain finds for free. If the answer
is *nothing*, the line is why plan review exists.

**Where this came from.** PR #421's round 4 produced eight findings. Traced
against that question: the compiler would have caught one (a required column
with no default makes an uncovered insert fail to typecheck), running the test
would have caught another (an assertion that could not be true), diff review
probably a third. One was plan-only and worth nothing. **One was plan-only and
load-bearing** — two sibling plans whose deploy order was constrained in both
directions, which no compiler, test, or single-PR reviewer can see. One in
eight justified the round.

Contrast PR #422's first round: ten findings on PostgreSQL enforcement
mechanics — trigger event coverage, `ENABLE ALWAYS`, statement-level TRUNCATE,
ownership reach. **Not one is catchable by a compiler, a test, or a diff
review.** A security boundary wired wrong compiles, passes, and reports
success while being fake. So the answer is not "write shorter plans" — it is
**cut by category**.

**Stop specifying:**

- **Call-site enumeration — but only where the call sites are statically
  typed.** State the invariant (*every writer to this table carries the
  snapshot*) and let the compiler enumerate the writers: a list of call sites
  in a plan goes stale silently, while a `NOT NULL` column on a Drizzle-typed
  insert is a list that cannot.

  **The exception is load-bearing in this repo, and a review of this very rule
  caught it: raw `db.execute(sql\`INSERT INTO …\`)` is not checked against the
  table type.** Ten tables here are written that way — `admin_config`,
  `ncmec_reports`, `upload_image_metadata`, `quarantined_memes` and others —
  so a raw writer compiles clean and fails only when that production path
  reaches the database. **A plan that changes a table's write contract
  therefore still owes a repo-wide writer inventory** (`grep` for the table
  name, not just the typed call sites), and says which writers are raw. The
  compiler is a substitute for enumeration exactly as far as the writers are
  typed, and no further.
- **Test assertions and their expected values.** State what must be true. The
  engineer writing the test derives the assertion, and a wrong one fails
  loudly.
- **Step-by-step implementation sequences** for ordinary code. Ordered steps
  for a *migration* are a different thing and stay.

**Keep at full depth** — the four things no downstream check can catch:

1. **Data model and migration shape.** Often irreversible.
2. **Security and privilege boundaries.** The wrong version is
   indistinguishable from the right one at runtime.
3. **Sequencing and dependencies between separate plans or PRs.** Structurally
   invisible to any reviewer looking at one diff.
4. **Product semantics.** Whether this is the right behaviour at all.

**The trap to avoid: the plan is the reviewer's oracle for the *code*.** A
David-approved plan's intent and invariants are pasted into the implementation
PR so the reviewer can catch a build that quietly narrowed scope. A vaguer plan
makes that unfalsifiable. So the plan stays **precise about intent and
invariants** while becoming **less detailed about implementation** — different
axes. Length is not precision: #421 ran to 1212 lines and still contradicted
itself about which sibling shipped first.

**And "the plan is the oracle" is only true of the sections the PR actually
pastes.** `.github/pull_request_template.md` carries **Direction, Product
Intent, Must Not Change, Settled Decisions** — nothing else, and
[`code-review.md`](../engineering/code-review.md#the-review-oracle-the-pr-body)
points the reviewer at those fields rather than the whole plan. An invariant
that this rule keeps at full depth but leaves sitting in a *Data Model*,
*Security* or *Runtime Behavior* section is therefore **not in the oracle at
all**, and an implementation can violate it invisibly — the precise failure
the oracle exists to prevent.

So a plan owes one of two things for every load-bearing invariant: **state it
in one of the four pasted sections**, or **paste it into the PR's oracle block
explicitly alongside them**. *Must Not Change* is usually the natural home —
an invariant worth protecting is, by definition, something that must not
change. This was found by Codex reviewing this very rule, which is a fair
demonstration of the rule's own point: no compiler or test could have caught a
plan-review policy that quietly excluded half its own subject matter.

**Say this in the review request.** A reviewer asked for "a lens not yet
applied" will go find anything. Tell it plainly: *do not report what the
compiler or the test suite would catch — report what survives into production
invisibly.* That one sentence is most of the win, and it costs nothing.

**The same line decides how many rounds to spend, not just what to write
(David, 2026-08-13).** Once a plan's *design claims* are settled, remaining
findings are mechanics — and mechanics are what implementation verifies best
and cheapest:

- **Design claims must be settled in the plan.** What is a boundary versus a
  convention, what depends on what, which invariant holds in which state.
  Code review structurally cannot catch a wrong design that has been
  faithfully implemented, so these are worth as many rounds as they take.
- **Mechanics can ride to implementation.** Which PostgreSQL function raises
  on which argument, whether a fixture setup still passes, whether a count
  assertion is coherent. These announce themselves the moment code runs, with
  a stack trace and a line number, which is more than any review round
  produces.

**So a plan loop's real exit condition is "the design claims are right," not
"the reviewer stopped finding things."** PR #422 reached that point at round 2,
when the false claim at the centre of the plan — that triggers enforce
anything before an ownership transfer the owner can undo — was found and
corrected. Everything the round found after that was PostgreSQL mechanics,
bought at review-round prices. The residual risk is covered three ways
regardless: the plan mandates its own negative tests, Codex reviews the
implementation diff against the plan as oracle, and crash-class defects
surface on first run.

### Review loops need a stopping rule, not just a convergence target

A review loop's exit condition cannot be "keep going until the reviewer stops
finding things." An adversarial reviewer on a sufficiently detailed artifact
will keep finding things, and each fix adds surface for the next round.

**The apparatus that used to sit here — a criticality gate, a finding-count
trend, a plan-growth tripwire and an oscillation diagnosis, all self-policed by
the agent driving the loop — was deleted on 2026-08-20.** Its measured record
was 0-for-15 at stopping a loop, on product and meta loops alike. What replaces
it, on internal tooling, is **the two-review limit below** — the one rule here
that bounds the *sequence*. Around it sit three that bound something else and
are not stops: the write-gate rule below (which heads must be reviewed),
pre-registered flip conditions (a bound within a round) and, since #96, a
judgement made from two independent assessments rather than alone (what is
written for). This paragraph listed only those three until 2026-09-20, which
is how a section headed *what stops a loop* came to answer with three rules
that do not stop one. (An external adjudicator whose verdict decided stood here
until the #89 cut removed it; nothing dispatched now decides anything.)

#### The write-gate rule: code written is code reviewed (David, 2026-08-22)

**Every tier.** The judgement happens *before* code is written, not after it is
pushed:

1. A round returns findings.
2. The judgement is made per finding: on a code loop from two independent
   assessments and the builder's own reading of them. (A planning loop is not
   a review loop and this write gate does not govern it — see *Who judges*
   below.)
3. **Anything written** → the fixes are pushed, and another review round is
   *automatic and mandatory*. Back to 1.
4. **Nothing written** → the loop ends there, on a head the last round already
   reviewed.

Two invariants follow, and they are the reason for the shape: **no commit
ever merges unreviewed**, and **a loop always terminates on a reviewed
head**, because a stop precedes the existence of any new commit. The exit
ramp from eternal looping is the judgement that nothing more is worth
writing — never anyone skipping the review of something written.

This supersedes the 2026-08-21 internal tier's ending, which deliberately
stopped with the last fixes unreviewed and carried machinery to make that
mergeable. All of it is deleted rather than repaired: it existed to make an
unreviewed head safe, and an unreviewed head is now never mergeable. The
older "fix-round merge path" workarounds (David posting the trigger himself, <!-- retired-ok -->
recutting the PR) stay retired for the same reason.

**The cost, measured rather than assumed.** This paragraph used to say that
fixing even a typo costs a full round, and that the only question left was
whether acting on a finding was worthwhile — answered by
[`review-judgment.md`](review-judgment.md), which is still the only statement of
that test and still sets no target rate in either direction. The per-finding
question stands. What was missing is the one below it: **a system of
per-finding filters has no opinion about the length of the sequence it
produces**, and the sequence is what David pays for.

Measured across every review loop the shared-judgement design has run (2026-09-19,
five pull requests, 31 rounds, 112 findings): **48 of the 84 findings from round
two onward — 57% — landed on lines a fix from an earlier round in the same loop
had just changed**, and 67% were written for, so each fix round produced the
next. Codex alone took 6.5 to 11.4 minutes on every round that returned
findings. #120 ran eight rounds over 22 hours; #124 ran fifteen over 19.
**Script and prose findings behaved identically** (57% and 58% on an earlier
fix), so the shape is a property of the loop, not of the artifact.

#### The two-review limit on autonomous iteration (David, 2026-09-19)

**For internal tooling, autonomous iteration is bounded at two reviews.** Not a
round budget — a limit on how long the builder may keep *editing* without
David. The sequence:

1. **Review the head.** Meets the agreed requirements → ship it.
2. **If corrections are warranted, make ONE coherent batch** — every finding
   worth acting on, together, with targeted verification of the failure classes
   involved rather than of the reviewer's examples.
3. **Review the corrected head.** Acceptable imperfections become recorded
   gaps; worthwhile deferred work becomes an issue.
4. **Autonomous iteration ends there.**

**A cap on further EDITING is not an exemption from REVIEWING what was edited**
(Astra, 2026-09-19, and this is the sentence the whole rule turns on). Step 3
is not optional and there is no second batch of fixes merged behind it. Both of
the write-gate's invariants survive intact: no commit merges unreviewed, and
the loop ends on a reviewed head.

**What ending iteration does NOT mean is "merge regardless."** If the corrected
head still violates an agreed requirement, a required check fails, or a finding
establishes consequential harm David has not accepted, **it does not merge —
it goes to David with the concrete shortfall and a choice**: continue, cut the
scope, or stop the work. Ending the loop and declaring the work ready are two
different things, and conflating them is how a cap turns into a hole.

**The builder cannot award itself a third review.** That is the operational
difference between this and the round budget the #89 cut deleted: "another
correction seems worthwhile" is exactly the reasoning the limit exists to
refuse. A third review requires David reopening the work deliberately.

**Two is an explicit operating trade-off, not a measured optimum.** The
retrospective establishes that the sequence is too long and too self-referential;
it does not establish that two is the right number. It buys independent
inspection of the implementation and of its first corrections, which is the
least that is worth having.

**Scope it by consequence and recoverability**, with "internal tooling" as the
convenient default rather than a universal exemption. Machinery that governs
approvals, publication, credentials or destructive operations is weighed on
both whatever directory it lives in: a change whose effect on what it
approves, publishes, grants or destroys could not be trivially undone is
outside the limit, and one that could — a printed message, a formatting change
to what gets published — is not. Product code is outside because the limit
bounds internal tooling, not because of that weighing. And **"this changes how
future agents work" does not by itself disqualify anything here** — reach is
not consequence, or every line in this repository would be exempt from every
limit.

**The failure signal, named in advance:** if this boundary routinely produces
requests to reopen, it has not relieved the problem. The answer then is smaller
increments or simpler machinery — never another layer of exceptions on top of
the limit.

**What capping costs, concretely, because it is not free.** At #124's round-two
head the concern ledger accepted an entry carrying no original reasoning and
rendered an empty box where the argument should have been; it was found at
round 7. At that same head, the private-plan ignore file did not ship to
consumers, so a plan could sit unignored and an intervening `git add -A` could
publish it. Both are real defects that a two-review limit would not have
surfaced inside that loop. Neither is an argument against the limit — the
second is an argument for step 4's *shortfall* branch, which is what a
disclosure failure is — but the trade is real and is recorded here rather than
discovered later. (Astra reproduced both against the historical code,
2026-09-19.)

#### There is no budget any more (#89 cut, 2026-09-16)

**Who judges.** On a **code** loop (#96, David 2026-09-17) **Astra and a Fable
assessor advise independently and the builder decides from both**, investigating
disputed facts itself; a purely technical disagreement that survives is the
Fable assessor's to settle, and intended behaviour or an accepted user-facing
shortfall is David's. Neither assessment binds, and neither substitutes for his
answer.

On a **planning** loop (David, 2026-09-18) there is no triage to perform,
because there are no tiers to triage into: Astra and the builder are peers
reading one contract, Astra returns Markdown, and **the builder states the next
action explicitly** rather than deriving it from an assessment. A purely
technical disagreement that survives investigation and discussion is the
builder's to settle, with the reasoning recorded where it stays readable. The
plan reaches David for approval, which nothing else substitutes for. Until that
date the reviewer performed a required/recommended split in a schema field and
the loop stopped on it; that verdict-driven design is what the redesign
replaced.

**What went, and what nothing replaced.** A declared per-PR round budget, its
committed receipts, extension grants and their arithmetic, a round-count
cache, a merge-readiness receipt, a translation-delivery gate, and the
adjudicator that ruled from round 3. Measured across PR #91's ten rounds, not
one of them changed a decision. What each *finding* is worth stays a
judgement; what the *sequence* may cost is now a count, and on work the two-review
limit bounds, it is that count. This paragraph read "termination is a judgement rather than a
count, and a loop that can conclude on the evidence needs no counter" — true of
what the #89 cut removed, and false as a description of how a loop ends now. The
thing budgets were compensating for was a builder writing code for every finding
because the decline was a paragraph it had to compose; the limit compensates for
something else, a sequence of individually-defensible fixes nothing was
counting.

**The tiers survive, and since 2026-09-17 they name what is downstream rather
than how strictly to read a finding.** `product`, `sensitive`
(auth/payments/migrations) and `internal` (guards, `scripts/`, skills, agent
contracts, process documentation, documentation harvests) each say who or what
bears the consequence, and nothing more — whether a change is internal *for
the two-review limit* is asked of that change, not read off this list
([above](#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)). They set no threshold and select no
rubric — that sentence said both things at once until round 4 of #120 caught
it. The `internal` tier's old rubric
wrote only for "a very high chance of a critical flaw" and declined everything
else; that is a decline quota and it is retired with the fix quota it was built
to correct. What the tier still supplies is the thing no rule can derive: with
no money or data downstream, an internal consequence is weighed by its effect
on David's ability to direct agents and understand results, recurring
reversible disruption included.

What the 2026-08-20 decision got right survives in that weighting, not in
refusing review: every runaway loop this repo measured was internal tooling
reviewed at product rigor (PR #488 ran 22 rounds on a ~10-line guard change;
then #503, #526, #531, #534, #539, and #91's ten), so the strictness lives in
the write decision, sized to a class of artifact whose failure mode is
wrongly-blocking and whose real protection is GitHub's server-side rulesets.
Engagement is a proportionate reply, never a form that makes declining harder
to write than fixing. How long engagement *runs* is the two-review limit's, not
this paragraph's — it used to open "engagement stays one pass", which is a
round budget in a sentence about strictness.

**Codex review of product code is unaffected and is not negotiable.** It is
the safety net a non-code-reading product manager depends on.

#### What still bounds a loop

- **A clean automatic pass on PR-open is the whole ceremony** for an internal
  PR. Finding nothing, it needs no judge: nothing was written, so the head is
  already reviewed.
- **Never a second review of an unchanged head; always a review of a changed
  one.** The rule here used to read "no re-request without a behavioural
  change", which contradicts the write-gate it sits under: a documentation pull
  request whose review yields one worthwhile factual correction could then never
  be reviewed and never merge, or had to acquire an unnecessary change to buy
  the round. Measured: #125's two-sentence fix waited a week under exactly that
  reading. **Any changed head gets review before merge** — documentation-only
  changes and base-branch merges included. What is refused is a round requested
  merely to get a different answer on a head already reviewed as it stands.
  (Astra, 2026-09-19.)
- **The two-review limit bounds how long iteration runs**, above. These bound
  what a single round is for.
- **Every review request carries pre-registered flip conditions** — what
  finding, what count, what change of shape would end the loop, written before
  the round runs, **each naming an observable read off the round rather than a
  judgement made in the moment**. **Within a round** it is the device with a
  working record (6-for-6), and it works because a condition written in
  advance collides with an event instead of waiting to be recalled. It was the
  only one until the two-review limit, which bounds the sequence instead.
- **A product decision goes to David immediately**, at any round, and is never
  ground through mechanically.

### Findings are triaged against the artifact's real risk

Codex labels findings "Required Revision" — that is its job, and it is
correct to. **Accepting that framing wholesale is not.** Every finding gets
one of three responses, stated explicitly:

1. **Fix it** — the defect matters for this artifact.
2. **Accept and document it** — the finding is correct, and the cost of fixing
   exceeds the risk *for this artifact*. Say so, in the thread and in the file.
3. **Escalate it** — it changes intended behaviour or accepts a user-facing
   shortfall. That's David's. A purely technical fork is not, and is settled in
   the loop.

Response 2 is legitimate, and nothing here sets a rate for it in either
direction — the Worth rule decides per finding
([`review-judgment.md`](review-judgment.md)). Specifying compare-and-swap semantics
for a GitHub label write, in a solo-operator repo, because a reviewer correctly
noted a race, is response 1 applied where response 2 was right.

### A finding names an instance; the fix owes the class (David, 2026-08-08)

Reviewers cite specific lines. Treating the cited lines as the scope of the
fix is how loops grind: the artifact contains sibling instances the reviewer
didn't enumerate, the next round finds them, and the loop burns a round per
sibling. The origin case is PR #366: round 1 flagged "render credits
described as deployed behavior" at the cited spots; the fix addressed
exactly those spots; round 2 was three more `credit` references that a
single `grep -n credit` would have caught in round 1 — plus a referenced
doc path that didn't exist, which `ls` would have caught the same way. The
same day produced a third instance of the shape (a CLAUDE.md rule naming
one model tier where the real gate was "any non-default tier" — swept with
a grep only after David caught it). Three in one day, same failure: the
intelligence to fix each instance was present; the forced step from *this
instance* to *every instance of this type* was not.

So: **a finding is fixed when its class is empty, not when its cited
instances are.** For every finding, whichever agent is driving the fixes:

1. **Name the class** — restate the finding as a pattern ("the doc asserts
   credits exist as deployed behavior — anywhere"), not a location. The
   class statement goes in the thread reply, where a mis-diagnosis is
   visible and contestable instead of implicit.
2. **Write a mechanical oracle for the class** — the `grep`/`ls`/`find`/
   one-liner that detects *every* instance, not just the cited ones. If the
   finding genuinely cannot be mechanized (a pure design/semantics finding),
   the reply says so — that inability is itself a signal, and it routes the
   finding to the driving agent's judgment-escalation triggers.
3. **Sweep the full scope before fixing, fix every hit, re-run the oracle
   to zero.** Scope defaults to the whole artifact/diff and widens to the
   repo when the class plausibly lives outside it. The reply cites the
   oracle and its post-fix result — a skipped sweep is then visible as a
   missing line in a public reply.
4. **Before each round's push, re-run every prior round's oracle.** A
   round-3 edit must not silently reintroduce a round-1 class; this re-run
   is what makes "re-fixing the same thing round after round" structurally
   impossible rather than merely discouraged.
5. **A recurrence of a swept class in a later round is a process failure by
   definition** — the class was misnamed or the sweep skipped. It is the
   "repairing an earlier round's fix" causal flag made mechanically
   detectable: it gets flagged as such in that round's record, and the
   re-naming of the class escalates to a stronger model rather than being
   retried at the tier that misnamed it.

When instance = class — a genuinely one-off defect with no plausible
siblings — saying so in the reply *is* the sweep. The obligation is making
the generalization step explicit every time, not grepping ritualistically.
A class that outlives its PR (a repo-wide, durable pattern) is a CI-guard
candidate at loop close, per the standing recurring-failure-patterns rule.

### The scope-of-work gate (David, 2026-08-15)

Before any plan-review loop opens, the pre-plan conversation's outcome is
compressed into a **scope of work David explicitly agrees to**: the direction
served, product intent for this increment, must-not-change, settled
decisions, the explicit scope boundaries (what is already decided to be
*next* or *never*), and the artifact's ceremony tier. (A 1–100 criticality
rating was agreed here too, for the gate deleted on 2026-08-20; the tier
carries what it was for.)
**That agreement is the loop's authority to run autonomously to
convergence** — it replaces the retired per-round check-in (below) as
David's control point at the front of the loop, paired with explicit plan
approval at the back. **The agreed scope of work is also the review oracle
itself** — it is handed to the reviewer verbatim, every round, as the thing the
plan is checked against. The corollary is the escalation rule: anything that
would *change* the agreed scope of work — a mid-loop scope addition, a split, a
change to intended behaviour, or a user-facing shortfall being knowingly
accepted — is outside the loop's authority and goes to David, however the loop
is otherwise pacing itself. (Claude's enactment of the gate's mechanics lives in
the `plan-review-loop` skill.)

**A purely technical design fork is not one of them** (2026-09-18). Two
approaches serving the same agreed behaviour, scope and explicit constraints are
the loop's to settle — through investigation and discussion, and if the
disagreement survives both, by the builder, with the reasoning recorded. This
list used to name "a product/design fork", which a technical fork also satisfies,
so an agent could read the escalation rule as negating the tie-break the same
redesign grants and send David a question the loop was built to keep off his
desk. **What does not become negotiable is a constraint David required
explicitly**: a requirement does not stop being his because it happens to be
about technology. (The code review loop's own escalation list, under *The
post-round judgement* below, carried the same "product or design fork" wording
until 2026-09-20 and is now narrowed the same way. This parenthesis used to
call it "correct as written", which is how the defect survived a round that
was looking straight at it — vouching for a sentence is not reading it. **It is not that the code loop lacks a technical tie-break** — *Who
judges* above gives a surviving purely technical disagreement to the Fable
assessor there, and `claude-core.md` rule 4 says so on `main`. This parenthesis
claimed the opposite for one round, which is this very paragraph's warning
happening to the paragraph itself: added at #124 round 7 to stop an escalation
rule negating the planning tie-break, it negated the code loop's in the same
breath. Corrected at round 9 `4049773956`.)

**The scope gate now carries a second opinion (David, 2026-09-09).** Before the
plan is written, the reviewer is given the oracle alone and asked whether the
thing should exist and whether the boundary is in the right place. David sees
its answer beside the driving agent's before he says go. It is the cheapest
place in the system to catch "we are about to build the wrong thing", and it
costs one round against a document a page long.

### The post-round judgement

Every substantive round pauses before any fix is implemented: triage first
(nature, affected area, disposition, and whether the finding sits in code an
earlier fix in this loop already changed), then the judgement is made per
finding — on a code loop from two independent assessments the builder weighs but
did not write. (A planning loop has no round to judge in this sense; *Who
judges* above says what happens there instead.) The agent driving a code loop
does not make that call alone:
self-policing is precisely what the 0-for-15 record measured, and
eleven-for-eleven on #91 measured it again after the worth rule was written.

What still stops the loop for David, whatever the assessors say: a genuine
product or behaviour fork, a scope addition, a split, a disclosure question,
and any change to intended behaviour or knowingly accepted user-facing
shortfall. **A purely technical design fork is not among them** — it is
settled in the loop, with the Fable assessor holding the tie-break on a code
round. This list read "a product or design fork" until 2026-09-20, which a
technical fork also satisfies: the same defect, and the same sentence, that
the paragraph fifty lines above had already diagnosed and fixed in the
planning list.

A round with **no findings** needs no dispatch: there is nothing to assess,
and the loop ends on the head that round reviewed.

**A round that did return findings is dispatched, whatever those findings look
like** (David, 2026-09-18). The exemption here used to extend to a round "whose
findings are all reasoned declines, so nothing gets written", which was
coherent while a dispatch produced a binding verdict — a round that wrote
nothing needed no verdict. Under two advisory assessments it is circular: a
reasoned decline is what the assessments *produce*, so reading one's own guess
that the findings will all be declined as grounds for skipping the assessments
ends the round on the builder's judgement alone. That is the exact behaviour
the shared judgement replaces. Note one status line either way, so the
discipline stays visible.

**Trivial nits do not skip the judgement** (David, 2026-08-22, the write-gate
rule). Writing for them is exactly the decision it exists to make: under this
rule a typo fix costs a full mandatory review round, so "it's only a nit" is
precisely the trade the loop must not settle for itself — in either direction,
since the same arithmetic that forbids skipping the judgement is what makes an
unworthy fix expensive.

**Scope: every code-review loop** — feature and bugfix, whichever agent is
driving it. A planning loop is not a review loop and is judged under *Who
judges* above; it takes the tier of what it is planning, because a wrong plan
for product code becomes wrong code. The tier names what is downstream; it is
neither a threshold nor a number of rounds.

**Plan approval is David's alone**, whatever a code loop does.


## Bugfix mode (routed or declared, one bug per PR, tiered by what the fix touches)

A focused fix-and-ship loop for a bug — restoring behavior that was already
agreed, not deciding new behavior. Entry is routed or declared, always
visible (see *How each agent enters/exits a mode* below).

**What bugfix mode saves is the planning ceremony, not the verification.** It
drops the plan file, the pre-plan conversation, and the multi-round plan-review
loop — the genuinely expensive parts, and the ones that mitigate a risk a fix
rarely carries ("we chose the wrong approach before any code existed"). It does
**not** license thin verification: a small-looking fix can still have wide
consequences, and several entries in this repo's own
[`known-failure-patterns.md`](./known-failure-patterns.md) are defects whose
shipped tests passed and which were caught only in code review.

### One bug, one branch, one PR (David, 2026-07-26)

**Bugfix mode does not batch.** Each bug gets its own branch off current
`origin/main`, its own commit, and its own PR, opened as soon as the fix is
verified — no waiting for a "create the PR" signal, no accumulating several bugs
on one branch.

Batching was costing more than it saved: it kept several half-verified fixes in
flight at once, and it meant no reviewer saw *any* fix until the whole batch
landed — so a wrong fix early got built on top of repeatedly and reviewed zero
times. One bug per PR means every fix is reviewed in isolation, immediately, and
against a diff that contains nothing else.

The measured worst case is **PR #334** — nominally a bugfix, actually eleven
leftover review findings batched into one PR: **21 rounds, 69 findings, 72%
self-inflicted (38 propagation + 12 wrong-fix), and no breaker fired.** That
is what batching produces, now with a number on it — and why a
"clean up the review findings" batch is named in *When NOT to use bugfix
mode* below: leftover findings from earlier PRs are N separate defects, each
owed its own classification and its own PR.

Use a **topic** slug, not a date (`…/bugfix-annual-plan-lookup`, not
`…/bugfix-jul26`) — with one bug per branch, a date collides the moment two bugs
land the same day. Create non-resettingly (fail rather than wipe existing work),
pick a disambiguated name on a clash, and **never** force/reset onto
`origin/main` to resolve one.

> **Exception — a preselected/assigned branch wins, but only while unclaimed.**
> If you were already invoked on a designated task branch (a preselected branch, a
> Codex cloud run, an assigned working branch, or a runner that disallows branch
> creation) and it has **no bug on it yet**, **stay on it** — do not create a
> fresh branch. The moment that branch carries a prior bug's pushed fix (its PR is
> open or merged), it is claimed the same as any other branch, and this exception
> no longer covers it — the next bug needs an unclaimed branch, per the fresh-branch
> step above. If the environment also disallows creating one (a runner that
> assigns exactly one branch), don't put the second bug on the first bug's
> branch to route around that — stop and ask David for a new assigned branch.

> **Dependent bugs are never stacked (David, 2026-08-20).** If a new bug's fix
> depends on an earlier fix whose PR is still open, **wait for the parent to
> merge** and branch from fresh `origin/main` as normal. Under the current
> close-out a ready PR merges within the hour, so the wait is short; and if the
> two fixes genuinely cannot be separated, they are one bug and ship in one PR.
> Stacking was retired because it bought little and cost a standing retarget
> obligation before every parent merge — this repo auto-deletes a branch when
> its PR merges, with no reliable window afterward, so a missed retarget
> orphaned the child.

### Disclosure check, before the workstream issue opens

Bugfix mode drops the plan and the plan-review loop, but not the
disclosure check that gates a public workstream issue — the same one
applies here, for the same reason: this repo is public, and a bug report
can itself contain the same categories of sensitive content a plan can.
Before opening a workstream issue for the bug, run
[`workstream-tracking.md`](./workstream-tracking.md)'s disclosure check —
its canonical definition. If it fails, the bug does **not** get a public
issue — it gets a private draft Project item instead, and the agent says
so plainly rather than silently using the fast path a sensitive bug
doesn't get. This applies to every agent entering bugfix mode, not just
Claude's enactment of it.

### The tier is chosen after diagnosis, never at intake

The old design picked its ceremony level at intake, from the **symptom**. That is
the wrong moment with the wrong information: every risk that matters is a property
of the **fix** — what it touches, how many callers share it, whether it crosses
persisted state — and none of that is knowable until the cause is found.
"Simple-seeming" describes a bug report; it never described a blast radius.

So: **diagnose first, then classify, then fix.** **Check Tier C first** (below)
— **any** of its triggers (a behavior/product change; any *database* schema,
migration, or backfill work — not generated API-validation schemas, which are
a Q1 trigger, not this one; a design flaw rather than a defect; needing a new
abstraction; needing an external vendor) is Tier C regardless of whether the
change also trips a Q1/Q2 item; those triggers only decide Tier A vs. Tier B
*within* work that's already confirmed to be a bug fix, not before. Once Tier
C is ruled out on **all** of its grounds, run the checklist below. **If any
item trips, it is
Tier B.** With this list, Tier A is the exception — that is intended, not a
mis-calibration.

**Q1 — Where does the fix land?** Any of these subsystems → **Tier B**:
payments / auth / permissions / security headers; the async job queue, worker
lanes, or any enqueue helper; **generated API-validation schemas** (the codegen
allowlist trap — these are distinct from Tier C's *database* schema trigger
below; a fix confined to them is Q1 Tier B, not Tier C); **any subsystem this
repo's overlay marks sensitive** — a product's own rendering pipeline, its
source-of-truth layers, its domain engines; the overlay is where those are
named, because only that repo knows them; dev-infra and
build tooling (Vite/esbuild config, the dev supervisor, retry/reload paths, CI
workflows).

**Q2 — What shape is the fix?** Any of these → **Tier B**:

1. **Shared, not a leaf.** The edit lands in an exported symbol or a function with
   more than one caller — so its blast radius is every caller, not this one site.
2. **A predicate, default, or heuristic.** It changes *when* or *whether*
   something happens — a condition, a skip check, a fallback, a dedupe key — not
   just what value comes out. (See *Uniform default over a falsely-ambiguous
   space*, *Cost-skip heuristic*, *Dedupe key coalesces two distinct intents*.)
3. **Concurrency, ordering, retry, or async state.** Enqueue paths, job state
   transitions, races, retries, or anything whose correctness depends on two
   reads seeing the same state. This is the single densest cluster of real
   defects in this repo, and each took multiple review rounds to converge.
4. **Persisted or derived data.** It changes what gets written, the shape it's
   written in, or how a stored/derived value is read back — even with no
   migration.
5. **Generalized past the report.** You concluded the *mechanism* was wrong and
   widened the fix beyond the reported instance. Correct instinct (see
   *One-example bug fixes*) and a real risk in the same breath (see *Regex
   grammar rewrite reaches past a safe anchor*).
6. **Shaky diagnosis.** No deterministic reproduction, more than one plausible
   root cause, or this symptom has been "fixed" before. Uncertainty at diagnosis
   is the strongest single predictor that the fix is a guess. ("Fixed before"
   is knowable, not a memory test — the loop's step 1 history check is where
   it's answered.)
7. **The path had no pre-existing tests at all.** Not "this exact regression
   scenario wasn't covered" — by definition almost no escaped bug's precise
   scenario was covered, so that reading would send nearly every real fix to
   Tier B and makes the trigger meaningless. The observable boundary: before
   this fix, did the touched function/module have **any** test file
   exercising it, in any scenario? Zero prior coverage of the path itself
   (you're originating a suite, not extending one) fires this trigger; adding
   a missed case to an already-tested path does not.

### Tier A — contained fix

Fix + regression test + one commit + PR, with the bugfix oracle and blast-radius
note below. Verification lives in the PR body ("how to verify" steps), which is
the miniature UAT. No separate docs.

### Tier B — elevated fix

Everything in Tier A, plus:

- **A real UAT doc** (`docs/tests/UAT/PR<N>_<FEATURE>_UAT.md`) — the click-through
  acceptance script, so David's product-verification net is restored for exactly
  the fixes that can reach past the reported symptom.
- **A Post-merge verification section in the PR body only when the fix
  genuinely needs one** — i.e. when something can only be verified in
  Replit's environment (live DB state, live config/data). Per
  [`../tests/test-run-contract.md`](../tests/test-run-contract.md), it is
  not a default; most bug fixes need none ("none needed" is the correct
  content), and a check that re-verifies what CI already gates is waste.
  The driving agent executes the section through the Replit connector at
  close-out (the standalone TEST_RUN file is retired, 2026-08-15).
- **The strongest model tier available** for the fix itself.

**Internal/infra-only exception on the UAT doc.** The test is **whether the
fix has any product-visible behavior at all — not which Q1/Q2 trigger(s)
fired.** A CI-workflow or dev-supervisor fix routinely trips a Q2 shape
trigger too (a retry predicate, a dedupe condition) without gaining any
in-app surface, so gating the exception on "the only trigger was Q1" would
disqualify exactly the fixes it's meant to cover. If nothing about the fix is
product-visible, ship a written verification note in the PR body instead of
a click-through UAT doc, regardless of how many or which triggers fired —
the same ship-the-UI-surface exception feature mode already grants pure
infra/refactor changes (see
[`../tests/TESTING.md`](../tests/TESTING.md) and
CLAUDE.md). A click-through script for a fix with no in-app surface to click
through is manufactured ceremony, not verification. The moment the fix also
touches anything product-visible — even indirectly, e.g. a codegen change
that alters generated API types the frontend consumes — the full UAT
applies.

### Tier C — this is not a bug fix; leave bugfix mode

Stop and tell David. Any of: the "fix" is a behavior change or a product
decision; diagnosis revealed a design flaw rather than a defect; or the fix
would need a new abstraction or an external vendor — these go to **feature
mode** (plan + David's approval).

**A *database* schema change, migration, or backfill is Tier C without
exception** — there is no size or scope of database schema change that stays
on bugfix mode's fast path. **"Schema" here means the persisted database
schema** (migrations, table structure) — not **generated API-validation
schemas**, which are Q1's own explicit Tier B trigger (the codegen allowlist
trap); a fix confined to
those stays Q1/Q2-governed, not Tier C, unless it *also* changes the database
schema, which puts it here on that separate basis. It always runs
[`../engineering/migrations-and-backfills.md`](../engineering/migrations-and-backfills.md)'s
ceremony (idempotency, observable counts, human-override preservation,
rollback for destructive ops). Whether it *also* needs a full approved plan
first is decided by **AGENTS.md's repo-wide planning standard** — non-trivial
implementation work requires a plan via
[`.agents/PLANS.md`](../../.agents/PLANS.md) with David's explicit approval
before anything runs — **not** by product-visibility; a schema/data change
with zero product surface can still be structurally complex, hard to
reverse, and exactly what that standard exists to gate. So: a genuinely
**trivial**, well-scoped schema fix (`PLANS.md`'s own carve-out — e.g. a
single `ADD COLUMN IF NOT EXISTS` with no data transformation and no
behavior change) can run migration ceremony directly, on David's explicit
go-ahead; anything **non-trivial** — multiple steps, a data transformation,
any risk of irreversibility, anything you're not confident is simple — gets
a full plan and approval first, regardless of whether it has product
consequences. If genuinely unsure which side of trivial/non-trivial it's on,
treat it as non-trivial and ask rather than guess.

A trivial Tier C fix still has a bug behind it, so its PR body isn't "n/a — no
plan" either — the [PR template](../../.github/pull_request_template.md) has a
dedicated Tier C block (tier, symptom, root cause, why it's trivial, David's
go-ahead, the migration-ceremony checklist) distinct from both the feature-mode
oracle and the Tier A/B bugfix oracle below.

### Per bug — the loop

1. **Reproduce and find the root cause.** Name the mechanism, not the
   instance. **Check the history first**:
   [`known-failure-patterns.md`](./known-failure-patterns.md) and a quick
   search of merged PRs for the symptom — a match can shortcut the
   diagnosis, and this check is also what makes Q2's "fixed before"
   trigger knowable rather than a memory test.

   **Some root causes are not in the repo, and that evidence belongs to this
   step.** When the diagnosis turns on what the running system actually
   *contains* rather than what the code does — which inputs actually trigger
   it, what live data or config actually looks like, what the server actually
   logged — gathering that is part of step 1, not something to do after
   classifying. Both the tier and the blast radius are downstream of those
   answers, so classifying first means classifying on a guess and re-tiering
   when the evidence lands. **What each agent can reach differs** — Replit
   reads the live environment directly, and Claude Code's enactment (which
   source answers which question, and how to drive the connector so the answer
   is evidence rather than an agent's account of itself) is
   [`live-diagnosis.md`](../../.claude/skills/bugfix/live-diagnosis.md) — but
   the ordering is the same for everyone: if the classification depends on
   live state, establish the live state first.
2. **Classify** against the checklist above. State the tier and the reason.
3. **Write the regression test first** — a test that **fails on current code
   because of this bug**. This is the difference between fixing a bug once and
   fixing it forever, and it must prove the **general invariant** with negative
   cases, not just the reported input (see *One-example bug fixes*).
4. **Make the smallest correct fix** and confirm the new test passes.
5. **Establish the blast radius — oracle-backed, not recalled.** What else
   calls this code, shares this path, or depends on this behavior? This is
   the affected-surface inventory (above) at bug scale: name the pattern
   (the function, the table, the shape of derivation the bug lives in), write
   the tracked-set/callers-search that finds every site matching it, and state
   what it found — not a memory of "what calls this." Regression tests pin
   the fixed behavior; they say nothing about the neighbors, which is exactly
   where a small-looking fix does its damage, and "I checked the obvious
   callers" is exactly the gap a mechanical search closes for free.
6. **Verify — scoped by step 5, not by the diff (David, 2026-08-09).** The
   touched tests + typecheck (see
   [`../tests/TESTING.md`](../tests/TESTING.md)), **plus the
   test suites of the neighbors the blast radius named** — the callers and
   shared-path dependents step 5 identified. A fix that breaks a neighbor
   is the exact failure the bugfix oracle warns about, and step 5's output
   is the checklist for detecting it; establishing a blast radius and then
   not running its tests checks the diff against itself. A fix that breaks
   the build doesn't get committed.
7. **One focused commit** — fix + its regression test together, message naming the
   bug and the fix.
8. **Open the PR** with the applicable oracle — the Tier A/B oracle below for a
   Tier A/B fix, or the dedicated Tier C block described above for a trivial
   schema fix — and engage the review under the write-gate rule.
9. **At close, harvest what generalizes (David, 2026-08-09).** A root cause
   that reaches past this one bug is captured before the workstream closes:
   a [`known-failure-patterns.md`](./known-failure-patterns.md) entry, a
   CI-guard candidate (the standing recurring-failure-patterns rule), or a
   one-line `/document` nudge to David. Tier A fixes especially — with no
   plan and no UAT doc, the merge is the only moment their learning exists
   anywhere but the diff.

> **Narrow carve-out on step 3:** if a fix is genuinely untestable at reasonable
> cost (a pure visual/CSS tweak with no assertable behavior), the regression test
> may be skipped — but say so explicitly in the commit message and the PR body
> ("no regression test: <why>"), so the exception is always visible, never silent.
> "The test is annoying to write" does not qualify; a tokenizer, API, data, logic,
> or concurrency bug always gets its test.

### The bugfix oracle: what the PR body must carry

A diff can be internally sound and still be the wrong fix — it can make the
reported symptom disappear while breaking an adjacent behavior nobody wrote down.
Feature mode solves this by pasting the approved plan into the PR body as the
reviewer's oracle. **A bug fix has no plan, so it needs its own oracle** — and
"n/a — no plan" leaves the reviewer checking the diff against nothing but itself.

**This section covers the Tier A/B oracle.** A trivial Tier C schema fix uses a
different, dedicated block (symptom, root cause, why it's trivial, David's
go-ahead, the migration-ceremony checklist) — see *Tier C* below; it has none of
the fields in the table that follows.

The feature oracle's fields map onto a Tier A/B fix directly:

| Feature mode | Bugfix mode |
|---|---|
| Product intent | **Reported symptom** — David's report, quoted verbatim |
| *(implicit in the plan)* | **Intended correct behavior** — what right looks like |
| Must not change | **Must not change** — the adjacent behaviors sharing this path |
| Settled decisions | **Root cause** — the mechanism, in one or two lines |

Plus **Blast radius** (from step 5), and the fix tier — which is now two
things in two places. The **letter** is `fix_tier` in the body's declared
`plan-provenance` block ([`plan-provenance.md`](plan-provenance.md)); the
**reason** is `**Tier rationale:**`, a required prose field. The split is
deliberate: a letter is what a machine selects on, a reason is what a reviewer
argues with, and folding the second into the first is how the reason nearly
disappeared when the letter moved. It is **required for Tier A as much as Tier
B.** A is the classification reviewers most need to be able to challenge, so
"A (contained)" alone is not enough: name the Q1/Q2 items you checked and
ruled out, not just the ones that would have fired. A bare tier letter with no
reasoning is a mis-tiering risk whether or not the letter turns out to be
right.

This is cheap to write and it is what lets a reviewer ask the two questions that
matter most on a fix: *is this the root cause or a symptom-level patch?* and *did
this miss a caller?*

**What bugfix mode turns OFF:**
- No plan file, no pre-plan ceremony, no plan-review loop.
- No forced "ship a new UI surface" gate for a pure fix (include UI only if the fix
  genuinely needs it to be testable).
- No UAT doc and no post-merge verification checks on **Tier A**. On
  **Tier B**, a UAT ships only if the fix has product-visible behavior (a
  written verification note otherwise — see the internal/infra-only
  exception above), and the PR-body verification section gets real content
  only when something truly needs Replit's environment.

**What it KEEPS (non-negotiable):**
- **Pause-and-ask on real ambiguity.** If a "bug" is actually a behavior change in
  disguise, or the correct behavior is genuinely unclear, **stop and ask** — that's
  Tier C, not a fix.
- **Root cause over symptom**, and a regression test proving the general invariant.
- **Verify before committing.**
- **Source-of-truth discipline** (don't silently overwrite human decisions, don't
  create a duplicate source of truth) — see
  [`known-failure-patterns.md`](./known-failure-patterns.md).
- **Squash-merge / never-force-push discipline.**
- **Bot-review engagement under the write-gate rule** once a PR is open —
  including re-review of every fix round, since a push does not reliably re-trigger a
  reviewer and reactive fix code is where subtle mistakes hide. Code review is
  the highest-yield net this repo has: several entries in
  [`known-failure-patterns.md`](./known-failure-patterns.md) were caught by
  review *after* the shipped tests passed.

## How each agent enters / exits a mode

**The ceremony in force is always visible before code moves — announced or
declared, never silent.** (Changed 2026-08-09; this line previously read
"always David's explicit choice — never inferred." The invariant that
mattered was never the pre-declaration: it was that David always knows which
contract is in force and can veto it. The routed design preserves that via
the announcement, and the real misclassification guards — tier-after-
diagnosis, Tier C's exit, pause-and-ask — never depended on how the mode
was entered. Rationale in [`decisions.md`](./decisions.md).)

- **Claude Code** classifies each work request by its shape: clearly
  bugfix-shaped (already-agreed behavior is broken, observable symptom) →
  the bugfix workflow, entered with a **one-line announcement** that is
  David's veto surface; clearly feature-shaped ("let's build / add /
  change X") → feature mode, as that phrasing always has; genuinely
  ambiguous → one numbered question. `/bugfix` remains an **explicit
  override** that forces the light path. Classification is **per-request**
  — no sticky mode state, no exit phrases.
- **Codex** has no auto-triggering skill system, so the signal stays **in
  David's prompt**. David starts a request with, e.g., **"Bugfix mode:"**
  (lightweight fix) or **"Regular mode:"** / **"Feature mode:"** (full
  workflow, plan first). Codex reads *this doc* via `AGENTS.md` and applies
  the matching workflow. Absent an explicit signal, Codex is in **feature
  mode** (the default) and follows the plan-before-implementation rule; a
  declared mode governs its thread until David changes it.
  - *Optional:* if a given Codex setup supports custom prompt files (e.g. a
    `/bugfix` prompt), point that prompt at this doc — it doesn't change the
    contract, just the trigger.

**Misrouting protection is entry-independent:** however a request reached the
bugfix path — routed, `/bugfix`-forced, or prefix-declared — if it looks like
**building or changing product functionality** (a feature, a behavior
change), or diagnosis reveals **any *database* schema change, migration, or
backfill** (Tier C without exception, regardless of product consequence —
not generated API-validation schemas, which stay Q1 Tier B — see *Tier C*
above), **do not silently treat it as a fix** — **ask** whether it should
take the feature workflow, or (for a genuinely trivial database schema fix)
proceed straight to migration ceremony per Tier C. Guessing wrong is
expensive in both directions (skipping a plan a feature or a non-trivial
schema change needed, or piling ceremony onto a one-line fix), and the
confirm costs one question.

## When NOT to use bugfix mode

Features, behavior changes, **any *database* schema change, migration, or
backfill** (Tier C without exception — see above; not gated on product
consequence; not generated API-validation schemas, which stay Q1 Tier B), or
anything where David needs to verify intent — that's **feature mode**, or for a
trivial database schema fix, migration ceremony run directly per Tier C. Don't
use bugfix mode to sneak a feature through the lightweight path. **And a
"clean up the review findings" batch is not a bug fix (David, 2026-08-09):**
N leftover findings are N defects, and batching them recreates exactly what
one-bug-per-PR banned — PR #334 above is the measured cost. When unsure
which it is, **ask.**
