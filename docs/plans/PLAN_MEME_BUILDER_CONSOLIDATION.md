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
2. Delete entirely the whole legacy builder island — verified via import
   graph to be reachable only through each other / `MemeStudio`:
   - Image/shell: `components/MemeBuilder.tsx` (dead legacy),
     `meme-builder/MemeBuilder.tsx` (flat builder), `MemeStudio.tsx`,
     `pages/memePage/BuilderOverlay.tsx`.
   - Legacy video-creation UIs: `MemeStudioVideoTab.tsx`,
     `components/MemeMagicVideo.tsx`, `components/VideoBuilder.tsx` — all four
     (incl. dead `MemeBuilder.tsx`) call the legacy `POST /api/videos/generate`
     route, which becomes orphaned and is therefore also deleted (see decision
     8). The wizard's video path is separate and unaffected.
   - Plus all now-orphaned builder-specific tests.
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
   caller of `POST /api/memes`. **Idempotency ordering (Codex P1 round 1):**
   the current `createMemeRecord` computes its idempotency key
   (`createMemeRecord.ts:229-237`) *before* the profile fallback and *without*
   `name`/`pronouns`, and keys on the *raw* `textOptions`. If we render after
   that key, two rapid saves of the same raw-token fact with *different*
   names/pronouns would dedupe — the second saver would receive the first's
   rendered/persisted meme. Required order: resolve the **effective identity
   snapshot** (request `name`/`pronouns` → profile fallback → the no-name
   `"___"` placeholder behavior `renderFact` already uses) *first*, render
   `topText`/`bottomText` against it, and include that snapshot in the
   idempotency key. **The idempotency payload MUST carry `effectiveName` and
   `effectivePronouns` as their own dedicated key fields, unconditionally
   (Codex P2 rounds 2 + 4)** — NOT keying on rendered text (or rendered
   `textOptions`) as a substitute. Rendered text is an unsafe key because it
   collides for saves that differ only by pronouns whenever the template has
   no pronoun-sensitive output — a `{NAME}`-only or token-free fact renders
   byte-identically for `he/him` and `they/them`, so the second save would
   still receive the first's meme. Keying on the raw `effectivePronouns`
   value closes that. Then two saves differing by name *or* pronouns can
   never collapse to a stale rendered meme.
   **Renderer parity for neopronouns (Codex P2 round 3 — David: full parity
   now):** the server render must agree with the wizard preview for *every*
   allowed pronoun set, not just he/she/they. Today they diverge: the shared
   `resolveIdentityForms` (`lib/api-zod/src/resolvedIdentityForms.ts:82-88`)
   special-cases only `he`/`she` and collapses every other subject —
   including `xe`/`ze` neopronouns — to `their`/`themselves`/`theirs`, while
   the client `render-fact.ts` `KNOWN_MAPS` carries full neopronoun forms
   (`xe`→`xyr`/`xemself`, `ze`→`zir`/`zirself`). Fix the divergence at its
   root: **lift the client's neopronoun form table into the shared
   `resolveIdentityForms` so there is ONE renderer both sides use** (the
   client's `renderFactSegments` continues to drive the preview; the server
   meme render calls the same shared derivation). This makes the saved image
   agree with the preview and the user's actual pronouns for `{POSS}`/
   `{POSS_PRO}`/`{REFL}`/`{OBJ}` across all allowed sets. **Parity scope =
   the 5 allowlisted presets** `he/him`, `she/her`, `they/them`, `xe/xem`,
   `ze/zir` (Codex P2 round 4). The `/api/memes` `PronounsSchema`
   (`memeBuilder.ts:35-40`) deliberately restricts pronouns to that enum as a
   prompt-injection guard, so custom pipe-delimited pronoun strings are
   rejected at the boundary by design and are **out of scope** here — we do
   NOT widen that security allowlist as a side effect of the parity fix. (If
   custom-pronoun meme support is ever wanted, that's a separate, deliberate
   security-surface decision for David, not a drive-by expansion.) **Ripple
   to check:**
   `resolveIdentityForms` also feeds budget projection
   (`promptIdentityBudget.ts` reserves space per resolved token) — the new
   (sometimes longer) neopronoun forms must be re-reconciled there, and the
   `unresolvedSimpleTokens()` cross-check kept green. This touches
   `lib/api-zod`, so follow the codegen/export discipline (update
   `patch-generated.mjs` + run `pnpm run check:codegen-drift` if any export
   surface changes — see CLAUDE.md).
7. Privacy toggle is restored in the wizard's Step 2 **image** flow (Public/
   Private control, gated on `viewerContext.tier === "legendary"`, mirroring
   the dead builder's UX), and `SaveMemePayload`/`buildSaveMemePayload()`
   gains the `isPublic` field so it reaches the already-functional API path.
   **Image memes only** — video privacy is explicitly out of scope, see
   decision 8.
8. **Video builder scope (David, 2026-07-24): the video builder is slated for
   a full rebuild once the image generator is perfected, so this plan invests
   nothing in the interim video path** — threading *privacy* (a feature)
   through a soon-to-be-replaced path is throwaway work. **The one exception
   is resource governance (Codex P1 round 3 — David: port it now):** cost/
   abuse protection is not a feature and is never waived by the pre-launch
   boldness rule, so we do not ship an ungoverned video path. Concretely:
   - The wizard's existing video path (`Step1ArtifactType` "video" →
     `Step2Video` → `POST /api/memes/video-jobs`) stays as the **interim,
     public-only** video builder. Video creation therefore remains reachable
     through the one wizard — "one builder" holds for video too.
   - **Governance is ported onto the surviving wizard video path *before* the
     legacy route is deleted.** The legacy `POST /api/videos/generate` wraps
     generation in `enforceGovernance`/`completeGovernance` (fal provider,
     per-user concurrency, spend/duration/payload caps, circuit-breaking);
     the wizard's `POST /api/memes/video-jobs` currently has only a
     per-request budget pre-check.
     - **The lease must span the async job lifecycle, NOT the HTTP request
       (Codex P1 round 4).** Critical asymmetry: the legacy route generates
       synchronously inside the request, but the wizard route returns
       `{ jobId }` immediately and `startVideoJob` schedules the expensive FAL
       pipeline via `setImmediate` (`videoPipelineRunner.ts:430,544`). So
       calling `completeGovernance` in the route `finally` would release the
       concurrency slot and record success *milliseconds after acquire, before
       stage 2 runs* — governance in name only (no real concurrency limit, cost
       recorded before it's incurred, provider failures never seen by the
       circuit-breaker). Therefore: **acquire the lease at job start and
       complete it from the pipeline's terminal path** (success / failure /
       cancel, inside `videoPipelineRunner`), not from the route handler — i.e.
       enforcement lives in the runner lifecycle, keyed to the job, so the slot
       stays held for the job's real duration.
     - Acceptance: an API test proving a second concurrent video job is
       **rejected while the first is still in a non-terminal phase** (not
       merely after the first request returned), plus the fal circuit-breaker
       exercised on a pipeline failure. This is reusing an existing guard
       correctly for an async job, not building new interim-video functionality.
   - **Video privacy is dropped for the interim.** Wizard-created videos are
     public-only; no `isPrivate` toggle is added to the wizard video step and
     no privacy field is threaded through the video payload. The rebuilt video
     builder will design privacy in from the start. (Codex P1 round 1 asked us
     to *decide and record* this rather than leave it conditional — recorded.)
   - **Only the `POST /api/videos/generate` creation handler is removed** —
     surgically, not the whole `routes/videos.ts` file. Its sibling read
     handlers in the same file (`GET /api/videos/:factId` for the gallery,
     `GET /api/video/:videoId` for the detail page) **stay mounted** — deleting
     the file wholesale would strand every existing completed `video_jobs` row
     even though the table is preserved. Removed along with the POST handler:
     only the tests that exercise creation via it. **Shared video
     infrastructure is retained and documented as non-builder infra the
     rebuild will consume:** the `video_jobs` table (incl. its `is_private`
     column — harmless to keep, and the rebuild uses it), those `GET` read
     routes (`FactDetail.tsx` reads `video.isPrivate` for its community/mine
     split), and the render pipeline (`videoPipelineRunner`).

## What must NOT change

- The private-meme *access-control* behavior itself (404-not-403 to
  non-owners, no social preview, no public cache) — untouched, already
  correct, covered by `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`.
- The split-slider UX (word-position semantics, `intelligentSplit`,
  `factSplitTokenIndex`) — the token fix lands server-side and does not
  touch how the client computes or displays the split.
- Video meme *creation capability* — must stay reachable. Verified: the
  wizard's video path (`Step1ArtifactType` "video" → `Step2Video` →
  `/api/memes/video-jobs`) is live and independent of the deleted legacy
  island, so deleting that island does not remove video creation. What *does*
  change (deliberately, per decision 8) is video **privacy**: interim wizard
  videos are public-only until the video rebuild.
- The `video_jobs` table, video read routes, and render pipeline — retained
  untouched as shared infra; only the orphaned legacy *creation* route is
  removed.

## Source-of-truth analysis

| Concept | Source of truth after this change |
|---|---|
| Whether a meme is public | `memes.is_public` column + `meme_private_visibility` feature flag (unchanged) |
| Rendered meme text (image + stored options) | Computed once in `createMemeRecord.ts` from `(textOptions.topText/bottomText raw template, effective identity)` — never re-derived client-side, never stored un-rendered |
| Effective identity for a save (name/pronouns) | Resolved once in `createMemeRecord.ts` (request → profile fallback → `"___"` placeholder) *before* the idempotency key; both the render and the dedup key derive from it |
| Pronoun→form derivation (all sets incl. neopronouns) | ONE shared `resolveIdentityForms` in `lib/api-zod`, neopronoun-aware, used by the server meme render, budget projection, AND the client preview — no second divergent table |
| Video-generation governance | `enforceGovernance`/`completeGovernance` on the surviving `POST /api/memes/video-jobs` route (ported from the deleted legacy route) — single governed video path |
| Whether two saves are "the same" (idempotency) | Key **always** includes `effectiveName` + `effectivePronouns` as dedicated fields (never substituted by rendered text, which collides on token-free/`{NAME}`-only facts), so name *or* pronoun differences never collapse |
| Video-generation governance lease | Held for the async job's real duration — acquired at job start, completed from the pipeline terminal path in `videoPipelineRunner` (not the HTTP `finally`) |
| Which builder is mounted | `MemeBuilderWizard`, unconditionally — no env flag |
| Video creation (interim, pre-rebuild) | Wizard `Step2Video` → `/api/memes/video-jobs`, public-only; legacy `/api/videos/generate` creation route removed |
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
- Unit test (idempotency, Codex P1 round 1 + P2 round 2): two saves from the
  same user within the idempotency window, identical in every field **except**
  `name`/`pronouns`, must produce two distinct memes with each one's own
  correctly-rendered text — they must NOT dedupe to the first result.
  **Must include a pronouns-only difference and a no-token/absent-`textOptions`
  case** (e.g. same name, `he/him` vs `they/them`; and a save with empty
  `textOptions`), proving the key never falls back to an identity-blind
  branch. Conversely, two byte-identical saves (same effective identity) still
  dedupe as before.
- Unit test (renderer parity, Codex P2 rounds 3 + 4): for **every one of the
  5 allowlisted pronoun sets** — `he/him`, `she/her`, `they/them`, `xe/xem`,
  `ze/zir` — the server meme render of a template containing
  `{SUBJ}`/`{OBJ}`/`{POSS}`/`{POSS_PRO}`/`{REFL}` must byte-match the client
  `renderFactSegments` output. General-invariant test (per the token-rendering
  skill), not a single neopronoun example. (Custom pipe-delimited pronouns are
  intentionally excluded — `PronounsSchema` rejects them at the boundary; a
  test asserts that rejection stays a clean 4xx, not a 500.)
- Unit test (budget-projection ripple): `promptIdentityBudget` reserves still
  cover the new neopronoun forms; `unresolvedSimpleTokens()` cross-check stays
  green after the shared-renderer change.
- API test (video governance, Codex P1 rounds 3 + 4): a second concurrent
  video job for the same user is rejected **while the first is still in a
  non-terminal pipeline phase** (proving the lease is held for the job's real
  duration, not released when the start request returned), and the fal
  circuit-breaker path is exercised on a pipeline failure — matching the
  protection the deleted legacy route had.
- Unit test: wizard's `initialStockImageId` path — Step 1 is skipped, Step 2
  mounts with that photo pre-selected, matching the flat builder's prior
  behavior.
- Unit test: `buildSaveMemePayload` includes `isPublic` when the wizard's
  toggle is set to private, omits/defaults otherwise.
- Integration/e2e: legendary user saves a private meme via the wizard → not
  visible to another account/logged-out (re-run of the existing PR213 UAT
  table, which is regression coverage here since we're touching the payload
  path it depends on).
- API regression (Codex P2 round 2): seed a **completed** `video_jobs` row,
  delete only the `POST /api/videos/generate` handler, then assert the
  retained `GET /api/videos/:factId` (gallery) and `GET /api/video/:videoId`
  (detail) still return that row — proving existing completed videos stay
  reachable after the creation route is removed.
- Manual UAT: fact-detail flow, remix flow, cold-permalink flow, video flow
  — each produces a correctly-rendered image (and video); legendary Public/
  Private toggle works on the image flow; non-legendary users don't see the
  toggle; the wizard video flow still creates a (public) video.
- **Deletion-completeness acceptance check (Codex P2 round 1):** after the
  deletions, a repo-wide `rg` sweep must show **no** remaining imports of any
  deleted builder component (`MemeBuilder`, `MemeStudio`, `MemeStudioVideoTab`,
  `MemeMagicVideo`, `VideoBuilder`, `BuilderOverlay`) from live code, and
  **no** remaining caller of `POST /api/videos/generate`. Any retained video
  API/helper must be explicitly documented in-code as non-builder
  infrastructure. This sweep is a gating check, not a spot-check of the entry
  points already found.

## Risks

- Deleting the full builder island (seven components/pages plus a backend
  route) touches every place that imports them — the `rg` sweep above is the
  guard, covering tests and demo harnesses (e.g. `__demo__/MatrixHarness.tsx`),
  not just the entry points already found.
- The wizard's `initialStockImageId` addition is new code in a currently
  well-tested area (`useWizardState`, `wizardStorage` schema version) —
  needs its own test coverage, not just "it compiles."
- The idempotency reorder touches a subtle correctness path (dedup window).
  The two-saves-differ-by-identity test above is the guard; the change must
  preserve genuine dedup for byte-identical repeat saves.
- Removing the legacy `/api/videos/generate` creation route must not touch the
  video **read** routes or `video_jobs` rows the gallery depends on — verified
  the two are separable (creation handler vs. read handlers in the same route
  file). Pre-launch, no real video data to preserve regardless. **The legacy
  route is deleted only *after* governance is confirmed live on the wizard
  route** — order matters so there is never a window with no governed path.
- The neopronoun-parity fix touches the **shared `lib/api-zod` identity
  module**, which feeds budget projection and (via codegen) `api-zod/src/index.ts`.
  Two guards: re-reconcile `promptIdentityBudget` reserves against the new
  forms (a longer resolved form must not blow a reserve), and respect the
  codegen/export discipline (`patch-generated.mjs` + `check:codegen-drift`) so
  the export surface can't be silently reverted — a trap CLAUDE.md calls out
  as hit twice before.

## Questions for David

None outstanding — the two open decisions (consolidation target, remix
parity) were already resolved in conversation.

## Definition of done

- One builder (`MemeBuilderWizard`) mounted from both `FactDetail.tsx` and
  `MemePage.tsx`; `VITE_MBFO_WIZARD` flag removed.
- The full legacy builder island deleted — `components/MemeBuilder.tsx`,
  `meme-builder/MemeBuilder.tsx`, `MemeStudio.tsx`, `MemeStudioVideoTab.tsx`,
  `MemeMagicVideo.tsx`, `VideoBuilder.tsx`,
  `pages/memePage/BuilderOverlay.tsx`, the orphaned `POST /api/videos/generate`
  creation route — along with now-orphaned tests; `rg` sweep confirms no
  live imports/callers remain.
- A meme saved through any image entry flow (fact-detail, remix,
  cold-permalink) renders the actual name/pronouns in the final image —
  verified by test across multiple name/pronoun combos, not just the one
  reported example.
- The server meme render byte-matches the client preview for **every** allowed
  pronoun set including neopronouns (`xe`/`ze`), via one shared
  `resolveIdentityForms`; budget projection stays correct.
- The surviving wizard video path enforces the same governance the deleted
  legacy route had (concurrency, spend/duration/payload caps, fal
  circuit-breaker), with the lease held across the async job lifecycle — a
  second job is rejected while the first is non-terminal. No ungoverned video
  path ships.
- Two rapid saves differing only by name/pronouns produce two correctly
  rendered memes (no stale idempotent dedup); byte-identical repeats still
  dedupe.
- Legendary users can toggle Public/Private on **image** memes in the wizard;
  the meme's visibility behaves per the existing PR213 UAT table.
- Wizard video creation still works and produces a (public-only) video;
  video privacy is documented as deferred to the video rebuild.
- Remix/cold-permalink still jump straight to the pre-selected stock photo.
- `pnpm run check:docs` and the relevant test suites pass; TEST_RUN + UAT
  docs shipped with the PR per the standing ceremony.
