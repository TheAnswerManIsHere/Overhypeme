# PR153 — Enrichment Field Documentation — Test Run (Replit)

Engineering checklist. In-app click-through: `PR153_ENRICHMENT_FIELD_DOCS_UAT.md`.

## What this PR does

Adds an info-icon popover to every field of the admin enrichment editor (shared
by moderation Step 2 → Advanced Options and Admin → Facts), backed by a typed
`fieldDocs/` registry, and generates `docs/ADMIN_FIELD_REFERENCE.md` from that
registry. Frontend + content only — **no backend/API/DB/render-pipeline changes**.
The one shared-package touch is two label strings in
`lib/api-zod/src/enrichmentOverrides.ts` (`OVERRIDABLE_PATHS`) brought into
parity with the on-screen labels.

## Commands

```bash
pnpm install                                            # picks up tsx devDep on @workspace/overhype-me
pnpm --filter @workspace/overhype-me typecheck          # tsc -b — the enum `satisfies` ratchets live here
pnpm --filter @workspace/api-zod exec tsc -b            # label mirror still compiles
pnpm --filter @workspace/overhype-me test               # full vitest suite

# The generated reference doc must be in sync + deterministic:
pnpm --filter @workspace/overhype-me run generate:field-docs   # should report "already up to date"
git diff --exit-code docs/ADMIN_FIELD_REFERENCE.md             # no diff → in sync
```

Expected at authoring time:
- Frontend suite: **645 pass / 0 fail** (55 files). New: `fieldDocs/fieldDocs.test.ts`, `FieldInfo.test.tsx`.
- `typecheck` clean (frontend + api-zod).
- `generate:field-docs` reports "already up to date" and leaves no diff.

## What the tests prove

- **Coverage ratchet** (`fieldDocs.test.ts`): every field has non-empty
  label/hint/whatItIs/howDerived/renderImpact + ≥1 complete worked example;
  every enum-backed field's values match the canonical `@workspace/api-zod`
  array **exactly, in order** (archetypes, subtypes, modifiers, reference types,
  entity kinds, capitalization signals, subject-realization modes, supporting-
  text/violence enums); every value has meaning/renderImpact/example; every doc
  or value is traceable (has `sourceRefs` or `authoredStatus`).
- **Label parity**: for every `OVERRIDABLE_PATHS` entry, `fieldLabel(docKey) ===
  OVERRIDABLE_PATHS[path].label` — the registry and the api-zod mirror can't drift.
- **FieldInfo** (`FieldInfo.test.tsx`): opens on click (not hover), content is
  `overflow-y-auto` + `z-[70]` + `max-h-[70vh]`, closes on Escape; the info
  button is a sibling of `<label>`, not a child; `FieldLabel` renders the
  registry label and keeps "Moderator Intent (admin-only, not rendered)"
  byte-identical. The modal-backdrop close guard (`guardModalOverlayDismiss`) is
  unit-tested: a dismiss landing on `[data-modal-overlay]` swallows the next
  click (one-shot) so the modal stays open; a non-overlay dismiss doesn't.
- **Generator**: deterministic (two renders identical) and the committed doc
  equals a fresh render.

## Gotchas

- The enum `satisfies` clauses are the exhaustiveness guarantee — if a future
  taxonomy value is added without a doc, **typecheck fails** (by design).
- Radix's outside-*pointerdown* dismissal is not simulable under jsdom, so the
  "tap outside closes the popover" gesture is verified in the UAT manually; the
  jsdom tests cover Escape + the overlay guard (the actual regression risk).

## Deliberately not shipped

- The 12 proposed field renames — a separate approval-gated commit on this PR
  (David signs off row-by-row; current labels ship until then).
- No new LLM calls, no scenario-grid / RuntimePromptPreview changes, no manual
  narrative docs beyond the generated reference.
