# PR #666 — Helpers and research move to the GPT-6 models — UAT

**Workstream:** #665

The everyday AI helpers move off the old `gpt-4o-mini` onto GPT-6 Luna, and the admin Research Reference tool moves off `gpt-4.1` onto GPT-6.1 Sol. You chose to split the helpers by what they decide (2026-10-13):

- **Reasoning at `low`:** the duplicate check, comment moderation, the image classifier, video direction and scene prompts.
- **No reasoning (`none`), fast and keeping their temperatures:** pronouns, hashtags and stock-photo keywords.

Steps 1–5 are checked by tests in CI, and steps 6–9 by live checks I run after the merge. Only 10–11 need your eye.

## Setup

- [claude] Confirm the Repl is synced to the merge commit and the live `openai-general` engine row reads `gpt-6-luna` at effort `none` (post-merge step 2, done at close-out).
- [claude] Pick one approved fact whose enrichment names a public reference, for the Research Reference step.

## Steps

### 1. Each helper asks for the reasoning you chose

**Do:** Run the per-call-site test.

**Expect:** The five judgement helpers send effort `low`; the quick lookups send `none` and keep their temperature.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/utilityLLM.reasoningEffort.test.ts`

### 2. GPT-6 at `none` keeps the caller's temperature

**Do:** Run the call-shape test.

**Expect:** At `none` a GPT-6 model sends temperature and the caller's budget; at any other effort it drops temperature; gpt-5 models are unchanged.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/openaiChatParams.test.ts`

### 3. Research uses Sol with web search and refuses a cut-off answer

**Do:** Run the research request test.

**Expect:** The request uses `gpt-6.1-sol`, the `web_search` tool, effort `low` and at least 25,000 tokens of reasoning room; an `incomplete` answer is refused with its reason.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/referenceResearch.request.test.ts`

### 4. The stored research prompt is updated only if untouched

**Do:** Run the prompt-migration test.

**Expect:** A stored prompt equal to the old default is rewritten to name `web_search`; a customised one is left alone.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/referenceResearchConfig.migration.test.ts`

### 5. The admin engine editor accepts Luna and refuses Sol

**Do:** Run the admin-engines route test.

**Expect:** Saving `gpt-6-luna` at effort `none` succeeds; saving `gpt-6.1-sol` is refused.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/adminEngines.test.ts`

### 6. The live helper engine is on Luna

**Do:** Read the live `engines` row `openai-general`.

**Expect:** `endpoint_id` is `gpt-6-luna` and `default_reasoning_effort` is `none`.

**Lane:** live

**Check:** `SELECT endpoint_id, default_reasoning_effort, default_temperature FROM engines WHERE id = 'openai-general'` via the Replit connector (read-only)

### 7. The duplicate check answers on Luna at `low`

**Do:** Call the duplicate check once on the live environment with a known near-duplicate pair.

**Expect:** It returns parseable JSON with `isDuplicate` and `matchIndex`, within its 60-token answer budget.

**Lane:** live

**Check:** `POST /api/ai/check-duplicate` called once through the Replit connector (read-only); response quoted in the run record

### 8. A picture-reading helper works on Luna

**Do:** Generate one video direction for a fact with a source image on the live environment.

**Expect:** A non-empty motion direction comes back, with no API error about image input.

**Lane:** live

**Check:** `artifacts/api-server/src/lib/videoDirection.ts` — `generateVideoDirection` run once through the Replit connector with a live image URL; response quoted in the run record

### 9. Research completes on Sol and logs its thinking

**Do:** Run Research Reference once on the chosen fact's reference.

**Expect:** The call completes (`status` `completed`) and the server log line `[referenceResearch.openaiResponses] usage` shows the reasoning tokens used, below 25,000.

**Lane:** live

**Check:** `artifacts/api-server/src/lib/referenceResearch/openaiResponses.ts` — the admin Research Reference route run once through the Replit connector; the usage log line quoted in the run record

### 10. The engine editor reads clearly

**Do:** Open `/admin/engines`, open "OpenAI — General Intelligence", and look at the model and reasoning-effort controls.

**Expect:** The model reads "GPT-6 Luna", Sol is not offered, the empty effort option reads "model default", and the labels make it clear that temperature only applies at None.

**Lane:** human

### 11. The research explanation reads right

**Do:** Open the chosen fact's enrichment editor and look at the Research Reference result from step 9.

**Expect:** The explanation and visual guidance are accurate and useful, and the sources are real pages.

**Lane:** human

## Regression

### R1. The fact tokenizer keeps its own model

**Do:** Run the tokenizer test.

**Expect:** The tokenizer still uses `gpt-5.4-mini` at low effort, untouched by this change.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/factTokenizer.test.ts`

## Not bugs

- The admin reasoning-effort dropdown only reaches the three quick lookups. The five judgement helpers are pinned to `low` in code, per your split, so changing them is a code change.
- The duplicate check and image classifier no longer use their temperature setting, because reasoning models ignore it. This is the trade-off of the split.
