# Render-prompt fidelity — user acceptance testing (in-app)

You're the end user (admin) here. Earlier you suspected the image engine
wasn't actually receiving the rich reasoning we build for each fact — and
that the live render was leaking `{NAME}` tokens. Both were real. This work
closes the gap end-to-end: the engine prompt is now **assembled** from the
structured plan + runtime inputs, built from correct, reproducible inputs.

The engineering/automated side is in
[`PROMPT_FIDELITY_TEST_RUN.md`](./PROMPT_FIDELITY_TEST_RUN.md) (owned by
Replit AI); you don't need to read it.

This PR also finishes the two items
[`RUNTIME_PROMPT_PREVIEW_UAT.md`](./RUNTIME_PROMPT_PREVIEW_UAT.md) flagged as
"not shipped yet": the live render token-rendering fix, and cultural
references now showing as **used** (not just provided).

If anything fails, note the section + step, what you saw vs. expected, and a
screenshot if visual. Bug template at the bottom.

---

## What this work explicitly does NOT ship

Not failures if you hit them:

- **A cost/budget gate for 2K renders.** Renders are now higher quality
  (2K) and cost a bit more per image; there's no budget cap yet — that's a
  deliberate follow-up.
- **An admin resolution toggle.** 2K is on by default for everyone.
- **A full prompt-section breakdown in admin.** You'll see compiler
  diagnostics in the `engineNotes` line, not a per-section trace UI.

---

## 1. The compiled prompt now carries the structured plan

Open the **Facts** admin page → pick a fact with cultural references and a
clear archetype → open the **Runtime Compiled Prompt Preview** panel. Pick
render assumptions (e.g. human i2i with a reference, or t2i fallback) and run
it.

Expect in the compiled Nano Banana prompt:

- **Rendered subject, not a token.** The prompt mentions "David" (the
  preview protagonist), never `{NAME}`/`{SUBJ}`.
- **Key visual elements** the prose skipped are spelled out ("Ensure these
  elements are clearly visible: …") — without repeating ones already in the
  prose.
- **Composition**: framing/camera plus, when applicable, "Leave clean
  negative space at the … for the caption overlay."
- **Supporting text rule**: either one short allowed text item with its
  placement, or a clean "keep all surfaces free of readable text…" line.
- **Semantic referents**: e.g. for an "Earth"-vs-"earth" fact, the prompt
  locks the right meaning ('"Earth" means the planet Earth…').
- **Cultural references** as explicit directives (e.g. Shark Week → "sharks
  on a TV screen"), always with "avoid real logos or brand marks."
- **Empty negative prompt**: the debug panel's `negativePrompt` is empty —
  exclusions are phrased positively in the main prompt.
- **`engineNotes`**: if the prompt was long, a short note like "Compressed …
  to fit the engine prompt budget."

In the debug panel, **Cultural references → used** now lists what the plan
actually consumed (previously always empty).

## 2. A real render uses rendered text + 2K (the live fix)

From the meme builder, generate an AI background **with an uploaded photo**
on a fact whose template personalizes to your name.

Expect:
- The finished image reflects your name/pronouns correctly — no literal
  `{NAME}` anywhere in the scene.
- The render looks crisper than before (2K). It may take a little longer.

## 3. A photo that can't carry the fact is blocked (not spun forever)

Upload a photo that clearly doesn't fit the fact (e.g. a plain object photo
on a fact that needs a human face doing something). When the system judges
the pairing **poor**:

Expect:
- The "Confirm your upload" modal stops with **"This photo doesn't fit"** and
  a plain-language reason + suggestion (e.g. "Try uploading a clear photo of
  a person instead.").
- If the suggestion is to change the photo, an **"Upload a different photo"**
  button appears; otherwise just **Close**.
- It does **not** hang until a generic timeout.

## 4. Upload guardrails

- Uploading, then picking an i2i mode the photo can't support (e.g. "use my
  face" on a photo with no usable face) is rejected with a clear message
  rather than producing a broken render.
- Someone else's upload can't be used for your render (you'll just get an
  error, not their image).

## Regression smoke

| Area | Expect |
|---|---|
| Generate AI bg **without** an upload (t2i) | Still works; no face/likeness claims in the scene |
| Non-human subject (pet/car) i2i | Subject preserved, never swapped for a human |
| Runtime preview for a fact with **no** cultural refs | Compiles fine; "used" list empty |
| Existing saved AI backgrounds | Still display and select normally |

## Known non-bug limitations

- 2K renders cost a little more and can be slightly slower — expected.
- The preview protagonist is always "David"; it doesn't use a specific
  admin's real name. Real renders use the requesting user's name.

---

## Bug report template

```
Section/step:
What I did:
What I expected:
What I saw:
Fact ID / screenshot:
```
