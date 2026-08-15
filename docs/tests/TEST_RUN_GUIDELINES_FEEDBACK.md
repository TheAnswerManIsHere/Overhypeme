# Feedback on TEST_RUN checklists — what to keep, trim, and change

Audience: the agent authoring `docs/tests/Replit/PR<N>_*_TEST_RUN.md` checklists.
Author: Replit (the agent executing the checklists in the live workspace).
Based on executing the PR223 and PR224 TEST_RUN checklists end-to-end.

## TL;DR

The checklists have real value, but it is concentrated in a few sections.
Roughly half of each checklist re-verifies things that already passed
pre-merge and adds execution time (and, in PR224's case, ~40 minutes of
fighting environment contention) without new signal. Restructure future
TEST_RUN docs around what ONLY this environment can verify.

## What ONLY this environment can verify (keep, always)

1. **Migration state of the live database.** The "Manual DB / behavior
   checks" section (e.g. "confirm `image_prompt_attempts.error_code`
   exists", "re-running migration 0088 is a no-op") verifies that *this*
   database actually received the migrations. Nothing upstream checks this.
   Highest-value section — keep and expand if anything.

2. **Cross-PR interaction drift.** PR224's `check-snapshots` gate failed
   here because 0089/0090 landed from other PRs after the checklist was
   written and weren't in `SNAPSHOT_EXEMPT_TAGS`. That failure would have
   blocked the next deploy. Repo-health gates that depend on the *merged*
   state of main (snapshot exemptions, docs-accuracy) belong in the
   checklist precisely because the PR author cannot see post-merge state.

3. **Behavior checks against live config/data.** e.g. "force a terminal
   render failure and confirm the queue row goes `failed` after ONE
   attempt" — these exercise seeded admin_config, real look_styles rows,
   and the actual queue, which unit tests mock.

## What earns its keep as regression insurance (keep)

4. **Proof tests / tripwires.** Tests like the §21 budget proof
   (`promptBudget.test.ts` asserting the LIVE compiler measurement fits the
   reserve) convert design decisions into CI tripwires. Cheap, fast,
   subtle-failure coverage. Keep writing these; they are the best part of
   the test suites.

5. **The targeted single-file test list.** 184 tests in ~4 seconds covering
   exactly the touched surfaces. Excellent signal-to-cost ratio. Keep this
   section in every TEST_RUN, and keep it scoped to the PR's surfaces.

## What to drop or make conditional

6. **The full sharded suite re-run (`pnpm --filter @workspace/api-server
   test`).** It already ran pre-merge; re-running ~1,150 tests here mostly
   re-verifies the environment, not the code. In PR224's run it never
   completed: the pretest chain (drizzle-kit push-force → migrate →
   codegen) repeatedly stalled against `heliumdb_test` while the api-server
   dev workflow was running. Suggested policy:
   - **Run it only when the PR touches shared infra** (test runner, DB
     layer, migration runner, codegen pipeline, shared middleware).
   - Otherwise the targeted list + repo-health gates are sufficient.
   - If you do require it, add a note: "stop the `artifacts/api-server:
     API Server` workflow first to release test-DB connections."

7. **`pnpm install --frozen-lockfile`, typecheck gates.** These pass
   trivially every time because they already ran pre-merge. Keep at most a
   single line ("gates assumed green; spot-check only if something else
   fails") instead of listing all five commands as required steps.

## Authoring requests (from the executor's seat)

- **State the expected output string for each gate** (PR224 did this well:
  "check-snapshots → 'All 89 journal entries…'"). But note the count may
  drift if other PRs merge first — phrase as "all entries exempt or
  snapshotted" rather than a hard number.
- **Flag known-environmental failures explicitly** (PR224's note about
  `asyncJobs.test.ts` single-file failures was exactly right — it saved a
  false-alarm investigation).
- **Keep the "Delete me" convention.** Transient TEST_RUN + durable UAT
  sibling is a good split.
- **List any new exempt-list / allow-list entries the PR should have added**
  (snapshot exemptions, console allowlists, cycle allowlists) so the
  executor can verify rather than diagnose.

## Suggested template (future TEST_RUN docs)

```markdown
# PR<N> — <title> · TEST_RUN

## Repo-health gates (post-merge state; run always)
- check-snapshots (expected: all entries exempt or snapshotted)
- check-docs-accuracy
- <any new allow-list entries this PR added — list them>

## Targeted tests (run always)
pnpm --filter @workspace/api-server exec tsx --test <files...>
Expected: N tests, 0 fail. Known environmental failures: <list or "none">

## Full sharded suite (run ONLY if this PR touched shared infra: <yes/no + why>)
pnpm --filter @workspace/api-server test
(Stop the api-server dev workflow first.)

## Manual DB / behavior checks (run always)
1. <migration N applied — exact column/row to confirm>
2. <idempotency re-run is a no-op>
3. <live behavior check>

## Delete me
```
