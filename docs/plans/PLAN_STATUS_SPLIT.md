# Plan — Split `/status` into a write-through per-session view and a fleet-wide `/status-all`

> Feature-building mode. Draft for Codex plan review; **not approved**.
> Design settled with David 2026-08-05. **Provenance note (corrected in
> round 2):** the two `decisions.md` entries recording this design are **not
> yet on `main`** — they sit on unmerged PR #331. Until that merges, the
> durable record of this design is that PR plus this plan. Implementation
> step 8 re-checks the entries against the final plan.

## Problem

David runs ~10 concurrent sessions through Discovery → Planning → 🛑 Plan
approval → Coding → Code review → 🛑 Merge → Test run → 🛑 UAT → Close-out.
Today's `/status` answers exactly one question — *"across everything, what
needs me?"* — by scanning every open workstream issue, its sub-issues, and the
50 most recently updated PRs. That is the right shape for triage and the wrong
shape for the question a session asks about *itself*: **"what am I working on
right now, and how does it fit the bigger picture?"** Answering that today
means paying for a full fleet scan, then discarding nine tenths of it.

The sharper problem is **silent staleness**, and there is a live instance of it
right now. Issue **#328**'s State of Play block says:

```
**Stage:** Code review (Codex loop)
**Waiting on:** Codex
```

and it carries `stage:code-review` + `waiting:codex`. But PR #329 **merged**.
The truthful state is 🛑 UAT, waiting on David. Nothing corrected it, and
nothing was going to, because of a structural gap: every existing label writer
(`plan-review-loop`, `bugfix`, `pr-watch`, `pr-docs`) fires at a **transition
it happens to be present for**. When a session ends mid-flight, or when state
changes outside any session's attention (a PR merges while the session is
compacted, closed, or watching something else), nothing fires at all. There is
no writer whose trigger is *"a session is looking at this right now."*

That is what makes the per-session view **write-through** rather than
read-only: the moment a session asks "where am I?", it has just computed the
answer from live evidence, which is exactly the moment the stored answer can be
corrected for free.

## Product Intent

1. **Per-session `/status`** answers, quickly and cheaply: what this session is
   working on, what state it's in, what's next, and how it fits the wider
   roadmap. Scoped to *this* workstream — not the fleet.
2. **It is write-through.** Every invocation refreshes the workstream issue's
   State of Play block **and** its `stage:`/`waiting:` labels from live
   evidence, and **discloses that write every time** — never a silent
   side-effect, never a read-only summary that leaves a known-stale record
   standing.
3. **A fixed 5-state vocabulary** — `WORKING` / `WAITING ON YOU` / `WATCHING` /
   `STALLED` / `DONE` — so David reads the same five words in every session
   instead of re-parsing a bespoke narrative each time.
4. **`WATCHING` may never be claimed from memory.** A session may only report
   WATCHING after an actual live GitHub check *in that invocation*.
5. **Discovery with no issue yet** → `/status` says so plainly and **offers**
   to open the workstream issue. It never opens one unasked.
6. **Fleet-wide `/status-all`** is today's `/status`, renamed, behavior
   unchanged.

## Must Not Change

- **Labels stay the single source of truth**; the Project board stays a
  projection of them via `.github/workflows/project-sync.yml`
  (`scripts/sync-project-fields.mjs`). This plan must not create a third
  place that independently claims lifecycle state.
- **The 5-state vocabulary is presentation-only and derived.** Never stored,
  never a label, never a board field.
- **`Pull request merged → Done` and `Auto-close issue` stay OFF.**
- **PR bodies keep saying `Workstream: #N`, never `Closes #N`.**
- **`/status-all`'s existing behavior is untouched** — same buckets, same 48h
  stall rule and `stalled=24h` override, same label parsing, same "no item
  silently dropped" rule, same drill-down.
- **Exactly one label per prefix (`stage:`, `waiting:`, `mode:`) is a data
  invariant.** Neither skill silently resolves a violation.
- **`mode:` is never written by `/status`.** It is set at workstream creation
  and describes intent, which live PR evidence cannot re-derive.
- **Sensitive / disclosure-carve-out workstreams never become public issues**,
  are never written to, and — added in round 2 — are never *offered* one.
- **No hand-typed GitHub UI name is matched by exact string.**

## Settled Decisions

1. **Two skills, not one with a flag.**
2. **Per-session `/status` is write-through, and discloses the write every
   time.**
3. **The 5-state vocabulary is *derived*, not a new stored field.**
4. **`WATCHING` requires a live check in the same invocation.**
5. **Discovery with no issue → offer, never auto-create.**
6. **`/status` writes both the issue body and the labels (self-healing)** —
   *David, 2026-08-05.* Rejected alternative: narrative-only writes — #328
   shows body and labels go stale *together*, so healing one leaves the board
   contradicting the issue text, which is worse than uniform staleness.
7. **`/status-all` keeps its current urgency buckets** — *David, 2026-08-05.*
   Rejected alternative: 5 states fleet-wide — the buckets are tuned for
   scanning ten workstreams, and `WATCHING` would force a live check per
   workstream.
8. **Phases merge sequentially, never stacked.**
9. **`waiting:replit` reports as `WAITING ON YOU`** — *David, 2026-08-05
   (round 3).* Replit never acts autonomously; David runs the TEST_RUN and
   relays the result. Rejected alternatives: `WATCHING` with an "unverified"
   caveat (would carve an exception into the live-check rule, since a Replit
   run has no GitHub surface) and a sixth state (breaks the settled 5-state
   vocabulary). Keeps `WATCHING` meaning exactly one thing — external work
   verifiable on GitHub right now.

## Repo Context Inspected

- `.claude/skills/status/SKILL.md` (182 lines) — the skill being renamed;
  source of the `Workstream:\s*#(\d+)` PR-discovery convention.
- `docs/ai-context/workstream-tracking.md` — lifecycle, three label prefixes,
  ownership table, "what must never happen".
- `scripts/sync-project-fields.mjs` — `labelsToFieldValues`, throw-on-duplicate
  for **all** configured prefixes.
- `.github/workflows/project-sync.yml` — `labeled`/`unlabeled` fire as
  **separate** workflow runs (round-2 finding 5).
- `.claude/skills/plan-review-loop/SKILL.md` — the carve-out gate reused here.
- `.claude/skills/pr-watch/SKILL.md` — the concrete transition set the label
  matrix below is modeled on; `bugfix`, `pr-docs` — the other writers.
- `.agents/PLANS.md`, `docs/ai-context/decisions.md`, `current-roadmap.md`,
  `.agents/memory/github-project-field-names-need-normalized-matching.md`.
- **Live GitHub:** issue #328 (stale fixture), PR #329 (merged), #331, #333.

## Current Behavior

`/status` is **read-only** and fleet-wide: lists open issues, filters to those
with a `stage:` label, pulls sub-issues, regex-matches `Workstream:\s*#(\d+)`
across the 50 most-recently-updated PR bodies to build an issue→PR map, batches
a `pull_request_read` per linked PR, applies stall detection and blocker
restatement, renders three urgency buckets.

**The State of Play block exists only by example.** Two files refer to it; none
defines it. Its de-facto shape comes from issue #328 alone: an
`## State of Play` header, three bold fields (Stage / Waiting on / Last
movement), then `### What this is`, `### Where it actually stands`,
`### What's blocking`, `### What you need to do`, `### Artifacts`,
`### Downstream`, `### To resume`. **Formalizing this template is part of this
build.**

## Source-of-Truth Analysis

| Concept | Source of truth | This plan's effect |
| --- | --- | --- |
| Lifecycle stage, holder, mode | The issue's `stage:` / `waiting:` / `mode:` **labels** | Unchanged as SoT. `/status` becomes an additional *writer* of stage/waiting only. |
| Board fields | Projection of labels via the sync Action | Unchanged. Healing labels heals the board through the existing Action — no new board writer. |
| State of Play block | **Derived** rendering | Formalized. Rendered from the *same computed values* written to labels in the same operation. |
| The 5 states | **Derived, never stored** | Presentation only. |
| PR liveness | GitHub, live | Read per invocation; never cached into the issue as authority. |

**The duplicate-source-of-truth risk is the main thing to get right.** The
mitigation is a hard ordering requirement: `/status` **computes** state once
from live evidence → **writes the body** → **writes labels** → and **never
reads the block back as authority**. A future implementation that parses the
block and writes *that* to the labels would invert the SoT; the skill file
must state this prohibition explicitly, not merely imply it by step order.

## Proposed Design

### 1. `.claude/skills/status-all/SKILL.md` — the fleet view, renamed

`git mv` of the existing file. Changes limited to frontmatter `name:`,
a reworded `description:` that routes trigger phrases correctly and does not
capture the per-session question, and internal self-references. **No logic
changes.**

### 2. `.claude/skills/status/SKILL.md` — the new per-session view

**Ordered steps.** The ordering is load-bearing and each step says why.

1. **Identify the workstream.** In order: an issue number in the invocation; a
   `Workstream: #N` line in a PR opened by this session; the branch name
   matched against open issues. **Ambiguous or nothing found → ask, never
   guess** (writing to the wrong issue is this skill's worst failure).
2. **Discover the PR — explicitly, and only from a TRUSTED association.**
   *(round-2 finding 1; **materially hardened in round 5** — see below.)*
   `list_pull_requests(state: all, sort: updated, direction: desc, perPage: 50)`
   and regex `Workstream:\s*#(\d+)` over the bodies. The workstream's
   **current PR** is the most-recently-updated match **that passes the trust
   check**. Fallbacks when the window misses it: the issue body's
   `### Artifacts` section, then the branch name. **If a PR is found by any
   path, its live state must be read before deriving anything** — the #328
   self-heal depends entirely on this step.

   **The trust check, and why it is not optional** *(round-5 finding)*. This
   repository is **public**, and a PR body is **attacker-controlled input** —
   the repo's own agentic-action threat model already says so. Anyone can open
   a PR whose body reads `Workstream: #328`; because discovery takes the
   most-recently-updated match and step 9 *writes*, an outsider could steer
   `/status` into rewriting a maintainer's issue from a PR they control.
   **Inheriting this convention from the old read-only fleet report is not
   authorization**: a matching rule that was merely a display heuristic
   becomes a write-targeting primitive here, and it has to be re-earned.

   A discovered PR is trusted only when **both** hold:
   - its author is the **repository owner** (`author_association: OWNER`), and
   - its head branch lives in **this repository, not a fork**
     (`head.repo.full_name == base.repo.full_name`).

   **The issue-side link overrides everything.** When the issue body's
   `### Artifacts` section names a PR, that association wins outright,
   because the issue body is maintainer-controlled — it is the one side of
   the link an outsider cannot write. An untrusted PR is **ignored for
   derivation entirely** — not merely deprioritized — and its existence is
   reported in chat so a genuine mis-association is visible rather than
   silently dropped.
3. **Gather live evidence, batched, read-only.** Every source the later steps
   consume must be fetched **here** — a derivation rule that names an input
   step 3 never retrieves is a rule that silently degrades *(round-5
   finding)*.
   - One `issue_read` (labels, body, `has_children`).
   - **`issue_read(method: get_comments)`** — a separate collection in this
     repo's tooling, and one the activity clock depends on. Without it, an
     issue with a fresh human comment falls back to creation time and gets
     written as `STALLED`.
   - **The issue's event/label timeline**, paginated, so a label change by
     another writer counts as activity **and** so `/status`'s own label
     writes can be excluded **by actor** — the only workable way to tell
     "someone moved this" from "I moved this."
   - Where a PR was discovered and trusted, one `pull_request_read` covering
     `get` + `get_status` + `get_review_comments` + `get_commits`.
   - **When the discovered PR is merged, a ref-qualified lookup of the
     TEST_RUN document against `main`** — `get_file_contents(path: "docs/",
     ref: "main")` (or the equivalent targeted path check), never the local
     checkout and never the PR's own file list. *(round-4 finding 2)* Both
     alternatives are wrong for the same reason: the doc is **deleted in a
     later commit**, so the PR that added it always shows it present, and the
     working branch may not be `main` at all.
4. **Validate label invariants — before any write.** *(round-2 finding 10)*
   Missing or duplicated labels for **any** of `stage:`, `waiting:`, `mode:`
   is a report-only data error: report it, write nothing, stop. Rewriting
   stage/waiting while a duplicate `mode:` keeps the sync throwing would
   produce a "healed" run that leaves the board broken.
5. **Terminal check — stored `stage:done` short-circuits *label derivation*,
   not the whole run.** *(round-4 finding 1, corrected in round 5.)* If the
   **stored** stage is `done`:
   - **Skip label derivation and all label writes entirely.** This must happen
     **before** the label matrix runs. A completed feature still has its
     durable UAT doc on `main`, so running the matrix would derive `uat`/`david`
     and **rewrite `stage:done` back to `stage:uat`** — reopening finished
     workstreams and mutating their authoritative labels on every invocation.
     The order-0 *presentation* short-circuit does **not** prevent this: by
     then the wrong labels are already in the derived set the write step
     applies. **A presentation-layer guard cannot protect a write path.**
   - **But still render and refresh the block**, with `DONE` taken from the
     authoritative stored label, and still run the splice and disclosure
     paths. *(round-5 finding.)* `stage:done` is David's own later manual
     transition and **no writer updates the block at that moment**, so a
     blanket "write nothing" would leave the public narrative saying UAT or
     close-out **forever** — contradicting both the body/label coherence goal
     and the every-invocation-refreshes rule. The right scope of the
     short-circuit is *labels*, not *the run*.
6. **Derive** the labels (matrix below), then the presentation state.
7. **Render the candidate block in memory** — not yet written.
8. **Disclosure gate, on the rendered candidate.** *(round-2 finding 4)* The
   gate runs **here**, after the candidate text exists and before any write,
   because classifying whether a write discloses carve-out content requires
   seeing the actual text. Running it earlier would mean classifying from
   session memory. On a hit: **write nothing**, report in chat, say plainly
   the write was withheld and why.
9. **Write — body first, then labels, atomically per mutation.**
   *(round-2 findings 5 and 6; ordering rationale below.)*
10. **Report in chat**, sparse, disclosing the write and every label changed —
    including the no-change and partial-failure cases.

### The label-derivation matrix

*(round-2 finding 2 — the plan previously specified only the display state,
leaving implementers no spec for what to actually write.)*

Modeled on `pr-watch`'s existing transitions. `/status` writes **only**
`stage:` and `waiting:`, and **only** where live evidence entails a value that
differs from what's stored. **Where evidence is silent, labels are left
unchanged** — `/status` heals what it can prove and never invents a transition.

| Live evidence | `stage:` | `waiting:` |
| --- | --- | --- |
| No PR discovered by any path | unchanged | unchanged (report only) |
| Draft PR titled `[PLAN REVIEW]`, review requested, no Codex response since | `planning` | `codex` |
| Draft PR titled `[PLAN REVIEW]`, unanswered Codex findings | `planning` | `claude` |
| Draft PR titled `[PLAN REVIEW]`, Codex converged | `plan-approval` | `david` |
| PR open, CI failing | `code-review` | `claude` |
| PR open, CI in progress | `code-review` | `ci` |
| PR open, CI green, open Codex threads with no reply after them | `code-review` | `claude` |
| PR open, CI green, review requested and not yet landed | `code-review` | `codex` |
| PR open, CI green, no open threads, no pending review | `merge` | `david` |
| PR merged, a `docs/PR<N>_*_TEST_RUN.md` still present on `main` | `test-run` | `replit` |
| PR merged, no TEST_RUN doc, a `docs/PR<N>_*_UAT.md` exists | `uat` | `david` |
| PR merged, neither doc (e.g. `mode:docs` / `mode:devops`) | `close-out` | `david` |
| PR closed unmerged | unchanged | `david` (report — needs his decision) |

`mode:` is never written (see *Must Not Change*). Where two rows could match,
the **first** matching row wins, and the skill states the matched row in its
disclosure so a wrong derivation is visible rather than silent.

**On the `test-run` row** *(round-3 finding)*: a TEST_RUN doc is deliberately
transient — David deletes it once Replit has run it, so *"present on `main`"*
is a genuine live signal for "not yet run," and its absence is expected rather
than a bug (`CLAUDE.md`, the `pr-docs` pairing). That makes the
Merge → Test run → UAT progression derivable from repo evidence instead of
from session memory.

### The 5-state derivation

Applied to the **derived** labels from the matrix above, not the stored ones.

| Order | State | Condition |
| --- | --- | --- |
| 0 | `DONE` | `stage:done` — **short-circuits everything** *(round-2 finding 7)*, because a terminal workstream still carries a required `waiting:*` label and would otherwise report as WAITING ON YOU or STALLED forever |
| 1 | `WAITING ON YOU` | `waiting:david` **or `waiting:replit`** |
| 2 | `STALLED` | `waiting` ∈ {`claude`, `codex`, `ci`} and no relevant activity in > 48h |
| 3 | `WATCHING` | `waiting:codex` or `waiting:ci`, **and** a live check *in this invocation* confirms an open PR with pending external work — CI in progress, an unanswered review thread, **or a requested review that has not landed** |
| 4 | `WORKING` | **the residual** — everything not caught above |

**Why `waiting:replit` is `WAITING ON YOU`** *(David, 2026-08-05, round-3
finding)*: Replit never acts autonomously — David hands it the TEST_RUN doc and
relays the result — so "waiting on Replit" is in practice "waiting on David to
run it or report back." Considered and rejected: mapping it to `WATCHING` with
an "unverified" caveat, which would have carved an exception into the
live-check rule (a Replit run has **no GitHub surface** to check), and adding a
sixth state, which breaks the settled 5-state vocabulary. This mapping keeps
`WATCHING` meaning exactly one thing: *external work I can verify on GitHub,
right now.*

**Why `WORKING` is the residual** *(round-3 finding)*: it makes the table total
by construction rather than by enumeration. Concretely it absorbs the case
Codex found — `waiting:codex`/`waiting:ci` with **no PR discovered** — and the
classification is honest rather than merely convenient: if no PR exists, there
is nothing for Codex or CI to be working on, so the ball is genuinely back with
me.

**Totality — now by construction, not by assertion** *(round-3 finding
supersedes round-2 finding 8's weaker version)*. Step 4 has already validated
that exactly one `waiting:` label is present, so the five values partition
cleanly: `david`/`replit` → order 1; `done` → order 0; `claude`/`codex`/`ci`
→ order 2 if aged, order 3 if live-confirmed, order 4 otherwise. **A legal
label combination is never reported as a data error.** That earlier framing
was wrong: routing valid states to "data error" misclassifies them rather than
covering them.

**What `data error` does cover** *(round-4 finding 3 — round 3 over-narrowed
this and contradicted the splice contract)*. It is a **report-only, no-write
stop** in exactly two structural cases, both of which make a *correct* write
impossible rather than merely unusual:

1. **Label-invariant violation** — a missing or duplicated label on any of the
   three prefixes (step 4).
2. **Ambiguous block structure** — more than one `## State of Play` heading,
   where no splice boundary can be chosen without risking content loss
   (splice contract).

What it does **not** cover is any legal `stage:`/`waiting:` combination. The
distinction is *"the artifact is malformed"* versus *"the state is unusual"* —
only the former is an error.

### The activity clock — what counts as "relevant activity"

*(round-4 finding 4. This is the subtlest failure in the plan so far and it is
self-inflicted by write-through itself.)*

`STALLED` depends on "no relevant activity in > 48h." The obvious source —
the issue's `updated_at` — is **disqualified**, because `/status` rewrites the
State of Play body on **every** invocation, which advances that very
timestamp. On a no-PR workstream the loop is closed and vicious: one `/status`
run makes the next run see "fresh," so an aged workstream reports `WORKING`
forever, and `STALLED` can never fire again for anyone who checks status more
often than every 48 hours. The skill would permanently mask the exact
condition it exists to surface.

**Relevant activity is therefore defined as events `/status` cannot itself
produce:**

- PR commits, comments, reviews, review threads, and CI runs;
- issue **comments** by any author;
- label changes attributable to another writer.

**Explicitly excluded:** the issue's `updated_at`, and any issue-body revision
whose only change is the State of Play block. When no qualifying event exists
at all, the anchor is the issue's **creation** time — never the last
`/status` touch.

**What makes `WATCHING` falsifiable:** if the live check shows the PR merged,
closed, or idle with nothing pending, WATCHING is unavailable and the state is
recomputed.

### The State of Play splice contract

*(round-2 finding 9 — formalizing the template was not enough to make writes
safe.)*

- **Boundary:** the block is the `## State of Play` heading through the next
  heading at the same level (`## `) or end-of-body.
- **Preserve everything outside it**, verbatim. `/status` replaces exactly one
  span and never rewrites the whole body.
- **Absent block** (older workstreams predating #328's shape): insert a fresh
  block at the **top** of the body, preserving all existing content below.
- **More than one `## State of Play` heading:** data error — report, write
  nothing. Splicing into an ambiguous boundary risks destroying content.
- **Never parse the block to derive state.** It is an output, never an input.

### Write ordering and partial-failure recovery

*(round-2 findings 5 and 6.)*

- **Re-read and revalidate immediately before the label write.** *(round-5
  finding — this one falsifies a claim I made in R3.)* The terminal check and
  the derivation happen several network calls before the write, and a full-set
  replacement built from that older snapshot will happily clobber anything
  that arrived in the gap. Two concrete losses: David sets `stage:done` mid-run
  and the write replaces it with `stage:uat`; or another writer adds an
  unrelated label and the replacement drops it. **The "next run resolves
  toward truth" argument does not cover this** — it assumes the write only
  ever *stales*, but here the write **erases the only authoritative
  completion signal**, and no later run can recover what is gone. So:
  re-read the labels immediately before mutating, and if **anything** in the
  three tracked prefixes differs from the snapshot the derivation used,
  **abort the label write** and report — recompute on the next invocation
  rather than overwrite a change made by someone with better information.
  Unrelated labels are carried through from the **fresh** read, never the
  stale one.
- **Each label mutation is a single atomic set-labels-style replacement** of
  the full label set, preserving unrelated labels — never add-then-remove.
  `labeled`/`unlabeled` fire as separate workflow runs, so `stage:uat` added
  before `stage:code-review` is removed makes `labelsToFieldValues` throw, and
  the reverse order briefly clears the board field.
- **Body first, then labels.** If the body write succeeds and the label write
  fails, the narrative David reads is truthful while the board lags — the
  pre-existing condition, not a new contradiction. The reverse order would
  produce a healed board contradicting a stale narrative, which is precisely
  the state Settled Decision 6 calls worse than uniform staleness.
- **On any partial failure:** report loudly in chat, naming exactly what
  succeeded and what did not. **Recovery is the next run**, which is safe
  because the skill is idempotent by construction — it recomputes from live
  evidence and rewrites both. The skill must never imply a complete write.

### 3. `docs/ai-context/workstream-tracking.md` — four additions

- The **State of Play template** plus the **splice contract**.
- The **label-derivation matrix**.
- The **5-state table with precedence**, marked derived-never-stored.
- A **`/status` row** in the ownership table, and a rewrite of the `## /status`
  section to describe both skills.

## Data Model and Migration Impact

**None.** No schema, stored data, migration, or backfill. The only mutated
state is GitHub issue labels and issue-body text, both already mutated by
existing skills.

## Runtime Behavior

| Situation | Behavior |
| --- | --- |
| Discovery, no issue exists, ordinary work | Report from session context; **offer** to open the issue; never auto-create. |
| Discovery, no issue, **carve-out content** | *(round-2 finding 12)* Run the carve-out check **before offering**. On a hit, report "private tracking only" and do **not** offer a public issue — otherwise the skill steers David into creating exactly the issue the write gate would later refuse to edit. |
| Issue exists, no PR found | Derive from labels + **the activity clock** (never `issue.updated_at` — see that section); leave labels unchanged; `WATCHING` unavailable, so the state falls to the `WORKING` residual (or `STALLED` if aged) — **not** a data error. |
| A `Workstream: #N` PR match fails the trust check | Ignore it for derivation entirely; **report** the untrusted match so a genuine mis-association is visible. Never let it influence a write. |
| `waiting:replit` / `stage:test-run` | `WAITING ON YOU`, per David's 2026-08-05 call. The TEST_RUN doc's presence on `main` is the live signal that it hasn't been run yet. |
| Missing/duplicate label on any of the three prefixes | Report-only data error; no write. |
| Ambiguous workstream identity | Ask. Never write on a guess. |
| PR merged while labels say code-review | The self-heal: correct labels, rewrite block, disclose both. |
| Body write fails | Report; no label write attempted (body is first). |
| Label write fails after body succeeded | Report the partial state explicitly; next run repairs. |
| Labels changed concurrently between derivation and the write | **Abort the label write** and report; the concurrent writer had better information. The body write already happened and stands. Never merge-and-proceed — that would mean guessing whose intent wins. |
| Carve-out content in the candidate | No write; chat only; say why. |
| No change needed | Still disclose: "state confirmed, no change." Silence is indistinguishable from a skipped write. |

## Admin/User UX Impact

No product surface. Output is David's chat text and the issue body. Chat output
stays sparse per CLAUDE.md. The 🛑 banner ritual is **not** used — this is a
report, not a blocking question.

## Security, Permissions, and Validation

Write-through introduces a genuinely new risk: read-only `/status` could never
leak, but a skill that automatically writes session narrative into a **public**
issue body can. `Overhypeme` is public; the Project is private, issue bodies
are not.

**And a second, sharper risk found in round 5: attacker-controlled write
targeting.** The repo is public, so a PR body — which this skill uses to
decide *which issue to write to* — is attacker-controlled input. The trust
check in step 2 (owner-authored **and** same-repo head, with the
maintainer-controlled issue-side `### Artifacts` link overriding) is what
stops an outsider steering a write into a maintainer's issue. The general
lesson, worth carrying past this plan: **a matching heuristic that was safe
while read-only is not automatically safe once it selects a write target.**

- **PR-to-workstream associations are authenticated before they can influence
  a write** (step 2); an untrusted match is ignored for derivation and
  reported, never silently dropped.
- **The disclosure gate runs on the rendered candidate** (step 8), before any
  write — not on session memory, and not before the text exists.
- **The same check gates the Discovery-path issue *offer*** (round-2 finding
  12), so the skill never steers David toward creating a public issue for
  carve-out work.
- **Writes are scoped** to one identified issue's labels and body. No
  fleet-wide mutation, no PR writes, no board writes.
- **No new credentials** — same GitHub MCP surface as `pr-watch`.
- **Review-thread resolution stays David's.**

## Testing Plan

Markdown skill/contract files, so no unit-testable code path. Verification is
mechanical checks plus live acceptance cases.

1. **`pnpm run check:docs`** — validates relative links and cited repo paths
   across all doc files; catches the rename's dangling references.
2. **`grep` sweep** for surviving `skills/status/` and bare `/status`
   references that should read `/status-all`.
3. **Self-heal acceptance — issue #328.** Currently stale in a known way
   (`stage:code-review` + `waiting:codex`; PR #329 merged). A run must
   discover PR #329 **via step 2's explicit discovery path**, derive
   `uat`/`david` (or `close-out`/`david` per the matrix), rewrite both labels
   atomically, splice the block, and disclose. **Issue-only invocation is the
   required form of this test** *(round-2 finding 1)* — invoking `/status 328`
   with no session PR context is exactly the case that fails if discovery is
   underspecified.
4. **WATCHING falsifiability — redesigned.** *(round-2 finding 3 — the
   previous negative test was worthless: after the #328 run the labels are
   `waiting:david`, so WATCHING is unreachable by precedence whether or not a
   live check happened, and the test would have passed for the wrong reason.)*
   The replacement uses a workstream that **remains eligible** for WATCHING:
   - **Positive:** a workstream at `waiting:codex` whose PR is genuinely open
     with a pending review → must report `WATCHING`, **and** the invocation
     must show a fresh `pull_request_read` for that PR.
   - **Negative (the real test):** the same workstream after its PR has
     merged, with labels still `waiting:codex` — still *eligible* by label, so
     only a live check can rule WATCHING out. Reporting `WATCHING` proves
     memory was used; reporting the corrected state proves the live check ran.
5. **Partial-write acceptance** *(round-2 finding 6)*: with the label write
   forced to fail after a successful body write, the run must report the
   partial state explicitly and must not claim a complete write.
6. **Carve-out negatives:** (a) carve-out content in the candidate → write
   withheld, reason stated; (b) carve-out Discovery session → "private
   tracking only", **no** issue offered.
7. **Splice negatives:** issue with no block → block inserted, existing content
   preserved; issue with two `## State of Play` headings → data error, no
   write.
8. **Holder-coverage acceptance matrix** *(round-3 finding)*. Round 2 proved I
   can't establish totality by inspection, so it gets asserted case by case —
   **every** `waiting:` value, in both the PR-present and no-PR forms, must
   produce exactly one of the five states and **never** a data error:

   | `waiting:` | With a discovered PR | With no PR found |
   | --- | --- | --- |
   | `david` | `WAITING ON YOU` | `WAITING ON YOU` |
   | `replit` (at `stage:test-run`) | `WAITING ON YOU` | `WAITING ON YOU` |
   | `claude` | `WORKING` (fresh) / `STALLED` (> 48h) | `WORKING` / `STALLED` |
   | `codex` | `WATCHING` if live-confirmed pending; else `WORKING` / `STALLED` | `WORKING` / `STALLED` — **never** `WATCHING` |
   | `ci` | `WATCHING` if CI in progress; else `WORKING` / `STALLED` | `WORKING` / `STALLED` — **never** `WATCHING` |

   Plus `stage:done` with **each** of the five `waiting:` values → `DONE` every
   time, exercising the order-0 short-circuit against the exact combination
   round 2 found reachable.
9. **Terminal-`done` non-mutation** *(round-4 finding 1 — the round-3
   acceptance case above could pass on a no-PR fixture while the real path
   reopened completed work).* Three fixtures, each `stage:done` **with a
   discovered merged PR**: (a) TEST_RUN doc still on `main`, (b) UAT doc only,
   (c) neither doc. All three must report `DONE` and perform **zero writes** —
   specifically, `stage:done` must not be rewritten to `uat` or `test-run`.
   A fixture without a merged PR does **not** satisfy this case.
10. **TEST_RUN `main` lookup** *(round-4 finding 2)*: a fixture where the local
    branch and current `main` **disagree** about the TEST_RUN doc's existence
    — the doc present locally, deleted on `main`. The derivation must follow
    `main` (→ `uat`/`david`), proving the signal came from a ref-qualified
    live lookup rather than the checkout or the PR's file list.
11. **Activity clock excludes self-writes** *(round-4 finding 4)*: an aged
    (> 48h) no-PR workstream at `waiting:claude`. Run `/status` twice. The
    **second** run must still report `STALLED`. Reporting `WORKING` proves the
    freshness came from the first run's own body write — the self-invalidating
    loop.
12. **Splice-error preservation** *(round-4 finding 3)*: the duplicate
    `## State of Play` fixture from case 7 must still be a report-only,
    no-write stop after the `data error` category was narrowed — confirming
    the narrowing didn't delete the structural safety stop.
13. **Forged workstream association — the security negative** *(round-5
    finding)*. A PR authored by a **non-owner from a fork**, whose body says
    `Workstream: #<N>` and which is the **most recently updated** match, must
    **not** be used to derive or write anything for issue `#<N>`. The run
    reports the untrusted match rather than silently ignoring it. This is the
    case that proves the trust check is real rather than decorative — the
    forged PR is deliberately the *newest*, so recency alone would select it.
14. **Terminal block still refreshes** *(round-5 finding)*: a `stage:done`
    workstream whose block still narrates UAT. The run must **refresh the
    block** to `DONE` while performing **zero label writes** — proving the
    short-circuit scopes to labels rather than aborting the run.
15. **Activity-clock sources, one case per class** *(round-5 finding)*: an
    aged workstream made fresh by (a) a human issue comment, (b) a label
    change by another actor, (c) a PR commit. Each must report `WORKING`,
    not `STALLED` — proving step 3 actually fetches every source the clock
    names. Paired with case 11's negative, where the only recent event is
    `/status`'s own write and the answer must stay `STALLED`.
16. **Concurrent-write interleaving** *(round-5 finding)*: `stage:done` is
    applied by another actor **between** derivation (step 6) and the write
    (step 9). The run must **abort the label write** and report, leaving
    `stage:done` intact. Reporting success here — or leaving `stage:uat`
    behind — is the unrecoverable failure, since the completion signal has no
    other source to be restored from.

## Implementation Steps

1. `git mv .claude/skills/status .claude/skills/status-all`; update frontmatter
   and self-references. No logic change.
2. Add the **State of Play template + splice contract** to
   `workstream-tracking.md`.
3. Add the **label-derivation matrix** to `workstream-tracking.md`.
4. Add the **5-state table + precedence** (DONE short-circuit at order 0),
   marked derived-never-stored.
5. Add the **`/status` ownership row**; rewrite that doc's `## /status`
   section.
6. Write `.claude/skills/status/SKILL.md` implementing the ten ordered steps,
   including the explicit SoT prohibition ("never parse the block to derive
   state").
7. Sweep remaining cross-references (`AGENTS.md` routing if enumerated).
8. **Reconcile `decisions.md`** *(round-2 finding 11)*: the two entries live on
   unmerged PR #331. Once it merges, verify they match the final approved plan
   and amend if the review loop moved anything; if #331 has not merged when
   this work lands, carry the entries here instead so the rationale is never
   only on a closed branch.
9. Verify: `check:docs`, the grep sweep, then **run every acceptance case,
   3–16** — not just the original 3–7. *(round-5 finding: these are
   manual-only checks, so a case the implementation step doesn't execute is a
   case that never runs. Listing them elsewhere in the plan is not the same as
   running them.)* Any case added by a later review round joins this range;
   the step says "all of them", not a frozen list.

Steps 1–5 are mechanical and independent; step 6 depends on 2–4.

## Risks and Mitigations

- **R1 — Public disclosure via automatic writes.** Gate runs on the rendered
  candidate before any write, and also gates the Discovery-path offer.
- **R2 — The narrative block becomes a second source of truth.** Mitigated by
  the ordering (compute → body → labels, all from one computation) *and* by an
  explicit prohibition in the skill file against ever parsing the block to
  derive state. The prohibition matters more than the ordering: ordering
  survives only while someone remembers why.
- **R3 — Self-healing labels fight a mid-transition writer.** `/status` writes
  only where live evidence differs, and reports rather than rewrites on a data
  error. **Corrected in round 5:** this risk previously claimed a race
  "resolves toward truth on the next run rather than ping-ponging." That is
  **false for the destructive case** and must not be restored — a full-set
  label replacement built from a stale snapshot can *erase* a `stage:done`
  set mid-run, and no later run can recover a signal that has no other
  source. The actual mitigation is the **pre-write re-read and abort** (see
  *Write ordering*), not eventual convergence.
- **R4 — Invalid intermediate label states breaking the sync.** Atomic
  set-labels replacement; never add-then-remove.
- **R5 — Partial write leaves board and narrative contradicting.** Body-first
  ordering makes the surviving inconsistency the benign direction; the run
  reports it; the idempotent next run repairs it.
- **R6 — Two vocabularies to hold in mind.** The 5 states are documented
  strictly as a derived view with an explicit mapping, and kept out of the
  fleet view (Settled Decision 7).
- **R7 — Muscle memory: David types `/status` expecting the fleet view.** The
  per-session output names `/status-all` as the alternative.
- **R8 — Writing to the wrong workstream.** Ask-don't-guess at step 1, which
  is why identification precedes everything else.

## Questions for David

**None.** Both product forks were resolved in the pre-plan conversation
(Settled Decisions 6 and 7). Round 2's twelve findings were all specification
gaps in this plan, resolved above without needing a product decision.

## Definition of Done

- [ ] `/status-all` exists, behaves exactly as today's `/status` did, and no
      cross-reference still points at the old path.
- [ ] `/status` exists, is per-session, and reports the workstream, one of the
      five states, what's next, and how it fits.
- [ ] Every invocation writes body + labels from live evidence and
      **discloses** it — including no-change and partial-failure cases.
- [ ] The label-derivation matrix is documented and implemented; `mode:` is
      never written; silent evidence leaves labels unchanged.
- [ ] Label writes are atomic set-replacements preserving unrelated labels.
- [ ] `WATCHING` is unreachable without a live check, proven by the
      **eligibility-preserving** negative case, not by a precedence artifact.
- [ ] `stage:done` short-circuits to `DONE`, verified against **all five**
      `waiting:` values.
- [ ] The five states are **total by construction** — the holder-coverage
      matrix passes for every `waiting:` value in both PR-present and no-PR
      forms, and **no legal label combination is ever reported as a data
      error** — that category covers **only** malformed artifacts, in both its
      forms: a missing/duplicated label on any of the three prefixes, **and**
      an ambiguous State of Play structure (more than one matching heading).
- [ ] `waiting:replit` reports `WAITING ON YOU`; `WATCHING` is never claimed
      without a live GitHub check.
- [ ] **A stored `stage:done` workstream never has its labels mutated** —
      verified with a discovered merged PR and its durable UAT doc present,
      the case that would otherwise reopen finished work on every invocation
      — **while its block still refreshes**, so a terminal workstream's
      narrative can't sit stale forever.
- [ ] **Write targeting is authenticated** — a forged, newer, fork-authored
      `Workstream: #N` PR body cannot influence what `/status` writes.
- [ ] **The label write revalidates immediately before mutating** and aborts
      on any concurrent change to the tracked prefixes, so a `stage:done` set
      mid-run is never overwritten.
- [ ] **Every source the activity clock names is actually fetched in step 3**
      — issue comments and the label timeline included, proven by one
      acceptance case per activity class.
- [ ] The TEST_RUN signal comes from a **ref-qualified `main` lookup**, not the
      local checkout or the PR's file list.
- [ ] **`STALLED` survives a `/status` run** — the activity clock excludes this
      skill's own body writes, proven by the two-run aged-workstream case.
- [ ] The splice contract is documented and its absent/duplicate negatives
      pass.
- [ ] Missing/duplicate labels on any of the three prefixes block writes.
- [ ] Both carve-out negatives pass, including the Discovery-offer case.
- [ ] `pnpm run check:docs` passes; grep sweep clean.
- [ ] **Exercisable end-to-end:** `/status 328`, invoked with no session PR
      context, corrects #328 to the truthful stage and rewrites its block.
