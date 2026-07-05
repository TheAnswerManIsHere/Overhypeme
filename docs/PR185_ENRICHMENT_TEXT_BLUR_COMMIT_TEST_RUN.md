# PR185 — Enrichment text blur-commit · TEST_RUN (engineering checklist)

> **For Replit (the technical safety net).** Automated verification for the
> blur-commit replacement of the override-write debounce in `EnrichmentEditor`
> (fixes to PR #182's frontend half; merges into PR #182's branch). Companion
> click-through: `docs/PR185_ENRICHMENT_TEXT_BLUR_COMMIT_UAT.md`.
>
> Frontend-only change — **no migrations, no schema, no API changes**. The
> backend half of PR #182 (clearing prior render attempts on visual-concept
> re-approval) is untouched by this PR; its test is re-run below only to prove
> the branch state is green end-to-end.

---

## 1. Build + typecheck

```bash
pnpm run typecheck
```

Expect: all four projects report **Done**, no TS errors (`check:cycles` and
`check:no-console` pass as part of the api-server typecheck). In particular
`EnrichmentEditor.tsx` compiles with the debounce machinery removed — there
must be **no** remaining references to `TRACKED_TEXT_OVERRIDE_DEBOUNCE_MS`,
`pendingTextOverrideTimers`, `pendingTextOverrideValues`, or
`overrideContextRef` anywhere:

```bash
grep -rn "TRACKED_TEXT_OVERRIDE_DEBOUNCE_MS\|pendingTextOverride\|overrideContextRef" artifacts/overhype-me/src
```

Expect: **no matches**.

## 2. Frontend tests

```bash
pnpm --filter @workspace/overhype-me test
```

Expect **all files pass** (738+ tests at time of writing). The rewritten file
that must be green:

- `EnrichmentEditor.dualMode.test.tsx` — **7 tests**. The old fake-timers
  debounce test is gone, replaced by three tests pinning the new contract:
  1. **Typing stays local, blur commits once** — a `change` on a semantic
     entity's Visual referent (typing `"hands signing "` with a trailing
     space) fires **neither** `onChange` **nor** `onOverride`; the input's own
     value keeps the trailing space; a `blur` then fires **both exactly
     once** with the space-preserving value; a second no-op blur does **not**
     write again.
  2. **Structural edits persist immediately** — clicking **Remove semantic
     entity** calls `onOverride("/semanticEntities", [])` synchronously (no
     deferral window).
  3. **Review mode is per-keystroke** — with no `overrideContext`, a `change`
     event fires `onChange` immediately (the localStorage-backed review draft
     autosave is unchanged).

Single-file run (if triaging):

```bash
pnpm --filter @workspace/overhype-me exec vitest run src/components/admin/EnrichmentEditor.dualMode.test.tsx
```

## 3. Backend tests (branch-state sanity, unchanged by this PR)

Run PR #182's backend test to confirm the combined branch is green:

```bash
bash artifacts/api-server/scripts/run-test.sh src/__tests__/routes.approveVisualConcept.test.ts
```

Expect: **12 pass / 0 fail** — including the re-approval case asserting
`clearedRenderAttempts: 1` and the detached prior attempt (`reviewId` null).

## 4. What's deliberately NOT shipped

- **No `beforeunload`/`pagehide` flush.** In override mode, text typed into a
  field that is never blurred is not persisted if the tab is closed while the
  field still has focus. This is the same contract the file has always had for
  the notes fields (`NoteOverrideField`, now folded into `DraftTextField`) —
  blur is the commit gesture. Any click inside the app (including Save /
  Approve buttons) blurs the field first, so the loss window is "close the
  tab with the cursor still in the field," accepted as out of scope.
- **Server-side trim on commit is unchanged.** The override endpoint still
  canonicalizes (`z.string().trim()`), so a committed value's trailing
  whitespace is trimmed **after blur**. That is post-edit canonicalization,
  not mid-typing interruption, and is intended.
- **No change to which fields are tracked/overridable**, no new endpoints, no
  change to `useFactEnrichmentEditing` / `useDraftForm`.
