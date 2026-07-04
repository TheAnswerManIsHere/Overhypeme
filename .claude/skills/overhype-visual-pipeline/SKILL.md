---
name: overhype-visual-pipeline
description: Work on Overhype.me visual planning, prompt compilation, render policy, candidate concepts, and moderation renders. Use for anything touching the image-prompt planner, the Nano Banana 2 compiler, the Visual Concept, render modes (i2i/t2i), identity/subject binding, or readable-text policy. Preserves the Visual Concept as authoritative, keeps preview aligned with runtime, and blocks reintroduction of retired mistakes.
---

# Overhype visual pipeline

For work on the render-time image pipeline.

## Read first

- [`docs/ai-context/visual-pipeline.md`](../../../docs/ai-context/visual-pipeline.md)
- [`docs/ai-context/moderation-workflow.md`](../../../docs/ai-context/moderation-workflow.md)
- [`docs/ai-context/known-failure-patterns.md`](../../../docs/ai-context/known-failure-patterns.md)
- `.agents/memory/image-prompt-preview-parity.md`, `docs/ADMIN_FIELD_REFERENCE.md`

## Preserve

- **The moderator-authored/-picked Visual Concept is the authoritative scene.** The
  frontier planner realizes it; the human concept wins.
- **Single prompt channel.** The compiler owns TASK/BINDING/STRICT-CONSTRAINTS/
  identity/reference/text-policy language. Do **not** add a duplicate prompt-building
  channel or let planner prose re-author compiler-owned clauses.
- **No raw enrichment behind the planner.** Cultural references / semantic entities
  are planner *inputs*, not "Interpret X means Y" lines to the engine.
- **Runtime Compiled Prompt preview must match runtime** — everything goes through
  `assembleImagePromptForPreview()` → `generateImagePromptPlan()` +
  `compileForSubjectRenderMode()`. Feed previews the canonical
  `RUNTIME_PREVIEW_DEFAULT_NAME`; never hardcode a per-route name. Divergence is
  temperature (0.4), not caching.
- **Readable in-scene text is preserved when required** — keep the narrow
  overlay-only exclusion; never reintroduce a blanket "no readable text" rule.
- **Subject/identity binding** — single subject; age/life-stage transforms bind to
  the one subject (no second person/clones) and must compile, never silently drop.

## Do NOT reintroduce

Blanket text bans · `gpt-4o-mini`/`gpt-image-1`/FLUX as the render path (it's the
`gpt-5.5` planner + Nano Banana 2) · enrichment-time visual preview as source of
truth · violence auto-softeners · per-route preview identities.

## Tests

Add regression tests for prompt contradictions and source-of-truth failures when
relevant (e.g. moderator core scene wins; compiler strips duplicated identity
prose; supporting-text policy modes; anti-split identity constraints). Run via the
repo runners.
