# PR #673 — Research Reference accepts "avoid the logo" guidance — UAT

**Workstream:** #672

The admin Research Reference tool was rejecting good answers for brand references. Its safety check failed any answer that both said "show …" and mentioned a logo, even when the logo mention was "avoid logos". GPT-6.1 Sol writes that avoidance guidance on almost every brand reference, so brands like Peloton always failed. The check now accepts avoidance and still rejects real instructions to draw a logo, brand mark, the fact text or hashtags.

## Setup

- [claude] Confirm the Repl is synced to the merge commit.
- [claude] Pick an approved fact whose enrichment includes a brand reference, for step 4.

## Steps

### 1. Avoidance guidance is accepted

**Do:** Run the validator test.

**Expect:** Sol's real Peloton answer and other "avoid / no / without / do not show the logo" phrasings pass validation.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts`

### 2. Real logo directives are still rejected

**Do:** Run the same test.

**Expect:** "Render the real Apple logo", "Show the Nike logos", "Display hashtags …" and "Avoid clutter, but show the Peloton logo" are rejected as forbidden content.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts`

### 3. Peloton research succeeds live

**Do:** Run the research service once on the live environment for the Peloton reference, forcing a fresh lookup.

**Expect:** A result comes back, not from cache and with no validation error.

**Lane:** live

**Check:** `artifacts/api-server/src/lib/referenceResearch/index.ts` — the research service run once through the Replit connector with `forceRefresh: true`; result quoted in the run record

### 4. A brand research result reads right

**Do:** Open the chosen fact's enrichment editor and click Research Reference on its brand reference (use Re-fetch if it says "from cache").

**Expect:** A result appears with useful visual guidance and real sources, and it tells the image model to avoid the logo rather than draw it.

**Lane:** human

## Regression

### R1. The other research checks still hold

**Do:** Run the validator test.

**Expect:** Empty fields, definition-only guidance and high confidence without sources are still rejected.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/referenceResearch.validate.test.ts`

## Not bugs

- A research answer can still be rejected for other reasons, such as missing sources at high confidence; only the logo/hashtag check changed.
