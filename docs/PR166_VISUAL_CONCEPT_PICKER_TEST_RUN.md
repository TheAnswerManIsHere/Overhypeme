# PR166 — Candidate Visual concept picker (Slice 2A, frontend) · TEST_RUN

> **Companion UAT:** `docs/PR166_VISUAL_CONCEPT_PICKER_UAT.md` (David's in-app
> click-through — this is the UAT the backend PR #163 deferred to here). Run this
> automated checklist first; it should be fully green before the UAT.
>
> **Replit owns the database connection** — just run the suites; don't set any
> DB env here. Backend for this feature (candidate generation + endpoints)
> already merged in **#163**; this PR is frontend-only.

---

## 1. What this PR changes (engineering summary)

Surfaces the three planner-drafted concepts from #163 in the moderation Step-2
visual review, under the existing "Visual concept" field. Frontend only.

1. **`components/admin/VisualConceptCandidates.tsx`** (new) — the picker.
   Rendered entirely from the server `visualConcepts` block on the review detail
   (`{ status, candidates, current, staleReason? }`); the FE **never** recomputes
   hashes. States: `null` → manual **Generate**; `pending` → working; `failed` →
   non-blocking notice + Regenerate; `ok`+stale (`current:false`) → candidates
   hidden + `staleReason` shown + Regenerate; `ok`+`current` → three cards
   (title + `whyItWorks` + expandable scene + **Use as draft**). A `tokenValid:false`
   candidate's button is disabled (tooltip = `tokenError`). Picking calls
   `withCoreSceneOverride(...)` into the shared enrichment draft.
2. **`pages/admin/moderation.tsx`**:
   - `visualConcepts` on `ReviewDetail`.
   - **Finite polling**: a dedicated effect polls `loadDetail()` ~1.2s **only
     while `detail.visualConcepts.status === "pending"`**; `null`/terminal never
     poll.
   - `onGenerateConcepts` → `POST /admin/reviews/:id/visual-concepts/regenerate`
     with the current unsaved draft as `coreSceneDraft`; optimistic `pending`.
   - `onPickConcept` → writes the scene into the enrichment draft (draft-only).
   - `PrepStatusPanel` gains an **optional** "Visual ideas" pill; `PrepStepPill`
     gains an `optional` variant (muted "unavailable" on failure, "not run" on
     null — never the blocking-red of a required step). Excluded from the "X of 2
     ready" tally.

## 2. What is deliberately NOT shipped

- No backend changes — candidate generation, the regenerate endpoint, and the
  `visualConcepts` review-detail block are all in #163 (on `main`).
- No eval harness (PR-B1/B2).
- The picker never gates approval — the Visual concept field works empty exactly
  as before.

## 3. Automated checks to run

```bash
pnpm --filter overhype-me run typecheck
pnpm --filter overhype-me exec vitest run src/components/admin/VisualConceptCandidates.test.tsx
# Full FE suite (confirms the PrepStepPill/PrepStatusPanel signature change is safe):
pnpm --filter overhype-me exec vitest run
```

**Expected:** typecheck clean; `VisualConceptCandidates.test.tsx` 9/9; full suite
**63 files / 692 tests, 0 fail** (jsdom "getContext() not implemented" canvas
lines are pre-existing noise, not failures).

## 4. Targeted assertions to confirm (`VisualConceptCandidates.test.tsx`)

- `null` status shows the **Generate** button and no cards; clicking calls
  `onGenerate`.
- `pending` shows the working indicator, no cards.
- `failed` shows the non-blocking message + a **Regenerate** button.
- `ok`+`current:false` **hides** the candidates and shows the `staleReason` copy
  (proves the server `current` flag gates display — the FE doesn't recompute).
- `ok`+`current` renders exactly three cards; each scene is **collapsed** until
  its "Show scene" toggle is clicked.
- **Use as draft** calls `onPick` with the candidate's exact `sceneDescription`.
- A `tokenValid:false` candidate's button is **disabled**, `onPick` is not
  called, and the invalid-token advisory shows.
- `disabled` prop blocks picking; Regenerate disables itself while a request is
  in flight, then re-enables.

## 5. Finite-polling guarantee (code-level; not a brittle page test)

`moderation.tsx` polls the review detail for concept status ONLY inside an effect
guarded by `if (visualConceptStatus !== "pending") return;`. So: a `null` status
(pre-feature / not-yet-generated) never starts a poll (the picker shows a manual
Generate instead), and `ok`/`failed` stop it. This mirrors the existing prep-poll
pattern (which is keyed on `stage === "prep_pending"`). No page-level mount test
is added — the modal is a large fetch/hook-heavy component with no existing
page-level test; the poll gate is a one-line invariant verified by reading it.

## 6. Live end-to-end (needs #163 backend + an OpenAI key on Replit)

1. Provisionally-approve a fact → after enrichment it reaches `production_review`;
   the "Visual ideas" pill goes working → ready and three cards appear under the
   Visual concept field.
2. Expand a card's scene; click **Use as draft** → the scene fills the Visual
   concept field (unsaved). Save → test renders flag stale; re-run them.
3. **Regenerate** → status flips to pending, three fresh distinct ideas land; the
   current draft was offered as context (distinct alternatives, not echoed).
4. Edit the enrichment/fact and reopen → the stored candidates show the **stale**
   notice (server `current:false`) until regenerated.

## 7. Gotchas

- If the cards never appear but the pill says "ready", confirm the review-detail
  response carries `visualConcepts.current: true` — a stale flag hides the cards
  by design.
- The picker is intentionally **optional**: a `failed`/absent concept job shows a
  muted, non-blocking notice; the moderator writes the Visual concept by hand
  exactly as before. That is not a bug.
