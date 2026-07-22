# PR229 — Speech &amp; Thought Bubble Controls — UAT

In-app, click-through acceptance test (David). Written for the end user: where to
click, what to expect vs. not expect. The engineering checklist is
[`PR229_BUBBLE_CONTROLS_TEST_RUN.md`](./PR229_BUBBLE_CONTROLS_TEST_RUN.md)
(transient — delete after Replit runs it).

## What this feature does

You can now make a specific character in a meme **speak** or **think** an exact
line. It renders a comic-style balloon into the image with your text lettered
verbatim — a speech balloon (with a tail pointing at the speaker) or a thought
cloud (with a trail of little circles to the thinker's head). It's a moderator
control on the Visual Strategy Override; it is **not** in the end-user wizard.

The AI Visual-ideas generator also **proposes** bubbles now — when a fact
contains a literal quote, an idea can come with the quote already set up as a
speech bubble. You still pick, edit, and Save; nothing renders until you do.

## Where to find it

In a review's **Step 2 (Visual Concept)**:

1. A new **Speech &amp; Thought Bubbles** editor sits right below the Visual
   Concept card (first-class placement).
2. The **same** editor also appears inside **Advanced Options → Visual Strategy
   Override**. Both edit the same thing — edits in one show in the other.

## Setup for the render checks

None special. Use any fact in concept review. For the AI-proposal check, pick a
fact whose text contains a quote (or temporarily edit one to include one, e.g.
*"When David left for college, he told his dad, 'You're the man of the house
now.'"*).

## Test 1 — Author a speech bubble (happy path)

1. In the Speech &amp; Thought Bubbles editor, click **Add bubble**.
2. Leave type **Speech**, entity **subject**, and type the text:
   `You're the man of the house now.`
3. Open **Runtime Compiled Prompt** (Advanced Options / preview). **Expect** a
   `SPEECH & THOUGHT BUBBLES:` section containing one directive with your exact
   text in quotes and a tail "pointing to" the subject's name.
4. Save, then run a **2K** test render.
   - **Expect:** a clean speech balloon whose tail points at the subject,
     lettered with exactly `You're the man of the house now.`
   - **Not expect:** the text baked in as a caption across the image, or a
     second/duplicate speaker.

Record: the exact requested string, the exact string you see rendered, whether
the tail points at the right character, resolution (2K), render mode, style,
and how many attempts it took.

## Test 2 — A thought bubble on a secondary character

1. Add a second bubble: type **Thought**, entity a role label (e.g.
   `the bartender`), text `Not again.`
2. Make sure the scene actually has that character (mention "a bartender" in the
   Visual Concept, or add a Scene Role Assignment for them).
3. **Expect** (preview): a second directive — a cloud-shaped thought balloon
   with a trail "leading to the head of the bartender", text `Not again.`
4. Render at 2K. **Expect** the thought cloud attributes to the bartender, not
   the subject.

## Test 3 — Two bubbles at once, mixed types (attribution stress)

1. Keep both bubbles from Tests 1 &amp; 2 (subject speech + bartender thought).
2. Render **2–3 times** at 2K.
   - **Expect:** each balloon carries the right text and attaches to the right
     character across attempts. Note any attempt where attribution slips — this
     is the highest-risk case and the evidence we care about most.

## Test 4 — The unmatched-entity nudge (not a blocker)

1. Add a bubble whose entity is a character **not** in the scene (e.g.
   `the mailman` when no mailman is described).
2. **Expect:** a soft amber warning in the editor ("doesn't match subject or any
   Scene Role Assignment…") and, in the preview, an unresolved-entity note. The
   bubble **still** compiles — the warning is a typo-catcher, not a gate. The
   model may add, ignore, or misattribute that character; confirm the render.

## Test 5 — Length limit &amp; the soft warning

1. Type past 60 characters. **Expect:** the counter turns amber with "shorter
   renders more reliably".
2. Type up to 80. **Expect:** you can't type past 80 (hard cap).
3. Try to add a 5th bubble. **Expect:** Add is disabled with a "Maximum 4" hint.

## Test 6 — Token text renders your name

1. Bubble text: `{NAME} did it again!` with a preview name set.
2. **Expect** (preview + render): the token is replaced with the name inside the
   quotes (e.g. `"David did it again!"`) — no raw `{NAME}` reaches the image.

## Test 7 — AI proposes a bubble from a quote

1. On a quote-bearing fact, click **Generate visual ideas** (or Regenerate).
2. **Expect:** at least one idea card shows a proposed bubble under the title —
   a speech row like `Speech — subject: "You're the man of the house now."`
3. Click **Use as draft** on that card.
   - **Expect:** the Visual Concept field fills **and** the bubble appears in
     the Speech &amp; Thought Bubbles editor — the same rows the card showed.
4. Save and render at 2K. **Expect** the quote renders in a balloon on the
   subject.
5. Also generate ideas for a plain fact with **no** dialogue.
   - **Expect:** ideas come back with **no** bubbles (the normal case) — the AI
     shouldn't invent speech where the fact has none.

## Test 8 — Picking is blocked while you have unsaved Advanced edits

1. Make an edit to some **other** Visual Strategy field (e.g. add a Required
   Visual Detail) but don't Save.
2. Try **Use as draft** on an idea.
   - **Expect:** the button is disabled with copy asking you to save or discard
     your current Visual Strategy changes first. (Editing the Concept text or
     bubbles themselves does **not** block picking — only unrelated fields do.)

## Regression smoke (should be unchanged)

| Area | Expect |
| --- | --- |
| A fact with **no** bubbles | Renders exactly as before; no bubble section in the prompt. |
| Visual Concept field | Still works; picking an idea still fills it. |
| Advanced Options save | Still saves; role bindings / required details unchanged. |
| Ideas staleness | Editing &amp; saving the Concept **or** a bubble marks the ideas stale (the saved concept still drives renders — non-blocking, as before). |

## Known non-bugs / limitations

- **In-image text is stochastic.** Even with the exact-text directive, the
  engine occasionally mis-letters or mis-attributes — that's why the UAT uses 2K
  and repeated renders. One good render isn't a guarantee; one bad one isn't a
  regression. Report a **pattern**, not a single miss.
- **Photorealistic scenes** get a clean graphic balloon overlaid on the photo —
  that's the intended meme look, not a bug.
- An unmatched entity's bubble still renders (Test 4) — by design.
- A `*_TEST_RUN.md` file missing from `main` later is expected (David deletes it
  after Replit runs it); this UAT is the durable half.

## Bug report template

```
Test #:
Fact / scene:
Bubble(s) configured (type — entity: "text"):
Requested string(s):
Observed string(s):
Attribution correct? (which balloon → which character):
Resolution / render mode / style:
Attempts:
Screenshot:
```
