# Meme Builder Consolidation (Image) — Token Bug + Privacy Toggle + One Builder

> **Scope note (David, 2026-07-24): video is split out of this plan.** Rounds
> 3–5 of review surfaced a series of *pre-existing* security/cost gaps in the
> wizard video backend (ungoverned generation, a governance-lease lifecycle
> problem, a lease-TTL leak, and an object-ownership IDOR) — all live in
> production today, none created by this change. Hardening that path is its own
> security workstream, and the video pipeline is slated for a near-from-scratch
> rebuild. So **this PR touches zero video backend**; it fixes the two reported
> image bugs and consolidates the image builder. The video findings are
> preserved in the *Carry-forward: video rebuild* appendix below and will be
> promoted to a durable `docs/ai-context/` note during implementation.

## Concrete symptoms (David's reports)

1. "We lost the ability to make memes private in the new meme builder."
2. Screenshot: a saved meme's image reads `{NAME} ONCE THREW A GRENADE...`
   literally — the token was never substituted — while the "WHAT'S NEXT?"
   sidebar on the same page correctly shows "Nick Baron once threw...".

## Product intent

- Every meme a user saves must render their actual name/pronouns — never a
  raw `{NAME}`/`{SUBJ}`/etc. token — in the composited image, and the saved
  image must match the live preview for **every** allowed pronoun set.
- Legendary-tier users must be able to mark an (image) meme private again,
  exactly as before (owner + admin only; 404 to everyone else; no social
  preview; no public cache — unchanged, see
  `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`).
- **There should only be one way to build a meme.** For images, that is the
  wizard. (Video creation also runs through the one wizard already; the
  wizard's video *backend* is left untouched here and hardened in the video
  rebuild.)

## Repo context inspected

Builder implementations today:

| Implementation | Status | Mounted from |
|---|---|---|
| `components/MemeBuilder.tsx` (2503 lines) | **Fully dead.** Kept "for reference" per `MemeStudio.tsx:38-42`. | Nothing |
| `meme-builder/MemeBuilder.tsx` ("flat", Phase-3) + `MemeStudio.tsx` (+ `MemeStudioVideoTab.tsx`) | **Live**, on-by-default. | `FactDetail.tsx` (flag off) and always `pages/memePage/BuilderOverlay.tsx` |
| `meme-builder/wizard/*` (MBFO wizard, image + video) | Active target, gated behind `VITE_MBFO_WIZARD=1` (set on Replit). | `FactDetail.tsx` when the flag is set |

The `VITE_MBFO_WIZARD` flag (`FactDetail.tsx:30`) is a "no rollout-flag gating"
violation and is why "the new meme builder" means different things per
environment.

**Privacy toggle** — still fully wired server-side, just never migrated into the
new builders' UI: `lib/db/src/schema/memes.ts:23` (`is_public`),
`lib/db/migrations/0013_feature_flags.sql:25-40` (`meme_private_visibility`,
legendary-only), `createMemeRecord.ts:170-175` (`canPrivate`/`isPublic`, always
`true` today because no client sends `isPublic`),
`validators/memeBuilder.ts:159` (`isPublic: z.boolean().optional()`). The dead
`components/MemeBuilder.tsx:2116-2134` has the reference toggle UI.

**Token-rendering bug** — a **write-time gap**, not a display bug:
- `render-fact.ts` `renderFact`/`renderFactSegments` are the client renderer;
  used correctly by `FactCard.tsx`/`FactDetail.tsx` (the sidebar that renders
  fine) and by the wizard's own `LivePreview.tsx:153-158` (why the *preview*
  looks correct).
- `Step2Image.tsx:197-205` builds `topText`/`bottomText` by splitting the raw
  `{NAME}`-laden `factText` with no render pass; those raw blocks are sent to
  `POST /api/memes`.
- Server: `memeGenerator.ts:378-380` draws `options.topText`/`bottomText`
  **verbatim** whenever present (the wizard always sets both), never running the
  render pipeline on them; `createMemeRecord.ts:141,232` also **persists** the
  raw `textOptions` into `memes.text_options`.

**Remix/cold-permalink parity gap** — `MemePage.tsx:209-239` lets "Remix" / "See
with your name" jump straight into editing with the original's stock photo via
`initialStockImageId`; `MemeBuilderWizard` has no equivalent prop.

## Settled decisions

1. The **MBFO wizard is the one image builder**, everywhere.
2. **Delete the legacy/duplicate builder frontend** (verified orphaned via import
   graph):
   - Image/shell: `components/MemeBuilder.tsx` (dead), `meme-builder/MemeBuilder.tsx`
     (flat), `MemeStudio.tsx`, `pages/memePage/BuilderOverlay.tsx`.
   - The video-UI frontend that is only reachable through `MemeStudio` and thus
     orphaned by its deletion: `MemeStudioVideoTab.tsx`, `components/MemeMagicVideo.tsx`,
     `components/VideoBuilder.tsx`. Deleting these removes duplicate video-*UI*
     entry points (leaving the wizard as the sole video creator UI) **without
     touching any video backend route** — see decision 8.
   - Plus now-orphaned builder-specific tests.
   - **Not deleted here:** the legacy `POST /api/videos/generate` backend route
     and all other video backend. It becomes caller-less (dead) but is left in
     place, to be removed as part of the video rebuild after the wizard video
     path is hardened to parity (decision 8). An `rg` sweep documents it as a
     known deferred orphan rather than silently leaving it undocumented.
3. Remove the `VITE_MBFO_WIZARD` flag — the wizard ships on-by-default.
4. `FactDetail.tsx` and `MemePage.tsx` both mount `MemeBuilderWizard` directly.
5. Add `initialStockImageId` to the wizard (Step 1 auto-skips to Step 2 image
   mode, pre-seeded with that stock photo) so remix/cold-permalink keep their
   one-tap UX.
6. **Token-rendering fix lands in `createMemeRecord.ts`** — render
   `topText`/`bottomText` once, at write time, and use the rendered value both
   for compositing and for what is persisted in `text_options`; the one point
   upstream of every current/future caller of `POST /api/memes`.
   - **Idempotency ordering + identity in the key (Codex rounds 1, 2, 4):** the
     current idempotency key (`createMemeRecord.ts:229-237`) is computed *before*
     the profile fallback and keys on the *raw* `textOptions`, excluding
     name/pronouns. Required: resolve the **effective identity snapshot**
     (request → profile fallback → the `"___"` no-name placeholder) *first*,
     render against it, and include `effectiveName` **and** `effectivePronouns`
     as their own **mandatory dedicated fields** in the idempotency key. Rendered
     text is NOT an acceptable substitute — a `{NAME}`-only or token-free fact
     renders identically for `he/him` and `they/them`, so a rendered-text key
     would let the second save receive the first's meme. Two saves differing by
     name *or* pronouns must never collapse; two byte-identical saves still dedupe.
   - **Renderer parity for neopronouns (Codex round 3 — David: full parity now):**
     the server render must byte-match the wizard preview for every allowed
     pronoun set. Today they diverge — the shared `resolveIdentityForms`
     (`lib/api-zod/src/resolvedIdentityForms.ts:82-88`) special-cases only
     `he`/`she` and collapses everything else (incl. `xe`/`ze`) to
     `their`/`themselves`, while the client `render-fact.ts` `KNOWN_MAPS` has full
     neopronoun forms. **Fix at the root: lift the client's neopronoun table into
     the shared `resolveIdentityForms` so there is ONE renderer** used by the
     server meme render, budget projection, and the client preview. **Parity
     scope = the 5 allowlisted presets** `he/him`, `she/her`, `they/them`,
     `xe/xem`, `ze/zir` (Codex round 4): `PronounsSchema` (`memeBuilder.ts:35-40`)
     restricts pronouns to that enum as a deliberate prompt-injection guard;
     custom pipe-delimited pronouns are rejected at the boundary by design and are
     out of scope — we do NOT widen that security allowlist here. **Ripple to
     check:** `resolveIdentityForms` also feeds budget projection
     (`promptIdentityBudget.ts` reserves per resolved token) — reconcile reserves
     against the new (sometimes longer) forms, keep `unresolvedSimpleTokens()`
     green, and respect the `lib/api-zod` codegen/export discipline
     (`patch-generated.mjs` + `check:codegen-drift`).
   - **Unify the text-options contract so EVERY wizard styling option survives
     save→render (Codex round 6).** The token bug is one instance of a broader
     disease: the wizard preview renders client-side from the full
     `MemeTextOptions` (`meme-builder/types.ts:48-61`), but the saved image
     renders server-side from a *different, drifted* contract
     (`TextOptionsSchema` in `memeBuilder.ts:60-75` → `generateMemeBuffer`), and
     Zod silently strips any field the schema doesn't name. Confirmed drift:
     the wizard sets `textColor` but the schema accepts `color` (so a chosen
     text color reverts to white on save/permalink/export); and the wizard sets
     `topY`/`bottomY` (vertical-position sliders) while the schema has only
     `verticalPosition` and no `topY`/`bottomY` (so vertical positioning is
     dropped too). Fix the **class**: reconcile the client `MemeTextOptions` and
     the server `TextOptionsSchema`/renderer into **one shared text-options
     contract** (rename/translate at the boundary at minimum, ideally a single
     shared type), and add a test that **every wizard-settable option**
     (fill color, outline color, vertical position, font family/size, effect,
     all-caps, bold/italic, opacity) survives save → persist → server render and
     matches the live preview — not just the two fields found here. This
     preempts the whole family of "preview shows X, saved image shows default"
     mismatches.
7. **Restore the legendary-gated Public/Private toggle** in the wizard's Step 2
   **image** flow (mirroring the dead builder's UX), and add `isPublic` to
   `SaveMemePayload`/`buildSaveMemePayload()` so it reaches the already-functional
   `POST /api/memes` → `createMemeRecord` path. Image memes only.
8. **Video is split into a separate follow-up (David, 2026-07-24).** This PR
   makes **no change to any video backend** — the wizard video path
   (`Step2Video` → `POST /api/memes/video-jobs`) and the legacy
   `POST /api/videos/generate` route are both left exactly as they are today. We
   only delete the orphaned video-*UI* frontend (decision 2) so the wizard is the
   sole video creator UI. All video hardening + the legacy-route deletion move to
   the video rebuild, which must address the findings in the appendix below. The
   pre-existing video gaps (IDOR, ungoverned spend) are **not introduced** by
   this PR but are live today and worth prioritizing on their own.

## What must NOT change

- Private-meme access-control (404-not-403, no social preview, no public cache)
  — untouched, covered by `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`.
- The split-slider UX — the token fix is server-side and does not touch it.
- Video creation capability and all video backend — untouched here. Video
  creation stays reachable through the wizard exactly as today.

## Source-of-truth analysis

| Concept | Source of truth after this change |
|---|---|
| Whether an (image) meme is public | `memes.is_public` + `meme_private_visibility` flag (unchanged) |
| Rendered meme text (image + stored options) | Computed once in `createMemeRecord.ts` from `(raw topText/bottomText, effective identity)` — never client-derived, never stored un-rendered |
| Effective identity for a save | Resolved once in `createMemeRecord.ts` (request → profile → `"___"`) *before* the idempotency key |
| Pronoun→form derivation (incl. neopronouns) | ONE shared `resolveIdentityForms` in `lib/api-zod` — server render, budget projection, and client preview all use it |
| Text styling options (color, position, font, effect…) | ONE reconciled text-options contract — the wizard preview and the server render read the same field names, so no wizard-set option is silently stripped |
| Idempotency | Key always carries `effectiveName` + `effectivePronouns` as dedicated fields (never substituted by rendered text) |
| Which image builder is mounted | `MemeBuilderWizard`, unconditionally — no env flag |
| Remix/cold-permalink initial photo | `initialStockImageId` threaded into wizard state |
| Video backend | **Unchanged by this PR** (hardened in the video rebuild) |

## Migration/backfill impact

**Stale `text_options` rows (Codex round 5).** The write-time fix only corrects
*new* saves. `GET /api/memes/:slug/image` and the export paths read
`meme.textOptions` and hand `topText`/`bottomText` to `generateMemeBuffer`, which
draws them verbatim — so any *already-saved* wizard meme with raw tokens in
`memes.text_options` keeps a broken permalink/export after the code fix. Because
this is pre-launch (no real user data to preserve, per
`agent-working-rules.md`), the plan includes a **one-time cleanup that deletes
image-meme rows whose `text_options.topText`/`bottomText` contain an unresolved
token** (`hasUnresolvedFactTokens`), rather than a compat-reader. Idempotent and
safe to re-run. (No such concern for video; video backend is untouched.)

## Runtime + UX behavior

- Every image save flow (fact-detail, remix, cold-permalink) goes through the
  wizard; saved images never contain a raw token, for any allowed pronoun set.
- Legendary users see a Public/Private toggle in Step 2 image; others don't.

## Security / permissions / validation

- No auth/tier change beyond restoring the existing `meme_private_visibility`
  check to a reachable UI control.
- `PronounsSchema`'s allowlist is left intact (deliberate prompt-injection
  guard); custom pronouns stay rejected.
- **No video backend touched** — so this PR neither fixes nor worsens the
  pre-existing video IDOR/governance gaps (appendix).

## Testing plan (proves the general invariant, not one example)

- `createMemeRecord` render: given `{NAME}`/`{SUBJ}`/verb-conjugation tokens,
  the persisted `text_options` and the composited buffer both contain the fully
  rendered string across a range of name/pronoun combos, incl. a plural set and
  the anonymous `"___"` case.
- Renderer parity (Codex rounds 3–4): for **each of the 5 allowlisted pronoun
  sets** the server render byte-matches the client `renderFactSegments`; a custom
  pipe-delimited value stays a clean 4xx (not a 500).
- Idempotency (Codex rounds 1, 2, 4): two saves differing only by name/pronouns
  produce two distinct correctly-rendered memes; **includes a pronouns-only
  difference and an absent-`textOptions` case**; byte-identical repeats still
  dedupe.
- Text-options survival (Codex round 6): a parameterized test asserting **each
  wizard-settable styling option** (fill color, outline color, vertical position,
  font family/size, effect, all-caps, bold/italic, opacity) set to a non-default
  value survives save → persisted `text_options` → server `generateMemeBuffer`
  output, so the saved/exported image matches the live preview. Explicitly
  covers `textColor` (non-white) and a moved vertical position.
- `buildSaveMemePayload` includes `isPublic` when private is chosen, omits/defaults
  otherwise; e2e re-run of the PR213 private-meme UAT (image).
- `initialStockImageId`: Step 1 skipped, Step 2 mounts with that photo selected.
- Stale-row cleanup: a seeded image-meme row with a raw `{NAME}` in `text_options`
  is removed by the cleanup; a clean row is untouched; re-running is a no-op.
- Deletion-completeness `rg` sweep (Codex round 1): no live import of any deleted
  builder component (`MemeBuilder`, `MemeStudio`, `MemeStudioVideoTab`,
  `MemeMagicVideo`, `VideoBuilder`, `BuilderOverlay`) remains; the caller-less
  legacy `POST /api/videos/generate` route is documented as a known deferred
  orphan (not silently left).

## Risks

- Deleting the builder frontend touches every importer — the `rg` sweep (incl.
  tests and `__demo__/MatrixHarness.tsx`) is the guard.
- `initialStockImageId` is new code in the well-tested `useWizardState`/
  `wizardStorage` area — needs its own coverage.
- The neopronoun-parity fix touches shared `lib/api-zod` (budget projection +
  codegen export surface) — reconcile `promptIdentityBudget` reserves and respect
  the codegen/export discipline (a trap CLAUDE.md flags as hit twice).
- Idempotency reorder is a subtle dedup-window change — the two-saves-differ-by-
  identity test is the guard; byte-identical repeats must still dedupe.

## Definition of done

- One image builder (`MemeBuilderWizard`) mounted from `FactDetail.tsx` and
  `MemePage.tsx`; `VITE_MBFO_WIZARD` removed.
- Builder frontend deleted (image builders + orphaned video-UI components);
  `rg` sweep clean; caller-less legacy video route documented as deferred.
- A meme saved through any image entry flow renders the actual name/pronouns —
  verified across pronoun sets, and byte-matching the preview for all 5 presets.
- Every wizard-settable text styling option (color, vertical position, font,
  effect, caps, bold/italic, opacity) survives save/export and matches the
  preview — no field silently stripped by a drifted schema.
- Two rapid saves differing only by name/pronouns yield two correct memes;
  identical repeats dedupe.
- Legendary users can toggle Public/Private on image memes; behavior per PR213.
- Remix/cold-permalink still jump to the pre-selected stock photo.
- Stale image-meme rows with raw tokens are cleaned; permalinks/exports render
  correctly.
- **Video backend unchanged**; video creation still works via the wizard.
- `check:docs` + relevant suites pass; TEST_RUN + UAT docs shipped with the PR.

---

## Carry-forward: video rebuild (findings to inherit — David, 2026-07-24)

David: "we're going to be rebuilding the video process almost from scratch but
we should take all the learnings from the investigations so far into account."
These are the verified findings from this review; they are **out of scope for
this PR** but must shape the video rebuild. (To be promoted to a durable
`docs/ai-context/` note during implementation so they survive to the rebuild.)

1. **Object-ownership authorization (IDOR) — highest priority, live today.** The
   wizard route `POST /api/memes/video-jobs` only regex-validates
   `sourceImagePath`; `startVideoJob`/`videoPipelineRunner` then download that
   `/objects/...` path with **no ownership/ACL check**. The legacy
   `/api/videos/generate` performed the ownership check (via
   `uploadPrivateImageToFalCdn` /`userCanReadObject`/`userOwnsAiReferenceImage`)
   before rehosting. The rebuilt path MUST authorize source-object ownership
   server-side (a user may only reference objects they own/may read), with a
   regression test. Verified against `videoJobs.ts:120-138` +
   `videoPipelineRunner.ts:782,891`.
2. **Resource governance.** The legacy route wraps generation in
   `enforceGovernance`/`completeGovernance` (per-user concurrency, spend/duration/
   payload caps, fal circuit-breaker); the wizard route has only a per-request
   budget pre-check. The rebuilt path must carry equivalent governance.
3. **Governance lease must span the async job lifecycle.** `startVideoJob`
   returns `{ jobId }` immediately and schedules the FAL pipeline via
   `setImmediate` (`videoPipelineRunner.ts:430,544`). A lease completed in the
   HTTP `finally` frees the slot before the work runs. The lease must be acquired
   at job start and completed from the pipeline's terminal states.
4. **Terminal states include TTL/prune expiry.** Jobs parked in `stage1_review`/
   `stage1_no_face_review` can be dropped by `pruneExpired()` after the 1-hour
   TTL without passing success/failure/cancel — so TTL expiry must ALSO release
   the governance lease, or an abandoned job throttles the user until process
   restart. Cover in the concurrency test.
5. **Video privacy.** The legacy `/api/videos/generate` accepts/persists
   `isPrivate`; the wizard `/api/memes/video-jobs` has no privacy field and
   `startVideoJob` persists `isPrivate: false`. The rebuild should design privacy
   in from the start (parity with image `is_public`).
6. **Renderer reuse.** The rebuilt video text rendering should use the same
   shared `resolveIdentityForms` (post neopronoun-parity fix from this PR) so
   video captions can't re-introduce the client/server pronoun divergence.
