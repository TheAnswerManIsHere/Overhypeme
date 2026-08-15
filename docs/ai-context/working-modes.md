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
is the *database* schema — Drizzle/`lib/db`, migrations, table structure —
not the generated Zod API-validation schemas under `lib/api-zod`/
`lib/api-spec`, which have their own explicit Tier B routing; see *Tier C*
below.)

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

| Artifact class | Ceremony | Why |
| --- | --- | --- |
| **Transient, single-use process docs** — handoff docs, one-off run notes, legacy TEST_RUN checklists (the TEST_RUN file itself is retired as of 2026-08-15 — new PRs carry a *Post-merge verification* PR-body section reviewed with the diff, per [`test-run-contract.md`](../tests/test-run-contract.md); this row still governs the legacy files while they run out), anything deleted after one execution | **Write it, ship it, never loop on it.** Codex's automatic first pass happens (it reviews every PR); its findings get one triage and the loop ends there — no re-request. The cap ends the *loop*, never a fix: the one triage still fixes anything safety-relevant (see the next column). | Criticality ≈ 1 on a 1–100 scale (David, 2026-08-08) — **conditional on the TEST_RUN read-only contract** ([`test-run-contract.md`](../tests/test-run-contract.md)): these docs may not instruct suite re-runs or live-state mutations, which is exactly what keeps their worst case at "one confused run by one person, immediately self-catching." A finding that a doc *breaks* that contract — an instruction that could touch live state — is a glaring issue and gets fixed in the single triage. A P1 badge on anything else describes the finding's internal severity, not this artifact's blast radius. |
| **Loop-ledger records** — `.agents/metrics/loops/<pr>.json`, filed per *The loop ledger* below | **This cap covers only findings *on the ledger file itself*.** The record "rides any PR of mine except the one it measures" (see *The loop ledger* below), so it routinely shares a carrier PR with unrelated product-code changes — this row never governs those; they keep their own artifact class's ceremony (product code: review to convergence, as normal). For the ledger file: write it, one review pass, ship regardless of findings. The review *request* itself states the narrowed bar (mechanical-value-or-factual-claim only, scoped explicitly to the ledger JSON — see [`code-review.md`](../engineering/code-review.md#documentation-only-prs-get-a-light-review-david-2026-08-08)'s loop-ledger carve-out), so Codex is asked not to surface prose/wording findings on that file in the first place, and a carrier PR's review request says which files this bar applies to. Whatever the first pass returns *on the ledger file* gets one triage — fix anything that's actually a wrong stored number or a factually wrong claim about the loop; anything else (a defensible reading of an ambiguous rubric clause, imprecise phrasing around a correct label) is merged as written, no re-request. | Criticality ≈ 1 (David, 2026-08-11, after PR #406 — the record for PR #398 — ran three review rounds on a JSON file with no product surface: the causal numbers were correct every round, only the prose explaining them kept needing polish). This is a self-measurement about an already-closed, already-merged loop; looping review on it is the same ceremony-mismatch the *transient process docs* row above exists to prevent, just on a record that happens to be kept rather than deleted. If the author's own judgment says a finding reveals something genuinely missed (not just an alternate phrasing), fix it in that one triage or flag it to David directly — never loop Codex again to confirm. The scope-to-the-file-not-the-PR caveat was added the same day, after Codex's review of PR #407 (the PR introducing this row) correctly flagged that unscoped "ship regardless of findings" language would, read literally, excuse a carrier PR's product-code changes from review too. |
| **Agent-facing markdown** — skills, `docs/ai-context/`, `docs/engineering/`, contracts, prompts | **Write it, one review pass, ship.** No plan document, no convergence loop. | Self-catching: it's wrong the first time someone runs it, and a fix is one commit. Nothing is irreversible. |
| **Product code** | Today's full feature ceremony — plan, review to convergence, approval. | Codex's review is a real net, but a subtly wrong behavior can reach users. |
| **Migrations, backfills, auth, payments, the visual pipeline** | Full ceremony **plus** the relevant specialist review. | Often irreversible, and a subtly-wrong result isn't visible until the damage is done. |

For the floor tier, say so in the PR body's *What & why* ("transient
checklist, deleted after one run — findings triaged once, no re-review"),
so the reviewer and any later reader can calibrate from the same line.
Review *depth* on any docs-only PR is governed by
[`code-review.md`](../engineering/code-review.md#documentation-only-prs-get-a-light-review-david-2026-08-08):
generally correct is good enough, glaring issues only — no grammar or
minor-count findings — and the review request states that bar explicitly.

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
  **once** for soundness, and is updated as later discoveries land.
- A **plan** builds **one bounded increment** toward a direction and **cites
  the direction it serves**. Its intent sentence says what *this increment*
  makes true — never what the end state is.
- **The plan-review loop only ever runs on plans, never on a direction.** A
  direction has no implementation to be wrong about, so adversarial review of
  one produces specification rather than correction. (This is about the
  `[PLAN REVIEW]` loop specifically — it says nothing about code-review loops
  on implementation PRs, feature or bugfix, which keep running exactly as
  described elsewhere in this doc and in the `bugfix` skill.)

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
a new artifact — it's a routing bug.** [`product-direction.md`](./product-direction.md)
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
abuse/fraud path, and unlike a plan-review PR (closed, unmerged, still public
history but never on `main`), a direction that updates a canonical
`docs/ai-context/` doc goes live on `main` directly. Run the canonical
disclosure check —
[`workstream-tracking.md`](./workstream-tracking.md#what-must-never-happen)'s
definition, the one every other disclosure gate in this repo references rather
than restates — before committing a direction; a direction that fails it takes
the same private/manual path a disclosure-carve-out workstream would.

### The increment test

**A universal quantifier in the intent sentence means you're holding a
direction, not a plan.** "All", "every", "everything", "any and all",
"exclusively" — any of these, needed to say what the intent means, is the
signal. Write or update the direction first (per the routing rule above), then
cut the first increment out of it and plan that one. Don't narrow the
requester's words to make the test pass — the totalising sentence stays intact
in the direction, which is exactly where it belongs.

**A *Phases* section that separates independently shippable pieces means each
phase was probably its own plan.** The distinction is **independent
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

**So a loop's real exit condition is "the design claims are right," not "the
reviewer stopped finding things."** PR #422 reached that point at round 2,
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

- **The criticality gate comes before the trend (David, 2026-08-08).** Before
  requesting round 2 on *any* artifact — and again any time the loop feels
  like it's grinding — answer this question first: **"if every remaining
  finding shipped unfixed, what is the realistic worst case for the product
  in production, and who would notice?"** If the honest answer is "nothing a
  user or the business would ever feel," the loop is already over: triage the
  open findings once (accept-and-document is the expected default at this
  criticality), ship, and move on. Correctness of the findings is not the
  test — in the loop that taught this rule, every finding was correct and the
  loop was still the wrong place to spend tokens. Rate the artifact 1–100 on
  "what breaks in production if this is wrong"; a transient run checklist is a 1,
  and nothing rated in the single digits earns a second round.
- **The count trend is a tripwire, not a verdict (David, 2026-08-13 —
  superseding "findings must fall round over round").** Report the trend
  plainly every round, and let a rising count still force a hard pause before
  any further round — but what the pause produces is a *classification*, not
  an automatic stop. The rule this supersedes said a rising count "means the
  artifact or the ceremony is wrong"; PR #425 falsified that interpretation
  three rounds running (6 → 7 → 8, each rise mostly the reviewer widening
  into pre-existing code while the diff itself converged), and a *falling*
  count was already known to hide oscillation and growth. What actually
  carried the continue/stop decision every time the tripwire fired was the
  causal-and-territory sort of the findings — so that sort is the decision
  rule, and the count is merely one of the tripwires (alongside artifact
  growth and oscillation) that forces it to happen:

  | Bucket | What it is | Decision |
  |---|---|---|
  | **Oscillation** — findings repairing an earlier round's fixes | propagation / wrong-fix / re-raised dominating the round | **Stop.** More prose rounds cannot converge this; implementation or reassessment can. |
  | **Class recurrence** — a sibling instance of an already-swept class | the sweep protocol's process-failure flag | **Continue**: finish the class, name the process miss in the round record. Converges fast. |
  | **New ground, in the diff** — fresh defects in code this loop touched | ordinary review progress | **Continue**, normal triage. |
  | **New ground, pre-existing** — defects in code the diff never touched | the reviewer ran out of diff and started auditing the repo | **A now / next / never scope decision per finding — never "another round" by default.** Closer to a convergence signal than a failure: the diff stopped yielding. |

  **Territory is the dimension the causal flag alone misses.** "New ground"
  lumps a defect in this PR's fresh code together with a years-old bug the
  reviewer wandered into, and the two demand opposite responses — so a
  finding is classified on both axes: cause (the ledger rubric's vocabulary)
  and territory (in this loop's diff, or outside it).

  **Bucket precedence, so every finding routes exactly one way.** The
  overlap case is a sibling instance of a class an earlier round claimed to
  sweep — the sweep protocol classifies that as wrong-fix for the *ledger's
  causal accounting*, which would also read as oscillation here. For the
  *loop decision*, the **first** recurrence of a swept class is class
  recurrence (continue: escalated re-name, re-sweep, process miss named in
  the round record) — one faulty sweep is a fixable mistake, not evidence that
  prose can't converge. A **second** recurrence of the *same* class joins
  oscillation: at that point the sweep mechanism itself is failing and
  another prose round won't fix it. The two axes deliberately diverge on
  this case — the bucket routes this loop's next step; the cause feeds the
  self-inflicted share — and the round record states both when they differ.
- **Impact ranks the fixes; it does not drive the loop (David, 2026-08-13).**
  A high-impact pre-existing finding earns *urgency in whatever vehicle it's
  routed to* — usually a promptly-scheduled follow-up — not another round of
  this loop. A low-impact oscillation finding is still a stop signal.
  Causality and territory decide whether the loop continues; impact decides
  how fast each routed finding gets fixed, wherever it lands. **The
  criticality gate above remains the outer gate and fires first**: buckets
  route continuation only for an artifact the gate already admitted. "Impact
  never drives the loop" means a finding's severity buys no *extra* rounds
  inside an admitted loop — it does not resurrect a loop the criticality
  gate already ended, and a single-digit-criticality artifact still gets no
  second round no matter how its findings classify.
- **The artifact must not grow while it is being reviewed (David,
  2026-08-11).** Record its size at round 1 and state the current size in every
  re-review request, beside the finding trend. **Growth past roughly 50% means
  the artifact has stopped being reviewed and started being written** — the
  correct output at that point is a split and a backlog, not another round.
  This is a **second, independent tripwire**, and it exists because a *falling*
  finding count hides it completely: PR #404 grew 877 → ~1,370 lines (+56%)
  while rounds 1 and 2 fell 24 → 14 and looked like convergence. The mechanism
  is that fixes add **machinery** — an endpoint, a reservation system, an
  advisory lock, a column — and each piece of machinery is fresh surface for
  the next round, which is how round 3 rose to 21 findings with roughly 14 of
  them against scope that did not exist when the loop started.
- **But the tripwire's output is not always a split — it depends on *what kind*
  of growth fired it (David, 2026-08-13).** Two kinds look identical on the
  line count and call for opposite responses:

  | Growth | Looks like | Correct output |
  |---|---|---|
  | **Scope accretion** — the artifact absorbed a second deliverable | New sections about a subsystem the plan didn't originally own | **Split.** This is what the tripwire was written for. |
  | **Depth** — findings against one coupled mechanism, answered | The same sections getting longer and more precise | **Cap the loop and go to implementation.** Splitting a coupled mechanism manufactures an ordering dependency and reviews neither half honestly. |

  PR #421 was the first kind: hardening material accreting inside an
  entitlements plan, and the two halves were genuinely separable. PR #422 was
  the second: 545 → 1029 lines because reviewers found real defects in one
  boundary whose migration and runbook halves are meaningless apart.
  **Recommending a split there was pattern-matching the rule instead of
  reading the situation** — and the proposed seam was the exact
  plan-to-plan ordering dependency both reviewers had just flagged as the
  riskiest thing about the *first* split. Splitting twice to avoid review
  rounds trades a bounded problem for an unbounded one.

  So the menu at a fired tripwire is **split / cap-and-implement / stop**, and
  the question that picks between them is *did the artifact take on new scope,
  or get deeper about the scope it had?* **Who decides (David, 2026-08-15):**
  cap-and-implement and stop are the driving agent's own calls, made through
  the post-round adjudication (adversarial subagent, FYI to David) — but
  **split always escalates to David**, because a split changes the
  deliverable shape the scope-of-work gate agreed to, and the loop has no
  authority over its own scope.
- **Oscillation is its own stopping condition (David, 2026-08-13).** When a
  round's findings are dominated by **failures of the previous round's
  fixes**, the loop is not converging, it is oscillating — and more rounds do
  not fix that, because prose cannot be executed. PR #422's round 2 carried
  three `Reconciliation — Still Open` findings against round 1's fixes, plus
  two fixes that were themselves new defects: a bypass flag any caller could
  forge, and a guard that would crash every un-hardened database. **The
  correct response is implementation**, which is the only thing that
  actually verifies a mechanism. Track this alongside the count and the size;
  a *falling* count hides it exactly as it hides growth.
- **A fix that requires inventing a new mechanism is a signal, not a
  solution.** When answering a finding means adding a flag, a state column, or
  a protocol the design did not already have, stop and ask whether the design
  is wrong instead. PR #422's forgeable GUC exemption existed only because the
  plan was trying to authenticate a sanctioned caller in a state where no
  authentication is possible; the real fix deleted the mechanism and corrected
  the claim above it. See *now vs. next* — the same default applies to
  mechanisms arriving via review, not just via scope requests.
- **Severity badges are not a triage input.** Two of PR #422 round 2's
  P2-badged findings were runtime crashes: `has_any_column_privilege(...,
  'DELETE')` raises, and `pg_has_role` raises on a role that does not exist
  yet. Read what a finding *does*, never what it is labelled.
- **Cap by artifact class.** Transient single-use docs: **the automatic first
  pass only — never a re-request** (see the ceremony table above). Docs-only
  PRs of any kind: **the first pass plus at most one re-request** — see
  *Docs-only PRs cap at one re-request* below, which supersedes the earlier
  "agent-facing markdown: 1–2 rounds" phrasing of this line. Product code:
  the existing soft cap, and the ~20-round figure is a backstop, not a
  budget.
- **The historical record reads cleanly under the bucket rubric — the
  diagnosis, never the number, was the decision every time.** PR #329's guard
  (9, 11, 12, 19 — 2026-08-05) was new-ground-in-diff against an unbounded
  parsing surface: the artifact really was the problem. PR #333's plan (12,
  1, 4, 6, 12 — same day) was ceremony mismatched to a markdown file, with
  later rounds specifying guarantees the platform could not provide. PR
  #356's TEST_RUN doc (2026-08-08) ran **five rounds and 36 findings on a
  checklist that gets deleted after a single run** — every finding correct,
  every round a misallocation, and the origin of the criticality gate. And
  PR #425 (6, 7, 8 — 2026-08-13) was majority pre-existing territory plus a
  pair of half-applied fixes: a scope decision wearing a divergence costume.
  Four rising or high counts, four different correct responses — which is
  the whole case for classifying before deciding.

### Docs-only PRs cap at one re-request — review of prose is structurally unbounded (David, 2026-08-14)

A code-review loop converges because the diff bounds it: the reviewer runs
out of changed lines. A documentation diff has no such bound — every claim
in a doc is checkable against the entire repo, so an adversarial reviewer
never runs out of true findings; each corrected claim exposes its
neighbors, and the loop's own fix commits hand the next round fresh prose
to audit. A convergence target ("review until clean") is therefore the
wrong exit condition for docs **even when every finding is correct** — and
in the loop that taught this rule they all were: PR #434 (the `/document`
harvest of PR #425) ran **eight rounds**, every finding genuinely factual.
Rounds 1–5 fixed real errors in durable docs — worth one round's ceremony.
Rounds 6–8 polished the allowlist of a proposed CI guard that does not
exist yet and audited pre-existing docs outside the diff. The cut line was
visible at round 5 and nothing mechanical forced anyone to look at it.

So a **docs-only PR** — any PR whose entire diff is documentation:
agent-facing markdown, `/document` harvests, manual chapters — gets a hard
cap, not a convergence target:

1. **The automatic first pass** (Codex reviews every non-draft PR on
   open), then one fix-and-triage commit.
2. **At most one `@codex review` re-request**, to verify those fixes.
3. **Whatever that verification round returns gets triage only** —
   fix-if-trivial in the merge-ready commit, file a follow-up issue, or
   decline — and the loop is over. No third request regardless of what the
   findings are: under an unbounded surface, "the findings are real" is
   not evidence the loop should continue — it is the permanent condition
   of reviewing prose, so it cannot be the continue signal.
4. **Out-of-diff findings route to follow-up issues by default, at any
   round.** A docs reviewer wandering into pre-existing docs is the
   convergence signal (the diff stopped yielding), never grounds for
   another round — the same *new ground, pre-existing* bucket the stopping
   rule already routes to a scope decision, hardened here into the
   default.

The floor tiers stay stricter: transient process docs and loop-ledger
records keep their zero-re-request rule from the ceremony table. And the
criticality gate above becomes **mechanical** at the same time: any
re-request, on any PR of any kind, states the artifact's 1–100 criticality
number in the request text itself. A request the author cannot put a
number in does not get posted — the missing number is exactly how PR #434
sailed past the pre-existing "agent-facing markdown: 1–2 rounds" cap
without anyone being forced to notice which class the artifact was in.

What the cap does **not** change: factual wrongness in durable docs is
still the one thing worth fixing there, so verified-real findings from any
round still get fixed (in the capped commit or via a filed issue) — the
cap ends *rounds*, never fixes. And a docs PR whose findings reveal a
real product defect (not a doc defect) leaves docs ceremony entirely:
route it to `/bugfix` or a feature workstream, where code rules apply.

**The PR body states the scope oracle, so the reviewer reviews the right
thing (David, 2026-08-15).** Every meta-artifact PR — ledger records,
`/document` harvests, agent-facing markdown — carries a
short *review scope* block naming what review is *for* on this artifact and
what is out of scope. A `/document` harvest's oracle, as the worked
example: *in scope — routing correctness against
`documentation-workflow.md`, factual accuracy against the merged diffs,
contradiction or duplication with existing docs; out of scope — prose
style, structure preferences, completeness beyond the session's actual
learnings.* PR #434's eight rounds were mostly prose polish — correct
findings against the wrong review target. With a stated oracle,
out-of-scope findings are **declined against the stated rule**, not
absorbed to be polite, and **convergence-by-decline in one triage pass is
convergence for this class**: merging same-day after declining every
out-of-scope finding is the expected outcome, not a diligence failure.

### Findings are triaged against the artifact's real risk

Codex labels findings "Required Revision" — that is its job, and it is
correct to. **Accepting that framing wholesale is not.** Every finding gets
one of three responses, stated explicitly:

1. **Fix it** — the defect matters for this artifact.
2. **Accept and document it** — the finding is correct, and the cost of fixing
   exceeds the risk *for this artifact*. Say so, in the thread and in the file.
3. **Escalate it** — it's a genuine product or design decision. That's David's.

Response 2 is legitimate and under-used. Specifying compare-and-swap semantics
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
*next* or *never*), the artifact's ceremony tier, and its 1–100 criticality.
**That agreement is the loop's authority to run autonomously to
convergence** — it replaces the retired per-round check-in (below) as
David's control point at the front of the loop, paired with explicit plan
approval at the back. The corollary is the escalation rule: anything that
would *change* the agreed scope of work — a mid-loop scope addition, a
split, a product/design fork — is outside the loop's authority and goes to
David, however the loop is otherwise pacing itself. (Claude's enactment of
the gate's mechanics lives in the `plan-review-loop` skill; the SOW's
content is the same material the plan-review PR body template already
carries, agreed *before* the loop starts instead of discovered during it.)

### The post-round adjudication (David, 2026-08-15, superseding the 2026-08-07 per-round check-in)

The stopping rule and the triage above were originally self-policed — the
agent driving the loop classified, judged the trend, and decided to continue,
all unilaterally. The NCMEC plan loop (PR #280 — 18 rounds, 180 findings,
this repo's worst by finding count, ledger row 14) showed what that costs:
rounds went into trying to make a migration block the application role from
mutating objects that role *owns* — a boundary PostgreSQL structurally
cannot enforce without a superuser, which is now exactly what
[`ncmec-audit-ledger-hardening.md`](../engineering/ncmec-audit-ledger-hardening.md)
documents. One round of "impossible as specified — escalate" was the correct
disposition; iterated fix attempts were not. The 2026-08-07 fix moved the
continue/stop decision to David, every substantive round.

**As of 2026-08-15 that decision moves back in-loop — but not back to the
unilateral self-policing that failed.** What made the 2026-08-07 pause
necessary was a decision that was unchecked, unscoped, and invisible. Each
of those now has a structural replacement, and together they are the
conditions of the autonomy:

1. **Not unchecked.** Every judgment moment — a fired tripwire, a rising
   count or oscillation signal, any split / cap / stop decision, any
   recommendation whose flip condition is missing or already true — gets the
   **adversarial second-opinion subagent** (the `model-routing` skill's
   structural triggers) before the decision executes. The subagent is
   prompted to *reverse* the drafted decision, not review it; what survives
   is what runs.
2. **Not unscoped.** The scope-of-work gate above bounds what the loop may
   decide. The decisions that remain David's, always blocking (🛑): a
   genuine **product or design fork**; a mid-loop **scope addition** (the
   now/next/never question — default *next*); any **split**, because a split
   changes the deliverable shape the SOW agreed to; anything touching the
   **disclosure check**. Cap-and-implement and stop are the loop's own
   calls; pulling new scope *in*, or cutting the deliverable *apart*, is
   not.
3. **Not invisible.** Every substantive round still produces the full round
   record (below) — in the loop's own trail (the PR thread and findings
   ledger) rather than as a blocking banner. Noteworthy adjudications (a
   fired tripwire and how it resolved, a stop/cap call) surface as
   non-blocking 👀 FYIs as they happen, and **the loop-close report
   summarizes the whole decision trail** — tripwires fired, how each was
   adjudicated, declines and their survivals — at the moment David re-enters:
   the approval ask for a plan loop, the merge/close-out report for a code
   loop. David audits the trail at the bookends instead of gating each round.

**When a review round's findings land: triage first, implement nothing until
the adjudication is done.** The round record carries:

1. **Count + trend, then the bucket mix that interprets it (David,
   2026-08-13)** — this round's finding count against the prior rounds'
   ("round 3: 4 findings; 9 → 6 → 4"), followed in the same breath by the
   stopping rule's classification: how many findings are oscillation /
   class recurrence / new ground in the diff / new ground in pre-existing
   code. **The mix, not the count, carries the continue/stop weight** — a
   rising count still forces this classification to be presented, but the
   count alone is never reported as the reason to stop.
2. **Per finding** (grouped where natural): what it is, which part of the
   feature or fix it affects, and the triage verdict — fix /
   accept-and-document / escalate / decline — with a plain statement of
   whether it is critical to delivering the feature or fix. **Decline** is
   distinct from *accept-and-document*: accept-and-document concedes the
   finding is a correct, real defect not worth fixing here; decline says the
   finding is not a defect at all, and it is only ever used with the same
   evidence bar the loop ledger's *Invalid* category requires — refuted with
   repository or platform evidence, or settled by an explicit prior product
   decision from David. A bare disagreement is neither; it's escalated.

   **Anything that reaches David is written in product English, for a
   product manager (David, 2026-08-08).** The round record itself now lives
   in the loop's own trail, where mechanics belong — but every surface with
   David as the audience (an escalation, an FYI, the loop-close report)
   keeps this rule in full. He does not write code and does not care about
   internal mechanics — he cares whether the thing being built will
   meaningfully change how the product behaves. Before writing any finding
   into a report to him, run it through his own template:
   *"What are you trying to build, why do we need it, why does Codex think
   there's an issue, and what is the ramification of having bugs in this
   code?"* Each finding in the report answers, in plain sentences: what
   would go wrong (as an outcome, never as a mechanism) and what that would
   mean for the product and for production. Shell quoting semantics,
   Postgres catalog names, bash expansion order, environment-variable
   precedence — all of that stays in the PR thread, where the reviewer
   lives; none of it appears in the report to David. The origin case: a
   check-in explained a finding as *"bash expands `$DATABASE_URL` using the
   already-exported value before applying the command-local assignment"* —
   which meant nothing to him. What it should have said: *"one of my test
   instructions would have quietly pointed a risky operation at your real
   database instead of the throwaway copy."* A useful test: a good report
   sentence **survives a change of technical root cause unchanged**, because
   it describes what happens to the product — the real-database sentence
   above reads the same whether the cause was shell expansion, a wrapper
   script, or environment-variable precedence. If the sentence would have to
   be rewritten when the mechanism changes, it's describing the mechanism —
   rewrite it as the outcome instead.
3. **The causal flag, explicitly — and for new ground, the territory.** Is
   the finding **new ground**, or is it **repairing something an earlier
   round's fix introduced** (propagation / wrong-fix, in the loop ledger's
   rubric vocabulary), or is it **demanding a guarantee the platform or
   configuration cannot provide** (the NCMEC case)? An
   impossible-as-specified finding is named as such and never absorbed as
   another fix attempt. New-ground findings additionally say **which
   territory** they sit in — code this loop's diff touched, or pre-existing
   code the reviewer widened into — because the latter routes to a
   now/next/never scope decision rather than a fix-by-default (per the
   stopping rule's bucket table).
4. **A decision** — continue / stop and ship / escalate. The loop makes it
   and proceeds, except where the decision is one of the reserved 🛑
   escalations above (a product/design fork, a scope addition, a split, a
   disclosure question) — those still wait for David.
5. **The flip condition: the one fact that would reverse the decision
   (David, 2026-08-13).** One line, always. Two failure modes it catches, and
   both have happened here:
   - **No flip condition can be named.** A decision nothing could
     reverse was not reasoned to; it was looked up.
   - **The named fact is already true.** That is the decision failing in
     the act of being written. Either condition is itself a structural
     trigger for the adversarial subagent — the decision does not execute
     until a real, false flip condition can be stated.

**A decision that carries an unrefuted argument against itself does not
execute (David, 2026-08-13).** Either refute the counter-argument explicitly,
or the decision flips to follow it. **A caveat that cannot be refuted *is*
the decision.** Under autonomy this rule matters *more*, not less — it is now
enforced by the adversarial subagent pass instead of by David's read.

This is not a general call for humility — it names a specific, mechanically
detectable failure. On PR #422 the recommendation to split ended with a
paragraph explaining that splitting a coupled mechanism would manufacture an
ordering dependency at the exact seam both reviewers had just flagged as the
riskiest thing about the previous split. The counter-argument was correct,
unanswered, and appended as a disclaimer under a recommendation it should have
reversed. One round earlier, a report recommending fixes for eight findings
also contained the observation that seven of them were toolchain-catchable.

**The shape is always the same: the right answer was already in the output,
demoted to commentary.** The recommendation came from applying a rule; the
situation-reading arrived afterwards and was not allowed to change the
conclusion. So the check is structural rather than a matter of thinking
harder — before sending any recommendation, find every sentence in it that
argues the other way, and treat each one as a stop signal rather than a
hedge.

**Every record, FYI, and report shows the argument against the decision,
never a sanitized case for it.** This is the safeguard with a perfect record
in this repo: both times a recommendation was wrong, David caught it
*because* the counter-argument was there in full for him to read. The
check-in it rode on is retired; the property is not — the adversarial
subagent receives the counter-arguments verbatim, and the loop-close report
carries them so David's bookend audit reads the same evidence the old
per-round read did.

**Fixes are implemented only after the adjudication.** The pause sits
*before* the round's fix work, not after, because the waste in a runaway
loop is *implementing* the chased fix — the adjudication is cheap, and a
verdict reached after the fixes would spend exactly the tokens it exists to
save.

**Skip-on-clean:** a round with zero findings, or only trivial mechanical
nits (a typo, a dead import, lint), needs no adjudication — handle it
silently and note one status line in the loop's trail so the discipline
stays visible.

**Scope: every review loop — plan review and code review, feature and
bugfix, whichever agent is driving it.** The per-round causal flags double as
live ledger classification: they are the same categories the
[loop ledger's](#the-loop-ledger) adjudication rubric applies at close,
recorded while the loop runs instead of reconstructed afterwards.

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

The measured worst case is **PR #334** (loop record
`.agents/metrics/loops/334.json`) — nominally a bugfix, actually eleven
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

> **Dependent bugs.** If a new bug's fix depends on an earlier fix whose PR is
> still open, say so rather than silently branching from `origin/main` (which
> wouldn't contain it). **Prefer waiting** for the parent to merge, then
> branching from fresh `origin/main` as normal — the only way to guarantee the
> new PR's diff contains just the new bug. If the wait is genuinely too
> costly: branch from the parent PR's head, but **open the new PR with the
> parent's branch as its base, not `main`.** Basing against `main` while the
> branch carries the parent's unmerged commits puts both bugs in one diff,
> which defeats the one-bug-per-PR isolation this section exists for. State
> the stack order in the new PR body. **Retarget the child's PR base to `main`
> *before* the parent's PR is merged — not after.** This repo auto-deletes a
> branch once its PR merges, with **no reliable window afterward** to act — the
> deletion can happen as part of the merge itself.
> [`CODEX_GITHUB_REVIEW_WORKFLOW.md`](../CODEX_GITHUB_REVIEW_WORKFLOW.md)
> records a real prior incident of exactly this orphaning, and its own required
> workflow says to preserve the parent branch and retarget the stack *before*
> squash-merging it — do the retarget as part of preparing the parent for
> merge, before asking David to merge it (or before merging it myself if that's
> in scope), not as a step after. Retargeting early means the diff is
> temporarily broad (it still contains the parent's unmerged commits) — accept
> that; it's cosmetic. Once the parent has actually merged, narrow the diff:
> `git fetch origin main && git merge origin/main` into the child branch (the
> squash commit becomes an ancestor, per CLAUDE.md's squash-merge-follow-up
> guidance — merge, never rebase, on an already-pushed branch), then push;
> the diff narrows to just the new bug once that lands.

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
migration, or backfill work — not the `lib/api-zod` Zod schemas, which are a
Q1 trigger, not this one; a design flaw rather than a defect; needing a new
abstraction; needing an external vendor) is Tier C regardless of whether the
change also trips a Q1/Q2 item; those triggers only decide Tier A vs. Tier B
*within* work that's already confirmed to be a bug fix, not before. Once Tier
C is ruled out on **all** of its grounds, run the checklist below. **If any
item trips, it is
Tier B.** With this list, Tier A is the exception — that is intended, not a
mis-calibration.

**Q1 — Where does the fix land?** Any of these subsystems → **Tier B**:
payments / auth / permissions / security headers; the tokenizer, grammar, or
`render-fact`; the visual pipeline (planner, compiler, render policy, Visual
Concept); the async job queue, worker lanes, or any enqueue helper; enrichment or
moderation source-of-truth (`facts.*`, `resolveEnrichment`, override layers);
`lib/api-zod/` or `lib/api-spec/` (the codegen allowlist trap — these are
generated Zod *API-validation* schemas, distinct from Tier C's *database*
schema trigger below; a fix confined to them is Q1 Tier B, not Tier C); dev-infra and
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
schema** (Drizzle/`lib/db`, migrations, table structure) — not the generated
Zod API-validation schemas under `lib/api-zod`/`lib/api-spec`, which are Q1's
own explicit Tier B trigger (the codegen allowlist trap); a fix confined to
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
2. **Classify** against the checklist above. State the tier and the reason.
3. **Write the regression test first** — a test that **fails on current code
   because of this bug**. This is the difference between fixing a bug once and
   fixing it forever, and it must prove the **general invariant** with negative
   cases, not just the reported input (see *One-example bug fixes*).
4. **Make the smallest correct fix** and confirm the new test passes.
5. **Establish the blast radius.** What else calls this code, shares this path, or
   depends on this behavior — and what you checked. Regression tests pin the fixed
   behavior; they say nothing about the neighbors, which is exactly where a
   small-looking fix does its damage.
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
   schema fix — and engage the review to convergence.
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

Plus **Blast radius** (from step 5) and the **fix tier with its reason** —
**required for Tier A as much as Tier B.** A is the classification reviewers
most need to be able to challenge, so "A (contained)" alone is not enough:
name the Q1/Q2 items you checked and ruled out, not just the ones that would
have fired. A bare tier letter with no reasoning is a mis-tiering risk
whether or not the letter turns out to be right.

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
- **Bot-review engagement to convergence** once a PR is open — including
  re-review of every fix round, since a push does not reliably re-trigger a
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
not the `lib/api-zod` Zod schemas, which stay Q1 Tier B — see *Tier C*
above), **do not silently treat it as a fix** — **ask** whether it should
take the feature workflow, or (for a genuinely trivial database schema fix)
proceed straight to migration ceremony per Tier C. Guessing wrong is
expensive in both directions (skipping a plan a feature or a non-trivial
schema change needed, or piling ceremony onto a one-line fix), and the
confirm costs one question.

## When NOT to use bugfix mode

Features, behavior changes, **any *database* schema change, migration, or
backfill** (Tier C without exception — see above; not gated on product
consequence; not the `lib/api-zod` Zod schemas, which stay Q1 Tier B), or
anything where David needs to verify intent — that's **feature mode**, or for a
trivial database schema fix, migration ceremony run directly per Tier C. Don't
use bugfix mode to sneak a feature through the lightweight path. **And a
"clean up the review findings" batch is not a bug fix (David, 2026-08-09):**
N leftover findings are N defects, and batching them recreates exactly what
one-bug-per-PR banned — PR #334 above is the measured cost. When unsure
which it is, **ask.**

## The loop ledger

**Every review loop gets one record at
`.agents/metrics/loops/<pr>.json`. This applies to every agent and every
mode** — plan review, feature/code review, bugfix review, and any ad-hoc
thread that escalated into a reviewed change.

> **Changed 2026-08-07.** The markdown table at
> [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md) is
> **frozen** at rows 1–46 and is never appended to again — it is the archive
> of what those loops showed, pinned by a `sha256` baseline. The `[LEDGER]`
> PR type is retired: a record rides any PR except the one it measures. Blind
> adjudication now runs on a **sample of loops** (each still adjudicated over
> its full finding population). And the answers now reach David through a
> digest rather than sitting in a file. Rationale — including why sampling
> loops does not reintroduce the bias defects that removed the original
> within-loop sample — is in [`decisions.md`](./decisions.md). The rubric
> below is unchanged.

**It is here, in the shared contract, rather than in one agent's private
instructions, for a specific reason:** Codex runs feature and bugfix workflows
independently of Claude's ceremony (see *How each agent enters / exits a mode*
above), so an obligation living only in `CLAUDE.md` would silently omit every
Codex-driven loop. The resulting record set would look complete while being
wrong about the thing it exists to measure — worse than none, because it
would be trusted.

**A loop becomes recordable at its terminal point — closed or merged — and
records are written and delivered at the weekly `/maintenance` flush
(David, 2026-08-15).** A loop's close no longer triggers its own recording
ceremony: David reads the ledger only through the digest `/maintenance`
narrates — the weekly "how are we doing and what can we improve"
conversation — so per-close recording bought freshness nobody consumed at
the cost of a review loop per loop. At each `/maintenance` pass, the
records for every loop closed since the last pass are created (via
`loop-metrics.mjs`, as below) and committed together on that pass's
docs-only commit; the digest's completeness check then runs against the
flushed state, so a gap it names is a real one. A record may still ride an
earlier carrier PR opportunistically — a record that exists early is fine —
but a **standalone ledger-only PR between maintenance passes is retired**.
The terminal-point definition below still governs *eligibility*, and the
late-review caveat still governs *correctness*:

There is no settling-window wait (David, 2026-08-08: first shortened from
14 days to 1 hour, then removed outright — nothing in this pipeline runs
automatically.
`--write` needs an agent to run it in a live session, and the digest needs
David to invoke `/maintenance`; a wait bought no real safety margin against
that, only a window where a genuinely missing record went unreported. The
duplication/collision problem the ledger actually had — PRs #327 and #335
both claiming the same rows — was a different failure, already fixed
structurally by one file per loop, not by a wait). Reviews can land after
merge — frozen-ledger rows #323 and #324 are observed cases — so a record
written right after close can understate rounds and findings if a pass is
still in flight. If a late review arrives after a record exists, re-derive
and edit the record; that is an ordinary commit, not a special case to
detect automatically.

**Commit the record on any open PR except the one being measured.** Adding a
metrics file to the PR it describes changes that PR's diff, which can trigger
a further reviewer pass *after* the rounds and interval were derived — the
record would then omit the round its own addition caused.

**At loop close:**

1. Run `node scripts/loop-metrics.mjs --pr <number> --write`, which lands a
   record with a `judgment: null` scaffold. **Do not type the mechanical
   values by hand.** Rounds, findings and elapsed time
   are countable, and figures produced here by recollection have a poor track
   record — two were withdrawn as wrong during the work that created this file.
   No direct `api.github.com` credential in your environment? The script also
   accepts `--mcp-snapshot <file>` for agents whose only working GitHub access
   is a tool-calling integration — see the adapter and its shape notes in
   `scripts/loop-metrics.mjs`. Either path is mechanical; neither is typing the
   numbers from memory. **The snapshot must page each of `get_reviews`,
   `get_files`, `get_review_comments`, and `get_comments` to completion
   yourself before calling the script** — it cannot page through the MCP tool
   on its own — and must set
   `complete: {reviews: true, files: true, reviewThreads: true, issueComments: true}`
   only once every page is concatenated in. **The snapshot's `pr` object must
   also carry `closed_at` (and `merged_at` when merged)** — capture them from
   `pull_request_read` method `"get"`. The digest windows on the closure
   timestamp, and neither the coarse state nor the review interval can supply
   it: the interval is null for a loop with no reviews, and it ends at the
   *last review*, which for a post-merge review is after the merge.
   `assertMcpSnapshotShape` rejects a snapshot that omits the key, and
   **`--write` refuses an input with no issue-comment collection at all** —
   plain derivation stays lenient there for older read-only snapshots, but a
   record understating rounds and review time must never land as measured
   data. `get_comments` (issue comments, not
   review comments) is what a clean reviewer pass can post through instead of a
   formal review — see *Rounds undercounted when a re-review is clean* in the
   ledger itself — so omitting it understates `rounds` and `review hrs` on
   exactly the loops where a pass found nothing. The script still derives
   without it (for snapshots captured before this was added), but the row it
   returns carries a `warnings` entry saying so; do not paste those numbers in
   as though they were complete. The script refuses an unmarked or partial
   snapshot rather than deriving a plausible-looking undercount, which a large
   loop — PR #279's 32 rounds (our worst case by round count) or PR #280's 180
   findings (our worst case by finding count, on 18 rounds) — would otherwise
   produce silently.

   **Before committing to backfill or blind-adjudicate a historical loop,
   check its size cheaply first.** A plain `get_reviews`/`get_review_comments`
   call (or the MCP `totalCount`) costs one round-trip and tells you the round
   and finding count before you've built a snapshot or spent any tokens
   classifying. The 2026-07-29 backfill skipped this and scoped its work from
   the ledger's prior worst case (18 rounds / 40 findings) — the two loops it
   then tried to backfill turned out to be 9 rounds/86 findings and 32
   rounds/166 findings, the latter a 4× jump that forced a mid-task
   renegotiation of what to actually adjudicate (see
   [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md)'s
   row 6 note). A loop's size has no reason to resemble the last one measured;
   check before scoping, not after building the snapshot.

   **A clean re-review can (but does not always) skip producing a review
   object to count — confirmed twice now, not a universal rule.** A
   completed review with zero findings sometimes DOES post as a normal
   `pull_request_review` (row 3, #270's `rounds` is 16 not 15 specifically
   because one clean review event *was* captured that way — read that row's
   own note before assuming the opposite). It has also been directly
   confirmed **not** doing so, twice independently: on PR #286 a clean
   re-review posted as a plain issue comment instead ("Codex Review: Didn't
   find any major issues. Delightful!"), not a `pull_request_review`, so
   `get_reviews` didn't see it — and on PR #288, checked directly against
   its own `get_comments` history (2026-08-01, correcting three earlier
   drafts of this note that called #288 unconfirmed on the strength of
   Codex's own claim without anyone actually checking the PR): two plain
   "Codex Review: Didn't find any major issues" comments exist
   (`2026-07-30T02:05:58Z` and `2026-07-30T03:32:17Z`), the same
   plain-issue-comment shape as #286's, not the 👍-reaction shape earlier
   drafts speculated. **The actionable consequence is narrower than "clean
   rounds never count":** when a PR body's own round-by-round narration
   cites more re-review passes than `get_reviews` returns, don't assume a
   pagination bug by default — check the PR's actual comment history for a
   plain "Codex Review: Didn't find any major issues" comment, since that
   specific gap is now confirmed to recur on this connector, not merely
   suspected. It is not, however, license to wave away every
   rounds/findings mismatch without checking — #288's own history shows why:
   the gap was real, but nobody confirmed it until someone actually looked
   at the comments instead of reasoning from absence of evidence. See
   [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md)'s
   *Rounds undercounted when a re-review is clean* note (row 11, #286) for
   the first sighting and its own concrete `rounds`/`review hrs` impact.
2. Fill the record's `judgment` yourself: cause per finding (new ground /
   propagation / wrong fix / re-raised / invalid), pre-open preflight
   minutes, breakers fired. **Ambiguous causes default to self-inflicted**,
   so classification drift cannot quietly flatter the workflow. Preflight
   minutes may be `null` **with a stated `preOpenPreflightReason`** when the
   figure genuinely cannot be isolated (a branch carrying unrelated earlier
   work — the frozen ledger's `—` convention). Null-with-a-reason is a
   measurement, distinct from a measured `0` and never summed as zero; do
   not fabricate a zero, and do not defer the whole classification over this
   one field. **Do not compute or store the self-inflicted share** — the
   digest derives it from the causes, and two copies of one number can
   disagree.
3. **Adjudicate only if the loop is sampled**: `pr % 5 === 0` **or**
   `findings >= 30`. Otherwise record `adjudication: {"status": "never-run"}`
   — that is the settled state for roughly four-fifths of loops, and their
   author classification still counts toward churn and the trend. A sampled
   loop that skips adjudication fails the guard, and an unsampled loop must
   not claim `completed`; the state matrix is enforced in both directions.

   When it *is* sampled, adjudicate **every finding** blind — a fresh-context
   reader (in practice a subagent with no access to the original
   classifications) is given the round history and **the rubric below**, and
   re-classifies the full population independently. Record only
   `population` and `disagreements`; the percentage and the verdict are
   derived at read time. At `findings = 0`, or when every finding is
   `invalid`, there is nothing to adjudicate: record `"n/a"` and the causal
   share is reported as `n/a` (see the ledger's own note on this), not `0%`. Above **20% disagreement**
   across the full set, record that loop's causal figure as `unmeasured` and
   exclude it from the trend rather than counting it as a pass.
   **"Disagreement" means an exact finding-by-finding comparison over a
   population both classifications agree is the same 1..N set — never an
   approximation from comparing aggregate category totals.** Two
   classifications whose `new`/`prop`/`wrong` totals are merely close do not
   establish a low disagreement count; they could differ on every single
   finding and still land near the same totals by coincidence. If the two
   classifications were produced against different populations (a different
   round-merging convention, or one surfaced a finding the other's source
   didn't count), that mismatch has to be resolved to a shared population
   first — or the row stays `unmeasured` for want of a real comparison, not
   a percentage computed from whatever rough alignment was easiest (loop
   ledger row 17, #294, first got this wrong before being corrected).

**The adjudication rubric.** Without a shared definition of the categories,
two readers can legitimately disagree on *classification* without either
being wrong about the *facts* — and the >20% gate can't tell that apart from
genuine drift. This is the shared decision rule both the original classifier
and the blind adjudicator use:

- **New ground** — the finding is a defect that existed independent of
  anything this same loop tried to fix. This includes a defect that was
  *already present* in the diff under review but only became visible or
  reachable because an earlier fix removed something blocking it (e.g. a
  fix removes a guard clause, and that makes a downstream bug reviewable for
  the first time) — the defect itself predates the fix, so exposing it is
  not something the fix *did wrong*. New ground is what the review workflow
  exists to catch; it is never counted as self-inflicted.
- **Propagation** — the finding is a **new** defect that exists *only because*
  an earlier fix **in this same loop** introduced it — not one it merely
  revealed. The test is causal, not temporal: if that earlier fix had never
  happened, would this specific defect exist? "Yes, though maybe unnoticed"
  is new ground; "no, the fix is the reason this exists at all" is
  propagation.
- **Wrong fix** — the finding says an earlier fix **in this same loop** did
  not actually resolve what it claimed to (the original symptom persists, or
  the fix is incomplete) — as distinct from propagation, which is a *new*
  defect elsewhere, not the same one recurring.
- **Re-raised** — the finding restates a **prior finding from an earlier round
  of this same loop** with no new information, **and no failed fix attempt sits
  between the original and the restatement.** The precedence matters because
  the categories otherwise overlap on exactly the case the numerator most
  needs: a Still Open Reconciliation finding about a defect an earlier fix
  attempted and did not resolve satisfies both definitions — that case is
  **wrong fix, always** (the failed attempt is the fact being measured, and it
  must enter the numerator). Re-raised is only the remainder: a restatement of
  a defect that was genuinely resolved (a spurious re-raise), or one no fix
  was attempted on in between (e.g. explicitly deferred) — repetition with no
  failed fix behind it. A restatement stays re-raised even when it is
  factually wrong *now* (the defect no longer exists) — invalid, below, is
  for first occurrences only.
- **Invalid** — the finding is not a defect for this loop's purposes, on its
  first occurrence, established one of two ways: **(a) refuted with
  repository evidence**, the same standard the review workflow already uses
  to dispose of a finding by rebuttal rather than a fix; or **(b) settled by
  an explicit product/scope decision from David** — the finding was escalated
  as a genuine product question and he chose the existing behavior or ruled
  the concern out of scope. The two subcases differ in kind (one says the
  reviewer misread the code, the other says the code is intended) but get
  identical metric treatment: neither is a defect the workflow caused or
  should have caught, so both are recorded in the `invalid` column and
  excluded from **both** the numerator and the denominator of the
  self-inflicted share — note the subcase in the row's notes when it
  matters. This category exists because the other four all presuppose either
  a real defect or a prior finding, while `findings` mechanically counts
  every reviewer-authored root comment — without it, a false positive or a
  David-overruled finding would force the classifier to fabricate a causal
  label or leave the category totals short of the findings count.
  **Doubt is resolved toward valid**: only evidence or an explicit decision
  makes a finding invalid — "probably not a real problem" is not enough. A
  finding treated as valid then gets a causal label, where the ambiguous
  default below applies. **The five category counts must sum exactly to
  `findings`** — a total that comes up short means a finding was skipped, not
  that it was hard to classify.
- **Ambiguous default**: if a finding could plausibly be new ground *or*
  self-inflicted (propagation/wrong fix), classify it as self-inflicted. This
  is the same bias direction the ledger's per-finding cause column already
  states, applied consistently by both the original classifier and the
  adjudicator. This default does not extend to the new-ground-vs-propagation
  test above: an *exposed* pre-existing defect is new ground by definition,
  not an ambiguous case defaulting to self-inflicted.
- **`newGroundTerritory` — the territory split of `causes.new` (David,
  2026-08-13; recorded for loops closing from this date, absent on older
  records).** The judgment block additionally carries
  `newGroundTerritory: { inDiff, preExisting }`: of the new-ground findings,
  how many were in code this loop's diff touched versus code the reviewer
  widened into? **The two must sum exactly to `causes.new`.** This exists to
  evaluate the stopping rule's bucket rubric with data instead of anecdote:
  the self-inflicted share measures fix quality, but a loop can have a
  spotless causal record and still run long because the reviewer left the
  diff and started auditing the repo — PR #425's rounds were exactly that
  shape, and without this field the record would show only "lots of new
  ground," indistinguishable from a genuinely defective diff. The ambiguous
  default here leans `inDiff` (the bias that makes *this* loop look worse,
  matching the self-inflicted default's direction). A high `preExisting`
  share across records is not a review-loop failure signal — it is a
  discovery/pre-planning signal: the affected-surface inventory was
  incomplete before the plan was written.

**Why the full population, not a sample (David, 2026-07-27).** Earlier drafts
adjudicated a 30% sample, inheriting the assumption that a *human* would do
the re-classification and the sample existed to bound that effort. The
adjudicator here is an agent, so full coverage costs tokens once per loop
close, not anyone's time — and the sampling machinery itself produced two
confirmed bias defects in two consecutive review rounds before being removed
(first an id-sort that oversampled round 1's disproportionately-new-ground
findings, then a round-robin whose "every round contributes" guarantee
failed whenever a loop had more nonempty rounds than the sample size —
either one capable of validating a causal figure while part of its
numerator went unchecked, since propagation and wrong-fix findings can only
occur in round 2 onward). Full-population adjudication deletes that
machinery outright: the >20% gate is computed exactly, over every finding,
with nothing to select and no selection rule left to get wrong.

*This rubric is new as of the loop-ledger's own PR and has not yet been
exercised by a real adjudication pass. #268 is the designated first run of
it (see the ledger's row-provenance notes) — if that pass surfaces a rubric
gap, fix the rubric here rather than making a one-off judgment call on #268
alone.*

**A record rides any PR except the one it measures (David, 2026-08-07 —
retiring the `[LEDGER]` PR type).** Two rules preceded this one, and the
history explains why the third is different in kind rather than just in
detail:

- The **original** rule folded a closed loop's row into whichever PR opened
  next, on any subject. It muddied every carrier's diff and made the ledger
  file the repo's worst merge-conflict magnet — three collisions in one week
  (#285/#286, #290/#294, #292/#295).
- The **2026-08-02** rule moved rows into dedicated `[LEDGER]`-titled PRs
  carrying every row currently owed. That fixed the muddied diffs but made
  collisions *mandatory*: any two concurrent `[LEDGER]` PRs were required by
  CI to contain overlapping rows and to hand-assign the same ordinals. PRs
  #327 and #335 both claimed rows 24–26 with different contents and each made
  the other un-mergeable.
- **The current rule fixes the cause instead of the symptom.** One file per
  loop, named for its PR number, means two sessions recording *different*
  loops touch different paths and cannot conflict at all. There is nothing
  to batch, nothing to carry, and no ordinal to assign — so there is also no
  recursion to terminate, and the `[LEDGER]` exclusion that existed to
  terminate it is gone with the PR type.

What remains:

- **Commit the record on any open PR of yours, except the PR being
  measured** (adding it there would change the diff it describes and can
  trigger another reviewer pass after the numbers were derived). The
  default delivery vehicle is the weekly `/maintenance` flush (above);
  riding an unrelated open carrier PR early is fine, a standalone
  ledger-only PR is not.
- **Recording the same loop twice, sequentially, is a no-op** —
  `--write` checks the working tree and `origin/main`. Any overlap *before*
  a record lands (two sessions at once, or a second session starting while
  the first record sits on an unmerged PR) is an ordinary git add/add
  conflict: keep either copy. That is an accepted outcome, not a protocol to
  build; this is a tracking tool.
- **Coverage is not a CI gate.** A closed loop with no record is named in
  the digest `/maintenance` narrates — the surface David actually reads —
  rather than failing an unrelated PR's build. Accepted risk: tracking can
  lapse for a week.
- **Records are not append-only.** A record can be edited or deleted in an
  ordinary commit; PR review is the control. Enforcing immutability required
  a corrections-overlay system whose own review produced more defects than it
  prevented.
- **Codex still reviews the PRs that carry records.** Its review of ledger
  appends has caught real classification errors (five rounds of them on
  #292's fold-in alone). Not gated by CI is not unreviewed.

**CI enforces record validity, and nothing else (David, 2026-08-07).**
`scripts/check-loop-metrics.mjs` runs in the Build job on every PR and on
push-to-`main`. It is fully offline (no token, no PR context, no base diff),
so it behaves identically in both, and it checks only whether a record is
internally coherent:

- Schema (both the measured and exempt branches), filename/`pr` agreement,
  and the `mechanical` **allowlist** — an unknown key there is a failure,
  because `derive()` returns more than the store keeps and a stored copy of
  something authoritative goes stale on the next refresh.
- The five causal counts sum exactly to `findings` — data corruption, not
  pending debt.
- Judgment completeness: a committed `--write` scaffold with a null judgment
  and no stated deferral **fails**, which is how an interrupted session is
  stopped from leaving a valid-looking hole. Null preflight *with a reason*
  is complete.
- The adjudication state matrix, **enforced in both directions**: a loop
  meeting the sampling predicate may not claim `never-run`, and a loop that
  does not meet it may not claim `completed`. A `completed` record stores
  only `population` and `disagreements`, bounded and equal to the full
  finding count; storing a percentage or a verdict is rejected as a second
  representation of one number.
- The frozen ledger still matches its `sha256` baseline.

**What CI deliberately does not check** — both accepted risks, recorded in
[`decisions.md`](./decisions.md) rather than discovered later:

- **Coverage.** A closed loop with no record is named in the digest that
  `/maintenance` narrates, not by failing an unrelated PR's build. The
  predecessor guard did fail builds over this, and it still did not put the
  gap in front of the person who could act on it.
- **Permanence.** Records are not append-only; PR review is the control.

**What it is for.** The primary question is whether the **self-inflicted
finding share** — findings that exist only because an earlier fix in the same
loop was incomplete or wrong — is falling. **Round count is recorded, never
targeted:** a long loop that keeps surfacing new ground is the loop working,
while a short loop that is mostly self-repair is worse, and a round target
scores both backwards.

A record's shape and the full field contract live in
[`.agents/metrics/loops/README.md`](../../.agents/metrics/loops/README.md)
and `scripts/check-loop-metrics.mjs`, the schema CI actually enforces — not
in the frozen ledger file, which is historical archive only from here on.
