# PR224 — NB2 prompt hardening · TEST_RUN (engineering)

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Three slices: §12 terminal/retryable async failures, §10
measured prompt budget, §14 style-copy trim. Two migrations (0087 additive
column, 0088 idempotent guarded UPDATE). **Replit owns the database
connection** — no `DATABASE_URL` / test-DB env is set anywhere in this doc;
apply the repo's normal migration flow against Replit's own DB. The
`_UAT.md` sibling (`docs/PR224_NB2_PROMPT_HARDENING_UAT.md`) is the durable,
product-visible half.

**No test suites in this checklist, deliberately.** This PR's behavior is
covered by `asyncJobs.test.ts`, `promptBudget.test.ts`,
`nanoBanana2Compiler.test.ts`, and `styleResolution.test.ts` — all of which
already ran and passed in CI against a real Postgres, on this exact code.
Re-running them here would verify the environment, not the code. Everything
below is what CI genuinely cannot see: the state of the live database and
the live app.

---

## §21 numbers — APPROVED by David (2026-07-21)

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
  CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  exemptions this PR added: `0086_retire_style_integration_add_supporting_text_kind`
  (hand-authored DML, actually introduced by PR222 but only exempted here),
  `0087_image_prompt_attempts_error_code` (hand-authored DDL), and
  `0088_trim_global_look_style_copy` (hand-authored DML) — all three are in
  `SNAPSHOT_EXEMPT_TAGS` — confirm all three entries are present.
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Other allow-list entries this PR added: none.
- Pre-merge gates (install, typecheck, codegen drift) are assumed green;
  spot-check only if something above fails.

## Live checks (read-only unless noted; run always)

1. **Migration 0087 applied** — confirm `image_prompt_attempts.error_code`
   exists (`varchar(64)`, nullable).
2. **Migration 0088 applied** — confirm the 18 named `look_styles` rows now
   carry the trimmed ≤180-char copy on both `prompt_suffix` and
   `prompt_suffix_reference`; `none` is untouched (empty). Re-running
   migration 0088: a second `migrate` skips it via the content-hash
   tracker — confirm skipped, not re-applied, no changes. (Separately, the
   guarded `UPDATE`'s own `WHERE` clauses are also SQL-level idempotent —
   they match nothing once applied — but that's a distinct fact from the
   tracker skip, not a substitute for it.)
3. **Terminal render failure** — force a deterministic failure (e.g. an
   attempt whose frozen enrichment snapshot is invalid) and confirm the queue
   row goes `failed` after ONE attempt and the attempt row has both `error`
   and a typed `error_code`.
4. **Save-time budget rejection** (rejected-request probe — writes nothing
   that persists) — PATCH `/admin/facts/:id/enrichment` (or the review
   candidate endpoint) with a Visual Concept over 1500 raw chars, or with
   ~110+ `{NAME}` tokens (raw small, rendered huge): expect **HTTP 400**
   `visual_strategy_override_over_budget` with per-field `details`. A normal
   Concept saves fine.

Proof tests guarding this PR's budgets (run in CI, listed for awareness):
`asyncJobs.test.ts`, `promptBudget.test.ts`, `nanoBanana2Compiler.test.ts`,
`styleResolution.test.ts`. What they lock in:
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

## What's deliberately NOT shipped

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
