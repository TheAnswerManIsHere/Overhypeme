# Moderator override token UX — user acceptance testing

Paired with **`docs/PR124_VISUAL_STRATEGY_OVERRIDE_TOKENS_TEST_RUN.md`** (the
automated checklist). This is the click-through test for David.

## What you're verifying

The moderator **Visual Strategy Override** panel already lets you art-direct an
image with personalization tokens (`{NAME}`, pronouns) that get filled in
per-viewer at render time — so you never type a real name. This polish pass adds
three things:

1. **Token chips** — a clickable legend at the top of the panel. Click into a
   field, click a chip, and the token drops in **at your cursor** (no typing the
   braces by hand).
2. **`{NAME_POSSESSIVE}`** — a possessive-name token. It always renders the
   subject's name + `'s` (David → **David's**, Chris → **Chris's**, James →
   **James's**).
3. **Rendered fact text** — the Runtime Prompt Preview now shows the fact
   sentence with its tokens filled in for your sample subject.

**Nothing to switch on** — it's live by default. No new screen; everything is in
the existing enrichment editor + prompt preview.

## Where to look

Admin **Facts** page → open an enriched fact → the **Visual Strategy Override**
panel (toggle it **on** if it isn't). The **Runtime Prompt Preview** panel is on
the same page (and on the **Moderation** page per review).

## 1. Chips insert at the cursor

1. In the override panel, find the **Insert token:** row of chips.
2. Click into **Required Visual Details** (add a row if needed), type
   `recognizable face on a newborn body`, put your cursor at the **start**.
3. Click the **`{NAME_POSSESSIVE}`** chip, then type a space.
   - **Expect:** the field now reads `{NAME_POSSESSIVE} recognizable face on a
     newborn body`, with your cursor right after the inserted token.
4. **Selected-range replacement:** type `TOKEN_HERE` into a field, select it
   (double-click / drag), click **`{NAME}`**.
   - **Expect:** `TOKEN_HERE` is replaced by `{NAME}` — the chip swaps the
     selection, it doesn't just append.
5. Click a chip with **no field focused** (e.g. right after opening the panel).
   - **Expect:** a small note like *"Copied {NAME} — click into a token-capable
     field to paste it."* It never errors and never silently does nothing.

## 2. Admin-only field is not a chip target

1. Click into **Moderator Intent (admin-only, not rendered)** and type a note.
2. Click any chip.
   - **Expect:** the token does **not** land in Moderator Intent (it's not a
     render target). You'll get the copy/note fallback instead. This is
     intentional — Moderator Intent never reaches the image model.

## 3. `{NAME_POSSESSIVE}` renders in the prompt (and always uses 's)

The rendered **fact text** block and the **compiled prompt** verify **different**
things — don't conflate them:

- **Rendered fact text** = the fact *sentence* with its own tokens filled in.
- **Compiled prompt** = where your **override-field** tokens show up.

Steps:

1. Author `{NAME_POSSESSIVE} Week` in a **Required Visual Details** row. Save.
2. Open **Runtime Prompt Preview**, set **Sample name** = `David Franklin`,
   **Sample pronouns** = `he/him`, click **Generate**.
3. In the **compiled prompt**, find **REQUIRED VISUAL DETAILS**.
   - **Expect:** `David Franklin's Week` — and **no** leftover
     `{NAME_POSSESSIVE}` anywhere.
4. Change **Sample name** to `Chris`, Generate again.
   - **Expect:** `Chris's Week` (note: **Chris's**, not `Chris'` — we always add
     `'s`).
5. The **Rendered fact text (sample subject)** block at the top changes when the
   sample name/pronouns change **for tokens in the fact text itself**. A token
   you put in an *override field* (step 1) appears in the **compiled prompt**,
   **not** in this block — that's expected.

## 4. No real name is ever stored

1. After saving `{NAME_POSSESSIVE} Week`, **reload** the fact editor.
2. Open the override panel.
   - **Expect:** the field still stores `{NAME_POSSESSIVE} Week` — the literal
     token, **not** `David Franklin's Week`. The real name only exists at
     render-time, per viewer.

## 5. Unknown tokens are still rejected

1. Type `{FirstName}` (not a real token) into any override field.
   - **Expect:** an amber warning: *"Invalid token: … Use {NAME},
     {NAME_POSSESSIVE}, and pronoun tokens only."* and the fact can't be approved
     with the bad token in place.

## Regression smoke

| Check | Expect |
| --- | --- |
| Existing `{NAME}` / pronoun chips | Still insert + render as before |
| Override toggle off | Panel collapses; no chips; no effect on prompt |
| A fact with no override | Preview + compiled prompt unchanged from today |
| Role binding `entity` field | Accepts `{name_possessive}` and normalizes it to `{NAME_POSSESSIVE}` |

## Known non-bugs

- The chip's copy-to-clipboard fallback only triggers when **no** token-capable
  field is focused. With a field focused, the chip inserts directly.
- Moderator Intent intentionally rejects token insertion (it's never rendered).
- We always render `{NAME_POSSESSIVE}` as `name + 's`, including for names ending
  in *s* (`Chris's`, `James's`). This is the chosen style — not a typo.

## Bug report template

```
Area: [chips / {NAME_POSSESSIVE} / rendered preview]
Fact: [title or id]
Sample name / pronouns: […]
Field used: [Required Visual Details / role binding / supporting text / …]
What I did: […]
Expected: […]
Saw: […]
```
