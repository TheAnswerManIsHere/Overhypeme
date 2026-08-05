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
2. **Discover the PR — explicitly, not "where linked."** *(round-2 finding 1)*
   `list_pull_requests(state: all, sort: updated, direction: desc, perPage: 50)`
   and regex `Workstream:\s*#(\d+)` over the bodies — the same convention
   `/status-all` already relies on, so there is one discovery mechanism, not
   two. The workstream's **current PR** is the most-recently-updated match.
   Fallbacks when the window misses it: the issue body's `### Artifacts`
   section, then the branch name. **If a PR is found by any path, its live
   state must be read before deriving anything** — the #328 self-heal depends
   entirely on this step, and an issue-only invocation that skips it is the
   exact failure that leaves `code-review`/`codex` standing.
3. **Gather live evidence, batched, read-only.** One `issue_read` (labels,
   body, `has_children`); where a PR was discovered, one `pull_request_read`
   covering `get` + `get_status` + `get_review_comments`.
4. **Validate label invariants — before any write.** *(round-2 finding 10)*
   Missing or duplicated labels for **any** of `stage:`, `waiting:`, `mode:`
   is a report-only data error: report it, write nothing, stop. Rewriting
   stage/waiting while a duplicate `mode:` keeps the sync throwing would
   produce a "healed" run that leaves the board broken.
5. **Derive** the labels (matrix below), then the presentation state.
6. **Render the candidate block in memory** — not yet written.
7. **Disclosure gate, on the rendered candidate.** *(round-2 finding 4)* The
   gate runs **here**, after the candidate text exists and before any write,
   because classifying whether a write discloses carve-out content requires
   seeing the actual text. Running it earlier would mean classifying from
   session memory. On a hit: **write nothing**, report in chat, say plainly
   the write was withheld and why.
8. **Write — body first, then labels, atomically per mutation.**
   *(round-2 findings 5 and 6; ordering rationale below.)*
9. **Report in chat**, sparse, disclosing the write and every label changed —
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
covering them. `data error` is reserved **exclusively** for genuine invariant
violations — a missing or duplicated label on any of the three prefixes —
which step 4 catches before any derivation runs.

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
| Issue exists, no PR found | Derive from labels + issue timestamps; leave labels unchanged; `WATCHING` unavailable, so the state falls to the `WORKING` residual (or `STALLED` if aged) — **not** a data error. |
| `waiting:replit` / `stage:test-run` | `WAITING ON YOU`, per David's 2026-08-05 call. The TEST_RUN doc's presence on `main` is the live signal that it hasn't been run yet. |
| Missing/duplicate label on any of the three prefixes | Report-only data error; no write. |
| Ambiguous workstream identity | Ask. Never write on a guess. |
| PR merged while labels say code-review | The self-heal: correct labels, rewrite block, disclose both. |
| Body write fails | Report; no label write attempted (body is first). |
| Label write fails after body succeeded | Report the partial state explicitly; next run repairs. |
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

- **The disclosure gate runs on the rendered candidate** (step 7), before any
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
6. Write `.claude/skills/status/SKILL.md` implementing the nine ordered steps,
   including the explicit SoT prohibition ("never parse the block to derive
   state").
7. Sweep remaining cross-references (`AGENTS.md` routing if enumerated).
8. **Reconcile `decisions.md`** *(round-2 finding 11)*: the two entries live on
   unmerged PR #331. Once it merges, verify they match the final approved plan
   and amend if the review loop moved anything; if #331 has not merged when
   this work lands, carry the entries here instead so the rationale is never
   only on a closed branch.
9. Verify: `check:docs`, grep sweep, then acceptance cases 3–7.

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
  only where live evidence differs, reports rather than rewrites on a data
  error, and writes what GitHub currently says — so a race resolves toward
  truth on the next run rather than ping-ponging.
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
      error** (that is reserved for missing/duplicate labels alone).
- [ ] `waiting:replit` reports `WAITING ON YOU`; `WATCHING` is never claimed
      without a live GitHub check.
- [ ] The splice contract is documented and its absent/duplicate negatives
      pass.
- [ ] Missing/duplicate labels on any of the three prefixes block writes.
- [ ] Both carve-out negatives pass, including the Discovery-offer case.
- [ ] `pnpm run check:docs` passes; grep sweep clean.
- [ ] **Exercisable end-to-end:** `/status 328`, invoked with no session PR
      context, corrects #328 to the truthful stage and rewrites its block.
