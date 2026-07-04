# PR172 — Prompt-pipeline de-scaffolding · UAT (click-through)

> **For David.** In-app acceptance test for the change that stops the AI from
> pasting modifier "directives" into the final image prompt and retires the
> blanket `no_readable_text` text ban. Companion engineering checklist:
> `docs/PR172_PROMPT_DESCAFFOLDING_TEST_RUN.md`.
>
> **What changed, in one line:** the frontier planner (steered by your Visual
> concept) now owns the scene; the compiler stopped re-injecting classifier
> modifiers as prose, so the contradictory "Keep all surfaces free of readable
> text" line can never fight your intentional in-scene text again.

---

## The bug this fixes

On the diary fact, the compiled prompt said **both** "Render this in-scene text
clearly: 'My Diary — AKA The Guinness Book of World Records'" **and** "Keep all
surfaces free of readable text, captions, and labels." The second line came from
an AI-picked `no_readable_text` modifier. That whole channel is gone.

## Where to look

Admin → **Moderation → Fact Reviews** → open a fact in **production review** →
**Step 2 · Visual review** → expand **Advanced Options** → **Prompt Diagnostics**
(the `RuntimePromptPreview` panel). That panel shows the live compiled prompt.

## The main check (the specimen)

| # | Do this | Expect |
|---|---------|--------|
| 1 | Find/craft a fact that needs readable in-scene text (a book cover, a sign, a scoreboard) — the diary/trophy fact is ideal — and reach Step 2. | Prompt Diagnostics shows a compiled prompt. |
| 2 | In the compiled prompt, find the in-scene text line. | **"Render this in-scene text clearly: …"** is present with your text. |
| 3 | Search the same prompt for a blanket text ban. | **No** "Keep all surfaces free of readable text" and **no** "free of readable text" anywhere. **No** contradiction. |
| 4 | Find the STRICT CONSTRAINTS section. | It carries **"Keep incidental background text non-readable; render only the specific in-scene text requested by these instructions."** — a *yielding* guard that keeps random background gibberish clean without banning your intended text. |
| 5 | Look at the SUBJECT DETAILS section. | It no longer contains robotic modifier sentences like "Show the object mid-transformation" / "Stage the subject in an exaggerated, mock-heroic pose." The planner's own prose covers staging. |

## Suppressing text on purpose (the new path)

| # | Do this | Expect |
|---|---------|--------|
| 1 | On a fact where you want **no** readable text at all, expand Advanced Options → **Visual Strategy Override** (toggle it on) → **Override supporting-text policy** → set mode **forbid**. Save. | The compiled prompt gains **"Avoid readable in-scene text unless required by a higher-priority instruction."** alongside the always-on incidental-text guard. This is now the way to fully suppress text (it replaces the old modifier). |

## Age transforms still work (every mode)

| Fact | Expect in SUBJECT BINDING |
|------|---------------------------|
| A human-photo fact rendered as a baby ("{NAME} as a baby…") | "…the same person de-aged or aged, not a second person." — unchanged. |
| A non-human / text-to-image fact with an age transform | A single-entity life-stage line ("…the same subject rendered at that life stage, not a different individual.") with **no** "reference person"/"adult" wording. |

## Legacy chips (harmless)

- Old facts may still show amber **`no_readable_text`** / `avoid_real_logos` /
  `avoid_readable_ui` chips in the Advanced-Options enrichment editor. They are
  **inert provenance** — not sent to the planner, not compiled, and they do
  **not** flip a render stale if you remove one. You can ignore or delete them.

## Expected, not-a-bug

- **All test renders show a "stale" badge after this deploys.** Intended
  one-time effect of the generation-version bump — re-run any render to refresh.
- **Facts show "version-stale" in Taxonomy Health.** Advisory only; no action
  required, nothing is re-classified automatically.

## Regression smoke (unchanged)

| Area | Expect |
|------|--------|
| Visual concept field, token chips, Save/Discard | Work exactly as before. |
| Approve / reject / waiver, required-render gating | Unchanged. |
| Overlay/caption/watermark/logo exclusion | Still always present ("Do not bake overlay or caption text…"). |
| Violence policy (allow/soften/suppress) | Unchanged — moderator override still the only suppressor. |
| Field info-popovers on modifiers | Now describe the two-tier model (planner context vs. structural signal); no false "Injects: …" claims. |

## Bug report template

> **Fact:** (id / text)
> **Where:** Prompt Diagnostics / test render / field doc
> **Expected:** …
> **Saw:** … (paste the offending compiled-prompt line)
> **Render mode:** human i2i / non-human i2i / t2i
