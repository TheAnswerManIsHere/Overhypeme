# Plan — Split `/status` into a write-through per-session view and a fleet-wide `/status-all`

> Feature-building mode. Draft for Codex plan review; **not approved**.
> Design settled with David 2026-08-05 (see
> [`decisions.md`](../ai-context/decisions.md)); two implementation forks
> resolved by David in the pre-plan conversation, recorded under *Settled
> Decisions* (6) and (7).

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
   WATCHING after an actual live GitHub check *in that invocation*. Believing
   "I'm watching PR #X" is precisely how #328 went stale.
5. **Discovery with no issue yet** → `/status` says so plainly and **offers**
   to open the workstream issue. It never opens one unasked.
6. **Fleet-wide `/status-all`** is today's `/status`, renamed, behavior
   unchanged.

## Must Not Change

- **Labels stay the single source of truth**; the Project board stays a
  projection of them via `.github/workflows/project-sync.yml`
  (`scripts/sync-project-fields.mjs`). This plan must not create a third
  place that independently claims lifecycle state.
- **The 5-state vocabulary is presentation-only and derived.** It is never
  stored anywhere, never becomes a label, and never becomes a board field.
- **`Pull request merged → Done` and `Auto-close issue` stay OFF** on the
  Project. A merge is followed by Test run and UAT; the board must never claim
  work is verified before David has verified it.
- **PR bodies keep saying `Workstream: #N`, never `Closes #N`.**
- **`/status-all`'s existing behavior is untouched** — the same 🛑 NEEDS YOU /
  ⚠️ STALLED / IN PROGRESS buckets, the same 48-hour stall rule and its
  `stalled=24h` override, the same label parsing, the same "no item silently
  dropped" rule, the same `/status-all <issue-number>` drill-down.
- **Two labels sharing a prefix stays a flagged data error.** Neither skill
  silently picks a winner (matching `labelsToFieldValues`, which throws).
- **Sensitive / disclosure-carve-out workstreams never become public issues**,
  and — new, and load-bearing here — never get written to by `/status`.
- **No hand-typed GitHub UI name is matched by exact string** (the `Waiting On`
  vs `Waiting on` failure, `.agents/memory/github-project-field-names-need-normalized-matching.md`).

## Settled Decisions

1. **Two skills, not one with a flag.** The fleet view and the session view
   have different inputs, different costs, and different output shapes.
2. **Per-session `/status` is write-through, and discloses the write every
   time.**
3. **The 5-state vocabulary is *derived*, not a new stored field** — computed
   from (`stage:`, `waiting:`, live PR state, last-activity age). Storing it
   would create the duplicate source of truth *Must Not Change* forbids.
4. **`WATCHING` requires a live check in the same invocation.**
5. **Discovery with no issue → offer, never auto-create.** David decides what
   becomes a tracked workstream.
6. **`/status` writes both the issue body and the labels (self-healing)** —
   *David, 2026-08-05.* Considered and rejected: writing only the narrative
   block. Rejected because #328 demonstrates body and labels go stale
   *together*; refreshing one leaves the board actively contradicting the issue
   body, which is worse than uniform staleness. Consequence accepted:
   `/status` becomes a legitimate label writer and earns a row in
   `workstream-tracking.md`'s ownership table.
7. **`/status-all` keeps its current urgency buckets** — *David, 2026-08-05.*
   Considered and rejected: adopting the 5 states fleet-wide. Rejected on two
   grounds: the buckets are tuned for scanning ten workstreams at once (a
   different job from describing one), and `WATCHING` would require a live
   per-workstream check, making the fleet run materially more expensive for no
   triage gain.
8. **Phases merge sequentially, never stacked** (settled in the same
   conversation, carried here because it constrains any future multi-phase
   split of this work).

## Repo Context Inspected

- `.claude/skills/status/SKILL.md` (182 lines) — the skill being renamed.
- `docs/ai-context/workstream-tracking.md` — the shared cross-agent contract:
  lifecycle, the three label prefixes, the ownership table, the "what must
  never happen" list.
- `scripts/sync-project-fields.mjs` — `labelsToFieldValues`, the
  labels→board projection and its throw-on-ambiguity behavior.
- `.claude/skills/plan-review-loop/SKILL.md` — the disclosure carve-out
  pattern this plan reuses for writes.
- `.claude/skills/pr-watch/SKILL.md`, `.claude/skills/bugfix/SKILL.md`,
  `.claude/skills/pr-docs/SKILL.md` — the existing label writers, to confirm
  where a new writer would and would not collide.
- `.agents/PLANS.md`, `docs/ai-context/decisions.md`,
  `docs/ai-context/current-roadmap.md`.
- `.agents/memory/github-project-field-names-need-normalized-matching.md`.
- **Live GitHub:** issue #328 (the stale fixture), PR #329 (merged), PR #331.

## Current Behavior

`/status` is **read-only** and fleet-wide. It lists open issues, filters to
those carrying a `stage:` label, pulls sub-issues, regex-matches
`Workstream:\s*#(\d+)` out of the 50 most-recently-updated PR bodies to build
an issue→PR map, batches a `pull_request_read` per linked PR, applies stall
detection and plain-language blocker restatement, and renders three urgency
buckets. `/status <issue-number>` drills into one issue.

**The State of Play block exists only by example.** `status/SKILL.md` refers to
"its State of Play block" and my new `decisions.md` entry names it, but **no
file defines what it contains.** Its de-facto shape comes from a single
instance — issue #328, which I authored earlier today: an `## State of Play`
header, three bold fields (Stage / Waiting on / Last movement), then
`### What this is`, `### Where it actually stands`, `### What's blocking`,
`### What you need to do`, `### Artifacts`, `### Downstream`, `### To resume`.
A write-through skill cannot target an undefined structure, so **formalizing
this template is part of this build**, not a nicety.

## Source-of-Truth Analysis

| Concept | Source of truth | This plan's effect |
| --- | --- | --- |
| Lifecycle stage, who's holding it, mode | The issue's `stage:` / `waiting:` / `mode:` **labels** | Unchanged as SoT. `/status` becomes an additional *writer*, never a competing store. |
| Board `Status` / `Waiting On` / `Mode` fields | Projection of labels via the sync Action | Unchanged. Self-healing labels means the board heals too, through the existing Action — no new board writer. |
| State of Play block (narrative) | **Derived**, human-readable rendering | Formalized as a template. Its Stage/Waiting lines are rendered from the *same computed values* written to the labels in the same operation, so the two cannot disagree at write time. |
| The 5-state vocabulary | **Derived, never stored** | Presentation only. |
| PR liveness (CI, threads, merged-ness) | GitHub, live | Read per invocation; never cached into the issue as authority. |

**The duplicate-source-of-truth risk is real and is the main thing to get
right.** Making a narrative block writable invites it to become a second place
claiming stage. The mitigation is ordering, and it is a hard requirement on the
implementation: `/status` **computes** state once from live evidence, then
**writes labels**, then **renders the block from those same computed values**.
The block is never authored independently of the labels, and never read back as
authority. (See *Risks* R2 for the failure this ordering prevents.)

## Proposed Design

### 1. `.claude/skills/status-all/SKILL.md` — the fleet view, renamed

`git mv` of the existing file. Changes limited to: frontmatter `name:`
(`status` → `status-all`); `description:` reworded so the trigger phrases route
correctly and explicitly *don't* capture the per-session question; internal
self-references (`/status` → `/status-all`, including the `stalled=24h` example
and the `/status <issue-number>` drill-down heading). **No logic changes.**

### 2. `.claude/skills/status/SKILL.md` — the new per-session view

Steps:

1. **Identify this session's workstream.** In order: an issue number David
   named in the invocation; a `Workstream: #N` reference in a PR opened by this
   session; the branch name matched against open issues' bodies. **Ambiguous or
   nothing found → ask, never guess** (guessing writes to the wrong issue,
   which is the worst failure this skill has).
2. **Disclosure gate (before any write).** If the workstream is a
   sensitive/carve-out workstream, or the state to be written would put
   carve-out content (unpatched-vulnerability specifics, auth-bypass detail,
   secrets, payment-fraud paths, private customer data, embargoed plans) into a
   **public** issue body — do not write. Report in chat and say plainly that
   the write was withheld and why.
3. **Gather live evidence, batched.** One `issue_read` (labels + body +
   `has_children`), and where a PR is linked one `pull_request_read` covering
   `get` + `get_status` + `get_review_comments`.
4. **Derive the state** (table below).
5. **Write** — labels first, then the rendered State of Play block.
6. **Report in chat**, sparse, and **disclose the write** including any label
   that changed.

### The 5-state derivation

| State | Derived when |
| --- | --- |
| `WAITING ON YOU` | `waiting:david` — any stage |
| `STALLED` | `waiting` ≠ `david` **and** no relevant activity in > 48h |
| `WATCHING` | `waiting:codex` or `waiting:ci`, **and** a live check *in this invocation* confirms an open PR with CI in progress or an unanswered review thread |
| `WORKING` | `waiting:claude`, activity within 48h |
| `DONE` | `stage:done`, or `stage:close-out` with its PR merged and no open gate |

**Precedence, applied top-down as listed.** A workstream can match several
rows; `WAITING ON YOU` always wins (a David-gate is never downgraded to
STALLED), and `STALLED` outranks `WATCHING` (believing you're watching
something that has been silent for three days is the exact failure mode). This
precedence is stated in the skill, not left to inference.

**What makes `WATCHING` falsifiable:** if the live check shows the PR merged or
closed, WATCHING is unavailable and the state is recomputed — which is
precisely what converts #328 from `WATCHING` to `WAITING ON YOU` (🛑 UAT).

### 3. `docs/ai-context/workstream-tracking.md` — three additions

- **The State of Play template**, formalized from #328's shape. Canonical home
  is this shared doc, not the skill file, because Codex reads these issue
  bodies too.
- **The 5-state derivation table and its precedence**, marked explicitly as a
  derived presentation vocabulary that is never stored.
- **A `/status` row in the ownership table**, and a rewrite of the `## /status`
  section (which currently describes a read-only skill) to describe both
  skills and which one owns which question.

## Data Model and Migration Impact

**None.** No schema, no stored data, no migration, no backfill. The only
mutated state is GitHub issue labels and issue body text, both already mutated
by existing skills. The `docs/ai-context` doc changes are prose.

## Runtime Behavior

Edge cases the skill must handle explicitly:

| Situation | Behavior |
| --- | --- |
| Discovery, no issue exists | Report state from session context; **offer** to open the workstream issue; never auto-create. |
| Issue exists, no PR yet | Derive from labels + issue timestamps; skip the PR call. `WATCHING` is unavailable (nothing live to watch). |
| Two `stage:` (or two `waiting:`) labels | Flag as a data error and report it; do **not** auto-resolve or write. Matches the sync script's throw. |
| Ambiguous which workstream this session owns | Ask. Never write on a guess. |
| Live check shows PR merged while labels say code-review | The self-healing case: correct labels to the truthful stage, rewrite the block, disclose both. |
| Write fails (permissions, network, race) | Report the derived state in chat **and** state plainly that the write failed. Never imply a successful write. |
| Carve-out content | No write; chat only; say why. |
| Invoked with no changes needed | Still discloses: "state confirmed, no change." Silence would be indistinguishable from a skipped write. |

## Admin/User UX Impact

No product surface. The "UX" is David's chat output and the issue body. Chat
output is sparse per CLAUDE.md — the state, what's next, the fit, and the
write disclosure. The 🛑 banner ritual is **not** used (this is a report, not a
blocking question), matching the existing rule in `status/SKILL.md`.

## Security, Permissions, and Validation

**This section exists because write-through introduces a genuinely new risk.**
Read-only `/status` could never leak anything; a skill that automatically
writes session narrative into a **public** issue body can. `Overhypeme` is
public — the Project is private, issue bodies are not.

- **The disclosure gate runs before every write** (step 2 above), reusing
  `plan-review-loop`'s carve-out categories. On a hit: no write, chat only,
  stated plainly.
- **Writes are scoped** to one identified workstream issue's labels and body.
  No fleet-wide mutation; no PR writes; no board writes.
- **No new credentials or permissions** — same GitHub MCP surface already used
  by `pr-watch` and `plan-review-loop`.
- **Review-thread resolution stays David's** — unchanged; this skill never
  resolves threads.

## Testing Plan

These are markdown skill/contract files, so there is no unit-testable code
path. Verification is therefore mechanical + a live acceptance case:

1. **`pnpm run check:docs`** — validates every relative link and cited repo
   path across all 121 doc files. Catches the rename's dangling references,
   which is the most likely mechanical failure.
2. **`grep` sweep** for surviving `skills/status/` and bare `/status`
   references that should now read `/status-all`.
3. **Live acceptance case — issue #328.** It is currently stale in a known,
   specific way (`stage:code-review` + `waiting:codex`, body says "Waiting on:
   Codex", while PR #329 is merged). Running the new `/status` against it must:
   derive `WAITING ON YOU` (🛑 UAT), correct **both** labels, rewrite the block,
   and disclose the write. **Negative half, and the one that actually proves
   the invariant:** a second run immediately after must report "state
   confirmed, no change" and must **not** claim `WATCHING` — proving the state
   was derived from a live check rather than from the first run's memory.
4. **Carve-out negative case:** invoked against a workstream whose narrative
   contains carve-out content, the skill must withhold the write and say so.

## Implementation Steps

1. `git mv .claude/skills/status .claude/skills/status-all`; update frontmatter
   `name`/`description` and all internal self-references. No logic change.
2. Add the **State of Play template** to `workstream-tracking.md`.
3. Add the **5-state derivation table + precedence** to `workstream-tracking.md`,
   marked derived-never-stored.
4. Add the **`/status` ownership row**; rewrite that doc's `## /status` section
   to cover both skills.
5. Write `.claude/skills/status/SKILL.md` (identification → disclosure gate →
   batched gather → derive → write → disclose).
6. Sweep remaining cross-references (`AGENTS.md` routing if the skill list is
   enumerated there).
7. Verify: `pnpm run check:docs`, the grep sweep, then the #328 acceptance case
   including the second-run negative.

Steps 1–4 are mechanical and independent; step 5 depends on 2–3 (it renders the
template and applies the table).

## Risks and Mitigations

- **R1 — Public disclosure via automatic writes.** *New with write-through.*
  Mitigated by the pre-write disclosure gate; on any doubt the skill withholds
  the write rather than trusting a judgment call.
- **R2 — The narrative block becomes a second source of truth.** Mitigated by
  the mandatory ordering (compute → write labels → render block from the same
  values) and by never reading the block back as authority. Without the
  ordering, a later run could parse a hand-edited block and write *that* to the
  labels — inverting the SoT. This is the single most important invariant here.
- **R3 — Self-healing labels fight a mid-transition writer.** `/status` writes
  only where live evidence *differs* from the stored labels, and reports rather
  than rewrites on a data error (two same-prefix labels). Because it writes
  what GitHub currently says, a race resolves toward truth on the next run
  rather than ping-ponging.
- **R4 — Two vocabularies to hold in mind** (5 states vs. 10 stages × 5
  waiting). Mitigated by documenting the 5 states strictly as a derived
  *view* with an explicit mapping table, and by David's decision (7) to keep
  them out of the fleet view.
- **R5 — Muscle memory: David types `/status` expecting the fleet view.** The
  per-session skill's output names `/status-all` as the fleet alternative, so
  the recovery is one line away rather than a confusing wrong answer.
- **R6 — Writing to the wrong workstream** on a bad identification. Mitigated
  by ask-don't-guess at step 1; this is why identification precedes the gather.

## Questions for David

**None.** Both implementation forks were resolved in the pre-plan conversation
and are recorded as *Settled Decisions* (6) and (7). Everything else was
answerable from the repo and is resolved above — notably the State of Play
block's undefined structure (formalized here from #328's shape) and the
5-state-vs-labels relationship (derived, never stored).

## Definition of Done

- [ ] `/status-all` exists, behaves exactly as today's `/status` did, and no
      cross-reference anywhere still points at the old path.
- [ ] `/status` exists, is per-session, and its output states the workstream,
      one of the five states, what's next, and how it fits.
- [ ] Every `/status` invocation writes labels + block from live evidence and
      **discloses** it — including the no-change and write-failed cases.
- [ ] `WATCHING` is unreachable without a live check in the same invocation,
      and the second-run negative case proves it.
- [ ] The State of Play template and the 5-state derivation table (with
      precedence, marked derived-never-stored) are in `workstream-tracking.md`;
      the ownership table has a `/status` row.
- [ ] The disclosure gate withholds writes on carve-out content.
- [ ] `pnpm run check:docs` passes; the grep sweep is clean.
- [ ] **Exercisable end-to-end:** running `/status` against #328 corrects it
      from `code-review`/`codex` to the truthful 🛑 UAT / David and rewrites its
      block — the concrete, checkable proof the staleness problem is solved.
