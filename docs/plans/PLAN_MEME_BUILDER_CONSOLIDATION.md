# Meme Builder Consolidation (Image) — One Shared Renderer, Stored Master + Privacy + One Builder

> **Final architecture (David, 2026-07-24):** the client sends **parameters
> only**; the server renders the meme **once at save time** using the **same
> shared rendering module the preview uses**, and stores the result as a
> **capped high-resolution master (~2400px long edge)**. The gallery, every
> share/permalink, and print/merch all serve that frozen stored file. This
> supersedes both prior approaches from earlier review rounds (patching the
> divergent server renderer; uploading the client preview bitmap). Rationale:
> merch/print is a launch requirement (needs re-derivable high-res), mobile
> uplinks must not carry multi-MB uploads (the save payload stays tiny), and
> the seven review rounds showed the true root cause was **two renderers that
> drift** — so there will be exactly **one**.

## Concrete symptoms (David's reports)

1. "We lost the ability to make memes private in the new meme builder."
2. Screenshot: a saved meme's image reads `{NAME} ONCE THREW A GRENADE...`
   literally, while the sidebar text on the same page renders correctly.

## Product requirements (David, verbatim intent)

1. **Stored for immediate retrieval.** Once generated, the meme bitmap is
   stored and served directly in galleries — no on-demand re-render for
   display.
2. **Shares are frozen.** A shared meme renders exactly as it was when
   created, forever. A later name change does **not** update it.
3. **Explicit re-render creates a NEW meme.** If the user changes their name
   and re-renders, that produces a new meme; the original is untouched (old
   links/shares stay as-created).
4. **Print-grade but bounded.** The stored master must be high-res enough for
   any use including merch print, but capped — no storing huge images beyond
   what print needs. **Decision: ~2400px long edge (~4–5MP), JPEG.**
5. **Watermark is tier-gated.** Whether a meme carries the overhype.me
   watermark is a **tier benefit**, wired into the tier plan matrix as a
   feature flag (like `meme_private_visibility`). Which tiers get
   watermark-free is **deliberately undecided** — the flag ships wired but
   David sets the tier mapping later. Since masters are frozen snapshots, the
   watermark state is baked at render time from the creator's tier at save.

## Repo context inspected

- **Root cause of the reported token bug:** two divergent renderers. The
  wizard preview draws client-side via `render-fact.ts` +
  `LivePreview.tsx:153-216` (token substitution, orange name-highlight,
  full styling); the saved image is re-drawn server-side by
  `generateMemeBuffer` (`memeGenerator.ts`), which draws `topText`/`bottomText`
  **verbatim** (`:378-380`, the `{NAME}` bug), fills one flat color (no
  name-highlight), and reads a drifted options contract (`color` vs the
  client's `textColor`; `verticalPosition` vs the client's `topY`/`bottomY`).
  Server pronoun forms also diverge (`resolvedIdentityForms.ts:82-88` collapses
  neopronouns to they-forms; client `render-fact.ts` has full `xe`/`ze` maps).
- **Serve/export paths already prefer a stored bitmap** (`routes/memes.ts:
  622-624, 761-763, 891-893`) and only fall back to `generateMemeBuffer` when
  none exists — so "store at save, serve the file" fits the existing routes.
- **Current save-time bitmap path is unusable for high-res**: 
  `previewImageBase64` is capped at 700K chars (`memeBuilder.ts:160`) with a
  2MB JSON body cap — one of the reasons the client-upload approach was
  rejected (Codex round 8).
- **Privacy** — fully wired server-side, no UI: `memes.is_public`
  (`schema/memes.ts:23`), `meme_private_visibility` flag
  (`0013_feature_flags.sql:25-40`), `createMemeRecord.ts:170-175`,
  `memeBuilder.ts:159`. Reference toggle UI in dead `MemeBuilder.tsx:2116-2134`.
- **Remix/cold-permalink** — `MemePage.tsx:209-239` pre-seeds the original's
  stock photo via `initialStockImageId`; the wizard lacks the prop.
- **Builder sprawl** — dead `components/MemeBuilder.tsx`, live flat
  `meme-builder/MemeBuilder.tsx` (+`MemeStudio.tsx`/`BuilderOverlay.tsx`), and
  the wizard behind `VITE_MBFO_WIZARD` (a no-rollout-flag violation).

## Settled decisions

1. **One shared rendering module.** Extract the wizard preview's compositing
   (token substitution via the client's full pronoun maps, orange
   name-highlight segments, text styling/layout) into a shared, dependency-
   light module that runs in the browser (preview) AND on the server via
   `@napi-rs/canvas` (save-time master render). The preview and the master are
   the same code — drift becomes impossible. The shared pronoun-form table
   lives with it (folds in the earlier neopronoun-parity decision; parity
   scope = the 5 allowlisted presets; `PronounsSchema`'s allowlist is a
   deliberate security boundary, unchanged).
2. **Save flow:** wizard POSTs parameters (fact, source image ref, name/
   pronouns, styling, split, framing, aspect) → `createMemeRecord` resolves
   the effective identity, renders the master **once** with the shared module
   at ~2400px long edge, NSFW-classifies the rendered output, stores it, and
   persists the render parameters + `renderedFactText` snapshot alongside.
   `previewImageBase64` is **removed from the save schema** (no client bitmap
   path remains; the field dies with the dead builder).
3. **Serve flow:** gallery/permalink/OG/export/Zazzle all serve the stored
   master (downscaling on the fly where a smaller variant is needed).
   `generateMemeBuffer`'s at-request re-render path is **deleted, not
   demoted** — with the master guaranteed at save, a bitmap-less meme is an
   invariant violation, not a mode. (Kills Codex round-8's fallback-identity
   and cleanup-predicate hazards: no fallback exists to misrepresent, and a
   failed master render **fails the save** rather than persisting a
   degraded row.)
4. **Re-render = new meme.** A user can re-render after a profile change;
   it creates a new meme row + master; the original is untouched.
5. **Watermark tier flag.** Add a watermark feature flag to the tier plan
   matrix (wired like `meme_private_visibility`); the shared renderer applies
   or omits the watermark at save based on the creator's tier. Tier mapping
   left for David to set later; current default: watermark on for all tiers
   (today's behavior).
6. **Privacy toggle restored** in the wizard Step 2 image flow (legendary-
   gated, mirroring the dead builder's UX); `isPublic` added to
   `SaveMemePayload`/`buildSaveMemePayload()`.
7. **Idempotency key carries effective identity AND the evaluated watermark
   entitlement** — `effectiveName`, `effectivePronouns` (resolved request →
   profile → `"___"`), and the watermark decision (the evaluated tier-feature
   result) as dedicated mandatory fields, all computed before the key;
   rendered text is not an acceptable substitute. Watermark is in the key
   because it's baked into the output bytes (Codex round 9): a tier upgrade or
   a matrix flip within the dedup window must produce a fresh render, not
   return the old differently-watermarked row. Two saves differing by name,
   pronouns, or watermark entitlement never collapse; byte-identical repeats
   still dedupe.
8. **One image builder.** Wizard mounted from `FactDetail.tsx` and
   `MemePage.tsx`; `VITE_MBFO_WIZARD` removed; delete the legacy island
   (`components/MemeBuilder.tsx`, flat `meme-builder/MemeBuilder.tsx`,
   `MemeStudio.tsx`, `BuilderOverlay.tsx`, and the orphaned video-UI trio
   `MemeStudioVideoTab.tsx`/`MemeMagicVideo.tsx`/`VideoBuilder.tsx`) plus
   orphaned tests. Gating `rg` sweep: no live import of any deleted component;
   the caller-less legacy `POST /api/videos/generate` route is documented as a
   deferred orphan (video backend untouched — appendix).
9. **`initialStockImageId`** added to the wizard for remix/cold-permalink
   one-tap parity.
10. **User hard-delete cleans stored masters (Codex round 9).** The admin
   hard-delete path (`admin.ts:260-264`) deletes the stored meme object only
   when `imageSource === null` — but post-pivot rows keep `imageSource`
   (the render parameters) *and* have a stored master, which would survive
   account hard-delete as orphaned media. Fix: delete the master object for
   every image meme regardless of `imageSource`, and cover it in the
   hard-delete/storage-summary tests.

## What must NOT change

- Private-meme access control (404-not-403, no social preview, no public
  cache) — PR213 behavior.
- The split-slider UX.
- Video creation capability and all video backend (appendix).

## Source-of-truth analysis

| Concept | Source of truth |
|---|---|
| The meme image | The stored master rendered once at save by the shared renderer — never re-derived at request time |
| Rendering semantics (tokens, highlight, styling, pronoun forms) | ONE shared rendering module used by both the browser preview and the server master render |
| Rendered text snapshot | `renderedFactText` persisted at save (frozen; profile edits don't touch it) |
| Whether an image meme is public | `memes.is_public` + `meme_private_visibility` (unchanged) |
| Watermark on a meme | Tier feature flag in the plan matrix, evaluated at save, baked into the master |
| Idempotency | Key includes `effectiveName` + `effectivePronouns` as dedicated fields |
| Which image builder is mounted | `MemeBuilderWizard`, unconditionally |
| Video backend | Unchanged by this PR (appendix) |

## Migration/backfill impact

Pre-launch, no real data to preserve. One-time cleanup: **delete image-meme
rows that have no stored master** (these are exactly the pre-pivot wizard
saves whose permalinks re-render with raw tokens). Predicate is
"no stored bitmap object exists for the slug" — post-deploy rows always have a
master (a failed render fails the save), so re-running cannot touch fresh
memes (addresses Codex round-8's cutoff concern structurally, no date cutoff
needed). Idempotent; log counts.

## Testing plan

- **Preview/master parity (the general invariant):** for a matrix of pronoun
  sets (all 5 presets) × styling options (non-default color, moved vertical
  position, effect, caps) × a name-token fact, the shared module's browser
  output and the server master render produce identical text layout/content —
  and the master contains no unresolved token (`hasUnresolvedFactTokens`).
- **Save→serve e2e:** saved wizard meme stores a master at ~2400px long edge;
  gallery/permalink/export/Zazzle routes return bytes of that stored master
  (not a re-render); dimensions asserted.
- **Frozen semantics:** creator renames after save → permalink bytes
  unchanged. Explicit re-render → new meme row + master; original untouched.
- **Failed render fails the save:** forced render/storage error → 5xx, no row
  persisted (no bitmap-less rows can exist post-deploy).
- **Moderation preserves the existing decision matrix (Codex round 9):** the
  classifier runs on the rendered master, keeping `classifyAndDecide`'s
  current contract — above-threshold content is **rejected/quarantined only
  when the user has NOT opted into NSFW mode**; with `nsfwModeEnabled` the
  save is **accepted and tagged** (`is_nsfw` + score persisted). Test both
  branches; the tag/score columns stay live for this flow.
- **Idempotency:** two saves differing only by name/pronouns → two memes
  (incl. pronouns-only and token-free-fact cases); identical params with
  **different watermark entitlement** → two distinct memes; identical
  entitlement + params still dedupes.
- **Hard-delete:** hard-deleting a user removes every stored master for their
  image memes (imageSource null or not); storage summary reflects it.
- **Watermark flag:** flag on → master carries watermark; flag off → clean
  master; wired through the tier matrix.
- **Privacy:** `buildSaveMemePayload` carries `isPublic`; PR213 UAT table
  re-run for a wizard-created private meme.
- **`initialStockImageId`:** Step 1 skipped, photo pre-selected.
- **Cleanup:** master-less row deleted; row with master untouched; re-run
  no-op.
- **`rg` deletion sweep** clean.

## Risks

- **The shared renderer is the load-bearing build item.** Extracting the
  canvas logic to run identically in browser and `@napi-rs/canvas` (fonts,
  text metrics, wrapping) is where fidelity bugs would hide — the parity test
  matrix above is the guard. Font registration server-side must match the
  preview's fonts (`ensureFontsRegistered`).
- **Save latency:** rendering ~4-5MP + NSFW classification at save adds
  seconds; the wizard already has async loading UX (PuLID takeover) to reuse
  if needed.
- **`lib/api-zod`/shared-module codegen discipline** (`patch-generated.mjs` +
  `check:codegen-drift`) if shared exports change — the twice-hit trap.
- Deleting the builder island touches every importer — `rg` sweep guards.
- `initialStockImageId` is new state code — needs its own tests.

## Definition of done

- One image builder (wizard), flag removed, legacy island deleted, sweep clean.
- Saving any image meme stores a ~2400px master rendered by the shared
  module; gallery/share/export/print serve exactly that file; preview ==
  saved, including tokens, orange name-highlight, colors, position, pronoun
  forms (all 5 presets).
- Renames never mutate existing memes; explicit re-render makes a new one.
- Watermark flag wired into the tier matrix (mapping TBD by David).
- Legendary Public/Private toggle works per PR213.
- Identity-aware idempotency; master-less rows cleaned; failed renders fail
  the save.
- Video backend unchanged; `check:docs` + suites pass; TEST_RUN + UAT docs
  ship with the implementation PR.

---

## Carry-forward: video rebuild (findings to inherit — David, 2026-07-24)

Video is split out; this PR touches **zero video backend**. Verified findings
that must shape the rebuild (to be promoted to a durable `docs/ai-context/`
note during implementation):

1. **Object-ownership IDOR (highest priority; live today).**
   `POST /api/memes/video-jobs` regex-validates `sourceImagePath` only; the
   runner downloads it with no ownership check (`videoJobs.ts:120-138`,
   `videoPipelineRunner.ts:782,891`). Rebuild MUST authorize source-object
   ownership with a regression test.
2. **Resource governance.** Legacy route had `enforceGovernance`/
   `completeGovernance` (concurrency, spend/duration/payload caps, fal
   circuit-breaker); wizard route has only a budget pre-check.
3. **Async lease lifecycle.** `startVideoJob` schedules via `setImmediate`
   (`videoPipelineRunner.ts:430,544`); the lease must complete from pipeline
   terminal states, not the HTTP handler.
4. **TTL/prune is a terminal state** — `pruneExpired()` drops must release
   the lease.
5. **Video privacy** — wizard video-jobs hard-code `isPrivate: false`;
   design privacy in (parity with image `is_public`).
6. **Renderer reuse** — the rebuilt video captions should consume the same
   shared rendering module this plan creates.
