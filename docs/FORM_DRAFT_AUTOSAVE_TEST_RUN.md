# Form-draft autosave helper — Test Run

Engineering-side checklist for the work shipped on
`claude/nifty-turing-eqhM2`. This refactor extracts the autosave/"don't lose
your work" logic that had been written twice (fact submission + fact moderation)
into one reusable helper, and adopts it for comment drafts too.

Covers:

1. **New storage util** — `src/lib/form-draft-storage.ts`: `StorageAdapter<T>`
   contract, `createLocalStorageAdapter` (schema-versioned, TTL'd, error-swallowing,
   matches `pendingBuilderState.ts` house style), `getRelativeTime`, and a
   stable key-sorted `stableSerialize`.
2. **New hook** — `src/hooks/use-form-draft.ts`: `useFormDraft<T>` — debounced
   save, restore-on-mount, self-refreshing "Saved X min ago" label, status/error,
   `clear()`, `saveNow()`, with snapshot-based change detection and async
   sequence guards.
3. **Fact submission** (`src/pages/SubmitFact.tsx`) — rewired onto the hook
   (localStorage adapter). The duplicated `getRelativeTime` + three effects are
   gone.
4. **Fact moderation** (`src/pages/admin/moderation.tsx`, `ReviewModal`) — same
   hook, but with a **server PATCH adapter**. Server persistence and the
   `dirtyRef`/`syncFromServer` clobber-guards are preserved; the duplicated
   `getRelativeTime`, `performSave`, and the two effects are gone.
5. **Comment composer** (`src/components/facts/FactComments.tsx`) — now persists
   the comment draft to localStorage (per user + fact, 24h TTL) on top of the
   existing in-memory fast path.

UAT for David: [`FORM_DRAFT_AUTOSAVE_UAT.md`](./FORM_DRAFT_AUTOSAVE_UAT.md).

---

## TL;DR

No DB or schema changes — this is a frontend refactor plus an additive
localStorage feature for comments. Against your own checkout:

```bash
# from artifacts/overhype-me
pnpm run typecheck       # all clean
pnpm run test            # full suite, 522 pass (44 files)
# Or just the new suites:
npx vitest run src/lib/form-draft-storage.test.ts \
               src/hooks/use-form-draft.test.tsx \
               src/components/facts/FactComments.draft.test.tsx
# Expected: 28 pass (11 storage + 15 hook + 2 comment-draft).
```

There is **no API/server change** in this PR. The moderation flow keeps hitting
the existing `PATCH /api/admin/reviews/:id/enrichment` endpoint — only the
client wiring changed.

---

## 1. Storage util (`src/lib/form-draft-storage.ts`)

Pure, framework-free, directly unit-tested (no renderer). Verify:

- `createLocalStorageAdapter` round-trips `{ value, savedAt }`, prunes on TTL
  expiry / corrupt JSON / schema-version mismatch / failed `isValid`, and
  **never throws** (quota / private mode are swallowed).
- `stableSerialize` is key-order independent (recursively).
- `getRelativeTime` boundary labels.

```bash
npx vitest run src/lib/form-draft-storage.test.ts
# Expected: 11 pass.
```

## 2. The hook (`src/hooks/use-form-draft.ts`)

Verify the contract and the race-safety guards that David's review called for:

- Debounce coalescing; **equivalent-value re-renders schedule no save**
  (snapshot compare, not object identity).
- Restore-on-mount fires `onRestore` and **leaves the stored draft intact**
  (restore never clears).
- TTL expiry → no restore.
- `isEmpty` → clear instead of save; `enabled:false` → never saves.
- `manualDirty` gating + `onSaved` callback.
- `clear()` cancels a pending save and leaves storage cleared.
- `saveNow()` flushes the latest value immediately and resolves a boolean.
- **Out-of-order async saves**: a stale resolution can't roll back `savedAt`.
- **Stale rejection** can't flip a newer-saved form to `error`.
- **clear-vs-in-flight-save**: a save resolving after `clear()` re-clears storage.
- Adapter throwing degrades without crashing.

```bash
npx vitest run src/hooks/use-form-draft.test.tsx
# Expected: 15 pass.
```

## 3. Fact submission (`src/pages/SubmitFact.tsx`)

Code review checklist (behavior is unchanged except one deliberate improvement):

- `DRAFT_STORAGE_KEY`, the local `getRelativeTime`, the restore/save/label
  effects, and `draftSavedAt`/`draftSavedLabel` state are all removed.
- A single `useFormDraft<SubmitDraft>` drives the "Saved X min ago" indicator
  (`draft.savedAt` / `draft.savedLabel`).
- `draft.clear()` replaces every `localStorage.removeItem(...)` (submit success,
  discard, "Submit Another").
- **Deliberate change:** restore no longer deletes the stored draft on load, so
  a restored draft survives a second reload. The onboarding-required button now
  `await`s `draft.saveNow()` before navigating, instead of writing localStorage
  by hand.

## 4. Fact moderation (`src/pages/admin/moderation.tsx`)

The linchpin — confirm server persistence is intact:

- `ReviewModal` builds a `StorageAdapter<FactEnrichment | null>` whose `save()`
  is the `PATCH /api/admin/reviews/:id/enrichment` call (throws on non-OK so the
  hook surfaces the error), `load()` is a no-op, `clear()` is a no-op.
- `useFormDraft({ debounceMs: 1500, restoreOnMount: false, manualDirty: dirty })`.
- `dirtyRef` is **kept** (guards `syncFromServer`); a parallel `dirty` state
  gates the hook. `onSaved` resets both — and the hook calls `onSaved` only for
  the latest save, so a stale PATCH response can't re-mark the form clean while
  a newer edit is pending.
- `regeneratePreview` now does `await draft.saveNow()` and bails if it returns
  false (no preview job kicked on a failed save).

Manual server check (optional, against your DB): open a pending review, edit the
enrichment, watch the indicator go `Saving… → Saved X min ago`, reload the page,
and confirm the edit persisted (it came from the DB, not localStorage).

## 5. Comment composer (`src/components/facts/FactComments.tsx`)

- localStorage adapter keyed `comment_draft::<userId>::<factId>` (falls back to
  `comment_draft::<factId>` if no user id), 24h TTL, validated shape.
- The in-memory `draft`/`onDraftChange` fast path is **kept**; on restore, a
  non-empty in-memory draft wins (no localStorage clobber, no keystroke loss).
- `commentDraft.clear()` runs on submit (both feed + detail variants).

```bash
npx vitest run src/components/facts/FactComments.draft.test.tsx
# Expected: 2 pass (in-memory precedence; restore when empty).
```

---

## What's deliberately NOT shipped

- No server/API/schema/migration changes.
- The comment composer does **not** add a visible "Saved" indicator (the feed
  composer is intentionally compact); persistence is verified by reload.
- Old fact-submission drafts written in the pre-refactor flat format (no
  `schemaVersion`) are discarded on first load rather than migrated — drafts are
  ephemeral (24h TTL), so this is intentional.
