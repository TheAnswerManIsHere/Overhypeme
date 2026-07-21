# PR224 — NB2 prompt hardening · TEST_RUN (engineering)

Technical safety-net checklist for Replit. Three slices: §12 terminal/retryable
async failures, §10 measured prompt budget, §14 style-copy trim. Two migrations
(0087 additive column, 0088 idempotent guarded UPDATE).

Replit owns the database connection — don't add `DATABASE_URL` / test-DB env
here; apply the repo's normal migration/test flow against Replit's own DB.

---

## ⚠️ §21 numbers gate — DAVID APPROVES THESE BEFORE MERGE

The moderator authoring limits below are **derived** from
`measureRequiredPromptBudget()` run against the real compiler — they can't be
honestly invented, so per the plan the PR generates them and you approve them
before merge. The engine's hard ceiling is **4000 chars**.

| Constant | Value | What it is |
| --- | ---: | --- |
| `FIXED_REQUIRED_RESERVE_BUDGET` | **1750** | Compiler-owned fixed sections. **Measured worst case = 1704** (human i2i + age-transform binding + 20-char identity + 180-char style + longest fixed policy lines); reserved with cushion. |
| `CORE_SCENE_RENDERED_MAX` | **1250** | Moderator Visual Concept, worst-case **rendered** length. |
| `MODERATOR_ADDITIONS_RENDERED_MAX` | **800** | All other moderator content (role bindings, required/forbidden details, subject realization, composition, additions, both policy guidances) — aggregate rendered length. |
| `PROMPT_OUTER_MARGIN` | **200** | Outer safety slack (plan requires ≥100). |
| `CORE_SCENE_RAW_MAX` | **1200** | Raw (pre-render) Concept storage cap (lowered from 1500). |

Arithmetic: `1750 + 1250 + 800 + 200 = 4000 ≤ 4000` ✓. The proof test
(`promptBudget.test.ts`) asserts the **live** measurement still fits, so a future
compiler wording change that grows a required section fails CI instead of
silently shrinking the moderator pool.

**If you want a different split** (e.g. more Concept room, less additions), say
so — it's a one-line change in `lib/api-zod/src/promptBudget.ts`; the proof test
re-validates it. Nothing else in the PR depends on the exact split.

---

## Build / typecheck / migration gates

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/db check-snapshots
node scripts/check-docs-accuracy.mjs
```

Expected: all clean. `check-snapshots` → "All 89 journal entries have snapshot
files (or are explicitly exempt)" (0086/0087/0088 are hand-authored, exempt).

## Automated tests

```bash
pnpm --filter @workspace/api-server test
```

Expected: **all shards pass, 0 fail.** (The logged `OPENAI_API_KEY must be set…`
line is a non-failing warning inside a test.)

Targeted:

```bash
pnpm --filter @workspace/api-server exec tsx --test \
  src/__tests__/asyncJobs.test.ts \
  src/__tests__/promptBudget.test.ts \
  src/__tests__/nanoBanana2Compiler.test.ts \
  src/__tests__/styleResolution.test.ts
```

(Note: `asyncJobs.test.ts` has two PRE-EXISTING failures under the single-file
runner — email "not configured" and a max-attempts case — that pass under the
sharded runner; they are environmental, not from this PR. The two NEW async
tests — terminal-first-attempt + retryable-still-retries — pass under the
sharded runner.)

What the new tests lock in:
- **§12** — `terminalFailure` marks the row `failed` on the FIRST attempt
  ignoring `maxAttempts`; a plain `{ok:false,error}` still retries (opt-in).
- **§10** — the live-compiler budget proof (measured ≤ reserve; reserves+margin
  ≤ 4000; rendered cap ≥ raw cap); the VSO save validator (raw cap, worst-case
  rendered cap on a token-heavy Concept under the raw cap, additions-pool
  aggregate, Concept not double-counted into additions).
- **§10.5** — the compiler signals `requiredBudgetOverflow` and does NOT truncate
  (length > 4000) instead of silently dropping guardrails.
- **§14** — the 18+`none`=19 style catalogue is complete, no dup ids, none over
  `RENDER_STYLE_COPY_MAX_CHARS`.

## Manual DB / behavior checks

1. **Migration 0087** — confirm `image_prompt_attempts.error_code` exists
   (`varchar(64)`, nullable).
2. **Migration 0088** — confirm the 18 named `look_styles` rows now carry the
   trimmed ≤180-char copy on both `prompt_suffix` and `prompt_suffix_reference`;
   `none` is untouched (empty). Re-running the migration is a no-op (the guarded
   WHERE clauses match nothing once applied).
3. **Terminal render failure** — force a deterministic failure (e.g. an
   attempt whose frozen enrichment snapshot is invalid) and confirm the queue
   row goes `failed` after ONE attempt and the attempt row has both `error` and
   a typed `error_code`.
4. **Save-time budget rejection** — PATCH `/admin/facts/:id/enrichment` (or the
   review candidate endpoint) with a Visual Concept over 1200 raw chars, or with
   ~65+ `{NAME}` tokens (raw small, rendered huge): expect **HTTP 400**
   `visual_strategy_override_over_budget` with per-field `details`. A normal
   Concept saves fine.

## What is deliberately NOT shipped

- **No look-style save validator.** `look_styles` has no admin edit route (it's
  migration-seeded); the 180-char copy bound is already enforced at resolve time
  (`resolveRenderStyle` → `copy_too_long`), so there's no save path to guard.
- **No UI budget counter.** Server-side save rejection is the enforcement; the
  projected-usage numbers are returned in the 400 `details` and in the validator
  result for a future in-editor counter.
- **The pre-existing async-durability issue** (non-atomic insert→enqueue /
  compiled-persist→enqueue) remains a separate hardening item per the plan.

## Delete me

Transient — delete once Replit has run the checklist. The `_UAT.md` sibling is
the durable half.
