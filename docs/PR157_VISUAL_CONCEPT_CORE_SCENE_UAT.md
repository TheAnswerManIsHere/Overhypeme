# PR157 — Frontier visual planner + moderator core scene (Visual concept) — UAT (David)

Companion engineering checklist (for Replit): `docs/PR157_VISUAL_CONCEPT_CORE_SCENE_TEST_RUN.md`.

## What changed, in one breath

The AI step that invents each render's visual gag now runs on gpt-5.5 at maximum
reasoning effort instead of the cheap utility model — and when you already know
the picture you want, there's one new box in visual review, **"Visual concept —
describe the picture"**, where you just write it; the system treats your scene
as law (never compressed out, planner ordered to realize it), while the compiler
still handles identity, tokens, style, and safety plumbing for you.

## Why it matters

This is the answer to "renders don't capture the joke, and I can't tell which of
45 knobs to turn." Two levers replace the knob-hunt: a much smarter model gets
the joke on its own more often, and when it doesn't, you state the picture in
plain language instead of reverse-engineering the taxonomy.

## Walkthrough

Prereq: a fact in **production_review** (submit one and Provisional Approve it),
plus a moment on `/admin/engines` and `/admin/config`.

1. **See the new engine.** Open `/admin/engines`. Under a new **"LLM engines"**
   section header, expect **"OpenAI — Visual Planner"** (model `gpt-5.5`,
   reasoning effort `xhigh`). Expect NO "Default" button on this row, and in its
   editor the "Default for kind" toggle is disabled with an explanatory tooltip.
   (That guard stops one stray click from routing every cheap utility call
   through the expensive planner.)
2. **Write a visual concept.** Open `/admin/moderation` → your review → Step 2
   (Visual review). Between the test-render grid and Advanced Options, expect
   the new **"Visual concept — describe the picture"** card. Type a scene using
   a token, e.g. `{NAME} triumphantly holds a participation trophy the size of
   a grain of rice, photographed like a championship victory.` Expect: token
   chips insert at your cursor, a live `n/1500` counter, and the draft
   save indicator ("Saving…" → "Saved") below Advanced Options.
3. **See it become law.** Open Advanced Options → Prompt Diagnostics → recompute.
   Expect: CORE SCENE shows YOUR sentence (with the sample name substituted,
   e.g. "David Franklin"), carrying an **"always kept"** priority chip AND a new
   purple **MODERATOR** chip. Above the diagnostics, expect a small line
   **"Planned by gpt-5.5 (openai-visual-planner, effort xhigh)"**.
4. **Watch the guardrail work.** Change the Visual concept to
   `Preserve the uploaded face and do not show readable text.` and recompute.
   Expect an amber warning that the Visual concept was stripped/emptied
   (compiler owns those instructions) and CORE SCENE falling back to the AI's
   scene — never a blank scene, never a silent success.
5. **Render it.** Restore a real scene description (step 2). Expect the scenario
   tiles to flag **stale** on their own after the save. Run a render. Expect a
   noticeably longer prompt-generation phase than before (gpt-5.5 thinking —
   tens of seconds to a minute+ is normal) and the image to depict YOUR scene.
6. **Same field, other door.** Open any live fact's Edit page → Visual Strategy
   Override panel. Expect the same "Visual Concept (Core Scene)" field at the
   top of the enabled section, with a ⓘ field doc.
7. **Fallback honesty (optional).** In `/admin/config`, set
   **"Image Prompt — Visual Planner Engine"** to `bogus-id`, recompute the
   preview: expect a loud amber **FALLBACK** banner naming the reason — renders
   still work on the old model. Set it back to `openai-visual-planner`.

## Expect vs. don't-expect

- **Expect** typing in the Visual concept box to auto-enable the override
  (watch the Advanced Options toggle flip on). **Don't expect** clearing the box
  to disable it — your other override fields stay live.
- **Expect** prompt generation to be slower and pricier per render (~$0.10–0.25,
  up to a minute+). That's the accepted trade for quality; you can drop the
  model/effort on the engine row anytime.
- **Expect** your scene verbatim in CORE SCENE (minus stripped engine
  instructions). **Don't expect** the planner to "improve" your concept into a
  different gag — supporting detail only.
- **Don't expect** AI-suggested concept candidates yet — that's slice 2.

## Regression smoke

| Area | Check |
|---|---|
| Moderation approve flow | Triage → prep → visual review → Approve for Production still completes with NO visual concept typed (field is optional). |
| Existing override fields | Required/forbidden details, role bindings, composition guidance still land in the compiled prompt alongside a visual concept. |
| Re-run classification | After "Re-run classification", your Visual concept text survives untouched. |
| Engines page | Other engines unchanged: Default button present, set-default still works (e.g. on the General Intelligence row). |
| Utility LLM calls | Enrichment / hashtag suggestions / comment moderation still respond fast (they did NOT move to gpt-5.5). |
| User meme flow | A normal end-user render (no moderation) still completes. |

## Known non-bugs (this version)

- The Visual concept rides the Visual Strategy draft: it saves on the debounce
  (and approval is blocked while unsaved) — it is not per-keystroke persisted.
- Editing ANY override field (even admin-only notes) flips scenario tiles stale
  — pre-existing wholesale-hash behavior, unchanged.
- A moderator scene sentence that duplicates an earlier prompt section is
  de-duplicated, not lost.
- The planner sees only your core scene, not your other override fields; if a
  role binding contradicts your scene, the compiler's binding wins — diagnose in
  Prompt Diagnostics (documented slice-1 boundary).

## Bug report template

> **Where:** (moderation Step 2 / edit fact / engines / config / preview)
> **Fact + Visual concept text:** (paste both)
> **Did:** (steps)
> **Expected:**
> **Got:** (screenshot + the Prompt Diagnostics breakdown/warnings if relevant)
> **Planner line said:** (Planned by … / FALLBACK …)
