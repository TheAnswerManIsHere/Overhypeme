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

### 1. A speech bubble appears correctly in the compiled prompt

**Do:** In the Speech & Thought Bubbles editor, click Add bubble, leave
type Speech and entity subject, type `You're the man of the house now.`,
then open Runtime Compiled Prompt (Advanced Options / preview).

**Expect:** a `SPEECH & THOUGHT BUBBLES:` section containing one directive
with your exact text in quotes and a tail "pointing to" the subject's name.

### 2. The speech bubble renders correctly at 2K

**Do:** Save the bubble from step 1, then run a 2K test render.

**Expect:** a clean speech balloon whose tail points at the subject,
lettered with exactly `You're the man of the house now.` — not the text
baked in as a caption across the image, and not a second/duplicate
speaker.

### 3. A thought bubble attaches to a secondary character in the prompt

**Do:** Add a second bubble: type Thought, entity a role label (e.g. `the
bartender`), text `Not again.`; make sure the scene actually includes that
character (mention "a bartender" in the Visual Concept, or add a Scene
Role Assignment for them); then open the preview.

**Expect:** a second directive — a cloud-shaped thought balloon with a
trail "leading to the head of the bartender", text `Not again.`

### 4. The thought bubble renders on the right character

**Do:** Render at 2K.

**Expect:** the thought cloud attributes to the bartender, not the
subject.

### 5. Two mixed bubbles keep correct attribution across repeats

**Do:** Keep both bubbles from steps 1–4 (subject speech + bartender
thought) and render 2–3 times at 2K.

**Expect:** each balloon carries the right text and attaches to the right
character across attempts. This is the highest-risk case — note any
attempt where attribution slips.

### 6. An unmatched entity gets a soft warning, not a block

**Do:** Add a bubble whose entity is a character not in the scene (e.g.
`the mailman` when no mailman is described).

**Expect:** a soft amber warning in the editor ("doesn't match subject or
any Scene Role Assignment…") and, in the preview, an unresolved-entity
note. The bubble still compiles — the warning doesn't block saving. The
model may add, ignore, or misattribute that character; confirm on the
render.

### 7. Bubble text over 60 characters shows a soft warning

**Do:** Type bubble text past 60 characters.

**Expect:** the counter turns amber with "shorter renders more reliably".

### 8. Bubble text is hard-capped at 80 characters

**Do:** Try to type bubble text past 80 characters.

**Expect:** you can't type past 80 — it's a hard cap.

### 9. A 5th bubble is blocked

**Do:** Try to add a 5th bubble.

**Expect:** Add is disabled with a "Maximum 4" hint.

### 10. A `{NAME}` token in bubble text renders your name

**Do:** Set bubble text to `{NAME} did it again!` with a preview name set,
and check the preview and render.

**Expect:** the token is replaced with the name inside the quotes (e.g.
`"David did it again!"`) — no raw `{NAME}` reaches the image.

### 11. The AI proposes a bubble from a quote-bearing fact

**Do:** On a quote-bearing fact, click Generate visual ideas (or
Regenerate).

**Expect:** at least one idea card shows a proposed bubble under the
title — a speech row like `Speech — subject: "You're the man of the house
now."`

### 12. Using a proposed idea fills both the Concept and the bubble editor

**Do:** Click Use as draft on the idea card from step 11.

**Expect:** the Visual Concept field fills and the bubble appears in the
Speech & Thought Bubbles editor — the same rows the card showed.

### 13. The picked bubble renders correctly

**Do:** Save and render at 2K.

**Expect:** the quote renders in a balloon on the subject.

### 14. A fact with no dialogue gets ideas with no bubbles

**Do:** Generate visual ideas for a plain fact with no dialogue.

**Expect:** ideas come back with no bubbles — the AI shouldn't invent
speech where the fact has none.

### 15. Picking an idea is blocked while other Advanced edits are unsaved

**Do:** Make an edit to some other Visual Strategy field (e.g. add a
Required Visual Detail) without saving, then try Use as draft on an idea.

**Expect:** the button is disabled with copy asking you to save or discard
your current Visual Strategy changes first. (Editing the Concept text or
bubbles themselves does not block picking — only unrelated fields do.)

## Regression

### R1. A fact with no bubbles renders exactly as before

**Do:** Render a fact that has no bubbles configured.

**Expect:** it renders exactly as before, with no bubble section in the
prompt.

### R2. The Visual Concept field still works on its own

**Do:** Pick an idea for a fact and check the Visual Concept field.

**Expect:** it still works; picking an idea still fills it.

### R3. Advanced Options still saves unrelated fields

**Do:** Save an edit to a role binding or required detail in Advanced
Options.

**Expect:** it still saves; role bindings / required details are
unchanged.

### R4. Editing the Concept or a bubble marks ideas stale, non-blocking

**Do:** Edit and save either the Visual Concept or a bubble, then check the
generated ideas list.

**Expect:** the ideas are marked stale, but the saved concept still drives
renders — this is non-blocking, as before.

## Not bugs

- **In-image text is stochastic.** Even with the exact-text directive, the
  engine occasionally mis-letters or mis-attributes — that's why this UAT
  uses 2K and repeated renders. One good render isn't a guarantee; one bad
  one isn't a regression. Report a pattern, not a single miss.
- **Photorealistic scenes** get a clean graphic balloon overlaid on the
  photo — that's the intended meme look, not a bug.
- An unmatched entity's bubble still renders (step 6) — by design.
