# Moderation render-review fixes — engineering test run (Replit)

Follow-up to PR #139 (`docs/PR139_MODERATION_RENDER_REVIEW_TEST_RUN.md`). Two
UAT-found bugs in the moderation render-review tools. Frontend-only changes; no
schema, no migration, no backend behavior change.

See also the click-through: `docs/PR140_MODERATION_RENDER_REVIEW_FIXES_UAT.md`.

## What changed (engineering summary)

1. **Pexels thumbnail layout** (`artifacts/overhype-me/src/components/admin/ModerationPexelsPanel.tsx`)
   - Thumbnails were crushed into thin horizontal strips. Root cause: inside a
     `max-h-72 overflow-auto` CSS grid, items sized via `aspect-square` have their
     row tracks *compressed to fit the max-height* instead of scrolling — with ~80
     images (20 rows) every row collapsed to ~14px.
   - Fix: fixed-height tiles (`block h-20`, `object-cover`), dropping
     `aspect-square`. The grid now scrolls normally and tiles are uniform.

2. **t2i fallback-gender derivation** (`artifacts/overhype-me/src/components/admin/RuntimePromptPreview.tsx`)
   - "Generate runtime prompt preview" and "Render AI background" failed with
     `prompt_generation_failed: t2i_fallback prompt missing fallbackSubjectGender "neutral"`.
   - Root cause: the image-prompt validator (`lib/api-zod/src/imagePromptGeneration.ts`,
     the `\bgender\b` check on the compiled prompt) requires the literal gender word;
     the model rarely emits "neutral", so t2i + neutral fails even after the corrective
     retry. Review-render mode defaults to t2i_fallback and gender was defaulting to
     `neutral` even with he/him sample pronouns.
   - Fix: in review-render mode only, derive the t2i fallback gender from the sample
     pronouns (`genderFromPronouns`: he/him→male, she/her→female, else neutral) and keep
     it synced until the moderator manually picks a gender (tracked by `genderTouched`,
     persisted to localStorage). The shared generator/validator is unchanged.

## Automated checks

```bash
# Typecheck both packages — expect clean
cd artifacts/overhype-me && npx tsc -b      # FE
cd artifacts/api-server && npx tsc -b       # BE (unchanged, sanity only)

# Frontend — the two touched suites; expect: Tests 13 passed
cd artifacts/overhype-me
npx vitest run src/__tests__/RuntimePromptPreview.test.tsx \
               src/components/admin/ModerationPexelsPanel.test.tsx
```

### What the tests pin down
- `RuntimePromptPreview.test.tsx` (new case): in review-render mode the fallback
  gender derives live from the sample pronouns (he/him→male, she/her→female), the
  derived value is sent on generate, and once the moderator changes the gender
  dropdown the pronouns no longer override it.
- Existing `ModerationPexelsPanel.test.tsx` cases (status/polling/empty/failed) still
  pass — the layout change is class-only and doesn't alter behavior.

### Layout regression evidence (manual, offline)
The crush was reproduced and the fix confirmed with a standalone Chromium render of
the exact utility classes (`max-h-72 overflow-auto` grid): the `aspect-square`
variant crushes overflow rows; the fixed-height-tile variant scrolls cleanly with
uniform tiles. No app/runtime dependency — pure CSS layout.

## Gotchas
- The fix is class-only for the grid; do **not** reintroduce `aspect-square` on a
  height-constrained scroll grid — it will crush rows again.
- `genderTouched` is persisted per review-render in localStorage; clearing storage
  resets to derive-from-pronouns (expected).
- `neutral` remains selectable and is still subject to the pre-existing generator
  fragility (see below) — only the *default* changed.

## Deliberately NOT shipped
- Hardening `neutral` in the shared image-prompt generator/validator (so abstract
  facts using `neutral` in production never fail validation). That touches the shared
  pipeline and production abstract-fact renders; deferred by decision to a separate,
  independently-tested change.
- Any backend change — the render route still accepts the gender the client sends.
