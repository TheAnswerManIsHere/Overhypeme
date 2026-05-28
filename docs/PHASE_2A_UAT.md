# Fact Enrichment Extension (Phase 2A Bridge) — UAT

You're the end user here. This UAT validates the **Phase 2A bridge** —
cultural references + a visual prompt preview added to fact enrichment, the
hard approval gate, and the on-demand fact preview. The bigger infra change
(generalizing the email outbox into a shared async-jobs queue, switching
OpenAI to our direct key) ships under the hood — the regression smoke at the
end confirms it.

**This phase does NOT change how any image or video looks.** Nothing about
the meme/video output changes yet. You're verifying that:
- The classifier now also emits structured **cultural references**.
- The system produces a **visual interpretation preview** (text) you can
  review/edit before approval.
- Approval is **hard-blocked** until enrichment + preview both exist.
- You can generate a preview **on demand** for an already-approved fact.

The automated test side is in [`PHASE_2A_TEST_RUN.md`](./PHASE_2A_TEST_RUN.md)
and is owned by Replit AI; that runs in parallel and you don't need to read it.

If anything fails, write down which section + step, what you saw vs. what you
expected, and a screenshot. Bug-report template at the bottom.

---

## Setup

1. Pull the latest from `claude/visual-taxonomy-prompt-arch-cb8up`.
2. Boot the dev app. The session-start hook brings up the test DB and one
   migration applies (`0063` — email_outbox → async_jobs) with no manual SQL.
3. You need:
   - An **admin** login.
   - Any **logged-in** user to submit a fact.
4. **Important — direct OpenAI key required:** set `OPENAI_API_KEY` (the same
   key `embeddings.ts` already uses). Without it the legacy proxy fallback
   still works (`AI_INTEGRATIONS_OPENAI_*`), but the unification only takes
   effect with the direct key. With no key at all, enrichment/preview mark
   "failed" gracefully — and you can still exercise the manual-fill path.

**What's new since Phase 1:**

- **Cultural references panel** in the admin review modal — a per-card editor
  for each outside-context dependency the classifier detected. You can edit
  the explanation + visual implication, or add/remove references by hand.
- **Visual Interpretation Preview** panel below cultural refs — the system's
  proposed scene concept, archetype application, selected frame, key visual
  elements, example i2i + t2i prompts, the supporting-text policy that
  applies to *this fact*, and any interpretation warnings. All editable.
- **Two distinct rerun buttons:** "Re-run classification" (regens taxonomy +
  cultural refs + preview) and "Regenerate preview" (regens only the preview,
  preserving your edits to taxonomy + cultural refs).
- **Hard approval gate:** Approve / Approve as Variant are **locked** until
  enrichment is valid AND a visual preview exists.
- **On-demand fact preview:** approved facts that lack a preview (e.g. ones
  bulk-imported and only enriched, not previewed) get a "Generate preview"
  action in the admin facts panel.
- **Supporting-text policy** (live in the preview panel):
  - **Forbidden:** full meme captions, full fact text, hashtags, watermarks,
    real logos, brand marks, long explanatory paragraphs.
  - **Allowed when they directly support the joke:** concise supporting text,
    numbers, symbols, equations, UI fragments, scoreboards, documents, keypad
    digits, short labels, signs.

---

# PART ONE — Submission flow (unchanged from a user's perspective)

## Section A — Submit a fact that depends on a cultural reference

Log in as any user, go to `/submit`. Submit:

> `Sharks have a David Week.`

Pass criterion: you land on the "You're Done!" confirmation, same as before.
No live AI hashtag suggester (that was removed in Phase 1; manual tags still
work).

Repeat with one or two more candidates if you'd like a spread to review:

- `David doesn't prepare for demos. Demos prepare for David. #Yardi` — a
  professional/domain reference (presales demos at Yardi).
- `David can set an ant on fire with a magnifying glass. At night.` — a
  mechanism-knowledge reference (sunlight focus, broken at night).
- `David's PIN is the last four digits of pi.` — logic/formal impossibility +
  digit-of-pi reference.
- `David's teachers raised their hands when they had questions.` — classroom
  authority reversal.

---

# PART TWO — Admin review with cultural refs + preview

Log in as **admin**, go to **/admin → Moderation → Fact Reviews** (Pending
tab). Click the Sharks-have-a-David-Week review to open the modal.

## Section B — Enrichment + cultural references panel

### B1. Taxonomy populated (same as Phase 1)

Below the submitted-fact text you should see the **Visual Taxonomy
Enrichment** panel pre-filled. Expected for this fact (the classifier may
pick a defensible adjacent archetype too — that's normal):

- Primary archetype: `authority_threat_reversal` (or
  `intrinsic_legendary_attribute` / `presence_induced_reaction_aura`).
- Subtype: `predator_danger_reversal` (under authority_threat_reversal) or
  another in-archetype subtype.
- Modifiers: at least `single_subject_focus`, `clear_causal_relationship`,
  plus a `no_readable_text` / `avoid_real_logos` / `audience_inside_reference`
  if the classifier flagged it.
- Confidence > 0.8 is typical.

### B2. **Cultural References** panel (new — Phase 2A)

Below the standard fields, a new **Cultural / Inside References** panel
should appear. For this fact, expect a card like:

- **Source phrase:** "David Week"
- **Reference type:** `cultural_reference`
- **Canonical reference:** "Shark Week" (Discovery Channel programming event)
- **Explanation:** "The joke reverses the familiar Shark Week programming
  concept — sharks are watching David as the spectacle, not the other way
  around."
- **Visual implication:** "Sharks gathered around a television/screen
  watching David with rapt attention; David appears on the screen as the
  legendary star."
- **Confidence:** ~0.9.
- **Requires admin review:** unchecked (it's a clean cultural ref, not a
  brand/professional one).

Try editing the **Visual implication** field with a small tweak. Add a new
reference manually with the "+ Add reference" button (then remove it). Pass
criterion: edits are reflected immediately; warnings update live (e.g. if you
check "Requires admin review", an amber warning appears).

### B3. **Visual Interpretation Preview** panel (new — Phase 2A)

Below cultural refs, a **Visual Interpretation Preview** panel. With
`OPENAI_API_KEY` set, the worker fills this within a few seconds of
submission; if you opened the review immediately, click **Regenerate preview**
to fill it.

Expected fields (the exact prose varies — judge the *gist*, not the words):

- **Archetype application:** a short paragraph explaining how the strategy
  for `authority_threat_reversal` applies *to this fact* (sharks-as-audience,
  reversed predator-prey viewing relationship).
- **Selected frame:** `default` (strategy-map content is stubbed pending your
  authoring; the model picks the only frame available).
- **Scene concept:** something like "Sharks gathered underwater around a
  glowing television, watching David as the star of a must-see broadcast."
- **Visual goal:** what the viewer should instantly understand (the reversal).
- **Visual approach:** how the scene is staged.
- **Key visual elements:** 3–8 concrete elements (e.g. "underwater viewing
  area", "glowing TV screen", "sharks facing the screen with rapt attention",
  "the named subject on-screen").
- **Engine-neutral visual plan:** a paragraph without engine-specific phrasing.
- **Example i2i prompt:** uses the **subject label** "David" (since the
  default sample name is David) or "the named subject" otherwise; explicitly
  says it preserves face; does not say it preserves physique.
- **Example t2i prompt:** the fallback prompt for text-to-image generation.
- **Prompt guardrails preview:** a one-paragraph summary stating both ALLOWED
  supporting-text categories (for this fact — likely a short on-screen TV
  label like "DAVID WEEK" in a generic broadcast-graphics font) and the
  FORBIDDEN ones (no real network logos, no full meme caption, no full fact
  text, no watermarks, no long paragraphs).
- **Supporting text policy:**
  - *Allowed* (in this case): "short labels", "broadcast-style on-screen
    text", "signs".
  - *Forbidden:* real logos, brand marks, watermarks, hashtags, full meme
    captions, full fact text, long explanatory paragraphs.
- **Cultural references used:** at least `David Week`.
- **Interpretation warnings:** empty (or small notes if the model is unsure).

### B4. **Warnings panel** — Phase 2A signals

Just below the dropdowns, the existing **Warnings** panel now also lights up
on:
- Any cultural ref with `requiresAdminReview` checked.
- Any cultural ref with confidence < 0.75.
- The example i2i / t2i prompts mentioning **forbidden** supporting-text
  categories (logos / watermarks / hashtags / full text / long paragraphs).
  Edit `exampleI2iPrompt` to include the word "watermark" and confirm the
  warning appears.
- A "generic" preview that doesn't actually echo the cultural reference. Edit
  the scene concept to remove any mention of Shark Week / David Week — the
  amber warning "Preview seems generic — none of the cultural references
  appear in the scene" should appear.

### B5. Save edits without approving

With everything dialed in to your liking, click **Save enrichment**. You
should see "Enrichment saved." Reopen the review (or refresh) — your edits
persist on the pending review.

### B6. Re-run classification vs Regenerate preview

The header now has **two** rerun affordances:

- **Re-run classification** (top-right of the editor): re-runs phase 1
  (taxonomy + cultural refs) and then phase 2 (preview). Status flips to
  `pending`; refresh in ~10–20s.
- **Regenerate preview** (top-right of the preview panel): re-runs **only**
  phase 2. Taxonomy + cultural refs (and your edits to them) are preserved.
  Useful after you edit a cultural-ref's `visualImplication` and want a new
  preview that reflects it.

Confirm both work and update the right things.

---

## Section C — The hard approval gate (Phase 2A)

### C1. Approve is locked without a preview

Open a freshly submitted review **before** the preview has been generated
(status = `pending`). The **Approve — New Fact** and **Approve as Variant**
buttons should be **disabled**, with a tooltip and a prominent amber notice:

> Approve is locked until enrichment is valid and a visual preview exists.

### C2. Hand-fill a preview to unlock Approve

Without waiting for the worker, manually fill in the preview panel: add a
scene concept, visual goal, etc. — at minimum the required fields. As soon
as everything's filled out and the validator is happy, the Approve buttons
should re-enable.

### C3. Approve and confirm the gate at the server

With the panel filled in correctly, click **Approve — New Fact**. The new
fact is created. Confirm in SQL:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, primary_archetype, subtype,
          enrichment->'culturalReferences' AS refs,
          enrichment->'visualPromptPreview'->>'sceneConcept' AS scene
   FROM facts ORDER BY id DESC LIMIT 1;"
```

Pass criteria:
- `primary_archetype`, `subtype` populated.
- `refs` is a jsonb array containing your cultural reference(s).
- `scene` matches what you saw in the preview panel.

### C4. Server gate is real (not just UI)

Try to bypass with curl while the preview is missing on a different review:

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" -d '{}' \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/approve
```

Pass criterion: `400` with body "A valid enrichment is required before
approval" or "A visual prompt preview is required before approval".

---

## Section D — On-demand preview for approved facts

This covers approved/backfilled facts that have enrichment but no preview.

### D1. Find a pre-existing approved fact

Go to **/admin → Facts Management**. Pick a fact with no preview yet (most
existing facts — the worker only fills preview for facts going through the
new approval flow). Open it.

### D2. Generate preview

In the actions panel on the right, find the new **Visual prompt preview**
section with a **Generate preview** button. Click it.

Pass criterion: green status "Visual preview queued — refresh in a moment to
see it on the fact."

After ~10–20s, refresh the fact. Verify in SQL:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, enrichment->'visualPromptPreview'->>'sceneConcept' AS scene
   FROM facts WHERE id = <factId>;"
```

`scene` should be populated.

### D3. Error path

Pick a fact that has NO enrichment yet (run `/admin/facts/backfill-enrichment`
first to ensure there's enrichment to work with). Then try the preview
button without enrichment present — pass criterion: red error "Cannot
generate preview: fact has no enrichment. Run backfill-enrichment first."

---

## Section E — Regression smoke (existing flows still work)

| #  | Area                              | Check                                                                              |
|----|-----------------------------------|------------------------------------------------------------------------------------|
| E1 | Email still gets sent             | Trigger an action that sends email (e.g. reject a review with notify enabled). A row appears in `async_jobs` with `queue='email'`. The worker delivers it (or fails gracefully with no Resend key). |
| E2 | Admin email queue page renders    | `/admin` → Email Queue (or wherever it's surfaced) shows recent rows with the new status vocabulary (pending / processing / done / failed). |
| E3 | Re-run classification is async    | Submitting a review never blocks the user; the row's `enrichment_status` flips to `pending` and the worker fills it. |
| E4 | OpenAI direct                     | Existing AI features (`/api/ai/check-duplicate`, `/api/ai/suggest-pronouns`, image scene-prompt, video motion direction) still work — they all flow through `callUtilityLLM()` → `getOpenAIClient()` which now uses the direct key. |
| E5 | Rollback by env                   | Unset `OPENAI_API_KEY`, set the `AI_INTEGRATIONS_OPENAI_*` proxy vars, restart. The same AI features still work via the proxy fallback. |
| E6 | No image/video change             | Approving a fact still kicks the existing image pipeline; nothing about meme/video output changed. |

---

# Bug report template

```
Section: <e.g. B3>
Fact text: <submitted fact>
Review id / Fact id: <id>
Viewer: <admin / user>

Enrichment panel state:
  enrichment_status: <pending / ok / failed>
  primaryArchetype / subtype: <values>
  cultural references: <list — sourcePhrase + referenceType>
  visualPromptPreview present: <yes / no>
  preview status (blob): <ok / pending / failed / absent>

Expected:
  <what the section says should happen>

Actual:
  <what happened>

Screenshots:
  <attach>

Network panel:
  <any 4xx/5xx requests>
```

---

# Notes / known limitations (expected, not bugs)

- **No visual change yet.** Phase 2A only adds stored metadata; the image-
  prompt generator that consumes it is Phase 2 (not in this PR).
- **Strategy-map content is stubbed.** Previews are intentionally thin until
  you author the per-archetype strategy text (TODO markers in
  `lib/promptStrategy/strategyMap.ts`). The wiring is in place — content is
  the next piece.
- **`requires_review` cultural references** require an admin sanity check
  before approval (warning surfaces in the panel).
- **OpenAI direct switch is shared infra.** It now affects every OpenAI call
  in the server (classification, scene prompt, motion direction, hashtag
  suggestion, duplicate check, pronoun suggestion). All proven through the
  same callUtilityLLM helper. Env-driven fallback to the proxy is preserved.
- **Backfill-enrichment is still in-process.** It's a sequential admin loop
  (no queue dedupe). Re-runnable. The follow-up unifies it with the queue.
- **Fal i2i/i2v polling** is **not** on the new async-jobs queue yet — the
  `external_id` column is reserved for that follow-up.
