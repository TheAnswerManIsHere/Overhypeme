# Semantic entities (capitalization-aware referents) — UAT

In-app click-through for the new capitalization-aware visual referent
interpretation. Engineering test plan:
[`SEMANTIC_ENTITIES_TEST_RUN.md`](./SEMANTIC_ENTITIES_TEST_RUN.md).

The goal of this PR: the system must distinguish "Earth" (the planet) from
"earth" (dirt / soil / ground) and treat that distinction as hard visual
context for both the admin preview and the Phase 2 render-time image prompt.

Existing approved facts are NOT auto-re-enriched. They keep their existing
enrichment until you choose to re-enrich them.

---

## Setup

1. Sign in as admin.
2. Make sure `OPENAI_API_KEY` is set (the enrichment + preview calls live).
3. Open the admin review queue.

---

## 1. Submit a planet-Earth fact

Submit a new fact (or wait for one in the review queue):

> When David does pushups, he doesn't push himself up, he pushes the Earth down.

After enrichment runs (auto on submission), open the review.

Expected in the **Semantic Entities / Visual Referents** section:

- One entry: `surfaceText: "Earth"`, `entityKind: celestial_body`,
  `visualReferent: "the planet Earth"` (or similar — wording from the LLM),
  `capitalizationSignal: capitalized_named_entity`,
  `materiallyAffectsVisualPrompt: true`, confidence ≥ 0.8.

Generate / regenerate the visual preview. Expected: the
**Scene concept** / **Example i2i prompt** mention "planet Earth",
not "ground" or "dirt".

## 2. Submit a soil/ground fact

> David hit the earth so hard the dirt apologized.

Expected entry: `surfaceText: "earth"`,
`entityKind: common_noun`,
`visualReferent` references "ground / dirt / soil / terrain",
`capitalizationSignal: lowercase_common_noun`,
`materiallyAffectsVisualPrompt: true`.

Generate the preview. Expected: scene mentions ground/soil/terrain, NOT the
planet.

## 3. Sentence-initial ambiguity

> Earth moves when David does pushups.

Expected entry: `surfaceText: "Earth"`,
`capitalizationSignal: sentence_initial_ambiguous`,
`requiresAdminReview: true`, confidence likely 0.6 – 0.8.

You should see a warning banner above the editor:

> Ambiguous sentence-initial entity: "Earth" — confirm interpretation.

The LLM's best guess is probably still "the planet Earth" given the
pushup-moves-the-world idiom, but you have a clear admin-review flag.

## 4. Two entities, same fact (apple + Apple)

> David ate an apple so confidently Apple changed its logo.

Expected: TWO entries.
- "apple" → `common_noun`, "an apple fruit".
- "Apple" → `brand_or_cultural_reference`, "the Apple technology brand /
  company", `requiresAdminReview: true`.

Warning banner above the editor:

> Brand / cultural reference entity: "Apple" — confirm rendering policy.

The visual preview should keep the fruit + the brand visually distinct.

## 5. Manual edit

Open any approved or pending fact's enrichment. In the **Semantic
Entities** section, click **Add entity**. Fill in:

- `surfaceText: "Sun"`
- `normalizedText: "sun"`
- `entityKind: celestial_body`
- `visualReferent: "the visible Sun in the sky"`
- `capitalizationSignal: capitalized_named_entity`
- `materiallyAffectsVisualPrompt: true`
- `requiresAdminReview: false`
- `confidence: 0.9`

Save the review. Reopen — the entry persists. Approve. The blob retains
the manual entry.

## 6. Render-time consumption (Phase 2)

(Requires `enable_image_prompt_v2 = true` from the previous PR.)

1. Pick a fact with a semantic entity that materially affects the prompt
   (use case 1 or 2 above).
2. As a legendary user, upload a reference photo and click Generate. The
   Phase 2 confirmation modal opens.
3. Pick the appropriate render mode.
4. Open `/admin/image-prompt/attempts?factId=<id>&limit=1`.

Expected `visualPlan.semanticEntitiesUsed`:

```json
[
  {
    "surfaceText": "Earth",
    "visualReferentUsed": "the planet Earth",
    "effectOnVisualPlan": "Composition pulled back to show the whole planet under David's hand"
  }
]
```

Or for case 2: `visualReferentUsed: "ground / dirt / soil beneath David"`.

The rendered image should match. If `Earth` shows up as soil (or `earth`
shows up as the planet), that's the bug this PR is preventing — note the
attempt id and the rendered image path for diagnosis.

---

## Known non-bugs

- Existing facts without `semanticEntities` are still valid — the field
  defaults to `[]`. They keep their existing enrichment until you re-enrich
  per fact.
- The enrichment AI does NOT need to list every noun. Only entries that
  materially affect the visual prompt or carry genuine ambiguity should
  appear.
- Variants don't inherit semantic entities from a parent fact — each
  variant is enriched independently (existing behavior, unchanged).
- Brand entries (Apple, Amazon, Windows) trigger `requiresAdminReview` by
  design. The system isn't deciding brand-sponsorship policy yet; admin
  reviews each brand interpretation manually.
- The validator's echo-back rule only fires when the enrichment has
  `materiallyAffectsVisualPrompt: true` entries. If the AI flags an entity
  with `materiallyAffectsVisualPrompt: false`, the visual plan is free to
  omit it.

## Bug report template

```
Step: <which scenario above>
Fact text: <verbatim>
Expected entity: surfaceText="...", visualReferent="..."
Got: <screenshot of the Semantic Entities section, or "no entry created">
Preview / render-time mismatch: <yes/no — if yes, attach attempt id from
  /admin/image-prompt/attempts>
```
