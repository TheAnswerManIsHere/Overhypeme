# PR #229 — Speech & Thought Bubble Controls — UAT

You can now make a specific character in a meme **speak** or **think** an
exact line. It renders a comic-style balloon into the image with your text
lettered verbatim — a speech balloon with a tail pointing at the speaker, or
a thought cloud with a trail of little circles leading to the thinker's
head. It's a moderator control on the Visual Strategy Override, in a new
**Speech & Thought Bubbles** editor that sits right below the Visual
Concept card in a review's Step 2, and the same editor again inside
**Advanced Options → Visual Strategy Override** (both edit the same thing —
edits in one show in the other). It's **not** in the end-user wizard.

The AI Visual-ideas generator also **proposes** bubbles now — when a fact
contains a literal quote, an idea can come with the quote already set up as
a speech bubble. You still pick, edit, and Save; nothing renders until you
do.

## Setup

- [claude] Confirm a fact is available in concept review.
- [claude] Confirm a fact whose text contains a quote is available for the
  AI-proposal check — or note one that can be temporarily edited to include
  a quote, e.g. "When David left for college, he told his dad, 'You're the
  man of the house now.'"

## Steps

_Step 1 retired as written (David, 2026-11-18, Q2): it was written against the Advanced Options editor and the old compiler, which PR #1022 replaced with the gag card. The behaviour itself was rebuilt, not removed, and CI still checks it: `artifacts/api-server/src/__tests__/imagePromptPreview.test.ts:returns one speech directive quoting the exact text, tail pointing to the preview name`. The bubble later steps use: a Speech bubble spoken by the subject, text `You're the man of the house now.`._

### 2. The speech bubble renders correctly at 2K

**Do:** Save the bubble from step 1, then run a 2K test render.

**Expect:** a speech balloon appears lettered with exactly `You're the man
of the house now.`, and that text does not also appear outside a balloon as
a caption across the image. Which speaker the balloon belongs to is step
16's, yours.

**Lane:** capture

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; lettering and tail placement are a judgement on a real render

_Step 3 retired as written (David, 2026-11-18, Q2): it relied on a Scene Role Assignment, replaced by the gag's cast in PR #1022. The behaviour itself was rebuilt, not removed, and CI still checks it: `artifacts/api-server/src/__tests__/imagePromptPreview.test.ts:returns a cloud-shaped thought balloon whose trail leads to the head of the bartender, bound by the gag's cast`. The bubble later steps use: a Thought bubble for `the bartender`, text `Not again.`, with the bartender named in the scene._

### 4. The thought bubble renders on the right character

**Do:** Render at 2K.

**Expect:** a thought cloud appears carrying the bubble's text exactly.
Which character it belongs to is step 17's, yours.

**Lane:** capture

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; attribution is a judgement on a real render

### 5. Two mixed bubbles keep correct attribution across repeats

**Do:** Keep both bubbles from steps 1–4 (subject speech + bartender
thought) and render 2–3 times at 2K.

**Expect:** on every attempt each balloon appears carrying its own text
exactly. Which character each one attaches to is step 18's, yours.

**Lane:** capture

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; attribution across repeats is a judgement on real renders

_Step 6 retired: it expected a bubble for a speaker absent from the scene to save and render, and the gag card now refuses that speaker (`SPEAKER_NOT_IN_SCENE`, `artifacts/api-server/src/lib/gags/gagStore.ts`) (David, 2026-11-18, Q2: retired as not applicable — the behaviour it tested was removed)._

### 7. Bubble text over 60 characters shows a soft warning

**Do:** Type bubble text past 60 characters.

**Expect:** the counter turns amber with "shorter renders more reliably".

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/BubbleEditor.test.tsx:soft-warns at 60+ chars of text`; `artifacts/overhype-me/src/components/admin/BubbleEditor.test.tsx:turns the character counter amber (text-amber-600) at 60+ chars, and keeps it muted below`

### 8. Bubble text is hard-capped at 80 characters

**Do:** Try to type bubble text past 80 characters.

**Expect:** you can't type past 80 — it's a hard cap.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/visualStrategyOverride.test.ts:rejects over-cap text (81) and entity (61)`; `artifacts/overhype-me/src/components/admin/BubbleEditor.test.tsx:the bubble text input refuses characters past 80 (maxLength is the literal 80)`

### 9. A 5th bubble is blocked

**Do:** Try to add a 5th bubble.

**Expect:** Add is disabled with a "Maximum 4" hint.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/BubbleEditor.test.tsx:caps at MAX_BUBBLES rows (Add disabled with a hint)`; `artifacts/overhype-me/src/components/admin/BubbleEditor.test.tsx:with four bubbles Add is disabled and the hint reads "Maximum 4 bubbles" (literal 4, not MAX_BUBBLES); three still allow Add`

### 10. A `{NAME}` token in bubble text renders your name

**Do:** Set bubble text to `{NAME} did it again!` with a preview name set,
and check the preview and render.

**Expect:** the token is replaced with the name inside the quotes (e.g.
`"David did it again!"`) — no raw `{NAME}` reaches the image.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:token-bearing bubble text renders the subject name BEFORE serialization`; `artifacts/api-server/src/__tests__/imagePromptPreview.test.ts:renders a {NAME} token in the stored bubble with the previewName and leaves no raw token`; `artifacts/api-server/src/__tests__/imagePromptJobs.test.ts:compiles a {NAME} bubble with the attempt's identity into the rendered name, no raw token`

### 11. The AI proposes a bubble from a quote-bearing fact

**Do:** On a quote-bearing fact, click Generate visual ideas (or
Regenerate).

**Expect:** at least one idea card shows a proposed bubble under the
title — a speech row like `Speech — subject: "You're the man of the house
now."`

**Lane:** live

**Check:** `artifacts/overhype-me/src/components/admin/VisualConceptCandidates.test.tsx:renders the normalized proposed bubbles on the card (exactly what pick applies)`

**Deferred:** #628 — Phase 8 (Engine evaluation) — the model proposing a speech bubble from a quote-bearing fact; whether the model proposes one is model behaviour that phase tunes (David, 2026-10-17)

_Step 12 retired with the proposed-idea "Use as draft" flow, replaced by the gag card in the three-gags rebuild (PR #956) (David, 2026-11-18, Q2: retired as not applicable — the behaviour it tested was removed)._

### 13. The picked bubble renders correctly

**Do:** Save and render at 2K.

**Expect:** a balloon appears carrying the quote's text exactly. Whether it
sits on the subject is step 19's, yours.

**Lane:** capture

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; the balloon on a real render is a judgement

### 14. A fact with no dialogue gets ideas with no bubbles

**Do:** Generate visual ideas for a plain fact with no dialogue.

**Expect:** ideas come back with no bubbles — the AI shouldn't invent
speech where the fact has none.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 3: the baseline fact has no dialogue, and no Visual Ideas candidate proposes a bubble

_Step 15 retired with the idea-card pick gate, replaced by the gag card in the three-gags rebuild (PR #956) (David, 2026-11-18, Q2: retired as not applicable — the behaviour it tested was removed)._

### 16. The step 2 balloon belongs to the subject

**Do:** Look at step 2's render (`/uat` shows it with its evidence link).

**Expect:** the balloon's tail points at the subject, and there is no second or duplicate speaker.

**Lane:** human

**Judgement:** which character a generated speech balloon belongs to is a judgement about AI-generated content, which is yours alone (David, 2026-10-17); step 2 proves only what the picture verifiably carries.

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; the real render this reads is made there

### 17. The step 4 thought cloud belongs to the bartender

**Do:** Look at step 4's render (`/uat` shows it with its evidence link).

**Expect:** the thought cloud attributes to the bartender, not the subject.

**Lane:** human

**Judgement:** which character a generated thought cloud belongs to is a judgement about AI-generated content, which is yours alone (David, 2026-10-17); step 4 proves only what the picture verifiably carries.

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; the real render this reads is made there

### 18. The step 5 balloons keep their characters across repeats

**Do:** Look at step 5's renders (`/uat` shows them with their evidence links).

**Expect:** each balloon attaches to the right character on every attempt. This is the highest-risk case — note any attempt where attribution slips.

**Lane:** human

**Judgement:** which character each generated balloon attaches to is a judgement about AI-generated content, which is yours alone (David, 2026-10-17); step 5 proves only what the picture verifiably carries.

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; the real renders this reads are made there

### 19. The step 13 balloon sits on the subject

**Do:** Look at step 13's render (`/uat` shows it with its evidence link).

**Expect:** the balloon sits on the subject.

**Lane:** human

**Judgement:** where a generated balloon sits is a judgement about AI-generated content, which is yours alone (David, 2026-10-17); step 13 proves only what the picture verifiably carries.

**Deferred:** #628 — Phase 7 (image offering) — speech bubbles are finished in that phase; the real render this reads is made there

## Regression

### R1. A fact with no bubbles renders exactly as before

**Do:** Render a fact that has no bubbles configured.

**Expect:** it renders exactly as before, with no bubble section in the
prompt.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/nanoBanana2Compiler.test.ts:zero bubbles → no section, no carveout, no bubble diagnostics`

_R2 retired with the proposed-idea "Use as draft" flow, as step 12 is (PR #956) (David, 2026-11-18, Q2: retired as not applicable — the behaviour it tested was removed)._

### R4. Editing the Concept or a bubble marks ideas stale, non-blocking

**Do:** Edit and save either the Visual Concept or a bubble, then check the
generated ideas list.

**Expect:** the ideas are marked stale, but the saved concept still drives
renders — this is non-blocking, as before.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/admin/VisualConceptCandidates.test.tsx:ok + stale (current:false) → hides candidates, shows the stale reason` `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:stale-but-saved concept still advances (visualConcepts.current false is allowed)`; `artifacts/api-server/src/__tests__/visualConceptJobs.test.ts:editing and saving the Concept makes the stored ideas stale (input_hash_mismatch) with the archetype untouched`; `artifacts/api-server/src/__tests__/routes.approveVisualConcept.test.ts:approves with 200 production_review after a Concept or bubble save leaves the stored ideas stale (GET reads current false)`

## Not bugs

- **In-image text is stochastic.** Even with the exact-text directive, the
  engine occasionally mis-letters or mis-attributes — that's why this UAT
  uses 2K and repeated renders. One good render isn't a guarantee; one bad
  one isn't a regression. Report a pattern, not a single miss.
- **Photorealistic scenes** get a clean graphic balloon overlaid on the
  photo — that's the intended meme look, not a bug.
