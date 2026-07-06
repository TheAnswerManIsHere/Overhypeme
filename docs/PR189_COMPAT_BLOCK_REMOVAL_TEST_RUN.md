# PR189 — Remove the compatibility render block · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification that
> `subjectFactCompatibility` no longer blocks rendering in any mode. Companion
> click-through: `docs/PR189_COMPAT_BLOCK_REMOVAL_UAT.md`.
>
> Touches the render-time image-prompt worker, the planner's validator + two
> prompt copies, and an `admin_config` DML migration (0084). **No new tables,
> no destructive schema change.**

---

## 1. Build + typecheck

```bash
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
```

Expect: both clean (`tsc --build`, then `tsc -b` + `check:cycles` +
`check:no-console` for api-server — no disallowed `console.*`, no import
cycles beyond the existing allow-listed one).

## 2. Apply the migration

Apply pending migrations (0084 is the new one) the same way you always do for
this repo. Confirm the migration runner reports `0084_strip_stale_compatibility_fallback_rule`
as applied, and that re-running the migration command reports it **already
up-to-date** (idempotent — 0 applied on the second run).

What 0084 does: scrubs one stale sentence from the `admin_config` row at key
`fact_image_prompt_system` (both its `value` and, if set, `debug_value`
columns) — the old "when rating is poor, recommendedFallback MUST be one of
… Never 'none' for a poor rating" instruction — replacing it with wording that
says the field is advisory only. It is a targeted, gated `UPDATE …
SET value = replace(value, '<exact old sentence>', '<new sentence>') WHERE key
= 'fact_image_prompt_system' AND value LIKE '%Never "none" for a poor
rating.%'` — if that admin has already hand-edited this config key away from
the shipped default (unlikely, but possible), the `LIKE` guard means the
migration is a safe no-op for that row; if the key still has its seeded
default, the stale sentence is replaced.

## 3. Backend tests

```bash
BCRYPT_SALT_ROUNDS=4 TEST_DB_ALLOW_EXIT_ON_IDLE=1 node --import tsx/esm \
  --experimental-test-isolation=none --test-concurrency=1 --test \
  src/__tests__/imagePromptGeneration.validate.test.ts \
  src/__tests__/factRenderScenarios.test.ts \
  src/__tests__/adminReviewRenderTools.test.ts \
  src/__tests__/imagePromptJobs.test.ts \
  src/__tests__/imagePromptEngine.test.ts \
  src/__tests__/imagePromptSystemPrompt.test.ts \
  src/__tests__/imagePromptUserMessage.test.ts
```

(Run from `artifacts/api-server/`.) Expect **108 pass / 0 fail**. The tests
that matter most for this PR:

- **`imagePromptJobs.test.ts`** (new file) — **2 tests**, the deterministic
  proof the block is gone. For a `poor`-rated plan AND a `risky`-rated plan
  (both against the real test DB), asserts:
  1. the attempt row's `error` column is `NULL` (not
     `"subject_fact_compatibility_poor"`);
  2. `subjectFactCompatibility` persists with the rating exactly as given;
  3. an `async_jobs` row exists with `queue = "image_generation"`,
     `payload.attemptId` matching the attempt, `dedupe_key =
     "image_generation:attempt:<id>"`, and status `pending`.

  This is the regression lock a live render can't provide — the planner runs
  at nonzero temperature, so a rerun of any one fact may not redraw `"poor"`
  again. This test doesn't depend on the planner at all; it drives the
  extracted `persistImagePromptPlanAndEnqueueGeneration()` helper directly.

- **`imagePromptGeneration.validate.test.ts`** — the test that used to be
  named "rejects compatibility rating=poor with recommendedFallback=none" is
  now **"accepts compatibility rating=poor with recommendedFallback=none
  (advisory only, never blocks)"** and asserts `result.ok === true`. Confirms
  the removed validator rule (a plan with `poor` + `"none"` used to fail
  Structured Outputs and force a wasted corrective retry — it no longer does).

- **`factRenderScenarios.test.ts`** / **`adminReviewRenderTools.test.ts`** —
  unchanged assertions (both renamed to say "legacy"/"maps legacy … rows"):
  a stored `error = "subject_fact_compatibility_poor"` value still maps to
  scenario/status `"blocked"`. This is intentionally still green — it proves
  **historical** attempt rows from before this PR keep displaying correctly;
  it does not mean new renders can produce this state.

## 4. Frontend test

```bash
pnpm --filter @workspace/overhype-me exec vitest run src/components/admin/useModerationRender.test.tsx
```

Expect **3 pass / 0 fail**. The renamed test ("surfaces a legacy blocked
render distinctly from failure…") still feeds the hook a synthetic
`blocked`-status poll response (as historical-payload coverage) — no
component code changed.

## 5. Stale-reference sweep

```bash
# (a) Hard-block / hard-fallback language — should return ONLY legacy
#     mapping code/tests (imagePromptAttempts.ts's buildRenderStatusPayload
#     and the renamed legacy tests), never a live gate:
rg 'subject_fact_compatibility_poor|blockedPoor|must NOT be "none"|rating is "poor" but recommendedFallback|attempt blocked: subject_fact_compatibility=poor|Never "none" for a poor rating' artifacts lib docs

# (b) Advisory-field audit — these terms are EXPECTED to remain live
#     (schema, payload, admin UI, docs); eyeball that none describe the
#     field as blocking:
rg 'subjectFactCompatibility|recommendedFallback' artifacts lib docs
```

Expect (a) to show only: `imagePromptAttempts.ts`'s legacy-mapping code and
comment, the renamed legacy tests in `factRenderScenarios.test.ts` /
`adminReviewRenderTools.test.ts` / `useModerationRender.test.tsx`, and the
migration file's own "old text" literal (needed to match against it). Nothing
in `imagePromptJobs.ts`, `generator.ts`, or `imagePromptConfig.ts`.

## 6. Manual render check (the actual end-to-end proof)

Render **Review #6810** (the finger-countdown fact) or another fact you know
previously drew `subject_fact_compatibility_poor`, in **Generic (t2i)** mode,
from the moderation Test Renders panel.

- **Expect: it now produces an image instead of a "Blocked" tile.**
- Confirm i2i (Male/Female) still renders as before.
- Open the attempt's diagnostics/admin payload and confirm
  `subjectFactCompatibility` is still present (rating + reason +
  recommendedFallback) — it's advisory now, not gone.
- **Record whether this specific render actually drew `rating: "poor"` or
  something else.** The planner runs at temperature 0.4, so a rerun of the
  same fact is not guaranteed to redraw `"poor"` — if it doesn't, this manual
  check still proves normal t2i rendering works, but the automated test in
  §3 (`imagePromptJobs.test.ts`) is the deterministic proof of the removed
  block, not this manual step.

## 7. What's deliberately NOT shipped in this PR

- **Scope 2 (full removal)** — `subjectFactCompatibility` stays in the
  planner's structured output, the DB column, and the admin surfaces
  (`RuntimePromptPreview`, `FactRenderScenarioTile`, `AiBgPicker`,
  `SourceImageConfirmModal`). It is advisory-only display metadata now, not
  removed. Those frontend surfaces already react to the `status` field, so no
  UI code change was needed for the block's removal — `status` simply never
  comes back as `"blocked"` for new attempts.
- **The compiler double-naming bug** (`"Alex Franklin is Alex Franklin
  leans…"` in the REFERENCE INTERPRETATION section) — a separate, already
  identified issue, deliberately deferred to its own `/bugfix` PR right after
  this one.
- **The #172 skill/doc refresh** (dead `modifierDirectives.ts` reference,
  modifier-retirement model) — unrelated follow-up, not folded in here.
- **No migration/backfill of historical rows** carrying `error =
  "subject_fact_compatibility_poor"` — those rows are untouched and continue
  to display as `blocked` via the preserved legacy mapping.
