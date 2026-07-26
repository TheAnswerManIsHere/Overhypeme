# PR224 — NB2 prompt hardening · TEST_RUN (engineering)

Technical safety-net checklist for Replit. Three slices: §12 terminal/retryable
async failures, §10 measured prompt budget, §14 style-copy trim. Two migrations
(0087 additive column, 0088 idempotent guarded UPDATE).

Replit owns the database connection — don't add `DATABASE_URL` / test-DB env
here; apply the repo's normal migration/test flow against Replit's own DB.

---

## ✅ §21 numbers — APPROVED by David (2026-07-21)

The moderator authoring limits below are **derived** from
`measureRequiredPromptBudget()` run against the real compiler. David revisited
the original 4000-char ceiling — NB2's actual context window is ~131K tokens, so
4000 chars (<1% of it) was an editorial forcing function, not an engine
capacity limit — and approved raising it to **6000 chars**, with the raw
Visual Concept cap restored to its original 1500 (never stricter than legacy
content).

| Constant | Value | What it is |
| --- | ---: | --- |
| `FIXED_REQUIRED_RESERVE_BUDGET` | **1750** | Compiler-owned fixed sections. **Measured worst case = 1704** (human i2i + age-transform binding + 20-char identity + 180-char style + longest fixed policy lines); reserved with cushion. Unchanged — this is measured, not a product choice. |
| `CORE_SCENE_RENDERED_MAX` | **2000** | Moderator Visual Concept, worst-case **rendered** length. |
| `MODERATOR_ADDITIONS_RENDERED_MAX` | **1500** | All other moderator content (role bindings, required/forbidden details, subject realization, composition, additions, both policy guidances) — aggregate rendered length. |
| `PROMPT_OUTER_MARGIN` | **750** | Outer safety slack (plan requires ≥100). |
| `CORE_SCENE_RAW_MAX` | **1500** | Raw (pre-render) Concept storage cap — restored to match the existing VSO schema cap; a new save is never stricter than legacy content. |

Arithmetic: `1750 + 2000 + 1500 + 750 = 6000 ≤ 6000` ✓. The proof test
(`promptBudget.test.ts`) asserts the **live** measurement still fits, so a future
compiler wording change that grows a required section fails CI instead of
silently shrinking the moderator pool.

---

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`; do not substitute `check-snapshots` — it fails on plain
  `main` today for a pre-existing, unrelated gap, see
  [`test-run-contract.md`](engineering/test-run-contract.md)). New exemptions
  this PR added: none — `0087`/`0088` are hand-authored and don't need
  `SNAPSHOT_EXEMPT_TAGS` entries (`validate-snapshots` skips pairs with no
  snapshot file rather than requiring one).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Install/typecheck (`install --frozen-lockfile`, `typecheck:libs`, per-package
  `typecheck`) — pre-merge gates assumed green; spot-check only if something
  below fails.

## Full sharded suite — shared infra touched: no

This PR is §12 async terminal/retryable handling + §10 prompt budget + §14
style-copy trim — no test runner, DB layer, migration runner, codegen
pipeline, or shared middleware change. The targeted list below is sufficient;
skip the sharded run. (Replit's own experience running this checklist: the
sharded suite never completed here — the `pretest` chain stalled against
`heliumdb_test` while the api-server dev workflow held connections open. That
cost is exactly what skipping it here avoids.)

## Targeted tests

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
  ≤ 6000; rendered cap ≥ raw cap); the VSO save validator (raw cap, worst-case
  rendered cap on a token-heavy Concept under the raw cap, additions-pool
  aggregate, Concept not double-counted into additions).
- **§10.5** — the compiler signals `requiredBudgetOverflow` and does NOT truncate
  (length > 6000) instead of silently dropping guardrails.
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
   review candidate endpoint) with a Visual Concept over 1500 raw chars, or with
   ~110+ `{NAME}` tokens (raw small, rendered huge): expect **HTTP 400**
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
