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
checklist was re-verification. Structure the doc around the four things below,
and demote the rest.

## What earns a section (always include, when applicable)

1. **Live-database migration state.** The highest-value section — nothing
   upstream checks that *this* database received the migration. Name the exact
   column/table/row to confirm, its type and nullability, and state that
   re-running the migration is a no-op (and why: `IF NOT EXISTS`, a guarded
   `WHERE`, etc.).

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

4. **The targeted single-file test list**, scoped to exactly the surfaces this
   PR touched. Best signal-to-cost ratio in the doc — a couple hundred tests in
   seconds. Keep it scoped; it is not a place to list adjacent files "for
   safety."

Proof tests / tripwires — a test that asserts a live measurement still fits a
design budget, so a future change fails CI instead of silently degrading —
belong in the targeted list and are worth calling out by name. They are the
highest-value tests we write.

## What to demote

- **The full sharded suite** (`pnpm --filter @workspace/api-server test`) is
  **conditional, not default.** Include it only when the PR touches shared
  infra — the test runner, the DB layer, the migration runner, the codegen
  pipeline (`lib/api-spec`, `lib/api-zod`), or shared middleware. State the
  verdict explicitly in the heading: *run only if shared infra touched —
  yes/no + why.* When it is required, add the operational note: **stop the
  `artifacts/api-server: API Server` workflow first** to release test-DB
  connections, or the `pretest` chain (push-force → migrate → codegen) stalls
  against the test database.

- **Install and typecheck gates** (`pnpm install --frozen-lockfile`,
  `typecheck:libs`, per-package `typecheck`, codegen drift) pass trivially
  every time because they already ran pre-merge. Compress to a **single line** —
  "pre-merge gates assumed green; spot-check only if something else fails" —
  rather than five required steps.

## Authoring requirements

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

## Template

```markdown
# PR<N> — <title> · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no DATABASE_URL / test-DB env
is set here.

Pre-merge gates (install, typecheck, codegen drift) are assumed green; spot-check
only if something below fails.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entries this PR added: <list, or "none">
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: <list, or "none">

## Targeted tests (run always)
<exact command>
Expected: ~N tests, **0 fail**. Known environmental failures: <list or "none">
Proof tests to note: <name them, or "none">

## Full sharded suite — shared infra touched: <yes/no + why>
<If yes:>
`pnpm --filter @workspace/api-server test`
(Stop the `artifacts/api-server: API Server` workflow first to free test-DB
connections.)
<If no: omit this section's command entirely — the heading's "no" is the
answer, do not leave an executable command underneath it.>

## Manual DB / behavior checks (run always)
1. Migration <N> applied — confirm <exact column/table/row, type, nullability>
2. Re-running migration <N> is a no-op — <why: IF NOT EXISTS / guarded WHERE>
3. <live behavior check against seeded config / real queue / real data>

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
