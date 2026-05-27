# Fact Visual-Taxonomy Enrichment — User acceptance testing (in-app)

You're the end user here. This UAT validates the new **fact enrichment**
layer from PR #75. The idea: when a fact is submitted, the app asks
OpenAI "what *kind* of impossible joke is this?" and stores a structured
answer (archetype, subtype, modifiers, how literal/complex it is to draw,
whether it fits Overhype, whether it's adult-compatible, hashtags, a
confidence score). You — as admin — review and edit that before
approving. The stored taxonomy is the foundation the future image/video
prompt generator will use.

**This phase does NOT change how any image or video looks.** Nothing in
the meme/video output changes yet. You're verifying that the
classification gets produced, that you can correct it, and that it's
saved on the approved fact.

The automated test side is in
[`FACT_ENRICHMENT_TEST_RUN.md`](./FACT_ENRICHMENT_TEST_RUN.md) and is
owned by Replit AI; that runs in parallel and you don't need to read it.

If anything fails, write down which section + step, what you saw vs. what
you expected, and a screenshot if it's visual. Bug-report template at the
bottom.

---

## Setup

1. Pull the latest from PR #75's branch
   (`claude/visual-taxonomy-prompt-arch-cb8up`).
2. Boot the dev app. The session-start hook brings up the test DB and one
   migration applies (`0062` — enrichment columns) with no manual SQL.
3. You need:
   - An **admin** login (the review screen is admin-gated).
   - Any **logged-in** user to submit a fact.
4. **Important — OpenAI must be provisioned** for the AI to actually
   classify facts: `AI_INTEGRATIONS_OPENAI_API_KEY` +
   `AI_INTEGRATIONS_OPENAI_BASE_URL`. If those aren't set, every
   submission's enrichment will come back **"failed"** and you'll only be
   able to test the *manual-fill* path (Section E). That's expected — not
   a bug — but you won't see real classifications without the key.
5. Cost: a fraction of a cent of OpenAI usage per submitted fact (one
   small `gpt-4o-mini` call, occasionally two if it has to self-correct).

**What's new / what to look for:**

- The `/submit` flow **no longer suggests hashtags live** while you type.
  You can still add your own comma-separated tags manually. AI hashtag
  suggestions now live in the admin review screen as part of enrichment.
- The admin Fact Reviews screen now shows a **Visual Taxonomy
  Enrichment** panel for each pending review, pre-filled by the AI and
  fully editable before you approve.
- Approving writes the (edited) taxonomy onto the new fact, and the
  enrichment's hashtags are what get attached.
- A **Backfill enrichment** button under Facts Management classifies
  facts that don't have enrichment yet.

---

# PART ONE — Submission flow (the user's side)

## Section A — Submitting a fact

Log in as any user, go to **/submit**.

### A1. No live AI hashtag suggestions

Write a fact and walk to the final "submit" step where hashtags live.

You should see:
- A **Hashtags** field with helper text like "Add tags to help people
  find your fact — comma-separated, optional," and a placeholder
  (e.g. *strength, legendary, coffee*).
- You can type your own tags and submit them.

You should **NOT** see:
- ❌ A "Generating suggestions…" spinner.
- ❌ A row of suggested-hashtag pills that toggle on/off.
- ❌ The field auto-filling itself with AI tags.

If you see any of those, the old live suggester wasn't fully removed —
**flag it**.

### A2. Submit succeeds

Submit a clearly-classifiable fact, e.g.:

> `When {SUBJ} does pushups, {SUBJ} pushes the Earth down.`

Pass criterion: you land on the "You're Done!" / in-queue confirmation,
same as before. Submission must **never** be blocked or slowed waiting on
the AI classification — it happens in the background.

### A3. (Optional) Submit a few varied facts

To give yourself interesting review material later, submit a spread, e.g.:

- `When {SUBJ} was born, {SUBJ} drove {POSS} mom home from the hospital.`
- `{SUBJ} can slam a revolving door.`
- `{SUBJ}'s PIN is the last four digits of pi.`
- `{SUBJ} doesn't prepare for demos. Demos prepare for {OBJ}. #Yardi`

---

# PART TWO — Admin review with enrichment

Log in as **admin**, go to **/admin → Moderation → Fact Reviews**
(Pending tab). Click a pending review to open the modal.

## Section B — The enrichment panel

### B1. The panel is there and pre-filled

Below the submitted-fact text you should see a **Visual Taxonomy
Enrichment** panel. With OpenAI configured, within a few seconds of
submission it should be populated:

- **Primary archetype** dropdown (e.g. `superhuman_physical_feat` for the
  pushups fact).
- **Subtype** dropdown (e.g. `force_scaled_action`).
- **Visual literalness**, **Visual complexity**, **Overhype fit**,
  **Adult suitability** dropdowns.
- **Adult suitability notes** textarea.
- **Modifiers** chips (e.g. `clear_causal_relationship`,
  `single_subject_focus`) with an "Add modifier…" box.
- **Suggested hashtags (3–8)** chips with an "Add hashtag…" box.
- **Taxonomy confidence** (read-only, e.g. `0.95`).
- **Admin review notes** textarea.
- A **status** indicator (`ok`), a **Re-run AI** link, and a **Save
  enrichment** button.

Sanity-check the classification against the fact — does the archetype
make sense for the joke? (Spot-check ideas: the pushups fact →
`superhuman_physical_feat`; the baby-drives-mom fact →
`authority_threat_reversal` / `social_role_reversal` and
`adultSuitability = incompatible`; the PIN-of-pi fact →
`logic_formal_impossibility`; the #Yardi demos fact →
`mundane_act_made_legendary` with brand/workplace modifiers and
`adultSuitability = incompatible`.)

> This is the heart of the feature — you're judging whether the AI
> classifies the *joke mechanism* well. Misclassifications you can fix by
> hand (B2); systematic ones are worth reporting so we can tune the prompt.

### B2. Editing works

- Change the **Primary archetype**. The **Subtype** dropdown should
  immediately re-scope to that archetype's subtypes (and the selected
  subtype resets to a valid one — you should never be able to leave an
  archetype/subtype mismatch).
- Add a modifier via the box. Type a known one (autocomplete suggests
  from the catalog) and a made-up custom one. Custom modifiers should be
  accepted but shown in an **amber** chip (known ones are blue/primary).
- Remove a chip with its ✕.
- Add/remove hashtags. Try typing `#Strength` or `Push Ups` — it should
  normalize to `strength` / `pushups`.
- Edit the notes fields.

### B3. Warnings show up

The panel should surface amber warning lines when relevant:

- Confidence < 0.75 → "Low confidence — review classification".
- Overhype fit = `questionable` → "Check Overhype fit"; `reject` →
  "Likely reject or rewrite".
- Adult suitability = `requires_review` → "Review adult eligibility".
- Visual complexity = `high` → "Hard to visualize".
- A custom (non-catalog) modifier → "New modifier(s): …".

Force one: set Overhype fit to `reject` and confirm the warning appears.

### B4. Invalid state is blocked

Remove hashtags until fewer than 3 remain. You should see a red
validation message (e.g. "suggestedHashtags: …min 3…") and the **Save
enrichment** button should be disabled. Add them back to clear it.

### B5. Save enrichment

With a valid panel, click **Save enrichment**. You should see a "Enrichment
saved." confirmation. (This persists your edits to the pending review
without approving it — so you can come back later.)

### B6. Re-run AI

Click **Re-run AI**. The status should flip to `pending` with a message
like "Re-running enrichment — refresh in a moment." Close and re-open the
review (or refresh) — with OpenAI configured it should be `ok` again with
a fresh classification.

---

## Section C — Approve and confirm it sticks

### C1. Approve as a new fact

With the enrichment dialed in, click **Approve — New Fact**.

Pass criteria:
- The review moves to Approved.
- Open the approved fact (the "View Approved Fact" link). Its hashtags
  should match the **enrichment's** hashtags (the curated set), including
  any you edited in.

Confirm the metadata persisted (admin, SQL):

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, primary_archetype, subtype, overhype_fit, adult_suitability,
          enrichment IS NOT NULL AS has_blob
   FROM facts ORDER BY id DESC LIMIT 1;"
```

Pass criterion: the four columns are populated to match what you approved,
and `has_blob = t`.

### C2. Approved/decided reviews show a read-only summary

Re-open the review you just approved (or use the Approved tab). Instead of
the editor, you should see a compact **read-only** enrichment summary
(archetype, subtype, literalness, complexity, fit, adult, confidence,
modifiers, hashtags). No edit controls.

---

## Section D — Variant approval keeps its own enrichment

### D1. Approve a different review as a variant

Open another pending review, edit its enrichment to be **clearly
different** from an existing fact (different archetype/subtype), then use
**Approve as Variant…**, entering an existing fact's id as the parent.

Pass criteria:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, parent_id, primary_archetype, subtype
   FROM facts ORDER BY id DESC LIMIT 2;"
```

- The variant row has `parent_id` = the parent you chose.
- Its `primary_archetype` / `subtype` reflect the **variant's own**
  enrichment — not copied from the parent. Each fact carries its own
  taxonomy.

---

## Section E — Failure / manual-fill path

This is the path you'll be on if OpenAI **isn't** configured, and it's
also what an admin sees if a classification fails.

### E1. A failed enrichment is clearly flagged

Find (or create) a review whose enrichment failed. The panel should show:
- status **`failed`**, and
- a banner like "No AI enrichment available. Re-run it, or fill the fields
  below manually before approving."

The editor fields are still present (scaffolded with defaults) so you can
fill them in by hand.

### E2. Manual fill + approve

Fill in a sensible archetype/subtype, add **at least 3** hashtags, set the
other dropdowns, and approve. It should approve cleanly and the fact
should carry the metadata you entered (verify as in C1).

### E3. Submission was never blocked

Confirm that even with enrichment failing, the original `/submit` flow
(Section A2) still completed normally — the user is never blocked or shown
an error because the AI classification failed.

---

## Section F — Backfill existing facts

### F1. Run the backfill

Go to **/admin → Facts Management**. In the **Bulk Import** panel, find
the **Visual Taxonomy** section and click **Backfill enrichment**.

Pass criterion: you get a confirmation like "Enriching N facts
sequentially in the background." (It returns immediately; the work runs in
the background and respects rate limits.)

### F2. Confirm facts gain enrichment

With OpenAI configured, after a bit:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT count(*) FILTER (WHERE enrichment IS NOT NULL) AS enriched,
          count(*) AS total
   FROM facts WHERE is_active = true;"
```

Pass criterion: `enriched` climbs over time toward `total`. (Facts that
fail individually are skipped and logged; the batch doesn't abort.)

---

## Section G — Regression smoke (existing flows still work)

| #  | Area                          | Check                                                                 |
|----|-------------------------------|-----------------------------------------------------------------------|
| G1 | Fact submission               | Submitting a fact still works end-to-end and lands in Pending.        |
| G2 | Reject still works            | Rejecting a review (with a reason) still notifies the submitter.      |
| G3 | Approve without editing       | Approving a review you didn't touch still works (uses stored or null enrichment) and attaches hashtags. |
| G4 | Manual hashtags survive       | Tags you typed at /submit still appear for the admin and can be approved. |
| G5 | No image/video change         | Approving a fact still kicks the existing image pipeline; nothing about meme/video output changed. |

---

# Bug report template

```
Section: <e.g. B2>
Fact text: <the submitted fact>
Review id: <id>
Viewer: <admin / user>

Enrichment panel state:
  status: <ok / pending / failed>
  primaryArchetype / subtype: <values>
  overhypeFit / adultSuitability / visualComplexity: <values>
  modifiers: <list>
  hashtags: <list>
  confidence: <number>

Expected:
  <what the section says should happen>

Actual:
  <what happened>

Screenshots:
  <attach>

Network panel:
  <any 4xx/5xx requests, e.g. on approve / PATCH …/enrichment / …/enrich>
```

---

# Notes / known limitations (expected, not bugs)

- **No visual change yet.** This stores taxonomy metadata only; the
  image/video prompt generator that uses it is the next phase.
- **AI classification quality is the thing under test.** The AI will
  occasionally pick a defensible-but-not-ideal archetype. That's why you
  can edit everything before approving. Systematic misclassifications are
  worth reporting so we can tune the system prompt (it's admin-editable in
  `/admin` config under the `fact_enrichment_*` keys).
- **Without OpenAI keys, all enrichment shows "failed"** and you're on the
  manual path (Section E) — by design.
- **Backfill is manual and sequential** (rate-limit friendly); it won't
  finish instantly for a large fact table.
