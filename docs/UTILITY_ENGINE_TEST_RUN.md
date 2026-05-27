# Utility Engine Consolidation — Automated test run

This is the engineering-side checklist for the change landed in **PR #76**
(branch `claude/elegant-einstein-5IxR4`). It routes **every** OpenAI
chat-completion call through one admin-configurable engine. Hand it to
Replit (or run locally) to confirm everything came across correctly.

The User Acceptance Test is in
[`UTILITY_ENGINE_UAT.md`](./UTILITY_ENGINE_UAT.md) — that one is for the
product owner to walk through in a browser.

**What this PR is:** a refactor + consolidation. There is **one new
engine row** and a shared dispatch helper; behavior for the default model
(`gpt-4o-mini`) is unchanged. The win is that the model + sampling +
reasoning effort for *all* LLM calls now live in one editable place
(`/admin/engines`) instead of being hardcoded or duplicated across
per-feature `admin_config` keys.

**Scope of changes:**

- **New dispatch** — `lib/utilityLLM.ts → callUtilityLLM()`: loads the
  default `llm` engine and runs the completion via the existing
  `lib/openaiChatParams.ts → chatModelTuningParams()`, so reasoning
  (gpt-5 / o-series → `max_completion_tokens` + `reasoning_effort`) and
  non-reasoning (gpt-4.x → `max_tokens` + `temperature`) models both work.
  Falls back to baked-in defaults if no default `llm` engine exists.
- **New engine** — `lib/engines/openai-general.ts` (`provider: "openai"`,
  `kind: "llm"`, `endpointId: "gpt-4o-mini"`), added to `ALL_ENGINES` and
  reconciled like any other engine. New `EngineKind` value `"llm"`.
- **Schema** — `engines` gains `default_temperature numeric(4,2)`,
  `default_max_tokens integer`, `default_reasoning_effort varchar(16)`.
  Added idempotently via `seed.ts` `ensureSchema()` (`ADD COLUMN IF NOT
  EXISTS`); the dev/test DB picks them up via `drizzle-kit push`. **No new
  numbered migration.**
- **Admin-editable model** — `endpointId`, `default_temperature`,
  `default_max_tokens`, `default_reasoning_effort` added to
  `ADMIN_EDITABLE_FIELDS`. `reconcile.ts` keeps `endpointId` **code-owned
  for non-`openai` providers** (fal endpoints can't be edited away); the
  PATCH route only accepts `endpointId` for `provider: "openai"` and
  validates the value against an allow-list of OpenAI models.
- **Migrated every chat call site** to `callUtilityLLM`:
  `routes/ai.ts` (comment moderation, duplicate check, tokenize-fact,
  suggest-pronouns), `lib/factImagePipeline.ts` (image keywords),
  `lib/aiMemePipeline.ts` (image scene prompts), `lib/videoDirection.ts`
  (video motion direction — still a vision call), and
  `lib/factEnrichment.ts` (fact taxonomy enrichment).
- **Slimmed config modules** — `scenePromptConfig.ts`,
  `videoDirection.ts`, `factEnrichmentConfig.ts` now expose **only their
  editable system prompt**; model/sampling/reasoning come from the engine.
  A `seed.ts` DELETE migration drops the now-dead `*_model`,
  `*_temperature`, `*_max_tokens`, `*_reasoning_effort` keys.
- **Admin UI** — `/admin/engines` editor gains a model dropdown +
  temperature + max-tokens + reasoning-effort for the `llm` engine, hides
  the fal-only fields, and hides the synthetic test bench for it.
  `/admin/config` "AI Style Prompt Configuration" panel now shows just the
  two editable system prompts.

---

## TL;DR

```bash
export DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test"

# 1. Repo-wide typecheck — libs + api-server (cycles + no-console) + frontend.
pnpm run typecheck

# 2. Make sure the engine columns exist (push is what the session hook runs).
pnpm --filter @workspace/db run push-force

# 3. Seed the engine catalogue into the test DB once. The session-start hook
#    only does `drizzle-kit push` (schema, no data), so the `engines` table is
#    EMPTY until something reconciles — and engineReconcile's *preservation*
#    tests need rows to exist. Boot once, or run reconcile directly:
cd artifacts/api-server && \
  DATABASE_URL="$DATABASE_URL" node --import tsx -e \
  'import { reconcileEngines } from "./src/lib/engines/index.ts"; await reconcileEngines(); process.exit(0);'

# 4. Server tests for the touched surface.
#    NOTE: the sharded runner (`pnpm test`) is broken in this environment on a
#    `--test-isolation=none` flag; run the files directly instead.
DATABASE_URL="$DATABASE_URL" BCRYPT_SALT_ROUNDS=4 \
  node --import tsx --test \
    src/__tests__/openaiChatParams.test.ts \
    src/__tests__/utility* 2>/dev/null; \
DATABASE_URL="$DATABASE_URL" BCRYPT_SALT_ROUNDS=4 \
  node --import tsx --test \
    src/__tests__/scenePromptConfig.test.ts \
    src/__tests__/videoDirection.test.ts \
    src/__tests__/factEnrichment.test.ts \
    src/__tests__/openaiChatParams.test.ts \
    src/__tests__/routes.ai.test.ts \
    src/__tests__/adminEngines.test.ts \
    src/__tests__/engineReconcile.test.ts

# 5. Frontend.
cd ../overhype-me && pnpm run typecheck && pnpm exec vitest run
```

Expected: typechecks clean; all listed server suites pass with **0
failures** (`adminEngines` = 53 incl. 3 new LLM-PATCH cases;
`engineReconcile` = 7); frontend typecheck clean + vitest green.

If everything above is green you can stop. Sections below break each step
out in case something fails.

---

## A — Setup gate

### A1. Test DB up + engine columns present

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name='engines'
     AND column_name IN ('default_temperature','default_max_tokens','default_reasoning_effort')
   ORDER BY column_name;"
```

Pass criterion: all three columns present. (They come from `drizzle-kit
push` in dev/test, and from `ensureSchema()` `ADD COLUMN IF NOT EXISTS` on
a prod boot — a prod-restore-into-dev self-heals.)

### A2. The `llm` engine reconciles

After a boot (or the reconcile in TL;DR step 3):

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, provider, kind, endpoint_id, is_default, is_active,
          default_temperature, default_max_tokens, default_reasoning_effort
   FROM engines WHERE kind='llm';"
```

Pass criterion: exactly one row — `openai-general`, `provider=openai`,
`kind=llm`, `endpoint_id=gpt-4o-mini`, `is_default=t`, `is_active=t`,
`default_temperature=0.70`, `default_max_tokens=512`,
`default_reasoning_effort=low`. It must be the **only** default for kind
`llm` (the one-default-per-kind invariant — that's why this is a new kind,
not piggy-backed on the existing `utility` default).

### A3. Per-feature model/sampling keys retired; system prompts kept

```bash
# Retired — expect ZERO rows after boot (seed.ts DELETE migration):
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT key FROM admin_config WHERE key IN (
     'scene_prompt_model','scene_prompt_temperature','scene_prompt_max_tokens','scene_prompt_reasoning_effort',
     'video_direction_model','video_direction_temperature','video_direction_max_tokens','video_direction_reasoning_effort',
     'fact_enrichment_model','fact_enrichment_temperature','fact_enrichment_max_tokens','fact_enrichment_reasoning_effort');"

# Kept — the three editable system prompts survive:
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT key FROM admin_config
   WHERE key IN ('scene_prompt_system','video_direction_system','fact_enrichment_system') ORDER BY key;"
```

Pass criteria: first query returns **0 rows**; second returns all **3**.

### A4. No stray hardcoded chat calls

```bash
grep -rn "chat.completions.create" artifacts/api-server/src --include=*.ts | grep -v utilityLLM.ts
grep -rn "getOpenAIClient" artifacts/api-server/src --include=*.ts \
  | grep -v -e utilityLLM.ts -e __tests__
```

Pass criterion: the first returns **no matches** (the only
`chat.completions.create` lives in `utilityLLM.ts`; embeddings use
`embeddings.create`, which is fine). The second should show only
`utilityLLM.ts` importing the client.

---

## B — Server tests

Run from `artifacts/api-server` (see TL;DR step 4 for the full command).
Pass criterion: all suites pass, 0 fail.

### B1. openaiChatParams

Unchanged from #75 — confirms the reasoning vs non-reasoning call-shape
split that `callUtilityLLM` now relies on.

### B2. scenePromptConfig / videoDirection

These were rewritten to system-prompt-only. Each confirms: the system
prompt seeds + is returned by the getter; it's stored as a `text`
(textarea) row; seeding is idempotent (an admin edit survives re-seed);
and the debug overlay promotes `debug_value` only when `debug_mode_active`.

### B3. factEnrichment

Unchanged orchestration tests (model caller injected, no network):
valid-first → 1 call; bad-then-good → retry once; bad-then-bad → throws
after 2 calls. Proves the consolidation didn't change the
parse→validate→retry contract; only the transport (now `callUtilityLLM`
with `temperature: 0.2`, `maxTokens: 600` call-site overrides) changed.

### B4. routes.ai

`tokenize-fact`, `check-duplicate`, `suggest-pronouns` (and the
`stripUnknownTokens` repair from the latest `main`) — now dispatched
through `callUtilityLLM`. Pass criterion: 0 fail.

### B5. adminEngines (53)

Includes **3 new** LLM-PATCH cases:
- `endpointId` edit on a **non-OpenAI** engine → `400` ("only editable for
  OpenAI engines").
- model + sampling + reasoning edit on an **OpenAI llm** engine → `200`,
  persisted (`endpointId`, `defaultTemperature`, `defaultMaxTokens`,
  `defaultReasoningEffort`).
- an **unknown model** value → `400` ("endpointId must be one of …").

### B6. engineReconcile (7)

Confirms the two-tier reconcile still holds after the new fields + the
`endpointId`-code-owned-for-fal rule: admin edits to `isActive` /
`defaultResolution` survive, `paramSchema` is overwritten, tombstones are
preserved. **Requires the `engines` table to be seeded first** (TL;DR step
3) — on a truly empty table the preservation cases have no row to edit and
will fail with a misleading assertion (test-harness artifact, not a code
bug).

---

## C — API smoke (curl)

Once the server is running, with an **admin** session.

### C1. Edit the model + sampling on the engine

```bash
curl -i -s -X PATCH -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"endpointId":"gpt-4o","defaultTemperature":0.5,"defaultMaxTokens":700,"defaultReasoningEffort":"low"}' \
  http://localhost:<api-port>/api/admin/engines/openai-general
```

Pass criterion: `200`, body reflects the new values. Re-`GET
/api/admin/engines` and confirm `openai-general` shows them.

### C2. Reject an invalid model / wrong provider

```bash
# Unknown model → 400
curl -s -X PATCH -H "Cookie: <admin-session>" -H "Content-Type: application/json" \
  -d '{"endpointId":"gpt-9-imaginary"}' \
  http://localhost:<api-port>/api/admin/engines/openai-general

# endpointId on a fal engine → 400
curl -s -X PATCH -H "Cookie: <admin-session>" -H "Content-Type: application/json" \
  -d '{"endpointId":"gpt-4o"}' \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-lite
```

Pass criteria: first → `400` ("endpointId must be one of …"); second →
`400` ("endpointId is only editable for OpenAI engines"). Confirm
`veo-3.1-lite`'s `endpoint_id` is unchanged.

### C3. A consuming feature still works end-to-end

With OpenAI provisioned, hit any consumer and confirm it uses the engine's
model. Easiest is tokenize:

```bash
curl -s -X POST -H "Cookie: <user-session>" -H "Content-Type: application/json" \
  -d '{"text":"David can slam a revolving door."}' \
  http://localhost:<api-port>/api/ai/tokenize-fact | jq .
```

Pass criterion: `200 { template: "…" }` with the name tokenized. Change
the engine's model (C1) to another value and confirm calls still succeed.

---

## D — Frontend

```bash
cd artifacts/overhype-me
pnpm run typecheck      # tsc --noEmit — clean
pnpm exec vitest run    # green
```

Frontend pieces touched:
- `pages/admin/engines.tsx` — the `llm`-only model dropdown + sampling +
  reasoning fields, fal fields hidden, test bench hidden.
- `pages/admin/_configShared.tsx` — `SCENE_PROMPT_KEYS` /
  `VIDEO_DIRECTION_KEYS` reduced to the system prompt; `SELECT_CONFIGS`
  emptied (model/reasoning dropdowns moved to the engine editor).
- `pages/admin/config.tsx` — the "AI Style Prompt Configuration" panel
  copy.

---

## E — What's deliberately NOT changed

Flag these as expected, not failures:

- **No behavior change at the default model.** `gpt-4o-mini` with the same
  effective sampling — the meme/video/enrichment output is unchanged.
- **Reasoning support is opt-in.** The default model is a chat model;
  `reasoning_effort` only takes effect if an admin selects a gpt-5 /
  o-series model.
- **The governance label in `/ai/suggest-hashtags`** is gone with that
  endpoint (removed upstream in #75); there is no `suggest-hashtags` here.
- **No new numbered migration** — the three engine columns are added via
  `ensureSchema()` (same convention #75 used for its `facts.*` columns).

---

## F — Environment note

Real completions require the OpenAI integration to be provisioned:

```
AI_INTEGRATIONS_OPENAI_API_KEY
AI_INTEGRATIONS_OPENAI_BASE_URL
```

Section B does not need OpenAI (no network — DB + validation + injected
callers). Section C's "consuming feature" step and the UAT's end-to-end
steps do.
