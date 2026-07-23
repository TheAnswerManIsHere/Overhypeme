# Meme Builder Consolidation — Token Bug + Privacy Toggle + One True Builder

## Concrete symptoms (David's reports)

1. "We lost the ability to make memes private in the new meme builder."
2. Screenshot: a saved meme's image reads `{NAME} ONCE THREW A GRENADE...`
   literally — the token was never substituted — while the "WHAT'S NEXT?"
   sidebar on the same page correctly shows "Nick Baron once threw...".

## Product intent

- Every meme a user saves must render their actual name/pronouns — never a
  raw `{NAME}`/`{SUBJ}`/etc. token — in the composited image.
- Legendary-tier users must be able to mark a meme private again, exactly as
  before (owner + admin only; 404 to everyone else; no social preview; no
  public cache — this behavior is unchanged and untouched by this plan, see
  `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`).
- **There should only be one way to build a meme.** David flagged that the
  repo has accumulated multiple overlapping builder implementations and
  wants the dead/duplicate ones removed, not just patched around.

## Repo context inspected

Three builder implementations exist today:

| Implementation | Status | Mounted from |
|---|---|---|
| `components/MemeBuilder.tsx` (2503 lines) | **Fully dead.** No imports anywhere outside itself/tests. Kept "for reference" per a comment in `MemeStudio.tsx:38-42`, which says Phase 5 will delete it. | Nothing |
| `meme-builder/MemeBuilder.tsx` ("flat", Phase-3) + `MemeStudio.tsx`/`MemeStudioVideoTab.tsx` | **Live today**, on-by-default. | `FactDetail.tsx` (when `VITE_MBFO_WIZARD` unset), and always from `pages/memePage/BuilderOverlay.tsx` (`MemePage.tsx`, the meme-detail/remix page — no flag check at all) |
| `meme-builder/wizard/*` (MBFO wizard) | **The active development target** — full-screen, step-based, covers both image and video (`Step1ArtifactType` → `step2-image`/`step2-video`). Gated behind `VITE_MBFO_WIZARD=1`, which is set on the Replit deployment David tested (explaining why he only sees the wizard, and only sees its bugs). | `FactDetail.tsx` only, when the flag is set |

The flag itself (`FactDetail.tsx:30`) is a **rollout-flag violation** of
`docs/ai-context/agent-working-rules.md`'s "no rollout-flag gating" rule —
it's exactly the kind of manual toggle that rule exists to prevent, and it's
why "the new meme builder" means different things depending on which
environment David is testing in.

**Privacy toggle** — confirmed still fully wired server-side, just never
migrated into either new builder's UI:
- `lib/db/src/schema/memes.ts:23` — `is_public` column, unchanged.
- `lib/db/migrations/0013_feature_flags.sql:25-40` — `meme_private_visibility`
  feature flag, legendary-tier only, unchanged.
- `artifacts/api-server/src/lib/createMemeRecord.ts:170-175` — `canPrivate`/
  `isPublic` gating logic, unchanged, currently always resolves to `true`
  because no client sends `isPublic: false` anymore.
- `artifacts/api-server/src/lib/validators/memeBuilder.ts:159` —
  `isPublic: z.boolean().optional()`, unchanged.
- The dead `components/MemeBuilder.tsx:2116-2134` had the actual toggle UI
  (Public/Private buttons, Globe/Lock icons, gated on `isLegendary`) — this
  is the reference implementation to mirror, not resurrect.

**Token-rendering bug** — root cause confirmed as a **write-time gap**, not
a display bug:
- `artifacts/overhype-me/src/lib/render-fact.ts` — `renderFact()`/
  `renderFactSegments()` are the one true tokenizer/renderer. Used correctly
  by `FactCard.tsx` and `FactDetail.tsx:111,388` (the sidebar text that
  renders fine).
- `artifacts/overhype-me/src/components/meme-builder/wizard/step2-image/Step2Image.tsx:197-205`
  builds `topText`/`bottomText` by splitting the wizard's raw `factText` prop
  (still `{NAME}`-laden — `MemeBuilderWizard.tsx:20`'s own docblock calls it
  "Token-laden fact text — passed through to Step 2 internals," confirming
  this was always meant to be rendered internally, just never implemented).
  The **live preview looks correct anyway** because `LivePreview.tsx:153-158`
  independently calls `renderFactSegments(blockText, name, pronouns)` per
  block for its own canvas draw — so this bug is invisible until you look at
  the actual saved/downloaded image.
- `artifacts/api-server/src/lib/memeComposite.ts:164,169` (`composeMeme`) —
  renders the legacy single-block `factText` via `renderPersonalized()`, but
  passes `input.textOptions` (containing the client's raw `topText`/
  `bottomText`) straight through to `generateMemeBuffer()` untouched.
- `artifacts/api-server/src/lib/memeGenerator.ts:378-380` — draws
  `options.topText`/`options.bottomText` **verbatim** whenever present (the
  wizard always sets both), never applying the render pipeline to them.
- `artifacts/api-server/src/lib/createMemeRecord.ts:141,232` — the request's
  `textOptions` (still containing the raw `topText`/`bottomText`) is also
  **persisted as-is** into `memes.text_options`, alongside `name`/`pronouns`
  which are already resolved in this same function.

**Remix/cold-permalink parity gap** — `pages/MemePage.tsx:209-239` currently
lets "Remix this meme" and "See with your name" jump straight into editing
with the *same stock photo* the original creator used, via
`initialStockImageId` passed to the flat builder. `MemeBuilderWizard.tsx`
has no equivalent prop today — it always starts at Step 1 ("choose image or
video"). Consolidating onto the wizard without addressing this would be a
real UX regression on the meme-detail page.

## Settled decisions (confirmed with David)

1. The **MBFO wizard becomes the one and only meme builder**, everywhere.
2. Delete entirely: `components/MemeBuilder.tsx`, `meme-builder/MemeBuilder.tsx`
   (flat builder), `MemeStudio.tsx`, `MemeStudioVideoTab.tsx`,
   `pages/memePage/BuilderOverlay.tsx`, and their builder-specific tests.
3. Remove the `VITE_MBFO_WIZARD` flag — the wizard ships on-by-default,
   unconditionally (per the "no rollout-flag gating" rule).
4. `FactDetail.tsx` and `MemePage.tsx` both mount `MemeBuilderWizard` directly.
5. Add `initialStockImageId` support to the wizard (Step 1 auto-skips to
   Step 2 / image mode, pre-seeded with that stock photo) so remix/
   cold-permalink keep their one-tap UX — no exceptions, no builder kept
   alive just for this flow.
6. Token-rendering fix lands in `createMemeRecord.ts` (render `topText`/
   `bottomText` once, at write time, using the request's `name`/`pronouns`;
   use the rendered value both for compositing and for what gets persisted
   in `text_options`) — the one point upstream of every current and future
   caller of `POST /api/memes`.
7. Privacy toggle is restored in the wizard's Step 2 image flow (Public/
   Private control, gated on `viewerContext.tier === "legendary"`, mirroring
   the dead builder's UX), and `SaveMemePayload`/`buildSaveMemePayload()`
   gains the `isPublic` field so it reaches the already-functional API path.
   Applies to image memes; video memes' save payload
   (`step2-video/util/saveVideoMemePayload.ts`) gets the same field added if
   video memes are also subject to `meme_private_visibility` today (to
   confirm against the current video route during implementation — no
   privacy-toggle UI currently exists for video in *any* builder, so this is
   scoped to matching whatever the API already supports, not inventing new
   video-privacy product behavior).

## What must NOT change

- The private-meme *access-control* behavior itself (404-not-403 to
  non-owners, no social preview, no public cache) — untouched, already
  correct, covered by `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`.
- The split-slider UX (word-position semantics, `intelligentSplit`,
  `factSplitTokenIndex`) — the token fix lands server-side and does not
  touch how the client computes or displays the split.
- Video meme creation capability — must have full parity in the wizard
  before the flat builder's video tab is deleted (already appears to via
  `step2-video/*`; confirmed during implementation, not assumed).

## Source-of-truth analysis

| Concept | Source of truth after this change |
|---|---|
| Whether a meme is public | `memes.is_public` column + `meme_private_visibility` feature flag (unchanged) |
| Rendered meme text (image + stored options) | Computed once in `createMemeRecord.ts` from `(textOptions.topText/bottomText raw template, name, pronouns)` — never re-derived client-side, never stored un-rendered |
| Which builder is mounted | `MemeBuilderWizard`, unconditionally — no env flag |
| Remix/cold-permalink initial photo | `initialStockImageId` threaded into wizard state at Step 1→2, same as today's flat-builder behavior |

## Migration/backfill impact

None. Pre-launch, no real users/data (per `agent-working-rules.md`'s
pre-launch guidance) — no backfill of existing `memes.text_options` rows
with stale tokens is needed or planned.

## Runtime + UX behavior

- Every save flow (fact-detail "Make a meme", meme-detail "Remix"/"See with
  your name"/cold-permalink) goes through the same wizard.
- Legendary users see a Public/Private toggle in Step 2 of the image flow;
  everyone else doesn't (matches today's dead-code gating exactly).
- Saved images never contain a raw token, regardless of entry flow.

## Security / permissions / validation

- No change to auth/tier gating beyond restoring the existing
  `meme_private_visibility` check to an actually-reachable UI control.
- Server-side rendering fix closes a latent "stored raw template in
  `text_options`" data-hygiene gap — nothing user-facing depended on that
  raw value being present, so no compatibility concern.

## Testing plan (proves the general invariant, not just the screenshot example)

- Unit test: `createMemeRecord` (or the extracted render step) — given a
  `topText`/`bottomText` containing `{NAME}`, `{SUBJ}`, and a verb-conjugation
  token, asserts the persisted `text_options` and the composited buffer's
  drawn text both contain the fully-rendered string for a range of
  name/pronoun combinations (not just "Nick Baron"/"he/him") — including a
  plural pronoun set and an anonymous/no-name case (`resolvedName = "___"`).
- Unit test: wizard's `initialStockImageId` path — Step 1 is skipped, Step 2
  mounts with that photo pre-selected, matching the flat builder's prior
  behavior.
- Unit test: `buildSaveMemePayload` includes `isPublic` when the wizard's
  toggle is set to private, omits/defaults otherwise.
- Integration/e2e: legendary user saves a private meme via the wizard → not
  visible to another account/logged-out (re-run of the existing PR213 UAT
  table, which is regression coverage here since we're touching the payload
  path it depends on).
- Manual UAT: fact-detail flow, remix flow, cold-permalink flow, video flow
  — each produces a correctly-rendered image; legendary Public/Private
  toggle works; non-legendary users don't see the toggle.

## Risks

- Deleting three components/pages touches every place that imports them —
  requires a full grep sweep for stragglers (tests, storybook-like demo
  harnesses e.g. `__demo__/MatrixHarness.tsx`) before deletion, not just the
  entry points already found.
- The wizard's `initialStockImageId` addition is new code in a currently
  well-tested area (`useWizardState`, `wizardStorage` schema version) —
  needs its own test coverage, not just "it compiles."
- If video memes turn out to have their own dormant privacy-toggle gap, that
  surfaces during implementation and needs a David check-in (out of scope
  to invent new video-privacy UX unprompted).

## Questions for David

None outstanding — the two open decisions (consolidation target, remix
parity) were already resolved in conversation.

## Definition of done

- One builder (`MemeBuilderWizard`) mounted from both `FactDetail.tsx` and
  `MemePage.tsx`; `VITE_MBFO_WIZARD` flag removed.
- `components/MemeBuilder.tsx`, `meme-builder/MemeBuilder.tsx`,
  `MemeStudio.tsx`, `MemeStudioVideoTab.tsx`,
  `pages/memePage/BuilderOverlay.tsx` deleted, along with now-orphaned tests.
- A meme saved through any entry flow (fact-detail, remix, cold-permalink,
  video) renders the actual name/pronouns in the final image — verified by
  test, not just the one reported example.
- Legendary users can toggle Public/Private in the wizard; the meme's
  visibility behaves per the existing PR213 UAT table.
- Remix/cold-permalink still jump straight to the pre-selected stock photo.
- `pnpm run check:docs` and the relevant test suites pass; TEST_RUN + UAT
  docs shipped with the PR per the standing ceremony.
