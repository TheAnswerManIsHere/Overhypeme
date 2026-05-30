# Admin Research Reference button — UAT

In-app click-through for the new "Research Reference" tool in the admin
enrichment editor. Engineering test plan:
[`REFERENCE_RESEARCH_TEST_RUN.md`](./REFERENCE_RESEARCH_TEST_RUN.md).

Goal: when an admin spots a cultural / brand / insider reference whose
visual implication needs more work (or is just missing), one click on
**Research Reference** runs a web-grounded research pass via OpenAI's
Responses API and fills in `explanation` + `visualImplication`. The admin
remains the final reviewer — high/medium-confidence + no-warnings + empty
fields auto-apply; anything else surfaces in a panel for review.

---

## Setup

1. Sign in as admin. Make sure `OPENAI_API_KEY` is set on the server
   (Responses API + `web_search_preview` tool uses the same key as the
   chat-completions path).
2. Open the admin moderation queue.
3. Pick or submit a pending review whose fact contains a known cultural
   reference, e.g. "David knows Victoria's secret."

---

## 1. Brand pun (Victoria's Secret)

1. Open the review. Locate the **Cultural / Insider References** section
   in the enrichment editor.
2. If the enrichment AI already added a row for "Victoria's secret",
   skip ahead. Otherwise add one manually:
   - `Source phrase: Victoria's secret`
   - `Reference type: brand_or_cultural_reference` (or whichever matches
     your `REFERENCE_TYPE_VALUES`)
   - `Canonical reference: Victoria's Secret`
3. Leave `Explanation` and `Visual implication` blank.
4. Click **Research reference**.

Expected within ~10–30 s:
- A spinner ("Researching…") then either:
  - **Auto-applied** (emerald banner): "Auto-applied to empty fields
    (high confidence)." The `Explanation` textarea now describes the
    Victoria's Secret brand + the pun; the `Visual implication` textarea
    describes boutique / fashion-retail / runway / fitting-room visual
    language. Confidence chip elsewhere should read "high".
  - **Result panel with buttons**: if confidence is "medium" or sources
    were sparse, the panel shows the proposed text + Apply / Replace /
    Dismiss.

Confirm:
- The visual implication mentions visual setting / props, not just a
  definition of the brand.
- It does NOT tell the image model to render the real Victoria's Secret
  logo (the validator rejects that).
- Sources details (if present) link to actual web pages.

Click **Save** on the enrichment editor (no special save step for
research — it goes through the normal enrichment save path). Regenerate
the visual preview if needed.

## 2. TV programming reference (Shark Week / David Week)

1. Submit or pick a fact like "Sharks have a David Week."
2. Add a cultural reference row:
   - `Source phrase: David Week`
   - `Reference type: pop_culture_reference`
   - `Canonical reference: Shark Week`
3. Click **Research reference**.

Expected:
- Auto-applied if confidence is high.
- Explanation identifies Shark Week as a TV programming event.
- Visual implication says the scene should show sharks watching David on
  TV with rapt attention, NOT just David swimming with sharks.

## 3. Professional / insider reference (Yardi)

1. Submit a fact like "David doesn't prepare for demos. Demos prepare for
   David. #Yardi"
2. Add a cultural reference row:
   - `Source phrase: Yardi`
   - `Reference type: professional_or_insider_reference`
   - `Canonical reference: Yardi`
3. Click **Research reference**.

Expected:
- Result panel surfaces (not auto-applied) because confidence is medium
  AND/OR ambiguity warnings exist about the insider context.
- Explanation identifies Yardi as a real estate software company and
  flags the presales-demo / internal context as something that depends
  on admin knowledge.
- Visual implication describes a polished enterprise-software demo room,
  dashboards, conference room.
- Ambiguity warning banner reads something like: "Professional-insider
  meaning cannot be fully confirmed from public sources alone."

Click **Apply to empty fields**, edit if needed, save.

## 4. Ambiguous reference (apple vs Apple)

1. Submit a fact like "David ate an apple so confidently Apple changed
   its logo."
2. The semantic-entities feature from the previous PR should produce two
   entries. For each entity that admin marks as a cultural reference
   (probably just "Apple" the brand):
   - `Source phrase: Apple`
   - `Reference type: brand_or_cultural_reference`
   - `Canonical reference: Apple Inc.`
3. Click **Research reference** on the brand row.

Expected:
- Result panel (not auto-applied) because ambiguity warnings flag the
  fruit-vs-brand confusion.
- Sources cite Apple Inc.
- Visual implication keeps the fruit-vs-brand contrast: the brand entry
  describes a corporate / product / launch-event setting; the fruit is
  handled by the existing semantic-entities pipeline.

## 5. Cache hit

1. Repeat step 1 (Victoria's Secret) on the SAME fact, SAME reference,
   without changing the source phrase / canonical name.
2. Click **Research reference** again.

Expected:
- The result panel (or auto-applied banner) opens within ~200 ms.
- A small `from cache` tag appears next to the confidence chip.
- No fresh OpenAI charge.

## 6. Existing-field protection

1. On a row where `Explanation` and `Visual implication` already have
   admin-edited text, click **Research reference**.
2. Auto-apply will NOT fire (target fields are non-empty).
3. The result panel shows proposed values without overwriting.
4. Click **Replace existing fields** → a `confirm()` dialog appears
   ("Replace existing explanation + visual implication with the
   researched values?"). Cancel keeps the existing text; OK replaces.

## 7. Admin observability

`POST /admin/references/research` is a synchronous endpoint, not an
async job. The cache table is queryable:

```sql
SELECT cache_key, created_at, result->>'confidence' AS confidence
FROM reference_research_cache
ORDER BY created_at DESC
LIMIT 10;
```

This lists recent research calls + their confidence. To purge a
specific entry (e.g. after the reference was misidentified and you want
a fresh run), delete by cache key.

---

## Known non-bugs

- Approving an enrichment that has researched fields stamps them on the
  saved cultural reference (the optional research metadata travels with
  the enrichment blob — no separate save needed).
- Auto-apply only fires when BOTH `explanation` and `visualImplication`
  are empty. If only one is empty, the result panel surfaces and the
  admin picks Apply (which fills only the empty one) or Replace.
- `Apply to empty fields` is a no-op when nothing is empty (clicking it
  leaves the row unchanged + dismisses the panel).
- Existing enrichments without research metadata stay valid — the new
  fields are all optional, no migration ran.
- Brand entries still trigger `requiresAdminReview` from the original
  enrichment AI — that warning is separate from the research-tool flow.
- The researched `explanation` / `visualImplication` are deliberately
  short (under ~800 chars). Long explanatory paragraphs are forbidden
  by the same supporting-text policy that governs the Phase 2 prompt.

## Bug report template

```
Step: <which scenario above>
Fact text: <verbatim>
Reference row: sourcePhrase="…", canonicalReference="…", referenceType="…"
Expected: <auto-apply or result panel? what visual implication?>
Got: <screenshot of the panel + any error text>
Cache hit? <yes/no>
Cache key (if needed): <copy from the network panel or sql query>
```
