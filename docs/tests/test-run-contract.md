# TEST_RUN authoring contract (what Replit executes)

> **Audience:** whoever authors a `docs/PR<N>_<FEATURE>_TEST_RUN.md` (in
> practice, Claude Code — see [`CLAUDE.md`](../../CLAUDE.md) for the PR-first
> naming/delivery ceremony). This file owns the doc's **content and shape**;
> `CLAUDE.md` owns *when* it ships and *what it's called*.
>
> **Executor:** Replit, running the checklist in the live workspace against the
> live database, **after** the PR has merged to `main`.

## The governing rule

**A TEST_RUN verifies what only Replit's environment can verify.** Everything
else in the checklist already passed pre-merge in CI — re-running it there
re-verifies the *environment*, not the code, and costs execution time (and
sometimes an hour of environment contention) for no new signal.

Replit's own feedback after executing several of these: roughly half of each
checklist was re-verification. Structure the doc around the things below,
and demote the rest.

**And it verifies it read-only (David, 2026-08-08).** A TEST_RUN instructs a
person operating against the live workspace, so the checklist itself must be
harmless to follow:

- **Never instruct re-running a test suite CI already ran on the merged
  code** — full or targeted. It adds no signal, and it is where all the risk
  lives: writing safe isolation for suite re-runs on a live workspace is what
  PR #356 spent five review rounds and 36 findings failing to do before the
  sections were simply deleted.
- **Never instruct anything that mutates cluster-global or live state**: no
  test files that create/drop PostgreSQL roles or grants (roles are
  cluster-scoped — no schema- or database-level isolation contains them), no
  successful writes to live `admin_config` or other production rows, no
  stopping of workflows without an explicit restart step. The permitted
  writes are exactly two shapes: a request whose *rejection* is the thing
  being tested (a 403 refusal probe writes nothing), and a write with a
  restore path through the same surface, captured **before** the write.
- **Read-only SQL is the workhorse.** Schema/catalog checks, count queries,
  backfill-outcome verification — all safe to run any number of times, and
  they cover what CI genuinely cannot see.

A TEST_RUN doc is criticality 1 on the 1–100 scale
([`working-modes.md`](../ai-context/working-modes.md#review-loops-need-a-stopping-rule-not-just-a-convergence-target)) —
but only because of this rule. A checklist that instructs risky operations
against production is not a criticality-1 artifact no matter how transient
the file is; keeping the doc read-only is what keeps it harmless.

## What earns a section (always include, when applicable)

1. **Live-database migration state.** The highest-value section — nothing
   upstream checks that *this* database received the migration. Name the exact
   column/table/row to confirm, its type and nullability. For rerun behavior,
   describe what actually happens — a second `migrate` is **skipped by the
   content-hash tracker**, not re-executed, so it confirms tracking rather
   than SQL-level idempotency (don't claim "re-running is a no-op" as though
   the SQL runs twice; that claim was a round-1 finding on PR #356). If the
   migration ran a backfill, add a **read-only** count query verifying its
   outcome on live data — including a bucket for the rows that *should* have
   been transformed and weren't, not just the malformed ones.

2. **Post-merge repo-health gates.** These depend on the *merged* state of
   `main`, which the PR author could not see when writing the doc — so a gate
   that was green on the branch can be red here because another PR landed
   first. Always run **both** snapshot gates — they check different things:
   - `pnpm --filter @workspace/db validate-snapshots`
     (`lib/db/scripts/validate-migration-snapshots.ts`) — the gate CI's
     `build.yml` actually runs. Checks that consecutive snapshots are
     consistent with the SQL between them; silently skips any pair with a
     missing snapshot file.
   - `pnpm --filter @workspace/db check-snapshots`
     (`lib/db/scripts/check-migration-snapshots.ts`) — checks that every
     journal entry has a snapshot file **or** an explicit
     `SNAPSHOT_EXEMPT_TAGS` entry. This is the gate `validate-snapshots`
     doesn't do: it's what catches a migration that shipped with neither a
     generated snapshot nor an exemption comment — exactly what happened with
     `0089`/`0090` (added without exemptions, causing this gate to fail on
     `main` for a stretch after PR228/PR229 merged, until a later commit
     added both tags). That gap is now closed (both entries exist), so this
     gate is green again and back to being required, not skipped.
   - `node scripts/check-docs-accuracy.mjs`
   - plus **any new allow-list / exempt-list entry this PR added** — a new
     `SNAPSHOT_EXEMPT_TAGS` entry in `check-migration-snapshots.ts`,
     `artifacts/api-server/scripts/check-no-console.mjs` allowlist entries,
     `artifacts/api-server/scripts/check-cycles.mjs` allowlist entries. **List
     them explicitly** so Replit can *verify* the entry rather than *diagnose*
     an unexplained gate failure.

3. **Behavior checks against live config and data.** Anything that exercises
   seeded `admin_config`, real catalogue rows, the real queue, or a real
   external call — the things unit tests mock. e.g. "force a terminal render
   failure and confirm the queue row goes `failed` after ONE attempt."

4. **Targeted test runs — rare, and only for live-environment-specific
   behavior.** Per the read-only rule above, a test that already passed in CI
   on the merged code is not re-run here. A targeted run earns its place only
   when the test genuinely measures something the live environment changes
   (live config values, real external-service reachability) — and never a
   file that mutates cluster-global state (role/grant creation), which is
   banned from TEST_RUN docs outright regardless of wrapper (wrapper
   isolation is schema-level; roles are cluster-scoped). The default for
   this section is **none**.

Proof tests / tripwires — a test that asserts a live measurement still fits a
design budget, so a future change fails CI instead of silently degrading —
are worth *naming* in the doc (so Replit knows they exist and what they
guard), but they run in CI, not here.

## What to demote

- **The full sharded suite** (`pnpm --filter @workspace/api-server test`) is
  **omitted by default — CI ran it on this exact code.** Per the read-only
  rule above, "the PR touches shared infra" is no longer a reason to re-run
  it on Replit: CI's coverage is the answer to that risk, and a live-workspace
  re-run adds environment contention plus a stopped-workflow hazard (the
  suite requires stopping the `artifacts/api-server: API Server` workflow,
  and nothing restarts it — leaving the app down for the manual checks and
  the UAT that follow). Include it only if David explicitly asks.

- **Install and typecheck gates** (`pnpm install --frozen-lockfile`,
  `typecheck:libs`, per-package `typecheck`, codegen drift) pass trivially
  every time because they already ran pre-merge. Compress to a **single line** —
  "pre-merge gates assumed green; spot-check only if something else fails" —
  rather than five required steps.

## Authoring requirements

- **Every api-server test command must route through its wrapper script** —
  `bash artifacts/api-server/scripts/run-test.sh <file...>` for a targeted
  single-file run, `pnpm --filter @workspace/api-server test` for the full
  suite (which itself runs `run-tests-sharded.sh`, a separate wrapper from
  `run-test.sh` — both are safe, don't conflate them). **Never** write a raw
  `node --import tsx/esm --test` or
  `pnpm --filter @workspace/api-server exec tsx --test` command in a TEST_RUN
  doc — both bypass `run-test.sh`'s production-DB guard entirely (the guard
  never executes, so the test runs against whatever `DATABASE_URL` already
  points at — `heliumdb`, the live schema, on Replit). See
  [`./TESTING.md`](./TESTING.md#quick-commands) for the full danger
  explanation. This rule is api-server-specific: frontend Vitest commands
  (`pnpm --filter @workspace/overhype-me exec vitest run <file...>` /
  `run test`) aren't DB-backed and have no equivalent wrapper to route
  through — write them directly. This bit four separate checklists in one review pass before
  being caught — check every command you write against this rule, not just
  the ones you copied from an older doc.
- **State the expected output for every gate**, but **phrase it drift-proof**.
  "All 89 journal entries…" goes stale the moment another PR merges a
  migration; write "all entries exempt or snapshotted" instead. Same for test
  counts: `0 fail` is the assertion, an exact total is a hint.
- **Flag known-environmental failures explicitly**, with the reason and the
  runner they appear under (e.g. "these two fail under the single-file runner
  and pass under the sharded runner — pre-existing, not from this PR"). This
  saves a false-alarm investigation and is one of the most appreciated things
  in the doc.
- **Replit owns the database connection.** Never include `DATABASE_URL=…`
  exports, test-DB env setup, or any environment-specific DB config — Replit's
  database lives elsewhere and anything written here would be wrong there.
  Describe *what* should happen against the DB and let Replit connect.
- **Keep the "Delete me" footer.** The transient TEST_RUN + durable UAT sibling
  split is deliberate and works.
- **Keep "what's deliberately NOT shipped" to terse bullets.** It exists so
  Replit does not diagnose a deliberate absence as a defect — not as a design
  essay. Anything longer belongs in the plan or in
  [`deferred-work.md`](deferred-work.md).

## Precision matters more than the stop/continue call (David, 2026-08-09)

David directs Replit's failure posture per run (e.g. "stop and report on any
error so one failure in a back-to-back batch doesn't cascade into the next")
— that instruction is his to give each time, and it is not a checklist
authoring concern. What the checklist owns is **being precise about what
actually is a failure**, because whatever it calls a failure gets escalated
under whatever posture is active. PR293 is the example: the run correctly
stopped on David's stop-on-error instruction, but the checklist itself
mischaracterized a value migration 0097 deliberately treats as a
`RAISE WARNING` (`dangling`) as equivalent to the one value that's an actual
invariant break (`linkable_but_unlinked`) — see the corrected
`docs/PR293_NCMEC_CYBERTIPLINE_TEST_RUN.md` for the fix. Getting the
must-flag/may-ignore line right in the doc is what keeps a correctly-obeyed
stop instruction from firing on a false alarm.

## Replit's handoff documents are ephemeral too (David, 2026-08-09)

When Replit stops mid-run and writes a handoff document describing what it
ran, what it found, and where it stopped, that document is **transient in
exactly the way a TEST_RUN checklist is** — a message in flight, not a
record, and it follows the same lifecycle. As of 2026-08-09 these live in
[`docs/handoff/`](../handoff/README.md), which owns the full contract
(naming, the delete-once-addressed rule, the describe-state-don't-snapshot-it
authoring note, and the public-repo disclosure check) — this file no longer
restates it.

## Template

```markdown
# PR<N> — <title> · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here.

Pre-merge gates (install, typecheck, codegen drift) are assumed green; spot-check
only if something below fails.

No test suites here — this PR's suites ran and passed in CI on this exact
code. Everything below is what CI cannot see: the live database and the live
app. Nothing below writes a row<, except <the one exception + its
capture-before/restore-after steps — or delete this clause>>.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entries this PR added: <list, or "none">
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: <list, or "none">

## Live checks (read-only; run always)
1. Migration <N> applied — confirm <exact column/table/row, type, nullability,
   constraint/trigger definitions where correctness-critical>
2. Re-running migration <N>: a second `migrate` skips it via the content-hash
   tracker — confirm skipped, not re-applied, no changes
3. <If the migration backfilled: read-only count query over live data,
   including the should-have-been-transformed-but-wasn't bucket>
4. <live behavior check against seeded config / real queue / real data —
   rejected-request probes are fine; successful live writes need a
   captured-before restore path or don't belong here>
Proof tests guarding this PR's budgets (run in CI, listed for awareness):
<name them, or "none">

## What's deliberately NOT shipped
- <terse bullets>

## Delete me
Transient — delete once the checklist has been run. The `_UAT.md` sibling is
the durable half.
```

## Related

- [`testing-guide.md`](testing-guide.md) — how tests are actually run in this
  repo, and what to report after running them.
- [`migrations-and-backfills.md`](migrations-and-backfills.md) — the
  idempotency and row-state expectations a migration check should assert.
- [`CLAUDE.md`](../../CLAUDE.md) — the PR-first delivery ceremony, naming, and
  the UAT sibling.
