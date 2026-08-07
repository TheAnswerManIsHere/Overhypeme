# Decision Log

> Append-only record of **settled** decisions — the *why* and *when* behind the
> "don't reverse without David" list in
> [`product-direction.md`](./product-direction.md). Newest first. If a decision
> should be revisited, don't silently reverse it — raise it with David and, if it
> changes, add a new entry that supersedes the old one (leave the old entry in
> place as history).
>
> Format: **date · title** — Decision / Why / Reference / Revisit if.
> Dates are approximate where anchored only to a PR; the PR number is the durable
> reference.

---

### 2026-08-07 · Loop metrics move to one record per loop, adjudication samples *loops*, and the insight is delivered by a digest — superseding the 2026-07-27 ledger decision
- **Decision:** Three changes to how review-loop efficacy is recorded, all
  superseding parts of *2026-07-27 · The loop ledger* below (which stays in
  place as history):
  1. **Storage.** One JSON record per loop at
     `.agents/metrics/loops/<pr>.json`, keyed by PR number, written by
     `scripts/loop-metrics.mjs --pr <n> --write`. The markdown table is
     **frozen** at rows 1–42, pinned by `loop-ledger.sha256`, and never
     appended to again. **There was no migration** — the old rows stay
     exactly as written, and the analysis in *What the ledger's adjudicated
     rows now show* remains the record of what those 42 loops showed.
  2. **Adjudication scope.** Blind adjudication now runs on a deterministic
     **sample of loops** — `pr % 5 === 0` or `findings >= 30` — instead of on
     every loop. **Every adjudication that runs still covers that loop's full
     finding population.**
  3. **Delivery.** `scripts/loop-report.mjs` renders a digest that
     `/maintenance` narrates to David in plain language. The `[LEDGER]` PR
     type is retired; a record rides any PR except the one it measures.
- **Why:** Three failures, all observed. **(a)** The single-table design
  forced concurrent sessions to collide: PRs #327 and #335 both claimed rows
  24–26 with different contents and each made the other un-mergeable, because
  CI *required* every `[LEDGER]` PR to carry every owed row. **(b)** The
  guard had grown to ~970 lines, almost all of it policing problems that
  design created — and its own PR (#304, 61.1% self-inflicted over 7 rounds)
  and the ledger's bootstrap (#270, 64.7% over 16 rounds) are two of the four
  worst loops in the dataset, making the measurement system a top generator
  of the pathology it measures. **(c)** The insight never reached its
  consumer: it lived in a ~2,500-word analysis section inside a file David
  does not open, and he learned the rows were duplicating by stumbling into
  it. The measurement half had shipped; the delivery half never had.
- **On the sampling reversal specifically** — the 2026-07-27 entry removed
  sampling, so this needs to answer it directly rather than quietly differ:
  - That entry's sample was **within a loop** (30% of one loop's findings),
    and the two bias defects that killed it were *selection* defects — an
    id-sort that oversampled round 1's disproportionately-new-ground
    findings, then a round-robin that silently dropped the latest rounds,
    where the self-inflicted numerator lives. **This samples loops, not
    findings.** Each sampled loop is adjudicated in full, so the
    disagreement gate stays exact and neither defect can recur.
  - That entry's stated rationale was **cost** ("full coverage costs tokens
    once per loop close, not anyone's time"). That reasoning still holds and
    is **not** why this changed.
  - What changed is the **observed outcome**, which did not exist as evidence
    in July: roughly 40% of adjudicated rows landed `unmeasured` and were
    discarded by the >20% disagreement gate. The repo was paying full
    dual-classification cost on every loop and throwing away two rows in
    five. Sampling loops keeps a recurring calibration signal at a fraction
    of that cost.
  - David's 2026-08-07 scope directive — *"this is an internal tool that has
    a simple task of tracking how effective our loops are… We're not curing
    cancer"* — is the authority for accepting a slightly weaker guarantee in
    exchange for a much simpler system.
  - The old entry's **"Revisit if"** clause is unaffected and still stands:
    if the blind adjudicator ever becomes a human rather than a subagent, the
    cost calculus flips again and this should be reconsidered.
- **Two guarantees were deliberately dropped**, both recorded as accepted
  risks rather than solved: records are **no longer append-only** (they can
  be edited or deleted in an ordinary commit; PR review is the control), and
  **coverage is no longer a CI gate** (missing records are named in the
  weekly digest instead of failing an unrelated PR's build). Enforcing the
  first required a corrections-overlay system whose own review produced more
  defects than it prevented.
- **Reference:** the approved plan, committed as `PLAN_LOOP_METRICS_STORE.md`
  under the plans directory on the never-merged `plan-review/loop-metrics-store`
  branch (commit `6a15e9d`; plan files never land on `main`), reviewed across four
  Codex rounds on the closed plan-review PR #340 (14 → 14 → 12 → 12 findings,
  48 fixed, 2 declined with recorded reasoning). Contract in
  [`working-modes.md`](./working-modes.md#the-loop-ledger).
- **Revisit if:** the digest goes unread for a month (the delivery half would
  have failed the same way the ledger's did, and the answer is a different
  surface, not more data); or missing records accumulate past a handful,
  which would mean the no-CI-gate trade was wrong and coverage needs teeth
  again.

---

### 2026-08-07 · CI cancels superseded PR runs and skips the heavy suites on provably docs-only changes
- **Decision:** `build.yml`/`codeql.yml` now cancel an in-progress run when a
  newer push lands on the *same PR* (never a push-to-main or the weekly
  CodeQL schedule run — those always run to completion), using a group key
  that falls back to `github.run_id` for those non-PR events so they can
  never collide with each other. `dependency-review.yml` gets the same
  cancellation unconditionally — it only ever triggers on `pull_request`, so
  there's no push/schedule case to protect. Separately, `Test` / `Frontend
  Test` / `E2E Smoke` skip entirely on a PR whose full changed-file list is
  provably inert for those suites, via a fail-safe allowlist classifier
  (`scripts/classify-ci-paths.mjs`) gated with **job-level `if:`**, not
  workflow-level `paths:` filtering. `codeql.yml`'s `python` matrix entry
  was also dropped: the repo has exactly two `.py` files, both tooling
  helpers under `.claude/skills/` (semgrep, sarif-parsing), no product
  Python — that job scanned nothing that ships, on every single push.
- **Why:** A fast-iterating, Codex-driven review loop can push many times to
  one PR in a single day (PR #334: 11 pushes in one day, ~8–9 parallel jobs
  each) and every prior push's CI was obsolete the moment the next one
  landed but still ran to completion. Separately, this repo's PR mix
  includes a lot of genuinely docs-only work — `/document` harvests,
  `[LEDGER]` PRs, UAT/TEST_RUN docs, skill and `CLAUDE.md` edits — that
  provably cannot change the integration/e2e suites' outcome, and each was
  still booting Postgres twice, downloading Chromium, and running the full
  suites. **This is a wall-clock/queue-pressure optimization, not a cost
  one** — Actions on standard runners is free/unmetered for this repo since
  it's public; see
  [`github-actions-outage-mimics-quota.md`](../../.agents/memory/github-actions-outage-mimics-quota.md)
  for how that got misdiagnosed as a billing problem along the way. The
  classifier is deliberately an allowlist (not a heavy-path denylist): its
  failure mode on an **unrecognized** path is wasted minutes, never a skipped
  regression, since anything it doesn't recognize defaults to heavy. That
  guarantee does **not** extend to a path that's already on the allowlist
  when a heavy suite later starts depending on it — a PR touching only that
  path would still skip the suite that could have caught the regression,
  exactly the shrink case the `Revisit if` line below exists to name. A
  generated artifact living inside an otherwise-inert directory
  (`docs/ADMIN_FIELD_REFERENCE.md`, whose byte-parity with
  `renderAdminFieldReference()` is asserted by `Frontend Test`) is carved out
  as an explicit exception rather than weakening the directory-level rule —
  it's the first instance of exactly this shrink case, caught before merge
  only because a reviewer happened to know the test existed.
- **Reference:** PR #334 (rounds 17–20 of its review loop).
  `scripts/classify-ci-paths.mjs` +
  `scripts/__tests__/classify-ci-paths.test.mjs`. Two GitHub Actions
  mechanics this hit along the way, now recorded so they aren't
  rediscovered:
  [`github-actions-required-checks-job-if-vs-paths-filter.md`](../../.agents/memory/github-actions-required-checks-job-if-vs-paths-filter.md)
  (a `paths`-filtered workflow that never triggers leaves a required check
  stuck at "Expected" forever) and
  [`github-actions-concurrency-group-key-and-queue-max.md`](../../.agents/memory/github-actions-concurrency-group-key-and-queue-max.md)
  (`github.ref` collides across every push to the same branch; `queue: max`
  can't combine with a `cancel-in-progress` that can evaluate `true`).
- **Revisit if:** the classifier's allowlist needs to grow (a new top-level
  directory that's genuinely inert for the heavy suites) or shrink (a new
  test starts reading something currently allowlisted, the way
  `fieldDocs.test.ts` already forced the field-reference exception).
  Separately: if this repo ever gains genuine product Python (not just a
  tooling script under `.claude/skills/`), restore the `python` entry to
  `codeql.yml`'s language matrix — its removal was scoped to "nothing that
  ships," not "Python is out of scope forever."

---

### 2026-08-05 · The Bash guard is narrowed to "make the lease mandatory," then review-loop iteration stops after round 4 widened instead of narrowed
- **Decision:** `.claude/guard.sh` (via `scripts/guard-decision.mjs`) was rewritten
  from a single inverted grep — it blocked `git push --force` while waving
  through the equivalent `git push -f` — into a token-level parser, then
  deliberately **narrowed in scope rather than removed**, after David supplied
  a screenshot proving GitHub's ruleset on `main` (Block force pushes, Restrict
  deletions, Require linear history, Require a pull request before merging,
  Require status checks to pass — verified ON 2026-08-05) already blocks force
  pushes server-side, for every actor, regardless of this hook. That reframed
  the hook as the **third** line of defense (behind the harness classifier,
  which still refuses to let this session edit its own guardrails without
  David approving the write, and GitHub's ruleset), whose only real job left is
  making `--force-with-lease` **mandatory** on the branches this session owns
  (`claude/*`, `plan-review/*`) — the container is ephemeral, so an
  overwritten remote branch has no local reflog to recover from. Three Codex
  review rounds on PR #329 then found 34 concrete parser gaps and fixed 31
  (round 1: 11 found / 9 fixed, 2 disclosed as known limits; round 2: 11 / 11;
  round 3: 12 / 11, 1 disclosed as a policy question). Round 4 found **19**.
  Rather than open a round 5, David stopped the loop there; round 4's gaps are
  recorded in `guard-decision.mjs`'s docstring (`ROUND 4, AND THE DECISION TO
  STOP`) as accepted, not fixed. **Corrected 2026-08-07** (loop-ledger row 35,
  built from a fully-paginated live re-check of PR #329's actual review
  threads): this entry originally said round 3 found 14, itself an error —
  re-derived from commit `d3bbe54a`'s own miscounted commit message rather
  than live GitHub data, and caught only after PR #331's first attempt to fix
  a *different* wrong figure ("9, 11, 12") landed on this equally wrong one.
  The true count is 12.
- **The finding counts never fell — 11, 11, 12, 19 across four rounds.** Worth
  stating precisely, because the intuition that a review loop is "converging"
  is exactly what this decision is a correction to. Each round's *fixes*
  landed and were real, but the number of newly-discovered gaps was flat and
  then rising, which is the falsifiable signal that the defense was the wrong
  shape rather than merely unfinished.
- **Why:** A hand-rolled recognizer trying to prove "no way this string
  executes a force push" is effectively reimplementing Bash's own parser and
  expander, and Bash's surface for "ways to dispatch a command" (wrapper
  commands like `sudo`/`time`/`timeout`/`coproc`/`env -S`, alternate quoting
  forms, script-dispatch mechanisms like heredocs/here-strings/`eval`, git's
  own alias system) is not practically enumerable — every round a reviewer
  thinking adversarially about Bash found a new class, not a shrinking one.
  The guard was never the actual protection for `main`; continuing would have
  kept spending review rounds hardening a backstop against a threat model
  (deliberate adversarial evasion) that does not match how the hook is
  actually exercised — an honest agent mistake in a normal-shaped command,
  which the shipped version already reliably catches.
- **Reference:** PR #329. `scripts/guard-decision.mjs`'s docstring carries the
  full three-layer model and the itemized list of round 4's 19 documented (not
  fixed) gaps.
- **Revisit if:** a real incident shows the guard misses a normal, non-adversarial
  command shape (not one of the documented edge cases); or GitHub's ruleset on
  `main` is ever weakened or removed, at which point this hook stops being a
  backstop and the cost/benefit of closing the remaining gaps changes.

### 2026-08-05 · Multi-PR features get parent-issue-plus-phase-sub-issue tracking, and I ask before declaring a split
- **Decision:** When a feature is too large for one PR (the pattern PR #293
  hit, self-documented mid-flight as "phase 1 of 8"), the **parent issue**
  carries the plan and the checkpoints that only make sense once — 🛑 Plan
  approval, 🛑 UAT, close-out — while each **phase** becomes its own
  **sub-issue** with its own PR, carrying only 🛑 Merge. A phase PR's oracle
  section gets an added **scope line** naming which of the parent plan's
  sections that phase delivers vs. defers, so a reviewer isn't left guessing
  whether a missing piece is out-of-scope-for-this-phase or dropped. UAT is
  **per-phase**, wherever a phase is itself product-visible, rather than one
  UAT deferred to the last phase. Phases **merge sequentially, never
  stacked** — no phase PR bases on another still-open phase PR. Splitting a
  feature into phases is something I **propose to David**, not something I
  declare silently mid-build. #310 and #293 are named retrofit candidates for
  this structure once it's built.
- **Why:** Without sub-issue tracking, a multi-PR feature's per-phase state
  (which phases are done, which is active, what the next one still owes)
  lived only in PR titles and chat memory, with no structural place to see it
  at a glance. Sequential-only merging matches this session's guard-work
  finding that force-push/stacking tooling isn't something to reach for
  routinely — phases don't need stacked-branch mechanics if they land one at
  a time. David chose "ask before declaring a split" over "split silently
  when a plan looks too big," revisitable if it becomes cumbersome in
  practice.
- **Reference:** Design settled in conversation 2026-08-05, alongside the
  `/status` redesign below. **Not yet built** — see
  [`current-roadmap.md`](./current-roadmap.md).
- **Revisit if:** the ask-before-splitting step becomes friction in practice
  (David's own stated condition for revisiting).

### 2026-08-05 · `/status` ships as report-and-offer, superseding the write-through design below
- **Decision:** Per-session `/status` **reports** the workstream's state and,
  when stored `stage:`/`waiting:` labels or the `## State of Play` block
  disagree with live GitHub, **offers** to correct them — David confirms,
  then it writes. It does **not** write unattended on every invocation, which
  is what the entry immediately below this one originally specified and
  approved.
- **Why:** The write-through design went through a Codex plan-review loop
  (PR #333) that reached round 6 before two findings showed the unattended
  write couldn't be made safe on this platform: (1) this repo is public and
  PR bodies are attacker-controlled, so the write-target discovery rule
  (`Workstream: #N` in a PR body) could be steered by a forged fork PR into
  rewriting a maintainer's issue; (2) GitHub's label API has no
  compare-and-swap, so a race between `/status`'s read and its write could
  silently erase a `stage:done` David had just set, with no way to recover
  it. Both are fixable *in principle* with enough specification, but round 6
  was already specifying acceptance cases with no harness to execute them —
  the guarantee had outrun what a status check justifies building. David's
  call: make the write **confirmed, not unattended** — a single "want me to
  fix this?" in a session already open — which removes both findings at the
  root instead of patching around them, and costs one tap.
  This also closed PR #333 unmerged and prompted the shared **ceremony
  scales to blast radius** rule in
  [`working-modes.md`](./working-modes.md#feature-mode-ceremony-scales-to-blast-radius-not-to-phrasing-david-2026-08-05):
  the six-round loop was ceremony mismatched to two markdown files, not a
  defect in the design being reviewed.
- **Reference:** PR #333 (plan review, closed unmerged); PR #336 (shipped
  implementation, `.claude/skills/status/SKILL.md`); the
  [known-failure-patterns entry](./known-failure-patterns.md#chasing-completeness-against-an-adversarial-reviewer-past-the-artifacts-real-risk).
- **Revisit if:** a GitHub API adds conditional/CAS-style label updates, which
  would remove the race that made unattended writes unsafe and reopen
  write-through as an option.

### 2026-08-05 · `/status` splits into a write-through per-session skill and a fleet-wide `/status-all` — superseded by the entry above
- **Decision:** The existing fleet-wide `/status` skill (cold-open summary of
  every open workstream) becomes **`/status-all`**, unchanged in behavior.
  A new, separate **per-session `/status`** answers the narrower "what am I
  working on right now and how does it fit the bigger picture" question, and
  is **write-through**: every invocation refreshes the workstream issue's
  State of Play block and discloses that write each time (never a silent,
  read-only summary). It reports state using a fixed 5-state vocabulary —
  **WORKING / WAITING ON YOU / WATCHING / STALLED / DONE** — where **WATCHING
  may never be claimed from memory**, only after an actual live GitHub check
  in that invocation (stale memory of "I was watching PR #X" is not enough to
  report WATCHING). In a Discovery-stage session that has no workstream issue
  yet, `/status` offers to open one rather than reporting "nothing to show."
- **Why:** The single fleet-wide `/status` conflated two different questions
  a session needs answered — "what's the state of everything" (David's,
  cross-session) vs. "what am I doing right now" (a session's own, cheap,
  frequent check) — forcing the cheap question through the expensive
  fleet-wide scan every time. The write-through design keeps the workstream
  issue as the durable source of truth for session state rather than letting
  it drift out of sync with what the session actually believes about itself.
  The WATCHING-only-from-live-check rule exists because a session's memory of
  "I subscribed to that PR" can go stale (the PR merged, closed, or the
  subscription silently dropped) in exactly the way CLAUDE.md's PR-watch
  rules already warn against for webhook events — "never judge from text
  alone" applies to self-reporting status too.
- **Superseded 2026-08-05** (same day, entry above): the write-through half
  did not survive plan review. The 5-state vocabulary, the WATCHING-only-
  from-live-check rule, and the `/status-all` split all shipped unchanged.
- **Reference:** Design settled in conversation 2026-08-05.
- **Revisit if:** n/a — superseded.

### 2026-08-05 · Workstream tracking runs on GitHub's own project management, with labels — not the board — as the source of truth
- **Decision:** Every unit of work (feature, bugfix, docs harvest) gets a
  **GitHub issue as its spine** — *except* sensitive/disclosure-carve-out
  work, which never becomes a public issue and instead lives as a private
  draft Project item, per `plan-review-loop`'s existing disclosure check
  (this repo is public, so an issue body is public even though the Project
  itself is private). For everything else, the issue is opened from
  Discovery onward — before any branch exists — carrying a **State of Play**
  block (defined in the routed contract below) and exactly one label
  from each of three prefixes: `stage:` (the ten lifecycle stages),
  `waiting:` (david/claude/codex/replit/ci), and `mode:`. Those issues are
  tracked on a private Project board whose `Status`/`Waiting On`/`Mode`
  fields are populated from the labels by a CI Action
  (`.github/workflows/project-sync.yml` → `scripts/sync-project-fields.mjs`),
  and read back by a `/status-all` skill. **Labels are the writable truth; the
  board is a projection of them.** Four skills — `plan-review-loop`,
  `bugfix`, `pr-watch`, `pr-docs` — each own a specific label transition at
  a trigger point they already hit, rather than any agent carrying a
  standing "go check the board" habit, plus one automated exception: the
  `test-run-completion.yml` Action (PR #334) is the sole non-agent label
  writer, moving `stage:test-run` to `stage:uat`/`stage:close-out` the
  moment a PR's TEST_RUN doc is deleted — nothing with write access was
  otherwise guaranteed to ever notice that event. Because that Action
  writes labels with `GITHUB_TOKEN`, whose events GitHub deliberately does
  not cascade to other workflows, it cannot rely on `project-sync.yml`'s
  own `issues:labeled` trigger firing from its write — it calls the same
  reconcile function directly instead. The full contract is
  [`workstream-tracking.md`](./workstream-tracking.md).
- **Why:** David runs ~10 concurrent Claude Code sessions and could not tell
  which needed him without opening each one; the session list shows a name
  and a timestamp, and has no field for stage or whose-turn, so it cannot
  answer that question no matter how sessions are named. Three alternatives
  were considered and rejected. **A status file in the repo:** the session
  container is ephemeral, so a local file dies with the session; committing
  one requires a branch (which a pure Discovery conversation doesn't have),
  and a *shared* board file written by many concurrent squash-merged
  branches is the worst possible git shape — a failure this repo has already
  recorded once in
  [`document-ceremony-concurrent-docs-pr-conflict.md`](../../.agents/memory/document-ceremony-concurrent-docs-pr-conflict.md).
  **A second Project for `/document` harvests:** fragments exactly what this
  exists to unfragment; harvests are **sub-issues** of their parent
  workstream instead, since each has its own branch, PR, and review loop and
  therefore needs its own row rather than a status value on the parent.
  **Reading the board directly:** no available MCP or REST tool can read
  *or* write a Projects v2 item field — confirmed twice independently — so
  labels are not a stylistic choice but the only writable surface an agent
  has, and `/status-all` recomputes the board's view from them rather than
  querying the board. `Waiting On` is deliberately a field **separate from**
  `Status` because the two diverge: a blocking question mid-build leaves
  `stage` at `coding` while the turn passes to David, and that divergence
  *is* the interruption that was being lost. The Project's built-in
  `PR merged → Done` workflow stays **off** because a merge is followed by
  TEST_RUN and UAT — proven correct in practice by #311, which merged and
  correctly stayed at `🛑 UAT` rather than claiming verified work. For the
  same reason PR bodies link with `Workstream: #N`, never `Closes #N`.
  A downstream consequence worth stating: because the State of Play block
  now holds a workstream's context durably *outside* any session, **sessions
  became disposable** — resuming cold in a fresh session is the intended
  path, not a loss, which is what makes the "ran out of tokens, come back
  tomorrow" case cheap instead of requiring an old transcript to be re-read
  uncached.
- **Reference:** PRs #318 (sync mechanism), #322 (field-name matching fix),
  #323 (`/status` skill, later split by #336 into per-session `/status` and
  fleet-wide `/status-all` once those turned out to be two different jobs at
  two different costs), #324 (label maintenance wired into the four
  skills + the shared contract), #334 (`test-run-completion.yml` — the
  automated TEST_RUN-completion trigger, added after Codex flagged that
  transition's missing owner twice reviewing that PR); workstream #317;
  [`workstream-tracking.md`](./workstream-tracking.md). Board:
  *Overhype.me Workstreams* (private, user-owned project 1).
- **Revisit if:** a tool appears that can read or write Projects v2 item
  fields directly — that would let `/status-all` read the board and could retire
  the sync Action entirely, collapsing labels and fields into one surface.
  Also revisit if the number of genuinely concurrent workstreams drops far
  enough that the board costs more ceremony than it saves.

---

### 2026-08-04 · Global CodeQL rate-limiter backstop ships on a custom bounded in-memory store, not a DB-backed `Store`
- **Decision:** The global, API-wide rate-limiter mounted to satisfy CodeQL's
  `js/missing-rate-limiting` query (`artifacts/api-server/src/lib/rateLimit.ts`'s
  `createGlobalLimiter`) is backed by `globalRateLimitStore.ts`'s
  `BoundedMemoryStore` — a **custom** class mirroring `express-rate-limit`'s
  own stock `MemoryStore` two-map rotation, but with a hard cardinality cap
  (`MAX_TRACKED_KEYS`, spanning both maps combined) and FIFO eviction added —
  instead of a store backed by the existing `rate_limit_counters` Postgres
  table. The stock, unbounded `MemoryStore` is what the original 213→0
  CodeQL-clearing proof used and is **not** what ships to production; the
  cardinality cap is the security-relevant difference and must not be dropped
  in a future cleanup that "simplifies" back to the stock store.
- **Why:** The original plan (`plan-review/codeql-rate-limiter`, PR #299)
  spent review rounds 4–14 building a DB-backed `Store`, and each attempt
  produced a new P1 on the same boundary — what the store does when a
  database call doesn't complete — across rounds 9, 11, 12, 13, and 14, with
  P1 counts going 8 → 6 → 6 → 10 (worsening, not converging). Round 14's
  version was worse than the bug it replaced: a hung query would wedge the
  in-process admission counter and 503 every request indefinitely, turning a
  database stall into a total outage. The CodeQL alert itself only requires
  the package to be mounted in the recognized shape — the original 213→0
  local-scan proof used the stock `MemoryStore` and needed none of the DB
  machinery; production adds the bounded-cardinality hardening the stock
  store lacks. David's call: ship the proven-shape store (bounded, not stock),
  and route the genuine repository bugs the 14-round detour surfaced to their
  own `/bugfix` PRs rather than lose them with the code they were found in —
  see [`deferred-work.md`](../engineering/deferred-work.md#code-level-tech-debt)
  for the `adminConfig` stampede, `getStripeSync` pool-leak-on-disposal, and
  `rate_limit_counters` cleanup entries, and its
  [Security & patching](../engineering/deferred-work.md#security--patching)
  section for the autoscale instance cap and `IP_HASH_SALT` production
  fallback.
- **Accepted trade-off, stated rather than smoothed over:** `MemoryStore`'s
  `localKeys = true` semantics (which `BoundedMemoryStore` inherits) means
  this is a **per-instance** ceiling, not a bounded fleet-wide one — on
  autoscale infrastructure with no configured instance cap, the effective
  allowance is `instances × ceiling`. **At least 13 of 31 route files** had
  some pre-existing rate/quota limiting before this PR — 7 DB-backed with an
  **atomic** guarantee (`facts.ts`, `reviews.ts`, `admin.ts`,
  `adminTaxonomyHealth.ts`, `ai.ts`, `localAuth.ts` via
  `checkSharedRateLimit`/`createRateLimiter`'s single
  `INSERT ... ON CONFLICT ... DO UPDATE`; `storage.ts` via
  `checkUploadRateLimit` → `checkSharedRateLimit`, same guarantee); 2
  DB-*observed* but **not atomic** (`videos.ts` and `memes.ts`, which each
  `SELECT count(...)` from `videoJobsTable`/`memesTable` and only *then*
  `INSERT` the new row as a separate statement — under a genuinely
  concurrent multi-instance burst, multiple requests can all pass the read
  before any insert commits, a classic TOCTOU race; DB-persisted and
  fleet-*visible*, but not fleet-*correct* the way the atomic family is); 2
  in-process/per-instance only (`share.ts`, `shareCopy.ts`, sharing this
  backstop's own per-instance limitation); and 3 **budget/quota gates, a
  different protection class from rate-per-window** (`videos.ts` *also*
  returns 429 from `checkBudget()` — a per-user cost cap, a second,
  independent 429 source in the same file as its `videoJobsTable` check;
  `pulidJobs.ts` returns 429 from `isUserAtImageLimit()`, a per-user image-
  count cap; `videoJobs.ts` — a *separate* route file from `videos.ts`,
  mounted independently via `routes/index.ts`'s `router.use(videoJobsRouter)`
  — delegates to `startVideoJob()` in
  `artifacts/api-server/src/lib/videoPipelineRunner.ts`, whose pre-flight
  `checkBudget()` call throws the same 429 before a job is
  created). **This budget/quota-gate list is non-exhaustive on gates, even
  though the file count isn't affected:** `memes.ts` (already counted above,
  among the DB-*observed*-but-not-atomic pair) also rejects AI generation via
  `isUserAtImageLimit()`/`BudgetExceededError`
  (`artifacts/api-server/src/routes/memes.ts:1333-1452`), and `reviews.ts`
  (already counted among the atomic DB-backed group) rejects fact
  submissions once `FACT_SUBMIT_PENDING_CAP` is reached
  (`artifacts/api-server/src/routes/reviews.ts:193-208`) — a quota gate
  distinct from that same file's `checkSharedRateLimit`-backed rate limit.
  Neither changes the 13/31 count (both files already counted), but a future
  quota/budget hardening pass using this note as a source of truth would
  miss both if it only read the three named files above. **A fourth layer,
  not a fourth file:** `videos.ts` and
  `memes.ts` also call `enforceGovernance()`
  (`artifacts/api-server/src/lib/resourceGovernance.ts`) before generation,
  which 429s from its own process-local `usageEvents`/`inFlightByUser`
  in-memory counters (requests/spend/concurrency caps) — a third protection
  layer on top of those two files' existing DB-observed and budget-gate
  429s, sharing this backstop's own per-instance limitation. Doesn't change
  the 13/31 file count (both files are already counted), but a future audit
  hardening per-instance controls specifically would miss this layer if it
  only looked at the `share.ts`/`shareCopy.ts` in-process bucket. `render.ts`'s preview/download endpoints are separately
  protected at the Cloudflare WAF edge layer (infrastructure, not
  application code — not counted in this tally either way; see
  `docs/cloudflare-rate-limits.md`). **No single number in this note should
  be trusted as final** — this count has been revised upward across five
  separate Codex review rounds on the same PR (6 → 9 → 11 → 12 → 13), each
  finding a real case the previous pass missed (a route-file symbol grep,
  then `lib/`-delegated protection, then a non-`checkSharedRateLimit`
  DB-backed check, then a budget/quota gate distinct from rate limiting,
  then a same-topic sibling route file the grep never visited because it
  isn't named `videos.ts`). Treat every count here as a lower bound on
  pre-existing protection and an upper bound on "newly covered by this
  backstop," not a verified-exhaustive audit — a further pass could
  plausibly find more. Since "existing" can only grow as more are found,
  **"18 route files getting their first application-level rate limiting
  from this PR" (31 − 13) is correspondingly an upper bound, not a lower
  one** — treat it as approximate, and as likely to shrink on a future
  audit, not grow.
- **Reference:** Plan-review PR #299 (16 rounds, approved 2026-08-04),
  implementation PR #308. Full context:
  [`codeql-missing-rate-limiting-csrf-false-positive.md`](../../.agents/memory/codeql-missing-rate-limiting-csrf-false-positive.md).
- **Revisit if:** the per-instance ceiling proves too permissive under real
  multi-instance autoscale traffic (would need either an enforced instance
  cap or a return to a fleet-wide store design — this time scoped to avoid
  the hot-path DB-failure boundary that sank the first attempt), or CodeQL's
  query model changes to recognize custom stores/controls directly.

---

### 2026-07-30 · Queue-health classification persists the retry ceiling at finalization instead of re-deriving it live
- **Decision:** When an `async_jobs` row transitions to `failed` (either
  exhausting retries or hitting a `terminalFailure()`), `processClaimedJob`
  now persists the **resolved** effective `maxAttempts` onto the row itself,
  instead of leaving the historical `0` sentinel ("follow whatever the
  queue's live config says") in place. A row still `pending`/mid-retry keeps
  the sentinel untouched — only a `failed` transition writes the resolved
  value. This is a narrow, deliberate exception to Phase 1's own stated
  scope ("instrument before changing the machine — no claim/finalize
  changes"), approved by David after being presented as a genuine fork
  (touch finalize minimally / accept the classification gap / silently drop
  the distinction for sentinel rows) rather than decided unilaterally.
- **Why:** The Queue Health surface (below) classifies a `failed` row as
  `abandoned_no_retry` — distinct from plain `failed` (either retries
  genuinely exhausted, or a legacy `0`-sentinel row too old to classify
  safely; see below) — via either of two branches: `effectiveMax <= 1` (no
  retry budget at all, regardless of *why* the one attempt failed) or
  `attempts < effectiveMax` (the row failed before its ceiling was reached,
  only reachable via a deterministic `terminalFailure()`). Both branches
  compare against the row's effective retry ceiling. For the common case —
  a row enqueued without a per-row override — that ceiling lived only in
  `admin_config`, which is mutable and cache-busted. Re-resolving it **live** at read time meant a
  historical row that legitimately exhausted retries under an *old, lower*
  ceiling could be silently reclassified as `abandoned_no_retry` — "the
  worker won't retry this," not "retries were exhausted" — the moment an
  admin later raised that queue's ceiling — an
  internally plausible but wrong answer, and worse, one that degrades
  *after* the fact with no code change to explain it. Persisting the
  resolved value at the one moment it's actually known (finalization) makes
  an already-computed, already-terminal fact durable instead of
  re-derivable-and-therefore-re-answerable-differently-later — the same
  general lesson as [freezing a value at the point it's fixed instead of
  re-resolving it live later](./known-failure-patterns.md#un-frozen-input-re-resolved-live-after-its-freeze-point),
  applied at a later pipeline stage (finalization, not enqueue). The automatic worker never re-claims or
  re-processes a `failed` row, so persisting one more field on it cannot
  affect any future *automatic* retry decision — the one exception is the
  admin's manual `/admin/email-queue/:id/retry` route, which deliberately
  resets a row back to `pending` **and** resets `maxAttempts` to the sentinel
  (round 5 of PR #288's review), restoring live-config semantics for a job an
  admin is knowingly reopening; see the manual-retry test coverage in
  `asyncJobs.test.ts`. Migration 0094 does not backfill existing rows, so a
  pre-deploy `failed` row keeps the `0` sentinel until something touches it —
  forever if it's never retried, or until the manual-retry exception above
  reopens it and it fails again, at which point finalization persists a
  resolved ceiling like any other row. Until then, the classification logic
  treats a `0`-sentinel row conservatively (plain `failed`, never the
  derived `abandoned_no_retry` state) rather than risking the same
  misclassification on data it cannot resolve safely.
- **Reference:** PR #288 (`artifacts/api-server/src/lib/asyncJobs.ts`'s
  `processClaimedJob`, `artifacts/api-server/src/lib/queueHealth.ts`'s
  `deriveDisplayStatus`). See
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues) for
  the surface this feeds.
- **Revisit if:** a future phase adds a backfill for legacy `0`-sentinel
  rows (making the conservative `failed`-only treatment for them
  unnecessary), or the `abandoned_no_retry` distinction needs to move
  earlier in the pipeline (e.g. onto the job payload at enqueue time)
  instead of living on the finalize write.

### 2026-07-30 · Async-jobs DB connection pool `max` raised to 20, explicit and derived — supersedes PR #216's deferral
- **Decision:** The shared Postgres pool's `max` (`lib/db/src/index.ts`) is
  now an explicit constant, `20`, instead of pg's implicit default of 10.
  20 is the offline-computed result of `min(20, floor(398 / max_instances))`
  at the observed fleet size — the code hardcodes the result, it does not
  evaluate that formula against a live `max_instances` at runtime.
- **Why:** PR #256's five-lane expansion (on top of PR #216's original
  fast/render/bulk split) raised the lanes' default combined concurrency to
  10 — exactly at the old implicit `max`, leaving zero spare **within this
  same process's own pool** for anything else this process itself runs
  concurrently (admin HTTP queries, the Queue Health reads, non-lane
  background work) — a different boundary from `lib/db/src/index.ts`'s
  separately-reserved 5 connections for migrations/console/one-off scripts,
  which are their own processes on the *global* `max_connections` budget,
  not consumers of this pool. Rather than wait for the pool-acquisition-wait
  or rate-limit symptom the #216 entry named as the trigger to revisit,
  PR #288 measured actual `max_connections` headroom (450 total, 7
  superuser-reserved, ~13 in use outside the pool) and derived a `max` that
  doubles the lanes' default worst-case demand with margin — closing the
  gap proactively rather than reactively. Raising this pool's `max` does
  consume more of that same global budget, narrowing the margin left for
  everything else on it (including the separately-reserved migrations/
  console/script connections) — it is not creating headroom for those
  consumers, only for this process's own non-lane queries. See
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues)
  for the full arithmetic.
- **Reference:** PR #288 (`lib/db/src/index.ts`).
- **Supersedes:** the pool-`max` clause of [2026-07 · Split the async-jobs
  worker into fast/render/bulk lanes](#2026-07--split-the-async-jobs-worker-into-fastrenderbulk-lanes)'s
  "Revisit if" note, which left raising `max` "explicitly out of scope" —
  that entry's other clause (a future queue needing its own lane) is
  unaffected and stands.
- **Revisit if:** the five lanes' *combined* concurrency (no aggregate cap
  ties their individually-configurable settings together — see the
  glossary's Lane entry) is raised enough to **reach** 20 — the defaults
  sum to 10, so a single small increase (e.g. `fast` 2→3, demand 11) merely
  narrows the margin and is advisory, not an immediate resize trigger; but
  combined demand hitting 20 exactly already consumes the whole pool with
  zero spare for HTTP queries, claims, or heartbeat writes — the same
  zero-headroom problem this decision fixed at the old 10/10 boundary, so
  the trigger is reaching 20, not waiting to exceed it. Also revisit if the
  autoscale ceiling exceeds ~19 instances at default lane settings — a
  different threshold,
  since that one threatens the *global* 398-connection budget
  (`max_instances × 20`) rather than any single instance's demand.

### 2026-07-29 · Codex "Exhaustive code review" ON, review trigger stays "On PR open" — and the switch is a dated boundary in the ledger
- **Decision:** In the Codex connector's code-review settings, **Exhaustive
  code review is enabled** ("keep looking for additional findings until it
  stops finding new issues") and the **Review trigger stays `On PR open`** —
  not `On every push`, and not `Smart Trigger`. Because this changes review
  behaviour repo-wide, **2026-07-29 is a boundary line in the loop ledger**:
  rows for loops that closed before this date and rows after it are not
  measuring the same reviewer, and any trend drawn across the boundary must
  say so.
- **Why:** The two settings cut in opposite directions against this repo's
  workflow. **Exhaustive** attacks a weakness the convergence rules already
  name and cannot otherwise close — a round that runs short and emits no
  defect is indistinguishable from a genuinely complete pass, and the only
  mitigation available was running many rounds under different stated lenses,
  which is an expensive workaround for shallow rounds. It also changes depth
  per round rather than cadence, so it disturbs neither the trigger discipline
  nor the ledger's round accounting. **On every push** was rejected because
  the manual `@codex review` trigger is not merely a trigger: the plan-review
  contract requires each round's comment to state the lens and name the prior
  findings to reconcile, and `code-review.md`'s re-review invariants require
  asking for the cumulative branch diff after 2+ fix rounds. An automatic
  push-triggered review carries none of that and sees only the incremental
  commits — strictly the weaker review those rules exist to force. It would
  also corrupt the ledger: `rounds` counts completed reviewer events, and
  convergence criterion (c) requires each round to have had a trigger comment
  naming a fresh lens, so push-triggered rounds would inflate the count while
  contributing no lens, and a silent clean auto-round would be
  indistinguishable from real convergence.
- **What would reopen the trigger question:** whether draft PRs are exempt
  from auto-review. Every plan-review PR is a draft, so if drafts are exempt,
  `On every push` would only affect implementation PRs — where automatic
  re-review of fix commits *is* a real gain, since that is exactly the code
  that currently reaches a squash-merge unreviewed when a manual trigger is
  forgotten. Checked on 2026-07-29: OpenAI's published Codex GitHub docs
  document neither the trigger options nor draft handling; the only relevant
  line is that Codex reviews "whenever someone opens a new PR **for review**."
  This repo's own ledger independently records that draft plan-review PRs
  receive zero auto-reviews on open — evidence for the *open* case only. The
  push case cannot be established without enabling it and observing.
- **Reference:** Enabled by David 2026-07-29 in the ChatGPT → Settings → Code
  review panel (personal preference; the repository row inherits it via
  "Follow personal"). The connector's review behaviour is not versioned in
  this repo, so this entry is the only durable record of when it changed. See
  [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md) for
  the rows either side of the boundary.
- **Revisit if:** post-boundary rows show round counts falling without the
  self-inflicted finding share falling (exhaustive is finding more per round
  but the extra findings are our own churn, not new ground); or if the
  draft-exemption question above is ever settled, which reopens `On every
  push` for implementation PRs specifically.

---

### 2026-07-28 · The "lifetime-only upgrade" bug's real root cause was a silently-failed Stripe sync, not plan-selection logic
- **Decision:** When `/api/stripe/plans` or the admin Billing page appears to
  be missing plans that exist and are correctly tagged in Stripe, check the
  sync's own persisted per-resource status (`stripe._sync_status`, surfaced by
  `GET /admin/stripe/sync/status`) **before** touching `selectPlanPrices` or
  the `overhype_membership` allowlist again. A sync that completed short of
  the live catalog looks, after a page reload, identical to one that completed
  correctly — see the known-failure-pattern below.
- **Why:** The upgrade page showed only the $99 "Forever" plan for months, and
  was independently "fixed" twice — PR #255 (classify each price by its own
  `recurring` field, not the parent product) and PR #260 (apply the same
  `overhype_membership` filter to `SubscriptionPanel`'s fallback path). The
  symptom survived both, because neither was the cause. Diagnosis (2026-07-28):
  Stripe's sandbox catalog held all three membership prices (Monthly, Annual,
  Forever); the app's synced local catalog held one. A from-scratch
  reproduction of the sync library's storage/read layer — its own 53
  migrations applied to a local Postgres, its own upsert SQL run against three
  fixture products, `listProductsWithPrices`'s query run verbatim — returned
  all three, correctly classified, ruling out the pricing-selection code
  entirely. Re-running "Sync Stripe data" in the admin Billing page then
  pulled all three products, with no other change: the sync had simply failed
  partway through at some earlier point, and nothing in the app surfaced that
  failure.
- **Reference:** Diagnosed 2026-07-28; no code shipped yet (the fix was
  re-running the sync). Visibility work — always render the sync's persisted
  failure state; stop `selectPlanPrices` from silently dropping a duplicate or
  unusual-cadence price — is planned but not yet built; see
  [`current-roadmap.md`](./current-roadmap.md#in-progress-slices). See the
  retired mistake in
  [`known-failure-patterns.md`](./known-failure-patterns.md#persisted-syncjob-failure-invisible-after-reload).
- **Revisit if:** the planned visibility work ships — replace this entry's
  Reference with the PR number rather than leaving this diagnosis as the
  terminal account of the bug.

---

### 2026-07-27 · The loop ledger: every review loop gets a permanent, falsifiable row — adjudicated over the full population, not a sample
- **Decision:** Every AI-agent-driven review loop (feature, bugfix, plan-review,
  or any ad-hoc thread that escalated into a reviewed change) gets one
  permanent row in [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md),
  appended when the loop closes, by **both** Claude Code and Codex. Mechanical
  columns (rounds, findings, size, review hours) are derived by
  `scripts/loop-metrics.mjs` and never typed by hand; judgment columns (cause
  per finding, breakers fired, preflight time) are hand-entered and visibly
  marked as such. The causal classification is checked by **blind
  adjudication over the full finding population** — not a sample — using a
  five-category rubric (new ground / propagation / wrong fix / re-raised /
  invalid) with explicit precedence rules.
- **Why:** David asked directly whether a mechanism existed to track all
  loop-invoking activity and confirm the workflow is optimizing the right
  things, calling it "extremely important." At the time, nothing recorded a
  single review round, so every efficacy claim about the workflow — including
  claims that it was *degrading* — was unfalsifiable; three prior attempts to
  characterize review history by recollection were each wrong and withdrawn.
  Adjudication started as a 30%-of-findings sample (to bound *human*
  effort), but the loop that built this ledger caught the assumption
  underneath that: the adjudicator here is a subagent, so full coverage
  costs tokens once per loop close, not anyone's time. The sample selection
  rule also produced two confirmed bias defects in two consecutive review
  rounds before being removed entirely (an id-sort that oversampled the
  first round's disproportionately-new-ground findings, then a round-robin
  whose "every round contributes" guarantee was false whenever a loop had
  more review rounds than the sample size — silently dropping the *latest*
  rounds, exactly where the metric's self-inflicted numerator lives).
  Full-population adjudication deletes that whole class of defect and makes
  the disagreement gate exact instead of estimated.
- **Reference:** PR #270. Full contract and rubric in
  [`working-modes.md`](./working-modes.md#the-loop-ledger); the ledger itself,
  including the seed rows and their provenance notes, at
  [`.agents/metrics/loop-ledger.md`](../../.agents/metrics/loop-ledger.md).
  PR #270's own row (16 review rounds, 34 findings, 64.7% self-inflicted,
  confirmed by blind adjudication at 14.7% disagreement — under the 20% gate)
  is the first row the mechanism produced rather than recalled into, and is
  itself the acceptance test for the pipeline: snapshot → script → row →
  independent adjudication, all in one pass.
- **Revisit if:** the blind adjudicator is ever a human instead of an agent
  (the cost calculus that justified full-population coverage would flip
  back toward sampling), or the pending acceptance replay of PR #268's 40
  findings disagrees with its retrospective classification beyond 20% (per
  the ledger's own row-provenance notes) — that would mean the rubric isn't
  trustworthy yet and needs another pass before its output is treated as a
  measurement rather than an account.

---

### 2026-07-26 · TEST_RUN checklists are scoped to what only Replit's live environment can verify
- **Decision:** A `docs/PR<N>_*_TEST_RUN.md` checklist runs, always: live-DB
  migration state, post-merge repo-health gates (**both**
  `pnpm --filter @workspace/db validate-snapshots` — matches CI's
  `build.yml` — **and** `check-snapshots` — catches a migration that shipped
  with neither a generated snapshot nor an explicit `SNAPSHOT_EXEMPT_TAGS`
  entry, which `validate-snapshots` silently skips), behavior checks against
  live config/data, and a test list scoped to the touched surfaces. The full
  sharded suite (`pnpm --filter @workspace/api-server test`) is **conditional
  on an explicit shared-infra verdict** — required only when the PR touches
  the test runner, DB layer, migration runner, codegen pipeline
  (`lib/api-spec`, `lib/api-zod`), or shared middleware — not a default step.
  Every api-server targeted test command must route through
  `bash artifacts/api-server/scripts/run-test.sh`, never raw
  `node`/`pnpm exec tsx --test`; frontend Vitest commands aren't DB-backed and
  have no equivalent wrapper, so they're invoked directly.
- **Why:** Replit's own feedback after executing the PR223/PR224 checklists:
  roughly half of each one re-verified things that already passed pre-merge,
  and PR224's unconditional full-suite run cost ~40 minutes fighting test-DB
  contention for zero new signal. The `check-snapshots`/`validate-snapshots`
  split resolved a real back-and-forth: `check-snapshots` was initially
  dropped as "currently broken" (`SNAPSHOT_EXEMPT_TAGS` already existed with
  entries through `0088` when PR228 and PR229 each added a migration —
  `0089`/`0090` — without adding the required exemption tag or a generated
  snapshot, an omission on their part, not a pre-existing gap in the
  discipline itself; the check then failed on plain `main` for reasons
  unrelated to whatever *later* PR was being checked) — but that failure was
  real signal, not noise, and a later commit closed the gap by tagging both.
  Once closed, `check-snapshots` was restored as required alongside
  `validate-snapshots`, since it catches a failure mode
  `validate-snapshots` structurally can't (a missing snapshot with no
  exemption at all). Separately, a Codex review round caught that four of the
  applied checklists used raw `node --import tsx/esm --test` /
  `pnpm exec tsx --test` for their targeted commands — both bypass
  `run-test.sh`'s production-DB guard entirely (the guard never executes on a
  direct invocation), which is the exact danger `docs/TESTING.md` already
  documents. Several shared-infra verdicts (does this PR touch the codegen
  allowlist / a shared worker / shared middleware?) were also initially
  judged from the PR's own description rather than its actual commit diff,
  and had to be corrected once verified.
- **Reference:** PR #263 (new contract:
  [`docs/engineering/test-run-contract.md`](../engineering/test-run-contract.md))
  and PR #264 (applied to the 6 still-live checklists: 224, 228, 229, 234,
  242, 256 — 221/222/223 had already been executed by Replit and deleted
  before #264 merged, per the transient-doc lifecycle).
- **Revisit if:** the `check-snapshots`/`0089`/`0090` gap reopens (a future
  migration ships without a snapshot or exemption again), or CI's `build.yml`
  changes which snapshot gate it runs.

---

### 2026-07-25 · Stripe plan selection classifies by each price's own `recurring` field, and only from membership-tagged products
- **Decision:** The customer-facing pricing page (and any future code that
  turns Stripe's product/price catalog into "which plan is this?") must
  classify **each price** by its own `recurring` field (`null`/absent →
  one-time/lifetime, `interval: "month"` → monthly, `interval: "year"` →
  annual) — never by guessing a whole **product's** plan type from its name
  or defaulting to only its first price. It must also filter to prices
  belonging to a product tagged `overhype_membership=true` (the same
  allowlist `/stripe/checkout` and the grant layer already enforce, see
  [`security-model.md`](./security-model.md#payment-trust--membership-grants-c6))
  **before** classifying — display must not advertise a plan the grant layer
  will refuse.
- **Why:** `Pricing.tsx` classified a whole Stripe *product* into
  monthly/annual/lifetime by sniffing its name, falling back to only its
  cheapest price's interval when the name didn't match. Stripe's natural
  dashboard setup is **one product, several price points** (e.g. a single
  "Legendary" product carrying monthly, annual, and one-time prices) —
  classifying by product silently collapsed all three onto one bucket and
  dropped the other two, which is what made the upgrade screen show only the
  "Forever" (lifetime) option. Fixing that surfaced a second, adjacent gap in
  Codex review: `/api/stripe/plans` returns every active product in the
  catalog, not just membership ones, so once selection stopped being
  name-gated it would have started flattening prices from **any** future
  non-membership product (render credits, merch, tips) straight onto the
  pricing page — advertising a plan that `/stripe/checkout`'s
  `overhype_membership` allowlist would then reject.
- **Reference:** PR #255. `artifacts/overhype-me/src/pages/pricingPlans.ts`
  (`selectPlanPrices`) is now the single place this classification happens;
  `Pricing.tsx` consumes it. See the retired mistake in
  [`known-failure-patterns.md`](./known-failure-patterns.md#stripe-plan-selection-classify-by-price-identity-not-product-identity).
- **Known existing exception, not yet migrated (Codex review, PR #258):**
  `SubscriptionPanel.tsx`'s `findAnnualPriceId()` is a second, pre-existing
  plan-selection surface (the "switch to annual" upgrade flow) that predates
  this decision and does not yet follow it — its fallback path (current price
  not found in the synced `plans` list) returns the **first** annual-recurring
  price across *all* products with no `overhype_membership` check. In that
  stale-sync scenario it can select a non-membership product's annual price;
  `switch-preview`/`switch-plan` still reject it at the grant layer, so this
  is a broken-UX gap, not a membership-bypass. Not fixed here — this is a
  docs-only PR; flagged to David to decide whether it's fixed now or
  deferred.
- **Revisit if:** any plan-selection surface — including migrating
  `SubscriptionPanel.tsx` above — is added or touched; it should reuse or
  mirror `selectPlanPrices`, not re-derive its own heuristic.

---

### 2026-07-25 · Code review gets an oracle too: implementation PRs carry the approved plan's intent, not just the diff
- **Decision:** Three additions to code review, extending the same "review
  against an oracle, not just the artifact" principle already applied to plan
  review:
  1. **The PR body carries an oracle.** The PR template's new **Approved-plan
     oracle** section holds the approved plan's Product Intent / Must Not
     Change / Settled Decisions verbatim — from the `[PLAN REVIEW]` PR body
     for the normal automated loop, or from the final approved plan document
     when the plan went through the manual/private review path instead — for
     any PR built from a plan; "n/a — no plan" for a trivial change with no
     plan and no bug behind it. *(Superseded 2026-07-26 for bugfix mode: a
     Tier A/B bug fix now carries its own **bugfix oracle** — reported
     symptom, intended behavior, must not change, root cause, blast radius,
     fix tier — instead of "n/a — no plan." A trivial Tier C schema fix
     (also no longer "n/a — no plan") uses a separate dedicated oracle block
     instead — symptom, root cause, why it's trivial, David's go-ahead, the
     migration-ceremony checklist. See
     [`working-modes.md`](./working-modes.md#the-bugfix-oracle-what-the-pr-body-must-carry).)*
     `code-review.md` now instructs reviewers to check the diff
     against that oracle and flag a dropped or narrowed requirement even if
     the code itself never mentions it.
  2. **Fix-round re-reviews request the cumulative diff after round 2+.** A
     per-round `@codex review` only shows the new commits since the last
     pass; a fix in file A can silently break something in file B from the
     *original* diff that isn't re-shown. Past the first fix round, the
     re-request explicitly asks Codex to check the full branch diff against
     `main`, not only the incremental commits.
  3. **`code-review.md`'s output section gets the same two-surface split as
     the plan-review contract** — a full-document shape for a human reviewer
     or an agent free to post one document, and a GitHub-structured-review
     shape (diff-anchored findings only, no status label, no top-level
     write-up) for the `@codex review` transport. Unlike the plan contract, a
     clean round *is* treated as sufficient evidence on code — it's backed by
     compiling, passing tests, and CI, which a plan has none of.

  Two follow-up gaps surfaced by Codex's own review of this change (real
  findings, not rubber-stamped) and fixed in the same PR:
  - The oracle-source paragraph in `CLAUDE.md` named only the `[PLAN REVIEW]`
    PR body, but a plan can also reach approval via the manual/private review
    path (the disclosure carve-out or a broken-loop fallback) with no such PR
    to copy from. Broadened to name both sources — the PR template already
    did.
  - `agent-working-rules.md`'s "reviewers use review-status labels" rule was
    stated flat, with no carve-out for the GitHub structured-review transport
    that `code-review.md` and `plan-review-contract.md` both already document
    as having no label channel at all. Qualified it to point at both.
  - `.agents/PLANS.md` (the canonical plan template) had only a combined
    Product Intent section, so the manual-fallback oracle path had nowhere
    to paste a distinct Must Not Change / Settled Decisions from. Split into
    three sections, matching the `[PLAN REVIEW]` PR body template's shape.
- **Why:** a code diff can be internally sound — well-tested, correctly
  scoped, cleanly reviewed — and still be the wrong PR, because it quietly
  narrowed or dropped part of what David approved. Reviewing the diff against
  itself can't catch that; only an external oracle can, same reasoning
  already applied to plan review's PR-body oracle. The cumulative-diff fix
  closes the equivalent "diff is not the scope" gap on the fix-round loop.
  The output-format split closes a gap `code-review.md` had that
  `plan-review-contract.md` already fixed for itself in PR #254: asking a
  transport for a shape it cannot post degrades into silent partial
  compliance rather than a visible refusal. The three follow-up gaps are the
  same class of problem one level down: a policy refined in one shared doc
  needs its other statements (a template, a second doc's flatter restatement
  of the same rule) checked for the same refinement, not just the doc it was
  first written in — Codex's own review of this PR is the concrete evidence
  that check doesn't yet happen by default and is worth staying alert for.
- **Reference:** PR #257 (docs-only; a same-session second Codex round caught
  the three follow-up gaps above before merge). Companion contract:
  [`plan-review-contract.md`](./plan-review-contract.md#the-review-oracle-the-pr-body);
  full checklist: [`code-review.md`](../engineering/code-review.md); template:
  [`pull_request_template.md`](../../.github/pull_request_template.md);
  canonical plan template: [`PLANS.md`](../../.agents/PLANS.md); ceremony:
  `CLAUDE.md`'s *Always open a PR when work is done* and *Watching the PRs I
  open* sections.
- **Revisit if:** the oracle section proves to add PR-body overhead without
  catching real scope drift after a few real plan-derived PRs, or Codex's
  GitHub connector gains a channel that makes the two-surface split
  unnecessary.

---

### 2026-07-24 · Model policy rebuilt for Opus 5 + Fable 5: `opusplan` by default, effort as a second dial, Fable reached by subagent — and delegation capped
- **Decision:** Four changes to how Claude Code is configured and steered, after
  Opus 5's release:
  - **`.claude/settings.json` default model → `opusplan`** (was pinned
    `claude-sonnet-5`). Ops-shaped turns still run Sonnet; plan mode auto-upgrades
    to Opus with no ask. **Known gap, accepted:** `opusplan` upgrades *plan-mode
    turns only*, and most of our planning cycle happens outside plan mode — the
    pre-plan conversation, and the Codex plan-review loop, which **cannot** run in
    plan mode because it commits, pushes, and opens a PR. Claude must speak up and
    ask for Opus at those two moments.
  - **Effort (`low`…`max`, default `high`) is adopted as a second dial** alongside
    model tier. Opus 5 at `low`/`medium` is strong enough that "Opus is too
    expensive for this" is no longer automatically true.
  - **Fable 5 is reached via subagents (`model: fable`), not session switches** —
    a deliberate escalation for ambiguous/root-cause/multi-sitting work that has
    already resisted a cheaper tier. It is **not** the session default, and the
    `best` alias is explicitly rejected as a persisted default because it would
    put every ops turn on the most expensive model.
  - **Subagent delegation is capped**, and the three vendored skills that
    encouraged fan-out (`dispatching-parallel-agents`,
    `subagent-driven-development`, `verification-before-completion`) carry local
    calibration blocks.
- **Why:** Opus 5 inverts two of its predecessor's biases. It **over**-delegates
  where 4.8 under-delegated, and it **self-verifies** where 4.8 needed reminding —
  so guidance tuned for 4.8 now amplifies the wrong behavior and spends quota with
  no product-visible symptom for David to catch in UAT. Separately, much of the
  recommended Opus 5 prompt tuning (scope discipline, corrections, parallel-agent
  guidance) is **already applied by the Claude Code harness itself**, so
  duplicating it into `CLAUDE.md` would be redundant — only the repo-specific caps
  were added.
- **The verification split is the subtle one:** Anthropic's guidance is to delete
  verification instructions on Opus 5. We kept the skill's *truthfulness* core
  (no completion claim without fresh evidence — David can't read diffs, so
  Claude's word is his only pre-UAT signal) and dropped only the *verify-more*
  framing (every positive statement a gate, re-checking verified work, verifier
  subagents). Deleting the whole skill would have removed a guard David actually
  depends on.
- **Settled by verification, not recall:** hooks **cannot** switch the session
  model — `SessionStart` can *read* a `model` field, but no hook output, skill
  field, or env var writes it. Only David switches the session model. Don't
  relitigate this.
- **Reference:** `CLAUDE.md` → *Token / cost discipline* (the `opusplan` default,
  the effort dial, Fable routing, the delegation cap, and the
  what-can-switch-models note); `.claude/skills/VENDORED_SKILLS_NOTICE.md` records
  the three upstream deviations.
- **Revisit if:** (a) **Fable becomes available as an advisor** — Claude Code
  currently rejects `/advisor fable` and shows it as `temporarily unavailable`
  pending a rollout; a Fable advisor would automate mid-task escalation and is the
  single change that would most replace this manual policy; (b) `opusplan`'s
  plan-mode-only boundary proves too leaky in practice, in which case pin Opus for
  whole planning cycles instead; (c) an effort sweep shows Opus at `medium` is a
  strict improvement over Sonnet at `high`, which would simplify the tier table
  considerably.

---

### 2026-07-24 · Variants are independent facts — `parent_id` is kinship + show/hide only, never metadata inheritance
- **Decision:** A variant is a fact expressing **the same concept** as its root in
  slightly different words. `facts.parent_id` exists for exactly two purposes:
  recording that kinship, and letting the UI show or hide variants. It is **not**
  an inheritance link. A variant owns its own memes, taxonomy/enrichment, Visual
  Concept, and stock/AI images, and **inherits no metadata** from its root.
  Specifically: **enrichment classifies a variant on its own text only** (the
  root's wording is *not* passed as classifier context), so **re-wording a root
  does not invalidate or re-enrich its variants**. David, verbatim: *"the only
  thing that we should be doing with variants is tracking them as having a
  parent-child relationship to the master fact… other than being able to show or
  hide variants I don't want them to be dependent upon their parents for any
  metadata. A variant can have its own memes, can have its own visual taxonomy,
  can have its own enrichment, can have its own visual concept."*
- **Why:** The code had drifted into a partial-inheritance model that was never
  stated anywhere in the docs, so it kept getting re-derived and deepened —
  `GET /facts/:factId/pexels-images` **unconditionally replaced** a variant's own
  stock images with its root's (so a variant could never use its own), fact detail
  filled in the root's images for whichever kind the variant lacked, and
  `enrichmentJobs.ts` classified variants with the root's text as context (putting
  `parentId` + parent text in the staleness fingerprint, which cascaded
  re-enrichment on a root re-word). Because no canonical statement existed, a
  reviewer reading only the code asked for the inheritance to be **mirrored into a
  new save path** — evidence that undocumented drift propagates. Structural
  cross-references stay legitimate (the link itself, show/hide grouping,
  `factActivation.ts`'s reparenting `HAS_ACTIVE_VARIANTS` guard, related-facts
  exclusion); *metadata* cross-references do not.
- **Reference:** `docs/ai-context/taxonomy-and-enrichment.md` → *Variants are
  independent facts* (canonical rule) + glossary entry "Variant (of a fact)".
  Offending sites at decision time: `routes/facts.ts:233-243`,
  `routes/facts.ts:587-590`, `lib/enrichmentJobs.ts:140-206,354-386`. Correct
  existing pattern: `enrichmentVersioning.ts`'s field-preservation invariant.
  **`sendFactBackToReview`'s `HAS_ACTIVE_VARIANTS` guard, also removed:** it
  rejected sending a root back to review while it had an active variant,
  justified by the same now-fixed assumption ("refreshing a root out from
  under active variants could silently invalidate them"). Once variants
  classify from their own text only, that justification no longer holds, so
  the guard — and the bulk-picker pre-skip, the skip-reason surface, and the
  client-side error code that mirrored it — were removed too. The
  differently-motivated `HAS_ACTIVE_VARIANTS` on `factActivation.ts`
  (reparenting a fact that itself has active children) is unrelated and
  still stands; it shares the error-code name, not the reasoning.
  **Root-edit invalidation mechanism, also to remove (Codex review, PR #251):**
  the parent-context classification model spawned its own machinery to protect
  it, which becomes dead weight once enrichment stops using parent text —
  `factTextEditProtection.ts`'s `loadDirectVariantDependencies` (blocks a
  root text edit while any direct variant has an unresolved review or an
  active enrichment job, "since their enrichment was classified with the
  parent's text as context") and `confirmedFactTextEdit.ts:200-204`
  (clears every child variant's `lastProcessedSignature` on a confirmed root
  edit, marking them `stale_for_reprocess`). Once classification is
  independent, a root re-word has nothing left to invalidate in a variant, so
  this dependency-tracking path should be removed, not merely left unfired —
  a currently-blocking guard silently going dead is exactly the kind of drift
  this decision exists to prevent.
  **Root-only media generation, also to fix (Codex review round 2, PR #251):**
  several endpoints currently reject or silently skip variants outright, which
  is a more direct violation than the readers above — a variant can't get its
  own images at all today, not just "falls back to the root's":
  `admin.ts:1990` (`POST /admin/facts/:id/refresh-images` — explicit 400,
  "Images are only stored on root facts, not variants"),
  `admin.ts:1999-2013` and `2015-2034` (the `backfill-images` /
  `backfill-pexels` bulk jobs both filter to `isNull(parentId)`, silently
  never touching variants), and — user-facing, not just admin —
  `memes.ts:1324-1332` and `pulidJobs.ts:217-233` (AI meme/PuLID generation:
  explicit 400, "AI meme generation only supported on root facts"). The
  last two mean a legendary user cannot generate an AI visual for a variant
  fact **today**, which is the exact capability David asked for. Also
  `admin.ts:2077-2091` (`POST /admin/facts/backfill-ai-memes` — a separate
  route from `backfill-pexels`, missed in the first pass of this list; both
  its `force` and non-`force` branches query `isNull(factsTable.parentId)`
  only, Codex review round 3).
  **This enumeration is illustrative, not exhaustive** — two consecutive
  review rounds each found a root-only site the previous pass missed, which
  is itself the signal: the follow-up code PR must do its own repo-wide sweep
  (e.g. every `parentId`/`isNull(factsTable.parentId)` site that touches
  images, enrichment, or AI generation) rather than trust this list as
  complete.
- **Revisit if:** we ever want a deliberate "concept-level" shared-metadata layer.
  That would be a **new explicit entity** (a concept/cluster the root and variants
  both point at), not a revival of parent-inheritance through `parent_id`.
- **Status: DONE (PR #256).** Every site enumerated above is fixed, plus the
  bulk-backfill routes converted to a durable async queue (new `fact_pexels`
  and `fact_ai_meme_backfill` lanes) and a bounded repeated-failure circuit
  breaker added to bulk-send-back so a persistently-failing fact can't create
  an unbounded number of retry cycles nor be silently declared "migration
  complete" while still excluded. See `docs/PR256_VARIANT_INDEPENDENCE_TEST_RUN.md`
  and `docs/PR256_VARIANT_INDEPENDENCE_UAT.md` for the verification record.
  This entry was a forward-looking "sites to fix" list at decision time — it
  now describes fixed behavior, not a plan.

### 2026-07-24 · Deferred engineering work gets one durable backlog, split from the product roadmap
- **Decision:** Created [`docs/engineering/deferred-work.md`](../engineering/deferred-work.md)
  as the single home for engineering/security/maintenance work consciously
  deferred — parked dependency bumps, security-hardening follow-ups, toolchain
  deprecations, code-level tech debt, infra/operational tuning. Scope is
  **engineering only**: deferred *product/feature* work stays in
  [`current-roadmap.md`](./current-roadmap.md)'s "Explicitly deferred work"
  section, cross-linked, not duplicated. Every entry carries four required
  fields — **what / why-deferred-now / cost-of-waiting / revisit-trigger** —
  so an item with an unfired trigger reads as *correctly parked*, not
  forgotten debt. The weekly `/maintenance` skill gained a step that re-checks
  every trigger and reports fired ones as decision items (never auto-acts on
  them — an explicit, narrow exception lets it commit backlog-doc updates
  directly, since that's docs-only with zero behavior change).
- **Why:** David asked directly for a way to track deferred maintenance/
  security/cleanup work without either building up invisible technical debt
  or blocking launch chasing an idealized codebase — the four-field format is
  the answer to both failure modes at once (a "why deferred" line gives
  explicit permission to wait; a "revisit trigger" as a condition, not
  "someday," keeps it from rotting into a graveyard). Everything security- or
  maintenance-shaped that had been scattered across the roadmap and
  `security-model.md` (the C5/C9 hardening follow-ups, the async-jobs pool-max
  deferral) was consolidated in — "keep everything in one place" (David).
- **Reference:** PR #245 (the doc + `/maintenance` wiring), PR #246 (the first
  real use of the process — see below).
- **Revisit if:** the engineering/product split proves awkward in practice
  (an item genuinely straddles both), or the four-field format proves too
  heavy for trivial items — surface either to David rather than quietly
  drifting the format.

### 2026-07-24 · Dependabot alert triage found the "safe patch" bumps parked in PR #243 were actually 9 disclosed CVEs, including a SQL injection in the production ORM
- **Decision:** Split `drizzle-orm` (0.45.1→0.45.2), `vite` (7.3.1→7.3.6,
  fixing 3 dev-server CVEs), `esbuild` (0.27.3→0.28.1, a direct
  `artifacts/api-server` devDependency), and `fast-uri` (3.1.0→3.1.4 via a
  pnpm `overrides` entry, fixing 4 CVEs, transitive through `ajv`) out of the
  parked Dependabot group PR #243 and shipped them immediately in PR #246 —
  zero code changes, verified via typecheck/build/codegen-drift and PR #243's
  own already-green `Test`/`Frontend Test`/`E2E Smoke` runs against the same
  resolved versions. `sharp`/`esbuild`'s original blocker (sharp 0.35's
  typings regression) stays untouched and parked — see the sharp entry in
  `deferred-work.md`, which was also corrected: it had claimed sharp 0.34.x
  "has no known CVE," which was wrong (libvips-inherited CVEs, alert tagged
  `Direct`).
- **Why:** A full manual triage of all 54 open Dependabot alerts (screenshots
  — this environment has no API/tool access to the Dependabot Alerts
  endpoint) found that three of the four packages bundled in #243 close real,
  disclosed High-severity CVEs — most importantly
  [CVE-2026-39356](https://github.com/advisories/GHSA-gpj5-g38j-94v9), a SQL
  injection in `drizzle-orm`, our direct production ORM. Waiting on the
  unrelated `sharp` blocker would have left a live SQL-injection fix sitting
  unshipped indefinitely.
- **Reference:** PR #246 (full CVE list, GHSA links, and verification in the
  PR description); `deferred-work.md`'s "Dependencies & toolchain" section.
- **Revisit if:** never — this specific decision (the 9-CVE split-and-ship) is
  closed. The ~40 remaining lower-severity alerts are a **separate, still-open
  question** — tracked with an actual weekly-checked revisit trigger in
  `deferred-work.md`'s "Dependencies & toolchain" section, not just mentioned
  here, so `/maintenance` doesn't lose track of them.

### 2026-07-23 · Fact lifecycle closed: one entrance, one exit — activation is moderation-only, and deactivation is reversible through moderation, not a direct toggle
- **Decision:** Two invariants, now enforced end-to-end (Phase 2 fact-lifecycle
  closure):
  - **One exit.** A fact can only become `is_active = true` through a single
    chokepoint, `activateFact` (`artifacts/api-server/src/lib/factActivation.ts`),
    called from exactly one place (`approveForProduction`). It re-validates, inside
    the activating transaction, that the fact carries a non-empty Visual Concept and
    that a variant's parent is still an active root — backstopped by a DB CHECK
    constraint (`facts_active_requires_concept`) so no writer, present or future,
    can create a live fact without a concept even by mistake. David, verbatim: "in
    order for the fact to be released into production, it must have a Visual
    Concept so that the image and video engines have something to work with when
    we make memes."
  - **One entrance.** Every way a fact enters the system — manual submission, bulk
    import, and variant creation — funnels through one primitive,
    `createTriageReview` (`artifacts/api-server/src/lib/moderationStaging.ts`), so a
    fact can never be born active or already enriched; it always starts at Stage 1
    (triage). `facts.is_active` defaults to `false` now (was `true`). David,
    verbatim: "there should only be two ways that a fact gets into the system...
    manual path where a user submits a fact... [and] a bulk import. In both those
    cases, the ingestion of the fact should put it on stage 1 of the moderation
    flow where it needs to be triaged, then enriched, then activated."
  - **The admin Active toggle is deactivate-only, and activation is
    moderation-only** (David-confirmed: "There's no point in having a fact in the
    database if it hasn't gone through moderation"). Deactivating a fact — directly,
    cascaded from a deactivated parent, or swept by the one-time grandfather
    backfill for pre-existing facts with no valid concept — is enforced for its
    *lifetime*, not just at activation: `cascadeDeactivateActiveChildren` runs on
    every write path that can flip a root inactive (PATCH, DELETE soft/hard,
    approved-text edits), so an active variant can never be stranded under an
    inactive/missing root.
  - **Deactivation is not a dead end.** Closing the direct-reactivate toggle
    initially left no path back for a deactivated fact at all (Codex found this
    gap in review — `sendFactBackToReview`, the only "send back to review"
    primitive, requires the fact to already be active). David asked for the fix
    rather than deferring it:
    `POST /admin/facts/:id/resubmit-for-moderation` re-enters an inactive fact at
    `prep_pending`, exactly like a first-time staging fact, reusing its existing
    id/history (no duplicate row) and riding the same pipeline back to production
    approval.
- **Why:** without both invariants closed together, a fact could still reach
  production without ever being triaged (a direct `POST /facts`, now removed) or
  without a Visual Concept (a stale enrichment, a hand-edit, a future writer that
  forgets the check) — the DB CHECK and the single chokepoint make both
  structurally impossible rather than merely policy.
- **Reference:** PR #242. Spec:
  [`moderation-workflow.md`](./moderation-workflow.md). Manual:
  [`moderation.md`](../manual/moderation.md).
- **Revisit if:** a future ingestion path is added (e.g. a partner API) — it must
  funnel through `createTriageReview` too, or this invariant silently breaks for
  that path alone.

---

### 2026-07-23 · Recurring failure patterns become CI guards, not just doc updates
- **Decision:** When a mistake already recorded in `known-failure-patterns.md`
  happens a **second** time, the default response is a deterministic CI check
  in `.github/workflows/build.yml` that makes the mistake impossible to merge
  — not a stronger doc warning or a one-off correction. This applies to any
  reviewer (Codex or Claude), not just the agent that adds the guard.
- **Why:** the `api-zod`/codegen-revert entry in `known-failure-patterns.md`
  already existed, was correct, and was consulted by nobody at the moment it
  recurred (PR #228) — a docs-only warning can't stop a mistake that happens
  before anyone thinks to check the doc. A CI guard can't be skipped that way.
  `scripts/check-codegen-drift.sh` (wired into the `Build` job as
  `pnpm run check:codegen-drift`) is the first instance of this principle.
- **Reference:** PR #236; the extended entry in
  [`known-failure-patterns.md`](./known-failure-patterns.md); the review
  checklist addition in
  [`code-review.md`](../engineering/code-review.md).
- **Revisit if:** never — standing engineering practice, not a one-off.

---

### 2026-07-22 · Visual Strategy Override is presence-based (no enable toggle); Visual Concept is required to save AND to release — one card is its only surface
- **Decision:** Three linked changes to the moderator Visual Strategy Override (VSO):
  - **Presence-based activation — the `enabled` boolean is retired.** Every VSO
    sub-field applies on its own whenever it is non-empty; there is no master
    switch. The two compiler gates that read `ov?.enabled` (`activeOverride()` in
    `nanoBanana2.ts`, `resolveRenderPolicy()` in `imagePromptGeneration.ts`) now do
    a plain presence check. **Keystone invariant:** an all-empty override compiles
    byte-identically to the old `null`/absent override (every consumer no-ops on
    empty). No migration — Zod strips the legacy `enabled` key from stored rows on
    parse (pre-launch, and David is re-doing all facts anyway).
  - **The Visual Concept (`coreSceneOverride`) is REQUIRED and blocking.** A blank
    concept blocks the admin **save** itself — the enrichment PATCH and the
    review-candidate PATCH reject it `400 visual_concept_required` — **and** blocks
    **production approval** (`CONCEPT_MISSING` on approve-visual-concept and the
    first-time/refresh production-approval paths). This **supersedes D1** of the
    "mandatory human gate" entry below: the gate no longer keys on a *saved,
    **enabled**, non-empty* concept — `enabled` is gone, and the requirement now
    also bites at save time, not only at approval. Rationale (David, verbatim): "in
    order for the fact to be released into production, it must have a Visual Concept
    so that the image and video engines have something to work with when we make
    memes."
  - **One editing surface.** The core-scene field was removed from the Advanced
    Options `VisualStrategyOverridePanel`; the prominent `VisualConceptCard` is now
    the single scene-editing surface, on both the Moderation Step-2 flow and the
    Facts page (Option 1 — David dislikes the duplicate/confusing surface).
- **Why:** The enable toggle added a confusing "populated but off" state with no
  real value — presence is a clearer, self-evident model. Requiring the concept at
  save (not only at approval) makes "a fact can't be released without something for
  the engines to render" a hard, early invariant.
- **Consequence accepted:** partial/hashtag-only admin saves that touch enrichment
  now require a non-empty concept — David explicitly accepted this blast radius.
- **Scope note (fast-follow):** the system-wide *activation guard* (no
  `isActive:true` without a concept) and the *ingestion→Stage-1 routing* principle
  (below) are a deferred pre-launch fast-follow ("Head 2"), not this change.
- **Ingestion principle (recorded now, David verbatim):** "there should only be two
  ways that a fact gets into the system. The first is the manual path where a user
  submits a fact. The second is a bulk import. In both those cases, the ingestion of
  the fact should put it on stage 1 of the moderation flow where it needs to be
  triaged, then enriched, then activated. If we ever have a future way of ingesting
  a fact (API for example) then it should also just be filling the front of that
  production pipeline."
- **Reference:** this PR (VSO presence-based + required concept, Head 1); see
  [`visual-pipeline.md`](./visual-pipeline.md) and
  [`moderation-workflow.md`](./moderation-workflow.md).
- **Revisit if:** the two ways a fact enters the system change, or the concept is
  later split per-scenario (as D1's revisit note already contemplates).

### 2026-07-22 · Speech & thought bubbles: a dedicated 900-char budget pool, funded by raising the prompt ceiling (not by shrinking an existing reserve)
- **Decision:** moderator-authored (and AI-proposed) speech/thought bubbles get
  their **own** rendered-length budget pool, `BUBBLE_DIRECTIVES_RENDERED_MAX =
  900`, funded by raising the engine prompt ceiling `PROMPT_TOTAL_BUDGET` 6000
  → **6900** — not by shrinking `CORE_SCENE_RENDERED_MAX`,
  `MODERATOR_ADDITIONS_RENDERED_MAX`, or `PROMPT_OUTER_MARGIN`. Bubbles are
  measured (and budgeted) completely separately from the existing "moderator
  additions" pool, so the two can never double-count and a bubble-heavy save
  can never silently eat another field's guaranteed capacity.
- **Why:** the merged pre-bubble budget (PR #224) was already fully allocated
  with zero spare margin, so *some* reserve had to move for bubbles to exist at
  all. Every existing reserve had already been set deliberately (each behind
  its own approval gate) — reducing one to make room for a brand-new feature
  would silently change a contract David already approved for unrelated
  content. NB2's actual context window (~131K tokens) has ample headroom below
  6900 chars, so raising the ceiling costs nothing at the engine level; the
  ceiling exists purely as editorial discipline against bloated authoring, not
  an engine capacity limit.
- **Reference:** PR #229 (plan rev 5, David-approved 2026-07-22). See
  [`visual-pipeline.md`](./visual-pipeline.md#render-time-prompt-budget) for
  the mechanics (measurement method, the escaping-precision follow-up fix).
- **Revisit if:** render evidence shows 900 chars is too tight for the bubble
  count/length the product actually needs (revisit the pool size, not the
  "separate pool, ceiling raise" funding model), or a future feature needs
  budget headroom and 6900 no longer has slack to give.

---

### 2026-07-22 · Plan review automated via a Codex draft-PR loop (replaces the manual ChatGPT paste)
- **Decision:** plan review now runs through **Codex on a dedicated,
  never-merged draft PR** instead of David hand-pasting each plan into ChatGPT.
  Claude commits the plan to a `plan-review/<slug>` branch, opens a
  `[PLAN REVIEW] … — DO NOT MERGE` draft PR, and iterates (revise → explicit
  `@codex review`) until Codex has **no substantive objections, minimum 3
  rounds**; the PR is then **closed unmerged**. Codex reviews against a shared
  contract, not its default code-review persona. **Codex convergence is not plan
  approval — only David approves.**
- **Why:** it removes the iPad copy-paste loop, gives the reviewer direct repo
  context (structurally better than a detached markdown upload), and leaves a
  durable, attributable review trail. Same OpenAI models as ChatGPT — but the
  reviewer **harness/contract matters more than the model**: the default Codex
  GitHub reviewer is tuned for serious *code* defects and can stay silent on a
  plausible-but-incomplete plan, so the loop gives Codex an explicit plan-review
  contract instead of relying on that persona.
- **Doc-routing principle applied:** the *review contract Codex executes* is
  **shared** ([`plan-review-contract.md`](./plan-review-contract.md), routed
  from [`AGENTS.md`](../../AGENTS.md)); the *workflow ceremony Claude drives* stays
  **Claude-specific** — detailed in the `plan-review-loop` skill
  (`.claude/skills/plan-review-loop/SKILL.md`), with only the guardrails that
  must fire without the skill loaded resident in `CLAUDE.md`. Instructions
  live where the agent that runs them reads — a narrower, correct split than
  mirroring one agent's whole workflow into the shared docs.
- **Guardrails (each a deliberate why):** a **public-repo disclosure check**
  keeps security-sensitive/confidential plans off the public PR channel (a
  closed-unmerged PR is still public history — see
  [`known-failure-patterns.md`](./known-failure-patterns.md#not-merged--not-disclosed-public-repo-pr-history));
  **external API/SDK/pricing claims are verified by Claude** (which has web
  access) and recorded in the plan, since Codex's review environment may be
  network-restricted; **model tier** — the whole plan-review loop is *planning*
  and stays on Opus, the only downshift to Sonnet being execution of a *simple*
  approved plan.
- **Reference:** PR #226. Operational contract: the `plan-review-loop` skill
  (`.claude/skills/plan-review-loop/SKILL.md`); reviewer contract:
  [`plan-review-contract.md`](./plan-review-contract.md).
- **Revisit if:** the loop ledger (`.agents/metrics/loop-ledger.md`) shows
  Codex's plan reviews are too shallow — e.g. a self-inflicted share that
  climbs without bound, or rounds converging on zero findings that a manual
  read would have caught. The PR **transport** stays good regardless; the fix
  would be to swap the **reviewer** (a dedicated Codex task/Action, or manual
  review for the substance) while keeping the draft-PR channel.

### 2026-07 · NB2 render pipeline hardened: terminal async failures, a measured prompt budget, 6000-char ceiling
- **Decision:** three coordinated hardening changes to the Nano Banana 2 render
  pipeline, shipped together:
  1. **Terminal vs retryable async failures.** `HandlerResult` gained an
     additive `retryable?`/`code?` shape (existing `{ok:false,error}` handlers
     are unchanged and still retry with backoff); a handler opts into
     `terminalFailure(code, message)` for a **deterministic** failure — the
     worker marks the row `failed` on the first attempt instead of burning
     retries. The image-prompt worker now classifies invalid frozen
     enrichment, an unresolved personalization token, planner
     validation-exhaustion (vs. a genuinely transient provider/timeout
     failure — `ImagePromptError` now carries a `validation_exhausted` vs
     `provider_failure` cause), a compiler throw, and a budget overflow as
     terminal, each with a typed `error_code` persisted alongside the
     human-readable `error` (new nullable `image_prompt_attempts.error_code`
     column) so the poll payload never requires parsing a "code: message"
     string.
  2. **The moderator prompt budget is *measured*, not estimated.**
     `measureRequiredPromptBudget()` compiles the fixed-shape prompt through
     the **real** Nano Banana 2 compiler across all three subject modes (at
     max-bound identity, max style copy, the longest fixed policy branches,
     the age-transform binding) to derive the compiler's true fixed overhead,
     and a proof test asserts it still fits the reserved budget — so a future
     compiler wording change that grows a required section fails CI instead
     of silently eating the moderator's authoring pool. The engine's prompt
     ceiling was raised from **4000 → 6000 chars**: David questioned the
     original 4000 mid-build — Nano Banana 2's real context window is ~131K
     tokens, so 4000 was editorial discipline against bloated prompts, not an
     engine capacity limit, and it left the moderator pools with zero margin.
     Approved split (all four terms sum to exactly 6000):
     `FIXED_REQUIRED_RESERVE_BUDGET=1750` (measured, unchanged) +
     `CORE_SCENE_RENDERED_MAX=2000` + `MODERATOR_ADDITIONS_RENDERED_MAX=1500` +
     `PROMPT_OUTER_MARGIN=750`. `CORE_SCENE_RAW_MAX` was restored to **1500**
     (matching the frontend editor's `CORE_SCENE_MAX_CHARS` and the candidate
     generator's `CANDIDATE_SCENE_MAX_CHARS`, both already 1500) rather than
     kept at the earlier plan's lowered 1200, so a save is never rejected by
     the budget gate for content the authoring UI itself presented as valid.
     The compiler no longer silently hard-truncates required content that
     overflows the budget (the old truncation could cut the STRICT
     CONSTRAINTS safety guardrails, which sit at the end of the assembled
     prompt) — it now surfaces `diagnostics.requiredBudgetOverflow` and the
     worker fails terminal (`required_budget_overflow`) instead.
  3. **The moderator-additions save check is measured through the compiler
     too, not summed from raw field text** (found by Codex mid-review, fixed
     before merge). The save-time aggregate check originally summed each VSO
     field's raw projected length, which undercounts what the compiler
     actually emits — `"Do not …"` negation prefixes on forbidden details,
     `"label: "` role-binding forms, `"; "`-joins between list entries, and
     per-section labels that only appear once a field is populated. A save
     that check accepted could still overflow at render. Fixed the same way
     as #2 — measure, don't guess: `measureModeratorAdditionsEmission()`
     compiles the fixed shape twice per mode (once with the override's
     worst-case-projected content, once with an empty override) and takes the
     delta, so every fixed cost cancels and what's left is exactly the
     additions' true compiler-emitted contribution.
  4. **Global `look_styles` copy trimmed** to a canonical ≤180-char catalogue
     for all 18 named styles via a per-column guarded migration (an
     admin-customized column is never overwritten); `RENDER_STYLE_COPY_MAX_CHARS`
     restored from a same-arc stopgap of 250 back to its intended 180.
- **Why:** the render pipeline previously retried every failure uniformly
  (wasting attempts on failures no retry could fix) and could silently
  truncate its own safety guardrails under budget pressure; the moderator
  authoring limits were invented numbers nobody could prove were safe. Measure
  real system behavior, fail loud and typed when a failure is deterministic,
  never silently drop a safety constraint.
- **Reference:** PR #224;
  [`visual-pipeline.md`](./visual-pipeline.md#render-time-prompt-budget),
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues),
  `lib/api-zod/src/promptBudget.ts`,
  `artifacts/api-server/src/lib/imagePrompt/promptBudget.ts`,
  `artifacts/api-server/src/lib/asyncJobs.ts`.
- **Revisit if:** the 6000-char split ever feels too tight/loose in practice
  (it's a one-line constant change, re-validated by the live-compiler proof
  test) — see `lib/api-zod/src/promptBudget.ts`.

### 2026-07 · Render identity + style are frozen at attempt-construction time, not re-resolved live by the worker
- **Decision:** the image-prompt async worker used to re-query the user's
  displayName/pronouns and re-resolve the selected look-style **live**, every
  time it ran — even though the fact text had already been frozen at enqueue.
  `prepareImagePromptAttemptInputs()` now resolves + freezes BOTH inputs once,
  at the moment the user clicks generate, and renders the fact text from that
  SAME frozen identity; the worker reads the frozen `PromptIdentitySnapshot` /
  `ResolvedRenderStyleSnapshot` off `render_controls` instead of re-deriving
  them, falling back to live resolution only for pre-existing attempt rows.
  Wired into both user-facing generate routes
  (`/memes/ai/:factId/generate-v2` and the generic branch of `/generate`).
  Separately, the identity fed **into the image prompt** (not the composited
  meme caption, which is untouched) is reduced to a short prompt-safe name —
  first name, else the first token of displayName, else the canonical
  fallback, grapheme-safe-bounded to `RENDERED_IDENTITY_NAME_MAX` (20 chars).
  This is a render-time reducer, NOT a new profile storage bound —
  `validators/personalName.ts` remains the sole source of truth for what a
  user may store.
- **Why:** a profile-name edit or a look-style edit/deactivation landing in
  the window between enqueue and worker execution could previously produce a
  render whose frozen fact text and whose live-resolved identity/style
  disagreed with each other — or an invalid/deactivated style silently
  degraded to "no style" instead of surfacing an error. No reason to feed a
  full (potentially very long) display name into an image model either.
- **Reference:** PR #223;
  [`visual-pipeline.md`](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility),
  `artifacts/api-server/src/lib/imagePrompt/prepareAttemptInputs.ts`,
  `promptIdentity.ts`, `styleResolution.ts`.
- **Revisit if:** a fourth render entry point (moderation/eval) needs the same
  freezing — today those paths use fixed sample identities and no live style,
  so they were already reproducible without this change; converting them is a
  clean follow-up if that stops being true.

### 2026-07 · dev-admin-login backdoor hardened fail-closed
- **Decision:** `GET/POST /api/auth/dev-admin-login` — which mints a
  bootstrap-admin session for any caller — is gated fail-closed by
  `isDevAdminLoginEnabled()`: OFF by default, opt-in only via
  `ENABLE_DEV_ADMIN_LOGIN=true` for a **non-production** preview, and NEVER
  enabled in production even if the flag is set. When disabled the handler 404s
  (no session, no cookie), and `app.ts` withholds the permissive CORS +
  origin-exemption; the UI trigger no-ops outside a dev build. The enabled path
  rotates the session (fresh sid, delete old — closes fixation) and sanitizes
  `returnTo`. Supersedes the earlier pre-launch decision to leave it open (that
  deferral is now closed).
- **Why:** it was the single highest-severity finding — unauthenticated
  privilege escalation — and must be inert on any live deployment. The flag
  preserves David's Replit-preview admin shortcut (set it in that env) while
  guaranteeing production can never enable it.
- **Reference:** finding C1, PR #221;
  [`security-model.md`](./security-model.md#dev-admin-login-backdoor-c1),
  `devAdminLogin.ts`.
- **Revisit if:** the preview admin workflow needs a different mechanism, or the
  flag's env-var contract changes.

### 2026-07 · Membership is granted only for Stripe products tagged `overhype_membership=true`
- **Decision:** "Does paying for this grant Legendary?" is decided by a
  positive allowlist keyed on the Stripe **product** metadata tag
  `overhype_membership=true`, enforced at the **grant layer** (checkout,
  subscription switch, the synchronous confirm endpoint, AND the webhook —
  grant *and* cancellation), not just at checkout. One-time grants verify the
  actual purchased product from the Checkout Session line items, never the
  mutable `membership=true` PI metadata stamp.
- **Why:** checkout previously accepted any active price and granted Legendary
  for any succeeded payment, never checking *which* product — a price/tier
  tampering hole that goes live the moment a non-membership product exists.
  David confirmed non-membership purchases are coming (render credits), so a
  product-metadata allowlist keeps the "is this membership?" decision next to
  the product in Stripe (no env/config to drift), and the grant layer is the
  authoritative gate because the webhook — not checkout — is what actually flips
  the tier.
- **Reference:** finding C6, PR #214;
  [`security-model.md`](./security-model.md#payment-trust--membership-grants-c6),
  `artifacts/api-server/src/lib/membershipPricing.ts`.
- **Revisit if:** membership products ever need per-mode (test/live) isolation
  beyond what the product tag gives, or a non-Stripe entitlement source appears.

### 2026-07 · `isPublic=false` on a meme means owner-only/secret
- **Decision:** A meme with `isPublic === false` is visible **only** to its
  creator or an admin — not "unlisted but link-shareable." Every non-owner
  (logged-in or not) gets a **404** (not 403), private responses are
  `no-store` and excluded from the Cloudflare public cache and OG preview, and
  the visibility gate runs *before* the soft-delete 410 so a deleted private
  meme is indistinguishable from a missing one.
- **Why:** David's explicit product call during the review — "private" is
  secret, so slug unguessability is not authorization. 404-over-403 avoids
  confirming a private meme exists.
- **Reference:** finding C3, PR #213;
  [`security-model.md`](./security-model.md#authorization--objects-media-and-memes),
  `artifacts/api-server/src/lib/memeVisibility.ts`.
- **Revisit if:** an "unlisted, link-shareable" tier is ever wanted as a
  *distinct* third state (it would be a new value, not a reinterpretation of
  `isPublic=false`).

### 2026-07 · Split the async-jobs worker into fast/render/bulk lanes
- **Decision:** The single async-jobs worker (`runAsyncJobsWorker`) that
  dispatched all queues through one FIFO claim query, one concurrency pool, and
  one shared re-entrancy guard is now **three independent lanes**, each with
  its own timer, its own closure-local re-entrancy guard, its own queue filter,
  and its own concurrency bound:
  - **`fast`** (`fact_send_back`, `projection_repair`) — pure-DB admin actions,
    2s poll / concurrency 2.
  - **`render`** (`image_prompt_generation`, `image_generation`) — single-item,
    moderator-watched renders, 5s poll / concurrency 3.
  - **`bulk`** (everything else: `enrichment`, `fact_enrichment_backfill`,
    `fact_pexels`, `fact_visual_concepts`, `email`,
    `review_render_scenarios_prepare` — the default for an unannotated queue)
    — 5s poll / concurrency 3 (down from the old shared default of 4).

  `registerJobHandler(queue, handler, { lane })` assigns a queue's lane
  (defaults to `bulk`); `asyncJobsTick` takes an options object
  (`{ queues?, maxConcurrency?, lane? }`) so a lane can filter its own claim and
  set its own concurrency, with `undefined` reproducing the exact legacy
  all-queues query. A queue's lane governs ONLY scheduling — retry/backoff,
  dedupe, and claim ordering (`nextAttemptAt, id`) are unchanged.
- **Why:** the shared worker caused real head-of-line blocking: a
  pure-DB admin action (Taxonomy Health "Send back to review," no model call)
  could sit in "Queued…" for 30s+ behind slow LLM/image-gen jobs claimed in the
  same batch or an unfinished prior tick, and a moderator-watched "test render"
  could wait behind an unrelated bulk backfill batch. David reported both
  symptoms directly. A 2-lane split (fast vs. everything else) was considered
  and rejected in favor of 3, specifically so moderator-watched renders also
  get isolation from bulk background batches, not just from the pure-DB
  actions. See the new "Head-of-line blocking in a shared background worker"
  pattern in
  [`known-failure-patterns.md`](./known-failure-patterns.md#head-of-line-blocking-in-a-shared-background-worker).
- **Reference:** PR #216; see
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).
- **Revisit if:** pool-acquisition wait time or provider rate-limit errors
  appear under simultaneous fast+render+bulk+HTTP load — the three lanes' combined
  handler concurrency (2+3+3=8) was deliberately kept under the DB pool's
  default `max` of 10, but raising that `max` was explicitly left out of scope
  and may become necessary. *(Superseded 2026-07-30 on the pool-`max` point:
  see [PR #288's entry](#2026-07-30--async-jobs-db-connection-pool-max-raised-to-20-explicit-and-derived--supersedes-pr-216s-deferral) — `max` is now 20, explicit and derived. This
  entry's other clause stands.)* Also revisit if a future queue needs its own
  distinct lane rather than defaulting into `bulk`.
  **Premise qualified 2026-07-30 (PR #291):** the handler-concurrency-vs-pool-`max`
  comparison this bullet rests on is not apples-to-apples — a handler holds a
  connection for the claim and finalize transactions and for whatever DB work
  it does itself, but **not** while awaiting an external provider, which for
  the provider-bound lanes is most of a job's wall-clock — so the headroom
  implied here overstates the real contention, which has never been measured. **Superseded in part the same day:** PR #288 raised
  the ceiling explicitly (`POOL_MAX_DEFAULT = 20`, derived from measured
  production capacity), so the `max` this bullet treats as fixed at 10 no
  longer holds either — that item is resolved and no longer tracked in
  `deferred-work.md`. The reasoning above is left as the record of what was
  decided at the time; see
  [`architecture-map.md`](./architecture-map.md#async-jobs-and-queues).

---

### 2026-07 · Auto-tokenize admin Visual-Concept authoring on Save
- **Decision:** Moderators author the Visual Strategy Override's rendered
  fields (Visual Concept, required/forbidden details, role visual roles,
  policy guidance) in **plain English** — naming the subject naturally, not
  hand-typed personalization tokens. Clicking **Save** runs every changed
  field through the same tokenizer core fact submission uses and **shows the
  tokenized result in the field** before it persists (shown-and-correctable,
  not a silent swap). A one-click model was chosen over a two-click
  review-then-confirm pause. A role binding's `entity` field is the one
  exception: it is a plain "subject"/role label, never tokenized — typing the
  subject's own name there auto-normalizes to `"subject"`, and a typed token
  is rejected as an error (client-side and via a hard schema backstop).
- **Why:** hand-typing tokens (possessive/reflexive/conjugation pairs) was
  error-prone and was the direct cause of the double-naming bug the compiler
  redesign (below) had to clean up; reusing the existing fact-submission
  tokenizer avoids a second, divergent tokenization implementation; showing
  (not hiding) the result keeps the moderator in control, mirroring the
  product's existing write→preview→confirm pattern for fact submission. The
  one-click model was David's explicit call over a review-pause UX.
- **Reference:** PR #206; see
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#shared-core-fact-submission-and-admin-visual-concept-authoring-pr-206)
  and
  [`visual-pipeline.md`](./visual-pipeline.md#visual-strategy-override-authoring-auto-tokenize-on-save).
- **Revisit if:** a second *named* character in authored prose becomes a
  frequent real-world problem — today it's mitigated only by an authoring rule
  + tooltips (name only the subject, use roles for everyone else), not a hard
  server-side block; a scene-aware tokenizer prompt is the deferred fix if
  that mitigation proves insufficient.

### 2026-07 · Visual Concept leads the compiled prompt; REFERENCE INTERPRETATION retired
- **Decision:** The compiled image prompt now leads with the moderator-authored
  **CORE SCENE** (Visual Concept), immediately followed by an identity/reference
  clause (i2i) or a short task line (t2i); every other section is either
  operational (identity, style, policy) or **strictly additive** — it earns its
  place only by contributing a concrete detail the Concept didn't already
  state, de-duped by content-word contiguity against the emitted text (not a
  bare substring check). The old `REFERENCE INTERPRETATION` section — which
  could structurally double a subject's name ("Alex is Alex leans against the
  bar…") when a role binding already named the subject — is retired entirely,
  replaced by the additive `ROLE DETAILS` section
  (`composeAdditiveRoleDetails`), which never doubles a name.
- **Why:** image engines weight earlier prompt text more heavily, so burying
  the authoritative scene behind reference/identity boilerplate worked against
  the very thing meant to drive the render; the retired compose function's
  `"${subject} is ${role}"` template had no guard against the role already
  naming the subject, which is exactly the shape a moderator's role binding
  produces once role labels get token-canonicalized.
- **Reference:** PR #192, #198; see
  [`visual-pipeline.md`](./visual-pipeline.md#prompt-compiler).
- **Revisit if:** render quality regresses because `ROLE DETAILS` drops
  something genuinely needed — dropped candidates are recorded in
  `diagnostics.droppedCandidates` with a reason, so this is debuggable rather
  than a guess.

### 2026-07 · Processing signatures + engine revision; bulk send-back is initiation, never completion
- **Decision:**
  - Staleness gets a second, orthogonal dimension alongside the existing
    `classificationPromptVersion` check: a `ProcessingSignature` (engine
    revision + 4 code-version constants) stamped on `facts.lastProcessedSignature`
    at classify time. Engine/model IDs are deliberately **excluded** — a config
    toggle would otherwise flip corpus-wide staleness — so an LLM/engine swap
    registers only via a manual, admin-audited **`engineRevision` bump**
    ("Mark major update"), not automatically.
  - **First-time approvals stamp fresh; direct live re-enrich never stamps.**
    A newly-approved fact is never stale-for-reprocess on day one, but an
    already-live fact only becomes fresh by going through the versioned
    refresh (send-back → promote) — a direct re-enrich writes `facts.*`
    straight and can't clear the flag.
  - **Bulk "reprocess" (PR4) is bulk *initiation*, never bulk *completion*.**
    It fans the existing single-fact send-back primitive out across many stale
    facts via the async-jobs queue — every fact still has to clear **both**
    human moderation gates (Visual Concept, then Test Renders) before it can
    promote. Nothing auto-promotes.
- **Why:** David's initial instinct was that "bulk reprocessing" shouldn't
  exist at all, since the (concurrently rebuilt) three-step moderation process
  requires a human in the loop — and that instinct is correct for bulk
  *completion*. The resolving reframe: a refresh's Visual Concept is *carried
  forward* from the live fact (not rebuilt from scratch) via the send-back
  primitive's seeded override layers, so initiating many refreshes at once
  doesn't bypass or weaken the human gates — it just fills the moderation queue
  faster than clicking the single-fact button hundreds of times. Excluding
  engine/model IDs from the signature (vs. stamping them automatically) avoids
  every config toggle silently invalidating the whole corpus; the manual bump
  keeps that invalidation an explicit, audited admin act.
- **Reference:** PR #168 (ProcessingSignature + Taxonomy Health lens), PR #205
  (bulk send-back); see
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md) and
  [`async-ui-status.md`](./async-ui-status.md).
- **Revisit if:** the product ever wants auto-promotion of a subset of
  refreshes (e.g. when only non-render-affecting inputs moved) — that would be
  a deliberate, separate decision, not an incremental extension of PR4.

### 2026-07 · Tokenizer grammar correctness batch: possessive form, "They's" retirement, coordination reach
- **Decision:**
  - `{NAME_POSSESSIVE}` always appends `'s` — including names already ending in
    `s` ("James" → "James's") — matching the server canonical renderer's
    existing `possessive()` convention, rather than a "James'" bare-apostrophe
    style.
  - The never-valid "They's" render is retired with BOTH a deterministic
    ingress fix (new templates can never store the bare `{Subj}'s` contraction
    — it's expanded to `{Subj} {is|are}` before storage) AND a one-time backfill
    of existing stored rows, rather than renderer-safety alone.
  - Coordinated `{Subj}`-subject verb wrapping (auto-wrapping a *later* verb in
    "`{Subj} runs and hides`") is explicitly NOT added to the deterministic
    net — only the immediately-adjacent verb is ever auto-wrapped. See the
    matching
    [known-failure-patterns.md](./known-failure-patterns.md#regex-grammar-rewrite-reaches-past-a-safe-anchor)
    entry for why.
- **Why:** the possessive form needed to be unambiguous and viewer-independent
  regardless of the name's spelling; "They's" is never valid English and the
  fix has to hold for both new writes and the existing corpus; coordinated
  verb-wrapping by regex can't reliably distinguish a shared subject from a new
  one once a coordinating conjunction is crossed, so "prefer no rewrite over
  the wrong rewrite" wins over broader coverage.
- **Reference:** PR #188; see
  [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Revisit if:** the product wants a "James'" possessive style instead, or a
  real parser (not regex) is ever introduced for tokenization, at which point
  coordinated-verb wrapping could be revisited.

### 2026-07 · Visual Concept is a mandatory human gate before any render spend (three-step moderation)
- **Decision:** Moderation gains a third gate. Enrichment success lands a review
  at a new **`concept_review`** stage (Step 2), where the human accepts/edits/
  writes the **Visual Concept** and **"approves the visual gag"** — and **no test
  renders run until then**. Approval advances `concept_review → production_review`
  (Step 3, "Test Renders"), which is the only stage renders fire in. Sub-decisions:
  - **D1** — gag approval requires a **saved, enabled, non-empty**
    `coreSceneOverride` on the cycle's effective enrichment (not just an AI
    candidate card, not a browser-only draft; the server checks the persisted
    value). *(Partially superseded 2026-07-22: `enabled` retired — activation is
    presence-based — and the non-empty concept is now also required at **save**
    time, not only at approval. See the presence-based VSO entry at the top.)*
  - **D2** — **no hard-cancel** of in-flight renders on a Step-3→Step-2 bounce;
    they finish but are superseded, and re-approval **force-creates a fresh batch**.
  - **D3** — **no back-migration**: pre-deploy `production_review` rows stay at
    Step 3 under the existing render/enrichment gates; the new concept gate only
    bites if an admin voluntarily bounces one back to Step 2.
  - **Force batch is dedupe-safe** — the force render-prepare enqueue carries
    **no dedupe key**, and the stage transition is an **atomic compare-and-set**
    (`UPDATE … WHERE workflow_stage='concept_review' RETURNING id`); the CAS, not
    the queue, is the double-click/concurrency guard, so two concurrent approvals
    produce exactly one batch.
  - **Stale-but-saved is allowed** — the *saved* concept, not the AI candidate
    cards, is the approved artifact; a concept saved before a later Advanced-
    Options edit still approves (only failed/pending/never-generated ideas block).
- **Why:** With the frontier planner, the Visual Concept is now the core
  description of how a gag works visually, not a break-glass override — so it
  deserves a human eval on **every** fact, and renders (which cost money) should
  not fire until that eval passes. Splitting the old bundled "visual review" step
  makes the concept gate explicit and keeps render spend behind it.
- **Reference:** PR #179; see [`moderation-workflow.md`](./moderation-workflow.md).
- **Revisit if:** the Visual Concept is later split per-scenario (the gate is
  keyed on "a saved concept exists + ideas terminal-OK", not on one concept, so a
  split changes *what* is validated, not the stage machine), or a hard-cancel of
  superseded renders becomes worth the complexity.

### 2026-07 · End-of-feature `/document` ceremony + human-facing Overhype.me Manual
- **Decision:** Adopt an explicit, David-triggered `/document` ceremony that
  harvests a finished feature's durable learnings and routes each to its one
  canonical home. Its cross-agent contract lives in
  [`documentation-workflow.md`](./documentation-workflow.md) (Claude adds a thin
  enactment skill; Codex reads the contract directly). Introduce
  [`docs/manual/`](../manual/README.md) — a human-facing *narrative* manual (how
  the system works and *why*) that grows one chapter at a time via that ceremony
  and lives **alongside** `docs/ai-context/` (the agent-facing operational
  spec), never absorbing it. Two layers, one truth: a fact is canonical in one
  place and linked from the other; generated docs stay generated.
- **Why:** Learnings otherwise evaporate with the chat transcript, and the
  "memory lives in files" habit had no explicit end-of-feature trigger. There
  was also no human-readable account of *why* the system is built the way it is;
  the generated Admin Field Reference was a first step. The ceremony is kept
  **distinct from "remember this"** (immediate single-item persistence) so a
  small memory request doesn't trigger a heavyweight harvest.
- **Reference:** PR #180.
- **Revisit if:** the manual and `docs/ai-context/` start duplicating rather
  than linking, or a lighter trigger than a full ceremony is wanted for most
  features.

### 2026-07 · One source of truth for agent context; CLAUDE.md deduped
- **Decision:** Shared product/architecture/principle truth lives once in
  `AGENTS.md` + `docs/ai-context/` + `docs/engineering/`; `CLAUDE.md` (Claude) and
  `AGENTS.md` (Codex) are thin entry doors that route into it. No principle is
  restated as full prose in more than one place.
- **Why:** Two drifting copies is worse than one — agents were relying on private
  memory for product direction. Checked-in, split-by-concern context is shared,
  reviewable, and updated alongside code.
- **Reference:** PR #171.
- **Revisit if:** a third agent with a different convention joins and can't read
  this layout.

### 2026-07 · Retire modifier→prompt-prose injection; one owner per prompt concern
- **Decision:** Enrichment `modifiers` are **not** re-injected as fixed English
  prose into the compiled image prompt. Each prompt concern has exactly one owner:
  fact meaning → planner context; the picture → moderator Visual Concept realized
  by the planner; identity/render-mode/overlay-text → the deterministic compiler;
  suppression → moderator render policy.
- **Why:** The second injection contradicted the moderator's scene (e.g. a "keep
  surfaces free of readable text" line fighting an explicit "render this in-scene
  text" line). It was scaffolding from when the planner was weaker.
- **Reference:** PR #172.
- **Revisit if:** the planner stops reliably carrying modifier intent on its own.

### 2026-07 · Readable in-scene text is allowed when required (no blanket ban)
- **Decision:** No global "no readable text" rule. The compiler emits only a narrow
  overlay-text exclusion (no baked captions/hashtags/watermarks/real logos);
  in-world text is governed by the `supportingText` policy (`allow/forbid/require`)
  and the moderator override.
- **Why:** Many jokes need legible in-scene text (formal-logic equations, tech UI,
  the pi-PIN "four crisp digits"). A blanket ban killed those.
- **Reference:** encoded in `nanoBanana2.ts`; see
  [`visual-pipeline.md`](./visual-pipeline.md).
- **Revisit if:** in-scene text quality from the model regresses badly.

### 2026-07 · Versioned enrichment; `facts.*` is the sole active truth
- **Decision:** Stale-fact refresh runs on a **candidate** enrichment version while
  the live fact stays published; `facts.*` remains the only active truth and
  `fact_enrichment_versions` is an append-only archive. AI baseline and human
  overrides stay separate columns; **human overrides survive re-enrichment**.
- **Why:** Refreshing classification under newer prompts must never drop a
  moderator's decision or take a fact offline mid-refresh.
- **Reference:** PRs #160, #164; see
  [`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md).
- **Revisit if:** the archive model needs to become active lineage (multi-active).

### 2026-06/07 · Frontier visual planner + moderator-authored Visual Concept
- **Decision:** The moderator-authored/-picked **Visual Concept** is the
  authoritative scene; a frontier-model planner (`gpt-5.5`) realizes it and a
  deterministic Nano Banana 2 compiler produces the engine prompt. `gpt-4o-mini` /
  `gpt-image-1` / FLUX are retired from the render path.
- **Why:** Human intent for the picture + a strong planner + a deterministic
  compiler beats letting a weaker model improvise the whole scene.
- **Reference:** PR #157; see [`visual-pipeline.md`](./visual-pipeline.md).
- **Revisit if:** a materially better/cheaper render model appears (config, not a
  rewrite — engines are code-first).

### pre-launch · Staged, cost-gated moderation
- **Decision:** No paid enrichment/render work runs at submission. Cheap human
  triage comes first; paid prep runs against an inactive **staging fact**;
  production approval flips it live.
- **Why:** Don't spend model/image money on spam/duplicate/low-quality
  submissions.
- **Reference:** [`moderation-workflow.md`](./moderation-workflow.md).
- **Revisit if:** triage volume makes the human first-pass the bottleneck.

### pre-launch · No rollout-flag gating; ship on-by-default
- **Decision:** New user-visible behavior ships on by default — no `enable_*`
  flags or admin toggles to flip during UAT. Only true kill-switches for
  externally-destructive actions are exempt.
- **Why:** Pre-launch the bar is "confidently correct," and hidden flags trip up
  acceptance testing. Post-launch we'll reintroduce staged rollouts deliberately.
- **Reference:** [`agent-working-rules.md`](./agent-working-rules.md).
- **Revisit if:** we launch (then this flips).

### standing · The deterministic net is the grammar guarantee, not the LLM
- **Decision:** The tokenizer's correctness comes from deterministic
  post-processing (`autoConjugatePersonSubjectVerbs`, branch-collapse), not the
  model prompt. Grammar fixes go in the net + tests, not the prompt.
- **Why:** A prompt can't be trusted to always conjugate correctly; the net can be
  proven with invariant tests.
- **Reference:** [`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md).
- **Revisit if:** never, unless the token model changes fundamentally.

### 2026-08 · Codex boots without a database; CI owns the integration suite
- **Decision:** Codex's container provisions no Postgres. `scripts/codex-setup.sh`
  installs, generates the API client, and builds `lib/**` — nothing else — and
  the database is opt-in behind `CODEX_SETUP_DB=1` for the exceptional task.
- **Why:** Boot cost is paid on *every* Codex task, and provisioning a database
  is the expensive part of it; the api-server suite is the minority need. Codex
  reviews by reading, and GitHub's required `Test` check already runs that suite
  against a real database before anything merges — so the capability lost in
  Codex is still covered at the gate that decides.
- **Reference:** PR #332; see [`codex-environment.md`](./codex-environment.md)
  for the verified capability matrix (codegen, typecheck, production build, and
  the frontend suite all pass DB-less).
- **Revisit if:** Codex starts driving backend implementation rather than review,
  or the api-server suite becomes something a reviewer must execute to trust.
